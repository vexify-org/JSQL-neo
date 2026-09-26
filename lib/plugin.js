/**
 * JSQL-NEO 可编程插件系统
 *
 * 统一的插件运行时，被 native / wasm / js 三个引擎共用，开放四类扩展点：
 *   1. 生命周期钩子（HOOKS）——在引擎操作前后触发，返回 false 可中止操作；
 *   2. 事件监听（onEvent / emit）——操作完成后广播；
 *   3. 上下文接口（ctx）——插件拿到引擎能力、schema、日志、配置与私有存储；
 *   4. 插件 API（api / db.plugin(name)）——插件对外暴露可编程接口。
 *
 * 约定：钩子内不要调用会再次触发钩子的引擎方法（native 引擎会抛
 * ER_PLUGIN_REENTRY 保护 N-API 不崩溃）；需要修改数据时直接原地修改传入的
 * 数组 / 对象，返回 undefined；返回 false 表示中止本次操作。
 */

/** 内置生命周期钩子名（自定义钩子名也会被自动登记，无需在此声明） */
const HOOKS = Object.freeze([
  'beforeInsert', 'afterInsert',
  'beforeUpdate', 'afterUpdate',
  'beforeDelete', 'afterDelete',
  'beforeFind', 'afterFind',
  'beforeCreateTable', 'afterCreateTable',
  'beforeDropTable', 'afterDropTable',
  'beforeFlush', 'afterFlush',
  'beforeCount', 'afterCount',
  'beforeQuery', 'afterQuery',
  'onStart', 'onStop'
]);

/** 创建一个预置了全部内置钩子的空注册表 */
function createHookRegistry() {
  const reg = {};
  for (const h of HOOKS) reg[h] = [];
  return reg;
}

class Plugin {
  /**
   * @param {string} name 插件名（用于 db.plugin(name) 取 API、私有存储隔离）
   * @param {object} [opts]
   * @param {string} [opts.version]
   * @param {object} [opts.hooks] { hookName: fn | fn[] }
   * @param {string[]} [opts.depends] 依赖的其它插件名
   * @param {number} [opts.priority]
   * @param {object} [opts.config] 传给插件的配置
   * @param {object} [opts.api] 插件对外暴露的接口对象
   * @param {function} [opts.onEvent]
   * @param {function} [opts.install] install(engine, ctx)
   */
  constructor(name, opts = {}) {
    this.name = name;
    this.version = opts.version || null;
    this.hooks = opts.hooks || {};
    this.depends = opts.depends || [];
    this.priority = opts.priority || 0;
    this.config = opts.config || {};
    this.api = opts.api || null;
    this._onEvent = opts.onEvent || null;
    this._install = opts.install || null;
  }

  onEvent(fn) {
    this._onEvent = fn;
    return this;
  }

  /** 注册钩子；同名钩子可多次注册，按注册顺序执行 */
  on(hook, fn) {
    if (!this.hooks[hook]) this.hooks[hook] = [];
    if (!Array.isArray(this.hooks[hook])) this.hooks[hook] = [this.hooks[hook]];
    this.hooks[hook].push(fn);
    return this;
  }

  install(fn) {
    this._install = fn;
    return this;
  }

  /** 声明插件对外暴露的接口 */
  expose(api) {
    this.api = api;
    return this;
  }

  build() {
    const inst = {
      name: this.name,
      version: this.version,
      hooks: this.hooks,
      depends: this.depends,
      priority: this.priority,
      config: this.config
    };
    if (this.api) inst.api = this.api;
    if (this._onEvent) inst.onEvent = this._onEvent;
    if (this._install) inst.install = this._install;
    return inst;
  }
}

/** 以函数式风格定义插件：definePlugin('name', { hooks, api, install }) */
function definePlugin(name, def = {}) {
  return new Plugin(name, def).build();
}

/** 登记单个钩子；未知钩子名会自动创建，便于插件自定义扩展点 */
function registerHook(engine, hook, fn) {
  if (typeof fn !== 'function') return engine;
  if (!engine._hooks) engine._hooks = createHookRegistry();
  if (!engine._hooks[hook]) engine._hooks[hook] = [];
  engine._hooks[hook].push(fn);
  return engine;
}

/** 把一个插件声明的所有钩子登记到引擎上 */
function registerHooks(engine, plugin) {
  if (!plugin || !plugin.hooks) return engine;
  for (const [hook, val] of Object.entries(plugin.hooks)) {
    const fns = Array.isArray(val) ? val : [val];
    for (const fn of fns) registerHook(engine, hook, fn);
  }
  return engine;
}

/** 引擎 → 插件 API 注册表 */
function getPluginApis(engine) {
  if (!engine._pluginApis) engine._pluginApis = new Map();
  return engine._pluginApis;
}

