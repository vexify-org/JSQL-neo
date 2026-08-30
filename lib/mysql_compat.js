// © Vexify 2026 All Rights Reserved.
/**
 * MySQL API 兼容层 — createConnection / createPool / query
 * 底层用 JSQL SQL 执行器，接口形状对齐 mysql / mysql2 包。
 */

const { executeSQL, applyParams, escapeValue, escapeId } = require('./sql');
const Database = require('./database');
const EventEmitter = require('events');

function isQueryResult(r) {
  return !!r && typeof r === 'object' && Array.isArray(r.rows) && Array.isArray(r.columns);
}

function toResultPacket(r, table, rowsAsArray) {
  if (isQueryResult(r)) {
    const columns = r.columns || [];
    const rawRows = r.rows || [];
    const fields = columns.map(name => ({
      name,
      table: table || '',
      type: 253,
      length: 1024,
      flags: 0,
      charsetNr: 45,
    }));
    const rows = rowsAsArray
      ? rawRows
      : rawRows.map(vals => {
          const obj = {};
          columns.forEach((c, j) => { obj[c] = vals[j]; });
          return obj;
        });
    return { rows, fields };
  }
  return {
    fieldCount: 0,
    affectedRows: r && r.affectedRows !== undefined ? r.affectedRows : 0,
    insertId: r && r.insertId !== undefined ? r.insertId : 0,
    serverStatus: 2,
    warningCount: 0,
    message: r ? r.type + (r.table ? ' ' + r.table : '') : '',
    protocol41: true,
    changedRows: r && r.affectedRows !== undefined ? r.affectedRows : 0,
  };
}

class Connection extends EventEmitter {
  constructor(options = {}) {
    super();
    this.config = {
      host: options.host || 'localhost',
      port: options.port || 3306,
      user: options.user || 'root',
      password: options.password || '',
      database: options.database || null,
      multipleStatements: options.multipleStatements === true,
    };
    this.safety = options.safety !== false;
    this.allowComments = options.allowComments === true;
    this.database = options.database && typeof options.database === 'object' && !options.filename && typeof options.database.start === 'function'
      ? options.database
      : (options.engine || null);
    this.filename = options.filename || null;
    this.engine = null;
    this._ownEngine = false;
    this.state = 'disconnected';
    this.stream = {
      destroyed: false,
      writable: true,
      destroy: () => { this.stream.destroyed = true; },
    };
    if (options.host !== undefined || options.database || options.engine || options.filename) {
      queueMicrotask(() => {
        this._getEngine().then(() => this.emit('connect'), err => {
          if (this.listenerCount('error') > 0) this.emit('error', err);
        });
      });
    }
  }

  async _getEngine() {
    if (this.engine) return this.engine;
    if (this.database && typeof this.database.start === 'function') {
      this.engine = this.database;
      await this.engine.start();
    } else if (this._pool) {
      this.engine = await this._pool._sharedEngineFor(this.config.database || 'default');
    } else if (this.filename) {
      this.engine = new Database(this.filename);
      await this.engine.start();
      this._ownEngine = true;
    } else {
      this.engine = new Database(':memory:');
      await this.engine.start();
      this._ownEngine = true;
    }
    this.state = 'connected';
    return this.engine;
  }

  connect(cb) {
    const p = this._getEngine().then(c => {
      this.emit('connect');
      return c;
    });
    if (cb) p.then(c => cb(null, c), err => cb(err));
    return p;
  }

