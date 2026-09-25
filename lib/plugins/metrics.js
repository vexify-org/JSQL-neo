/**
 * metrics —— 统计各类操作的次数，通过 db.plugin('metrics') 读取。
 *
 * @example
 * db.use(require('jsql-neo/lib/plugins').metrics());
 * db.plugin('metrics').snapshot();   // { insert: 3, update: 1, find: 5, ... }
 * db.plugin('metrics').reset();
 */
const { definePlugin } = require('../plugin');

function createMetrics(opts = {}) {
  const counters = {};

  const bump = (key, n = 1) => { counters[key] = (counters[key] || 0) + n; };
  const rowCount = rows => (Array.isArray(rows) ? rows.length : 1);

  return definePlugin('metrics', {
    api: {
      snapshot: () => ({ ...counters }),
      get: key => counters[key] || 0,
      reset: () => { for (const k of Object.keys(counters)) delete counters[k]; }
    },
    hooks: {
      afterInsert(_t, rows) { bump('insert', rowCount(rows)); bump('insertOps'); },
      afterUpdate() { bump('update'); },
      afterDelete() { bump('delete'); },
      afterFind() { bump('find'); },
      afterCount() { bump('count'); },
      afterQuery() { bump('query'); },
      afterCreateTable() { bump('createTable'); },
      afterDropTable() { bump('dropTable'); },
      onStart() { bump('start'); },
      onStop() { bump('stop'); }
    }
  });
}

module.exports = { createMetrics, metrics: createMetrics };