// © Vexify 2026 All Rights Reserved.
/**
 * JSQL Database — 数据库管理器
 * 支持加密、插件系统、迁移、版本历史、变更流、响应式查询
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Table = require('./table');

class Database {
    /**
     * @param {string} filePath - 数据库文件路径，传 null 或 ':memory:' 使用内存模式
     * @param {object} options
     * @param {boolean} options.autoSave - 是否自动保存（默认 true）
     * @param {number} options.autoSaveInterval - 自动保存间隔 ms（默认 0）
     * @param {boolean} options.pretty - JSON 是否格式化（默认 true）
     * @param {string} options.encryptKey - 加密密钥（16/24/32 字节），启用 AES-256-CBC
     * @param {boolean} options.versioning - 是否启用版本历史（默认 false）
     */
    constructor(filePath, options = {}) {
        this._filePath = filePath;
        this._memoryMode = !filePath || filePath === ':memory:';
        this._options = {
            autoSave: options.autoSave !== false,
            autoSaveInterval: options.autoSaveInterval || 0,
            pretty: options.pretty !== false
        };
        this._tables = {};
        this._dirty = false;
        this._autoSaveTimer = null;
        this._loading = false;
        this._transaction = null;
        this._encryptKey = options.encryptKey || null;
        this._versioning = options.versioning || false;
        this._versions = {};       // tableName -> [{ rows, timestamp }]
        this._maxVersions = options.maxVersions || 50;
        this._plugins = [];
        this._migrations = [];
        this._observers = [];      // 响应式观察者
        this._views = {};           // 视图 { name: { query, table } }
        this._triggers = {};        // 触发器 { name: { event, table, callback } }
        this._attached = {};        // 附加数据库 { name: db }
        this._changeStream = null; // 变更流

        // 从文件加载
        if (!this._memoryMode && fs.existsSync(this._filePath)) {
            this._loading = true;
            this._load();
            this._loading = false;
        }
    }

    // ============================================================
    // 表管理
    // ============================================================

    createTable(name, schema) {
        if (this._tables[name]) {
            throw new Error(`Table '${name}' already exists`);
        }
        const table = new Table(name, schema, this);
        this._tables[name] = table;

        Object.defineProperty(this, name, {
            get: () => this._tables[name],
            enumerable: true,
            configurable: true
        });

        if (this._versioning) {
            this._versions[name] = [];
        }

        this._markDirty();
        return table;
    }

    dropTable(name) {
        if (!this._tables[name]) throw new Error(`Table '${name}' does not exist`);
        delete this._tables[name];
        delete this[name];
        delete this._versions[name];
        this._markDirty();
    }

    hasTable(name) {
        return !!this._tables[name];
    }

    getTables() {
        return Object.keys(this._tables);
    }

    // ============================================================
    // 视图
    // ============================================================

    /**
     * 创建视图（虚拟表）
     * @param {string} name - 视图名
     * @param {function} queryFn - (db) => Query 实例
     * @example
     * db.createView('adults', db => db.users.where({ age: { $gte: 18 } }).select(['name', 'age']));
     */
    createView(name, queryFn) {
        if (this._views[name]) throw new Error(`View '${name}' already exists`);
        this._views[name] = { queryFn };

        // 代理到 db 上
        Object.defineProperty(this, name, {
            get: () => {
                const q = queryFn(this);
                return {
                    get: () => q.get(),
                    first: () => q.first(),
                    count: () => q.count(),
                    sum: (f) => q.sum(f),
                    avg: (f) => q.avg(f),
                    min: (f) => q.min(f),
                    max: (f) => q.max(f),
                    _query: q
                };
            },
            enumerable: true,
            configurable: true
        });
    }

    dropView(name) {
        if (!this._views[name]) throw new Error(`View '${name}' does not exist`);
        delete this._views[name];
        delete this[name];
    }

    getViews() {
        return Object.keys(this._views);
    }

    // ============================================================
    // 触发器
    // ============================================================

    /**
     * 创建触发器
     * @param {string} name - 触发器名
     * @param {object} options - { event: 'insert'|'update'|'remove', table: 'tableName', timing: 'before'|'after' }
     * @param {function} callback - 触发时执行的回调
     */
    createTrigger(name, options, callback) {
        if (this._triggers[name]) throw new Error(`Trigger '${name}' already exists`);
        const table = this._tables[options.table];
        if (!table) throw new Error(`Table '${options.table}' does not exist`);

        const hookName = options.timing + options.event.charAt(0).toUpperCase() + options.event.slice(1);
        this._triggers[name] = { event: options.event, table: options.table, callback, hookName };
        table.on(hookName, callback);
    }

    dropTrigger(name) {
        const trigger = this._triggers[name];
        if (!trigger) throw new Error(`Trigger '${name}' does not exist`);
        const table = this._tables[trigger.table];
        if (table) table.off(trigger.hookName, trigger.callback);
        delete this._triggers[name];
    }

    getTriggers() {
        return Object.keys(this._triggers).map(name => ({
            name,
            event: this._triggers[name].event,
            table: this._triggers[name].table
        }));
    }

    // ============================================================
    // CSV 导入/导出
    // ============================================================

    /**
     * 从 CSV 文件导入数据到表
     * @param {string} filePath - CSV 文件路径
     * @param {string} tableName - 目标表名
     * @param {object} options - { delimiter: ',', hasHeader: true, skipRows: 0, mapping: { csvCol: schemaCol } }
     */
    importCSV(filePath, tableName, options = {}) {
        const table = this._tables[tableName];
        if (!table) throw new Error(`Table '${tableName}' does not exist`);

        const delimiter = options.delimiter || ',';
        const hasHeader = options.hasHeader !== false;
        const skipRows = options.skipRows || 0;
        const mapping = options.mapping || null;

        const content = fs.readFileSync(filePath, 'utf8');
        const lines = content.split(/\r?\n/).filter(l => l.trim());

        let headers = [];
        let startRow = 0;

        if (hasHeader) {
            headers = this._parseCSVLine(lines[0], delimiter);
            startRow = 1 + skipRows;
        } else {
            startRow = skipRows;
        }

        let count = 0;
        for (let i = startRow; i < lines.length; i++) {
            const values = this._parseCSVLine(lines[i], delimiter);
            if (values.length === 0) continue;

            const data = {};
            if (mapping) {
                for (const [csvCol, schemaCol] of Object.entries(mapping)) {
                    const idx = hasHeader ? headers.indexOf(csvCol) : parseInt(csvCol);
                    if (idx >= 0 && idx < values.length) {
                        data[schemaCol] = this._castValue(values[idx], table._schema[schemaCol]);
                    }
                }
            } else if (hasHeader) {
                for (let j = 0; j < headers.length; j++) {
                    if (j < values.length && table._schema[headers[j]]) {
                        data[headers[j]] = this._castValue(values[j], table._schema[headers[j]]);
                    }
                }
            }

            if (Object.keys(data).length > 0) {
                table.insert(data);
                count++;
            }
        }

        return count;
    }

    /**
     * 导出表数据到 CSV 文件
     * @param {string} filePath - 输出文件路径
     * @param {string} tableName - 表名
     * @param {object} query - 筛选条件（可选）
     * @param {object} options - { delimiter: ',', fields: ['col1','col2'] }
     */
    exportCSV(filePath, tableName, query = {}, options = {}) {
        const table = this._tables[tableName];
        if (!table) throw new Error(`Table '${tableName}' does not exist`);

        const delimiter = options.delimiter || ',';
        const rows = table._applyFilter(table._rows, query);
        const fields = options.fields || Object.keys(table._schema).filter(f => f !== '_softDelete');

        const lines = [];
        // 表头
        lines.push(fields.map(f => this._csvEscape(f, delimiter)).join(delimiter));

        // 数据行
        for (const row of rows) {
            lines.push(fields.map(f => {
                const val = row[f];
                return val === null || val === undefined ? '' : this._csvEscape(String(val), delimiter);
            }).join(delimiter));
        }

        const dir = path.dirname(filePath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(filePath, lines.join('\n'), 'utf8');
        return lines.length - 1; // 返回数据行数
    }

    _parseCSVLine(line, delimiter) {
        const result = [];
        let current = '';
        let inQuotes = false;

        for (let i = 0; i < line.length; i++) {
            const ch = line[i];
            if (inQuotes) {
                if (ch === '"') {
                    if (i + 1 < line.length && line[i + 1] === '"') {
                        current += '"';
                        i++;
                    } else {
                        inQuotes = false;
                    }
                } else {
                    current += ch;
                }
            } else {
                if (ch === '"') {
                    inQuotes = true;
                } else if (ch === delimiter) {
                    result.push(current.trim());
                    current = '';
                } else {
                    current += ch;
                }
            }
        }
        result.push(current.trim());
        return result;
    }

    _csvEscape(value, delimiter) {
        if (value.includes(delimiter) || value.includes('"') || value.includes('\n')) {
            return '"' + value.replace(/"/g, '""') + '"';
        }
        return value;
    }

    _castValue(value, schemaDef) {
        if (!schemaDef || !value) return value;
        switch (schemaDef.type) {
            case 'integer': return parseInt(value, 10) || 0;
            case 'number': return parseFloat(value) || 0;
            case 'boolean': return value.toLowerCase() === 'true' || value === '1';
            case 'array': try { return JSON.parse(value); } catch(e) { return [value]; }
            case 'object': try { return JSON.parse(value); } catch(e) { return {}; }
            default: return value;
        }
    }

    // ============================================================
    // 数据库统计
    // ============================================================

    /**
     * 获取数据库统计信息
     */
    stats() {
        const tableStats = {};
        let totalRows = 0;
        let totalIndexes = 0;

        for (const [name, table] of Object.entries(this._tables)) {
            if (name === '__meta__') continue;
            const rowCount = table._rows.length;
            const indexCount = Object.keys(table._indexes).length;
            const sizeEstimate = JSON.stringify(table._rows).length;
            tableStats[name] = {
                rowCount,
                indexCount,
                sizeEstimate,
                primaryKey: table._primaryKey,
                columns: Object.keys(table._schema).length,
                softDelete: table._softDelete,
                foreignKeys: table._foreignKeys.length,
                hooks: Object.values(table._hooks).reduce((s, a) => s + a.length, 0)
            };
            totalRows += rowCount;
            totalIndexes += indexCount;
        }

        return {
            tables: Object.keys(this._tables).filter(t => t !== '__meta__').length,
            views: Object.keys(this._views).length,
            triggers: Object.keys(this._triggers).length,
            migrations: this._migrations.length,
            plugins: this._plugins.length,
            totalRows,
            totalIndexes,
            memoryMode: this._memoryMode,
            versioning: this._versioning,
            encrypted: !!this._encryptKey,
            tableStats
        };
    }

    // ============================================================
    // 多数据库
    // ============================================================

    /**
     * 附加另一个数据库（跨库查询）
     * @param {string} name - 别名
     * @param {Database} db - 另一个 Database 实例
     */
    attach(name, db) {
        if (this._attached[name]) throw new Error(`Database '${name}' already attached`);
        this._attached[name] = db;

        Object.defineProperty(this, name, {
            get: () => db,
            enumerable: true,
            configurable: true
        });
    }

    detach(name) {
        if (!this._attached[name]) throw new Error(`Database '${name}' is not attached`);
        delete this._attached[name];
        delete this[name];
    }

    getAttached() {
        return Object.keys(this._attached);
    }

    // ============================================================
    // 事务
    // ============================================================

    begin() {
        if (this._transaction) throw new Error('Transaction already in progress');
        this._transaction = { rows: {}, autoIncrements: {} };
        for (const [name, table] of Object.entries(this._tables)) {
            this._transaction.rows[name] = table._rows.map(r => ({ ...r }));
            this._transaction.autoIncrements[name] = table._autoIncrement;
        }
    }

    commit() {
        if (!this._transaction) throw new Error('No transaction in progress');
        this._transaction = null;
        this._markDirty();
    }

    rollback() {
        if (!this._transaction) throw new Error('No transaction in progress');
        for (const [name, table] of Object.entries(this._tables)) {
            if (this._transaction.rows[name]) {
                table._rows = this._transaction.rows[name];
                table._autoIncrement = this._transaction.autoIncrements[name];
                for (const field of Object.keys(table._indexes)) {
                    table.createIndex(field);
                }
            }
        }
        this._transaction = null;
    }

    inTransaction() {
        return !!this._transaction;
    }

    // ============================================================
    // 版本历史
    // ============================================================

    /**
     * 保存当前快照
     */
    snapshot(tableName) {
        if (!this._versioning) return;
        const table = this._tables[tableName];
        if (!table) return;
        if (!this._versions[tableName]) this._versions[tableName] = [];

        // 空表跳过
        if (table._rows.length === 0) return;

        // 去重：如果当前状态与上次快照相同，跳过
        const currentHash = JSON.stringify(table._rows);
        const versions = this._versions[tableName];
        if (versions.length > 0 && versions[versions.length - 1]._hash === currentHash) return;

        versions.push({
            rows: table._rows.map(r => ({ ...r })),
            timestamp: Date.now(),
            _hash: currentHash
        });
        if (versions.length > this._maxVersions) {
            versions.shift();
        }
    }

    /**
     * 回退到指定版本
     */
    undo(tableName, steps = 1) {
        if (!this._versioning) throw new Error('Versioning is not enabled');
        const versions = this._versions[tableName];
        if (!versions || versions.length < 2) throw new Error('No versions to undo');
        const table = this._tables[tableName];
        if (!table) throw new Error(`Table '${tableName}' not found`);

        for (let i = 0; i < steps && versions.length > 1; i++) {
            versions.pop();  // 丢弃最新版本
            const snapshot = versions[versions.length - 1];  // 恢复到上一个版本
            table._rows = snapshot.rows.map(r => ({ ...r }));
            table._autoIncrement = 0;
            for (const row of table._rows) {
                if (table._autoIncrementField && row[table._autoIncrementField] > table._autoIncrement) {
                    table._autoIncrement = row[table._autoIncrementField];
                }
            }
            for (const field of Object.keys(table._indexes)) {
                table.createIndex(field);
            }
        }
        this._markDirty();
        return versions.length;
    }

    getVersions(tableName) {
        return this._versions[tableName] || [];
    }

    // ============================================================
    // 变更流 & 响应式
    // ============================================================

    /**
     * 监听变更事件
     * @param {function} callback - (event) => {}  event: { type, table, data, timestamp }
     */
    onChange(callback) {
        this._observers.push(callback);
        return () => {
            this._observers = this._observers.filter(cb => cb !== callback);
        };
    }

    _emitChange(type, table, data) {
        const event = { type, table, data, timestamp: Date.now() };
        for (const cb of this._observers) {
            try { cb(event); } catch (e) { /* ignore */ }
        }
    }

    /**
     * 创建变更流（返回异步迭代器）
     */
    createChangeStream() {
        const events = [];
        let resolve = null;
        const unsubscribe = this.onChange(event => {
            events.push(event);
            if (resolve) {
                resolve();
                resolve = null;
            }
        });

        return {
            [Symbol.asyncIterator]() {
                return {
                    next: async () => {
                        while (events.length === 0) {
                            await new Promise(r => resolve = r);
                        }
                        return { value: events.shift(), done: false };
                    }
                };
            },
            close: unsubscribe
        };
    }

    // ============================================================
    // 插件系统
    // ============================================================

    /**
     * 注册插件
     * @param {object} plugin - { name, install(db) }
     */
    use(plugin) {
        if (typeof plugin.install !== 'function') {
            throw new Error('Plugin must have an install() method');
        }
        this._plugins.push(plugin);
        plugin.install(this);
        return this;
    }

    // ============================================================
    // 迁移
    // ============================================================

    /**
     * 注册迁移
     * @param {object} migration - { version, name, up(db), down(db) }
     */
    addMigration(migration) {
        this._migrations.push(migration);
        this._migrations.sort((a, b) => a.version - b.version);
    }

    /**
     * 执行迁移到指定版本
     */
    migrate(targetVersion) {
        const current = this._getCurrentVersion();
        if (targetVersion === undefined) {
            targetVersion = this._migrations.length > 0
                ? this._migrations[this._migrations.length - 1].version
                : 0;
        }

        if (targetVersion > current) {
            for (const m of this._migrations) {
                if (m.version > current && m.version <= targetVersion) {
                    m.up(this);
                    this._setCurrentVersion(m.version);
                }
            }
        } else if (targetVersion < current) {
            for (const m of this._migrations.reverse()) {
                if (m.version <= current && m.version > targetVersion) {
                    m.down(this);
                    this._setCurrentVersion(m.version - 1);
                }
            }
        }
    }

    _getCurrentVersion() {
        return this._tables['__meta__']
            ? (this._tables['__meta__'].findOne({ key: 'version' })?.value || 0)
            : 0;
    }

    _setCurrentVersion(version) {
        if (!this._tables['__meta__']) {
            this.createTable('__meta__', {
                key: { type: 'string', primaryKey: true },
                value: { type: 'any' }
            });
        }
        this._tables['__meta__'].upsert({ key: 'version', value: version });
    }

    // ============================================================
    // 备份与恢复
    // ============================================================

    backup(filePath) {
        const data = this.export();
        const json = this._options.pretty
            ? JSON.stringify(data, null, 2)
            : JSON.stringify(data);
        this._writeFile(filePath, json);
        return filePath;
    }

    restore(filePath) {
        if (!fs.existsSync(filePath)) {
            throw new Error(`Backup file not found: ${filePath}`);
        }
        const json = this._readFile(filePath);
        const data = JSON.parse(json);
        for (const [name, rows] of Object.entries(data)) {
            if (this._tables[name]) {
                this._tables[name]._loadRows(rows);
            }
        }
        this._markDirty();
    }

    // ============================================================
    // 持久化
    // ============================================================

    save() {
        // 版本快照（内存模式也支持）
        if (this._versioning) {
            for (const name of Object.keys(this._tables)) {
                this.snapshot(name);
            }
        }

        if (this._memoryMode) return;

        const data = { __schema__: {}, __meta__: { version: this._getCurrentVersion() } };
        for (const [name, table] of Object.entries(this._tables)) {
            if (name === '__meta__') continue;
            data.__schema__[name] = table._schema;
            data[name] = table.toJSON();
        }

        const json = this._options.pretty
            ? JSON.stringify(data, null, 2)
            : JSON.stringify(data);
        this._writeFile(this._filePath, json);
        this._dirty = false;
    }

    _load() {
        try {
            const json = this._readFile(this._filePath);
            const data = JSON.parse(json);

            if (data.__schema__) {
                for (const [name, schema] of Object.entries(data.__schema__)) {
                    if (!this._tables[name]) {
                        this.createTable(name, schema);
                    }
                }
            }

            for (const [name, rows] of Object.entries(data)) {
                if (name !== '__schema__' && name !== '__meta__' && this._tables[name]) {
                    this._tables[name]._loadRows(rows);
                }
            }
        } catch (e) {
            throw new Error(`Failed to load database from '${this._filePath}': ${e.message}`);
        }
    }

    _markDirty() {
        this._dirty = true;
        if (this._loading) return;
        if (this._options.autoSave && !this._autoSaveTimer) {
            if (this._options.autoSaveInterval > 0) {
                this._autoSaveTimer = setTimeout(() => {
                    this._autoSaveTimer = null;
                    if (this._dirty) this.save();
                }, this._options.autoSaveInterval);
            } else {
                this.save();
            }
        }
    }

    close() {
        if (this._autoSaveTimer) {
            clearTimeout(this._autoSaveTimer);
            this._autoSaveTimer = null;
        }
        if (this._dirty && !this._memoryMode) {
            this.save();
        }
        this._tables = {};
    }

    export() {
        const data = {};
        for (const [name, table] of Object.entries(this._tables)) {
            if (name === '__meta__') continue;
            data[name] = table.toJSON();
        }
        return data;
    }

    import(data) {
        for (const [name, rows] of Object.entries(data)) {
            if (this._tables[name]) {
                this._tables[name]._loadRows(rows);
            }
        }
        this._markDirty();
    }

    // ============================================================
    // 加密（内部）
    // ============================================================

    _writeFile(filePath, content) {
        if (this._encryptKey) {
            const iv = crypto.randomBytes(16);
            const cipher = crypto.createCipheriv('aes-256-cbc', Buffer.from(this._encryptKey.padEnd(32).slice(0, 32)), iv);
            const encrypted = Buffer.concat([cipher.update(content, 'utf8'), cipher.final()]);
            const data = Buffer.concat([iv, encrypted]);
            fs.writeFileSync(filePath, data.toString('base64'), 'utf8');
        } else {
            const dir = path.dirname(filePath);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(filePath, content, 'utf8');
        }
    }

    _readFile(filePath) {
        if (this._encryptKey) {
            const data = Buffer.from(fs.readFileSync(filePath, 'utf8'), 'base64');
            const iv = data.slice(0, 16);
            const encrypted = data.slice(16);
            const decipher = crypto.createDecipheriv('aes-256-cbc', Buffer.from(this._encryptKey.padEnd(32).slice(0, 32)), iv);
            return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
        }
        return fs.readFileSync(filePath, 'utf8');
    }
}

module.exports = Database;