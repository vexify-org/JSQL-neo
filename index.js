// © Vexify 2026 All Rights Reserved.
/**
 * JSQL-NEO — Pure JavaScript Embedded Database
 * v2.0.0 — B-Tree 索引、WAL、哈希 JOIN、错误码体系、事务隔离
 *
 * @example
 * const jsql = require('jsql-neo');
 * const db = new jsql.Database('mydb.json', { wal: true, fileLock: true });
 */

module.exports = {
    Database: require('./lib/database'),
    Table: require('./lib/table'),
    Query: require('./lib/query'),
    BTree: require('./lib/btree'),
    JSQL_Error: require('./lib/errors').JSQL_Error,
    ErrorCodes: require('./lib/errors').ErrorCodes
};