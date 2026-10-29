'use strict';
/**
 * XQL ↔ JSQL 适配器（浅集成）
 *
 * 把 JSQL 表加载成 XQL 集合，只读：加载后可用 XQL 查询与索引，
 * 不做写回（XQL 目前没有 UPDATE / DELETE / 持久化）。
 *
 * 适配任何实现了 `find(table, filter, opts) -> Promise<rows[]>` 的数据库对象
 * （JSQL 的 NativeJSQL / Database / WASM 均满足）。`find` 有默认 limit=100，
 * 所以这里自动分页把整表读出来。
 *
 * @example
 * const { xql } = require('@vexify/xql');
 * const coll = await xql.fromJSQL(db, 'users', {
 *   indexes: ['id', ['score', 'range']],
 * });
 * coll.query("SELECT name FROM users WHERE age > 18 ORDER BY name");
 */

async function fromJSQL(db, table, opts = {}) {
  if (!db || typeof db.find !== 'function') {
    throw new Error('fromJSQL: 需要一个实现了 find(table, filter, opts) 的数据库对象');
  }
  const { Collection } = require('../index.js');
  const pageSize = opts.pageSize || 1000;
  const rows = [];
  let offset = 0;
  for (;;) {
    const batch = await db.find(table, opts.filter || {}, { limit: pageSize, offset });
    if (!Array.isArray(batch) || batch.length === 0) break;
    rows.push(...batch);
    if (batch.length < pageSize) break;
    offset += batch.length;
  }
  const coll = new Collection(table, rows);
  if (opts.indexes) {
    for (const spec of opts.indexes) {
      const field = Array.isArray(spec) ? spec[0] : spec;
      const type = Array.isArray(spec) ? spec[1] : null;
      coll.index(field, type);
    }
  }
  return coll;
}

module.exports = { fromJSQL };
