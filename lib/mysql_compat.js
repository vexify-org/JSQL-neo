// © Vexify 2026 All Rights Reserved.
/**
 * MySQL API 兼容层 — createConnection / createPool / query
 * 底层用 JSQL SQL 执行器，接口形状对齐 mysql / mysql2 包。
 */

const { executeSQL } = require('./sql');
const Database = require('./database');

function escapeId(name) {
  return '`' + String(name).replace(/`/g, '``') + '`';
}

function escapeValue(value) {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'NULL';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (value instanceof Date) {
    const p = n => String(n).padStart(2, '0');
    return `'${value.getFullYear()}-${p(value.getMonth() + 1)}-${p(value.getDate())} ${p(value.getHours())}:${p(value.getMinutes())}:${p(value.getSeconds())}'`;
  }
  if (Buffer.isBuffer(value)) return "X'" + value.toString('hex') + "'";
  if (Array.isArray(value)) {
    if (value.some(Array.isArray)) {
      return '(' + value.map(row => '(' + row.map(escapeValue).join(', ') + ')').join(', ') + ')';
    }
    return value.map(escapeValue).join(', ');
  }
  if (typeof value === 'object') return "'" + JSON.stringify(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'";
  const str = String(value)
    .replace(/\\/g, '\\\\')
    .replace(/\0/g, '\\0')
    .replace(/'/g, "\\'")
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\u001a/g, '\\Z');
  return "'" + str + "'";
}

function applyParams(sql, values) {
  if (!values || values.length === 0) return sql;
  let out = '';
  let idx = 0;
  let inStr = null;
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    if (inStr) {
      out += c;
      if (c === '\\' && i + 1 < sql.length) { out += sql[i + 1]; i += 2; continue; }
      if (c === inStr) inStr = null;
      i++;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') { inStr = c; out += c; i++; continue; }
    if (c === '?' && sql[i + 1] === '?') {
      out += escapeId(values[idx++]);
      i += 2;
      continue;
    }
    if (c === '?') {
      out += escapeValue(values[idx++]);
      i++;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

function isQueryResult(r) {
  return r && r.type === 'select';
}

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
      multipleStatements: options.multipleStatements !== false,
    };
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
      const finalSql = values ? applyParams(sql, values) : sql;
      const r = await executeSQL(engine, finalSql);
      const results = Array.isArray(r) ? r : [r];
      const last = results[results.length - 1];
      return toResultPacket(last, last ? last.table : null);
    })();
    if (cb) {
      p.then(res => {
        if (res && res.rows && res.fields) cb(null, res.rows, res.fields);
        else cb(null, res);
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
