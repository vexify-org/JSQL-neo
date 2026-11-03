// © Vexify 2026 All Rights Reserved.
/**
 * jsql 1.0.0 兼容层（怀旧 API）
 *
 * 1.0.0 的公开 API 是**全同步**的：
 *
 *   const jsql = require('jsql-neo');
 *   const db = new jsql.Database('mydb.json');
 *   db.createTable('users', {
 *     id:   { type: 'integer', primaryKey: true, autoIncrement: true },
 *     name: { type: 'string', required: true },
 *     age:  { type: 'integer' }
 *   });
 *   db.users.insert({ name: 'Alice', age: 25 });
 *   db.users.where({ age: { $gte: 18 } }).orderBy('age', 'desc').limit(10).get();
 *
 * v6 引擎本身已经把 Table / Query 的全部方法做成同步的，只有
 * `Database.createTable()` / `Database.dropTable()` 变成了 async。
 * 这层只做两件事：
 *
 *   1. 同步版 createTable/dropTable（内部走 _createTableSync/_dropTableSync）；
 *   2. 把 `db.<表名>` 的取值属性镜像到包装对象上，保证老代码直接可用。
 *
 * 除了这两个方法，其余行为完全等同 v6：拿到的 Table 就是 lib/table.js 的
 * Table，查询链就是 lib/query.js 的 Query，不存在第二套实现。
 *
 * 注意：这是兼容层，不是"降级"。它不会关闭 v6 的任何能力，
 * 需要 async API 时通过 `db.raw` 拿到底层 Database 即可。
 */

const Database = require('../database');
const Table = require('../table');

/**
 * 把 1.0.0 的简写 schema（'string' / 'integer' 等）解析成对象。
 * 与 Database#createTable 里的解析逻辑保持一致，避免两处语义漂移。
 */
function parseShorthand(schema) {
    if (typeof schema !== 'string') return schema || {};
    const parsed = {};
    for (const seg of schema.split(',')) {
        const trimmed = seg.trim();
        if (!trimmed) continue;
        const parts = trimmed.split(/\s+/);
        const field = parts.shift();
        parsed[field] = parts.join(' ').toLowerCase().trim() || 'string';
    }
    return parsed;
}

/** 深拷贝（优先 structuredClone，退化到 JSON） */
function deepClone(value) {
    try {
        if (typeof structuredClone === 'function') return structuredClone(value);
    } catch (e) { /* 含函数/类实例时退化 */ }
    return JSON.parse(JSON.stringify(value));
}

/**
 * 从行数据推断 schema（仅用于 import 时表还不存在的场景）。
 * 1.0.0 的 export() 只吐出 rows，不带 schema，所以必须能反推。
 */
function inferSchema(rows) {
    const schema = {};
    if (!Array.isArray(rows) || rows.length === 0) return schema;
    const sample = rows[0];
    for (const [field, value] of Object.entries(sample)) {
        let type = 'string';
        if (typeof value === 'number') type = Number.isInteger(value) ? 'integer' : 'float';
        else if (typeof value === 'boolean') type = 'boolean';
        else if (Array.isArray(value)) type = 'array';
        else if (value !== null && typeof value === 'object') type = 'object';
        schema[field] = { type };
    }
    // 1.0.0 的 export() 不带 schema，自增主键信息会丢。
    // 常见约定：`id` 且整型唯一 —— 还原成 primaryKey + autoIncrement，
    // 否则 import 后继续 insert 会得到 id=undefined（老代码会当场炸）。
    if (schema.id && schema.id.type === 'integer') {
        const ids = rows.map(r => r.id);
        const unique = new Set(ids).size === ids.length && ids.every(v => typeof v === 'number');
        if (unique) {
            schema.id.primaryKey = true;
            schema.id.autoIncrement = true;
        }
    }
    return schema;
}

class V1Database {
    /**
     * @param {string|null} [filePath] 文件路径；null / ':memory:' 为内存模式
     * @param {object} [options] 透传给 v6 Database
     */
    constructor(filePath, options = {}) {
        this._db = new Database(filePath, options);
        // 文件模式导入或目录模式加载时，表已经存在 —— 同样要把
        // db.<表名> 属性镜像到包装对象上，否则老代码 `db.users` 会 undefined。
        for (const name of this._db.getTables()) this._bindTable(name);
    }

    /** 底层 v6 Database（需要 async / 高级能力时用） */
    get raw() {
        return this._db;
    }

    _bindTable(name) {
        if (typeof name !== 'string' || !name) return;
        // 内部字段绝不覆盖（表名叫 _db 时不能把引擎句柄删掉）
        if (name === '_db') return;
        // 表名撞上类方法（如叫 "save"）时不覆盖方法，保持 1.0.0 的边界行为。
        if (Object.prototype.hasOwnProperty.call(V1Database.prototype, name)) return;
        if (Object.prototype.hasOwnProperty.call(this, name)) {
            delete this[name];
        }
        Object.defineProperty(this, name, {
            get: () => this._db[name],
            enumerable: true,
            configurable: true
        });
    }

    // ============================================================
    // 表管理（1.0.0 语义：同步）
    // ============================================================

    /**
     * 同步建表。
     * @param {string} name
     * @param {object|string} schema
     * @returns {Table}
     */
    createTable(name, schema) {
        const table = this._db._createTableSync(name, parseShorthand(schema));
        this._bindTable(name);
        return table;
    }

    /**
     * 同步删表（表不存在时静默返回，符合 1.0.0 的宽松行为）。
     * @param {string} name
     */
    dropTable(name) {
        if (this._db.hasTable(name)) this._db._dropTableSync(name);
        if (name !== '_db' && Object.prototype.hasOwnProperty.call(this, name)) delete this[name];
    }

    hasTable(name) {
        return this._db.hasTable(name);
    }

    getTable(name) {
        return this._db[name];
    }

    getTables() {
        return this._db.getTables();
    }

    // ============================================================
    // 持久化（与 v6 一致，均为同步）
    // ============================================================

    save() {
        return this._db.save();
    }

    close() {
        return this._db.close();
    }

    export() {
        const data = this._db.export();
        // 1.0.0 的 export() 是快照：调用方会存起来 / 发出去 / 过一会儿再 import。
        // v6 的 Table#toJSON() 直接返回 this._rows，原样透传的话后续 insert/update
        // 会同步改写刚导出的"快照"（import 到新库后两个库还共享同一个数组）。
        // 这里做一次深拷贝，保持导出结果的不可变语义。
        const snapshot = {};
        for (const [name, rows] of Object.entries(data)) {
            snapshot[name] = Array.isArray(rows) ? deepClone(rows) : rows;
        }
        return snapshot;
    }

    /**
     * 导入数据。1.0.0 的 export() 只保留 rows，表不存在时按首行推断 schema 建表，
     * 保证 export → import 往返可用。
     */
    import(data) {
        if (!data || typeof data !== 'object') return this;
        for (const [name, rows] of Object.entries(data)) {
            if (!this._db.hasTable(name)) {
                this.createTable(name, inferSchema(rows));
            }
            // 再拷贝一次：避免导入方后续修改自己的数据时串改库内行
            this._db[name]._loadRows(Array.isArray(rows) ? deepClone(rows) : []);
        }
        this._db._markDirtyLegacy && this._db._markDirtyLegacy();
        return this;
    }
}

module.exports = {
    Database: V1Database,
    Table,
    // 便于测试 / 高级用法
    V1Database,
    _inferSchema: inferSchema
};
