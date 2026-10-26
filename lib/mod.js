const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const vm = require('vm');

const DEFAULT_CONFIG_PATH = path.join(os.homedir(), '.config', 'jsql', 'mod.config');
const CONFIG_PATH = process.env.JSQL_MOD_CONFIG || DEFAULT_CONFIG_PATH;

class ModApi {
  constructor(collector) {
    this._collector = collector;
  }

  nameset(name) {
    if (typeof name !== 'string' || !name) {
      throw new Error('nameset: module name must be a non-empty string');
    }
    if (this._collector.nameSet) {
      throw new Error('nameset: module name already declared');
    }
    this._collector.name = name;
    this._collector.nameSet = true;
  }

  priority(n) {
    this._collector.priority = n;
    return this;
  }

  depends(name) {
    if (typeof name === 'string') name = [name];
    for (const d of name) {
      if (typeof d !== 'string' || !d) {
        throw new Error('depends: dependency names must be non-empty strings');
      }
    }
    this._collector.depends = [...(this._collector.depends || []), ...name];
    return this;
  }

  api(obj) {
    if (typeof obj !== 'object' || obj === null) {
      throw new Error('api: must be an object');
    }
    this._collector.api = obj;
    return this;
  }

  on(hook, fn) {
    if (typeof fn !== 'function') throw new Error('on: hook must be a function');
    if (!this._collector.hooks[hook]) this._collector.hooks[hook] = [];
    this._collector.hooks[hook].push(fn);
    return this;
  }

  onEvent(fn) {
    if (typeof fn !== 'function') throw new Error('onEvent: must be a function');
    this._collector.onEvent = fn;
    return this;
  }

  install(fn) {
    if (typeof fn !== 'function') throw new Error('install: must be a function');
    this._collector.install = fn;
    return this;
  }
}

class ModuleManager {
  constructor(configPath = CONFIG_PATH) {
    this._configPath = configPath;
    this._modules = [];
    this._load();
  }

  _load() {
    try {
      if (!fs.existsSync(this._configPath)) return;
      const data = JSON.parse(fs.readFileSync(this._configPath, 'utf8'));
      if (Array.isArray(data)) {
        this._modules = data;
      } else if (Array.isArray(data.modules)) {
        this._modules = data.modules;
      }
    } catch (e) {
      // P3-20: 配置损坏时静默清空模块表——不应丢弃已有模块
      // 保留已有模块，只记录警告
      console.warn('[mod] Failed to load config, keeping existing modules:', e.message);
    }
  }