/** 引擎 → 插件私有存储（按插件名隔离） */
function getPluginStore(engine, name) {
  if (!engine._pluginStores) engine._pluginStores = new Map();
  if (!engine._pluginStores.has(name)) engine._pluginStores.set(name, new Map());
  return engine._pluginStores.get(name);
}

/**
 * 构建插件上下文。优先走引擎自身的公开方法，缺失时回退到约定的内部字段，
 * 使三个引擎共享同一套插件 API。
 */
function buildPluginContext(engine, plugin) {
  const name = plugin.name || 'anonymous';
  const version = plugin.version || null;
  const store = getPluginStore(engine, name);
  const ctx = {
    name,
    version,
    engine,
    plugin,
    config: plugin.config || {},
    store,
    /** 注册生命周期钩子 / 自定义钩子 */
    on(hook, fn) { return engine.on(hook, fn); },
    /** 注册事件监听 */
    onEvent(fn) { return engine.onEvent(fn); },
    /** 广播事件 */
    emit(eventName, data) { return engine.emit(eventName, data); },
    /** 主动触发一个钩子（含自定义钩子） */
    hook(hookName, ...args) { return engine.runHook(hookName, ...args); },
    /** 组合：加载另一个插件 */
    use(other, opts) { return engine.use(other, opts); },
    /** 表清单（同步） */
    tables() {
      if (engine._tableNames) return Array.from(engine._tableNames);
      if (typeof engine.getTables === 'function') return engine.getTables();
      return [];
    },
    /** 表是否存在 */
    hasTable(t) {
      if (typeof engine.hasTable === 'function') return engine.hasTable(t);
      return !!(engine._tableNames && engine._tableNames.has(t));
    },
    /** 表 schema（同步，可能为 null） */
    getTableSchema(t) {
      if (engine._schemas && engine._schemas[t] !== undefined) return engine._schemas[t];
      if (typeof engine.getTableSchema === 'function') return engine.getTableSchema(t);
      return null;
    },
    /** 带插件名前缀的日志 */
    log(...args) { console.log(`[jsql:${name}]`, ...args); },
    /** 运行期声明插件 API */
    expose(api) {
      plugin.api = api;
      getPluginApis(engine).set(name, api);
      return api;
    }
  };
  return ctx;
}

/**
 * 把一个插件应用到引擎：登记钩子、调用 install、挂载事件与 API。
 * 引擎的 `use()` 只需 `return applyPlugin(this, plugin, opts)`。
 * @returns {object} engine（便于链式调用）
 */
function applyPlugin(engine, plugin, opts) {
  // 字符串 → 内置插件名（懒加载，避免与 plugins/index 形成加载期循环依赖）
  if (typeof plugin === 'string') {
    plugin = require('./plugins').resolve(plugin, opts);
  }
  if (typeof plugin === 'function') plugin = { install: plugin };
  if (!plugin || typeof plugin !== 'object') {
    throw new Error('use: plugin must be an object, a function, or a builtin plugin name');
  }
  if (!engine._plugins) engine._plugins = [];
  if (!engine._eventListeners) engine._eventListeners = [];

  registerHooks(engine, plugin);

  const ctx = buildPluginContext(engine, plugin);
  if (typeof plugin.install === 'function') plugin.install(engine, ctx);
  if (typeof plugin.onEvent === 'function') engine._eventListeners.push(plugin.onEvent);

  engine._plugins.push(plugin);
  if (plugin.name && plugin.api) getPluginApis(engine).set(plugin.name, plugin.api);
  return engine;
}

/**
 * 运行某个钩子链。
 * - 任一钩子返回 false → 中止（返回 false），引擎据此跳过本次操作；
 * - native 引擎置 `_forbidReentry`，钩子内再次触发引擎操作会抛 ER_PLUGIN_REENTRY。
 */
function runHooks(engine, hookName, args) {
  const hooks = engine._hooks && engine._hooks[hookName];
  if (!hooks || hooks.length === 0) return true;

  const guard = !!engine._forbidReentry;
  if (guard) {
    if (engine._inHook) {
      throw new Error('ER_PLUGIN_REENTRY: plugin hook "' + hookName +
        '" re-entered native call; plugin must not call engine methods inside its own hook');
    }
    engine._inHook = true;
  }
  try {
    for (const fn of hooks) {
      if (fn(...args) === false) return false;
    }
    return true;
  } finally {
    if (guard) engine._inHook = false;
  }
}

module.exports = {
  HOOKS,
  Plugin,
  definePlugin,
  createHookRegistry,
  registerHook,
  registerHooks,
  buildPluginContext,
  applyPlugin,
  runHooks,
  getPluginApis,
  getPluginStore
};