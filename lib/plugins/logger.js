/**
 * logger —— 把数据库操作记录到自定义 logger。
 *
 * @example
 * db.use(require('jsql-neo/lib/plugins').logger({ logger: myLogger, tables: ['users'] }));
 */
const { definePlugin } = require('../plugin');

function count(rows) {
  if (Array.isArray(rows)) return rows.length;
  return rows === undefined || rows === null ? 0 : 1;
}

function createLogger(opts = {}) {
  const logger = typeof opts.logger === 'function' ? opts.logger : (...a) => console.log('[jsql]', ...a);
  const only = opts.tables ? new Set(opts.tables) : null;
  const show = t => !only || only.has(t);

  return definePlugin('logger', {
    config: { tables: opts.tables || null },
    hooks: {
      afterInsert(table, rows) { if (show(table)) logger(`insert ${table} +${count(rows)}`); },
      afterUpdate(table) { if (show(table)) logger(`update ${table}`); },
      afterDelete(table) { if (show(table)) logger(`delete ${table}`); },
      afterFind(table) { if (opts.logFinds && show(table)) logger(`find ${table}`); },
      afterQuery(sql) { if (opts.logQueries) logger(`query ${sql}`); },
      afterCreateTable(name) { if (show(name)) logger(`createTable ${name}`); },
      afterDropTable(name) { if (show(name)) logger(`dropTable ${name}`); },
      onStart() { logger('engine start'); },
      onStop() { logger('engine stop'); }
    }
  });
}

module.exports = { createLogger, logger: createLogger };