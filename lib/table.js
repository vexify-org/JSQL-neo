// © Vexify 2026 All Rights Reserved.
/**
 * JSQL Table — 表操作引擎 v2.0
 * B-Tree 自动索引、日期类型、错误码、外键 CASCADE、长度/精度校验
 */

const Query = require('./query');
const BTree = require('./btree');
const { validateDateType, now } = require('./date-types');
const { createError, JSQL_Error } = require('./errors');

// ---------------------------------------------------------------------------
// DEFAULT 表达式求值（Issue #72）
//
// 此前只有字符串 'CURRENT_TIMESTAMP' 被特判成 now()，其他函数式默认值
// （'NOW()'、'NOW(6)'、'LOCALTIMESTAMP' 等）会被原样当成列值塞进数据行，
// 随后被日期校验当作非法日期，报出误导性的 "Incorrect date value: '<列名>'"。
// 这里统一按字符串形态识别：
//   • CURRENT_TIMESTAMP / NOW[(n)] / LOCALTIMESTAMP[(n)] / LOCALTIME[(n)]
//     → 当前时间戳（MySQL 语义）
//   • 其他「函数调用形式」的默认值 → 明确报不支持，而不是拿列名当值
//   • 普通字面量（'abc'、'0'、'{}' 等）→ 原样返回，保持向后兼容
// 注意：JS 侧 `default: () => ...` 的函数仍在调用处直接 dv()。
// ---------------------------------------------------------------------------
const NOW_DEFAULT_RE = /^(?:CURRENT_TIMESTAMP|NOW|LOCALTIMESTAMP|LOCALTIME)\s*(?:\(\s*\d*\s*\))?$/i;
const FUNC_CALL_DEFAULT_RE = /^[A-Za-z_$][\w$]*\s*\([\s\S]*\)$/;

function resolveDefaultValue(dv, fieldName) {
    if (typeof dv === 'function') return dv();
    if (typeof dv !== 'string') return dv;
    const expr = dv.trim();
    if (NOW_DEFAULT_RE.test(expr)) return now();
    if (FUNC_CALL_DEFAULT_RE.test(expr)) {
        throw new JSQL_Error(1235,
            `Unsupported default expression '${expr}' for column '${fieldName}'`);
    }
    return dv;
}

// ---------------------------------------------------------------------------
// 64 位整数（Issue #38）
//
// JS 的 number 只能精确表示 |v| <= 2^53-1。integer/int/bigint 列原先用
// Number(v) 归一，>2^53 的输入（无论 number 还是十进制字符串）都会被静默
// 截断成 53 位浮点，SQL 路径则因为字面量被解析成 BigInt 而报 1292 —— 两条
// 路径行为不一致且都丢精度。
//
// 现在的语义：
//   • BigInt 输入      → 精确接受（在 int64 范围内）；
//   • 十进制字符串输入 → 精确解析成 BigInt，安全范围内仍存成 number（兼容旧行为）；
//   • 超安全范围的 number → 明确报 1292（调用方在 JS 层就已丢精度，不能静默入库）；
//   • 超出 int64 范围 → 明确报 1292（持久化格式是 8 字节有符号整数）。
// ---------------------------------------------------------------------------
const INT64_MIN = -9223372036854775808n;
const INT64_MAX = 9223372036854775807n;
const SAFE_INT_MIN = BigInt(Number.MIN_SAFE_INTEGER);
const SAFE_INT_MAX = BigInt(Number.MAX_SAFE_INTEGER);
const DECIMAL_INT_RE = /^[+-]?\d+$/;
/**
 * 从持久化的 CHECK SQL 文本重新编译判定函数（Issue #70）。
 * 惰性 require 避免 table.js ↔ sql.js 的加载顺序耦合。
 * 编译失败直接抛错：约束无法重建时必须显式失败，不能静默丢弃。
 */
function compileCheckSql(sqlText) {
    const { compileCheckExpr } = require('./sql');
    return compileCheckExpr(sqlText);
}


function integerError(type, v) {
    return createError('ER_TRUNCATED_WRONG_VALUE', type, v);
}

/**
 * 把已经确认是十进制整数的字符串/BigInt 归一成 number（安全范围内）或 BigInt。
 * 超出 int64 抛 1292，避免持久化时被 BigInt64 写入静默回绕。
 */
function normalizeInteger(v, type) {
    let b;
    if (typeof v === 'bigint') b = v;
    else {
        try { b = BigInt(v); } catch (_) { throw integerError(type, v); }
    }
    if (b < INT64_MIN || b > INT64_MAX) throw integerError(type, b.toString());
    if (b >= SAFE_INT_MIN && b <= SAFE_INT_MAX) return Number(b);
    return b;
}

/**
 * 会被 _compileMatcher 编译成快路径的操作符。
 *
 * 收录标准：语义简单、求值廉价，且能在编译期确定目标值。
 * 不在表内的操作符（$inSub / $elemMatch / $textSearch / $expr / 作为值级
 * 逻辑的 $and $or $not …）走退回路径，逐字段交给 _matchOperator，语义不变。
 */
const FAST_MATCH_OPS = new Set([
    '$eq', '$ne', '$gt', '$gte', '$lt', '$lte',
    '$in', '$nin', '$between', '$exists', '$isNull',
    '$startsWith', '$endsWith', '$contains', '$type', '$size',
]);

function isSafeRegex(pattern) {
    if (typeof pattern !== 'string') return false;
    if (pattern.length > 256) return false;
    const groups = [];
    let i = 0;
    const n = pattern.length;
    while (i < n) {
        const c = pattern[i];
        if (c === '\\') { i += 2; continue; }
        if (c === '[') {
            while (i < n && pattern[i] !== ']') i++;
            i++;
            continue;
        }
        if (c === '(') {
            const nxt = pattern[i + 1];
            if (nxt === '?') {
                const t = pattern[i + 2];
                if (t === ':') {
                    groups.push({ hasQuant: false, hasAlt: false });
                    i += 3;
                    continue;
                }
                if (t === '=' || t === '!') {
                    let depth = 1, j = i + 3;
                    for (; j < n && depth > 0; j++) {
                        if (pattern[j] === '\\') { j++; continue; }
                        if (pattern[j] === '(') depth++;
                        else if (pattern[j] === ')') depth--;
                    }
                    i = j;
                    continue;
                }
                if (t === '<') {
                    const u = pattern[i + 3];
                    if (u === '=' || u === '!') {
                        let depth = 1, j = i + 4;
                        for (; j < n && depth > 0; j++) {
                            if (pattern[j] === '\\') { j++; continue; }
                            if (pattern[j] === '(') depth++;
                            else if (pattern[j] === ')') depth--;
                        }
                        i = j;
                        continue;
                    }
                    const gt = pattern.indexOf('>', i + 3);
                    if (gt === -1) return false;
                    groups.push({ hasQuant: false, hasAlt: false });
                    i = gt + 1;
                    continue;
                }
                return false;
            }
            groups.push({ hasQuant: false, hasAlt: false });
            i++;
            continue;
        }
        if (c === ')') {
            const g = groups.pop();
            if (!g) return false;
            let qi = i + 1;
            let quant = null;
            if (pattern[qi] === '+' || pattern[qi] === '*' || pattern[qi] === '?') {
                quant = pattern[qi];
            } else if (pattern[qi] === '{') {
                const close = pattern.indexOf('}', qi);
                if (close === -1) return false;
                quant = pattern.slice(qi, close + 1);
                qi = close + 1;
            }
            if (quant && (g.hasQuant || g.hasAlt)) return false;
            i = qi;
            continue;
        }
        if (c === '+' || c === '*' || c === '?') {
            if (groups.length > 0) groups[groups.length - 1].hasQuant = true;
            i++;
            continue;
        }
        if (c === '{' && /[0-9]/.test(pattern[i + 1] || '')) {
            const close = pattern.indexOf('}', i);
            if (close === -1) return false;
            if (groups.length > 0) groups[groups.length - 1].hasQuant = true;
            i = close + 1;
            continue;
        }
        if (c === '|') {
            if (groups.length > 0) groups[groups.length - 1].hasAlt = true;
            i++;
            continue;
        }
        i++;
    }
    return groups.length === 0;
}

