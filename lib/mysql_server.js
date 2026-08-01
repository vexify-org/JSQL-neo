// © Vexify 2026 All Rights Reserved.
/**
 * MySQL 协议服务端 — TCP 3306
 * 实现 MySQL 握手/认证/命令循环，任何 mysql/mysql2 客户端可直接连接。
 */

const net = require('net');
const crypto = require('crypto');
const { executeSQL } = require('./sql');
const Database = require('./database');

const SERVER_VERSION = '8.0.0-jsql-neo';
const CLIENT_PROTOCOL_41 = 0x00000001 << 9;
const CLIENT_SECURE_CONNECTION = 0x00008000;
const CLIENT_PLUGIN_AUTH = 0x00080000;
const CLIENT_CONNECT_WITH_DB = 0x00000008;
const CLIENT_LONG_PASSWORD = 0x00000001;
const CLIENT_TRANSACTIONS = 0x00002000;
const CLIENT_MULTI_STATEMENTS = 0x00010000;
const CLIENT_MULTI_RESULTS = 0x00020000;
const CLIENT_LONG_FLAG = 0x00000004;
const CLIENT_DEPRECATE_EOF = 0x01000000;
const SERVER_STATUS_AUTOCOMMIT = 0x0002;
const CHARSET_UTF8 = 0x21;

const MYSQL_TYPE_TINY = 1, MYSQL_TYPE_LONG = 3, MYSQL_TYPE_LONGLONG = 8,
  MYSQL_TYPE_DATE = 10, MYSQL_TYPE_DATETIME = 12, MYSQL_TYPE_DOUBLE = 5,
  MYSQL_TYPE_STRING = 254, MYSQL_TYPE_VAR_STRING = 253, MYSQL_TYPE_BLOB = 252,
  MYSQL_TYPE_JSON = 245, MYSQL_TYPE_NULL = 6;

function encodeLenenc(value) {
  if (value === null) return Buffer.from([0xfb]);
  if (value < 0xfb) return Buffer.from([value]);
  if (value <= 0xffff) {
    const b = Buffer.alloc(3);
    b[0] = 0xfc; b.writeUInt16LE(value, 1);
    return b;
  }
  if (value <= 0xffffff) {
    const b = Buffer.alloc(4);
    b[0] = 0xfd; b.writeUIntLE(value, 1, 3);
    return b;
  }
  const b = Buffer.alloc(9);
  b[0] = 0xfe; b.writeUInt32LE(value, 1); b.writeUInt32LE(Math.floor(value / 4294967296), 5);
  return b;
}

function encodeLenencString(str) {
  const buf = Buffer.from(String(str), 'utf8');
  return Buffer.concat([encodeLenenc(buf.length), buf]);
}

function parseLenenc(buf, offset) {
  const first = buf[offset];
  if (first < 0xfb) return { value: first, size: 1 };
  if (first === 0xfb) return { value: null, size: 1 };
  if (first === 0xfc) return { value: buf.readUInt16LE(offset + 1), size: 3 };
  if (first === 0xfd) return { value: buf.readUIntLE(offset + 1, 3), size: 4 };
  return { value: buf.readUInt32LE(offset + 1), size: 5 };
}

class PacketBuilder {
  constructor() {
    this.bufs = [];
  }
  byte(v) { this.bufs.push(Buffer.from([v & 0xff])); return this; }
  int16(v) { const b = Buffer.alloc(2); b.writeUInt16LE(v & 0xffff); this.bufs.push(b); return this; }
  int32(v) { const b = Buffer.alloc(4); b.writeUInt32LE(v >>> 0); this.bufs.push(b); return this; }
  raw(buf) { this.bufs.push(buf); return this; }
  string(str) { this.bufs.push(Buffer.from(str, 'utf8')); return this; }
  nul(str) { this.bufs.push(Buffer.concat([Buffer.from(String(str), 'utf8'), Buffer.from([0])])); return this; }
  bytes(list) { this.bufs.push(Buffer.from(list)); return this; }
  build() { return Buffer.concat(this.bufs); }
}

