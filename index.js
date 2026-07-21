// © Vexify 2026 All Rights Reserved.
/**
 * JSQL-NEO — Pure JavaScript Embedded Database
 * v1.3.0 — 窗口函数、视图、触发器、全文搜索、CSV、stats、多数据库
 *
 * @example
 * const jsql = require('jsql-neo');
 * const db = new jsql.Database('mydb.json');
 */

module.exports = {
    Database: require('./lib/database'),
    Table: require('./lib/table'),
    Query: require('./lib/query')
};