class Table {
    constructor(name, schema, db) {
        this._name = name;
        this._schema = schema;
        this._db = db;
        this._rows = [];
        this._indexes = {};          // 旧版 hash 索引（兼容）
        this._btrees = {};           // B-Tree 索引 { fieldName: BTree }
        this._autoIncrement = 0;
        this._dirty = false;
        this._hooks = {
            beforeInsert: [], afterInsert: [],
            beforeUpdate: [], afterUpdate: [],
            beforeRemove: [], afterRemove: []
        };
        this._softDelete = false;
        this._computedFields = {};


        this._primaryKey = null;
        this._pkIndex = null;
        this._autoIncrementField = null;
        this._foreignKeys = [];
        this._checkConstraints = [];
        this._defaults = {};
        this._dateFields = {};       // { fieldName: 'date'|'datetime'|'timestamp' }

        for (const [field, def] of Object.entries(schema)) {
            // schema 字段名归一化：驼峰 primaryKey/autoIncrement 与下划线
            // primary_key/auto_increment 两种写法都要认。
            //
            // 此前这里只认驼峰，而 native_client 在交给 Rust 之前会归一化
            // （lib/native_client.js 里 primary_key → primaryKey）。结果：
            // README 与官方示例用的下划线写法，在 native 下正常，在纯 JS 下
            // **静默失效** —— 自增 id 不生成，find({id:1}) 永远返回空，
            // 而且不报任何错。这是纯 JS 与 native 的行为分歧。
            if (def && typeof def === 'object' && !Array.isArray(def)) {
                if (def.primary_key !== undefined && def.primaryKey === undefined) def.primaryKey = def.primary_key;
                if (def.auto_increment !== undefined && def.autoIncrement === undefined) def.autoIncrement = def.auto_increment;
                if (def.primary_key !== undefined) delete def.primary_key;
                if (def.auto_increment !== undefined) delete def.auto_increment;
            }
            const isPk = !!(def.primaryKey || def.primary === true);
            if (isPk) this._primaryKey = field;
            if (def.autoIncrement) {
                this._autoIncrementField = field;
                if (isPk) this._primaryKey = field;
            }
            if (def.default !== undefined) {
                this._defaults[field] = def.default;
            }
            this._registerChecks(field, def);
            if (def.foreignKey) {
                this._foreignKeys.push({
                    field,
                    table: def.foreignKey.table,
                    refField: def.foreignKey.field || 'id',
                    onDelete: def.foreignKey.onDelete || 'restrict',
                    onUpdate: def.foreignKey.onUpdate || 'restrict'
                });
            }
            if (def.computed) {
                this._computedFields[field] = def.computed;
            }
            // 日期类型
            if (['date', 'datetime', 'timestamp', 'time'].includes(def.type)) {
                this._dateFields[field] = def.type;
            }
        }

        if (schema._softDelete) {
            this._softDelete = true;
        }

        this._pkIndex = this._primaryKey ? new Map() : null;
        this._cachedSchemaFields = Object.keys(schema).filter(f => f !== '_softDelete');
        this._cachedDateFields = Object.keys(this._dateFields);
        this._cachedUniqueFields = this._cachedSchemaFields.filter(f => schema[f].unique);
        this._cachedRequiredFields = this._cachedSchemaFields.filter(f => schema[f].required);
        this._autoCreateBTrees();
    }

    // P1-2: DDL 后统一刷新 schema 缓存。
    // dropColumn/renameColumn 过去只改 _cachedSchemaFields，unique/required/numeric/
    // date/computed 缓存残留旧列 → insertMany 等路径拿到陈旧 schema 直接崩溃或漏校验。
    _refreshSchemaCache() {
        this._cachedSchemaFields = Object.keys(this._schema).filter(f => f !== '_softDelete');
        this._cachedDateFields = Object.keys(this._dateFields);
        this._cachedUniqueFields = this._cachedSchemaFields.filter(f => this._schema[f] && this._schema[f].unique);
        this._cachedRequiredFields = this._cachedSchemaFields.filter(f => this._schema[f] && this._schema[f].required);
        this._cachedNumericFields = this._cachedSchemaFields.filter(f => ['integer', 'int', 'float', 'number', 'decimal'].includes(this._schema[f] && this._schema[f].type));
        this._cachedComputedFields = this._cachedSchemaFields.filter(f => this._computedFields[f]);
    }

    /**
     * 注册一个列的 CHECK 约束（Issue #70）。
     * 支持三种来源：
     *   • def.check     —— 已编译的判定函数（CREATE TABLE 解析时生成）
     *   • def.checks[]  —— 表级 CHECK，元素形如 { sql, fn }
     *   • def.checkSql  —— JSON 持久化后只剩文本，惰性重新编译
     * 判定函数统一签名为 (值, 整行) => boolean，跨列条件也能拿到整行。
     */
    _registerChecks(field, def) {
        if (!def) return;
        if (typeof def.check === 'function') {
            this._checkConstraints.push({ field, fn: def.check });
        } else if (typeof def.checkSql === 'string' && def.checkSql) {
            const fn = compileCheckSql(def.checkSql);
            if (fn) this._checkConstraints.push({ field, fn });
        }
        if (Array.isArray(def.checks)) {
            for (const entry of def.checks) {
                if (!entry) continue;
                let fn = typeof entry === 'function' ? entry : entry.fn;
                if (typeof fn !== 'function' && entry.sql) fn = compileCheckSql(entry.sql);
                if (fn) this._checkConstraints.push({ field, fn });
            }
        }
    }

    /** 校验全部 CHECK 约束（整行上下文，列级/表级统一走这里）。 */
    _enforceChecks(data) {
        for (const { field, fn } of this._checkConstraints) {
            if (typeof fn !== 'function') continue;
            let ok;
            try {
                ok = fn(data ? data[field] : undefined, data || {});
            } catch (_) {
                ok = false;   // 求值失败视为违反，绝不静默放行
            }
            if (!ok) throw createError('ER_CHECK_CONSTRAINT', this._name + '.' + field);
        }
    }

    _autoCreateBTrees() {
        for (const [field, def] of Object.entries(this._schema)) {
            if (field === '_softDelete') continue;
            if (def.primaryKey || def.primary === true || def.unique) {
                this._btrees[field] = new BTree(64, true);
            }
        }
    }

    // ============================================================
    // 插入
    // ============================================================

    insert(data) {
        for (const hook of this._hooks.beforeInsert) {
            data = hook({ ...data }) || data;
        }

        data = this._applyDefaults(data);
        data = this._applyComputed(data);
        data = this._validateDataTypes(data);
        this._validateConstraints(data, -1);

        if (this._autoIncrementField && data[this._autoIncrementField] === undefined) {
            this._autoIncrement++;
            data[this._autoIncrementField] = this._autoIncrement;
        } else if (this._autoIncrementField && data[this._autoIncrementField] > this._autoIncrement) {
            this._autoIncrement = data[this._autoIncrementField];
        }

        const rowIndex = this._rows.length;
        this._rows.push({ ...data });
        this._addToIndexes(rowIndex, data);
        this._dirty = true;
        this._db._markDirty(this._name);

        for (const hook of this._hooks.afterInsert) {
            hook(data);
        }
        this._db._emitChange('insert', this._name, data);

        return data;
    }

    insertMany(items) {
        if (items.length === 0) return [];
        for (const hook of this._hooks.beforeInsert) {
            const mapped = new Array(items.length);
            for (let i = 0; i < items.length; i++) mapped[i] = hook({ ...items[i] }) || items[i];
            items = mapped;
        }
        const N = items.length;
        const uniqueTracker = {};
        for (const field of this._cachedUniqueFields) {
            uniqueTracker[field] = new Set();
            for (const row of this._rows) {
                if (row[field] !== undefined && row[field] !== null) uniqueTracker[field].add(row[field]);
            }
        }
        const autoIncField = this._autoIncrementField;
        const defaults = this._defaults;
        const computedFields = this._computedFields;
        const schema = this._schema;
        const checkConstraints = this._checkConstraints;
        const foreignKeys = this._foreignKeys;
        // 批量预分配自增 ID 范围：先扫描显式提供的最大值，一次性推进计数器，
        // 再在循环内用本地序号递增，避免批量内重复读取/写入同一计数器字段。
        const baseAutoInc = this._autoIncrement;
        if (autoIncField) {
            let maxExplicit = 0;
            for (const it of items) {
                const v = it[autoIncField];
                if (v !== undefined && v !== null) {
                    const n = Number(v);
                    if (!isNaN(n) && n > maxExplicit) maxExplicit = n;
                }
            }
            if (maxExplicit > baseAutoInc) {
                this._autoIncrement = maxExplicit;
            }
        }
        let autoIncSeq = 0;
        const result = new Array(N);
        for (let i = 0; i < N; i++) {
            // 在副本上做默认值/计算列/类型归一，避免污染调用方传入的原始对象
            let data = { ...items[i] };
            for (const [f, dv] of Object.entries(defaults)) {
                if (data[f] === undefined) data[f] = resolveDefaultValue(dv, f);
            }
            for (const f of Object.keys(computedFields)) data[f] = computedFields[f](data);
            // 与单条 insert 保持一致：归一时间/数值/布尔/字符串类型（此前 insertMany 跳过了这一步）
            data = this._validateDataTypes(data);
            for (const field of this._cachedSchemaFields) {
                const def = schema[field];
                if (def.required && (data[field] === undefined || data[field] === null)
                    && !(def.autoIncrement && data[field] === undefined)) throw createError('ER_BAD_NULL_ERROR', field);
                // 与 _validateConstraints 保持一致：主键（非自增）不接受显式 NULL
                if ((def.primaryKey || def.primary === true) && !def.autoIncrement
                    && data[field] === null) throw createError('ER_BAD_NULL_ERROR', field);
                if (def.unique && data[field] !== undefined) {
                    if (uniqueTracker[field].has(data[field])) throw createError('ER_DUP_ENTRY', String(data[field]), field);
                    uniqueTracker[field].add(data[field]);
                }
                if (def.length && typeof data[field] === 'string' && data[field].length > def.length) throw createError('ER_DATA_TOO_LONG', field);
                if (def.type === 'integer' || def.type === 'int' || def.type === 'bigint' || def.type === 'number') {
                    const raw = data[field];
                    // BigInt 与 number 的 </> 比较是精确的，不要先 Number() 丢精度
                    const v = typeof raw === 'bigint' ? raw : (def.type === 'number' ? raw : Number(raw));
                    const min = typeof raw === 'bigint' && Number.isInteger(def.min) ? BigInt(def.min) : def.min;
                    const max = typeof raw === 'bigint' && Number.isInteger(def.max) ? BigInt(def.max) : def.max;
                    if (raw !== undefined && raw !== null && def.min !== undefined && v < min) throw createError('ER_OUT_OF_RANGE', field);
                    if (raw !== undefined && raw !== null && def.max !== undefined && v > max) throw createError('ER_OUT_OF_RANGE', field);
                }
            }
            // CHECK 约束统一在列循环外整体校验（支持跨列/表级约束）
            this._enforceChecks(data);
            // 主键唯一性检查（主键可能不在 _cachedUniqueFields 中）
            if (this._primaryKey && data[this._primaryKey] !== undefined && data[this._primaryKey] !== null) {
                const pkVal = data[this._primaryKey];
                if (this._pkIndex && this._pkIndex.has(pkVal)) {
                    throw createError('ER_DUP_ENTRY', String(pkVal), this._primaryKey);
                }
            }
            for (const fk of foreignKeys) {
                if (data[fk.field] !== undefined && data[fk.field] !== null) {
                    const refTable = this._resolveTable(fk.table);
                    if (refTable) {
                        const exists = refTable.findOne({ [fk.refField]: data[fk.field] });
                        if (!exists) throw createError('ER_NO_REFERENCED_ROW');
                    }
                }
            }
            if (autoIncField && data[autoIncField] === undefined) {
                autoIncSeq++;
                data[autoIncField] = baseAutoInc + autoIncSeq;
                this._autoIncrement = data[autoIncField];
            } else if (autoIncField && data[autoIncField] > this._autoIncrement) {
                this._autoIncrement = data[autoIncField];
            }
            const rowIdx = this._rows.length;
            this._rows.push(Object.assign({}, data));
            if (this._pkIndex && this._primaryKey) {
                const pkVal = data[this._primaryKey];
                if (pkVal !== undefined && pkVal !== null) {
                    // P1-1: insertMany 主键重复检查
                    if (this._pkIndex.has(pkVal)) throw createError('ER_DUP_ENTRY', String(pkVal), this._primaryKey);
                    this._pkIndex.set(pkVal, rowIdx);
                }
            }
            for (const [field, tree] of Object.entries(this._btrees)) {
                const val = data[field];
                if (val !== undefined && val !== null) tree.insert(val, rowIdx);
            }
            // 不写回调用方传入的 items，改为返回归一后的新数组
            result[i] = data;
        }
        this._dirty = true;
        this._db._markDirty(this._name);
        for (const hook of this._hooks.afterInsert) {
            for (let i = 0; i < N; i++) hook(result[i]);
        }
        this._db._emitChange('insertMany', this._name, { count: N });
        return result;
    }

