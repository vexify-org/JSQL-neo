class Plugin {
  constructor(name, opts = {}) {
    this.name = name;
    this.hooks = opts.hooks || {};
    this._onEvent = opts.onEvent || null;
    this._install = opts.install || null;
  }

  onEvent(fn) {
    this._onEvent = fn;
    return this;
  }

  on(hook, fn) {
    this.hooks[hook] = fn;
    return this;
  }

  install(fn) {
    this._install = fn;
    return this;
  }

  build() {
    const inst = {
      name: this.name,
      hooks: this.hooks
    };
    if (this._onEvent) inst.onEvent = this._onEvent;
    if (this._install) inst.install = this._install;
    return inst;
  }
}

module.exports = { Plugin };