  save() {
    const dir = path.dirname(this._configPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(this._configPath, JSON.stringify({ modules: this._modules }, null, 2), 'utf8');
    try { fs.chmodSync(this._configPath, 0o600); } catch (e) {}
  }

  list() {
    return this._modules.map(m => ({ ...m }));
  }

  find(name) {
    return this._modules.find(m => m.name === name) || null;
  }

  add(address, opts = {}) {
    const resolved = path.resolve(address);
    // 防止 path traversal 攻击：resolved 必须在 cwd 之下
    // P1-44: startsWith(cwd) 不够——/etc/passwd 匹配 /etc 前缀
    // 必须要求 cwd + path.sep 前缀，或 resolved 恰好等于 cwd（目录场景）
    const cwdWithSep = process.cwd() + path.sep;
    if (!resolved.startsWith(cwdWithSep)) throw new Error('Module path outside working directory: ' + address);
    if (!fs.existsSync(resolved)) {
      throw new Error(`Module file not found: ${resolved}`);
    }
    if (fs.statSync(resolved).isDirectory()) {
      throw new Error(`Expected a module file, got directory: ${resolved}`);
    }

    const plugin = this._loadModuleFile(resolved);
    const name = plugin.name;

    if (this.find(name)) {
      throw new Error(`Module already registered: ${name}`);
    }

    const entry = {
      name,
      path: resolved,
      enabled: false,
      priority: plugin.priority || 0,
      depends: plugin.depends || [],
      addedAt: Date.now()
    };
    this._modules.push(entry);
    this.save();
    return { ...entry };
  }

  enable(name, opts = {}) {
    const m = this.find(name);
    if (!m) throw new Error(`Module not found: ${name}. Use 'jsql mod add --address <path>' first.`);
    if (m.enabled) return { ...m, ok: true, message: 'already enabled' };

    const enabling = this._enablingStack || (this._enablingStack = new Set());
    if (enabling.has(name)) throw new Error(`Circular module dependency: ${[...enabling, name].join(' -> ')}`);
    enabling.add(name);

    try {
      const plugin = this._loadModuleFile(m.path);

      if (plugin.depends && plugin.depends.length > 0) {
        for (const dep of plugin.depends) {
          const depMod = this.find(dep);
          if (!depMod) throw new Error(`Module '${name}' depends on '${dep}' which is not registered`);
          if (!depMod.enabled && opts.withDeps !== false) {
            this.enable(dep, opts);
          }
        }
      }

      m.enabled = true;
      m.priority = plugin.priority || m.priority || 0;
      this.save();
      return { ...m, ok: true };
    } finally {
      enabling.delete(name);
    }
  }

  disable(name) {
    const m = this.find(name);
    if (!m) throw new Error(`Module not found: ${name}`);
    if (!m.enabled) return { ...m, ok: true, message: 'already disabled' };
    // P3-21: 不应全量 require 所有模块来检查依赖——只检查已启用的
    for (const other of this._modules) {
      if (!other.enabled) continue;
      const plugin = this._loadModuleFile(other.path);
      if (plugin.depends && plugin.depends.includes(name)) {
        this.disable(other.name);
      }
    }
    m.enabled = false;
    this.save();
    return { ...m, ok: true };
  }

  enableAll() {
    const names = this._modules.map(m => m.name);
    for (const name of names) {
      try { this.enable(name); } catch (e) { /* skip failed */ }
    }
    this.save();
    return this.list().filter(m => m.enabled).length;
  }

  disableAll() {
    for (const m of this._modules) m.enabled = false;
    this.save();
    return this._modules.length;
  }

  applyTo(db) {
    const enabled = this._sortEnabled();
    for (const entry of enabled) {
      const plugin = this._loadModuleFile(entry.path);
      db.use(plugin);
    }
    return db;
  }

  api(name) {
    const m = this.find(name);
    if (!m) throw new Error(`Module not found: ${name}`);
    const plugin = this._loadModuleFile(m.path);
    return plugin.api || null;
  }

  _sortEnabled() {
    const enabled = this._modules.filter(m => m.enabled).map(m => ({ ...m }));
    const resolved = new Set();
    const order = [];
    const cache = new Map();

    const resolve = (name, chain) => {
      if (resolved.has(name)) return 0;
      const entry = enabled.find(m => m.name === name);
      if (!entry) return 0;
      if (chain.has(name)) throw new Error(`Circular module dependency: ${[...chain, name].join(' -> ')}`);

      let plugin;
      if (cache.has(entry.path)) {
        plugin = cache.get(entry.path);
      } else {
        plugin = this._loadModuleFile(entry.path);
        cache.set(entry.path, plugin);
      }

      let maxDepDepth = -1;
      for (const dep of (plugin.depends || [])) {
        const d = resolve(dep, new Set([...chain, name]));
        maxDepDepth = Math.max(maxDepDepth, d);
      }
      resolved.add(name);
      order.push({ entry, depth: maxDepDepth + 1 });
      return maxDepDepth + 1;
    };

    for (const entry of enabled) resolve(entry.name, new Set());

    // 依赖深度优先，同层按 priority 排序：保证被依赖方始终先应用
    order.sort((a, b) => a.depth - b.depth || (a.entry.priority || 0) - (b.entry.priority || 0));
    return order.map(o => o.entry);
  }

  remove(name) {
    const idx = this._modules.findIndex(m => m.name === name);
    if (idx === -1) throw new Error(`Module not found: ${name}`);
    const [removed] = this._modules.splice(idx, 1);
    this.save();
    return removed;
  }

  get(name) {
    const m = this.find(name);
    if (!m) throw new Error(`Module not found: ${name}`);
    return this._loadModuleFile(m.path);
  }

  _loadModuleFile(filePath) {
    const ext = path.extname(filePath).toLowerCase();

    if (ext === '.json') {
      const obj = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      return {
        name: obj.name || path.basename(filePath, ext),
        ...obj
      };
    }

    // JS 模块默认在受限 vm 沙箱中运行：不暴露 require/process/Buffer。
    // 需要这些能力时必须显式设置 JSQL_ALLOW_UNSAFE_MODULES=1（信任该模块）。
    const resolved = path.isAbsolute(filePath) ? filePath : require.resolve(filePath);
    delete require.cache[resolved];
    let plugin;
    try {
      const code = fs.readFileSync(resolved, 'utf8');
      const unsafe = process.env.JSQL_ALLOW_UNSAFE_MODULES === '1';
      // 空对象作为沙箱：module/exports 在沙箱内部创建，避免把宿主对象带进去
      const context = vm.createContext(Object.create(null), {
        codeGeneration: { strings: unsafe, wasm: unsafe },
      });
      context.__filename = resolved;
      context.__dirname = path.dirname(resolved);
      if (unsafe) {
        context.require = require;
        context.process = process;
        context.Buffer = Buffer;
        context.console = console;
      }
      vm.runInContext(
        'globalThis.module = { exports: {} }; globalThis.exports = module.exports;' +
        (unsafe ? '' : 'globalThis.console = Object.freeze({ log(){}, info(){}, warn(){}, error(){} });'),
        context,
        { timeout: 1000 }
      );
      vm.runInContext(code, context, { filename: resolved, timeout: 5000 });
      plugin = vm.runInContext('module.exports', context, { timeout: 1000 });
    } catch (e) {
      const hint = process.env.JSQL_ALLOW_UNSAFE_MODULES !== '1' && /is not defined/.test(e.message || '')
        ? '\nJS modules run in a restricted sandbox. Set JSQL_ALLOW_UNSAFE_MODULES=1 to allow require/process/Buffer (trusted code only).'
        : '';
      throw new Error(`Failed to load module ${filePath}: ${e.message}${hint}`);
    }
    if (typeof plugin === 'function') {
      return { install: plugin, name: path.basename(filePath, ext) };
    }
    if (!plugin.name) plugin.name = path.basename(filePath, ext);
    return plugin;
  }
}

module.exports = { ModuleManager, ModApi, CONFIG_PATH };