    upsert(data) {
        if (this._primaryKey && data[this._primaryKey] !== undefined) {
            const existing = this.findById(data[this._primaryKey]);
            if (existing) {
                this.updateById(data[this._primaryKey], data);
                return this.findById(data[this._primaryKey]);
            }
        }
        return this.insert(data);
    }

    // ============================================================
    // 查询（支持 B-Tree 加速）
    // ============================================================

    find(query = {}) {
        let rows = this._getVisibleRows();
        if (Object.keys(query).length > 0) {
            rows = this._applyFilterOptimized(rows, query);
        }
        return rows.map(r => ({ ...r }));
    }

    findOne(query = {}) {
        let rows = this._getVisibleRows();
        if (Object.keys(query).length > 0) {
            rows = this._applyFilterOptimized(rows, query);
        }
        return rows.length > 0 ? { ...rows[0] } : null;
    }

    exists(query = {}) {
        if (Object.keys(query).length === 0) return this._getVisibleRows().length > 0;
        const rows = this._applyFilterOptimized(this._getVisibleRows(), query);
        return rows.length > 0;
    }

    findById(id) {
        if (!this._primaryKey) throw createError('ER_PARSE_ERROR', 'Table has no primary key');
        // Issue #44：字符串主键查询值先按列类型归一，否则索引静默未命中
        const key = this._coerceQueryValue(this._primaryKey, id);
        // Hash 索引 O(1)
        if (this._pkIndex) {
            const rowIndex = this._pkIndex.get(key);
            if (rowIndex !== undefined) {
                const row = this._rows[rowIndex];
                if (row && !row._deleted) return { ...row };
            }
        } else if (this._btrees[this._primaryKey]) {
            const indices = this._btrees[this._primaryKey].search(key);
            if (indices.length > 0) {
                const row = this._rows[indices[0]];
                if (row && !row._deleted) return { ...row };
            }
        }
        // 索引未命中不等于不存在：回落主键列全表匹配（类型差异 / 索引未覆盖的行）
        const row = this._rows.find(r => r && !r._deleted && r[this._primaryKey] === key);
        return row ? { ...row } : null;
    }

    findAll() {
        return this._getVisibleRows().map(r => ({ ...r }));
    }

    count(query = {}) {
        if (Object.keys(query).length === 0) return this._getVisibleRows().length;
        return this._applyFilterOptimized(this._getVisibleRows(), query).length;
    }

    where(conditions) {
        return new Query(this, conditions);
    }

    // ============================================================
    // 更新
    // ============================================================

    update(query, updates, opts = {}) {
        for (const hook of this._hooks.beforeUpdate) {
            updates = hook(query, { ...updates }) || updates;
        }

        updates = this._validateDataTypes(updates, true);
        const matched = this._applyFilterOptimized(this._getVisibleRows(), query);
        let count = 0;

        for (const row of matched) {
            const index = this._rows.indexOf(row);
            if (index === -1) continue;

            const oldData = { ...this._rows[index] };
            const merged = { ...this._rows[index], ...updates };
            this._validateConstraints(merged, index, undefined, opts);

            this._removeFromIndexes(index, oldData);
            Object.assign(this._rows[index], updates);
            this._addToIndexes(index, this._rows[index]);
            count++;
        }

        if (count > 0) {
            this._dirty = true;
            this._db._markDirty(this._name);
            for (const hook of this._hooks.afterUpdate) {
                hook(query, updates, count);
            }
            this._db._emitChange('update', this._name, { query, updates, count });
        }
        return count;
    }

    updateById(id, updates) {
        if (!this._primaryKey) throw createError('ER_PARSE_ERROR', 'Table has no primary key');
        for (const hook of this._hooks.beforeUpdate) {
            updates = hook({ [this._primaryKey]: id }, { ...updates }) || updates;
        }
        updates = this._validateDataTypes(updates, true);
        const pkKey = this._coerceQueryValue(this._primaryKey, id);
        let rowIndex;
        if (this._pkIndex) {
            rowIndex = this._pkIndex.get(pkKey);
        } else if (this._btrees[this._primaryKey]) {
            const indices = this._btrees[this._primaryKey].search(pkKey);
            rowIndex = indices.length > 0 ? indices[0] : undefined;
        }
        if (rowIndex === undefined) {
            // Issue #44：索引未命中时回落全表匹配
            const found = this._rows.findIndex(r => r && !r._deleted && r[this._primaryKey] === pkKey);
            if (found !== -1) rowIndex = found;
        }
        if (rowIndex === undefined) return 0;
        const row = this._rows[rowIndex];
        if (row && row._deleted) return 0;
        // P1-3：主键被更新时传播到外键引用（CASCADE / SET NULL / RESTRICT）
        if (updates[this._primaryKey] !== undefined && updates[this._primaryKey] !== pkKey) {
            this._propagatePKUpdate(pkKey, updates[this._primaryKey]);
        }
        const oldData = { ...row };
        const merged = { ...row, ...updates };
        this._validateConstraints(merged, rowIndex);
        this._removeFromIndexes(rowIndex, oldData);
        Object.assign(row, updates);
        this._addToIndexes(rowIndex, row);
        this._dirty = true;
        this._db._markDirty(this._name);
        for (const hook of this._hooks.afterUpdate) {
            hook({ [this._primaryKey]: id }, updates, 1);
        }
        this._db._emitChange('update', this._name, { query: { [this._primaryKey]: id }, updates, count: 1 });
        return 1;
    }

    // ============================================================
    // 删除 & 外键 CASCADE
    // ============================================================

    remove(query = {}) {
        for (const hook of this._hooks.beforeRemove) {
            if (hook(query) === false) return 0;
        }

        if (Object.keys(query).length === 0) {
            return this._truncate();
        }

        const toRemove = this._applyFilterOptimized(this._getVisibleRows(), query);
        let count = 0;
        const removeIndices = [];

        for (const row of toRemove) {
            const index = this._rows.indexOf(row);
            if (index === -1) continue;
            this._cascadeForeignKeys(row);
            this._removeFromIndexes(index, row);
            removeIndices.push(index);
            count++;
        }

        if (count > 0) {
            removeIndices.sort((a, b) => b - a);
            for (const idx of removeIndices) {
                const lastIdx = this._rows.length - 1;
                if (idx < lastIdx) {
                    const lastRow = this._rows[lastIdx];
                    this._rows[idx] = lastRow;
                    if (this._pkIndex && this._primaryKey) {
                        this._pkIndex.set(lastRow[this._primaryKey], idx);
                    }
                    for (const [field, tree] of Object.entries(this._btrees)) {
                        const val = lastRow[field];
                        if (val !== undefined && val !== null) {
                            tree.remove(val, lastIdx);
                            tree.insert(val, idx);
                        }
                    }
                    for (const field of Object.keys(this._indexes)) {
                        const val = lastRow[field];
                        if (val !== undefined && this._indexes[field].has(val)) {
                            const positions = this._indexes[field].get(val);
                            const pi = positions.indexOf(lastIdx);
                            if (pi !== -1) positions[pi] = idx;
                        }
                    }
                }
                this._rows.pop();
            }
            this._dirty = true;
            this._db._markDirty(this._name);
            for (const hook of this._hooks.afterRemove) {
                hook(query, count);
            }
            this._db._emitChange('remove', this._name, { query, count });
        }
        return count;
    }

