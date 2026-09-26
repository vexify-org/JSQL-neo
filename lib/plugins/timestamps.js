/**
 * timestamps —— 自动维护创建/更新时间戳。
 *
 * 在插入时补全 createdAt / updatedAt（已存在则不覆盖 createdAt），
 * 更新时刷新 updatedAt。建表时若 schema 未声明这两个字段，会原地补上，
 * 以便 native / WASM 引擎按 schema 列持久化。钩子内只原地修改数据、不回调引擎。
 *
 * @example
 * db.use(require('jsql-neo/lib/plugins').timestamps());
 * db.use(require('jsql-neo/lib/plugins').timestamps({ createdField: 'created_at', updatedField: 'updated_at' }));
 */
const { definePlugin } = require('../plugin');

function createTimestamps(opts = {}) {
  const createdField = opts.createdField || 'createdAt';
  const updatedField = opts.updatedField || 'updatedAt';
  const now = typeof opts.now === 'function' ? opts.now : () => new Date().toISOString();

  const stampRow = (row, isInsert) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) return;
    const t = now();
    if (isInsert && row[createdField] === undefined) row[createdField] = t;
    if (row[updatedField] === undefined || opts.overwriteUpdated) row[updatedField] = t;
  };

  const stampDef = { type: 'string' };

  const ensureStampFields = (schema) => {
    if (!schema) return;
    if (typeof schema === 'string') return;
    if (typeof schema !== 'object') return;
    if (schema[createdField] === undefined) schema[createdField] = { ...stampDef };
    if (schema[updatedField] === undefined) schema[updatedField] = { ...stampDef };
  };

  return definePlugin('timestamps', {
    config: { createdField, updatedField },
    hooks: {
      beforeCreateTable(_name, schema) {
        ensureStampFields(schema);
      },
      beforeInsert(_table, rows) {
        if (Array.isArray(rows)) rows.forEach(r => stampRow(r, true));
        else stampRow(rows, true);
      },
      // 更新钩子有 [table, id, data] / [table, pairs] / [table, query, updates] 三种形态
      beforeUpdate(_table, second, third) {
        if (third !== undefined) { stampRow(third, false); return; }
        if (Array.isArray(second)) {
          for (const pair of second) if (Array.isArray(pair)) stampRow(pair[1], false);
        }
      }
    }
  });
}

module.exports = { createTimestamps, timestamps: createTimestamps };