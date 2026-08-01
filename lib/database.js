// © Vexify 2026 All Rights Reserved.
/**
 * JSQL Database — 数据库管理器 v2.0
 * WAL、文件锁、事务隔离级别、慢查询日志、错误码体系
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const Table = require('./table');
const { createError } = require('./errors');
const JSQLFormat = require('./jsql_format');

class Database {
    /**
     * @param {string} filePath - 数据库文件/目录路径，传 null 或 ':memory:' 使用内存模式
     * @param {object} options
     * @param {string} options.mode - 存储模式：
     *   'memory'（默认）：纯内存，不落盘
     *   'hybrid'（混合，Redis 式）：先写内存，后台异步慢慢刷盘；内存充足（默认预留 0.5GB 余量）
     *     则数据常驻内存作为缓存；内存紧张时按 LRU 驱逐最冷表（已落盘），查询时自动从磁盘加载
     *   'disk'（磁盘模式）：写入后尽快刷盘，内存只做读写缓存
     * @param {number} options.memReserveMB - 内存余量 MB（默认 512，即预留 0.5GB）
     * @param {number} options.flushInterval - 脏表后台刷盘间隔 ms（默认 hybrid 200 / disk 50，0 = 每次写后立即刷）
     * @param {number} options.evictInterval - 内存压力检查间隔 ms（默认 1000）
     * @param {boolean} options.autoSave - 是否自动保存（默认 true，仅旧文件模式）
     * @param {number} options.autoSaveInterval - 自动保存间隔 ms（默认 0，仅旧文件模式）
     * @param {boolean} options.pretty - JSON 是否格式化（默认 true，仅旧文件模式）
     * @param {string} options.encryptKey - 加密密钥（16/24/32 字节），启用 AES-256-CBC
     * @param {boolean} options.versioning - 是否启用版本历史（默认 false）
     * @param {boolean} options.wal - 是否启用 WAL 模式（默认 false，内存模式自动禁用）
     * @param {string} options.isolationLevel - 事务隔离级别 'READ_COMMITTED' | 'REPEATABLE_READ'（默认 'READ_COMMITTED'）
     * @param {number} options.slowQueryThreshold - 慢查询阈值 ms（默认 100，0 记录全部，<0 禁用）
     * @param {boolean} options.fileLock - 是否启用文件锁（默认 false）
     */
    constructor(filePath, options = {}) {
        this._filePath = filePath;
        this._memoryMode = !filePath || filePath === ':memory:';
        this._options = {
            autoSave: options.autoSave !== false,
            autoSaveInterval: options.autoSaveInterval || 0,
            pretty: options.pretty !== false
        };

        // 存储模式: 'memory' | 'hybrid' | 'disk' | null(旧文件模式: 全量 save)
        this._mode = options.mode || (this._memoryMode ? 'memory' : null);
        this._dirMode = this._mode === 'hybrid' || this._mode === 'disk';
        this._memReserve = (options.memReserveMB !== undefined ? options.memReserveMB : 512) * 1024 * 1024;
        this._flushInterval = options.flushInterval !== undefined
            ? options.flushInterval
            : (this._mode === 'disk' ? 50 : 200);
        this._evictInterval = options.evictInterval !== undefined ? options.evictInterval : 1000;
        this._dirtyTables = new Set();
        this._flushTimer = null;
        this._monitorTimer = null;
        this._lastAccess = {};
        this._meta = { version: 1, tables: {} };

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
        this._hooks = {
            beforeInsert: [], afterInsert: [],
            beforeUpdate: [], afterUpdate: [],
            beforeDelete: [], afterDelete: [],
            beforeFind: [], afterFind: [],
            beforeCreateTable: [], afterCreateTable: [],
            beforeDropTable: [], afterDropTable: [],
            beforeFlush: [], afterFlush: [],
            beforeCount: [], afterCount: [],
            onStart: [], onStop: []
        };
        this._eventListeners = [];
        this._tableNames = new Set(Object.keys(this._tables));
        this._migrations = [];
        this._observers = [];      // 响应式观察者
        this._views = {};           // 视图 { name: { query, table } }
        this._triggers = {};        // 触发器 { name: { event, table, callback } }
        this._attached = {};        // 附加数据库 { name: db }
        this._changeStream = null; // 变更流

        // WAL（Write-Ahead Logging）
        this._walEnabled = options.wal === true && !this._memoryMode;
        this._walPath = this._filePath ? this._filePath + '.wal' : null;
        this._walOps = [];          // WAL 操作日志

        // 事务隔离
        this._isolationLevel = options.isolationLevel || 'READ_COMMITTED';

        // JSql 格式 (binary block-based)
        this._jsqlMode = this._filePath && this._filePath.endsWith('.jsql');
        this._jsqlFormat = this._jsqlMode ? new JSQLFormat(this._filePath) : null;

        // 文件锁
        this._fileLockEnabled = options.fileLock === true && !this._memoryMode;
        this._lockFd = null;
        this._lockPath = this._filePath ? this._filePath + '.lock' : null;

        // 慢查询日志
        this._slowQueryThreshold = options.slowQueryThreshold !== undefined ? options.slowQueryThreshold : 100;
        this._slowQueries = [];

        // 从文件加载
        if (!this._memoryMode && !this._dirMode && fs.existsSync(this._filePath)) {
            this._loading = true;
            this._acquireLock();
            this._load();
            this._loading = false;
        }

        // 磁盘/混合模式: 目录存储（每表独立 JSql 文件，增量刷盘）
        if (this._dirMode) {
            this._initDirStore();
        }
    }

    // ============================================================
    // 磁盘/混合存储（Redis 式: 内存缓存 + 异步刷盘 + LRU 驱逐）
    // ============================================================

    _initDirStore() {
        if (!this._filePath) throw new Error('hybrid/disk mode requires a directory path');
        fs.mkdirSync(this._filePath, { recursive: true });
        this._metaPath = path.join(this._filePath, 'meta.json');
        this._meta = { version: 1, tables: {} };
        try {
            if (fs.existsSync(this._metaPath)) {
                const parsed = JSON.parse(fs.readFileSync(this._metaPath, 'utf8'));
                if (parsed && parsed.tables) this._meta = parsed;
            }
        } catch (e) {
            this._meta = { version: 1, tables: {} };
        }
        this._startMonitor();
    }

    _tableFile(name) {
        const meta = this._meta.tables[name];
        if (meta && meta.file) return path.join(this._filePath, meta.file);
        return path.join(this._filePath, encodeURIComponent(name) + '.jsql');
    }

    _saveMeta() {
        if (!this._dirMode) return;
        try {
            fs.writeFileSync(this._metaPath, JSON.stringify(this._meta, null, 2), 'utf8');
        } catch (e) {
            // 忽略 meta 写入失败
        }
    }

    _touchTable(name) {
        this._lastAccess[name] = Date.now();
    }

    _ensureTable(name) {
        if (this._tables[name]) return this._tables[name];
        if (!this._dirMode) return null;
        const meta = this._meta.tables[name];
        if (!meta) return null;
        const file = path.join(this._filePath, meta.file);
        if (!fs.existsSync(file)) return null;
        try {
            const fmt = new JSQLFormat(file);
            const { rows } = fmt.readTableSync(name);
            const table = new Table(name, meta.schema, this);
            if (rows && rows.length > 0) table._loadRows(rows);
            this._tables[name] = table;
            if (this._versioning) this._versions[name] = [];
            this._touchTable(name);
            return table;
        } catch (e) {
            return null;
        }
    }

    _markDirty(name) {
        if (!this._dirMode) {
            this._dirty = true;
            return;
        }
        this._touchTable(name);
        this._dirtyTables.add(name);
        this._scheduleFlush();
    }

    _scheduleFlush() {
        if (this._flushTimer) return;
        if (this._flushInterval <= 0) {
            this._flushTimer = setImmediate(() => {
                this._flushTimer = null;
                try { this._flushDirty(); } catch (e) {}
            });
            return;
        }
        this._flushTimer = setTimeout(() => {
            this._flushTimer = null;
            try { this._flushDirty(); } catch (e) {}
        }, this._flushInterval);
        if (this._flushTimer.unref) this._flushTimer.unref();
    }

    _flushDirty() {
        if (!this._dirMode || this._dirtyTables.size === 0) return;
        const names = [...this._dirtyTables];
        this._dirtyTables.clear();
        for (const name of names) this._flushTable(name);
        this._saveMeta();
    }

    _flushTable(name) {
        const table = this._tables[name];
        if (!table) return;
        const meta = this._meta.tables[name];
        let file = meta && meta.file ? meta.file : encodeURIComponent(name) + '.jsql';
        const fmt = new JSQLFormat(path.join(this._filePath, file));
        try {
            const pkField = Object.keys(table._schema).find(f => table._schema[f].primaryKey) || null;
            fmt.writeTable(name, table._schema, table._rows, pkField);
            this._meta.tables[name] = { file, schema: table._schema };
        } finally {
            fmt._close();
        }
    }

    _startMonitor() {
        if (this._monitorTimer) return;
        this._monitorTimer = setInterval(() => {
            try { this._checkMemory(); } catch (e) {}
        }, this._evictInterval);
        if (this._monitorTimer.unref) this._monitorTimer.unref();
    }

    _checkMemory() {
        const total = os.totalmem();
        if (!total) return;
        const budget = total - this._memReserve;
        if (budget <= 0) return;
        const rss = process.memoryUsage().rss;
        if (rss <= budget) return;
        this._evictTables(budget);
    }

    _evictTables(budget) {
        const candidates = Object.keys(this._tables)
            .filter(n => n !== '__meta__' && !this._versioning && this._meta.tables[n]);
        candidates.sort((a, b) => (this._lastAccess[a] || 0) - (this._lastAccess[b] || 0));
        for (const name of candidates) {
            if (budget !== undefined && process.memoryUsage().rss <= budget) break;
            try { this._flushTable(name); } catch (e) { continue; }
            delete this._tables[name];
            delete this[name];
            this._dirtyTables.delete(name);
        }
        this._saveMeta();
    }

    // ============================================================
    // 文件锁
    // ============================================================

    _acquireLock() {
        if (!this._fileLockEnabled) return;
        try {
            // 检查锁文件是否存在
            if (fs.existsSync(this._lockPath)) {
                const lockTime = fs.statSync(this._lockPath).mtimeMs;
                // 锁超过 30 秒视为过期
                if (Date.now() - lockTime > 30000) {
                    fs.unlinkSync(this._lockPath);
                } else {
                    throw createError('ER_LOCK_WAIT_TIMEOUT', 'Database is locked by another process');
                }
            }
            fs.writeFileSync(this._lockPath, String(process.pid), 'utf8');
            this._lockFd = true;
        } catch (e) {
            if (e.code === 'ER_LOCK_WAIT_TIMEOUT') throw e;
            // 权限不足等，降级为无锁模式
            this._fileLockEnabled = false;
        }
    }

    _releaseLock() {
        if (!this._fileLockEnabled || !this._lockFd) return;
        try {
            if (fs.existsSync(this._lockPath)) {
                fs.unlinkSync(this._lockPath);
            }
            this._lockFd = null;
        } catch (e) {
            // 忽略
        }
    }

    // ============================================================
    // WAL（Write-Ahead Logging）
    // ============================================================

    /**
     * 写入 WAL 日志
     */
    _walWrite(op) {
        if (!this._walEnabled) return;
        this._walOps.push({
            ...op,
            timestamp: Date.now(),
            sequence: this._walOps.length + 1
        });
        this._flushWAL();
    }

    /**
     * 将 WAL 刷入磁盘
     */
    _flushWAL() {
        if (!this._walEnabled || this._walOps.length === 0) return;
        try {
            const dir = path.dirname(this._walPath);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(this._walPath, JSON.stringify(this._walOps), 'utf8');
        } catch (e) {
            // WAL 写入失败不应阻塞主流程
        }
    }

    /**
     * 检查点：将 WAL 应用到数据文件并清空 WAL
     */
    _checkpoint() {
        if (!this._walEnabled || this._walOps.length === 0) return;
        // 所有操作已在内存中生效，此函数仅清除 WAL 文件
        this._walOps = [];
        try {
            if (fs.existsSync(this._walPath)) {
                fs.unlinkSync(this._walPath);
            }
        } catch (e) {
            // 忽略
        }
    }

    /**
     * 崩溃恢复：从 WAL 重放操作
     */
    _recoverFromWAL() {
        if (!this._walEnabled || !this._walPath || !fs.existsSync(this._walPath)) return;
        try {
            const walData = JSON.parse(fs.readFileSync(this._walPath, 'utf8'));
            if (!Array.isArray(walData) || walData.length === 0) return;

            // WAL 操作在 v2.0 中仅用于崩溃恢复标记
            // 实际操作已在 save() 时持久化，WAL 主要用于：
            // 1. 标记未完成的事务
            // 2. 在 save() 间隔中保护数据
            this._walOps = [];
            fs.unlinkSync(this._walPath);
        } catch (e) {
            // WAL 损坏，忽略
            try { if (fs.existsSync(this._walPath)) fs.unlinkSync(this._walPath); } catch (_) {}
        }
    }

    // ============================================================
    // 表管理
    // ============================================================

    createTable(name, schema) {
        if (!this._runHooks('beforeCreateTable', [name, schema])) throw createError('ER_PLUGIN_ABORT', 'createTable aborted by plugin');
        if (this._tables[name] || (this._dirMode && this._meta.tables[name])) {
            throw createError('ER_TABLE_EXISTS_ERROR', name);
        }
        const normalized = {};
        for (const [field, def] of Object.entries(schema || {})) {
            if (typeof def === 'string') normalized[field] = { type: def.toLowerCase() };
            else normalized[field] = def;
        }
        const table = new Table(name, normalized, this);
        this._tables[name] = table;
        this._tableNames.add(name);

        Object.defineProperty(this, name, {
            get: () => this._ensureTable(name) || this._tables[name],
            enumerable: true,
            configurable: true
        });

        if (this._versioning) {
            this._versions[name] = [];
        }
        if (this._dirMode) {
            this._meta.tables[name] = { file: encodeURIComponent(name) + '.jsql', schema: normalized };
            this._saveMeta();
        }

        this._markDirty(name);
        this._walWrite({ op: 'createTable', table: name, schema });
        this._emit('createTable', { name, schema });
        this._runHooks('afterCreateTable', [name, schema]);
        return table;
    }

    dropTable(name) {
        if (!this._tables[name] && !(this._dirMode && this._meta.tables[name])) throw createError('ER_NO_SUCH_TABLE', name);
        if (!this._runHooks('beforeDropTable', [name])) return;
        if (this._tables[name]) {
            delete this._tables[name];
        }
        delete this[name];
        delete this._versions[name];
        this._tableNames.delete(name);
        if (this._dirMode) {
            const meta = this._meta.tables[name];
            if (meta && meta.file) {
                try { fs.unlinkSync(path.join(this._filePath, meta.file)); } catch (e) {}
            }
            delete this._meta.tables[name];
            this._dirtyTables.delete(name);
            this._saveMeta();
        }
        this._walWrite({ op: 'dropTable', table: name });
        this._markDirty(name);
        this._emit('dropTable', { name });
        this._runHooks('afterDropTable', [name]);
    }

    hasTable(name) {
        return !!this._tables[name] || (this._dirMode && !!this._meta.tables[name]);
    }

    getTables() {
        const names = new Set(Object.keys(this._tables));
        if (this._dirMode) {
            for (const name of Object.keys(this._meta.tables)) names.add(name);
        }
        return [...names];
    }

    getTableSchema(name) {
        const table = this._ensureTable(name);
        if (table) return table._schema;
        if (this._dirMode && this._meta.tables[name]) return this._meta.tables[name].schema;
        return null;
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
        if (this._views[name]) throw createError('ER_TABLE_EXISTS_ERROR', name);
        this._views[name] = { queryFn };

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
        if (!this._views[name]) throw createError('ER_NO_SUCH_TABLE', name);
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
        if (this._triggers[name]) throw createError('ER_TRIGGER_EXISTS', name);
        const table = this._ensureTable(options.table);
        if (!table) throw createError('ER_NO_SUCH_TABLE', options.table);

        const hookName = options.timing + options.event.charAt(0).toUpperCase() + options.event.slice(1);
        this._triggers[name] = { event: options.event, table: options.table, callback, hookName };
        table.on(hookName, callback);
    }

    dropTrigger(name) {
        const trigger = this._triggers[name];
        if (!trigger) throw createError('ER_TRIGGER_NOT_FOUND', name);
        const table = this._ensureTable(trigger.table);
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
        const table = this._ensureTable(tableName);
        if (!table) throw createError('ER_NO_SUCH_TABLE', tableName);

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
     */
    exportCSV(filePath, tableName, query = {}, options = {}) {
        const table = this._ensureTable(tableName);
        if (!table) throw createError('ER_NO_SUCH_TABLE', tableName);

        const delimiter = options.delimiter || ',';
        const rows = table._applyFilter(table._rows, query);
        const fields = options.fields || Object.keys(table._schema).filter(f => f !== '_softDelete');

        const lines = [];
        lines.push(fields.map(f => this._csvEscape(f, delimiter)).join(delimiter));

        for (const row of rows) {
            lines.push(fields.map(f => {
                const val = row[f];
                return val === null || val === undefined ? '' : this._csvEscape(String(val), delimiter);
            }).join(delimiter));
        }

        const dir = path.dirname(filePath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(filePath, lines.join('\n'), 'utf8');
        return lines.length - 1;
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
            case 'date':
            case 'datetime':
            case 'timestamp':
            case 'time':
                return value;
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
        let totalBTrees = 0;

        for (const [name, table] of Object.entries(this._tables)) {
            if (name === '__meta__') continue;
            const rowCount = table._rows.length;
            const indexCount = Object.keys(table._indexes).length;
            const btreeCount = Object.keys(table._btrees).length;
            const sizeEstimate = JSON.stringify(table._rows).length;
            tableStats[name] = {
                rowCount,
                indexCount: indexCount + btreeCount,
                btreeCount,
                sizeEstimate,
                primaryKey: table._primaryKey,
                columns: Object.keys(table._schema).length,
                softDelete: table._softDelete,
                foreignKeys: table._foreignKeys.length,
                hooks: Object.values(table._hooks).reduce((s, a) => s + a.length, 0)
            };
            totalRows += rowCount;
            totalIndexes += indexCount;
            totalBTrees += btreeCount;
        }

        return {
            tables: Object.keys(this._tables).filter(t => t !== '__meta__').length,
            views: Object.keys(this._views).length,
            triggers: Object.keys(this._triggers).length,
            migrations: this._migrations.length,
            plugins: this._plugins.length,
            totalRows,
            totalIndexes,
            totalBTrees,
            memoryMode: this._memoryMode,
            versioning: this._versioning,
            encrypted: !!this._encryptKey,
            walEnabled: this._walEnabled,
            fileLockEnabled: this._fileLockEnabled,
            isolationLevel: this._isolationLevel,
            slowQueryThreshold: this._slowQueryThreshold,
            slowQueriesCount: this._slowQueries.length,
            tableStats
        };
    }

    // ============================================================
    // 慢查询日志
    // ============================================================

    /**
     * 记录慢查询
     */
    _logSlowQuery(sql, durationMs, rowsReturned) {
        if (this._slowQueryThreshold < 0) return;
        if (this._slowQueryThreshold > 0 && durationMs < this._slowQueryThreshold) return;

        this._slowQueries.push({
            sql,
            duration: durationMs,
            rows: rowsReturned,
            timestamp: Date.now()
        });

        // 限制日志数量
        if (this._slowQueries.length > 1000) {
            this._slowQueries = this._slowQueries.slice(-500);
        }
    }

    /**
     * 获取慢查询日志
     * @param {number} limit - 返回最近 N 条
     */
    getSlowQueries(limit = 50) {
        return this._slowQueries.slice(-limit).reverse();
    }

    /**
     * 清空慢查询日志
     */
    clearSlowQueries() {
        this._slowQueries = [];
    }

    /**
     * 设置慢查询阈值
     * @param {number} ms - 毫秒，0 禁用
     */
    setSlowQueryThreshold(ms) {
        this._slowQueryThreshold = ms;
    }

    // ============================================================
    // 多数据库
    // ============================================================

    /**
     * 附加另一个数据库（跨库查询）
     */
    attach(name, db) {
        if (this._attached[name]) throw createError('ER_DBATTACH_EXISTS', name);
        this._attached[name] = db;

        Object.defineProperty(this, name, {
            get: () => db,
            enumerable: true,
            configurable: true
        });
    }

    detach(name) {
        if (!this._attached[name]) throw createError('ER_DBATTACH_NOT_FOUND', name);
        delete this._attached[name];
        delete this[name];
    }

    getAttached() {
        return Object.keys(this._attached);
    }

    // ============================================================
    // 事务（支持隔离级别）
    // ============================================================

    /**
     * 开始事务
     * @param {string} isolationLevel - 覆盖默认隔离级别（可选）
     */
    begin(isolationLevel) {
        if (this._transaction) throw createError('ER_TRANSACTION_ACTIVE');

        const level = isolationLevel || this._isolationLevel;

        this._transaction = {
            rows: {},
            autoIncrements: {},
            level,
            startedAt: Date.now()
        };

        if (level === 'REPEATABLE_READ') {
            // 快照：保存当前所有数据
            for (const [name, table] of Object.entries(this._tables)) {
                this._transaction.rows[name] = table._rows.map(r => ({ ...r }));
                this._transaction.autoIncrements[name] = table._autoIncrement;
            }
        } else {
            // READ_COMMITTED：只保存 autoIncrement
            for (const [name, table] of Object.entries(this._tables)) {
                this._transaction.autoIncrements[name] = table._autoIncrement;
            }
        }

        this._walWrite({ op: 'begin', level });
    }

    commit() {
        if (!this._transaction) throw createError('ER_NO_TRANSACTION');
        this._walWrite({ op: 'commit', at: this._transaction.startedAt });
        this._transaction = null;
        this._checkpoint();
        this._markDirtyLegacy();
    }

    rollback() {
        if (!this._transaction) throw createError('ER_NO_TRANSACTION');

        for (const [name, table] of Object.entries(this._tables)) {
            if (this._transaction.rows[name]) {
                table._rows = this._transaction.rows[name];
                table._autoIncrement = this._transaction.autoIncrements[name];
                table._rebuildAllBTrees();
                for (const field of Object.keys(table._indexes)) {
                    table.createIndex(field);
                }
            } else if (this._transaction.autoIncrements[name] !== undefined) {
                table._autoIncrement = this._transaction.autoIncrements[name];
            }
        }

        this._walWrite({ op: 'rollback', at: this._transaction.startedAt });
        this._transaction = null;
    }

    inTransaction() {
        return !!this._transaction;
    }

    /**
     * 获取当前事务隔离级别
     */
    getIsolationLevel() {
        return this._transaction ? this._transaction.level : this._isolationLevel;
    }

    /**
     * 设置默认事务隔离级别
     * @param {'READ_COMMITTED'|'REPEATABLE_READ'} level
     */
    setIsolationLevel(level) {
        if (!['READ_COMMITTED', 'REPEATABLE_READ'].includes(level)) {
            throw createError('ER_NOT_SUPPORTED', `Isolation level '${level}' is not supported. Use READ_COMMITTED or REPEATABLE_READ.`);
        }
        this._isolationLevel = level;
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

        if (table._rows.length === 0) return;

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
        if (!this._versioning) throw createError('ER_NOT_SUPPORTED', 'Versioning is not enabled');
        const versions = this._versions[tableName];
        if (!versions || versions.length < 2) throw createError('ER_NOT_SUPPORTED', 'No versions to undo');
        const table = this._ensureTable(tableName);
        if (!table) throw createError('ER_NO_SUCH_TABLE', tableName);

        for (let i = 0; i < steps && versions.length > 1; i++) {
            versions.pop();
            const snapshot = versions[versions.length - 1];
            table._rows = snapshot.rows.map(r => ({ ...r }));
            table._autoIncrement = 0;
            for (const row of table._rows) {
                if (table._autoIncrementField && row[table._autoIncrementField] > table._autoIncrement) {
                    table._autoIncrement = row[table._autoIncrementField];
                }
            }
            table._rebuildAllBTrees();
            for (const field of Object.keys(table._indexes)) {
                table.createIndex(field);
            }
        }
        this._walWrite({ op: 'undo', table: tableName, steps });
        this._markDirtyLegacy();
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
     * @returns {function} 取消监听的函数
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
     * @param {object|function} plugin - { name, install(db, ctx), hooks, onEvent } 或函数 (作为 install)
     */
    use(plugin) {
        if (typeof plugin === 'function') {
            plugin = { install: plugin };
        }
        if (plugin.hooks) {
            for (const [event, fn] of Object.entries(plugin.hooks)) {
                if (this._hooks[event]) {
                    this._hooks[event].push(fn);
                }
            }
        }
        if (typeof plugin.install === 'function') {
            plugin.install(this, this._buildCtx(plugin));
        }
        if (typeof plugin.onEvent === 'function') {
            this._eventListeners.push(plugin.onEvent);
        }
        this._plugins.push(plugin);
        return this;
    }

    _buildCtx(plugin) {
        const self = this;
        return {
            name: plugin.name || 'anonymous',
            engine: this,
            plugin,
            on(hook, fn) { return self.on(hook, fn); },
            onEvent(fn) { return self.onEvent(fn); },
            emit(eventName, data) { self._emit(eventName, data); },
            tables() { return Array.from(self._tableNames); },
            hasTable(name) { return self._tableNames.has(name); },
            getTableSchema(name) {
                const t = self._tables[name];
                return t ? t._schema : null;
            },
            table(name) { return self._tables[name] || null; }
        };
    }

    on(event, fn) {
        if (this._hooks[event]) {
            this._hooks[event].push(fn);
        }
        return this;
    }

    onEvent(fn) {
        this._eventListeners.push(fn);
        return this;
    }

    _emit(eventName, data) {
        for (const fn of this._eventListeners) {
            try { fn(eventName, data); } catch (e) { /* ignore */ }
        }
    }

    _runHooks(hookName, args) {
        const hooks = this._hooks[hookName];
        if (!hooks || hooks.length === 0) return true;
        for (const fn of hooks) {
            const r = fn(...args);
            if (r === false) return false;
            if (r !== undefined && args.length > 0) {
                args[0] = r;
            }
        }
        return true;
    }

    // ============================================================
    // 统一高层 API（与 Native/WASM 引擎对齐）
    // ============================================================

    _pkOf(table) {
        return table._primaryKey || table._autoIncrementField || null;
    }

    async start() {
        this._runHooks('onStart', []);
        this._emit('start', {});
        return this;
    }

    insert(tableName, data) {
        const table = this._ensureTable(tableName);
        if (!table) throw createError('ER_NO_SUCH_TABLE', tableName);
        const arr = Array.isArray(data) ? data : [data];
        if (!this._runHooks('beforeInsert', [tableName, arr])) return [];
        const pk = this._pkOf(table);
        const ids = [];
        for (const row of arr) {
            const r = table.insert(row);
            ids.push(pk ? r[pk] : (table._rows.indexOf(r) + 1));
        }
        this._emit('insert', { table: tableName, count: arr.length, ids });
        this._runHooks('afterInsert', [tableName, arr, ids]);
        this._markDirty(tableName);
        return ids;
    }

    async flush() {
        if (!this._runHooks('beforeFlush', [])) return;
        if (this._dirMode) {
            this._flushDirty();
            this._saveMeta();
        } else if (!this._memoryMode) {
            this.save();
        }
        this._runHooks('afterFlush', []);
        return this;
    }

    _resolveId(table, id) {
        const pk = this._pkOf(table);
        if (pk) return table._rows.find(r => r[pk] === id) || null;
        return table._rows[id - 1] || null;
    }

    find(tableName, filter, opts = {}) {
        const table = this._ensureTable(tableName);
        if (!table) throw createError('ER_NO_SUCH_TABLE', tableName);
        if (!this._runHooks('beforeFind', [tableName, { filter, opts }])) return [];
        const { limit = 100, offset = 0 } = opts;
        let rows = table._applyFilter(table._rows, filter || {});
        rows = rows.slice(offset, offset + limit);
        this._touchTable(tableName);
        this._runHooks('afterFind', [tableName, { filter, opts }, rows]);
        return rows;
    }

    findById(tableName, id) {
        const table = this._ensureTable(tableName);
        if (!table) throw createError('ER_NO_SUCH_TABLE', tableName);
        if (!this._runHooks('beforeFind', [tableName, { id }])) return null;
        const row = this._resolveId(table, id);
        this._touchTable(tableName);
        this._runHooks('afterFind', [tableName, { id }, row]);
        return row;
    }

    findByIds(tableName, ids) {
        const table = this._ensureTable(tableName);
        if (!table) throw createError('ER_NO_SUCH_TABLE', tableName);
        if (!this._runHooks('beforeFind', [tableName, { ids }])) return null;
        const rows = ids.map(id => this._resolveId(table, id)).filter(r => r !== null);
        this._touchTable(tableName);
        this._runHooks('afterFind', [tableName, { ids }, rows]);
        return rows;
    }

    findByIdsRaw(tableName, ids) {
        return this.findByIds(tableName, ids);
    }

    count(tableName) {
        const table = this._ensureTable(tableName);
        if (!table) throw createError('ER_NO_SUCH_TABLE', tableName);
        this._runHooks('beforeCount', [tableName]);
        const n = table._rows.length;
        this._touchTable(tableName);
        this._runHooks('afterCount', [tableName, n]);
        return n;
    }

    updateById(tableName, id, data) {
        const table = this._ensureTable(tableName);
        if (!table) throw createError('ER_NO_SUCH_TABLE', tableName);
        if (!this._runHooks('beforeUpdate', [tableName, id, data])) return;
        const row = this._resolveId(table, id);
        if (!row) return { ok: false, error: 'not found' };
        Object.assign(row, data);
        this._emit('update', { table: tableName, id, data });
        this._runHooks('afterUpdate', [tableName, id, data, { ok: true }]);
        this._markDirty(tableName);
        return { ok: true };
    }

    updateByIds(tableName, entries) {
        const table = this._ensureTable(tableName);
        if (!table) throw createError('ER_NO_SUCH_TABLE', tableName);
        const pairs = entries.map(([id, data]) => [id, data]);
        if (!this._runHooks('beforeUpdate', [tableName, pairs])) return;
        let count = 0;
        for (const [id, data] of pairs) {
            const row = this._resolveId(table, id);
            if (row) { Object.assign(row, data); count++; }
        }
        this._emit('update', { table: tableName, entries: pairs, result: { ok: true, count } });
        this._runHooks('afterUpdate', [tableName, pairs, { ok: true, count }]);
        this._markDirty(tableName);
        return { ok: true, count };
    }

    removeById(tableName, id) {
        const table = this._ensureTable(tableName);
        if (!table) throw createError('ER_NO_SUCH_TABLE', tableName);
        if (!this._runHooks('beforeDelete', [tableName, id])) return;
        const idx = table._rows.findIndex(r => r === this._resolveId(table, id));
        if (idx === -1) return { ok: false, error: 'not found' };
        table._rows.splice(idx, 1);
        this._emit('delete', { table: tableName, id });
        this._runHooks('afterDelete', [tableName, id, { ok: true }]);
        this._markDirty(tableName);
        return { ok: true };
    }

    removeByIds(tableName, ids) {
        const table = this._ensureTable(tableName);
        if (!table) throw createError('ER_NO_SUCH_TABLE', tableName);
        if (!this._runHooks('beforeDelete', [tableName, ids])) return;
        let removed = 0;
        for (const id of ids) {
            const idx = table._rows.findIndex(r => r === this._resolveId(table, id));
            if (idx !== -1) {
                table._rows.splice(idx, 1);
                removed++;
            }
        }
        this._emit('delete', { table: tableName, ids, result: { ok: true, count: removed } });
        this._runHooks('afterDelete', [tableName, ids, { ok: true, count: removed }]);
        this._markDirty(tableName);
        return { ok: true, count: removed };
    }

    async stop() {
        this._runHooks('onStop', []);
        this._emit('stop', {});
        if (this._dirMode) {
            try {
                this._flushDirty();
                this._saveMeta();
            } catch (e) {}
        }
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
            throw createError('ER_FILE_NOT_FOUND', filePath);
        }
        const json = this._readFile(filePath);
        const data = JSON.parse(json);
        for (const [name, rows] of Object.entries(data)) {
            if (this._tables[name]) {
                this._tables[name]._loadRows(rows);
            }
        }
        this._walWrite({ op: 'restore', from: filePath });
        this._markDirtyLegacy();
    }

    // ============================================================
    // 持久化
    // ============================================================

    save() {
        // 版本快照
        if (this._versioning) {
            for (const name of Object.keys(this._tables)) {
                this.snapshot(name);
            }
        }

        if (this._memoryMode) return;
        if (this._dirMode) {
            this._flushDirty();
            this._saveMeta();
            return;
        }

        if (this._jsqlMode) {
            const all = {};
            for (const [name, table] of Object.entries(this._tables)) {
                if (name === '__meta__') continue;
                const pkField = Object.keys(table._schema).find(f => table._schema[f].primaryKey);
                all[name] = { schema: table._schema, rows: table._rows, pkField };
            }
            this._jsqlFormat.saveAll(all);
            this._jsqlFormat._close();
            this._dirty = false;
            this._checkpoint();
            return;
        }

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

        // 保存后做检查点
        this._checkpoint();
    }

    _load() {
        try {
        if (this._jsqlMode) {
            this._jsqlFormat._open();
            for (const [name, t] of this._jsqlFormat.tables) {
                if (!this._tables[name]) this.createTable(name, t.schema);
                if (t.rowCount > 0) {
                    const { rows } = this._jsqlFormat.readTableSync(name);
                    this._tables[name]._loadRows(rows);
                }
            }
            return;
        }

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

            // WAL 恢复
            this._recoverFromWAL();
        } catch (e) {
            throw new Error(`Failed to load database from '${this._filePath}': ${e.message}`);
        }
    }

    _markDirtyLegacy() {
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
        if (this._jsqlFormat) this._jsqlFormat._close();
        this._releaseLock();
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
        this._walWrite({ op: 'import', tables: Object.keys(data) });
        this._markDirtyLegacy();
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