    removeById(id) {
        if (!this._primaryKey) throw createError('ER_PARSE_ERROR', 'Table has no primary key');
        // Issue #44：同 findById，先按列类型归一查询值
        const pkKey = this._coerceQueryValue(this._primaryKey, id);
        let rowIndex;
        if (this._pkIndex) {
            rowIndex = this._pkIndex.get(pkKey);
        } else if (this._btrees[this._primaryKey]) {
            const indices = this._btrees[this._primaryKey].search(pkKey);
            rowIndex = indices.length > 0 ? indices[0] : undefined;
        }
        if (rowIndex === undefined) {
            // Issue #44：索引未命中时回落全表匹配
            const found = this._rows.findIndex(r => r && !r._deleted && r[this._primaryKey] === pkKey);
            if (found !== -1) rowIndex = found;
        }
        if (rowIndex === undefined) return 0;
        const row = this._rows[rowIndex];
        if (!row || row._deleted) return 0;
        this._cascadeForeignKeys(row);
        this._removeFromIndexes(rowIndex, row);
        const lastIdx = this._rows.length - 1;
        if (rowIndex < lastIdx) {
            const lastRow = this._rows[lastIdx];
            this._rows[rowIndex] = lastRow;
            if (this._pkIndex && this._primaryKey) {
                this._pkIndex.set(lastRow[this._primaryKey], rowIndex);
            }
            for (const [field, tree] of Object.entries(this._btrees)) {
                const val = lastRow[field];
                if (val !== undefined && val !== null) {
                    tree.remove(val, lastIdx);
                    tree.insert(val, rowIndex);
                }
            }
            for (const field of Object.keys(this._indexes)) {
                const val = lastRow[field];
                if (val !== undefined && this._indexes[field].has(val)) {
                    const positions = this._indexes[field].get(val);
                    const pi = positions.indexOf(lastIdx);
                    if (pi !== -1) positions[pi] = rowIndex;
                }
            }
        }
        this._rows.pop();
        this._dirty = true;
        this._db._markDirty(this._name);
        for (const hook of this._hooks.afterRemove) {
            hook({ [this._primaryKey]: id }, 1);
        }
        this._db._emitChange('remove', this._name, { query: { [this._primaryKey]: id }, count: 1 });
        return 1;
    }

    removeSoft(query = {}) {
        if (!this._softDelete) throw createError('ER_NOT_SUPPORTED', 'Soft delete is not enabled');
        const matched = this._applyFilterOptimized(this._getVisibleRows(), query);
        let count = 0;
        const now = new Date().toISOString();
        for (const row of matched) {
            const index = this._rows.indexOf(row);
            if (index === -1) continue;
            this._removeFromIndexes(index, row);
            row._deleted = true;
            row._deletedAt = now;
            this._addToIndexes(index, row);
            count++;
        }
        if (count > 0) {
            this._dirty = true;
            this._db._markDirty(this._name);
            for (const hook of this._hooks.afterRemove) {
                hook(query, count);
            }
            this._db._emitChange('remove', this._name, { query, count, soft: true });
        }
        return count;
    }

    _findRowIndex(id) {
        if (this._pkIndex && this._primaryKey) {
            const idx = this._pkIndex.get(id);
            if (idx !== undefined) return idx;
        }
        for (let i = 0; i < this._rows.length; i++) {
            if (this._rows[i][this._primaryKey] === id) return i;
        }
        return -1;
    }

    restore(query = {}) {
        if (!this._softDelete) throw createError('ER_NOT_SUPPORTED', 'Soft delete is not enabled');
        const matched = this._applyFilter(this._rows, { ...query, _deleted: true });
        for (const row of matched) {
            const index = this._rows.indexOf(row);
            if (index !== -1) {
                delete this._rows[index]._deleted;
                delete this._rows[index]._deletedAt;
            }
        }
        return matched.length;
    }

    truncate() {
        return this._truncate();
    }

    _truncate() {
        const count = this._rows.length;
        this._rows = [];
        if (this._pkIndex) this._pkIndex.clear();
        for (const key of Object.keys(this._btrees)) {
            this._btrees[key].clear();
        }
        this._indexes = {};
        this._autoIncrement = 0;
        // P1-13: truncate 不应重置软删除模式——保留原值
        this._dirty = true;
        this._db._markDirty(this._name);
        return count;
    }

    // ============================================================
    // ALTER TABLE
    // ============================================================

    addColumn(field, definition) {
        if (this._schema[field]) throw createError('ER_DUP_FIELDNAME', field);
        this._schema[field] = definition;
        // P1-14: 更新缓存字段列表，使新列的 unique/required 约束生效
        if (!this._cachedSchemaFields.includes(field)) this._cachedSchemaFields.push(field);
        if (definition.unique && !this._cachedUniqueFields.includes(field)) this._cachedUniqueFields.push(field);
        if (definition.required && !this._cachedRequiredFields.includes(field)) this._cachedRequiredFields.push(field);
        if (definition.default !== undefined) {
            this._defaults[field] = definition.default;
            for (const row of this._rows) {
                if (row[field] === undefined) {
                    row[field] = typeof definition.default === 'function' ? definition.default() : definition.default;
                }
            }
        }
        this._registerChecks(field, definition);
        if (definition.foreignKey) {
            this._foreignKeys.push({
                field,
                table: definition.foreignKey.table,
                refField: definition.foreignKey.field || 'id',
                onDelete: definition.foreignKey.onDelete || 'restrict',
                onUpdate: definition.foreignKey.onUpdate || 'restrict'
            });
        }
        if (definition.computed) this._computedFields[field] = definition.computed;
        if (['date', 'datetime', 'timestamp', 'time'].includes(definition.type)) {
            this._dateFields[field] = definition.type;
        }
        if (definition.primaryKey || definition.unique) {
            this._btrees[field] = new BTree(64, true);
            this._rebuildBTree(field);
        }
        // P1-8: 添加主键列时设置 _primaryKey 并重建 pkIndex
        if (definition.primaryKey) {
            this._primaryKey = field;
            if (this._pkIndex) this._pkIndex.clear();
            for (let i = 0; i < this._rows.length; i++) {
                const val = this._rows[i][field];
                if (val !== undefined && val !== null) this._pkIndex.set(val, i);
            }
        }
        this._refreshSchemaCache();
        this._dirty = true;
        this._db._markDirty(this._name);
        return this;
    }

    dropColumn(field) {
        if (!this._schema[field]) throw createError('ER_CANT_DROP_FIELD', field);
        delete this._schema[field];
        delete this._defaults[field];
        delete this._btrees[field];
        delete this._indexes[field];
        this._checkConstraints = this._checkConstraints.filter(c => c.field !== field);
        this._foreignKeys = this._foreignKeys.filter(fk => fk.field !== field);
        delete this._computedFields[field];
        delete this._dateFields[field];
        for (const row of this._rows) {
            delete row[field];
        }
        // P1-8: 删除主键列时清空 pkIndex
        if (this._primaryKey === field) {
            this._primaryKey = null;
            if (this._pkIndex) this._pkIndex.clear();
        }
        if (this._autoIncrementField === field) this._autoIncrementField = null;
        this._refreshSchemaCache();
        this._dirty = true;
        this._db._markDirty(this._name);
        return this;
    }

    renameColumn(oldName, newName) {
        if (!this._schema[oldName]) throw createError('ER_BAD_FIELD_ERROR', oldName, this._name);
        if (this._schema[newName]) throw createError('ER_DUP_FIELDNAME', newName);
        this._schema[newName] = this._schema[oldName];
        delete this._schema[oldName];
        if (this._defaults[oldName] !== undefined) {
            this._defaults[newName] = this._defaults[oldName];
            delete this._defaults[oldName];
        }
        if (this._btrees[oldName]) {
            this._btrees[newName] = this._btrees[oldName];
            delete this._btrees[oldName];
            this._btrees[newName].clear();
            for (let i = 0; i < this._rows.length; i++) {
                const val = this._rows[i][newName];
                if (val !== undefined && val !== null) this._btrees[newName].insert(val, i);
            }
        }
        for (const row of this._rows) {
            row[newName] = row[oldName];
            delete row[oldName];
        }
        if (this._indexes[oldName]) {
            this._indexes[newName] = this._indexes[oldName];
            delete this._indexes[oldName];
        }
        this._foreignKeys = this._foreignKeys.filter(fk => true);
        for (const fk of this._foreignKeys) {
            if (fk.field === oldName) fk.field = newName;
        }
        this._checkConstraints = this._checkConstraints.map(c =>
            c.field === oldName ? { ...c, field: newName } : c);
        if (this._computedFields[oldName]) {
            this._computedFields[newName] = this._computedFields[oldName];
            delete this._computedFields[oldName];
        }
        if (this._dateFields[oldName]) {
            this._dateFields[newName] = this._dateFields[oldName];
            delete this._dateFields[oldName];
        }
        if (this._primaryKey === oldName) this._primaryKey = newName;
        if (this._autoIncrementField === oldName) this._autoIncrementField = newName;
        this._refreshSchemaCache();
        this._dirty = true;
        this._db._markDirty(this._name);
        return this;
    }

