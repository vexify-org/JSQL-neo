// © Vexify 2026 All Rights Reserved.
/**
 * JSQL Query — 链式查询构建器
 * 支持 JOIN、DISTINCT、HAVING、UNION、窗口函数、缓存、CASE WHEN、toSQL
 */

class Query {
    constructor(table, conditions = {}) {
        this._table = table;
        this._conditions = conditions;
        this._orderBy = [];
        this._limitCount = null;
        this._offsetCount = 0;
        this._selectFields = null;
        this._groupBy = null;
        this._having = null;
        this._distinct = false;
        this._distinctField = null;
        this._joins = [];
        this._union = null;
        this._explain = false;
        this._window = null;
        this._cache = null;        // { ttl, result, timestamp }
        this._caseExpr = null;     // [{ when, then }, ...] + else
    }

    // ============================================================
    // 条件
    // ============================================================

    where(conditions) {
        Object.assign(this._conditions, conditions);
        return this;
    }

    // ============================================================
    // 排序
    // ============================================================

    orderBy(field, dir = 'asc') {
        this._orderBy.push({ field, dir: dir.toLowerCase() });
        return this;
    }

    orderByDesc(field) {
        return this.orderBy(field, 'desc');
    }

    // ============================================================
    // 分页
    // ============================================================

    limit(n) {
        this._limitCount = n;
        return this;
    }

    offset(n) {
        this._offsetCount = n;
        return this;
    }

    paginate(page = 1, perPage = 20) {
        this._limitCount = perPage;
        this._offsetCount = (page - 1) * perPage;
        const total = this._countRaw();
        const rows = this.get();
        return { rows, total, page, perPage, totalPages: Math.ceil(total / perPage) };
    }

    // ============================================================
    // 字段选择
    // ============================================================

    select(fields) {
        this._selectFields = Array.isArray(fields) ? fields : [fields];
        return this;
    }

    distinct(field) {
        this._distinct = true;
        this._distinctField = field;
        return this;
    }

    // ============================================================
    // CASE WHEN
    // ============================================================

    /**
     * CASE WHEN 表达式
     * @example
     * db.users.where({}).case([
     *   { when: { age: { $lt: 18 } }, then: 'minor' },
     *   { when: { age: { $lt: 60 } }, then: 'adult' }
     * ], 'senior').as('ageGroup').get()
     */
    case(whenClauses, elseExpr) {
        this._caseExpr = { clauses: whenClauses, else: elseExpr };
        return this;
    }

    /**
     * 给 CASE WHEN 结果命名
     */
    as(fieldName) {
        this._caseAs = fieldName;
        return this;
    }

    // ============================================================
    // 分组 & 聚合后过滤
    // ============================================================

    groupBy(field) {
        this._groupBy = field;
        return this;
    }

    having(conditions) {
        this._having = conditions;
        return this;
    }

    // ============================================================
    // 窗口函数
    // ============================================================

    /**
     * 窗口函数
     * @param {string} fn - 'rowNumber' | 'rank' | 'denseRank'
     * @param {string} field - 排序字段
     * @param {string} partitionBy - 分区字段
     * @param {string} dir - 'asc' | 'desc'
     */
    window(fn, field, partitionBy, dir = 'asc') {
        this._window = { fn, field, partitionBy, dir };
        return this;
    }

    // ============================================================
    // JOIN
    // ============================================================

    join(otherTable, localField, foreignField, as) {
        const table = typeof otherTable === 'string' ? this._table._db._tables[otherTable] : otherTable;
        if (!table) throw new Error(`Table '${otherTable}' does not exist`);
        this._joins.push({ type: 'inner', table, localField, foreignField, as });
        return this;
    }

    leftJoin(otherTable, localField, foreignField, as) {
        const table = typeof otherTable === 'string' ? this._table._db._tables[otherTable] : otherTable;
        if (!table) throw new Error(`Table '${otherTable}' does not exist`);
        this._joins.push({ type: 'left', table, localField, foreignField, as });
        return this;
    }

