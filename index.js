/**
 * JSQL-NEO v3.1.0 — Rust-Powered Embedded Database (WASM + HTTP)
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
    createMysqlServer,
    MysqlServer,
};
