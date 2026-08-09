/**
 * JSQL-NEO v5.1.2 — Rust-Powered Embedded Database (WASM + HTTP)
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
const { Plugin } = require('./lib/plugin');
const { ModuleManager } = require('./lib/mod');
const sql = require('./lib/sql');
const { Datastore } = require('./lib/nedb_compat');
const mysqlCompat = require('./lib/mysql_compat');
const { createMysqlServer, MysqlServer } = require('./lib/mysql_server');
const migrate = require('./lib/migrate');
const { WebUI } = require('./lib/web_ui');
const { RedisServer, createRedisServer } = require('./lib/redis_server');

/**
 * 全局注入：把项目内 `require('mysql2')` 全部替换为 jsql-neo 内存引擎兼容层。
 * 调用一次后，TypeORM / Drizzle / MikroORM / Kysely 等直接依赖 mysql2 的库
 * 无需改代码即可享受本地内存速度。
 */
function enableMySQLCompat() {
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
      // 不覆盖已加载的真实 mysql2，避免全局劫持副作用
      if (require.cache[resolved]) return;
      require.cache[resolved] = { exports: mod, id: resolved, filename: resolved, loaded: true, children: [] };
    } catch (e) { /* ignore */ }
  };
  for (const base of bases) {
    inject(path.join(base, 'mysql2', 'index.js'), mysqlCompat);
    inject(path.join(base, 'mysql2', 'promise.js'), mysqlCompat);
  }
  return mysqlCompat;
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
    ModuleManager,
    JSQL_Error: require('./lib/errors').JSQL_Error,
    ErrorCodes: require('./lib/errors').ErrorCodes,
    JSQLFormat: require('./lib/jsql_format'),
    HttpJSQL: require('./lib/client').JSQL,
    // 兼容层
    SQL: sql,
    executeSQL: sql.executeSQL,
    parseSQL: sql.parseSQL,
    Datastore,
    createConnection: mysqlCompat.createConnection,
    createPool: mysqlCompat.createPool,
    mysql: mysqlCompat,
    mysql2: mysqlCompat,
    enableMySQLCompat,
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
};