    rightJoin(otherTable, localField, foreignField, as) {
        const table = typeof otherTable === 'string' ? this._table._db._tables[otherTable] : otherTable;
        if (!table) throw new Error(`Table '${otherTable}' does not exist`);
        this._joins.push({ type: 'right', table, localField, foreignField, as });
        return this;
    }

    // ============================================================
    // UNION
    // ============================================================

    union(query) {
        this._union = query;
        return this;
    }

    // ============================================================
    // EXPLAIN
    // ============================================================

    explain() {
        this._explain = true;
        return this;
    }

    // ============================================================
    // 缓存
    // ============================================================

    /**
     * 缓存查询结果
     * @param {number} ttlMs - 缓存有效期（毫秒），默认 60000
     */
    cache(ttlMs = 60000) {
        this._cache = { ttl: ttlMs, result: null, timestamp: 0 };
        return this;
    }

    // ============================================================
    // 执行
    // ============================================================

    get() {
        if (this._explain) return this._getExplain();

        // 缓存命中
        if (this._cache && this._cache.result && (Date.now() - this._cache.timestamp < this._cache.ttl)) {
            return this._cache.result;
        }

        let rows = this._table._applyFilter(this._table._rows, this._conditions);

        // JOIN
        for (const join of this._joins) {
            rows = this._applyJoin(rows, join);
        }

        // UNION
        if (this._union) {
            const unionRows = this._union.get();
            rows = [...rows, ...unionRows];
        }

        // GROUP BY
        if (this._groupBy) {
            rows = this._applyGroupBy(rows);
        }

        // HAVING
        if (this._having) {
            rows = this._table._applyFilter(rows, this._having);
        }

        // 窗口函数
        if (this._window) {
            rows = this._applyWindow(rows);
        }

        // DISTINCT
        if (this._distinct) {
            const seen = new Set();
            rows = rows.filter(r => {
                let key;
                if (this._distinctField) {
                    const val = r[this._distinctField];
                    if (val === undefined) return false;
                    key = String(val);
                } else if (this._selectFields) {
                    const obj = {};
                    for (const f of this._selectFields) {
                        obj[f] = r[f];
                    }
                    key = JSON.stringify(obj);
                } else {
                    key = JSON.stringify(r);
                }
                if (seen.has(key)) return false;
                seen.add(key);
                return true;
            });
        }

        // 排序
        if (this._orderBy.length > 0) {
            rows = this._applyOrderBy(rows);
        }

        // 分页
        if (this._offsetCount > 0) {
            rows = rows.slice(this._offsetCount);
        }
        if (this._limitCount !== null) {
            rows = rows.slice(0, this._limitCount);
        }

        // CASE WHEN
        if (this._caseExpr) {
            rows = rows.map(r => {
                const row = { ...r };
                let val = this._caseExpr.else;
                for (const clause of this._caseExpr.clauses) {
                    if (this._table._matchRow(row, clause.when)) {
                        val = clause.then;
                        break;
                    }
                }
                const asField = this._caseAs || '_case';
                row[asField] = val;
                return row;
            });
        }

        // 字段选择
        rows = rows.map(r => ({ ...r }));
        if (this._selectFields) {
            rows = rows.map(r => {
                const obj = {};
                for (const f of this._selectFields) {
                    obj[f] = r[f];
                }
                return obj;
            });
        }

        // 缓存存储
        if (this._cache) {
            this._cache.result = rows;
            this._cache.timestamp = Date.now();
        }

        return rows;
    }

    first() {
        const rows = this.limit(1).get();
        return rows.length > 0 ? rows[0] : null;
    }

    count() {
        return this._countRaw();
    }

    sum(field) {
        const rows = this._getFilteredRows();
        return rows.reduce((acc, r) => acc + (Number(r[field]) || 0), 0);
    }

    avg(field) {
        const rows = this._getFilteredRows();
        if (rows.length === 0) return 0;
        return this.sum(field) / rows.length;
    }

    min(field) {
        const rows = this._getFilteredRows();
        if (rows.length === 0) return null;
        return rows.reduce((min, r) => {
            const v = Number(r[field]);
            return (min === null || v < min) ? v : min;
        }, null);
    }