    modifyColumn(field, definition) {
        if (!this._schema[field]) throw createError('ER_BAD_FIELD_ERROR', field, this._name);
        this._schema[field] = { ...this._schema[field], ...definition };
        if (definition.default !== undefined) this._defaults[field] = definition.default;
        this._checkConstraints = this._checkConstraints.filter(c => c.field !== field);
        this._registerChecks(field, definition);
        if (definition.primaryKey !== undefined || definition.unique !== undefined) {
            if (definition.primaryKey || definition.unique) {
                if (!this._btrees[field]) this._btrees[field] = new BTree(64, true);
                this._rebuildBTree(field);
            } else {
                delete this._btrees[field];
            }
        }
        if (definition.type && ['date', 'datetime', 'timestamp', 'time'].includes(definition.type)) {
            this._dateFields[field] = definition.type;
        } else if (definition.type) {
            delete this._dateFields[field];
        }
        this._refreshSchemaCache();
        this._dirty = true;
        this._db._markDirty(this._name);
        return this;
    }

    describe() {
        return {
            name: this._name,
            columns: { ...this._schema },
            primaryKey: this._primaryKey,
            rowCount: this._getVisibleRows().length,
            btreeIndexes: Object.keys(this._btrees),
            hashIndexes: Object.keys(this._indexes),
            softDelete: this._softDelete,
            foreignKeys: this._foreignKeys.map(fk => ({ field: fk.field, table: fk.table }))
        };
    }

    selectInto(newTableName, newSchema, query = {}) {
        const rows = this._applyFilterOptimized(this._getVisibleRows(), query);
        this._db.createTable(newTableName, newSchema);
        const newTable = this._db._tables[newTableName];
        for (const row of rows) {
            newTable.insert(row);
        }
        return newTable;
    }

    textSearch(field, terms) {
        const searchTerms = Array.isArray(terms) ? terms : terms.split(/\s+/);
        const rows = this._getVisibleRows();
        const scored = [];
        for (const row of rows) {
            const value = String(row[field] || '').toLowerCase();
            let score = 0;
            for (const term of searchTerms) {
                const t = term.toLowerCase();
                const idx = value.indexOf(t);
                if (idx !== -1) {
                    score += 10 + (idx === 0 ? 5 : 0) + (value === t ? 20 : 0)
                        + (value.length - idx) / value.length * 5;
                }
            }
            if (score > 0) scored.push({ ...row, _score: score });
        }
        return scored.sort((a, b) => b._score - a._score);
    }

    // ============================================================
    // 索引
    // ============================================================

    createIndex(field) {
        this._indexes[field] = new Map();
        for (let i = 0; i < this._rows.length; i++) {
            const value = this._rows[i][field];
            if (value !== undefined) {
                if (!this._indexes[field].has(value)) {
                    this._indexes[field].set(value, []);
                }
                this._indexes[field].get(value).push(i);
            }
        }
        return this._indexes[field];
    }

    dropIndex(field) {
        delete this._indexes[field];
        delete this._btrees[field];
    }

    /**
     * 创建 B-Tree 索引（O(log n) 查询）
     */
    createBTreeIndex(field, unique = false) {
        this._btrees[field] = new BTree(64, unique);
        this._rebuildBTree(field);
        return this._btrees[field];
    }

    _rebuildBTree(field) {
        if (this._btrees[field]) {
            this._btrees[field].clear();
            for (let i = 0; i < this._rows.length; i++) {
                const val = this._rows[i][field];
                if (val !== undefined && val !== null) {
                    this._btrees[field].insert(val, i);
                }
            }
        }
    }


    _rebuildAllBTrees() {
        for (const field of Object.keys(this._btrees)) {
            this._rebuildBTree(field);
        }
    }

    // ============================================================
    // 事件钩子
    // ============================================================

    on(event, callback) {
        if (this._hooks[event]) {
            this._hooks[event].push(callback);
        }
        return this;
    }

    off(event, callback) {
        if (this._hooks[event]) {
            this._hooks[event] = this._hooks[event].filter(cb => cb !== callback);
        }
        return this;
    }

    // ============================================================
    // 内部: 过滤器（B-Tree 加速）
    // ============================================================

    _rowsFromIndices(indices) {
        const subset = [];
        for (let i = 0; i < indices.length; i++) {
            const row = this._rows[indices[i]];
            if (row) subset.push(row);
        }
        return subset;
    }

    _likePrefix(pattern) {
        if (typeof pattern !== 'string' || pattern.length === 0) return null;
        if (pattern[0] === '%' || pattern[0] === '_') return null;
        let end = pattern.length;
        for (let i = 0; i < pattern.length; i++) {
            const c = pattern[i];
            if (c === '%' || c === '_') { end = i; break; }
        }
        return end > 0 ? pattern.slice(0, end) : null;
    }

    /**
     * Issue #44：按列声明类型归一查询值。
     *
     * 索引（B-Tree / hash）命中用的是严格 ===，所以字符串 '5' 永远搜不到
     * INT 列里的数字 5，表现为「静默返回空」；SQL 的 WHERE 路径早就在
     * 解析阶段强转过了，文档 API 这条路径没有。
     *
     * 归一结果与 insert 时 _validateDataTypes 的产物一致（整数 → number/BigInt、
     * 浮点 → number、布尔 → boolean、字符串列 → string）。无法归一的值原样返回。
     */
    _coerceQueryValue(field, value) {
        const def = this._schema && this._schema[field];
        if (!def || typeof def === 'string' || value === null || value === undefined) return value;
        const t = String(def.type || '').toLowerCase();
        if (t === 'integer' || t === 'int' || t === 'bigint') {
            if (typeof value === 'bigint') {
                return (value >= SAFE_INT_MIN && value <= SAFE_INT_MAX) ? Number(value) : value;
            }
            if (typeof value === 'number') return value;
            if (typeof value === 'string' && DECIMAL_INT_RE.test(value.trim())) {
                try { return normalizeInteger(value.trim(), t); } catch (_) { return value; }
            }
            return value;
        }
        if (t === 'float' || t === 'double' || t === 'number' || t === 'real') {
            if (typeof value === 'number') return value;
            if (typeof value === 'string' && value.trim() !== '' && !Number.isNaN(Number(value))) return Number(value);
            return value;
        }
        if (t === 'boolean' || t === 'bool') {
            if (typeof value === 'boolean') return value;
            if (value === 0 || value === 1) return !!value;
            if (typeof value === 'string' && ['true', 'false', '1', '0'].includes(value.toLowerCase())) {
                return value.toLowerCase() === 'true' || value === '1';
            }
            return value;
        }
        if (t === 'string' || t === 'text' || t === 'varchar' || t === 'char') {
            if (typeof value === 'string') return value;
            if (typeof value === 'number' || typeof value === 'boolean' || value instanceof Date) return String(value);
            return value;
        }
        return value;
    }

    /** 按 schema 归一 query 中的等值 / $eq / $in / 范围值（Issue #44）。 */
    _coerceQuery(query) {
        let out = null;
        const set = (field, value) => {
            if (!out) out = { ...query };
            out[field] = value;
        };
        for (const [field, condition] of Object.entries(query)) {
            if (field === '$or' || field === '$and') {
                if (Array.isArray(condition)) {
                    const subs = condition.map(c => (c && typeof c === 'object' && !Array.isArray(c)) ? this._coerceQuery(c) : c);
                    if (subs.some((s, i) => s !== condition[i])) set(field, subs);
                }
                continue;
            }
            if (field === '$not' || field[0] === '$' || !this._schema[field]) continue;
            const next = this._coerceCondition(field, condition);
            if (next !== condition) set(field, next);
        }
        return out || query;
    }

    _coerceCondition(field, condition) {
        if (condition === null || typeof condition !== 'object' || condition instanceof RegExp) {
            return this._coerceQueryValue(field, condition);
        }
        if (Array.isArray(condition)) {
            const next = condition.map(v => this._coerceQueryValue(field, v));
            return next.some((v, i) => v !== condition[i]) ? next : condition;
        }
        const keys = Object.keys(condition);
        if (keys.length === 0 || !keys.every(k => k[0] === '$')) return condition;
        let copy = null;
        for (const [op, val] of Object.entries(condition)) {
            let next = val;
            if (op === '$eq' || op === '$ne' || op === '$gt' || op === '$gte' || op === '$lt' || op === '$lte') {
                next = this._coerceQueryValue(field, val);
            } else if ((op === '$in' || op === '$nin' || op === '$between') && Array.isArray(val)) {
                next = val.map(v => this._coerceQueryValue(field, v));
            }
            if (next !== val) {
                if (!copy) copy = { ...condition };
                copy[op] = next;
            }
        }
        return copy || condition;
    }