function handshakePacket(connectionId, seed) {
  const b = new PacketBuilder();
  b.byte(10);
  b.nul(SERVER_VERSION);
  b.int32(connectionId);
  b.bytes(seed.slice(0, 8));
  b.byte(0);
  const caps = CLIENT_PROTOCOL_41 | CLIENT_SECURE_CONNECTION | CLIENT_PLUGIN_AUTH | CLIENT_CONNECT_WITH_DB | CLIENT_LONG_PASSWORD | CLIENT_TRANSACTIONS | CLIENT_MULTI_STATEMENTS | CLIENT_MULTI_RESULTS | CLIENT_LONG_FLAG;
  b.int16(caps & 0xffff);
  b.byte(CHARSET_UTF8);
  b.int16(SERVER_STATUS_AUTOCOMMIT);
  b.int16((caps >>> 16) & 0xffff);
  b.byte(21);
  b.bytes([0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  b.bytes(seed.slice(8, 20));
  b.byte(0);
  b.nul('mysql_native_password');
  return b.build();
}

function okPacket(affectedRows = 0, insertId = 0, status = SERVER_STATUS_AUTOCOMMIT) {
  const b = new PacketBuilder();
  b.byte(0x00);
  b.raw(encodeLenenc(affectedRows));
  b.raw(encodeLenenc(insertId));
  b.int16(status);
  b.int16(0);
  return b.build();
}

function eofPacket() {
  const b = new PacketBuilder();
  b.byte(0xfe);
  b.int16(0);
  b.int16(SERVER_STATUS_AUTOCOMMIT);
  return b.build();
}

function errPacket(errno, message, sqlState = 'HY000') {
  const b = new PacketBuilder();
  b.byte(0xff);
  b.int16(errno);
  b.byte(0x23);
  b.string(sqlState);
  b.string(String(message).slice(0, 200));
  return b.build();
}

function toMysqlErrno(e) {
  if (e && typeof e.code === 'number') return e.code;
  const m = e && e.message ? String(e.message).match(/^(ER_[A-Z_]+)/) : null;
  if (m) {
    const known = { ER_DUP_ENTRY: 1062, ER_NO_SUCH_TABLE: 1146, ER_TABLE_EXISTS: 1050, ER_PARSE_ERROR: 1064 };
    if (known[m[1]]) return known[m[1]];
  }
  return 1105;
}

function columnDefinition(column) {
  const b = new PacketBuilder();
  b.raw(encodeLenencString('def'));
  b.raw(encodeLenencString(column.table || ''));
  b.raw(encodeLenencString(column.table || ''));
  b.raw(encodeLenencString(column.table || ''));
  b.raw(encodeLenencString(column.name || ''));
  b.raw(encodeLenencString(column.name || ''));
  b.raw(encodeLenenc(0x0c));
  b.int16(column.charset || CHARSET_UTF8);
  b.int32(column.length || 1024);
  b.byte(column.type !== undefined ? column.type : MYSQL_TYPE_VAR_STRING);
  b.int16(0);
  b.byte(0);
  b.int16(0);
  return b.build();
}

function columnTypeFromSchema(def) {
  const type = def && def.type ? String(def.type).toLowerCase() : 'string';
  if (type === 'integer' || type === 'int' || type === 'bigint') return MYSQL_TYPE_LONG;
  if (type === 'number' || type === 'float' || type === 'double' || type === 'real') return MYSQL_TYPE_DOUBLE;
  if (type === 'boolean' || type === 'bool') return MYSQL_TYPE_TINY;
  if (type === 'date') return MYSQL_TYPE_DATE;
  if (type === 'datetime' || type === 'timestamp') return MYSQL_TYPE_DATETIME;
  if (type === 'object' || type === 'array') return MYSQL_TYPE_JSON;
  if (type === 'binary') return MYSQL_TYPE_BLOB;
  return MYSQL_TYPE_VAR_STRING;
}

function resultSetPacket(result, tableSchema, baseSeq) {
  const packets = [];
  let sequence = baseSeq || 0;
  const push = (buf) => {
    const header = Buffer.alloc(4);
    header.writeUIntLE(buf.length, 0, 3);
    header[3] = sequence;
    sequence++;
    packets.push(header);
    packets.push(buf);
  };

  push(encodeLenenc((result.columns || []).length));
  for (const name of result.columns || []) {
    const col = {
      name,
      table: result.table || '',
      type: tableSchema && tableSchema[name] ? columnTypeFromSchema(tableSchema[name]) : MYSQL_TYPE_VAR_STRING,
      length: 1024,
    };
    push(columnDefinition(col));
  }
  push(eofPacket());

  for (const row of result.rows || []) {
    const parts = [];
    for (let i = 0; i < (result.columns || []).length; i++) {
      const v = row[i];
      if (v === null || v === undefined) {
        parts.push(Buffer.from([0xfb]));
      } else if (typeof v === 'object') {
        parts.push(encodeLenencString(JSON.stringify(v)));
      } else {
        parts.push(encodeLenencString(v));
      }
    }
    push(Buffer.concat(parts));
  }
  push(eofPacket());
  return { packets, sequence };
}

class MysqlConnection {
  constructor(socket, server) {
    this.socket = socket;
    this.server = server;
    this.connectionId = ++server._connectionCounter;
    this.seed = crypto.randomBytes(20);
    this.buffer = Buffer.alloc(0);
    this.sequence = 0;
    this.authenticated = false;
    this.user = null;
    this.authFails = 0;
    this.multiStatements = false;
    if (server.handshakeTimeout > 0) {
      this._authTimer = setTimeout(() => {
        if (!this.authenticated) {
          this.server._onSecurityEvent({ type: 'auth-timeout', user: this.user, remote: socket.remoteAddress });
          socket.destroy();
        }
      }, server.handshakeTimeout);
      this._authTimer.unref();
    }
    this.socket.on('data', chunk => this._onData(chunk));
    this.socket.on('error', () => {});
    this._send(handshakePacket(this.connectionId, this.seed));
  }

  _send(payload) {
    if (!this.socket.writable) return;
    const header = Buffer.alloc(4);
    header.writeUIntLE(payload.length, 0, 3);
    header[3] = this.sequence;
    this.sequence = (this.sequence + 1) & 0xff;
    this.socket.write(Buffer.concat([header, payload]));
  }

  _onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    if (this.buffer.length > this.server.maxPacketSize + 4) {
      this._malicious('packet exceeds maxPacketSize (' + this.server.maxPacketSize + ')');
      return;
    }
    while (true) {
      if (this.buffer.length < 4) return;
      const len = this.buffer.readUIntLE(0, 3);
      if (len > this.server.maxPacketSize) {
        this._malicious('packet length ' + len + ' exceeds maxPacketSize');
        return;
      }
      if (this.buffer.length < 4 + len) return;
      const seq = this.buffer[3];
      const payload = this.buffer.slice(4, 4 + len);
      this.buffer = this.buffer.slice(4 + len);
      this._handlePacket(payload, seq);
      if (this.socket.destroyed) return;
    }
  }

  _malicious(reason) {
    this.socket.destroy();
    this.server._onSecurityEvent({ type: 'malicious', reason, user: this.user, remote: this.socket.remoteAddress });
  }

  _handlePacket(payload, cmdSeq) {
    if (!this.authenticated) {
      this.sequence = (cmdSeq + 1) & 0xff;
      this._handleAuth(payload);
      return;
    }
    this.sequence = (cmdSeq + 1) & 0xff;
    const cmd = payload[0];
    const body = payload.slice(1);
    try {
      switch (cmd) {
        case 0x01: this.socket.end(); break; // COM_QUIT
        case 0x02: { // COM_INIT_DB
          const db = body.toString('utf8');
          if (!/^[a-zA-Z0-9_$.\-]+$/.test(db)) {
            this._malicious('COM_INIT_DB with invalid database name');
            return;
          }
          this.currentDb = db;
          this._send(okPacket());
          break;
        }
        case 0x03: {
          const sql = body.toString('utf8');
          if (sql.length === 0) {
            this._send(errPacket(1065, 'Query was empty'));
            break;
          }
          this._handleQuery(sql);
          break;
        }
        case 0x0e: this._send(okPacket()); break; // COM_PING
        case 0x1f: this._send(okPacket()); break; // COM_RESET_CONNECTION
        case 0x0a: { // COM_PROCESS_INFO
          const seq = this.sequence;
          this.sequence = (this.sequence + 1) & 0xff;
          this._send(encodeLenenc(1));
          this._send(columnDefinition({ name: 'Id', type: MYSQL_TYPE_LONG }));
          this._send(eofPacket());
          this._send(Buffer.from([0x31]));
          this._send(eofPacket());
          break;
        }
        case 0x09: this._send(okPacket(0, 0, SERVER_STATUS_AUTOCOMMIT)); break; // COM_STATISTICS
        default:
          this._send(errPacket(1105, `Unsupported command: ${cmd}`));
      }
    } catch (e) {
      this._send(errPacket(toMysqlErrno(e), e.message));
    }
  }

  _handleAuth(payload) {
    try {
      const caps = payload.readUInt32LE(0);
      let pos = 32; // 4 caps + 4 maxpacket + 1 charset + 23 reserved
      const userEnd = payload.indexOf(0, pos);
      this.user = payload.slice(pos, userEnd).toString('utf8');
      pos = userEnd + 1;
      let authResponse = Buffer.alloc(0);
      if (caps & CLIENT_SECURE_CONNECTION) {
        const lenenc = parseLenenc(payload, pos);
        if (lenenc.value === null) { pos += lenenc.size; }
        else {
          authResponse = payload.slice(pos + lenenc.size, pos + lenenc.size + lenenc.value);
          pos += lenenc.size + lenenc.value;
        }
      } else {
        const end = payload.indexOf(0, pos);
        if (end !== -1) {
          authResponse = payload.slice(pos, end);
          pos = end + 1;
        }
      }
      let db = null;
      if (caps & CLIENT_CONNECT_WITH_DB) {
        const dbEnd = payload.indexOf(0, pos);
        if (dbEnd !== -1) {
          db = payload.slice(pos, dbEnd).toString('utf8');
          pos = dbEnd + 1;
        }
      }
      this.currentDb = db;

      const valid = this.server._checkAuth(this.user, authResponse, this.seed);
      if (!valid) {
        this.authFails++;
        this.server._onSecurityEvent({ type: 'auth-fail', user: this.user, fails: this.authFails, remote: this.socket.remoteAddress });
        if (this.authFails >= this.server.maxAuthFails) {
          this.socket.destroy();
          return;
        }
        this._send(errPacket(1045, `Access denied for user '${this.user}'`));
        this.socket.end();
        return;
      }
      this.multiStatements = !!(caps & CLIENT_MULTI_STATEMENTS);
      this.authenticated = true;
      if (this._authTimer) { clearTimeout(this._authTimer); this._authTimer = null; }
      this._send(okPacket());
    } catch (e) {
      this._send(errPacket(1105, 'auth failed: ' + e.message));
      this.socket.end();
    }
  }

  _handleQuery(sql) {
    (async () => {
      try {
        const results = await executeSQL(this.server._engine, sql, {
          allowComments: this.server.allowComments,
          safety: this.server.safety,
          maxStatements: this.multiStatements ? null : 1,
        });
        const list = Array.isArray(results) ? results : [results];
        for (const r of list) {
          if (r.type === 'select' || r.type === 'showTables' || r.type === 'showDatabases' || r.type === 'describe') {
            let schema = null;
            if (r.table) {
              const engine = this.server._engine;
              schema = engine.getTableSchema
                ? await engine.getTableSchema(r.table)
                : (engine._schemas ? engine._schemas[r.table] : null);
            }
            const { packets, sequence } = resultSetPacket(r, schema, this.sequence);
            this.sequence = sequence;
            this.socket.write(Buffer.concat(packets));
          } else {
            this._send(okPacket(r.affectedRows || 0, r.insertId || 0));
          }
        }
      } catch (e) {
        this._send(errPacket(toMysqlErrno(e), e.message));
      }
    })();
  }
}

class MysqlServer {
  constructor(options = {}) {
    this.options = options;
    this.port = options.port || 3306;
    this.host = options.host || '127.0.0.1';
    this.user = options.user || null;
    this.password = options.password || null;
    this.auth = options.auth || null;
    this.safety = options.safety !== false;
    this.allowComments = options.allowComments !== false;
    this.maxPacketSize = options.maxPacketSize || 1024 * 1024;
    this.handshakeTimeout = options.handshakeTimeout != null ? options.handshakeTimeout : 10000;
    this.maxAuthFails = options.maxAuthFails || 3;
    this.maxConnections = options.maxConnections || 128;
    this._engine = null;
    this._ownEngine = false;
    this._connectionCounter = 0;
    this._sockets = new Set();
    this._securityHandler = typeof options.onSecurityEvent === 'function' ? options.onSecurityEvent : null;
  }

  _onSecurityEvent(event) {
    if (this._securityHandler) {
      try { this._securityHandler(event); } catch (e) {}
    }
  }

  async _getEngine() {
    if (this._engine) return this._engine;
    if (this.options.engine || this.options.database) {
      this._engine = this.options.engine || this.options.database;
      if (typeof this._engine.start === 'function') await this._engine.start();
    } else {
      this._engine = new Database(this.options.filename || ':memory:');
      if (typeof this._engine.start === 'function') await this._engine.start();
      this._ownEngine = true;
    }
    return this._engine;
  }

  _checkAuth(user, authResponse, seed) {
    if (this.auth) {
      if (!Object.prototype.hasOwnProperty.call(this.auth, user)) return false;
      const pwd = this.auth[user];
      if (!pwd) return authResponse.length === 0;
      const pwdHash1 = crypto.createHash('sha1').update(pwd).digest();
      const pwdHash2 = crypto.createHash('sha1').update(pwdHash1).digest();
      const seedHash = crypto.createHash('sha1').update(Buffer.concat([seed, pwdHash2])).digest();
      const expected = Buffer.alloc(20);
      for (let i = 0; i < 20; i++) expected[i] = pwdHash1[i] ^ seedHash[i];
      return authResponse.length === 20 && crypto.timingSafeEqual(expected, authResponse);
    }
    if (this.user === null) return true;
    if (user !== this.user) return false;
    if (!this.password) return authResponse.length === 0;
    const pwdHash1 = crypto.createHash('sha1').update(this.password).digest();
    const pwdHash2 = crypto.createHash('sha1').update(pwdHash1).digest();
    const seedHash = crypto.createHash('sha1').update(Buffer.concat([seed, pwdHash2])).digest();
    const expected = Buffer.alloc(20);
    for (let i = 0; i < 20; i++) expected[i] = pwdHash1[i] ^ seedHash[i];
    return authResponse.length === 20 && crypto.timingSafeEqual(expected, authResponse);
  }

  listen(cb) {
    this._getEngine().then(() => {
      this._server = net.createServer(socket => {
        if (this._sockets.size >= this.maxConnections) {
          this._onSecurityEvent({ type: 'max-connections', remote: socket.remoteAddress });
          socket.destroy();
          return;
        }
        this._sockets.add(socket);
        socket.on('close', () => this._sockets.delete(socket));
        new MysqlConnection(socket, this);
      });
      this._server.listen(this.port, this.host, cb || (() => {}));
    }).catch(err => {
      if (cb) cb(err);
      else throw err;
    });
    return this;
  }

  get address() {
    return this._server ? this._server.address() : null;
  }

  close(cb) {
    const done = () => {
      for (const s of this._sockets) s.destroy();
      if (this._ownEngine && this._engine && typeof this._engine.stop === 'function') {
        this._engine.stop().then(() => cb && cb()).catch(() => cb && cb());
      } else if (cb) cb();
    };
    if (this._server) {
      this._server.close(() => done());
    } else {
      done();
    }
    return this;
  }
}

function createMysqlServer(options) {
  return new MysqlServer(options || {});
}

module.exports = { createMysqlServer, MysqlServer };