    max(field) {
        const rows = this._getFilteredRows();
        if (rows.length === 0) return null;
        return rows.reduce((max, r) => {
            const v = Number(r[field]);
            return (max === null || v > max) ? v : max;
        }, null);
    }

    groupStats(field) {
        if (!this._groupBy) throw new Error('groupStats() requires groupBy()');
        const rows = this._table._applyFilter(this._table._rows, this._conditions);
        const groups = {};

        for (const row of rows) {
            const key = String(row[this._groupBy] ?? '__null__');
            if (!groups[key]) {
                groups[key] = { _group: row[this._groupBy], _count: 0, _sum: 0, _min: null, _max: null, _rows: [] };
            }
            const g = groups[key];
            g._count++;
            const v = Number(row[field]) || 0;
            g._sum += v;
            g._min = g._min === null ? v : Math.min(g._min, v);
            g._max = g._max === null ? v : Math.max(g._max, v);
            g._rows.push(row);
        }

        const result = Object.values(groups);
        result.forEach(g => {
            g._avg = g._count > 0 ? g._sum / g._count : 0;
            delete g._rows;
        });
        return result;
    }

    update(updates) {
        return this._table.update(this._conditions, updates);
    }

    remove() {
        return this._table.remove(this._conditions);
    }

    /**
     * 无效缓存
     */
    invalidateCache() {
        if (this._cache) {
            this._cache.result = null;
            this._cache.timestamp = 0;
        }
        return this;
    }

    // ============================================================
    // toSQL
    // ============================================================

    /**
     * 导出为类 SQL 字符串（调试用）
     */
    toSQL() {
        const parts = ['SELECT'];
        if (this._selectFields) {
            parts.push(this._selectFields.join(', '));
        } else {
            parts.push('*');
        }
        parts.push('FROM', this._table._name);

        if (Object.keys(this._conditions).length > 0) {
            parts.push('WHERE', JSON.stringify(this._conditions));
        }

        if (this._groupBy) {
            parts.push('GROUP BY', this._groupBy);
            if (this._having) parts.push('HAVING', JSON.stringify(this._having));
        }

        if (this._orderBy.length > 0) {
            parts.push('ORDER BY', this._orderBy.map(o => `${o.field} ${o.dir}`).join(', '));
        }

        if (this._limitCount !== null) {
            parts.push('LIMIT', String(this._limitCount));
        }

        if (this._offsetCount > 0) {
            parts.push('OFFSET', String(this._offsetCount));
        }

        return parts.join(' ');
    }

    // ============================================================
    // 内部
    // ============================================================

    _getFilteredRows() {
        return this._table._applyFilter(this._table._rows, this._conditions);
    }

    _countRaw() {
        return this._table._applyFilter(this._table._rows, this._conditions).length;
    }

    _applyOrderBy(rows) {
        return [...rows].sort((a, b) => {
            for (const { field, dir } of this._orderBy) {
                const va = a[field];
                const vb = b[field];
                if (va < vb) return dir === 'asc' ? -1 : 1;
                if (va > vb) return dir === 'asc' ? 1 : -1;
            }
            return 0;
        });
    }

    _applyWindow(rows) {
        const { fn, field, partitionBy, dir } = this._window;

        if (partitionBy) {
            // 分组
            const groups = {};
            for (const row of rows) {
                const key = String(row[partitionBy] ?? '__null__');
                if (!groups[key]) groups[key] = [];
                groups[key].push(row);
            }

            const result = [];
            for (const group of Object.values(groups)) {
                this._applyWindowToGroup(group, fn, field, dir);
                result.push(...group);
            }
            return result;
        }

        this._applyWindowToGroup(rows, fn, field, dir);
        return rows;
    }

