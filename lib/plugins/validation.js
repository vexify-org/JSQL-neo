/**
 * validation —— 基于表 schema 的插入/更新校验，跨引擎行为一致。
 *
 * 校验项：not null（插入）、字段类型、maxLength、min/max，以及自定义校验函数。
 * 违反时抛出 `ER_VALIDATION: table.field ...`。
 *
 * @example
 * db.use(require('jsql-neo/lib/plugins').validation({
 *   validators: { users: { email: v => /@/.test(v) || 'invalid email' } }
 * }));
 */
const { definePlugin } = require('../plugin');

function normalizeFieldDef(def) {
  if (typeof def === 'string') {
    const s = def.toLowerCase();
    const has = re => new RegExp(re).test(s);
    const type = s
      .replace(/\bprimary\s+key\b/g, '')
      .replace(/\bauto_?increment\b/g, '')
      .replace(/\bnot\s+null\b/g, '')
      .replace(/\bunique\b/g, '')
      .replace(/\bdefault\s+\S+/g, '')
      .trim();
    return {
      type: type || 'string',
      required: has('\\bnot\\s+null\\b'),
      primaryKey: has('\\bprimary\\s+key\\b'),
      autoIncrement: has('\\bauto_?increment\\b'),
      hasDefault: has('\\bdefault\\s+\\S+')
    };
  }
  if (def && typeof def === 'object') {
    return {
      type: String(def.type || 'string').toLowerCase(),
      required: !!(def.required || def.notNull || def.not_null),
      nullable: def.nullable,
      primaryKey: !!(def.primaryKey || def.primary_key),
      autoIncrement: !!(def.autoIncrement || def.auto_increment),
      hasDefault: def.default !== undefined,
      maxLength: def.maxLength !== undefined ? def.maxLength : def.length,
      min: def.min,
      max: def.max
    };
  }
  return { type: 'string' };
}

const TYPE_OF = {
  string: v => typeof v === 'string',
  text: v => typeof v === 'string',
  varchar: v => typeof v === 'string',
  char: v => typeof v === 'string',
  integer: v => Number.isInteger(v),
  int: v => Number.isInteger(v),
  bigint: v => typeof v === 'bigint' || Number.isInteger(v),
  float: v => typeof v === 'number' && Number.isFinite(v),
  double: v => typeof v === 'number' && Number.isFinite(v),
  number: v => typeof v === 'number' && Number.isFinite(v),
  numeric: v => typeof v === 'number' && Number.isFinite(v),
  decimal: v => typeof v === 'number' && Number.isFinite(v),
  boolean: v => typeof v === 'boolean',
  bool: v => typeof v === 'boolean',
  json: v => typeof v === 'object' && v !== null && !Array.isArray(v),
  object: v => typeof v === 'object' && v !== null && !Array.isArray(v),
  array: v => Array.isArray(v),
  date: v => typeof v === 'string' || v instanceof Date,
  datetime: v => typeof v === 'string' || v instanceof Date,
  timestamp: v => typeof v === 'string' || v instanceof Date
};

function checkValue(table, field, def, value, row, custom) {
  const isNull = value === undefined || value === null;
  const fail = msg => { throw new Error(`ER_VALIDATION: ${table}.${field} ${msg}`); };

  if (isNull) {
    if (def.required && !def.hasDefault && def.nullable !== true) fail('is required');
    return;
  }
  const type = def.type;
  const checker = TYPE_OF[type];
  if (checker && !checker(value)) fail(`expected ${type}, got ${typeof value}`);
  if (def.maxLength !== undefined && typeof value === 'string' && value.length > def.maxLength) {
    fail(`length > ${def.maxLength}`);
  }
  if (def.min !== undefined && typeof value === 'number' && value < def.min) fail(`< ${def.min}`);
  if (def.max !== undefined && typeof value === 'number' && value > def.max) fail(`> ${def.max}`);
  if (typeof custom === 'function') {
    const r = custom(value, row);
    if (r === false) fail('custom validator failed');
    if (typeof r === 'string') fail(r);
  }
}

function createValidation(opts = {}) {
  const validators = opts.validators || {};

  const validateRow = (ctx, table, row, { partial }) => {
    const schema = ctx.getTableSchema(table);
    if (!schema) return;
    const tableValidators = validators[table] || {};
    for (const [field, rawDef] of Object.entries(schema)) {
      const def = normalizeFieldDef(rawDef);
      if (partial && !(field in row)) continue;
      checkValue(table, field, def, row[field], row, tableValidators[field] || validators[field]);
    }
  };

  const validateMany = (ctx, table, rows, partial) => {
    if (Array.isArray(rows)) rows.forEach(r => validateRow(ctx, table, r, { partial }));
    else if (rows && typeof rows === 'object') validateRow(ctx, table, rows, { partial });
  };

  return definePlugin('validation', {
    install(engine, ctx) { ctx.config = ctx.config || {}; },
    hooks: {
      beforeInsert(table, rows) { validateMany(this._ctx, table, rows, false); },
      beforeUpdate(table, second, third) {
        if (third !== undefined) { validateMany(this._ctx, table, third, true); return; }
        if (Array.isArray(second)) for (const p of second) if (Array.isArray(p)) validateMany(this._ctx, table, p[1], true);
      }
    }
  });
}

module.exports = { createValidation, validation: createValidation };