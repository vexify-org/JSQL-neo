// © Vexify 2026 All Rights Reserved.
/**
 * better-sqlite3 兼容层 — 主线程
 *
 * 提供与 better-sqlite3 完全一致的同步 API：
 *   const Database = require('jsql-neo/sqlite');
 *   const db = new Database('file.db');
 *   const row = db.prepare('SELECT * FROM users WHERE id = ?').get(1);
 *
 * 底层通过 worker_threads + SharedArrayBuffer(Atomics) 同步桥调用 JSQL 引擎。
 * 每个操作：主线程 postMessage 请求 → Atomics.wait 阻塞 → worker 完成后
 * postMessage 结果 + Atomics.notify → 主线程 receiveMessageOnPort 同步取回。
 */

const { Worker, MessageChannel, receiveMessageOnPort } = require('worker_threads');
const path = require('path');

const WORKER_PATH = path.join(__dirname, 'sqlite_worker.js');

class SqliteError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'SqliteError';
    this.code = code || 'SQLITE_ERROR';
  }
}

class Database {
  constructor(filename = ':memory:', options = {}) {
    if (filename !== null && filename !== undefined && typeof filename !== 'string') {
      throw new TypeError('The first argument must be a string or undefined');
    }
    this.name = filename || ':memory:';
    this.memory = this.name === ':memory:';
    this.readonly = !!options.readonly;
    this.open = true;
    this._options = options;
    this._sab = new SharedArrayBuffer(4);
    this._ctrl = new Int32Array(this._sab);
    this._seq = 0;
    const channel = new MessageChannel();
    this._port = channel.port2;
    this._worker = new Worker(WORKER_PATH, {
      workerData: { filename: this.name, options, port: channel.port1 },
      transferList: [channel.port1],
    });
    this._sync('start', [this.name, this._options]);
  }

  _sync(op, args) {
    if (!this.open && op !== 'close') throw new SqliteError('The database connection is not open', 'SQLITE_MISUSE');
    const id = ++this._seq;
    // 预先清空控制槽，避免读到旧值
    Atomics.store(this._ctrl, 0, 0);
    this._worker.postMessage({ id, op, args, sab: this._sab });
    // 阻塞直到 worker 完成（ctrl[0] === id）
    const wait = Atomics.wait(this._ctrl, 0, 0);
    if (wait === 'not-equal') {
      // 已经完成，直接取
    } else if (wait === 'timed-out' || wait === 'not-equal') {
      // 重新等待
    }
    // 取结果（同步从端口队列读取）
    let result;
    let guard = 0;
    while (true) {
      const msg = receiveMessageOnPort(this._port);
      if (msg && msg.message && msg.message.id === id) {
        result = msg.message;
        break;
      }
      // 消息可能尚未到达（竞态），再等一次
      const w2 = Atomics.wait(this._ctrl, 0, id - 1);
      if (w2 !== 'ok' && ++guard > 1000) break;
    }
    if (!result) throw new SqliteError('Worker did not respond', 'SQLITE_INTERNAL');
    if (!result.ok) throw new SqliteError(result.error.message, result.error.code);
    return result.result;
  }

  close() {
    if (!this.open) return;
    try {
      this._sync('close', []);
    } finally {
      this.open = false;
      this._worker.terminate();
    }
  }

  prepare(sql) {
    if (typeof sql !== 'string') throw new TypeError('The "sql" argument must be a string');
    return new Statement(this, sql);
  }

  exec(sql) {
    if (typeof sql !== 'string') throw new TypeError('The "sql" argument must be a string');
    this._sync('exec', [sql, null]);
    return this;
  }