    _applyWindowToGroup(rows, fn, field, dir) {
        // 按字段排序
        if (field) {
            rows.sort((a, b) => {
                const va = a[field];
                const vb = b[field];
                if (va < vb) return dir === 'asc' ? -1 : 1;
                if (va > vb) return dir === 'asc' ? 1 : -1;
                return 0;
            });
        }

        const colName = fn === 'rowNumber' ? '_row_number' : fn === 'rank' ? '_rank' : '_dense_rank';
        let rank = 1;
        let denseRank = 1;
        let prevVal = null;

        for (let i = 0; i < rows.length; i++) {
            const curVal = field ? rows[i][field] : null;

            if (fn === 'rowNumber') {
                rows[i][colName] = i + 1;
            } else if (fn === 'rank') {
                if (i > 0 && curVal !== prevVal) {
                    rank = i + 1;
                }
                rows[i][colName] = rank;
            } else if (fn === 'denseRank') {
                if (i > 0 && curVal !== prevVal) {
                    denseRank++;
                }
                rows[i][colName] = denseRank;
            }

            prevVal = curVal;
        }
    }

    _applyJoin(localRows, join) {
        const result = [];
        const foreignRows = join.table._rows;

        if (join.type === 'left') {
            for (const lr of localRows) {
                const matches = foreignRows.filter(fr => fr[join.foreignField] === lr[join.localField]);
                if (matches.length === 0) {
                    result.push({ ...lr, ...this._nullRow(join.table, join.as) });
                } else {
                    for (const fr of matches) {
                        result.push(this._mergeJoinRow(lr, fr, join));
                    }
                }
            }
        } else if (join.type === 'right') {
            for (const fr of foreignRows) {
                const matches = localRows.filter(lr => lr[join.localField] === fr[join.foreignField]);
                if (matches.length === 0) {
                    result.push({ ...fr, ...this._nullRow(join.table, join.as) });
                } else {
                    for (const lr of matches) {
                        result.push(this._mergeJoinRow(lr, fr, join));
                    }
                }
            }
        } else {
            for (const lr of localRows) {
                for (const fr of foreignRows) {
                    if (fr[join.foreignField] === lr[join.localField]) {
                        result.push(this._mergeJoinRow(lr, fr, join));
                    }
                }
            }
        }
        return result;
    }

    _mergeJoinRow(lr, fr, join) {
        const merged = { ...lr };
        const prefix = join.as ? join.as + '_' : '';
        for (const [key, value] of Object.entries(fr)) {
            merged[prefix + key] = value;
        }
        return merged;
    }

    _nullRow(table, as) {
        const nulls = {};
        const prefix = as ? as + '_' : '';
        for (const field of Object.keys(table._schema)) {
            nulls[prefix + field] = null;
        }
        return nulls;
    }

    _applyGroupBy(rows) {
        const groups = {};
        for (const row of rows) {
            const key = String(row[this._groupBy] ?? '__null__');
            if (!groups[key]) {
                groups[key] = { _group: row[this._groupBy], _rows: [], _count: 0 };
            }
            groups[key]._rows.push(row);
            groups[key]._count++;
        }

        const result = [];
        for (const g of Object.values(groups)) {
            const base = { ...g._rows[0] };
            base._group = g._group;
            base._count = g._count;
            result.push(base);
        }
        return result;
    }

    _getExplain() {
        const totalRows = this._table._rows.length;
        const filtered = this._table._applyFilter(this._table._rows, this._conditions);
        const plan = {
            table: this._table._name,
            totalRows,
            conditions: this._conditions,
            filteredRows: filtered.length,
            selectivity: totalRows > 0 ? (filtered.length / totalRows * 100).toFixed(1) + '%' : '0%',
            hasIndex: false,
            indexUsed: null,
            joins: this._joins.length,
            groupBy: this._groupBy,
            having: this._having,
            window: this._window ? this._window.fn : null,
            orderBy: this._orderBy.map(o => `${o.field} ${o.dir}`),
            limit: this._limitCount,
            offset: this._offsetCount,
            estimatedCost: filtered.length * (1 + this._joins.length)
        };

        for (const [field] of Object.entries(this._conditions)) {
            if (this._table._indexes[field]) {
                plan.hasIndex = true;
                plan.indexUsed = field;
                plan.estimatedCost = Math.floor(plan.estimatedCost * 0.1);
                break;
            }
        }

        return plan;
    }
}

module.exports = Query;