  query(...args) {
    let sql, values, cb, rowsAsArray;
    if (typeof args[0] === 'object' && args[0] !== null && typeof args[0].sql === 'string') {
      sql = args[0].sql;
      rowsAsArray = args[0].rowsAsArray === true;
      values = args[0].values !== undefined ? args[0].values : (Array.isArray(args[1]) ? args[1] : null);
      cb = typeof args[1] === 'function' ? args[1] : (typeof args[2] === 'function' ? args[2] : null);
    } else {
      sql = args[0];
      values = Array.isArray(args[1]) ? args[1] : null;
      cb = typeof args[1] === 'function' ? args[1] : (typeof args[2] === 'function' ? args[2] : null);
    }
    const p = (async () => {
      const engine = await this._getEngine();
      const finalSql = applyParams(sql, values);
      const r = await executeSQL(engine, finalSql, {
        safety: this.safety,
        allowComments: this.allowComments,
        maxStatements: this.config.multipleStatements ? null : 1,
      });
      const results = Array.isArray(r) ? r : [r];
      const last = results[results.length - 1];
      const packet = toResultPacket(last, last ? last.table : null, rowsAsArray);
      if (isQueryResult(last)) {
        const arr = [packet.rows, packet.fields];
        arr.rows = packet.rows;
        arr.fields = packet.fields;
        return arr;
      }
      const arr = [packet];
      arr.rows = null;
      arr.fields = null;
      return arr;
    })();
    const q = new EventEmitter();
    q.setMaxListeners = EventEmitter.prototype.setMaxListeners;
    p.then(res => {
      q.emit('result', res.rows || res[0]);
      q.emit('fields', res.fields || []);
    }, err => {
      if (q.listenerCount('error') > 0) q.emit('error', err);
    });
    if (cb) {
      p.then(res => {
        if (res && res.rows && res.fields) cb(null, res.rows, res.fields);
        else if (res && res[0] && res[0].insertId !== undefined) cb(null, res[0]);
        else cb(null, res[0]);
      }, err => cb(err));
      return q;
    }
    p.setMaxListeners = q.setMaxListeners;
    return p;
  }

  execute(sql, values, cb) {
    if (typeof values === 'function') {
      cb = values;
      values = undefined;
    }
    return this.query(sql, values, cb);
  }

  beginTransaction(cb) {
    const p = this.query('BEGIN');
    if (cb) p.then(() => cb(null), err => cb(err));
    return p;
  }

  commit(cb) {
    const p = this.query('COMMIT');
    if (cb) p.then(() => cb(null), err => cb(err));
    return p;
  }

  rollback(cb) {
    const p = this.query('ROLLBACK');
    if (cb) p.then(() => cb(null), err => cb(err));
    return p;
  }

  ping(cb) {
    const p = this._getEngine().then(() => true);
    if (cb) p.then(ok => cb(null, ok), err => cb(err));
    return p;
  }

  release() {
    this.state = 'released';
  }

  destroy() {
    this.state = 'destroyed';
    this.stream.destroy();
    this.emit('close');
  }

  end(cb) {
    const p = (async () => {
      if (this._ownEngine && this.engine && typeof this.engine.stop === 'function') {
        await this.engine.stop();
      }
      this.state = 'closed';
      this.stream.destroy();
      this.emit('close');
      return undefined;
    })();
    if (cb) p.then(() => cb(null), err => cb(err));
    return p;
  }

  promise() {
    return this;
  }
}

class Pool {
  constructor(options = {}) {
    this.config = options;
    this.connectionLimit = options.connectionLimit || 10;
    this.queueLimit = options.queueLimit || 0;
    this.idleTimeout = options.idleTimeout != null ? options.idleTimeout : 300000;
    this._connections = [];
    this._waiters = [];
    this._closed = false;
    this._sharedEngines = new Map();
    this._reaper = setInterval(() => this._reapIdle(), Math.max(1000, Math.floor(this.idleTimeout / 10) || 10000));
    this._reaper.unref();
  }

  async _sharedEngineFor(database) {
    const key = database || 'default';
    let engine = this._sharedEngines.get(key);
    if (!engine) {
      const filename = (this.config && this.config.filename) || null;
      engine = filename ? new Database(filename) : new Database(':memory:');
      if (typeof engine.start === 'function') await engine.start();
      this._sharedEngines.set(key, engine);
    }
    return engine;
  }

