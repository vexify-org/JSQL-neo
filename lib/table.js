// © Vexify 2026 All Rights Reserved.
/**
 * JSQL Table — 表操作引擎
 * 支持 DEFAULT、CHECK、外键、UPSERT、TRUNCATE、ALTER TABLE、计算字段、JSON 路径、软删除
 */

const Query = require('./query');

class Table {
    constructor(name, schema, db) {
        this._name = name;
        this._schema = schema;
        this._db = db;
        this._rows = [];
        this._indexes = {};
        this._autoIncrement = 0;
        this._dirty = false;
        this._hooks = {
            beforeInsert: [], afterInsert: [],
            beforeUpdate: [], afterUpdate: [],
            beforeRemove: [], afterRemove: []
        };
        this._softDelete = false;        // 是否启用软删除
        this._computedFields = {};       // 计算字段

        // 解析列定义
        this._primaryKey = null;
        this._autoIncrementField = null;
        this._foreignKeys = [];
        this._checkConstraints = [];
        this._defaults = {};

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
                    onDelete: def.foreignKey.onDelete || 'restrict'
                });
            }
            if (def.computed) {
                this._computedFields[field] = def.computed;
            }
        }

        if (schema._softDelete) {
            this._softDelete = true;
        }
    }

    // ============================================================
    // 插入
    // ============================================================

    insert(data) {
        for (const hook of this._hooks.beforeInsert) {
            data = hook({ ...data }) || data;
        }

        // 填充默认值
        data = this._applyDefaults(data);

        // 计算字段
        data = this._applyComputed(data);

        // 校验必填
        for (const [field, def] of Object.entries(this._schema)) {
            if (field === '_softDelete') continue;
            if (def.required && (data[field] === undefined || data[field] === null)) {
                throw new Error(`Field '${field}' is required in table '${this._name}'`);
            }
        }

        // CHECK 约束
        for (const { field, fn } of this._checkConstraints) {
            if (data[field] !== undefined && !fn(data[field], data)) {
                throw new Error(`CHECK constraint failed on '${this._name}.${field}'`);
            }
        }

        // 唯一约束
        for (const [field, def] of Object.entries(this._schema)) {
            if (def.unique && data[field] !== undefined) {
                for (const row of this._rows) {
                    if (row[field] === data[field]) {
                        throw new Error(`Duplicate value for unique field '${field}': ${data[field]}`);
                    }
                }
            }
        }

        // 自增
        if (this._autoIncrementField && data[this._autoIncrementField] === undefined) {
            this._autoIncrement++;
            data[this._autoIncrementField] = this._autoIncrement;
        } else if (this._autoIncrementField && data[this._autoIncrementField] > this._autoIncrement) {
            this._autoIncrement = data[this._autoIncrementField];
        }

        const rowIndex = this._rows.length;
        this._rows.push({ ...data });
        this._updateIndexes(rowIndex, data);
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

    /**
     * UPSERT — 有则更新，无则插入
     * 按主键或唯一字段判断
     */
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
    // 查询
    // ============================================================

    find(query = {}) {
        let rows = this._getVisibleRows();
        if (Object.keys(query).length > 0) {
            rows = this._applyFilter(rows, query);
        }
        return rows.map(r => ({ ...r }));
    }

    findOne(query = {}) {
        const rows = this.find(query);
        return rows.length > 0 ? rows[0] : null;
    }

    findById(id) {
        if (!this._primaryKey) throw new Error(`Table '${this._name}' has no primary key`);
        return this.findOne({ [this._primaryKey]: id });
    }

    findAll() {
        return this._getVisibleRows().map(r => ({ ...r }));
    }

    count(query = {}) {
        if (Object.keys(query).length === 0) return this._getVisibleRows().length;
        return this._applyFilter(this._getVisibleRows(), query).length;
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

        const matched = this._applyFilter(this._getVisibleRows(), query);
        let count = 0;

        for (const row of matched) {
            const index = this._rows.indexOf(row);
            if (index === -1) continue;

            const oldData = { ...this._rows[index] };

            // 唯一约束
            for (const [field, def] of Object.entries(this._schema)) {
                if (def.unique && updates[field] !== undefined) {
                    for (let i = 0; i < this._rows.length; i++) {
                        if (i !== index && this._rows[i][field] === updates[field]) {
                            throw new Error(`Duplicate value for unique field '${field}': ${updates[field]}`);
                        }
                    }
                }
            }

            // CHECK 约束
            const merged = { ...this._rows[index], ...updates };
            for (const { field, fn } of this._checkConstraints) {
                if (merged[field] !== undefined && !fn(merged[field], merged)) {
                    throw new Error(`CHECK constraint failed on '${this._name}.${field}'`);
                }
            }

            Object.assign(this._rows[index], updates);
            this._removeFromIndexes(index, oldData);
            this._updateIndexes(index, this._rows[index]);
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
        if (!this._primaryKey) throw new Error(`Table '${this._name}' has no primary key`);
        return this.update({ [this._primaryKey]: id }, updates);
    }

    // ============================================================
    // 删除
    // ============================================================

    remove(query = {}) {
        for (const hook of this._hooks.beforeRemove) {
            if (hook(query) === false) return 0;
        }

        if (Object.keys(query).length === 0) {
            return this._truncate();
        }

        const toRemove = this._applyFilter(this._getVisibleRows(), query);
        let count = 0;

        for (const row of toRemove) {
            const index = this._rows.indexOf(row);
            if (index === -1) continue;

            // 外键级联删除
            for (const fk of this._foreignKeys) {
                if (fk.onDelete === 'cascade') {
                    const refTable = this._db._tables[fk.table];
                    if (refTable) {
                        refTable.remove({ [fk.field]: row[this._primaryKey] });
                    }
                }
            }

            if (this._softDelete) {
                this._rows[index]._deleted = true;
                this._rows[index]._deletedAt = Date.now();
            } else {
                this._removeFromIndexes(index, row);
                this._rows.splice(index, 1);
                this._adjustIndexesAfterRemove(index);
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
        if (!this._primaryKey) throw new Error(`Table '${this._name}' has no primary key`);
        return this.remove({ [this._primaryKey]: id });
    }

    /**
     * 软删除 — 标记为已删除，可恢复
     */
    removeSoft(query = {}) {
        this._softDelete = true;
        const result = this.remove(query);
        return result;
    }

    /**
     * 恢复软删除的行
     */
    restore(query = {}) {
        if (!this._softDelete) throw new Error('Soft delete is not enabled');
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

    /**
     * 清空表（保留结构）
     */
    truncate() {
        return this._truncate();
    }

    _truncate() {
        const count = this._rows.length;
        this._rows = [];
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
        if (this._schema[field]) throw new Error(`Column '${field}' already exists`);
        this._schema[field] = definition;
        if (definition.default !== undefined) {
            this._defaults[field] = definition.default;
            // 填充现有行的默认值
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
                onDelete: definition.foreignKey.onDelete || 'restrict'
            });
        }
        if (definition.computed) this._computedFields[field] = definition.computed;
        this._dirty = true;
        this._db._markDirty();
        return this;
    }

    dropColumn(field) {
        if (!this._schema[field]) throw new Error(`Column '${field}' does not exist`);
        delete this._schema[field];
        delete this._defaults[field];
        this._checkConstraints = this._checkConstraints.filter(c => c.field !== field);
        this._foreignKeys = this._foreignKeys.filter(fk => fk.field !== field);
        delete this._computedFields[field];
        // 移除所有行中的该字段
        for (const row of this._rows) {
            delete row[field];
        }
        this._dirty = true;
        this._db._markDirty();
        return this;
    }

    renameColumn(oldName, newName) {
        if (!this._schema[oldName]) throw new Error(`Column '${oldName}' does not exist`);
        if (this._schema[newName]) throw new Error(`Column '${newName}' already exists`);
        this._schema[newName] = this._schema[oldName];
        delete this._schema[oldName];
        if (this._defaults[oldName] !== undefined) {
            this._defaults[newName] = this._defaults[oldName];
            delete this._defaults[oldName];
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
        if (!this._schema[field]) throw new Error(`Column '${field}' does not exist`);
        this._schema[field] = { ...this._schema[field], ...definition };
        if (definition.default !== undefined) this._defaults[field] = definition.default;
        this._checkConstraints = this._checkConstraints.filter(c => c.field !== field);
        if (definition.check) this._checkConstraints.push({ field, fn: definition.check });
        this._dirty = true;
        this._db._markDirty();
        return this;
    }

    /**
     * 获取表结构
     */
    describe() {
        return {
            name: this._name,
            columns: { ...this._schema },
            primaryKey: this._primaryKey,
            rowCount: this._getVisibleRows().length,
            indexCount: Object.keys(this._indexes).length,
            softDelete: this._softDelete,
            foreignKeys: this._foreignKeys.map(fk => ({ field: fk.field, table: fk.table }))
        };
    }

    // ============================================================
    // SELECT INTO
    // ============================================================

    /**
     * 从查询结果创建新表
     */
    selectInto(newTableName, newSchema, query = {}) {
        const rows = this._applyFilter(this._getVisibleRows(), query);
        this._db.createTable(newTableName, newSchema);
        const newTable = this._db._tables[newTableName];
        for (const row of rows) {
            newTable.insert(row);
        }
        return newTable;
    }

    // ============================================================
    // 全文搜索评分
    // ============================================================

    /**
     * 全文搜索并返回带相关性评分的排序结果
     * @param {string} field - 搜索字段
     * @param {string|string[]} terms - 搜索词
     * @returns {Array} 按 _score 降序排列的结果
     */
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
                    score += 10;  // 基础命中
                    if (idx === 0) score += 5;  // 开头匹配加分
                    if (value === t) score += 20;  // 完全匹配加更多
                    score += (value.length - idx) / value.length * 5;  // 靠前加权
                }
            }
            if (score > 0) {
                scored.push({ ...row, _score: score });
            }
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
    // 内部: 过滤器
    // ============================================================

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
            // 顶层 $or / $and / $not
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

            // JSON 路径: 'profile.city' 或 'data.profile.city'
            const value = this._resolvePath(row, field);

            if (condition !== null && typeof condition === 'object' && !Array.isArray(condition) && !(condition instanceof RegExp)) {
                // 检查是否是操作符
                const keys = Object.keys(condition);
                const isOperator = keys.every(k => k.startsWith('$'));
                if (isOperator && keys.length > 0) {
                    for (const [op, target] of Object.entries(condition)) {
                        if (!this._matchOperator(value, op, target)) {
                            return false;
                        }
                    }
                } else {
                    // 普通对象：递归匹配子文档
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
                const likeRegex = target.replace(/%/g, '.*').replace(/_/g, '.');
                return new RegExp('^' + likeRegex + '$', 'i').test(value);
            case '$regex':
                return new RegExp(target).test(String(value));
            case '$exists':
                return target ? value !== undefined : value === undefined;
            case '$between':
                return Array.isArray(target) && target.length === 2
                    && value >= target[0] && value <= target[1];
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
                    typeof el === 'object' ? this._matchRow(el, target) : el === target
                );
            case '$isNull':
                return target ? value === null || value === undefined : value !== null && value !== undefined;
            case '$startsWith':
                return typeof value === 'string' && value.startsWith(target);
            case '$endsWith':
                return typeof value === 'string' && value.endsWith(target);
            case '$search':
                // 全文搜索（简单实现）
                if (typeof value !== 'string') return false;
                const terms = Array.isArray(target) ? target : [target];
                return terms.every(t => value.toLowerCase().includes(t.toLowerCase()));
            case '$textSearch':
                // 高级全文搜索，带相关性评分（返回 true 即可，评分在 _textScore 中）
                if (typeof value !== 'string') return false;
                const searchTerms = Array.isArray(target) ? target : target.split(/\s+/);
                const lower = value.toLowerCase();
                return searchTerms.some(t => lower.includes(t.toLowerCase()));
            case '$inSub':
                // 子查询：$inSub: { table: otherTable, field: 'col', query: {} }
                if (!target || !target.table) return false;
                const subRows = target.table._applyFilter(target.table._rows, target.query || {});
                return subRows.some(r => r[target.field] === value);
            case '$notInSub':
                if (!target || !target.table) return false;
                const subRows2 = target.table._applyFilter(target.table._rows, target.query || {});
                return !subRows2.some(r => r[target.field] === value);
            case '$expr':
                // 表达式：$expr: (value, row) => boolean
                if (typeof target === 'function') return target(value);
                return false;
            default:
                return false;
        }
    }

    /**
     * 解析 JSON 路径，如 'profile.city' -> row.profile.city
     */
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
    // 内部: 辅助
    // ============================================================

    _applyDefaults(data) {
        const result = { ...data };
        for (const [field, defaultValue] of Object.entries(this._defaults)) {
            if (result[field] === undefined) {
                result[field] = typeof defaultValue === 'function' ? defaultValue() : defaultValue;
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
        if (this._softDelete) {
            return this._rows.filter(r => !r._deleted);
        }
        return this._rows;
    }

    _updateIndexes(rowIndex, data) {
        for (const field of Object.keys(this._indexes)) {
            const value = data[field];
            if (value !== undefined) {
                if (!this._indexes[field].has(value)) {
                    this._indexes[field].set(value, []);
                }
                this._indexes[field].get(value).push(rowIndex);
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
    }

    _adjustIndexesAfterRemove(removedIndex) {
        for (const idxName of Object.keys(this._indexes)) {
            const idx = this._indexes[idxName];
            for (const [key, positions] of idx) {
                const newPositions = positions
                    .filter(p => p !== removedIndex)
                    .map(p => p > removedIndex ? p - 1 : p);
                if (newPositions.length === 0) {
                    idx.delete(key);
                } else {
                    idx.set(key, newPositions);
                }
            }
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
        for (const field of Object.keys(this._indexes)) {
            this.createIndex(field);
        }
    }

    toJSON() {
        return this._rows;
    }
}

module.exports = Table;