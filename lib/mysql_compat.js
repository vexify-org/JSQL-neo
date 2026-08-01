// © Vexify 2026 All Rights Reserved.
/**
 * MySQL API 兼容层 — createConnection / createPool / query
 * 底层用 JSQL SQL 执行器，接口形状对齐 mysql / mysql2 包。
 */

const { executeSQL, applyParams, escapeValue, escapeId } = require('./sql');
const Database = require('./database');

function toResultPacket(r, table) {
  if (isQueryResult(r)) {
    const columns = r.columns || [];
    const rows = (r.rows || []).map(vals => {
      const obj = {};
      columns.forEach((c, j) => { obj[c] = vals[j]; });
      return obj;
    });
    const fields = columns.map(name => ({
      name,
      table: table || '',
      type: 253,
      length: 1024,
      flags: 0,
      charsetNr: 45,
    }));
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

class Connection {
  constructor(options = {}) {
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
    this.filename = options.filename || (typeof options.database === 'string' ? options.database : null);
    this.engine = null;
    this._ownEngine = false;
    this.state = 'disconnected';
  }

  async _getEngine() {
    if (this.engine) return this.engine;
    if (this.database) {
      this.engine = this.database;
      if (typeof this.engine.start === 'function') await this.engine.start();
    } else {
      this.engine = new Database(this.filename || ':memory:');
      if (typeof this.engine.start === 'function') await this.engine.start();
      this._ownEngine = true;
    }
    this.state = 'connected';
    return this.engine;
  }

  connect(cb) {
    const p = this._getEngine().then(() => this);
    if (cb) p.then(c => cb(null, c), err => cb(err));
    return p;
  }

  async query(...args) {
    let sql, values, cb;
    if (typeof args[0] === 'object' && args[0] !== null && typeof args[0].sql === 'string') {
      sql = args[0].sql;
      values = args[0].values;
      cb = typeof args[1] === 'function' ? args[1] : null;
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
      const packet = toResultPacket(last, last ? last.table : null);
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
    if (cb) {
      p.then(res => {
        if (res && res.rows && res.fields) cb(null, res.rows, res.fields);
        else if (res && res[0] && res[0].insertId !== undefined) cb(null, res[0]);
        else cb(null, res[0]);
      }, err => cb(err));
      return undefined;
    }
    return p;
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
  }

  end(cb) {
    const p = (async () => {
      if (this._ownEngine && this.engine && typeof this.engine.stop === 'function') {
        await this.engine.stop();
      }
      this.state = 'closed';
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
    this._connection = null;
  }

  async _getConnection() {
    if (!this._connection) {
      this._connection = new Connection(this.config);
      await this._connection._getEngine();
    }
    return this._connection;
  }

  query(...args) {
    return this._getConnection().then(conn => conn.query(...args));
  }

  getConnection(cb) {
    const p = this._getConnection().then(conn => {
      const release = conn.release.bind(conn);
      return { connection: conn, release };
    });
    if (cb) p.then(r => cb(null, r.connection, r.release), err => cb(err));
    return p;
  }

  end(cb) {
    const p = (async () => {
      if (this._connection) {
        await this._connection.end();
        this._connection = null;
      }
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

module.exports = {
  createConnection,
  createPool,
  escape: escapeValue,
  escapeId,
  format: applyParams,
};
