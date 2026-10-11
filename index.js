/**
 * JSQL-NEO v6.3.10 — Rust-Powered Embedded Database (WASM + HTTP)
 *
 * @example
 * const jsql = require('jsql-neo');
 * const db = new jsql.JSQL();  // WASM mode (no server needed)
 * await db.start();
 * await db.createTable('users', { name: { type: 'string' }, age: { type: 'integer' } });
 * const ids = await db.insert('users', { name: 'Alice', age: 30 });
 * const user = await db.findById('users', 1);
 * await db.stop();
 */

const WasmClient = require('./lib/wasm_client');
const NativeClient = require('./lib/native_client');
const { Plugin, definePlugin, HOOKS } = require('./lib/plugin');
const plugins = require('./lib/plugins');
const { ModuleManager } = require('./lib/mod');
const sql = require('./lib/sql');
const { Datastore } = require('./lib/nedb_compat');
const mysqlCompat = require('./lib/mysql_compat');
const { createMysqlServer, MysqlServer } = require('./lib/mysql_server');
const migrate = require('./lib/migrate');
const { WebUI } = require('./lib/web_ui');
const { RedisServer, createRedisServer } = require('./lib/redis_server');
const { PgServer, createPgServer } = require('./lib/pg_server');
const { MongoServer, createMongoServer } = require('./lib/mongo_server');
const { MultiServer, createMultiServer } = require('./lib/multiserver');
const { TUIShell, createTUI } = require('./lib/tui');

/**
 * 全局注入：把项目内 `require('mysql2')` 全部替换为 jsql-neo 内存引擎兼容层。
 * 该函数**不再**改写 `require.cache`。
 *
 * 背景：旧实现会遍历 node_modules，把 `mysql2/index.js` 与 `mysql2/promise.js`
 * 的 require.cache 条目替换为内存兼容层。由于它靠 `process.cwd()` 猜测路径，
 * 命中哪个 node_modules 完全取决于启动目录，且 mysql2 通常尚未加载，
 * 于是被静默替换 —— 真实 MySQL 连接悄无声息地改查内存库且不报错，
 * 表现为「本地跑通、上线全错」。这是不可接受的隐式副作用。
 *
 * 现在请显式选择注入方式：
 *
 *   1) 直接使用兼容层（推荐，零副作用）：
 *        const { mysql2 } = require('jsql-neo');
 *        const conn = await mysql2.createConnection(opts);
 *
 *   2) 让某个依赖改用兼容层（只对指定模块生效，不污染全局缓存）：
 *        const { injectMySQLCompat } = require('jsql-neo');
 *        injectMySQLCompat(require('typeorm'));   // 只改写 typeorm 自己的引用
 *
 *   3) 确实需要全局劫持（危险，仅限测试环境）：
 *        enableMySQLCompat({ global: true, force: true });
 *        需同时设置 JSQL_NEO_ALLOW_GLOBAL_HIJACK=1 作为显式确认。
 *
 * @param {object}  [opts]
 * @param {boolean} [opts.global=false] 是否允许改写 require.cache（需环境变量确认）
 * @param {boolean} [opts.force=false]   是否覆盖已加载的真实 mysql2
 * @returns {object} mysql2 兼容层
 */
function enableMySQLCompat(opts = {}) {
  if (!opts || opts.global !== true) {
    // 默认安全：什么都不做，仅返回兼容层供显式使用
    return mysqlCompat;
  }
  if (process.env.JSQL_NEO_ALLOW_GLOBAL_HIJACK !== '1') {
    throw new Error(
      '[jsql-neo] 已拒绝全局劫持 require.cache：这会静默替换真实 mysql2，' +
      '导致本地测试通过但生产连错库。\n' +
      '如确需启用，请显式设置环境变量 JSQL_NEO_ALLOW_GLOBAL_HIJACK=1 并传 { global: true }。\n' +
      '推荐改用显式注入：injectMySQLCompat(require(\'你的orm\'))，或直接使用导出的 mysql2/createConnection。'
    );
  }
  const fs = require('fs');
  const path = require('path');
  const seen = new Set();
  const bases = new Set();
  if (require.main && Array.isArray(require.main.paths)) {
    for (const p of require.main.paths) bases.add(p);
  }
  if (process.env.NODE_PATH) {
    for (const p of process.env.NODE_PATH.split(path.delimiter)) if (p) bases.add(p);
  }
  bases.add(path.join(process.cwd(), 'node_modules'));
  const inject = (p, mod) => {
    try {
      const resolved = p;
      if (seen.has(resolved)) return;
      if (!fs.existsSync(resolved)) return;
      seen.add(resolved);
      if (require.cache[resolved] && !opts.force) return;
      require.cache[resolved] = { exports: mod, id: resolved, filename: resolved, loaded: true, children: [] };
    } catch (e) { /* ignore */ }
  };
  for (const base of bases) {
    inject(path.join(base, 'mysql2', 'index.js'), mysqlCompat);
    inject(path.join(base, 'mysql2', 'promise.js'), mysqlCompat);
  }
  return mysqlCompat;
}

