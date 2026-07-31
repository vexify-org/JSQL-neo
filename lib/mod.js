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
      this._modules = [];
    }
  }

  save() {
    const dir = path.dirname(this._configPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(this._configPath, JSON.stringify({ modules: this._modules }, null, 2), 'utf8');
  }

  list() {
    return this._modules.map(m => ({ ...m }));
  }

  find(name) {
    return this._modules.find(m => m.name === name) || null;
  }

  add(address) {
    const resolved = path.resolve(address);
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
  }

  disable(name) {
    const m = this.find(name);
    if (!m) throw new Error(`Module not found: ${name}`);
    if (!m.enabled) return { ...m, ok: true, message: 'already disabled' };
    for (const other of this._modules) {
      const plugin = this._loadModuleFile(other.path);
      if (plugin.depends && plugin.depends.includes(name) && other.enabled) {
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
      if (resolved.has(name)) return;
      const entry = enabled.find(m => m.name === name);
      if (!entry) return;
      if (chain.has(name)) throw new Error(`Circular module dependency: ${[...chain, name].join(' -> ')}`);

      let plugin;
      if (cache.has(entry.path)) {
        plugin = cache.get(entry.path);
      } else {
        plugin = this._loadModuleFile(entry.path);
        cache.set(entry.path, plugin);
      }

      for (const dep of (plugin.depends || [])) {
        resolve(dep, new Set([...chain, name]));
      }
      resolved.add(name);
      order.push(entry);
    };

    for (const entry of enabled) resolve(entry.name, new Set());

    order.sort((a, b) => (a.priority || 0) - (b.priority || 0));
    return order;
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

    const code = fs.readFileSync(filePath, 'utf8');
    const collector = { name: null, nameSet: false, hooks: {} };
    const sandboxModule = new Module(filePath, module);
    sandboxModule.filename = filePath;
    sandboxModule.paths = Module._nodeModulePaths(path.dirname(filePath));
    const sandboxRequire = Module.createRequire(filePath);

    const jsqlMod = new ModApi(collector);
    const context = vm.createContext({
      module: sandboxModule,
      exports: sandboxModule.exports,
      require: sandboxRequire,
      __filename: filePath,
      __dirname: path.dirname(filePath),
      console,
      process,
      Buffer,
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
      URL,
      URLSearchParams,
      TextEncoder,
      TextDecoder,
      jsql: { mod: jsqlMod }
    });

    try {
      vm.runInContext(code, context, { filename: filePath });
    } catch (e) {
      throw new Error(`Failed to load module ${filePath}: ${e.message}`);
    }

    const sandboxExports = sandboxModule.exports;
    const hasExports = sandboxExports && Object.keys(sandboxExports).length > 0;
    const plugin = hasExports ? sandboxExports : {
      hooks: collector.hooks,
      onEvent: collector.onEvent,
      install: collector.install
    };

    const meta = {
      name: collector.name || plugin.name || path.basename(filePath, ext),
      priority: collector.priority !== undefined ? collector.priority : plugin.priority,
      depends: collector.depends || plugin.depends,
      api: collector.api || plugin.api
    };
    for (const [k, v] of Object.entries(meta)) {
      if (v !== undefined && v !== null) plugin[k] = v;
    }
    return plugin;
  }
}

module.exports = { ModuleManager, ModApi, CONFIG_PATH };