    _applyFilterOptimized(rows, query) {
        // Issue #44：索引查找前先把查询值归一成列声明类型，避免 '5' 查不到 5
        const q = this._coerceQuery(query);
        for (const [field, condition] of Object.entries(q)) {
            if (field === '$or' || field === '$and' || field === '$not') continue;
            if (typeof condition !== 'object' || condition === null || Array.isArray(condition) || condition instanceof RegExp) {
                if (this._btrees[field]) {
                    const indices = this._btrees[field].search(condition);
                    // #44：索引未命中时回落全表过滤——索引键是严格相等的，
                    // 类型/形态不一致的行会被漏掉，不能直接断言「没有数据」。
                    if (indices.length === 0) return this._applyFilter(rows, q);
                    return this._applyFilter(this._rowsFromIndices(indices), q);
                }
                if (this._indexes[field] && this._indexes[field].has(condition)) {
                    return this._applyFilter(this._rowsFromIndices(this._indexes[field].get(condition)), q);
                }
                if (this._indexes[field]) return this._applyFilter(rows, q);
            }
            if (condition && typeof condition === 'object') {
                if (this._btrees[field] && Array.isArray(condition.$in) && condition.$in.length > 0) {
                    const indices = this._btrees[field].searchMany(condition.$in);
                    if (indices.length === 0) return this._applyFilter(rows, q);
                    return this._applyFilter(this._rowsFromIndices(indices), q);
                }
                if (this._btrees[field] && typeof condition.$like === 'string') {
                    const prefix = this._likePrefix(condition.$like);
                    if (prefix) {
                        const indices = this._btrees[field].prefix(prefix);
                        if (indices.length === 0) return this._applyFilter(rows, q);
                        return this._applyFilter(this._rowsFromIndices(indices), q);
                    }
                }
                if (this._btrees[field] && (condition.$gt !== undefined || condition.$gte !== undefined ||
                    condition.$lt !== undefined || condition.$lte !== undefined || condition.$between)) {
                    let min, max, exclusiveMin = false, exclusiveMax = false;
                    if (condition.$between && Array.isArray(condition.$between) && condition.$between.length === 2) {
                        min = condition.$between[0];
                        max = condition.$between[1];
                    } else {
                        if (condition.$gte !== undefined) min = condition.$gte;
                        else if (condition.$gt !== undefined) { min = condition.$gt; exclusiveMin = true; }
                        if (condition.$lte !== undefined) max = condition.$lte;
                        else if (condition.$lt !== undefined) { max = condition.$lt; exclusiveMax = true; }
                    }
                    if (min === undefined && max === undefined) continue;
                    let indices;
                    if (min !== undefined && max !== undefined) {
                        indices = this._btrees[field].range(min, max);
                    } else if (min !== undefined) {
                        indices = exclusiveMin ? this._btrees[field].greaterThan(min) : this._btrees[field].greaterThanEqual(min);
                    } else {
                        indices = exclusiveMax ? this._btrees[field].lessThan(max) : this._btrees[field].lessThanEqual(max);
                    }
                    return this._applyFilter(this._rowsFromIndices(indices), q);
                }
            }
        }
        return this._applyFilter(rows, q);
    }

    /**
     * 把 filter 编译成一个谓词函数。
     *
     * 动机（实测数据，10 万行）：
     *   _matchRow 每行都要做 Object.entries(query)、Object.keys(condition)、
     *   以及一串 startswith 判断。这部分占单次全表扫描耗时的 **98%** ——
     *   点查 13.9ms/次，其中 13.6ms 是反射；同样语义的手写循环只要 0.28ms。
     *   $like / $regex 更糟：正则每行每字段重编一次。
     *
     * 做法：编译一次，把字段、路径、操作符、正则全部预先解析好，
     * 循环里只剩取值和比较。语义与 _matchRow 逐一对应。
     *
     * 遇到冷门操作符（$inSub / $elemMatch / $textSearch / $expr …）
     * 时**只把那一个字段**退回 _matchRow，其余字段仍走快路径 ——
     * 既保住语义，也不让混合查询整体退回。
     */
    _compileMatcher(query) {
        const self = this;
        const parts = [];
        for (const [field, condition] of Object.entries(query)) {
            // --- 顶层逻辑操作符 ---
            if (field === '$or' || field === '$and') {
                if (!Array.isArray(condition)) { parts.push({ k: 0 }); continue; }   // 原实现直接 return false
                parts.push({ k: field === '$or' ? 3 : 4, subs: condition.map(c => self._compileMatcher(c)) });
                continue;
            }
            if (field === '$not') {
                // $not 的条件形态太多（对象/标量都合法），整体退回，保证逐字一致
                parts.push({ k: 7, q: { $not: condition } });
                continue;
            }

            // --- 字段路径：点号路径预先切好，循环里不再 split/includes ---
            const path = (field.indexOf('.') !== -1 && field[0] !== '$') ? field.split('.') : null;

            const plainObj = condition !== null && typeof condition === 'object'
                && !Array.isArray(condition) && !(condition instanceof RegExp);

            if (!plainObj) {
                parts.push({ k: 1, path, field, target: condition });   // 等值
                continue;
            }

            const keys = Object.keys(condition);
            const isOp = keys.length > 0 && keys.every(k => k[0] === '$');
            if (!isOp) {
                // 嵌套对象匹配
                parts.push({ k: 5, path, field, sub: self._compileMatcher(condition) });
                continue;
            }

            // --- 操作符：能编译的编译，不能的整体退回这一字段 ---
            const ops = [];
            let ok = true;
            for (const [op, target] of Object.entries(condition)) {
                if (op === '$like' && typeof target === 'string') {
                    const escaped = target
                        .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
                        .replace(/%/g, '.*')
                        .replace(/_/g, '.');
                    ops.push({ op, re: new RegExp('^' + escaped + '$', 'i') });
                } else if (op === '$regex' && !(target instanceof RegExp) && typeof target === 'string') {
                    if (!isSafeRegex(target)) throw createError('ER_BAD_REGEX', String(target));
                    ops.push({ op, re: new RegExp(target) });
                } else if (FAST_MATCH_OPS.has(op)) {
                    ops.push({ op, target });
                } else {
                    ok = false;
                    break;
                }
            }
            if (!ok) { parts.push({ k: 7, q: { [field]: condition } }); continue; }
            parts.push({ k: 2, path, field, ops });
        }

        return function match(row) {
            for (let i = 0; i < parts.length; i++) {
                const p = parts[i];
                switch (p.k) {
                    case 1: {   // 等值
                        const v = p.path ? self._walk(row, p.path) : row[p.field];
                        if (v !== p.target) return false;
                        break;
                    }
                    case 2: {   // 操作符
                        const v = p.path ? self._walk(row, p.path) : row[p.field];
                        const ops = p.ops;
                        for (let j = 0; j < ops.length; j++) {
                            const o = ops[j];
                            const op = o.op;
                            if (op === '$eq') { if (v !== o.target) return false; }
                            else if (op === '$ne') { if (v === o.target) return false; }
                            else if (op === '$gt') { if (!(v > o.target)) return false; }
                            else if (op === '$gte') { if (!(v >= o.target)) return false; }
                            else if (op === '$lt') { if (!(v < o.target)) return false; }
                            else if (op === '$lte') { if (!(v <= o.target)) return false; }
                            else if (op === '$in') { if (!Array.isArray(o.target) || o.target.indexOf(v) === -1) return false; }
                            else if (op === '$nin') {
                                // 非数组 target 时原实现返回 false（不匹配），不能当成通过
                                if (!Array.isArray(o.target) || o.target.indexOf(v) !== -1) return false;
                            }
                            else if (op === '$between') {
                                if (!Array.isArray(o.target) || o.target.length !== 2
                                    || !(v >= o.target[0]) || !(v <= o.target[1])) return false;
                            }
                            else if (op === '$exists') { if (o.target ? v === undefined : v !== undefined) return false; }
                            else if (op === '$isNull') {
                                const isn = v === null || v === undefined;
                                if (o.target ? !isn : isn) return false;
                            }
                            else if (op === '$startsWith') { if (typeof v !== 'string' || !v.startsWith(o.target)) return false; }
                            else if (op === '$endsWith') { if (typeof v !== 'string' || !v.endsWith(o.target)) return false; }
                            else if (op === '$contains') { if (!Array.isArray(v) || v.indexOf(o.target) === -1) return false; }
                            else if (op === '$type') { if (typeof v !== o.target) return false; }
                            else if (op === '$size') { if (!Array.isArray(v) || v.length !== o.target) return false; }
                            else if (op === '$like') {
                                if (typeof v !== 'string') return false;
                                if (!o.re.test(v)) return false;
                            }
                            else if (op === '$regex') {
                                if (o.re instanceof RegExp) { if (!o.re.test(String(v))) return false; }
                                else if (!o.re.test(v)) return false;
                            }
                            else { if (!self._matchOperator(v, op, o.target)) return false; }
                        }
                        break;
                    }
                    case 3: {   // $or
                        let hit = false;
                        for (let j = 0; j < p.subs.length; j++) { if (p.subs[j](row)) { hit = true; break; } }
                        if (!hit) return false;
                        break;
                    }
                    case 4: {   // $and
                        for (let j = 0; j < p.subs.length; j++) if (!p.subs[j](row)) return false;
                        break;
                    }
                    case 5: {   // 嵌套对象
                        const v = p.path ? self._walk(row, p.path) : row[p.field];
                        if (v === null || typeof v !== 'object') return false;
                        if (!p.sub(v)) return false;
                        break;
                    }
                    case 7: {   // 退回原有逐字段求值
                        if (!self._matchRow(row, p.q)) return false;
                        break;
                    }
                    default: return false;   // k===0：原实现直接 return false
                }
            }
            return true;
        };
    }