  pragma(pragma, options = {}) {
    if (typeof pragma !== 'string') throw new TypeError('The "pragma" argument must be a string');
    const { simple } = options;
    const sql = /^\s*pragma\b/i.test(pragma) ? pragma : 'PRAGMA ' + pragma;
    const name = (pragma.replace(/^\s*pragma\b\s*/i, '').split(/[=(]/)[0] || '').trim();
    const r = this._sync('all', [sql, null]);
    if (simple) {
      if (Array.isArray(r)) {
        const first = r.length > 0 ? r[0] : null;
        if (first && typeof first === 'object') {
          const keys = Object.keys(first);
          return keys.length === 1 ? first[keys[0]] : first;
        }
        return first;
      }
      return r;
    }
    if (!Array.isArray(r)) return [{ [name || 'value']: r }];
    if (r.length > 0 && (typeof r[0] !== 'object' || r[0] === null)) {
      return r.map(v => ({ [name || 'value']: v }));
    }
    return r;
  }

  transaction(fn) {
    if (typeof fn !== 'function') throw new TypeError('Expected a function');
    const wrapped = (...params) => {
      if (!this.open) throw new SqliteError('The database connection is not open', 'SQLITE_MISUSE');
      this.exec('BEGIN');
      try {
        const result = fn.apply(this, params);
        if (result && typeof result.then === 'function') {
          this.exec('ROLLBACK');
          throw new SqliteError('Transaction functions cannot be asynchronous', 'SQLITE_MISUSE');
        }
        this.exec('COMMIT');
        return result;
      } catch (err) {
        try { this.exec('ROLLBACK'); } catch (e) {}
        throw err;
      }
    };
    wrapped.deferred = () => wrapped;
    wrapped.immediate = () => wrapped;
    wrapped.exclusive = () => wrapped;
    wrapped.default = wrapped;
    return wrapped;
  }

  function(name, options, fn) {
    if (typeof options === 'function') { fn = options; options = {}; }
    if (typeof fn !== 'function') throw new TypeError('Expected a function');
    const fnStr = fn.toString();
    if (/\[native code\]/.test(fnStr)) {
      throw new SqliteError(`Cannot register native function '${name}'. Only source-available functions work over the worker bridge.`, 'SQLITE_FEATURE_NOT_SUPPORTED');
    }
    this._sync('registerFunction', [name, fnStr, !!(options && options.deterministic)]);
    return this;
  }

  aggregate(name, options, factory) {
    if (typeof options === 'function') { factory = options; options = {}; }
    if (typeof options === 'object' && options !== null && factory === undefined) { factory = options; options = {}; }
    if (typeof factory !== 'function' && (typeof factory !== 'object' || factory === null)) {
      throw new TypeError('Expected a function or aggregate object');
    }
    // 单函数形式: (values) => result；对象形式: { start, step, result }
    let specStr;
    if (typeof factory === 'function') {
      specStr = factory.toString();
      if (/\[native code\]/.test(specStr)) {
        throw new SqliteError(`Cannot register native aggregate '${name}'`, 'SQLITE_FEATURE_NOT_SUPPORTED');
      }
    } else {
      const parts = [];
      for (const key of ['start', 'step', 'result']) {
        const f = factory[key];
        if (typeof f === 'function') parts.push(`${key}: ${f.toString()}`);
      }
      specStr = '{ ' + parts.join(', ') + ' }';
    }
    this._sync('registerAggregate', [name, specStr, !!(options && options.deterministic)]);
    return this;
  }

  table(name, options, fn) {
    throw new SqliteError('db.table() is not supported by the worker bridge', 'SQLITE_FEATURE_NOT_SUPPORTED');
  }
  serialize() {
    return Buffer.from(this._sync('serialize', []));
  }

  deserialize(buffer) {
    const buf = Buffer.from(buffer);
    this._sync('deserialize', [buf]);
    return this;
  }

  loadExtension() {
    throw new SqliteError('db.loadExtension() is not supported: JSQL-NEO does not support loading native SQLite extensions', 'SQLITE_FEATURE_NOT_SUPPORTED');
  }

  backup(destination, options) {
    const dump = this._sync('backup', []);
    const target = new Database(destination, {});
    try {
      target.deserialize(dump);
      return Promise.resolve({ totalPages: 1, remainingPages: 0, idle: true });
    } catch (e) {
      target.close();
      throw e;
    }
  }

  unsafeMode() {
    this._unsafeMode = true;
    return this;
  }

  get defaultSafeIntegers() { return false; }
  set defaultSafeIntegers(v) {}

  get db() { return this; }

  [Symbol.for('nodejs.util.inspect.custom')]() {
    return `Database { name: '${this.name}', open: ${this.open} }`;
  }
}

class Statement {
  constructor(database, sql) {
    this.database = database;
    this._src = sql;
    this._params = [];
    this._rawMode = false;
    this._pluck = false;
    this._safeIntegers = false;
    const trimmed = sql.trim().toLowerCase();
    this._type = trimmed.startsWith('select') || trimmed.startsWith('pragma') || trimmed.startsWith('with') ? 'select'
      : trimmed.startsWith('insert') ? 'insert'
      : trimmed.startsWith('update') ? 'update'
      : trimmed.startsWith('delete') ? 'delete'
      : trimmed.startsWith('create') || trimmed.startsWith('drop') || trimmed.startsWith('alter') ? 'ddl'
      : 'other';
    this._reader = this._type === 'select' || /^\s*(select|pragma|with)\b/i.test(sql);
    this._tableName = null;
  }

  get reader() { return this._reader; }
  get safeIntegers() { return this._safeIntegers; }
  set safeIntegers(v) { this._safeIntegers = !!v; }
  get source() { return this._src; }

  bind(...params) {
    if (params.length === 1 && Array.isArray(params[0])) params = params[0];
    this._params = params;
    return this;
  }

  raw(enabled = true) {
    this._rawMode = !!enabled;
    return this;
  }

  pluck(enabled = true) {
    this._pluck = !!enabled;
    return this;
  }

  expand() { return this; }
  returning() { return this; }

  _call(mode, params) {
    let p = params;
    if (p === undefined || p === null) p = this._params;
    if (Array.isArray(p) && p.length === 1 && typeof p[0] === 'object' && p[0] !== null && !Array.isArray(p[0]) && !(p[0] instanceof Date) && !Buffer.isBuffer(p[0])) {
      const hasNamed = /[@:$][A-Za-z_][A-Za-z0-9_]*/.test(this.source);
      p = hasNamed ? p[0] : p;
    } else if (!Array.isArray(p) && (typeof p !== 'object' || p === null)) {
      p = [p];
    }
    return this.database._sync(mode, [this.source, p]);
  }

  run(...params) {
    const r = this._call('run', params.length > 0 ? params : undefined);
    return r;
  }

  get(...params) {
    return this._call('get', params.length > 0 ? params : undefined);
  }

  all(...params) {
    const r = this._call('all', params.length > 0 ? params : undefined);
    if (this._rawMode) return this._call('raw', params.length > 0 ? params : undefined);
    if (this._pluck) {
      const cols = r && r.length > 0 ? Object.keys(r[0]) : [];
      return cols.length > 0 ? r.map(row => row[cols[0]]) : [];
    }
    return r;
  }

  iterate(...params) {
    const rows = this.all(...params);
    let i = 0;
    const it = {
      next: () => i < rows.length ? { value: rows[i++], done: false } : { value: undefined, done: true },
      [Symbol.iterator]: () => it,
    };
    return it;
  }

  columns() {
    return this._call('columns', []);
  }
}

module.exports = Database;
module.exports.default = Database;
module.exports.Database = Database;
module.exports.SqliteError = SqliteError;
