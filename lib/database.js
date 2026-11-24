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
const { createError, JSQL_Error, ErrorCodes } = require('./errors');
const bigintJson = require('./bigint_json');

/**
 * 构造带补充说明的错误。
 *
 * 为什么不能直接用 createError：它的消息来自错误码目录的模板，
 * 只把 %s 换成参数 —— ER_NO_TRANSACTION 的模板里没有 %s，
 * 自定义说明会被整段丢弃，用户只能看到一句 "No transaction in progress"，
 * 不知道该怎么做。这里沿用同一个 MySQL 错误码（保证兼容），
 * 但在标准消息后面补上有用的提示。
 */
function errorWithHint(codeKey, hint) {
    const t = ErrorCodes[codeKey];
    if (!t) return new JSQL_Error('UNKNOWN', hint);
    const msg = hint ? `${t.msg}: ${hint}` : t.msg;
    return new JSQL_Error(t.code, msg, { codeKey });
}
const JSQLFormat = require('./jsql_format');

// live 表达到该行数后也挂上行级 LRU：此前只有从磁盘 reload 的表才有
// rowCache，运行时新建的大表一直整表常驻，最终被整表驱逐或 OOM（#127）。
const ROW_CACHE_MIN_ROWS = 1000;
const { valuesEqual } = require('./objectid');
const {
  createHookRegistry, applyPlugin, buildPluginContext, registerHook,
  runHooks, getPluginApis
} = require('./plugin');

/**
 * 解析字段简写类型字符串，如 'integer primary key'、'string unique'、
 * 'integer primary key auto_increment'、'datetime default now'
 * @param {string} str - 简写字符串（已小写化）
 * @returns {object} { type, primaryKey, unique, autoIncrement, required, ... }
 */