    /** 点号路径取值，与 _resolvePath 的分支语义一致 */
    _walk(row, parts) {
        let v = row;
        for (let i = 0; i < parts.length; i++) {
            if (v === null || v === undefined) return undefined;
            v = v[parts[i]];
        }
        return v;
    }

    _applyFilter(rows, query) {
        const match = this._compileMatcher(query);
        const soft = this._softDelete;
        const result = [];
        for (let i = 0; i < rows.length; i++) {
            const r = rows[i];
            // 软删除行不应出现在任何查询结果中
            if (soft && r._deleted) continue;
            if (match(r)) result.push(r);
        }
        return result;
    }

    _matchRow(row, query) {
        for (const [field, condition] of Object.entries(query)) {
            if (field === '$or') {
                if (!Array.isArray(condition) || !condition.some(sub => this._matchRow(row, sub))) return false;
                continue;
            }
            if (field === '$and') {
                if (!Array.isArray(condition) || !condition.every(sub => this._matchRow(row, sub))) return false;
                continue;
            }
            if (field === '$not') {
                if (this._matchRow(row, condition)) return false;
                continue;
            }

            const value = this._resolvePath(row, field);

            if (condition !== null && typeof condition === 'object' && !Array.isArray(condition) && !(condition instanceof RegExp)) {
                const keys = Object.keys(condition);
                const isOperator = keys.every(k => k.startsWith('$'));
                if (isOperator && keys.length > 0) {
                    for (const [op, target] of Object.entries(condition)) {
                        if (!this._matchOperator(value, op, target)) return false;
                    }
                } else {
                    if (value !== null && typeof value === 'object') {
                        if (!this._matchRow(value, condition)) return false;
                    } else {
                        return false;
                    }
                }
            } else {
                if (value !== condition) return false;
            }
        }
        return true;
    }

    _matchOperator(value, op, target) {
        switch (op) {
            case '$eq': return value === target;
            case '$ne': return value !== target;
            case '$gt': return value > target;
            case '$gte': return value >= target;
            case '$lt': return value < target;
            case '$lte': return value <= target;
            case '$in': return Array.isArray(target) && target.includes(value);
            case '$nin': return Array.isArray(target) && !target.includes(value);
            case '$like':
                if (typeof value !== 'string' || typeof target !== 'string') return false;
                {
                    const escaped = target
                        .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
                        .replace(/%/g, '.*')
                        .replace(/_/g, '.');
                    return new RegExp('^' + escaped + '$', 'i').test(value);
                }
            case '$regex':
                if (target instanceof RegExp) return target.test(String(value));
                if (!isSafeRegex(target)) throw createError('ER_BAD_REGEX', String(target));
                return new RegExp(target).test(String(value));
            case '$exists':
                return target ? value !== undefined : value === undefined;
            case '$between':
                return Array.isArray(target) && target.length === 2 && value >= target[0] && value <= target[1];
            case '$and':
                return Array.isArray(target) && target.every(sub => this._matchRow({ _val: value }, { _val: sub }));
            case '$or':
                return Array.isArray(target) && target.some(sub => this._matchRow({ _val: value }, { _val: sub }));
            case '$not':
                return !this._matchRow({ _val: value }, { _val: target });
            case '$contains':
                return Array.isArray(value) && value.includes(target);
            case '$type':
                return typeof value === target;
            case '$size':
                return Array.isArray(value) && value.length === target;
            case '$elemMatch':
                return Array.isArray(value) && value.some(el =>
                    typeof el === 'object' ? this._matchRow(el, target) : el === target);
            case '$isNull':
                return target ? value === null || value === undefined : value !== null && value !== undefined;
            case '$startsWith':
                return typeof value === 'string' && value.startsWith(target);
            case '$endsWith':
                return typeof value === 'string' && value.endsWith(target);
            case '$search':
                if (typeof value !== 'string') return false;
                const terms = Array.isArray(target) ? target : [target];
                return terms.every(t => value.toLowerCase().includes(t.toLowerCase()));
            case '$textSearch':
                if (typeof value !== 'string') return false;
                const sTerms = Array.isArray(target) ? target : target.split(/\s+/);
                return sTerms.some(t => value.toLowerCase().includes(t.toLowerCase()));
            case '$inSub':
                if (!target || !target.table) return false;
                const subRows = target.table._applyFilter(target.table._rows, target.query || {});
                return subRows.some(r => r[target.field] === value);
            case '$notInSub':
                if (!target || !target.table) return false;
                const subRows2 = target.table._applyFilter(target.table._rows, target.query || {});
                return !subRows2.some(r => r[target.field] === value);
            case '$expr':
                if (typeof target === 'function') return target(value);
                return false;
            default:
                return false;
        }
    }

    _resolvePath(row, field) {
        if (field.includes('.') && !field.startsWith('$')) {
            const parts = field.split('.');
            let value = row;
            for (const part of parts) {
                if (value === null || value === undefined) return undefined;
                value = value[part];
            }
            return value;
        }
        return row[field];
    }

    // ============================================================
    // 内部: 约束校验
    // ============================================================

    _validateConstraints(data, excludeIndex, uniqueTracker, opts = {}) {
        // CHECK 约束（含跨列/表级）：整行校验一次，不能按"当前列"门控 ——
        // 否则 UPDATE 只改 y 时，挂在 x 上的 CHECK(x > y) 就漏检了。
        this._enforceChecks(data);
        for (const [field, def] of Object.entries(this._schema)) {
            if (field === '_softDelete') continue;

            // NOT NULL
            if (def.required && (data[field] === undefined || data[field] === null)
                && !(def.autoIncrement && data[field] === undefined)) {
                throw createError('ER_BAD_NULL_ERROR', field);
            }

            // PRIMARY KEY 不允许显式 NULL。
            // CREATE TABLE 里只写 PRIMARY KEY 时 def.required 并没被置上（只有 NOT NULL 才会），
            // 于是 INSERT ... VALUES (NULL, ...) 能写进一行没有身份的数据：
            // 主键索引里查不到、二次插入也不冲突，等于绕过了唯一约束。
            // 自增主键例外：MySQL 会自行分配（这里 storage 层也已经逐行分配）。
            if ((def.primaryKey || def.primary === true) && !def.autoIncrement
                && data[field] === null) {
                throw createError('ER_BAD_NULL_ERROR', field);
            }

            // PRIMARY KEY 唯一性
            if ((def.primaryKey || def.primary === true) && data[field] !== undefined && data[field] !== null) {
                let dup = false;
                if (uniqueTracker && uniqueTracker[field]) {
                    dup = uniqueTracker[field].has(data[field]);
                } else if (this._pkIndex) {
                    const idx = this._pkIndex.get(data[field]);
                    dup = idx !== undefined && idx !== null && idx !== excludeIndex;
                } else {
                    const idx = this._rows.findIndex(r => r[field] === data[field]);
                    dup = idx !== -1 && idx !== excludeIndex;
                }
                if (dup) {
                    throw createError('ER_DUP_ENTRY', String(data[field]), field);
                }
            }

            // UNIQUE（B-Tree 优化 O(log n)）
            if (def.unique && data[field] !== undefined) {
                if (uniqueTracker && uniqueTracker[field]) {
                    if (uniqueTracker[field].has(data[field])) {
                        throw createError('ER_DUP_ENTRY', String(data[field]), field);
                    }
                    uniqueTracker[field].add(data[field]);
                } else if (this._btrees[field]) {
                    const found = this._btrees[field].search(data[field]);
                    if (found.length > 0) {
                        for (const idx of found) {
                            if (idx !== excludeIndex && this._rows[idx] && this._rows[idx][field] === data[field]) {
                                throw createError('ER_DUP_ENTRY', String(data[field]), field);
                            }
                        }
                    }
                } else {
                    for (let i = 0; i < this._rows.length; i++) {
                        if (i === excludeIndex) continue;
                        if (this._rows[i][field] === data[field]) {
                            throw createError('ER_DUP_ENTRY', String(data[field]), field);
                        }
                    }
                }
            }

            // 长度限制
            if (def.length && typeof data[field] === 'string' && data[field].length > def.length) {
                throw createError('ER_DATA_TOO_LONG', field);
            }

            // 数值范围
            if ((def.type === 'integer' || def.type === 'int' || def.type === 'bigint')
                && data[field] !== undefined && data[field] !== null) {
                const raw = data[field];
                const v = typeof raw === 'bigint' ? raw : Number(raw);
                const min = typeof raw === 'bigint' && Number.isInteger(def.min) ? BigInt(def.min) : def.min;
                const max = typeof raw === 'bigint' && Number.isInteger(def.max) ? BigInt(def.max) : def.max;
                if (def.min !== undefined && v < min) throw createError('ER_OUT_OF_RANGE', field);
                if (def.max !== undefined && v > max) throw createError('ER_OUT_OF_RANGE', field);
            }
        }

        // FOREIGN KEY 校验
        // skipForeignKeys：父表主键 CASCADE 传播时，子表的新值尚未在父表生效，
        // 此时跳过本表 FK 复查（否则合法的 CASCADE 会被自己拦住）。
        if (!opts.skipForeignKeys) this._validateForeignKeys(data);
    }

