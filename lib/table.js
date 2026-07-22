// © Vexify 2026 All Rights Reserved.
/**
 * JSQL Table — 表操作引擎 v2.0
 * B-Tree 自动索引、日期类型、错误码、外键 CASCADE、长度/精度校验
 */

const Query = require('./query');
const BTree = require('./btree');
const { validateDateType, now } = require('./date-types');
const { createError } = require('./errors');

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
        this._autoIncrementField = null;
        this._foreignKeys = [];
        this._checkConstraints = [];
        this._defaults = {};
        this._dateFields = {};       // { fieldName: 'date'|'datetime'|'timestamp' }

        for (const [field, def] of Object.entries(schema)) {
            if (def.primaryKey) this._primaryKey = field;
            if (def.autoIncrement) {
                this._autoIncrementField = field;
                if (def.primaryKey) this._primaryKey = field;
            }
            if (def.default !== undefined) {
                this._defaults[field] = def.default;
            }
            if (def.check) {
                this._checkConstraints.push({ field, fn: def.check });
            }
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

        // 自动为 primaryKey 和 unique 字段建 B-Tree 索引
        this._autoCreateBTrees();
    }

    _autoCreateBTrees() {
        for (const [field, def] of Object.entries(this._schema)) {
            if (field === '_softDelete') continue;
            if (def.primaryKey || def.unique) {
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
        this._db._markDirty();

        for (const hook of this._hooks.afterInsert) {
            hook(data);
        }
        this._db._emitChange('insert', this._name, data);

        return data;
    }

    insertMany(items) {
        return items.map(item => this.insert(item));
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
        const rows = this.find(query);
        return rows.length > 0 ? rows[0] : null;
    }

    findById(id) {
        if (!this._primaryKey) throw createError('ER_PARSE_ERROR', 'Table has no primary key');
        // B-Tree 加速
        if (this._btrees[this._primaryKey]) {
            const indices = this._btrees[this._primaryKey].search(id);
            if (indices.length > 0) {
                const row = this._rows[indices[0]];
                if (row && !row._deleted) return { ...row };
            }
            return null;
        }
        return this.findOne({ [this._primaryKey]: id });
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

    update(query, updates) {
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
            this._validateConstraints(merged, index);

            this._removeFromIndexes(index, oldData);
            Object.assign(this._rows[index], updates);
            this._addToIndexes(index, this._rows[index]);
            count++;
        }

        if (count > 0) {
            this._dirty = true;
            this._db._markDirty();
            for (const hook of this._hooks.afterUpdate) {
                hook(query, updates, count);
            }
            this._db._emitChange('update', this._name, { query, updates, count });
        }
        return count;
    }

    updateById(id, updates) {
        if (!this._primaryKey) throw createError('ER_PARSE_ERROR', 'Table has no primary key');
        return this.update({ [this._primaryKey]: id }, updates);
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

        for (const row of toRemove) {
            const index = this._rows.indexOf(row);
            if (index === -1) continue;

            // 外键 CASCADE / SET NULL：查找所有引用此表的子表
            this._cascadeForeignKeys(row);

            if (this._softDelete) {
                this._rows[index]._deleted = true;
                this._rows[index]._deletedAt = Date.now();
            } else {
                this._removeFromIndexes(index, row);
                this._rows.splice(index, 1);
                this._adjustBTreeAfterRemove(index);
            }
            count++;
        }

        if (count > 0) {
            this._dirty = true;
            this._db._markDirty();
            for (const hook of this._hooks.afterRemove) {
                hook(query, count);
            }
            this._db._emitChange('remove', this._name, { query, count });
        }
        return count;
    }

    removeById(id) {
        if (!this._primaryKey) throw createError('ER_PARSE_ERROR', 'Table has no primary key');
        return this.remove({ [this._primaryKey]: id });
    }

    removeSoft(query = {}) {
        this._softDelete = true;
        return this.remove(query);
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
        for (const key of Object.keys(this._btrees)) {
            this._btrees[key].clear();
        }
        this._indexes = {};
        this._autoIncrement = 0;
        this._dirty = true;
        this._db._markDirty();
        return count;
    }

    // ============================================================
    // ALTER TABLE
    // ============================================================

    addColumn(field, definition) {
        if (this._schema[field]) throw createError('ER_DUP_FIELDNAME', field);
        this._schema[field] = definition;
        if (definition.default !== undefined) {
            this._defaults[field] = definition.default;
            for (const row of this._rows) {
                if (row[field] === undefined) {
                    row[field] = typeof definition.default === 'function' ? definition.default() : definition.default;
                }
            }
        }
        if (definition.check) this._checkConstraints.push({ field, fn: definition.check });
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
        this._dirty = true;
        this._db._markDirty();
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
        if (this._primaryKey === field) this._primaryKey = null;
        if (this._autoIncrementField === field) this._autoIncrementField = null;
        this._dirty = true;
        this._db._markDirty();
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
        }
        for (const row of this._rows) {
            row[newName] = row[oldName];
            delete row[oldName];
        }
        if (this._primaryKey === oldName) this._primaryKey = newName;
        if (this._autoIncrementField === oldName) this._autoIncrementField = newName;
        this._dirty = true;
        this._db._markDirty();
        return this;
    }

    modifyColumn(field, definition) {
        if (!this._schema[field]) throw createError('ER_BAD_FIELD_ERROR', field, this._name);
        this._schema[field] = { ...this._schema[field], ...definition };
        if (definition.default !== undefined) this._defaults[field] = definition.default;
        this._checkConstraints = this._checkConstraints.filter(c => c.field !== field);
        if (definition.check) this._checkConstraints.push({ field, fn: definition.check });
        if (definition.primaryKey || definition.unique) {
            if (!this._btrees[field]) this._btrees[field] = new BTree(64, true);
            this._rebuildBTree(field);
        }
        this._dirty = true;
        this._db._markDirty();
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

    _applyFilterOptimized(rows, query) {
        // 尝试用 B-Tree 加速
        for (const [field, condition] of Object.entries(query)) {
            if (field === '$or' || field === '$and' || field === '$not') continue;
            // 等值查询用 B-Tree
            if (typeof condition !== 'object' || condition === null || Array.isArray(condition) || condition instanceof RegExp) {
                if (this._btrees[field]) {
                    const indices = this._btrees[field].search(condition);
                    if (indices.length > 0) {
                        const subset = indices.map(i => this._rows[i]).filter(r => r);
                        return this._applyFilter(subset, query);
                    }
                    return [];
                }
            }
            // 范围查询用 B-Tree
            if (condition && typeof condition === 'object') {
                if (condition.$gt !== undefined && condition.$lt !== undefined && this._btrees[field]) {
                    const indices = this._btrees[field].range(condition.$gt, condition.$lt);
                    const subset = indices.map(i => this._rows[i]).filter(r => r);
                    return this._applyFilter(subset, query);
                }
                if (condition.$gte !== undefined && condition.$lte !== undefined && this._btrees[field]) {
                    const indices = this._btrees[field].range(condition.$gte, condition.$lte);
                    const subset = indices.map(i => this._rows[i]).filter(r => r);
                    return this._applyFilter(subset, query);
                }
            }
        }
        return this._applyFilter(rows, query);
    }

    _applyFilter(rows, query) {
        const result = [];
        for (let i = 0; i < rows.length; i++) {
            if (this._matchRow(rows[i], query)) {
                result.push(rows[i]);
            }
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
                return new RegExp('^' + target.replace(/%/g, '.*').replace(/_/g, '.') + '$', 'i').test(value);
            case '$regex':
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

    _validateConstraints(data, excludeIndex) {
        for (const [field, def] of Object.entries(this._schema)) {
            if (field === '_softDelete') continue;

            // NOT NULL
            if (def.required && (data[field] === undefined || data[field] === null)) {
                throw createError('ER_BAD_NULL_ERROR', field);
            }

            // UNIQUE
            if (def.unique && data[field] !== undefined) {
                for (let i = 0; i < this._rows.length; i++) {
                    if (i === excludeIndex) continue;
                    if (this._rows[i][field] === data[field]) {
                        throw createError('ER_DUP_ENTRY', String(data[field]), field);
                    }
                }
            }

            // CHECK
            for (const { field: cf, fn } of this._checkConstraints) {
                if (cf === field && data[field] !== undefined && !fn(data[field], data)) {
                    throw createError('ER_CHECK_CONSTRAINT', this._name + '.' + field);
                }
            }

            // 长度限制
            if (def.length && typeof data[field] === 'string' && data[field].length > def.length) {
                throw createError('ER_DATA_TOO_LONG', field);
            }

            // 数值范围
            if (def.type === 'integer' && data[field] !== undefined && data[field] !== null) {
                const v = Number(data[field]);
                if (def.min !== undefined && v < def.min) throw createError('ER_OUT_OF_RANGE', field);
                if (def.max !== undefined && v > def.max) throw createError('ER_OUT_OF_RANGE', field);
            }
        }

        // FOREIGN KEY 校验
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
     * 并执行 CASCADE 或 SET NULL
     */
    _cascadeForeignKeys(row) {
        for (const [, table] of Object.entries(this._db._tables)) {
            if (table._name === this._name) continue;
            for (const fk of table._foreignKeys) {
                const refTable = table._resolveTable(fk.table);
                if (!refTable || refTable._name !== this._name) continue;

                // 检查子表行是否引用当前行
                if (fk.onDelete === 'cascade') {
                    table.remove({ [fk.field]: row[fk.refField] });
                } else if (fk.onDelete === 'set null') {
                    table.update({ [fk.field]: row[fk.refField] }, { [fk.field]: null });
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
        return result;
    }

    // ============================================================
    // 内部: 辅助
    // ============================================================

    _applyDefaults(data) {
        const result = { ...data };
        for (const [field, defaultValue] of Object.entries(this._defaults)) {
            if (result[field] === undefined) {
                result[field] = typeof defaultValue === 'function'
                    ? defaultValue()
                    : (defaultValue === 'CURRENT_TIMESTAMP' ? now() : defaultValue);
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

    _adjustBTreeAfterRemove(removedIndex) {
        // 重建受影响的 B-Tree
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