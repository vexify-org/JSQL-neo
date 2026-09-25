/**
 * JSQL-NEO 内置插件集
 *
 * 每个插件都是「工厂函数」，调用后返回可交给 `db.use()` 的插件对象。
 * 也可以直接用名字加载：`db.use('logger')` / `db.use('timestamps', { ... })`。
 *
 * @example
 * const plugins = require('jsql-neo/lib/plugins');
 * db.use(plugins.timestamps());
 * db.use(plugins.logger({ logger: myLog }));
 * db.use(plugins.metrics());
 * const audit = db.plugin('audit');
 */
const { createTimestamps } = require('./timestamps');
const { createLogger } = require('./logger');
const { createMetrics } = require('./metrics');
const { createAudit } = require('./audit');
const { createValidation } = require('./validation');

/** 名称 → 插件工厂 */
const builtins = {
  timestamps: createTimestamps,
  logger: createLogger,
  metrics: createMetrics,
  audit: createAudit,
  validation: createValidation
};

/** 内置插件名清单 */
function list() {
  return Object.keys(builtins);
}

/**
 * 按名字构造内置插件。
 * @param {string} name
 * @param {object} [opts]
 * @returns {object} 插件对象，可直接 db.use()
 */
function create(name, opts = {}) {
  const factory = builtins[name];
  if (!factory) {
    throw new Error(`Unknown builtin plugin: ${name}. Available: ${list().join(', ')}`);
  }
  return factory(opts);
}

/**
 * 名称或插件对象 → 插件对象。供引擎的 `use()` 解析字符串用。
 * 插件对象原样返回；字符串走内置注册表。
 */
function resolve(nameOrPlugin, opts) {
  if (typeof nameOrPlugin === 'string') return create(nameOrPlugin, opts);
  return nameOrPlugin;
}

module.exports = {
  createTimestamps,
  createLogger,
  createMetrics,
  createAudit,
  createValidation,
  timestamps: createTimestamps,
  logger: createLogger,
  metrics: createMetrics,
  audit: createAudit,
  validation: createValidation,
  builtins,
  list,
  create,
  resolve
};