    /** 仅校验外键引用是否存在（供插入/更新路径复用） */
    _validateForeignKeys(data) {
        for (const fk of this._foreignKeys) {
            if (data[fk.field] !== undefined && data[fk.field] !== null) {
                const refTable = this._resolveTable(fk.table);
                if (refTable) {
                    const exists = refTable.findOne({ [fk.refField]: data[fk.field] });
                    if (!exists) {
                        throw createError('ER_NO_REFERENCED_ROW');
                    }
                }
            }
        }
    }

    _resolveTable(tableRef) {
        if (typeof tableRef === 'string') {
            return this._db._tables[tableRef] || this._db._attached[tableRef]?._tables[tableRef];
        }
        return tableRef;
    }

    /**
     * 级联外键操作：当删除当前表的行时，查找所有引用此表的子表
     * 并执行 CASCADE / SET NULL / RESTRICT（P1-3：RESTRICT 之前静默放行）
     */
    _cascadeForeignKeys(row, opts = {}) {
        for (const [, table] of Object.entries(this._db._tables)) {
            if (table._name === this._name) continue;
            for (const fk of table._foreignKeys) {
                const refTable = table._resolveTable(fk.table);
                if (!refTable || refTable._name !== this._name) continue;

                // 被引用列值为 NULL 时不构成引用（SQL 语义），不参与约束
                const refVal = row[fk.refField];
                if (refVal === undefined || refVal === null) continue;

                // 检查子表行是否引用当前行（软删除模式下行已不可见则不阻断）
                const refs = table._applyFilterOptimized(table._getVisibleRows(), { [fk.field]: refVal });
                if (refs.length === 0) continue;

                if (fk.onDelete === 'cascade') {
                    table.remove({ [fk.field]: row[fk.refField] });
                } else if (fk.onDelete === 'set null') {
                    table.update({ [fk.field]: row[fk.refField] }, { [fk.field]: null });
                } else {
                    // RESTRICT / NO ACTION / 未指定：默认拒绝删除（ER_ROW_IS_REFERENCED）
                    if (opts.skipRestrict) continue;
                    throw createError('ER_ROW_IS_REFERENCED');
                }
            }
        }
    }

    /**
     * P1-3：父表主键被更新时，传播到引用它的子表。
     * CASCADE → 同步新值；SET NULL → 置空；RESTRICT → 拒绝更新。
     */
    _propagatePKUpdate(oldVal, newVal) {
        for (const [, table] of Object.entries(this._db._tables)) {
            if (table._name === this._name) continue;
            for (const fk of table._foreignKeys) {
                const refTable = table._resolveTable(fk.table);
                if (!refTable || refTable._name !== this._name) continue;
                const refs = table._applyFilterOptimized(table._getVisibleRows(), { [fk.field]: oldVal });
                if (refs.length === 0) continue;
                const action = (fk.onUpdate || 'restrict').toLowerCase();
                if (action === 'cascade') {
                    // 父行此时还没写入新值，跳过子表 FK 复查
                    table.update({ [fk.field]: oldVal }, { [fk.field]: newVal }, { skipForeignKeys: true });
                } else if (action === 'set null') {
                    table.update({ [fk.field]: oldVal }, { [fk.field]: null }, { skipForeignKeys: true });
                } else {
                    throw createError('ER_ROW_IS_REFERENCED');
                }
            }
        }
    }

    _validateDataTypes(data, partial = false) {
        const result = { ...data };
        for (const [field, type] of Object.entries(this._dateFields)) {
            if (partial && data[field] === undefined) continue;
            if (data[field] !== undefined && data[field] !== null) {
                result[field] = validateDateType(data[field], type, field);
            }
        }
        for (const [field, def] of Object.entries(this._schema)) {
            if (field === '_softDelete') continue;
            if (partial && data[field] === undefined) continue;
            const v = data[field];
            if (v === undefined || v === null) continue;
            const t = String(def.type || '').toLowerCase();
            if (t === 'integer' || t === 'int' || t === 'bigint') {
                if (typeof v === 'boolean') throw integerError(t, v);
                if (typeof v === 'bigint') {
                    // 显式 BigInt：>2^53 也能精确保存（Issue #38）。
                    result[field] = normalizeInteger(v, t);
                } else if (typeof v === 'number') {
                    if (!Number.isInteger(v)) throw integerError(t, v);
                    // 超过 2^53-1 的 number 在调用方就已经丢失精度，不能再假装
                    // 存进去了：明确报错，要求传 BigInt 或十进制字符串。
                    if (!Number.isSafeInteger(v)) throw integerError(t, v);
                    result[field] = v;
                } else if (typeof v === 'string' && DECIMAL_INT_RE.test(v.trim())) {
                    result[field] = normalizeInteger(v.trim(), t);
                } else {
                    throw integerError(t, v);
                }
            } else if (t === 'float' || t === 'double' || t === 'number' || t === 'real') {
                if (typeof v === 'boolean') throw createError('ER_TRUNCATED_WRONG_VALUE', t, v);
                if (typeof v === 'number') result[field] = v;
                else if (typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v))) result[field] = Number(v);
                else throw createError('ER_TRUNCATED_WRONG_VALUE', t, v);
            } else if (t === 'boolean' || t === 'bool') {
                if (typeof v === 'boolean') result[field] = v;
                else if (v === 0 || v === 1) result[field] = !!v;
                else if (typeof v === 'string' && ['true', 'false', '1', '0'].includes(v.toLowerCase())) {
                    result[field] = v.toLowerCase() === 'true' || v === '1';
                } else {
                    throw createError('ER_TRUNCATED_WRONG_VALUE', t, v);
                }
            } else if (t === 'string' || t === 'text' || t === 'varchar' || t === 'char') {
                if (typeof v === 'string') result[field] = v;
                else if (typeof v === 'number' || typeof v === 'boolean' || v instanceof Date) result[field] = String(v);
                else if (Buffer.isBuffer(v)) result[field] = v.toString('utf8');
                else throw createError('ER_TRUNCATED_WRONG_VALUE', t, v);
            } else if ((t === 'object' || t === 'array' || t === 'json') && (def.jsonType || t === 'json')) {
                // JSON / JSONB 列：字符串形式必须是合法 JSON（{bad json 这类会被 JSON.parse 拒绝）
                if (typeof v === 'string') {
                    try { JSON.parse(v); } catch (e) { throw createError('ER_TRUNCATED_WRONG_VALUE', t, v); }
                }
            }
        }
        return result;
    }

    // ============================================================
    // 内部: 辅助
    // ============================================================

    _applyDefaults(data) {
        const result = { ...data };
        for (const [field, defaultValue] of Object.entries(this._defaults)) {
            if (result[field] === undefined) {
                result[field] = resolveDefaultValue(defaultValue, field);
            }
        }
        return result;
    }

    _applyComputed(data) {
        for (const [field, fn] of Object.entries(this._computedFields)) {
            data[field] = fn(data);
        }
        return data;
    }

    _getVisibleRows() {
        if (this._softDelete) return this._rows.filter(r => !r._deleted);
        return this._rows;
    }

    _addToIndexes(rowIndex, data) {
        if (this._pkIndex && this._primaryKey) {
            const pkVal = data[this._primaryKey];
            if (pkVal !== undefined && pkVal !== null) this._pkIndex.set(pkVal, rowIndex);
        }
        for (const field of Object.keys(this._indexes)) {
            const value = data[field];
            if (value !== undefined) {
                if (!this._indexes[field].has(value)) {
                    this._indexes[field].set(value, []);
                }
                this._indexes[field].get(value).push(rowIndex);
            }
        }
        for (const [field, tree] of Object.entries(this._btrees)) {
            const value = data[field];
            if (value !== undefined && value !== null) {
                tree.insert(value, rowIndex);
            }
        }
    }

    _removeFromIndexes(rowIndex, data) {
        if (this._pkIndex && this._primaryKey) {
            this._pkIndex.delete(data[this._primaryKey]);
        }
        for (const field of Object.keys(this._indexes)) {
            const value = data[field];
            if (value !== undefined && this._indexes[field].has(value)) {
                const positions = this._indexes[field].get(value).filter(p => p !== rowIndex);
                if (positions.length === 0) {
                    this._indexes[field].delete(value);
                } else {
                    this._indexes[field].set(value, positions);
                }
            }
        }
        for (const [field, tree] of Object.entries(this._btrees)) {
            const value = data[field];
            if (value !== undefined && value !== null) {
                tree.remove(value, rowIndex);
            }
        }
    }

    _rebuildPKIndex() {
        if (!this._pkIndex || !this._primaryKey) return;
        this._pkIndex.clear();
        for (let i = 0; i < this._rows.length; i++) {
            const pkVal = this._rows[i][this._primaryKey];
            if (pkVal !== undefined && pkVal !== null) this._pkIndex.set(pkVal, i);
        }
    }

    _adjustBTreeAfterRemove(removedIndex) {
        this._rebuildPKIndex();
        for (const field of Object.keys(this._btrees)) {
            this._rebuildBTree(field);
        }
    }

    _loadRows(rows) {
        this._rows = rows;
        if (this._autoIncrementField) {
            for (const row of rows) {
                const val = row[this._autoIncrementField];
                if (typeof val === 'number' && val > this._autoIncrement) {
                    this._autoIncrement = val;
                }
            }
        }
        this._rebuildPKIndex();
        this._rebuildAllBTrees();
        for (const field of Object.keys(this._indexes)) {
            this.createIndex(field);
        }
    }

    toJSON() {
        return this._rows;
    }
}

module.exports = Table;