  _createConnection() {
    const conn = new Connection(this.config);
    conn._pool = this;
    const origDestroy = conn.destroy.bind(conn);
    conn.destroy = () => {
      this._remove(conn);
      origDestroy();
    };
    return conn;
  }

  _remove(conn) {
    const idx = this._connections.indexOf(conn);
    if (idx !== -1) this._connections.splice(idx, 1);
  }

  _reapIdle() {
    if (this.idleTimeout <= 0) return;
    const now = Date.now();
    for (const conn of this._connections.slice()) {
      if (conn.state === 'released' && !conn._inUse && now - (conn._releasedAt || 0) > this.idleTimeout) {
        this._remove(conn);
        if (conn._ownEngine && conn.engine && typeof conn.engine.stop === 'function') {
          conn.engine.stop().catch(() => {});
        }
        conn.state = 'destroyed';
      }
    }
  }

  _acquire() {
    if (this._closed) return Promise.reject(new Error('Pool is closed'));
    const free = this._connections.find(c => c.state === 'released' && !c._inUse);
    if (free) {
      free._inUse = true;
      free.state = 'acquired';
      return Promise.resolve(free);
    }
    if (this._connections.length < this.connectionLimit) {
      return Promise.resolve().then(() => {
        if (this._connections.length >= this.connectionLimit) {
          return this._waitForConnection();
        }
        const conn = this._createConnection();
        this._connections.push(conn);
        conn._inUse = true;
        conn.state = 'acquired';
        return conn._getEngine().then(
          () => conn,
          err => {
            this._remove(conn);
            throw err;
          }
        );
      });
    }
    return this._waitForConnection();
  }

  _waitForConnection() {
    return new Promise((resolve, reject) => {
      this._waiters.push({ resolve, reject });
      if (this.queueLimit > 0 && this._waiters.length > this.queueLimit) {
        const w = this._waiters.shift();
        w.reject(new Error('Pool queue limit exceeded'));
      }
    });
  }

  _release(conn) {
    conn._inUse = false;
    conn.state = 'released';
    conn._releasedAt = Date.now();
    const w = this._waiters.shift();
    if (w) {
      conn._inUse = true;
      conn.state = 'acquired';
      w.resolve(conn);
    }
  }

  async _getConnection() {
    return this._acquire();
  }

  async query(...args) {
    const conn = await this._acquire();
    try {
      return await conn.query(...args);
    } finally {
      this._release(conn);
    }
  }

  async getConnection(cb) {
    const p = (async () => {
      const conn = await this._acquire();
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        if (conn.state === 'destroyed') {
          this._remove(conn);
          return;
        }
        this._release(conn);
      };
      return { connection: conn, release };
    })();
    if (cb) p.then(r => cb(null, r.connection, r.release), err => cb(err));
    return p;
  }

  async end(cb) {
    const p = (async () => {
      this._closed = true;
      if (this._reaper) { clearInterval(this._reaper); this._reaper = null; }
      const err = new Error('Pool is closed');
      for (const w of this._waiters.splice(0)) w.reject(err);
      const conns = this._connections.splice(0);
      await Promise.allSettled(conns.map(c => c.end()));
      const engines = Array.from(this._sharedEngines.values());
      this._sharedEngines.clear();
      await Promise.allSettled(engines.map(e => (typeof e.stop === 'function' ? e.stop() : null)));
      return undefined;
    })();
    if (cb) p.then(() => cb(null), err => cb(err));
    return p;
  }

  promise() {
    return this;
  }
}

function createConnection(options) {
  return new Connection(options || {});
}

function createPool(options) {
  return new Pool(options || {});
}

class RowDataPacket {}
class OkPacket {}
class ResultSetHeader {}
class FieldPacket {}

module.exports = {
  createConnection,
  createPool,
  createConnectionPromise: () => Promise.resolve(createConnection()),
  Connection,
  Pool,
  RowDataPacket,
  OkPacket,
  ResultSetHeader,
  FieldPacket,
  escape: escapeValue,
  escapeId,
  format: applyParams,
};
