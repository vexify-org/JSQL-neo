/**
 * audit —— 记录数据变更审计日志（内存环形缓冲）。
 *
 * @example
 * db.use(require('jsql-neo/lib/plugins').audit({ limit: 500 }));
 * db.plugin('audit').entries();   // [{ at, op, table, count }]
 */
const { definePlugin } = require('../plugin');

function createAudit(opts = {}) {
  const limit = opts.limit || 1000;
  const entries = [];

  const push = e => {
    entries.push({ at: Date.now(), ...e });
    if (entries.length > limit) entries.splice(0, entries.length - limit);
  };
  const rowCount = rows => (Array.isArray(rows) ? rows.length : 1);

  return definePlugin('audit', {
    config: { limit },
    api: {
      entries: () => entries.map(e => ({ ...e })),
      size: () => entries.length,
      clear: () => { entries.length = 0; }
    },
    hooks: {
      afterInsert(table, rows) { push({ op: 'insert', table, count: rowCount(rows) }); },
      afterUpdate(table) { push({ op: 'update', table }); },
      afterDelete(table) { push({ op: 'delete', table }); },
      afterCreateTable(name) { push({ op: 'createTable', table: name }); },
      afterDropTable(name) { push({ op: 'dropTable', table: name }); }
    }
  });
}

module.exports = { createAudit, audit: createAudit };