function parseFieldShorthand(str) {
    const def = { type: str };
    const strip = (re) => {
        const next = def.type.replace(re, '').trim();
        def.type = next || def.type;
    };
    if (/\bprimary\s+key\b/i.test(def.type)) { def.primaryKey = true; strip(/\bprimary\s+key\b/gi); }
    if (/\bauto_?increment\b/i.test(def.type)) { def.autoIncrement = true; strip(/\bauto_?increment\b/gi); }
    if (/\bnot\s+null\b/i.test(def.type)) { def.required = true; strip(/\bnot\s+null\b/gi); }
    if (/\bunique\b/i.test(def.type)) { def.unique = true; strip(/\bunique\b/gi); }
    if (/\bdefault\s+(\S+)/i.test(def.type)) {
        const m = def.type.match(/\bdefault\s+(\S+)/i);
        def.default = m[1].replace(/^['"]|['"]$/g, '');
        strip(/\bdefault\s+\S+/gi);
    }
    return def;
}

/**
 * 深度相等比较两个行对象（用于无主键表的行匹配）。
 * 剥离内部字段（_rid, _deleted）后逐字段比较。
 */
function _rowDeepEqual(a, b) {
    if (a === b) return true;
    if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
    const strip = (obj) => {
        const out = {};
        for (const [k, v] of Object.entries(obj)) {
            if (k === '_rid' || k === '_deleted') continue;
            out[k] = v;
        }
        return out;
    };
    const sa = strip(a), sb = strip(b);
    const ka = Object.keys(sa), kb = Object.keys(sb);
    if (ka.length !== kb.length) return false;
    for (const k of ka) {
        if (!Object.prototype.hasOwnProperty.call(sb, k)) return false;
        const va = sa[k], vb = sb[k];
        if (va === vb) continue;
        if (va === null || va === undefined || vb === null || vb === undefined) return false;
        if (typeof va === 'number' && typeof vb === 'number' && va === vb) continue;
        if (String(va) !== String(vb)) return false;
    }
    return true;
}

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
     * @param {boolean} options.wal - 是否启用 WAL（默认 true：文件模式写入立即 append 到内核，fsync 按
     *   walSyncInterval 合并；内存模式自动禁用；传 false 关闭；目录 hybrid/disk 模式与加密库默认关闭）
     * @param {number} options.walCheckpointOps - WAL 累积多少条后自动做一次快照检查点（默认 1000，0 禁用）
     * @param {number} options.walSyncInterval - WAL fsync 合并窗口 ms（默认 20）。写入仍立即 write() 到内核，
     *   进程崩溃 / kill -9 不丢已提交写入；fsync 按窗口合并以摊薄磁盘刷写成本（掉电最多丢一个窗口，
     *   等价 SQLite WAL 的 synchronous=NORMAL）。传 0 恢复「每条写入立即 fsync」的严格模式。
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
        // #320：encryptKey 的字节长度必须落在 AES 密钥长度集合 {16, 24, 32} 内。
        // 此前构造阶段不校验，写入侧用 padEnd(32).slice(0, 32) 兜底：
        //   · 1 字节密钥被空格补齐到 32 字节 → 有效熵只有 1 字节，属可爆破弱密钥
        //   · 48 字节密钥被静默截断到 32 字节 → 用户高估密钥熵值
        // 两者都只在事后审计密钥时才发现。这里构造时直接抛错。
        this._encryptKey = options.encryptKey || null;
        if (this._encryptKey !== null && this._encryptKey !== undefined) {
            const keyBytes = Buffer.byteLength(String(this._encryptKey), 'utf8');
            if (keyBytes !== 16 && keyBytes !== 24 && keyBytes !== 32) {
                const err = new Error(
                    `Invalid encryptKey length: ${keyBytes} bytes (expected 16, 24 or 32)`
                );
                err.code = 'ER_INVALID_KEY';
                err.errno = 1820;
                err.sqlState = 'HY000';
                throw err;
            }
        }
        this._versioning = options.versioning || false;
        this._versions = {};       // tableName -> [{ rows, timestamp }]
        this._maxVersions = options.maxVersions || 50;
        this._plugins = [];
        this._hooks = createHookRegistry();
        this._eventListeners = [];

        // P1: {modules:true} 自动加载插件（mod.config + ~/.jsql/plugins/）
        this._autoPlugins = options.modules !== false;
        if (this._autoPlugins) {
            this._loadAutoPlugins();
        }
        this._tableNames = new Set(Object.keys(this._tables));
        this._migrations = [];
        this._observers = [];      // 响应式观察者
        this._views = {};           // 视图 { name: { query, table } }
        this._triggers = {};        // 触发器 { name: { event, table, callback } }
        this._attached = {};        // 附加数据库 { name: db }
        this._changeStream = null; // 变更流

        // WAL（Write-Ahead Logging）：文件模式下默认开启，每次写入立即追加并 fsync，
        // 不再依赖「内存中改完、退出时 save()」的旧语义。
        if (this._memoryMode) this._walEnabled = false;
        else if (this._dirMode) this._walEnabled = options.wal === true;
        else if (this._encryptKey) this._walEnabled = options.wal === true; // WAL 为明文，加密库需显式开启
        else this._walEnabled = options.wal !== false;
        this._walPath = this._filePath ? this._filePath + '.wal' : null;
        this._walOps = [];          // WAL 操作日志（内存镜像）
        this._walFlushedCount = 0;  // 已落盘记录数（append-only 增量追加用）
        this._walError = null;      // #263：最近一次 WAL 落盘失败（供上层查询）
        // #260：目录模式的静态加密（与 legacy 单文件模式语义一致）。
        // _aesKey 是由用户密钥派生的 32 字节 AES-256 密钥。
        this._aesKey = this._encryptKey
            ? crypto.scryptSync(
                Buffer.from(String(this._encryptKey), 'utf8'),
                Buffer.from('jsql-neo-static-encryption-v1', 'utf8'),
                32)
            : null;
        this._walReplaying = false; // 回放中：抑制再次写日志
        this._walReplaySummary = null;
        this._metaCorrupt = null;   // #453：meta.json 损坏/兜底恢复的排障记录
        this._walOpCount = 0;       // 自上次检查点以来的操作数
        this._walCheckpointOps = options.walCheckpointOps !== undefined ? options.walCheckpointOps : 1000;
        this._walCheckpointScheduled = false;
        // 落盘策略：write() 立即执行（进程崩溃/ kill -9 安全），fsync 合并到时间窗口内批量执行。
        // 逐条 fsync 是此前单条写入只有 ~1k/s 的根因；合并后吞吐提升一个数量级，
        // 同时保留「已提交写入在进程崩溃后不丢」的承诺（掉电窗口外的数据仍在页缓存里）。
        this._walSyncInterval = options.walSyncInterval !== undefined ? Number(options.walSyncInterval) : 20;
        if (!(this._walSyncInterval >= 0)) this._walSyncInterval = 20;
        this._walFd = null;         // 常驻追加句柄（避免每次 open/close 的系统调用）
        this._walFdPath = null;     // 句柄绑定的路径（路径变化时需重开，不能写到旧 inode）
        this._walDirReady = false;  // 目录已确保存在（避免每次 existsSync）
        this._walNeedsSync = false; // 有已 write() 但尚未 fsync 的数据
        this._walSyncTimer = null;

        // 事务隔离：默认 READ_COMMITTED（每条语句读到最新已提交数据）；
        // 传 'REPEATABLE_READ' 则固定事务开始时的行快照。
        this._isolationLevel = options.isolationLevel || 'READ_COMMITTED';

        // JSql 格式 (binary block-based)
        this._jsqlMode = this._filePath && this._filePath.endsWith('.jsql');
        this._jsqlFormat = this._jsqlMode ? new JSQLFormat(this._filePath, this._encryptKey) : null;

        // 文件锁
        // #295：默认开启文件锁，避免两个实例静默互相覆盖
        this._fileLockEnabled = options.fileLock !== false && !this._memoryMode;
        this._lockFd = null;
        this._lockPath = this._filePath ? this._filePath + '.lock' : null;

        // 慢查询日志
        this._slowQueryThreshold = options.slowQueryThreshold !== undefined ? options.slowQueryThreshold : 100;
        this._slowQueries = [];

        // 从文件加载
        // 注意：即使数据文件不存在也要走 _load()，因为可能存在「上次崩溃前
        // 只写了 WAL、快照尚未落盘」的情况 —— 此时必须回放 WAL 才能恢复数据。
        // 旧实现在这里用 fs.existsSync 直接短路，导致新建库后崩溃丢数据。
        if (!this._memoryMode && !this._dirMode) {
            const hasDataFile = this._filePath ? fs.existsSync(this._filePath) : false;
            const hasWal = this._walEnabled && this._walPath && fs.existsSync(this._walPath);
            // #295：即使数据文件尚不存在也要先拿锁，否则两个新实例会同时写同一路径
            this._loading = true;
            this._acquireLock();
            try {
                if (hasDataFile || hasWal) this._load();
            } finally {
                this._loading = false;
            }
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
        // #449：目录模式同样要拿目录级文件锁（`<dir>.lock`），与 legacy 单文件模式一致；
        // 否则同目录两个实例可并存，后 flush 者用陈旧内存快照全量覆写，抹掉前者已提交行。
        // 崩溃残留锁按既有 30s 过期逻辑在 _acquireLock 内接管。
        this._acquireLock();
        fs.mkdirSync(this._filePath, { recursive: true });
        this._metaPath = path.join(this._filePath, 'meta.json');
        this._meta = { version: 1, tables: {} };
        try {
            if (fs.existsSync(this._metaPath)) {
                // #260：meta.json 在启用 encryptKey 时也是密文。
                // 格式：{"__enc":"v1","data":"<base64>"}；无密钥时按明文 JSON 读（兼容旧库）。
                const rawMeta = fs.readFileSync(this._metaPath, 'utf8');
                let parsed;
                let parseErr = null;
                try {
                    parsed = JSON.parse(rawMeta);
                } catch (e) {
                    parseErr = e;
                    parsed = null;
                }
                if (parsed && parsed.__enc === 'v1' && typeof parsed.data === 'string') {
                    if (!this._encryptKey) {
                        throw new Error('meta.json is encrypted but no encryptKey was provided');
                    }
                    const dec = crypto.createDecipheriv('aes-256-cbc', this._aesKey, Buffer.from(parsed.iv, 'base64'));
                    const plain = Buffer.concat([
                        dec.update(Buffer.from(parsed.data, 'base64')),
                        dec.final(),
                    ]).toString('utf8');
                    parsed = JSON.parse(plain);
                }
                // 明文 JSON 半写撕裂：解析失败必须走损坏兜底，不能静默落空注册表。
                if (parseErr) throw parseErr;
                if (parsed && parsed.tables) {
                    this._meta = parsed;
                    // 清洗 meta 中的 file 字段：拒绝绝对路径/.. 穿越，防恶意 meta.json 写任意位置
                    for (const name of Object.keys(this._meta.tables)) {
                        const meta = this._meta.tables[name];
                        if (meta && meta.file !== undefined) {
                            if (this._safeTableFile(meta.file) === null) {
                                delete this._meta.tables[name];
                            }
                        }
                    }
                }
            }
        } catch (e) {
            // #453：解析/解密失败不能静默清空注册表 —— 备份损坏文件、上报 error，
            // 并从目录下的 .jsql 文件重建表登记，避免数据块文件全部成孤儿。
            this._recoverMetaFromFiles(e);
        }
        for (const name of Object.keys(this._meta.tables)) {
            if (this[name] === undefined && !(name in this)) {
                Object.defineProperty(this, name, {
                    get: () => this._ensureTable(name) || this._tables[name],
                    enumerable: true,
                    configurable: true
                });
            }
        }
        // #259：目录模式（hybrid/disk）显式开启 wal:true 后，写入路径会往
        // `<dir>.wal` 追加并 fsync，但此前**从不回放** —— 只写不读，
        // 崩溃时尚未刷入 .jsql 的提交全部丢失。
        // 这里在启动时回放 WAL，把已 fsync 的提交恢复出来。
        if (this._walEnabled && this._walPath && fs.existsSync(this._walPath)) {
            try {
                this._recoverFromWAL();
            } catch (e) {
                // 回放失败不能静默：记录下来供 getWALInfo() 排障
                this._walReplaySummary = { replayed: 0, failed: 1, error: e.message, at: Date.now() };
                try { this._emit('error', e); } catch (_) { /* ignore */ }
            }
        }
        this._startMonitor();
    }

    _tableFile(name) {
        const meta = this._meta.tables[name];
        if (meta && meta.file) {
            const safe = this._safeTableFile(meta.file);
            if (safe) return path.join(this._filePath, safe);
        }
        return path.join(this._filePath, encodeURIComponent(name) + '.jsql');
    }

    _safeTableFile(file) {
        if (typeof file !== 'string' || file.length === 0) return null;
        if (path.isAbsolute(file)) return null;
        if (file.includes('/') || file.includes('\\')) return null;
        const base = path.basename(file);
        if (base !== file || base === '.' || base === '..') return null;
        if (file.includes('\0')) return null;
        return file;
    }

    _saveMeta() {
        if (!this._dirMode) return;
        try {
            let payload;
            // #260：启用 encryptKey 时 meta.json 也落密文（表结构/字段名不外泄）
            if (this._encryptKey) {
                const iv = crypto.randomBytes(16);
                const cipher = crypto.createCipheriv('aes-256-cbc', this._aesKey, iv);
                const enc = Buffer.concat([
                    cipher.update(JSON.stringify(this._meta, null, 2), 'utf8'),
                    cipher.final(),
                ]);
                payload = JSON.stringify({
                    __enc: 'v1',
                    iv: iv.toString('base64'),
                    data: enc.toString('base64'),
                });
            } else {
                payload = JSON.stringify(this._meta, null, 2);
            }
            // #453：与 _writeFile 一致的原子写 —— 先写临时文件 + fsync，再 rename
            // 覆盖；崩溃只会留下旧 meta 或新 meta，不会出现写到一半的半份注册表。
            const tmp = this._metaPath + '.tmp';
            const fd = fs.openSync(tmp, 'w');
            try {
                fs.writeFileSync(fd, payload, 'utf8');
                fs.fsyncSync(fd);
            } finally {
                fs.closeSync(fd);
            }
            fs.renameSync(tmp, this._metaPath);
        } catch (e) {
            // 忽略 meta 写入失败
        }
    }

    /**
     * #453：meta.json 解析/解密失败时的兜底。
     *
     * 此前 catch 直接把注册表重置为 `{version:1,tables:{}}` —— 表数据块
     * 文件还在，引擎却再也找不到表，全部变成孤儿文件，且无任何告警。
     * 这里：先备份损坏文件为 `meta.json.corrupt-<ts>`，再扫描目录下的
     * `.jsql` 文件重建登记，并通过 error 事件对外上报损坏原因。
     */
    _recoverMetaFromFiles(cause) {
        let backedUp = false;
        try {
            if (fs.existsSync(this._metaPath)) {
                const backup = this._metaPath + '.corrupt-' + Date.now();
                fs.copyFileSync(this._metaPath, backup);
                backedUp = true;
            }
        } catch (e) { /* 备份失败不阻断后续文件扫描 */ }
        this._meta = { version: 1, tables: {} };
        try {
            const files = fs.readdirSync(this._filePath);
            for (const file of files) {
                if (!file.endsWith('.jsql')) continue;
                if (!this._safeTableFile(file)) continue;
                const name = decodeURIComponent(file.slice(0, -5));
                this._meta.tables[name] = { file, schema: {} };
            }
        } catch (e) { /* 目录扫描失败：保持空注册表 */ }
        const reason = cause && cause.message ? cause.message : String(cause);
        const restored = Object.keys(this._meta.tables);
        const err = new Error(
            `meta.json is corrupt (${reason}); rebuilt registry from ${restored.length} table file(s)` +
            (backedUp ? '' : '; corrupt file backup unavailable')
        );
        err.code = 'ER_META_CORRUPT';
        this._metaCorrupt = { error: err.message, code: err.code, at: Date.now(), restored };
        try { this._emit('error', err); } catch (_) { /* 监听器自身抛错不阻塞启动 */ }
        console.error('[jsql-neo] ' + err.message);
    }

    /**
     * 统一的「表不可用」错误。
     *
     * #262：区分「表不存在」与「表文件损坏」。损坏的表文件加载失败后，
     * 若一律报 ER_NO_SUCH_TABLE，运维看到的是「表没了」，而 meta.json 里
     * 明明还登记着它 —— 极易被误判为「数据被删」。现在报 ER_TABLE_CORRUPT
     * 并带上原始原因。
     */
    _noSuchTable(name) {
        const corrupt = this._corruptTables && this._corruptTables[name];
        if (corrupt) {
            const err = new Error(corrupt.message);
            err.code = 'ER_TABLE_CORRUPT';
            err.errno = corrupt.errno || 1815;
            err.sqlState = 'HY000';
            err.cause = corrupt.cause;
            return err;
        }
        return createError('ER_NO_SUCH_TABLE', name);
    }

    _touchTable(name) {
        this._lastAccess[name] = Date.now();
    }

    _ensureTable(name) {
        if (this._tables[name]) return this._tables[name];
        if (!this._dirMode) return null;
        const meta = this._meta.tables[name];
        if (!meta) return null;
        const file = this._tableFile(name);
        if (!fs.existsSync(file)) return null;
        try {
            const fmt = new JSQLFormat(file, this._encryptKey);
            fmt._open();
            const table = new Table(name, meta.schema, this);
            // 行级懒加载：只在内存里保留 {block, off}，被访问的行才读盘。
            const locators = fmt.scanLocators(name);
            if (locators.length > 0) {
                table._loadRowRefs(locators, (block, off) => fmt.readRowAt(block, off), fmt);
            } else {
                table._loadRows([]);
                fmt._close();
            }
            if (typeof table._clearDirtyRows === 'function') table._clearDirtyRows();
            this._tables[name] = table;
            if (this._versioning) this._versions[name] = [];
            this._touchTable(name);
            return table;
        } catch (e) {
            // #262：加载失败不能静默吞掉。
            // 此前 catch 里直接 return null —— 表文件损坏时表「从查询中消失」，
            // 而 meta.json 仍登记着它，getTables()/hasTable() 报存在、
            // count()/find() 全报缺表，形成自相矛盾的「幽灵表」且无任何告警。
            // 现在：记录损坏状态、发出 error 事件，并让后续查询明确报出损坏原因。
            const err = new Error(
                `Table '${name}' failed to load from '${file}': ${e.message}`
            );
            err.code = 'ER_TABLE_CORRUPT';
            err.errno = 1815;
            err.sqlState = 'HY000';
            err.cause = e;
            this._corruptTables = this._corruptTables || {};
            this._corruptTables[name] = err;
            try { this._emit('error', err); } catch (_) { /* 监听器自身抛错不影响主流程 */ }
            return null;
        }
    }

    _markDirty(name) {
        // #181：SQL 写路径（updateById/removeByIds 等）不经过 Table.update/remove，
        // 统一在这里让列存派生缓存失效，避免后续 SELECT 读到旧快照。
        const table = name && this._tables ? this._tables[name] : null;
        if (table && typeof table._invalidateColumnar === 'function') table._invalidateColumnar();
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
                try { this._flushDirty(); } catch (e) { this._emit('error', e); }
            });
            return;
        }
        this._flushTimer = setTimeout(() => {
            this._flushTimer = null;
            try { this._flushDirty(); } catch (e) { this._emit('error', e); }
        }, this._flushInterval);
        if (this._flushTimer.unref) this._flushTimer.unref();
    }

    _flushDirty() {
        if (!this._dirMode || this._dirtyTables.size === 0) return;
        const names = [...this._dirtyTables];
        for (const name of names) {
            try {
                this._flushTableDelta(name);
                this._dirtyTables.delete(name);
            } catch (e) {
                // 保留脏标记，下次 flush 重试；错误对外传播而非静默
                this._emit('error', e);
            }
        }
        this._saveMeta();
    }

    /**
     * 行级刷盘：只把本表变更过的行追加到表文件，不再整表重写。
     * 无主键表、truncate、schema 变更、回滚等场景退化为全量重写。
     */
    _flushTableDelta(name) {
        const table = this._tables[name];
        if (!table) return;
        // live 大表首次达到阈值时走一次全量写，借机挂上行级 rowCache；
        // 之后 delta 写入会照常更新行定位符。
        if (this._dirMode && !table._rowCache && table._rows.length >= ROW_CACHE_MIN_ROWS) {
            this._flushTable(name);
            return;
        }
        const dirty = typeof table._peekDirtyRows === 'function'
            ? table._peekDirtyRows()
            : { all: true, upserts: [], deletes: [] };

        if (dirty.all) {
            this._flushTable(name);
            return;
        }
        if (dirty.upserts.length === 0 && dirty.deletes.length === 0) {
            table._clearDirtyRows();
            return;
        }

        const meta = this._meta.tables[name];
        const file = meta && meta.file ? meta.file : encodeURIComponent(name) + '.jsql';
        const fmt = new JSQLFormat(path.join(this._filePath, file), this._encryptKey);
        let appendBlocks = 0;
        try {
            const written = fmt.writeRows(name, table._persistedSchema(), dirty.upserts, dirty.deletes, table._primaryKey);
            appendBlocks = fmt.nBlocks;
            this._meta.tables[name] = { file, schema: table._persistedSchema() };
            if (typeof table._applyFlushedLocators === 'function') {
                if (written && written.length === dirty.upserts.length) {
                    table._applyFlushedLocators(dirty.upserts, written);
                } else {
                    // 退化成整表写入时行位置全部变化，重建定位符
                    table._resetRowLocators(fmt.scanLocators(name));
                }
            }
            table._clearDirtyRows();
        } finally {
            fmt._close();
        }

        // 空洞块过多时回收：阈值取「行数 2 倍 + 64」，超过则整表重写一次。
        if (appendBlocks > Math.max(64, table._rows.length * 2 + 64)) {
            this._flushTable(name);
        }
    }

    _flushTable(name) {
        const table = this._tables[name];
        if (!table) return;
        const meta = this._meta.tables[name];
        let file = meta && meta.file ? meta.file : encodeURIComponent(name) + '.jsql';
        const fmt = new JSQLFormat(path.join(this._filePath, file), this._encryptKey);
        let keepHandleOpen = false;
        try {
            const pkField = Object.keys(table._schema).find(f => table._schema[f].primaryKey) || null;
            fmt.writeTable(name, table._persistedSchema(), table._rows, pkField);
            this._meta.tables[name] = { file, schema: table._persistedSchema() };
            // live 大表首次全量写完后挂上行级 LRU，让后续内存淘汰按行回退。
            if (this._dirMode && !table._rowCache && table._rows.length >= ROW_CACHE_MIN_ROWS) {
                const locators = fmt.scanLocators(name);
                if (locators.length > 0) {
                    table._loadRowRefs(locators, (block, off) => fmt.readRowAt(block, off), fmt);
                    keepHandleOpen = true;
                }
            }
            // 整表重写改变了每一行的物理位置，用新文件的定位符重置缓存
            if (!keepHandleOpen && typeof table._resetRowLocators === 'function') {
                table._resetRowLocators(fmt.scanLocators(name));
            }
            if (typeof table._clearDirtyRows === 'function') table._clearDirtyRows();
        } finally {
            if (!keepHandleOpen) fmt._close();
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

        // 先做行级 LRU 淘汰：把冷行回退成磁盘定位符，表结构与索引保持不变。
        // 这一步只在两次同步操作之间触发（定时器回调），不会打断正在进行的查询。
        for (const name of candidates) {
            if (budget !== undefined && process.memoryUsage().rss <= budget) break;
            const table = this._tables[name];
            if (table && typeof table._evictRows === 'function' && table._rowCache) {
                table._evictRows(Infinity);
            }
        }

        // 仍超预算时才整表卸载。
        for (const name of candidates) {
            if (budget !== undefined && process.memoryUsage().rss <= budget) break;
            const table = this._tables[name];
            if (table && table._rowCache) continue;   // 行级淘汰已足够，保留表对象
            try { this._flushTableDelta(name); } catch (e) { continue; }
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
            // 原子创建锁文件：'wx' 模式在文件存在时立即抛错，无需 TOCTOU 两步检查
            this._lockFd = fs.openSync(this._lockPath, 'wx');
            fs.writeSync(this._lockFd, String(process.pid), null, 'utf8');
            fs.fsyncSync(this._lockFd);
        } catch (e) {
            if (e.code === 'EEXIST') {
                try {
                    const lockTime = fs.statSync(this._lockPath).mtimeMs;
                    if (Date.now() - lockTime > 30000) {
                        fs.unlinkSync(this._lockPath);
                        this._lockFd = fs.openSync(this._lockPath, 'wx');
                        fs.writeSync(this._lockFd, String(process.pid), null, 'utf8');
                        fs.fsyncSync(this._lockFd);
                        return;
                    }
                } catch (_) { /* ignore */ }
                throw createError('ER_LOCK_WAIT_TIMEOUT', 'Database is locked by another process');
            }
            // 权限不足等，降级为无锁模式
            this._fileLockEnabled = false;
            this._lockFd = null;
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
     *
     * 采用 append-only（每行一条 JSON）而非全量重写：
     * 全量重写会让日志写入本身成为 O(n²)，且中途崩溃会损坏整个日志文件。
     * append-only 下崩溃最多丢失最后一行（已 fsync 过的行不会丢）。
     */
    _walWrite(op) {
        if (!this._walEnabled || this._loading) return;
        // #446：活动事务内产生的写入打上事务标签，回放时按 commit 帧判定是否可见。
        if (op.tx === undefined) {
            const tag = this._currentTxTag();
            if (tag !== null) op.tx = tag;
        }
        const entry = {
            ...op,
            timestamp: Date.now(),
            sequence: this._walOps.length + 1
        };
        this._walOps.push(entry);
        this._walOpCount++;
        // 恢复过程中重放操作不能再次写 WAL，否则会无限增长
        if (this._walReplaying) return;
        this._flushWAL();
        this._maybeCheckpointWAL();
    }

    /**
     * 记录「写入后的行」：有主键时按主键幂等 upsert，无主键时退化为整表镜像。
     * 这样任何写入都立刻落到 WAL，崩溃后按序回放即可恢复。
     */
    _walLogUpsert(tableName, rows) {
        if (!this._walEnabled || this._walReplaying || this._loading) return;
        const t = this._tables[tableName];
        if (!t || !Array.isArray(rows) || rows.length === 0) return;
        if (t._primaryKey) {
            const pk = t._primaryKey;
            // 不复制行对象：WAL 在本次调用内同步序列化落盘，
            // 批量插入几十万行时浅拷贝本身就是一笔可观开销。
            const out = rows.filter(r => r && r[pk] !== undefined && r[pk] !== null);
            if (out.length === 0) return;
            this._walWrite({ op: 'upsertRows', table: tableName, pk, rows: out });
        } else {
            // 无主键表此前退化成「每次批量插入都写整表镜像」——100 万行会写出几百 MB 的 O(n²) 日志。
            // 改为只追加本批新增行（append-only），回放时顺序 push 即可。
            this._walWrite({ op: 'insert', table: tableName, rows });
        }
    }

    /** 记录删除：有主键时只记主键列表，无主键时记录整表镜像。 */
    _walLogRemove(tableName, removedRows) {
        if (!this._walEnabled || this._walReplaying || this._loading) return;
        const t = this._tables[tableName];
        if (!t) return;
        if (t._primaryKey && Array.isArray(removedRows) && removedRows.length) {
            const pk = t._primaryKey;
            const ids = removedRows.map(r => r && r[pk]).filter(v => v !== undefined && v !== null);
            if (ids.length) {
                this._walWrite({ op: 'removeRows', table: tableName, pk, ids });
                return;
            }
        }
        this._walLogReplaceTable(tableName);
    }

    /** 无主键表 / truncate / 结构变化：写入该表的完整行镜像。 */
    _walLogReplaceTable(tableName) {
        if (!this._walEnabled || this._walReplaying || this._loading) return;
        const t = this._tables[tableName];
        if (!t) return;
        this._walWrite({ op: 'replaceTable', table: tableName, rows: t._rows });
    }

    /**
     * WAL 增长到阈值后自动做一次快照检查点，避免日志无限膨胀。
     * 事务进行中不检查点，否则未提交的数据会进入快照。
     */
    _maybeCheckpointWAL() {
        if (!this._walEnabled || this._walCheckpointScheduled) return;
        if (this._walCheckpointOps <= 0 || this._walOpCount < this._walCheckpointOps) return;
        if (this._loading || this._walReplaying || this.hasActiveTx()) return;
        this._walCheckpointScheduled = true;
        const run = () => {
            this._walCheckpointScheduled = false;
            if (this._loading || this._walReplaying || this.hasActiveTx()) return;
            try {
                this.save();
            } catch (e) {
                // 快照失败时保留 WAL，数据仍可恢复
            }
        };
        if (typeof setImmediate === 'function') setImmediate(run);
        else setTimeout(run, 0);
    }

    /**
     * 将新增的 WAL 记录追加到磁盘（append-only）
     *
     * 性能设计（此前单条写入 ~1k/s 的根因）：
     *   1. 常驻追加句柄 —— 不再每次 open()/close()
     *   2. 一次 write() 批量写出所有待落盘记录（批次内 JSONL 拼接）
     *   3. fsync 合并到 walSyncInterval 时间窗口 —— write() 已完成，进程崩溃不丢；
     *      只是把「每条一次磁盘刷写」摊薄成「窗口内一次」
     */
    _flushWAL() {
        if (!this._walEnabled || !this._walPath || this._walOps.length === 0) return;
        // 只追加尚未落盘的记录
        const pending = this._walOps.slice(this._walFlushedCount);
        if (pending.length === 0) return;
        try {
            // 路径变化（或句柄已失效）时必须重开：否则会继续写旧 inode。
            if (this._walFd !== null && this._walFdPath !== this._walPath) this._walCloseFd();
            if (!this._walDirReady) {
                const dir = path.dirname(this._walPath);
                if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
                this._walDirReady = true;
            }
            let payload = '';
            for (let i = 0; i < pending.length; i++) {
                payload += bigintJson.stringify(pending[i]) + '\n';
            }
            if (this._walFd === null) {
                this._walFd = fs.openSync(this._walPath, 'a');
                this._walFdPath = this._walPath;
            }
            const buf = Buffer.from(payload, 'utf8');
            let offset = 0;
            while (offset < buf.length) {
                offset += fs.writeSync(this._walFd, buf, offset, buf.length - offset);
            }
            this._walFlushedCount = this._walOps.length;
            this._walError = null;
            this._walNeedsSync = true;
            this._scheduleWALSync();
        } catch (e) {
            // #263：WAL 追加失败不能静默吞掉。
            // WAL 是崩溃安全的前提（README 承诺「kill -9 不会丢已提交的写入」）：
            // 磁盘满 / 权限不足 / inode 耗尽时若继续返回成功，
            // 进程崩溃后这批提交就彻底丢失，且事后没有任何线索。
            // 现在至少通过 error 事件暴露出来（与 _flushDirty 的处理一致），
            // 并记入 _walError 供上层查询。
            this._walError = e;
            this._walCloseFd();
            try { this._emit('error', e); } catch (_) { /* 事件监听器自身抛错不影响主流程 */ }
        }
    }

    /**
     * 按 walSyncInterval 合并 fsync：
     *   - 0   → 立即同步（最严格，等价旧行为）
     *   - >0  → 窗口内只 fsync 一次；窗口内已 write() 的记录在进程崩溃后仍可从页缓存恢复
     */
    _scheduleWALSync() {
        if (!this._walNeedsSync) return;
        if (this._walSyncInterval <= 0) {
            this._syncWAL();
            return;
        }
        if (this._walSyncTimer) return;
        this._walSyncTimer = setTimeout(() => {
            this._walSyncTimer = null;
            this._syncWAL();
        }, this._walSyncInterval);
        // 不能让合并窗口的定时器把进程挂住
        if (this._walSyncTimer && this._walSyncTimer.unref) this._walSyncTimer.unref();
    }

    /** 立即 fsync 尚未落盘刷写的 WAL 数据（幂等）。 */
    _syncWAL() {
        if (!this._walNeedsSync) return;
        if (this._walFd === null) { this._walNeedsSync = false; return; }
        try {
            fs.fsyncSync(this._walFd);
            this._walNeedsSync = false;
        } catch (e) {
            this._walError = e;
            try { this._emit('error', e); } catch (_) { /* ignore */ }
        }
    }

    /** 关闭常驻 WAL 句柄：先补齐 fsync，再关句柄并复位状态。 */
    _walCloseFd() {
        if (this._walSyncTimer) {
            clearTimeout(this._walSyncTimer);
            this._walSyncTimer = null;
        }
        this._syncWAL();
        if (this._walFd !== null) {
            try { fs.closeSync(this._walFd); } catch (e) { /* 已关闭 / 句柄失效 */ }
            this._walFd = null;
            this._walFdPath = null;
        }
        this._walDirReady = false;
    }

    /**
     * 检查点：数据已由 save() 完整落盘，清空 WAL
     *
     * 只在 save() 成功写完快照之后调用。若快照写入失败则不检查点，
     * 保证 WAL 里的记录仍可用于恢复。
     */
    _checkpoint() {
        if (!this._walEnabled) return;
        // 必须先把常驻句柄里的数据 fsync 并关闭，否则 unlink 后该句柄
        // 仍持有旧 inode，后续写入会落到一个「已被删除」的文件里而静默丢失。
        this._walCloseFd();
        this._walOps = [];
        this._walFlushedCount = 0;
        this._walOpCount = 0;
        try {
            if (this._walPath && fs.existsSync(this._walPath)) {
                fs.unlinkSync(this._walPath);
            }
        } catch (e) {
            // 忽略
        }
    }

    /**
     * 崩溃恢复：重放 WAL 中尚未被快照覆盖的操作
     *
     * 历史问题（6.3.3 及以前）：本函数直接 `fs.unlinkSync` 删除 WAL，
     * 完全没有回放，导致「WAL / 崩溃恢复」是虚假宣传 —— 实测开启 wal:true
     * 后 kill -9 丢数据，重开连表都不存在。现在真正回放。
     *
     * 日志格式为 append-only JSONL；最后一行可能在崩溃时写半，
     * 因此解析时逐行 try/catch，坏行直接丢弃（它必然是未完成的那条）。
     */
    /**
     * #237：快照损坏时 WAL 里可能只有行数据、没有建表记录。
     * 从行值推断一个最小 schema，让 WAL 能重放而不是因「表不存在」全部失败。
     */
    _inferWalSchema(rows) {
        const defs = {};
        for (const row of rows || []) {
            if (!row || typeof row !== 'object') continue;
            for (const [field, value] of Object.entries(row)) {
                if (value === null || value === undefined || defs[field]) continue;
                let type = 'string';
                if (typeof value === 'number') type = Number.isInteger(value) ? 'integer' : 'number';
                else if (typeof value === 'boolean') type = 'boolean';
                else if (Array.isArray(value)) type = 'array';
                else if (typeof value === 'object') type = 'object';
                defs[field] = { type };
            }
        }
        return defs;
    }

    /**
     * WAL 回放时定位目标表（#259）。
     *
     * 目录模式（hybrid/disk）的表是**懒加载**的：meta.json 里登记了表名，
     * 但 `this._tables` 里要等第一次访问才通过 _ensureTable 加载。
     * 回放直接取 `this._tables[op.table]` 会拿到 undefined，
     * 于是 WAL 里的行被写进一个凭空新建的空表（原表数据被覆盖）。
     * 这里统一走 _ensureTable，把已存在的表真正加载出来。
     */
    _walTargetTable(name) {
        if (!name) return null;
        if (this._tables[name]) return this._tables[name];
        if (this._dirMode && this._meta && this._meta.tables && this._meta.tables[name]) {
            const loaded = this._ensureTable(name);
            if (loaded) return loaded;
        }
        return null;
    }

    _recoverFromWAL() {
        if (!this._walEnabled || !this._walPath || !fs.existsSync(this._walPath)) return;

        let raw;
        try {
            raw = fs.readFileSync(this._walPath, 'utf8');
        } catch (e) {
            return;
        }
        if (!raw || !raw.trim()) {
            this._checkpoint();
            return;
        }

        // 兼容 6.3.3 及以前的旧格式：整个 WAL 是一个 JSON 数组（单行）。
        // 6.3.4 起改为 append-only JSONL（每行一条）。此处按形状识别并归一化，
        // 否则升级后用户遗留的旧 WAL 会被静默丢弃。
        let ops = [];
        const trimmed = raw.trim();
        if (trimmed.startsWith('[')) {
            try {
                const parsed = bigintJson.parse(trimmed);
                if (Array.isArray(parsed)) {
                    ops = parsed.filter(o => o && typeof o.op === 'string');
                }
            } catch (e) {
                // 落到下面的 JSONL 解析
            }
        }
        if (ops.length === 0) {
            for (const line of raw.split('\n')) {
                const t = line.trim();
                if (!t) continue;
                try {
                    const o = bigintJson.parse(t);
                    if (o && typeof o.op === 'string') ops.push(o);
                } catch (e) {
                    // 崩溃时写半的尾行，丢弃
                }
            }
        }
        if (ops.length === 0) {
            this._checkpoint();
            return;
        }

        this._walReplaying = true;
        let replayed = 0, failed = 0;
        // #446：按事务帧聚合回放。先扫描出所有带 commit 帧的事务标签；
        // 缺少 commit 帧（崩溃时未闭合）的事务，其行变更在恢复时整体丢弃，
        // 保证 kill -9 后未提交的脏写不会随 WAL 回放复活。
        const committedTx = new Set();
        for (const op of ops) {
            if (op.op === 'commit' && op.tx !== undefined && op.tx !== null) {
                committedTx.add(String(op.tx));
            }
        }
        const TX_MARKERS = new Set(['begin', 'commit', 'rollback', 'rollbackTo', 'savepoint', 'undo', 'restore', 'import']);
        const DATA_OPS = new Set(['insert', 'update', 'remove', 'upsertRows', 'removeRows', 'replaceTable']);
        try {
            // 逐条按 sequence 顺序回放，保证 insert→update→remove 的相对次序。
            // insert 不走 _loadRows()（那是整体替换语义），而是直接 push 到 _rows，
            // 再在末尾统一重建索引；否则逐条回放会互相覆盖。
            const touched = new Set();
            // 回放热路径：按表缓存 pk -> 行下标，避免逐行 findIndex 造成 O(n²)。
            // 一次 20 万行的批量 upsert 回放在旧实现里会退化成 400 亿次比较（几乎等于挂死）。
            const replayIdx = new Map(); // table -> Map(pkField -> Map(pkKey -> rowIndex))
            const pkKeyOf = (v) => typeof v + ':' + String(v);
            const idxMapOf = (t, pkField) => {
                let byField = replayIdx.get(t);
                if (!byField) { byField = new Map(); replayIdx.set(t, byField); }
                let m = byField.get(pkField);
                if (!m) {
                    m = new Map();
                    for (let i = 0; i < t._rows.length; i++) {
                        const row = t._rows[i];
                        if (row && row[pkField] !== undefined && row[pkField] !== null) {
                            m.set(pkKeyOf(row[pkField]), i);
                        }
                    }
                    byField.set(pkField, m);
                }
                return m;
            };
            const invalidateIdx = (t) => { replayIdx.delete(t); };
            for (const op of ops) {
                try {
                    // 事务标记帧本身不改数据状态，回放时跳过。
                    if (TX_MARKERS.has(op.op)) continue;
                    // 未闭合事务的行变更：整批丢弃，不落可见行。
                    if (DATA_OPS.has(op.op) && op.tx !== undefined && op.tx !== null
                        && !committedTx.has(String(op.tx))) continue;
                    switch (op.op) {
                        case 'insert': {
                            // #259：目录模式下表是懒加载的（_tables 里可能还没有），
                            // 回放前必须先把它加载出来，否则 WAL 里的行会落到一个
                            // 凭空新建的空表上。
                            let t = op.table && this._walTargetTable(op.table);
                            if (!t && op.table && Array.isArray(op.rows) && op.rows.length > 0) {
                                this._createTableSync(op.table, this._inferWalSchema(op.rows));
                                t = this._tables[op.table];
                            }
                            if (!t || !Array.isArray(op.rows) || op.rows.length === 0) { failed++; break; }
                            const pk = t._primaryKey;
                            const idm = pk ? idxMapOf(t, pk) : null;
                            for (const __e of op.rows) {
                                if (!__e) continue;
                                // 幂等：快照已包含该行时覆盖而不是重复插入
                                if (idm && __e[pk] !== undefined && __e[pk] !== null) {
                                    const k = pkKeyOf(__e[pk]);
                                    const ai = idm.get(k);
                                    if (ai !== undefined) { t._rows[ai] = __e; continue; }
                                    idm.set(k, t._rows.length);
                                }
                                t._rows.push(__e);
                            }
                            touched.add(t);
                            replayed++;
                            break;
                        }
                        case 'upsertRows': {
                            // #259：同上 —— 目录模式先加载已存在的表
                            let t = op.table && this._walTargetTable(op.table);
                            if (!t && op.table && Array.isArray(op.rows) && op.rows.length > 0) {
                                this._createTableSync(op.table, this._inferWalSchema(op.rows));
                                t = this._tables[op.table];
                            }
                            if (!t || !op.pk || !Array.isArray(op.rows)) { failed++; break; }
                            const idm = idxMapOf(t, op.pk);
                            for (const __r of op.rows) {
                                if (!__r || typeof __r !== 'object') continue;
                                const k = pkKeyOf(__r[op.pk]);
                                const ai = idm.get(k);
                                if (ai !== undefined) {
                                    t._rows[ai] = { ...__r };
                                } else {
                                    idm.set(k, t._rows.length);
                                    t._rows.push({ ...__r });
                                }
                            }
                            touched.add(t);
                            replayed++;
                            break;
                        }
                        case 'removeRows': {
                            const t = op.table && this._walTargetTable(op.table);
                            if (!t || !op.pk || !Array.isArray(op.ids)) { failed++; break; }
                            const gone = new Set(op.ids.map(String));
                            t._rows = t._rows.filter(r => !r || !gone.has(String(r[op.pk])));
                            invalidateIdx(t);
                            touched.add(t);
                            replayed++;
                            break;
                        }
                        case 'replaceTable': {
                            let t = op.table && this._walTargetTable(op.table);
                            if (!t && op.table && Array.isArray(op.rows) && op.rows.length > 0) {
                                this._createTableSync(op.table, this._inferWalSchema(op.rows));
                                t = this._tables[op.table];
                            }
                            if (!t || !Array.isArray(op.rows)) { failed++; break; }
                            t._rows = op.rows.map(r => ({ ...r }));
                            invalidateIdx(t);
                            touched.add(t);
                            replayed++;
                            break;
                        }
                        case 'update': {
                            const t = this._walTargetTable(op.table);
                            if (!t || !op.pk || op.row === undefined) { failed++; break; }
                            const cur = t._rows.find(r => r[op.pk] === op.id);
                            if (!cur) { failed++; break; }
                            Object.assign(cur, op.row);
                            touched.add(t);
                            replayed++;
                            break;
                        }
                        case 'remove': {
                            const t = this._walTargetTable(op.table);
                            if (!t || !op.pk) { failed++; break; }
                            const before = t._rows.length;
                            t._rows = t._rows.filter(r => r[op.pk] !== op.id);
                            invalidateIdx(t);
                            if (t._rows.length === before) { failed++; break; }
                            touched.add(t);
                            replayed++;
                            break;
                        }
                        default:
                            if (this._replayWalOp(op)) replayed++;
                            else failed++;
                    }
                } catch (e) {
                    failed++;
                }
            }
            // 重建受影响表的索引与自增计数
            for (const t of touched) {
                if (typeof t._rebuildPKIndex === 'function') t._rebuildPKIndex();
                if (typeof t._rebuildAllBTrees === 'function') t._rebuildAllBTrees();
                for (const field of Object.keys(t._indexes || {})) t.createIndex(field);
                if (typeof t._markAllRowsDirty === 'function') t._markAllRowsDirty();
                if (t._autoIncrementField) {
                    for (const row of t._rows) {
                        const v = row[t._autoIncrementField];
                        if (typeof v === 'number' && v > t._autoIncrement) t._autoIncrement = v;
                    }
                }
            }
        } finally {
            this._walReplaying = false;
        }

        // 记录回放结果供 getWALInfo() / 排障使用，不打断启动流程
        if (replayed > 0 || failed > 0) {
            this._walReplaySummary = { replayed, failed, at: Date.now() };
        }

        // 回放后的状态已合并进内存。
        // 必须立即落盘做检查点：否则 WAL 一清空，这批数据就只存在于内存，
        // 下次崩溃又要「没有快照 + 没有 WAL」而彻底丢失。
        // 这也是 WAL 的标准语义：recovery 之后必须 checkpoint。
        if (replayed > 0) {
            try {
                this._walCheckpointPending = true;
                this.save();
            } catch (e) {
                // 落盘失败：保留 WAL 以便下次启动重试
                this._walOps = ops;
                this._walFlushedCount = 0;
                this._walCheckpointPending = false;
                this._walReplaySummary = {
                    replayed, failed, at: Date.now(),
                    checkpointFailed: true, error: e.message
                };
                return;
            }
        }

        // save() 内部已调用 _checkpoint()，此处无需重复。
    }

    /**
     * 回放单条 WAL 记录
     * @returns {boolean} 是否成功应用
     */
    _replayWalOp(op) {
        switch (op.op) {
            case 'createTable':
                // #259：目录模式下的两种情形：
                //  a) 表文件已落盘 → 懒加载表对象即可（_walTargetTable）
                //  b) meta.json 已登记但 .jsql 未落盘（崩溃发生在首次刷盘前）
                //     → 需要按 WAL 里的 schema 重建表，否则行数据无处安放。
                //     _createTableSync 会因「meta 里已登记」抛 ER_TABLE_EXISTS_ERROR，
                //     这里先清掉那条陈旧的 meta 登记再重建。
                if (op.table && !this._tables[op.table]) {
                    const existing = this._walTargetTable(op.table);
                    if (!existing) {
                        if (this._dirMode && this._meta && this._meta.tables
                            && this._meta.tables[op.table]
                            && !fs.existsSync(this._tableFile(op.table))) {
                            delete this._meta.tables[op.table];
                        }
                        this._createTableSync(op.table, op.schema || {});
                    }
                }
                return true;

            case 'dropTable':
                if (op.table && this._tables[op.table]) {
                    this._dropTableSync(op.table);
                }
                return true;

            case 'renameTable':
                // 重命名也要能回放：否则崩溃恢复后表名会退回去，
                // 而后续的 insert/update 记录全都打在新名字上，全部丢失。
                if (op.from && op.to && this._tables[op.from] && !this._tables[op.to]) {
                    // renameTable 是 async 的（内部 await _runHooks），而本回放路径
                    // 是同步的，没法 await。**注意不能把 promise 直接 return** ——
                    // `if (promise)` 恒为真，失败会被当成成功。
                    // 这里同步发起并接住 rejection，避免未处理的 Promise 拒绝
                    // 把进程打崩；真失败了会体现在后续按新表名的记录上。
                    Promise.resolve(this.renameTable(op.from, op.to)).catch(() => {});
                }
                return true;

            case 'insert':
            case 'update':
            case 'remove':
            case 'upsertRows':
            case 'removeRows':
            case 'replaceTable':
                // 数据类操作由 _recoverFromWAL 按序直接处理（需维护表内行序），
                // 不走这里。
                return false;

            // 事务标记：begin/commit/rollback/undo 本身不改数据状态，
            // 记录它们是为了可观测性；回放时跳过。
            case 'begin':
            case 'commit':
            case 'rollback':
            case 'rollbackTo':
            case 'savepoint':
            case 'undo':
            case 'restore':
            case 'import':
                return true;

            default:
                return false;
        }
    }

    // ============================================================
    // 表管理
    // ============================================================

    _createTableSync(name, schema) {
        if (this._tables[name] || (this._dirMode && this._meta.tables[name])) {
            throw createError('ER_TABLE_EXISTS_ERROR', name);
        }
        const normalized = {};
        for (const [field, def] of Object.entries(schema || {})) {
            if (typeof def === 'string') normalized[field] = parseFieldShorthand(def.toLowerCase());
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
        return table;
    }

    async createTable(name, schema) {
        if (!name || name.length > 64 || name === '.' || name === '..' || /[\x00-\x1f/\\]|\.\./.test(name)) {
            throw createError('ER_BAD_TABLE_NAME', name);
        }
        if (typeof schema === 'string') {
            const parsed = {};
            for (const seg of schema.split(',')) {
                const trimmed = seg.trim();
                if (!trimmed) continue;
                const parts = trimmed.split(/\s+/);
                const field = parts.shift();
                parsed[field] = parts.join(' ').toLowerCase().trim() || 'string';
            }
            schema = parsed;
        }
        if (!(await this._runHooks('beforeCreateTable', [name, schema]))) throw createError('ER_PLUGIN_ABORT', 'createTable aborted by plugin');
        const table = this._createTableSync(name, schema);
        await this._runHooks('afterCreateTable', [name, schema]);
        return table;
    }

    _dropTableSync(name) {
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
    }

    async dropTable(name) {
        if (!this._tables[name] && !(this._dirMode && this._meta.tables[name])) throw createError('ER_NO_SUCH_TABLE', name);
        // #200：被外键引用且存在引用行时禁止删除父表
        if (this._foreignReferencingRows(name).length > 0) {
            throw createError('ER_ROW_IS_REFERENCED_2', name);
        }
        if (!(await this._runHooks('beforeDropTable', [name]))) return;
        this._dropTableSync(name);
        await this._runHooks('afterDropTable', [name]);
    }

    /**
     * 表改名后重写所有子表的外键引用（Issue #246）。
     * 把 fk.table 从旧表名改成新表名，并同步 _indexRegistry 里的登记。
     */
    _rewriteViewTableRefs(oldName, newName) {
        const oldLower = String(oldName).toLowerCase();
        const walk = (node) => {
            if (!node || typeof node !== 'object') return false;
            let changed = false;
            if (Array.isArray(node)) {
                for (const item of node) if (walk(item)) changed = true;
                return changed;
            }
            for (const key of Object.keys(node)) {
                const val = node[key];
                if (key === 'table' && typeof val === 'string' && val.toLowerCase() === oldLower) {
                    node[key] = newName;
                    changed = true;
                } else if (walk(val)) {
                    changed = true;
                }
            }
            return changed;
        };
        if (!this._views) return;
        for (const view of Object.values(this._views)) {
            if (view && view.select) walk(view.select);
        }
    }

    _rewriteForeignKeyRefs(oldName, newName) {
        const oldKey = String(oldName).toLowerCase();
        for (const table of Object.values(this._tables)) {
            if (!table || !Array.isArray(table._foreignKeys)) continue;
            for (const fk of table._foreignKeys) {
                if (String(fk.table).toLowerCase() === oldKey) {
                    fk.table = newName;
                }
            }
        }
    }

    /**
     * 找出所有引用指定父表的子表外键，且子表中至少有一行非空引用值。
     * 用于 DROP TABLE / TRUNCATE 的引用完整性检查。
     */
    _foreignReferencingRows(parentName) {
        const target = String(parentName).toLowerCase();
        const refs = [];
        for (const [childName, table] of Object.entries(this._tables)) {
            for (const fk of (table._foreignKeys || [])) {
                if (String(fk.table).toLowerCase() !== target) continue;
                const hasRow = table._rows.some(r => r[fk.field] !== undefined && r[fk.field] !== null);
                if (hasRow) refs.push({ child: childName, field: fk.field });
            }
        }
        return refs;
    }

    /**
     * 重命名表。
     *
     * 单独写成引擎方法而不是在 SQL 层拼：表名不只存在 _tables 里 ——
     * _tableNames、db.<表名> 这个取值属性、_versions、_meta.tables（目录模式）
     * 各自都存了一份。漏掉任何一个都会留下一张「半改名」的表：
     * 查得到数据却列不出来，或者反过来。
     */
    async renameTable(oldName, newName, { ifExists = false } = {}) {
        if (oldName === newName) {
            if (!this._tables[oldName]) {
                if (ifExists) return false;
                throw createError('ER_NO_SUCH_TABLE', oldName);
            }
            return true;   // 改成同名 = 无事发生，不算错
        }
        if (!this._tables[oldName]) {
            if (ifExists) return false;
            throw createError('ER_NO_SUCH_TABLE', oldName);
        }
        if (this._tables[newName] || (this._dirMode && this._meta.tables[newName])) {
            throw createError('ER_TABLE_EXISTS_ERROR', newName);
        }
        if (!newName || newName.length > 64 || newName === '.' || newName === '..' ||
            /[\x00-\x1f/\\]|\.\./.test(newName)) {
            throw createError('ER_BAD_TABLE_NAME', newName);
        }
        if (!(await this._runHooks('beforeRenameTable', [oldName, newName]))) return false;

        const table = this._tables[oldName];

        // 目录模式：先把物理文件挪过去。放在改动内存状态之前 ——
        // 文件挪失败就整体放弃，不会留下内存与磁盘不一致的状态。
        if (this._dirMode && this._meta.tables[oldName]) {
            const meta = this._meta.tables[oldName];
            const oldFile = meta.file;
            const newFile = encodeURIComponent(newName) + '.jsql';
            if (oldFile && oldFile !== newFile) {
                const from = path.join(this._filePath, oldFile);
                const to = path.join(this._filePath, newFile);
                if (fs.existsSync(from)) {
                    try { fs.renameSync(from, to); }
                    catch (e) { throw createError('ER_FILE_NOT_FOUND', `${oldFile} → ${newFile}: ${e.message}`); }
                }
                meta.file = newFile;
            }
        }

        delete this._tables[oldName];
        table._name = newName;
        this._tables[newName] = table;

        // #246：改名后必须同步重写所有子表的外键引用。
        // 此前只改 _tables 的键，子表 _foreignKeys 里的 fk.table 仍是旧名 →
        // 悬空引用让外键校验与 ON DELETE CASCADE 全部静默失效：
        // 坏引用能写进表，删父行也不级联。
        // MySQL 8.0 的 RENAME TABLE 同样会更新数据字典里的外键引用。
        this._rewriteForeignKeyRefs(oldName, newName);

        // #385：视图 AST 里快照了建视图时的基表名，RENAME TABLE 不重写 → 视图悬空。
        this._rewriteViewTableRefs(oldName, newName);

        // #358：CREATE INDEX 时按索引名登记了 索引名 → { table, columns }。
        // RENAME TABLE 只改 _tables 键，登记表还指旧名 → 之后无条件 DROP INDEX
        // 按名反查不到表，索引删不掉且登记项残留。
        if (this._indexRegistry && typeof this._indexRegistry.forEach === 'function') {
            for (const entry of this._indexRegistry.values()) {
                if (entry && String(entry.table).toLowerCase() === String(oldName).toLowerCase()) entry.table = newName;
            }
        }

        this._tableNames.delete(oldName);
        this._tableNames.add(newName);

        delete this[oldName];
        Object.defineProperty(this, newName, {
            get: () => this._ensureTable(newName) || this._tables[newName],
            enumerable: true,
            configurable: true
        });

        if (this._versioning && this._versions[oldName]) {
            this._versions[newName] = this._versions[oldName];
            delete this._versions[oldName];
        }
        if (this._dirMode && this._meta.tables[oldName]) {
            const meta = this._meta.tables[oldName];
            delete this._meta.tables[oldName];
            this._meta.tables[newName] = meta;
            this._dirtyTables.delete(oldName);
            this._dirtyTables.add(newName);
            this._saveMeta();
        }

        this._dirtyTables.delete(oldName);
        this._markDirty(newName);
        this._walWrite({ op: 'renameTable', from: oldName, to: newName });
        this._emit('renameTable', { from: oldName, to: newName });
        await this._runHooks('afterRenameTable', [oldName, newName]);
        return true;
    }

    hasTable(name) {
        // #262：损坏的表不再报告为「存在」—— 否则 meta 说在、查询说缺表，
        // 两种状态互相矛盾且没有任何告警。
        if (this._corruptTables && this._corruptTables[name]) return false;
        if (this._tables[name]) return true;
        if (!this._dirMode || !this._meta.tables[name]) return false;
        // 主动探测：首次访问前损坏状态还没记录，这里触发一次加载判定
        this._ensureTable(name);
        return !(this._corruptTables && this._corruptTables[name]);
    }

    getTables() {
        const names = new Set(Object.keys(this._tables));
        if (this._dirMode) {
            for (const name of Object.keys(this._meta.tables)) {
                // #262：跳过已确认损坏的表，避免列出「查不到」的幽灵表
                if (this._corruptTables && this._corruptTables[name]) continue;
                // 主动探测损坏状态，保证 getTables 与实际可查询状态一致
                this._ensureTable(name);
                if (this._corruptTables && this._corruptTables[name]) continue;
                names.add(name);
            }
        }
        return [...names];
    }

    /**
     * 列出损坏的表及其原因（#262）。
     * @returns {Object<string, Error>} tableName -> 加载错误
     */
    getCorruptTables() {
        return { ...(this._corruptTables || {}) };
    }

    /** #453：meta.json 损坏后兜底恢复的排障记录（未损坏时为 null）。 */
    getMetaCorruption() {
        return this._metaCorrupt ? { ...this._metaCorrupt } : null;
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
        if (!table) throw this._noSuchTable(tableName);

        const delimiter = options.delimiter || ',';
        const hasHeader = options.hasHeader !== false;
        const skipRows = options.skipRows || 0;
        const mapping = options.mapping || null;
        // #455：strict 模式下不可解析的类型值直接抛错；默认降级为 warnings 并跳过该行，
        // 不再把非数值整数静默置 0、非真值布尔静默置 false。
        const strict = options.strict === true;

        const content = fs.readFileSync(filePath, 'utf8');
        // #184：RFC 4180 允许引号字段内出现换行，不能先按行切分
        const records = this._parseCSV(content, delimiter);

        let headers = [];
        let startRow = 0;

        if (hasHeader) {
            headers = records[0] || [];
            startRow = 1 + skipRows;
        } else {
            startRow = skipRows;
        }

        const warnings = [];
        let count = 0;
        for (let i = startRow; i < records.length; i++) {
            const values = records[i];
            if (values.length === 0) continue;

            const data = {};
            const castCtx = { warnings, row: i };
            if (mapping) {
                for (const [csvCol, schemaCol] of Object.entries(mapping)) {
                    const idx = hasHeader ? headers.indexOf(csvCol) : parseInt(csvCol);
                    if (idx >= 0 && idx < values.length) {
                        data[schemaCol] = this._castValue(values[idx], table._schema[schemaCol], { ...castCtx, field: schemaCol });
                    }
                }
            } else if (hasHeader) {
                for (let j = 0; j < headers.length; j++) {
                    if (j < values.length && table._schema[headers[j]]) {
                        data[headers[j]] = this._castValue(values[j], table._schema[headers[j]], { ...castCtx, field: headers[j] });
                    }
                }
            }

            if (Object.keys(data).length > 0) {
                try {
                    table.insert(data);
                    count++;
                } catch (e) {
                    if (strict) throw e;
                    warnings.push({
                        row: i,
                        code: e.code || e.errno || 'ER_TRUNCATED_WRONG_VALUE',
                        message: e.message,
                    });
                }
            }
        }

        // 与 migrate 路径一致：返回 { count, warnings }，告警随结果带回上层
        return { count, warnings };
    }

    /**
     * 导出表数据到 CSV 文件
     */
    exportCSV(filePath, tableName, query = {}, options = {}) {
        const table = this._ensureTable(tableName);
        if (!table) throw this._noSuchTable(tableName);

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

    /**
     * RFC 4180 解析：引号内的 CR/LF、逗号和双引号都是数据；
     * 非引号字段保留首尾空格（原实现会 trim，破坏有意义的数据）。
     */
    _parseCSV(text, delimiter) {
        const records = [];
        let record = [];
        let field = '';
        let fieldStarted = false;
        let inQuotes = false;
        const s = String(text).replace(/^\uFEFF/, '');

        const pushField = () => {
            record.push(field);
            field = '';
            fieldStarted = false;
        };
        const pushRecord = () => {
            pushField();
            records.push(record);
            record = [];
        };

        for (let i = 0; i < s.length; i++) {
            const ch = s[i];
            if (inQuotes) {
                if (ch === '"') {
                    if (s[i + 1] === '"') { field += '"'; i++; }
                    else inQuotes = false;
                } else {
                    field += ch;
                }
            } else if (ch === '"') {
                inQuotes = true;
                fieldStarted = true;
            } else if (ch === delimiter) {
                pushField();
            } else if (ch === '\r' || ch === '\n') {
                if (ch === '\r' && s[i + 1] === '\n') i++;
                // 空行不是记录；被引号包裹的空字段仍然算数据
                if (record.length > 0 || field !== '' || fieldStarted) pushRecord();
                else { field = ''; fieldStarted = false; }
            } else {
                field += ch;
                fieldStarted = true;
            }
        }
        if (record.length > 0 || field !== '' || fieldStarted) pushRecord();
        return records;
    }

    _parseCSVLine(line, delimiter) {
        const records = this._parseCSV(line, delimiter);
        return records.length > 0 ? records[0] : [];
    }

    _csvEscape(value, delimiter) {
        if (value.includes(delimiter) || value.includes('"') || value.includes('\n')) {
            return '"' + value.replace(/"/g, '""') + '"';
        }
        return value;
    }

    _castValue(value, schemaDef, ctx) {
        if (!schemaDef) return value;
        // 空字段 / NULL：语义与此前一致，不参与类型转换
        if (value === null || value === undefined || value === '') return value;
        const type = String(schemaDef.type || '').toLowerCase();
        const raw = String(value).trim();
        switch (type) {
            case 'integer':
            case 'int':
            case 'bigint': {
                // #455：不再 `parseInt(...) || 0` 把解析失败吞成 0；非法整数值记入告警并保留原值，
                // 由表校验层拒绝（strict 模式下 importCSV 直接抛错）。
                if (/^[+-]?\d+$/.test(raw)) return parseInt(raw, 10);
                this._recordCastWarning(ctx, type, value);
                return value;
            }
            case 'number':
            case 'float':
            case 'double':
            case 'real':
            case 'decimal': {
                if (raw !== '' && !Number.isNaN(Number(raw))) return Number(raw);
                this._recordCastWarning(ctx, type, value);
                return value;
            }
            case 'boolean': {
                // #455：只识别规范真值/假值；其余不可识别的值不再一律归 false，记入告警并保留原值。
                const low = raw.toLowerCase();
                if (low === 'true' || low === '1') return true;
                if (low === 'false' || low === '0') return false;
                this._recordCastWarning(ctx, type, value);
                return value;
            }
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

    _recordCastWarning(ctx, type, value) {
        if (!ctx || !Array.isArray(ctx.warnings)) return;
        ctx.warnings.push({
            row: ctx.row,
            field: ctx.field,
            type,
            value: String(value),
            message: `Truncated incorrect ${type} value: '${value}'`,
        });
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
            const sizeEstimate = bigintJson.stringify(table._rows).length;
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

    // ============================================================
    // 事务（支持隔离级别）与保存点
    // ============================================================

    /**
     * 抓一份「所有表」的快照。
     *
     * 形状与 beginTx 的 _txSnapshot 一致（表名 → {rows, schema}），
     * 让「事务开始」「保存点」「两种回滚」共用同一套还原逻辑。
     *
     * 必须是深拷贝：行里可能含嵌套对象/数组，浅拷贝的话回滚之后
     * 调用方手里的引用仍指向已被改动的数据。
     */
    _captureTxSnapshot() {
        const snap = {};
        for (const [name, table] of Object.entries(this._tables)) {
            snap[name] = {
                rows: bigintJson.parse(bigintJson.stringify(table.toJSON())),
                // #199：schema 必须深拷贝（到列定义层），否则 ALTER TABLE 会直接改到快照，
                // ROLLBACK 后列结构无法还原。逐列浅拷贝可保留 check/computed 函数引用。
                schema: Object.fromEntries(Object.entries(table._schema).map(
                    ([k, v]) => [k, v && typeof v === 'object' ? { ...v } : v]
                )),
                // 自增计数器也要存：否则回滚掉刚插入的行之后，
                // 下一次插入会跳过已用过的号（用户看到 id 从 2 开始会困惑）。
                // 原有 rollback() 一直是这么做的，保存点保持一致。
                autoIncrement: table._autoIncrement,
                hooks: table._hooks
            };
        }
        return snap;
    }

    /**
     * 把数据还原到某个快照。
     *
     * 还原时**再深拷贝一次**是关键：同一个保存点可以被 ROLLBACK TO 多次，
     * 若把快照里的数组直接交给表，后续写入会改坏快照本身，
     * 第二次回滚拿到的就不是最初的状态了。
     *
     * 快照里没有的表要删掉 —— 否则「保存点之后才建的表」会残留，
     * 回滚完却多出一张当时并不存在的表。
     */
    _restoreTxSnapshot(snap) {
        if (!snap) return;
        for (const name of Object.keys(this._tables)) {
            if (snap[name]) continue;
            // #452：事务内 CREATE TABLE 回滚必须彻底撤销。目录模式下只删内存
            // 表对象会留下 meta 登记与 .jsql 文件，重开后被回滚的表连同未提交
            // 行一起复活。这里与 _dropTableSync 对齐：清 meta 登记、删表文件、
            // 摘掉访问器与表名登记。
            if (this._dirMode) {
                const meta = this._meta.tables[name];
                if (meta && meta.file) {
                    try { fs.unlinkSync(path.join(this._filePath, meta.file)); } catch (e) { /* 文件已不存在 */ }
                }
                delete this._meta.tables[name];
                this._dirtyTables.delete(name);
            }
            delete this[name];
            delete this._versions[name];
            this._tableNames.delete(name);
            delete this._tables[name];
        }
        if (this._dirMode) this._saveMeta();
        for (const [name, entry] of Object.entries(snap)) {
            const rows = bigintJson.parse(bigintJson.stringify(entry.rows));
            const prev = this._tables[name];
            // #199：用快照 schema 重建表对象，确保 ADD/DROP/MODIFY COLUMN、
            // 默认值、约束与派生缓存一并回滚。保留 hooks，避免回滚丢监听器。
            const schema = Object.fromEntries(Object.entries(entry.schema || {}).map(
                ([k, v]) => [k, v && typeof v === 'object' ? { ...v } : v]
            ));
            const table = new Table(name, schema, this);
            if (prev && prev._hooks) table._hooks = prev._hooks;
            table._loadRows(rows);
            this._tables[name] = table;
            // B1-2: 恢复后必须重新标记脏，否则 rollback 后 _flushDirty 空转
            // —— 事务写已落盘（900/600），回滚恢复正确数据（1000/500）到内存，
            // 但若不标记脏，_flushDirty 检测 _dirtyTables.size===0 直接 return，
            // 正确数据永远写不进磁盘，重启后回滚被逆转（900 复活）。
            if (this._dirMode) this._dirtyTables.add(name);
            // _loadRows 只会把计数器往上抬（取现有行的最大值），
            // 所以「回滚掉刚插入的行」之后还得显式退回去。
            if (entry.autoIncrement !== undefined) {
                table._autoIncrement = entry.autoIncrement;
            }
        }
        this._dirty = true;
    }

    /**
     * 是否有进行中的事务。
     *
     * 引擎里有两条事务实现路径：begin/commit/rollback 与
     * beginTx/commitTx/rollbackTx。SQL 层走后者（因为 Database.beginTx 存在），
     * 直接调 API 走前者 —— 保存点必须对两条都有效，所以这里两条都算。
     */
    hasActiveTx() {
        return (this._txId !== undefined && !!this._txSnapshot) || !!this._transaction;
    }

    /**
     * 当前活动事务的 WAL 标签（beginTx 路径用 `tx<n>`，begin 路径用 `b<n>`）。
     * 无活动事务时返回 null —— 旧 WAL / 自动提交的写入不带事务标记，回放时视为已提交。
     */
    _currentTxTag() {
        if (this._txId !== undefined && this._txSnapshot) return 'tx' + this._txId;
        if (this._transaction && this._transaction.txTag) return this._transaction.txTag;
        return null;
    }

    /** 保存点栈（懒建），随事务结束清空 */
    _savepointStackRef() {
        if (!this._savepointStack) this._savepointStack = [];
        return this._savepointStack;
    }

    /**
     * 开始事务
     * @param {string} isolationLevel - 覆盖默认隔离级别（可选）
     */
    begin(isolationLevel) {
        if (this._transaction) throw createError('ER_TRANSACTION_ACTIVE');

        const level = isolationLevel || this._isolationLevel;

        this._txFrameSeq = (this._txFrameSeq || 0) + 1;
        this._transaction = {
            snapshot: null,
            autoIncrements: {},
            level,
            startedAt: Date.now(),
            txTag: 'b' + this._txFrameSeq
        };

        if (level === 'REPEATABLE_READ') {
            // 快照：保存当前所有数据（深拷贝，保证嵌套对象可回滚）
            this._transaction.snapshot = this._captureTxSnapshot();
        } else {
            // #204：READ_COMMITTED 只降低读可见性，ROLLBACK 仍必须撤销写入，
            // 因此同样保存行快照（仅记录 autoIncrement 会让 UPDATE/INSERT 残留）。
            this._transaction.snapshot = this._captureTxSnapshot();
            for (const [name, table] of Object.entries(this._tables)) {
                this._transaction.autoIncrements[name] = table._autoIncrement;
            }
        }

        this._savepointStack = [];
        this._walWrite({ op: 'begin', tx: this._transaction.txTag, level });
    }

    commit() {
        if (!this._transaction) throw createError('ER_NO_TRANSACTION');
        this._walWrite({ op: 'commit', tx: this._transaction.txTag, at: this._transaction.startedAt });
        // 提交即释放全部保存点 —— 它们随事务一起结束
        this._transaction = null;
        this._savepointStack = [];
        // 不在此处调用 _checkpoint()：_checkpoint() 清空 WAL，但数据可能还未保存。
        // save() 内部会在保存完成后自动调用 _checkpoint()。
        this._markDirtyLegacy();
    }

    rollback() {
        if (!this._transaction) throw createError('ER_NO_TRANSACTION');

        if (this._transaction.snapshot) {
            this._restoreTxSnapshot(this._transaction.snapshot);
            // 回滚后的状态必须重新写入 WAL：否则 WAL 里已记录的写入
            // 会在崩溃重放时被重新应用，回滚等于没做。
            for (const name of Object.keys(this._transaction.snapshot)) {
                if (this._tables[name]) this._walLogReplaceTable(name);
            }
        } else {
            // READ_COMMITTED：没有行快照，只能退回自增值
            for (const [name, table] of Object.entries(this._tables)) {
                const v = this._transaction.autoIncrements[name];
                if (v !== undefined) table._autoIncrement = v;
            }
        }

        this._walWrite({ op: 'rollback', tx: this._transaction.txTag, at: this._transaction.startedAt });
        this._transaction = null;
        this._savepointStack = [];
        this._markDirtyLegacy();
    }

    // ============================================================
    // 保存点（SAVEPOINT / ROLLBACK TO / RELEASE）
    // ============================================================

    /**
     * 建立一个保存点。
     *
     * 语义遵循 SQL 标准：
     *   - 只在事务内有效，COMMIT / ROLLBACK 时全部释放
     *   - 同名保存点覆盖旧的（Postgres 行为），它之后的保存点一并作废
     *   - ROLLBACK TO 之后该保存点**仍然存在**，可以再回滚一次
     *
     * 保存点一律做全量行快照，不看隔离级别 —— 保存点的全部意义就是精确还原，
     * READ_COMMITTED 下若只记自增值，「回滚成功」就是假的。
     */
    savepoint(name) {
        if (!this.hasActiveTx()) {
            throw errorWithHint('ER_NO_TRANSACTION',
                `SAVEPOINT '${name}' requires an active transaction (run BEGIN first)`);
        }
        const sp = String(name == null ? '' : name).trim();
        if (!sp) throw errorWithHint('ER_PARSE_ERROR', 'Savepoint name cannot be empty');

        const list = this._savepointStackRef();
        // 同名覆盖：丢掉它以及它之后的所有保存点
        const dup = list.findIndex(s => s.name.toLowerCase() === sp.toLowerCase());
        if (dup >= 0) list.length = dup;

        list.push({ name: sp, snap: this._captureTxSnapshot(), at: Date.now() });
        return list.length;
    }

    /**
     * 回滚到某个保存点，事务本身继续有效。
     * 该保存点保留（可再次回滚到它），它之后建立的保存点全部丢弃。
     */
    rollbackTo(name) {
        const list = this._requireSavepoints(name, 'ROLLBACK TO SAVEPOINT');
        const idx = this._findSavepoint(list, name);
        this._restoreTxSnapshot(list[idx].snap);
        for (const tableName of Object.keys(list[idx].snap)) {
            if (this._tables[tableName]) this._walLogReplaceTable(tableName);
        }
        list.length = idx + 1;
        this._walWrite({ op: 'rollbackTo', name });
        this._markDirtyLegacy();
        return list.length;
    }

    /** 释放保存点：它和它之后的都作废，但不还原数据 */
    releaseSavepoint(name) {
        const list = this._requireSavepoints(name, 'RELEASE SAVEPOINT');
        const idx = this._findSavepoint(list, name);
        list.length = idx;
        return list.length;
    }

    /** 当前事务里的保存点名（由外到内） */
    listSavepoints() {
        if (!this.hasActiveTx()) return [];
        return this._savepointStackRef().map(s => s.name);
    }

    _requireSavepoints(name, op) {
        if (!this.hasActiveTx()) {
            throw errorWithHint('ER_NO_TRANSACTION',
                `${op} '${name}' requires an active transaction (run BEGIN first)`);
        }
        return this._savepointStackRef();
    }

    _findSavepoint(list, name) {
        const sp = String(name == null ? '' : name).toLowerCase();
        const idx = list.findIndex(s => s.name.toLowerCase() === sp);
        if (idx < 0) {
            const known = list.map(s => s.name).join(', ') || '(none)';
            // 用 MySQL 的错误码 1305（SAVEPOINT xxx does not exist），
            // 后面补上已定义的保存点，省得用户回头翻代码
            const base = ErrorCodes.ER_SP_DOES_NOT_EXIST.msg.replace('%s', String(name));
            throw new JSQL_Error(ErrorCodes.ER_SP_DOES_NOT_EXIST.code,
                `${base} (defined savepoints: ${known})`, { codeKey: 'ER_SP_DOES_NOT_EXIST' });
        }
        return idx;
    }

    inTransaction() {
        return this.hasActiveTx();
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

        const currentHash = bigintJson.stringify(table._rows);
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
        if (!table) throw this._noSuchTable(tableName);

        for (let i = 0; i < steps && versions.length > 1; i++) {
            versions.pop();
            const snapshot = versions[versions.length - 1];
            table._rows = snapshot.rows.map(r => ({ ...r }));
            if (typeof table._markAllRowsDirty === 'function') table._markAllRowsDirty();
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
     * @param {object|function|string} plugin - { name, version, install(db, ctx), hooks, api, onEvent }、函数或内置插件名
     * @param {object} [opts] - 传给内置插件工厂的配置，例如 db.use('timestamps', { createdField: 'created_at' })
     */
    use(plugin, opts) {
        return applyPlugin(this, plugin, opts);
    }

    _buildCtx(plugin) {
        return buildPluginContext(this, plugin);
    }

    /**
     * P1 修复：{modules:true} 自动加载插件。
     * 1. 通过 ModuleManager 读取 ~/.config/jsql/mod.config，应用已启用的模块
     * 2. 扫描 ~/.jsql/plugins/ 加载 registry 安装的插件
     */
    _loadAutoPlugins() {
        // 1. mod.config 中的模块
        try {
            const { ModuleManager } = require('./mod');
            new ModuleManager().applyTo(this);
        } catch (e) {
            if (process.env.JSQL_DEBUG) console.warn('[database] Failed to load mod.config:', e.message);
        }
        // 2. ~/.jsql/plugins/ 中的 registry 插件
        try {
            this._loadInstalledPlugins();
        } catch (e) {
            if (process.env.JSQL_DEBUG) console.warn('[database] Failed to load installed plugins:', e.message);
        }
    }

    /**
     * 扫描 ~/.jsql/plugins/ 目录，加载已安装的 registry 插件。
     * 兼容两种布局：根级入口文件 + plugins/ 子目录入口文件。
     */
    _loadInstalledPlugins() {
        const os = require('os');
        const fs = require('fs');
        const PLUGIN_DIR = path.join(os.homedir(), '.jsql', 'plugins');
        if (!fs.existsSync(PLUGIN_DIR)) return;
        const entries = fs.readdirSync(PLUGIN_DIR, { withFileTypes: true });
        for (const entry of entries) {
            if (!entry.isDirectory()) continue;
            const dir = path.join(PLUGIN_DIR, entry.name);
            const manifestPath = path.join(dir, 'manifest.json');
            if (!fs.existsSync(manifestPath)) continue;
            let manifest;
            try {
                manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
            } catch { continue; }
            if (manifest.disabled) continue;
            const pluginName = manifest.name || entry.name;
            // 查找入口文件：manifest.main || manifest.entry || 'index.js'
            const entryFile = manifest.main || manifest.entry || 'index.js';
            // 兼容三种布局：
            //   1. entry 是仓库相对路径（如 "plugins/xql/index.js"）且文件在根级 → basename
            //   2. entry 是根级相对路径（如 "index.js"）且文件在根级
            //   3. plugins/ 子目录（旧布局）
            const candidates = [
                path.join(dir, entryFile),
                path.join(dir, entryFile + '.js'),
                path.join(dir, path.basename(entryFile)),
                path.join(dir, path.basename(entryFile) + '.js'),
                path.join(dir, 'plugins', entryFile),
                path.join(dir, 'plugins', entryFile + '.js'),
                path.join(dir, 'plugins', path.basename(entryFile)),
                path.join(dir, 'plugins', path.basename(entryFile) + '.js'),
            ];
            let entryPath = null;
            for (const c of candidates) {
                if (fs.existsSync(c) && fs.statSync(c).isFile()) {
                    entryPath = c;
                    break;
                }
            }
            if (!entryPath) continue;
            try {
                const resolved = require.resolve(entryPath);
                delete require.cache[resolved];
                const plugin = require(resolved);
                if (typeof plugin === 'function') {
                    this.use({ name: pluginName, install: plugin });
                } else if (plugin && typeof plugin === 'object') {
                    if (!plugin.name) plugin.name = pluginName;
                    this.use(plugin);
                }
            } catch (e) {
                if (process.env.JSQL_DEBUG) console.warn('[database] Failed to load plugin', entry.name, e.message);
            }
        }
    }n
    on(event, fn) {
        return registerHook(this, event, fn);
    }

    onEvent(fn) {
        this._eventListeners.push(fn);
        return this;
    }

    /** 广播事件（插件上下文 / 外部均可调用） */
    emit(eventName, data) {
        this._emit(eventName, data);
        return this;
    }

    /** 主动触发一个钩子（含插件自定义钩子） */
    runHook(hookName, ...args) {
        return this._runHooks(hookName, args);
    }

    /** 取插件对外暴露的 API（由 plugin.api 声明） */
    plugin(name) {
        return getPluginApis(this).get(name) || null;
    }

    _emit(eventName, data) {
        for (const fn of this._eventListeners) {
            try { fn(eventName, data); } catch (e) { /* ignore */ }
        }
        // #263：'error' 事件同时投递给 on('error', fn) 注册的钩子。
        // on() 走 registerHook（进 _hooks），onEvent() 走 _eventListeners ——
        // 此前只有后者能收到错误，db.on('error', ...) 永远静默。
        if (eventName === 'error') {
            const hooks = this._hooks && this._hooks.error;
            if (hooks && hooks.length) {
                for (const entry of hooks) {
                    try { entry.fn(data); } catch (e) { /* ignore */ }
                }
            }
        }
    }

    _runHooks(hookName, args) {
        return runHooks(this, hookName, args);
    }

    // ============================================================
    // 统一高层 API（与 Native/WASM 引擎对齐）
    // ============================================================

    _pkOf(table) {
        return table._primaryKey || table._autoIncrementField || null;
    }

    async start() {
        await this._runHooks('onStart', []);
        this._emit('start', {});
        if (this._dirMode && !this._sigInstalled) {
            this._sigInstalled = true;
            Database._installSignalHandler(this);
        }
        return this;
    }

    /**
     * 进程退出时兜底刷盘：拦截 SIGINT/SIGTERM，同步落盘脏表后再退出。
     * 使用静态共享 handler，避免多个数据库实例重复注册/互相覆盖。
     * @private
     */
    static _installSignalHandler(db) {
        if (!Database._signalHandlerInstalled) {
            Database._signalHandlerInstalled = true;
            Database._signalDBs = new Set();
            const handler = (sig) => {
                for (const d of Database._signalDBs) {
                    try {
                        if (d._dirMode) {
                            if (d._flushTimer) { clearTimeout(d._flushTimer); d._flushTimer = null; }
                            d._flushDirty();
                            d._saveMeta();
                        }
                    } catch (e) { /* 兜底失败不阻塞退出 */ }
                }
                process.exit(128 + (sig === 'SIGINT' ? 2 : 15));
            };
            process.on('SIGINT', handler);
            process.on('SIGTERM', handler);
            Database._signalHandler = handler;
        }
        Database._signalDBs.add(db);
    }

    /** 从进程退出兜底集合移除（stop 时调用） */
    static _uninstallSignalHandler(db) {
        if (Database._signalDBs) Database._signalDBs.delete(db);
    }

    /** 公开别名 */
    static removeSignalHandler(db) {
        if (Database._signalDBs) {
            Database._signalDBs.delete(db);
        }
    }

    async insert(tableName, data, opts = {}) {
        const table = this._ensureTable(tableName);
        if (!table) throw this._noSuchTable(tableName);
        // #303：beforeInsert 可返回「修改后 data」（PLUGINS.md 契约）。
        // 钩子返回值通过 args 数组原地写回，这里必须读回被替换后的 arr。
        const hookArgs = [tableName, Array.isArray(data) ? data : [data]];
        if (!(await this._runHooks('beforeInsert', hookArgs))) return [];
        const arr = hookArgs[1];
        const pk = this._pkOf(table);
        // #201：多行 INSERT 走 insertMany，逐行校验全部通过后再统一落库
        // #269：opts.ignore 让可忽略的错误（CHECK 违反等）只跳过该行
        let inserted;
        let ignoreWarnings = [];
        if (arr.length > 1 && typeof table.insertMany === 'function') {
            inserted = table.insertMany(arr, { ignore: opts.ignore === true });
            if (inserted && inserted.warnings) {
                ignoreWarnings = inserted.warnings;
                delete inserted.warnings;
            }
        } else {
            // 单行：Table.insert 在 ignore 模式下返回带 warnings 的空数组（该行被跳过）
            const one = table.insert(arr[0], { ignore: opts.ignore === true });
            if (one && one.warnings) {
                ignoreWarnings = one.warnings;
                inserted = [];
            } else {
                inserted = [one];
            }
        }
        const ids = inserted.map((r, i) => (pk ? r[pk] : table._rows.length - inserted.length + i + 1));
        // #269：把 IGNORE 跳过的行以 warnings 形式带回给上层
        if (ignoreWarnings.length > 0) ids.warnings = ignoreWarnings;
        // WAL 已由 Table.insert() 在写入瞬间逐条落盘（含无主键表的整表镜像）
        this._emit('insert', { table: tableName, count: arr.length, ids });
        await this._runHooks('afterInsert', [tableName, arr, ids]);
        this._markDirty(tableName);
        return ids;
    }

    async flush() {
        if (!(await this._runHooks('beforeFlush', []))) return;
        if (this._dirMode) {
            this._flushDirty();
            this._saveMeta();
            this._checkpoint();
        } else if (!this._memoryMode) {
            this.save();
        }
        await this._runHooks('afterFlush', []);
        return this;
    }

    /**
     * 轻量持久化屏障：只把已写入的 WAL 记录 fsync 到磁盘，不写全量快照。
     *
     * 每条记录在写入时已单独 append 并 write() 进内核；默认 fsync 按
     * `walSyncInterval` 窗口合并。需要「此刻就必须抗掉电」时调用本方法，
     * 比 flush()/save()（全量快照）轻得多。
     */
    syncWAL() {
        if (this._walEnabled) this._syncWAL();
        return this;
    }

    _resolveId(table, id) {
        const pk = this._pkOf(table);
        if (pk) {
            // Issue #44：主键查询值按列类型归一（'5' → 5），与索引/insert 保持一致
            const key = typeof table._coerceQueryValue === 'function' ? table._coerceQueryValue(pk, id) : id;
            // 优先走主键索引：行级懒加载下避免为了取一行而把整表读进内存
            if (table._pkIndex) {
                const idx = table._pkIndex.get(key);
                if (idx !== undefined) {
                    const row = table._rows[idx];
                    if (row && (row[pk] === key || row[pk] === id)) return row;
                }
            }
            return table._rows.find(r => r[pk] === key || r[pk] === id) || null;
        }
        // 无主键表：id 是行对象（可能是 find() 返回的浅拷贝）时，用内容匹配代替引用比较。
        // 做法：逐行比对所有字段值是否相等；是数字时当 1-based 行号。
        if (id && typeof id === 'object') {
            const keys = Object.keys(id);
            return table._rows.find(r => keys.every(k => valuesEqual(r[k], id[k]))) || null;
        }
        const idx = Number(id);
        if (!isNaN(idx)) return table._rows[idx - 1] || null;
        return null;
    }

    async find(tableName, filter, opts = {}) {
        const table = this._ensureTable(tableName);
        if (!table) throw this._noSuchTable(tableName);
        if (!(await this._runHooks('beforeFind', [tableName, { filter, opts }]))) return [];
        const { limit, offset = 0 } = opts;
        // P1-4: 软删除模式下不得泄露已删除行——只看可见行
        let rows = table._applyFilterOptimized(table._getVisibleRows(), filter || {});
        if (limit > 0) rows = rows.slice(offset, offset + limit);
        else if (offset > 0) rows = rows.slice(offset);
        // P1-11: 返回浅拷贝，防止调用方修改影响内部数据
        rows = rows.map(r => ({ ...r }));
        this._touchTable(tableName);
        await this._runHooks('afterFind', [tableName, { filter, opts }, rows]);
        return rows;
    }

    /**
     * 一键把表转成列存（按字段拆成「每列一个数组」）。
     *
     * 适合「批量导入 → 转换 → 反复扫描/聚合」的读多写少场景。
     * `_rows` 始终是权威数据；列存是查询用的派生缓存，任何写入都会让它
     * 失效（下次读取自动回到行存路径），因此不会出现两份数据不一致。
     * 需要重新转换后可再次调用。
     */
    convertToColumnar(tableName) {
        const table = this._ensureTable(tableName);
        if (!table) throw this._noSuchTable(tableName);
        return table.toColumnar();
    }

    /** 把表转回行存（丢弃列存缓存）。 */
    convertToRow(tableName) {
        const table = this._ensureTable(tableName);
        if (!table) throw this._noSuchTable(tableName);
        return table.toRow();
    }

    exists(tableName, filter = {}) {
        const table = this._ensureTable(tableName);
        if (!table) throw this._noSuchTable(tableName);
        this._touchTable(tableName);
        return table.exists(filter);
    }

    async query(sql, paramsOrOpts, opts) {
        const { executeSQL } = require('./sql');
        if (!(await this._runHooks('beforeQuery', [sql, paramsOrOpts, opts]))) return null;
        const result = await executeSQL(this, sql, paramsOrOpts, opts);
        await this._runHooks('afterQuery', [sql, paramsOrOpts, opts, result]);
        return result;
    }

    prepare(sql) {
        return require('./prepared').createPrepared(this, sql);
    }

    async findById(tableName, id) {
        const table = this._ensureTable(tableName);
        if (!table) throw this._noSuchTable(tableName);
        if (!(await this._runHooks('beforeFind', [tableName, { id }]))) return null;
        const row = this._resolveId(table, id);
        // P1-4: 软删除行对普通读取不可见
        if (row && row._deleted) return null;
        // P1-11: 返回浅拷贝，防止调用方修改影响内部数据
        const result = row ? { ...row } : null;
        this._touchTable(tableName);
        await this._runHooks('afterFind', [tableName, { id }, result]);
        return result;
    }

    async findByIds(tableName, ids) {
        const table = this._ensureTable(tableName);
        if (!table) throw this._noSuchTable(tableName);
        if (!(await this._runHooks('beforeFind', [tableName, { ids }]))) return null;
        // P1-4: 过滤掉软删除行；P1-11: 返回浅拷贝
        const rows = ids.map(id => this._resolveId(table, id)).filter(r => r !== null && !r._deleted).map(r => ({ ...r }));
        this._touchTable(tableName);
        await this._runHooks('afterFind', [tableName, { ids }, rows]);
        return rows;
    }

    findByIdsRaw(tableName, ids) {
        return this.findByIds(tableName, ids);
    }

    async count(tableName, filter) {
        const table = this._ensureTable(tableName);
        if (!table) throw this._noSuchTable(tableName);
        if (!(await this._runHooks('beforeCount', [tableName, filter]))) return 0; // #383 钩子中止按数字契约兜底
        // P1-4: 软删除模式下只统计可见行
        // #334：api-reference.md 承诺 count(table, filter) 按条件计数，第二参数此前被丢弃。
        // 这里复用 find 的过滤路径（_applyFilterOptimized），保证与 find 语义一致。
        const visible = table._softDelete ? table._getVisibleRows() : table._rows;
        const n = filter && Object.keys(filter).length
            ? table._applyFilterOptimized(visible, filter).length
            : visible.length;
        this._touchTable(tableName);
        await this._runHooks('afterCount', [tableName, n]);
        return n;
    }

    /**
     * #418：单条更新的公共写入内核（类型/NOT NULL/唯一/外键/CHECK 校验 + 索引同步），
     * 供 updateById / updateByIds 复用。批量路径此前只跑 CHECK 就 Object.assign，
     * 绕过了类型、NOT NULL、唯一冲突、外键校验与主键/唯一索引维护，导致 pkIndex
     * 与行不一致、非法约束数据落库。返回 { row, validated }；行不存在或已软删返回 null。
     */
    _applyUpdateToRow(table, id, data) {
        // P1-9: 先做类型校验再更新

        const validated = table._validateDataTypes({ ...data }, true);
        const row = this._resolveId(table, id);
        // P1-4: 软删除行不可更新
        if (!row || row._deleted) return null;
        // 改主键/唯一列时要先确认新值不与其它行冲突。
        // 注意：UNIQUE 列记录在 table._cachedUniqueFields（不是 _indexes），
        // 逐行比对即可，未建索引时也能正确拦截。
        const pk = this._pkOf(table);
        const uniq = (table._cachedUniqueFields || []).filter(f => f !== pk);
        for (const field of [pk, ...uniq]) {
            if (!field || !Object.prototype.hasOwnProperty.call(validated, field)) continue;
            const nv = validated[field];
            if (nv === row[field]) continue;          // 值没变，不算冲突
            // #245：唯一性判定必须与等值比较同一口径（默认大小写不敏感），
            // 改用 Table 层的折叠键判定。
            const clash = typeof table._uniqueConflictRow === 'function'
                ? table._uniqueConflictRow(field, nv, row)
                : table._rows.find(r => r !== row && r[field] === nv);
            if (clash) throw createError('ER_DUP_ENTRY', String(nv), field);
        }
        // 外键：改主键时按 ON UPDATE 传播到引用它的子表；改自身外键列时校验引用存在。
        if (pk && Object.prototype.hasOwnProperty.call(validated, pk) && validated[pk] !== row[pk]) {
            table._propagatePKUpdate(row[pk], validated[pk]);
        }
        if (table._foreignKeys && table._foreignKeys.length) {
            table._validateForeignKeys({ ...row, ...validated });
        }
        // #250：与 db.update() 走同一套约束校验（NOT NULL / required）。
        if (typeof table._validateConstraints === 'function') {
            const rowIdx = table._rows.indexOf(row);
            table._validateConstraints({ ...row, ...validated }, rowIdx);
        }
        // CHECK 约束（Issue #70）
        if (typeof table._enforceChecks === 'function') {
            table._enforceChecks({ ...row, ...validated });
        }
        // #234：复合唯一索引在 UPDATE 路径上同样必须校验
        if (typeof table._checkCompositeUnique === 'function') {
            table._checkCompositeUnique({ ...row, ...validated }, table._rows.indexOf(row));
        }
        // 改主键/唯一值时索引必须同步：否则 _pkIndex 还指向旧值，
        // 后续 FK 校验 findOne({id:新值}) 查不到刚更新的父行。
        {
            // 优先用主键索引定位，避免行级懒加载时 indexOf 把前面的行全部读进内存
            let rowIndex = -1;
            if (pk && table._pkIndex) {
                const oldKey = typeof table._coerceQueryValue === 'function'
                    ? table._coerceQueryValue(pk, row[pk]) : row[pk];
                const i = table._pkIndex.get(oldKey);
                if (i !== undefined && table._rows[i] === row) rowIndex = i;
            }
            if (rowIndex === -1) rowIndex = table._rows.indexOf(row);
            const oldPk = pk ? row[pk] : undefined;
            if (rowIndex !== -1) table._removeFromIndexes(rowIndex, row);
            Object.assign(row, validated);
            if (rowIndex !== -1) table._addToIndexes(rowIndex, row);
            if (typeof table._markRowDirty === 'function') table._markRowDirty(row, oldPk);
        }
        return { row, validated };
    }

    async updateById(tableName, id, data) {
        const table = this._ensureTable(tableName);
        if (!table) throw this._noSuchTable(tableName);
        // #303：beforeUpdate 可返回「修改后 data」（PLUGINS.md 契约），
        // 写回后必须用改写后的值继续。
        const hookArgs = [tableName, id, data];
        if (!(await this._runHooks('beforeUpdate', hookArgs))) return { ok: false, error: 'aborted' }; // #383
        data = hookArgs[2];
        const applied = this._applyUpdateToRow(table, id, data);
        if (!applied) return { ok: false, error: 'not found' };
        const { row, validated } = applied;
        this._walLogUpsert(tableName, [row]);
        this._emit('update', { table: tableName, id, data: validated });
        await this._runHooks('afterUpdate', [tableName, id, validated, { ok: true }]);
        this._markDirty(tableName);
        return { ok: true };
    }

    async updateByIds(tableName, entries) {
        const table = this._ensureTable(tableName);
        if (!table) throw this._noSuchTable(tableName);
        const pairs = entries.map(([id, data]) => [id, data]);
        if (!(await this._runHooks('beforeUpdate', [tableName, pairs]))) return { ok: false, count: 0, error: 'aborted' }; // #383
        let count = 0;
        const changed = [];
        for (const [id, data] of pairs) {
            const applied = this._applyUpdateToRow(table, id, data);
            if (applied) {
                changed.push(applied.row);
                count++;
            }
        }
        if (changed.length) this._walLogUpsert(tableName, changed);
        this._emit('update', { table: tableName, entries: pairs, result: { ok: true, count } });
        await this._runHooks('afterUpdate', [tableName, pairs, { ok: true, count }]);
        this._markDirty(tableName);
        return { ok: true, count };
    }

    async removeById(tableName, id) {
        const table = this._ensureTable(tableName);
        if (!table) throw this._noSuchTable(tableName);
        if (!(await this._runHooks('beforeDelete', [tableName, id]))) return { ok: false, error: 'aborted' }; // #383
        if (table._primaryKey) {
            const removed = table.removeById(id);
            if (removed === 0) return { ok: false, error: 'not found' };
            // WAL 由 Table.removeById() 记录
            this._emit('delete', { table: tableName, id });
            await this._runHooks('afterDelete', [tableName, id, { ok: true }]);
            this._markDirty(tableName);
            return { ok: true };
        }
        const idx = table._rows.findIndex(r => r === this._resolveId(table, id));
        if (idx === -1) return { ok: false, error: 'not found' };
        table._rows.splice(idx, 1);
        table._rebuildPKIndex();
        table._rebuildAllBTrees();
        for (const field of Object.keys(table._indexes)) table.createIndex(field);
        this._walLogReplaceTable(tableName);
        this._emit('delete', { table: tableName, id });
        await this._runHooks('afterDelete', [tableName, id, { ok: true }]);
        this._markDirty(tableName);
        return { ok: true };
    }

    async removeByIds(tableName, ids) {
        const table = this._ensureTable(tableName);
        if (!table) throw this._noSuchTable(tableName);
        if (!(await this._runHooks('beforeDelete', [tableName, ids]))) return { ok: false, count: 0, error: 'aborted' }; // #383
        let removed = 0;
        if (table._primaryKey) {
            for (const id of ids) removed += table.removeById(id);
        } else {
            // 无主键表没有稳定的行标识，P1-11 后 find() 返回浅拷贝（{...r}），
            // 对象引用与 table._rows 里的原对象不同，不能用 Set.has(row) 做引用匹配。
            // _resolveId 对无主键表做 table._rows[id-1]，传入对象时 id-1=NaN → undefined。
            // 所以这里对对象 id 做深度相等匹配，对值 id 走 _resolveId（1-based 行号）。
            const seen = new Set();
            const targets = [];
            for (const id of ids) {
                let rowIndex;
                if (id && typeof id === 'object') {
                    // id 是行对象（find() 返回的浅拷贝），用深度相等匹配
                    rowIndex = table._rows.findIndex(r => _rowDeepEqual(r, id));
                } else {
                    // id 是值（1-based 行号），_resolveId 能处理
                    const original = this._resolveId(table, id);
                    if (original) rowIndex = table._rows.indexOf(original);
                }
                if (rowIndex >= 0 && !seen.has(rowIndex)) {
                    seen.add(rowIndex);
                    targets.push(rowIndex);
                }
            }
            if (targets.length) {
                table._rows = table._rows.filter((_, idx) => !seen.has(idx));
                if (typeof table._markAllRowsDirty === 'function') table._markAllRowsDirty();
                removed = targets.length;
            }
            table._rebuildPKIndex();
            table._rebuildAllBTrees();
            for (const field of Object.keys(table._indexes)) table.createIndex(field);
            if (removed > 0) this._walLogReplaceTable(tableName);
        }
        this._emit('delete', { table: tableName, ids, result: { ok: true, count: removed } });
        await this._runHooks('afterDelete', [tableName, ids, { ok: true, count: removed }]);
        this._markDirty(tableName);
        return { ok: true, count: removed };
    }

    async removeWhere(tableName, filter) {
        const table = this._ensureTable(tableName);
        if (!table) throw this._noSuchTable(tableName);
        if (!(await this._runHooks('beforeDelete', [tableName, [filter]]))) return { ok: true, count: 0 };
        const before = table._rows.length;
        // P1-4: 只匹配可见行（软删除行已“不存在”，不应被硬删操作波及）
        const matched = table._applyFilter(table._getVisibleRows(), filter || {});
        const matchSet = new Set(matched);
        table._rows = table._rows.filter(r => !matchSet.has(r));
        if (typeof table._markAllRowsDirty === 'function') table._markAllRowsDirty();
        const removed = before - table._rows.length;
        table._rebuildPKIndex();
        table._rebuildAllBTrees();
        for (const field of Object.keys(table._indexes)) table.createIndex(field);
        if (removed > 0) this._walLogRemove(tableName, matched);
        this._emit('delete', { table: tableName, ids: [], result: { ok: true, count: removed } });
        await this._runHooks('afterDelete', [tableName, [filter], { ok: true, count: removed }]);
        this._markDirty(tableName);
        return { ok: true, count: removed };
    }

    async insertMany(tableName, items, opts = {}) {
        const table = this._ensureTable(tableName);
        if (!table) throw this._noSuchTable(tableName);
        const arr = Array.isArray(items) ? items : [items];
        if (!(await this._runHooks('beforeInsert', [tableName, arr]))) return [];
        // #269：opts.ignore → 可忽略的错误降级为 warning，只跳过该行
        const inserted = table.insertMany(arr, { ignore: opts.ignore === true });
        // WAL 由 Table.insertMany() 记录
        this._emit('insert', { table: tableName, count: arr.length });
        await this._runHooks('afterInsert', [tableName, arr, inserted]);
        this._markDirty(tableName);
        return inserted;
    }

    async update(tableName, query, updates) {
        const table = this._ensureTable(tableName);
        if (!table) throw this._noSuchTable(tableName);
        if (!(await this._runHooks('beforeUpdate', [tableName, query, updates]))) return 0;
        const count = table.update(query, updates);
        // WAL 由 Table.update() 记录
        this._emit('update', { table: tableName, query, count });
        await this._runHooks('afterUpdate', [tableName, query, updates, count]);
        this._markDirty(tableName);
        return count;
    }

    async delete(tableName, query = {}) {
        const table = this._ensureTable(tableName);
        if (!table) throw this._noSuchTable(tableName);
        if (!(await this._runHooks('beforeDelete', [tableName, query]))) return 0;
        // WAL 由 Table.remove() 记录
        const count = table.remove(query);
        this._emit('delete', { table: tableName, query, count });
        await this._runHooks('afterDelete', [tableName, query, count]);
        this._markDirty(tableName);
        return count;
    }

    truncate(tableName) {
        const table = this._ensureTable(tableName);
        if (!table) throw this._noSuchTable(tableName);
        // #206：被外键引用的父表禁止 TRUNCATE（MySQL 1701），也不应触发级联
        if (this._foreignReferencingRows(tableName).length > 0) {
            throw createError('ER_TRUNCATE_ILLEGAL_FK', tableName);
        }
        // WAL 由 Table.truncate() 记录整表镜像
        const count = table.truncate();
        this._emit('delete', { table: tableName, count });
        this._markDirty(tableName);
        return count;
    }

    async stop() {
        await this._runHooks('onStop', []);
        this._emit('stop', {});
        // 内存监控定时器：stop() 此前从不清理，重复创建/销毁实例会堆积定时器
        if (this._monitorTimer) { clearInterval(this._monitorTimer); this._monitorTimer = null; }
        if (this._dirMode) {
            if (this._flushTimer) { clearTimeout(this._flushTimer); this._flushTimer = null; }
            try {
                this._flushDirty();
                this._saveMeta();
                this._checkpoint();
            } catch (e) {}
        } else if (!this._memoryMode) {
            // 正常关闭时做一次快照检查点，缩短下次启动的回放时间
            try { this.save(); } catch (e) {}
        }
        if (this._sigInstalled) {
            this._sigInstalled = false;
            Database._uninstallSignalHandler(this);
        }
        // 兜底：合并窗口内可能还有未 fsync 的 WAL 记录（例如 save() 抛错被吞掉），
        // 关闭实例前必须补齐，否则掉电会丢失这段已返回成功的写入。
        this._walCloseFd();
        // #295：stop() 表示本实例停止写入，必须释放文件锁，否则同路径再打开会误报占用
        this._releaseLock();
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
            for (const m of [...this._migrations].reverse()) {
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
            ? bigintJson.stringify(data, 2)
            : bigintJson.stringify(data);
        this._writeFile(filePath, json);
        return filePath;
    }

    restore(filePath) {
        if (!fs.existsSync(filePath)) {
            throw createError('ER_FILE_NOT_FOUND', filePath);
        }
        const json = this._readFile(filePath);
        const data = bigintJson.parse(json);
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
            this._checkpoint();
            return;
        }

        if (this._jsqlMode) {
            const all = {};
            for (const [name, table] of Object.entries(this._tables)) {
                if (name === '__meta__') continue;
                const pkField = Object.keys(table._schema).find(f => table._schema[f].primaryKey);
                all[name] = { schema: table._persistedSchema(), rows: table._rows, pkField };
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
            data.__schema__[name] = table._persistedSchema();
            data[name] = table.toJSON();
        }

        const json = this._options.pretty
            ? bigintJson.stringify(data, 2)
            : bigintJson.stringify(data);
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
                if (!this._tables[name]) this._createTableSync(name, t.schema);
                if (t.rowCount > 0) {
                    const { rows } = this._jsqlFormat.readTableSync(name);
                    this._tables[name]._loadRows(rows);
                }
            }
            // WAL 恢复（此前 .jsql 分支提前 return，导致崩溃后数据全丢）
            this._recoverFromWAL();
            return;
        }

            // P1-10: WAL-only 恢复 —— 主库文件不存在时跳过读取，直接恢复 WAL
            if (!fs.existsSync(this._filePath)) {
                this._recoverFromWAL();
                return;
            }

            const json = this._readFile(this._filePath);
            let data;
            try {
                data = bigintJson.parse(json);
            } catch (parseErr) {
                // #237：快照损坏（崩溃半写）不能直接整库打不开；
                // 记录告警后继续走 WAL 恢复（缺失的表由 WAL 行推断重建）。
                const warn = new Error(`Snapshot '${this._filePath}' is corrupt (${parseErr.message}); attempting WAL recovery.`);
                try { this._emit('error', warn); } catch (e) { /* 监听器异常不阻塞恢复 */ }
                console.error('[jsql-neo] ' + warn.message);
                this._recoverFromWAL();
                return;
            }

            if (data.__schema__) {
                for (const [name, schema] of Object.entries(data.__schema__)) {
                    if (!this._tables[name]) {
                        this._createTableSync(name, schema);
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
                // #321：legacy 文件模式的自动保存定时器也要 unref()。
                // 同文件的 _flushTimer / _monitorTimer 都已经 unref，唯独这个漏了，
                // 漏调 close() 时进程会被挂到下一次自动保存触发才退出。
                if (this._autoSaveTimer && this._autoSaveTimer.unref) this._autoSaveTimer.unref();
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
        // 同样清理内存监控定时器，否则 close() 后仍在后台触发 _checkMemory
        if (this._monitorTimer) { clearInterval(this._monitorTimer); this._monitorTimer = null; }
        if (this._dirMode) {
            try {
                this._flushDirty();
                this._saveMeta();
            } catch (e) {
                this._emit('error', e);
            }
        } else if (this._dirty && !this._memoryMode) {
            this.save();
        }
        if (this._jsqlFormat) this._jsqlFormat._close();
        this._walCloseFd();
        this._releaseLock();
        // Bug 3: 清理静态信号处理器，防止关闭后还在响应信号
        if (this._sigInstalled) {
            this._sigInstalled = false;
            Database.removeSignalHandler(this);
        }
        // 关闭行缓存持有的文件句柄
        for (const t of Object.values(this._tables)) {
            if (t && typeof t._detachRowCache === 'function') t._detachRowCache();
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
        this._walWrite({ op: 'import', tables: Object.keys(data) });
        this._markDirtyLegacy();
    }

    async beginTx() {
        this._savepointStack = [];
        // 与保存点共用同一套快照函数，两边形状必须一致，
        // 否则 rollbackTx 还原不了保存点存下来的快照（反之亦然）。
        this._txSnapshot = this._captureTxSnapshot();
        this._txId = (this._txId || 0) + 1;
        this._walWrite({ op: 'begin', tx: 'tx' + this._txId });
        return this._txId;
    }

    async commitTx() {
        this._walWrite({ op: 'commit', tx: 'tx' + this._txId });
        this._txSnapshot = null;
        this._txId = undefined;
        this._savepointStack = [];   // 提交即释放全部保存点
        if (this._dirMode) {
            try { this._flushDirty(); } catch (e) {}
        } else if (!this._memoryMode) {
            this.save();
        }
    }

    async rollbackTx() {
        const snap = this._txSnapshot;
        this._walWrite({ op: 'rollback', tx: 'tx' + this._txId });
        this._txSnapshot = null;
        this._txId = undefined;
        this._savepointStack = [];
        if (!snap) return;
        this._restoreTxSnapshot(snap);
        // 修复 B1：rollback 后必须落盘，否则事务期间已 flush 到磁盘的写入
        // 不会被撤销，kill -9 重启后数据不一致（ACID 原子性被破坏）。
        // dirMode 下事务写入已逐表 flush，rollback 后需重新 flush 恢复后的数据；
        // 非 dirMode 下 commitTx 会 save()，rollback 也要 save() 保持一致。
        if (this._dirMode) {
            try { this._flushDirty(); } catch (e) { this._emit('error', e); }
        } else if (!this._memoryMode) {
            this.save();
        }
    }

    // ============================================================
    // 加密（内部）
    // ============================================================

    _writeFile(filePath, content) {
        let payload;
        if (this._encryptKey) {
            const iv = crypto.randomBytes(16);
            const cipher = crypto.createCipheriv('aes-256-cbc', Buffer.from(this._encryptKey.padEnd(32).slice(0, 32)), iv);
            const encrypted = Buffer.concat([cipher.update(content, 'utf8'), cipher.final()]);
            const data = Buffer.concat([iv, encrypted]);
            payload = data.toString('base64');
        } else {
            payload = content;
        }
        // #237：先写临时文件 + fsync，再原子 rename；崩溃只会留下旧快照或新快照，
        // 不会出现写到一半的半份 JSON。
        const dir = path.dirname(filePath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        const tmp = filePath + '.tmp';
        const fd = fs.openSync(tmp, 'w');
        try {
            fs.writeFileSync(fd, payload, 'utf8');
            fs.fsyncSync(fd);
        } finally {
            fs.closeSync(fd);
        }
        fs.renameSync(tmp, filePath);
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
module.exports.parseFieldShorthand = parseFieldShorthand;