/**
 * 把已加载模块自身持有的 `mysql2` 引用定向到 jsql-neo 兼容层。
 *
 * 与全局劫持不同，本函数**只修改传入模块对象上的引用**，
 * 不触碰 require.cache，不影响进程内其他模块。
 *
 * @param {object} mod 目标模块的 exports（如 require('typeorm')）
 * @returns {boolean} 是否成功改写
 */
function injectMySQLCompat(mod) {
  if (!mod || typeof mod !== 'object') return false;
  let touched = false;
  // 常见形态：模块把 createConnection / createPool 挂在自身或嵌套对象上
  const patch = (target) => {
    if (!target || typeof target !== 'object') return;
    for (const key of ['createConnection', 'createPool']) {
      if (typeof target[key] === 'function' && target[key] !== mysqlCompat[key]) {
        target[key] = mysqlCompat[key];
        touched = true;
      }
    }
  };
  patch(mod);
  // 一层嵌套（drizzle / kysely 等常把驱动挂在子对象上）
  for (const key of Object.keys(mod)) {
    const v = mod[key];
    if (v && typeof v === 'object' && v !== mod && !Array.isArray(v)) patch(v);
  }
  return touched;
}

module.exports = {
    JSQL: WasmClient.JSQL,
    NativeJSQL: NativeClient.JSQL,
    Database: require('./lib/database'),
    Table: require('./lib/table'),
    Query: require('./lib/query'),
    BTree: require('./lib/btree'),
    Cache: require('./lib/cache'),
    Plugin,
    definePlugin,
    HOOKS,
    plugins,
    ModuleManager,
    JSQL_Error: require('./lib/errors').JSQL_Error,
    ErrorCodes: require('./lib/errors').ErrorCodes,
    JSQLFormat: require('./lib/jsql_format'),
    HttpJSQL: require('./lib/client').JSQL,
    // 兼容层
    SQL: sql,
    executeSQL: sql.executeSQL,
    parseSQL: sql.parseSQL,
    // AST 访问与改写（5.5.0+）
    AST: sql.AST,
    walk: sql.walk,
    transform: sql.transform,
    tokenize: sql.tokenize,
    splitStatements: sql.splitStatements,
    Datastore,
    createConnection: mysqlCompat.createConnection,
    createPool: mysqlCompat.createPool,
    mysql: mysqlCompat,
    mysql2: mysqlCompat,
    enableMySQLCompat,
    injectMySQLCompat,
    createMysqlServer,
    MysqlServer,
    // 迁移工具: mysqldump 导入 / JSON / CSV
    migrate,
    exportTableToJSON: migrate.exportTableToJSON,
    exportAllToJSON: migrate.exportAllToJSON,
    importFromJSON: migrate.importFromJSON,
    exportTableToCSV: migrate.exportTableToCSV,
    importFromCSV: migrate.importFromCSV,
    importDump: migrate.importDump,
    importDumpFile: migrate.importDumpFile,
    exportToFile: migrate.exportToFile,
    // Web UI
    WebUI,
    // Redis 兼容服务器
    RedisServer,
    createRedisServer,
    // PostgreSQL wire protocol 服务器
    PgServer,
    createPgServer,
    // MongoDB wire protocol 服务器
    MongoServer,
    createMongoServer,
    // 多协议嗅探服务器（MySQL + PG + Redis + Mongo 同端口）
    MultiServer,
    createMultiServer,
    // 交互式 TUI
    TUIShell,
    createTUI,
};
