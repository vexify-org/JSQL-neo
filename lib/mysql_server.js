// © Vexify 2026 All Rights Reserved.
/**
 * MySQL 协议服务端 — TCP 3306
 * 实现 MySQL 握手/认证/命令循环，任何 mysql/mysql2 客户端可直接连接。
 */

const net = require('net');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const { executeSQL, parseSQL, splitStatements, applyParams } = require('./sql');
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
  if (typeof value === 'bigint') value = Number(value);
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

function readLenenc(buf, offset) {
  const { value, size } = parseLenenc(buf, offset);
  if (value === null) return { value: null, off: offset + size };
  const str = buf.slice(offset + size, offset + size + value).toString('utf8');
  return { value: str, off: offset + size + value };
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

/**
 * 生成握手 seed：使用可打印 ASCII（33-126），避开 0x00。
 * 老客户端按 C 字符串读取 seed，若含 \0 会提前截断导致握手失败/断连。
 */
function genSeed(len = 20) {
  const out = Buffer.alloc(len);
  for (let i = 0; i < len; i++) {
    out[i] = 33 + Math.floor(Math.random() * 94);
  }
  return out;
}

function okPacket(affectedRows = 0, insertId = 0, status = SERVER_STATUS_AUTOCOMMIT) {  const b = new PacketBuilder();
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
    const known = {
      ER_DUP_ENTRY: 1062,
      ER_NO_SUCH_TABLE: 1146,
      ER_TABLE_EXISTS: 1050,
      ER_TABLE_EXISTS_ERROR: 1050,
      ER_PARSE_ERROR: 1064,
      ER_BAD_FIELD_ERROR: 1054,
      ER_BAD_NULL_ERROR: 1048,
      ER_ACCESS_DENIED_ERROR: 1045,
      ER_DBACCESS_DENIED_ERROR: 1044,
      ER_BAD_DB_ERROR: 1049,
      ER_WRONG_DB_NAME: 1102,
      ER_WRONG_TABLE_NAME: 1103,
      ER_WRONG_COLUMN_NAME: 1166,
      ER_DATA_TOO_LONG: 1406,
      ER_OUT_OF_RANGE: 1264,
      ER_CHECK_CONSTRAINT: 3819,
      ER_NO_DEFAULT_FOR_FIELD: 1364,
      ER_CANT_DROP_FIELD_OR_KEY: 1091,
      ER_CANT_DROP_DATABASE: 1008,
      ER_EMPTY_QUERY: 1065,
      ER_UNKNOWN_TABLE: 1109,
      ER_NON_UNIQ_ERROR: 1052,
      ER_WRONG_FIELD_WITH_GROUP: 1055,
      ER_WRONG_VALUE_COUNT_ON_ROW: 1136,
      ER_MISSING_TABLE: 1052,
      ER_SP_DOES_NOT_EXIST: 1305,
      ER_NOT_SUPPORTED_YET: 1235,
      ER_LOCK_DEADLOCK: 1213,
      ER_LOCK_WAIT_TIMEOUT: 1205,
      ER_UNKNOWN_ERROR: 1105,
    };
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

function resultSetPacket(result, tableSchema, baseSeq, rawRow) {
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

  const inferType = (name, value) => {
    if (tableSchema && tableSchema[name]) return columnTypeFromSchema(tableSchema[name]);
    if (value === null || value === undefined) return MYSQL_TYPE_NULL;
    if (typeof value === 'number') return Number.isInteger(value) ? MYSQL_TYPE_LONGLONG : MYSQL_TYPE_DOUBLE;
    if (typeof value === 'boolean') return MYSQL_TYPE_TINY;
    if (typeof value === 'object') return MYSQL_TYPE_JSON;
    return MYSQL_TYPE_VAR_STRING;
  };

  push(encodeLenenc((result.columns || []).length));
  const sampleRow = (result.rows && result.rows[0]) || null;
  for (let ci = 0; ci < (result.columns || []).length; ci++) {
    const name = result.columns[ci];
    let sample;
    if (sampleRow !== null) {
      if (Array.isArray(sampleRow)) sample = sampleRow[ci];
      else sample = sampleRow[name];
    }
    const col = {
      name,
      table: result.table || '',
      type: inferType(name, sample),
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
      } else if (typeof v === 'boolean') {
        parts.push(encodeLenencString(v ? '1' : '0'));
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

function binaryResultSetPacket(result, tableSchema, baseSeq) {
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

  const inferType = (name, value) => {
    if (tableSchema && tableSchema[name]) return columnTypeFromSchema(tableSchema[name]);
    if (value === null || value === undefined) return MYSQL_TYPE_NULL;
    if (typeof value === 'number') return Number.isInteger(value) ? MYSQL_TYPE_LONGLONG : MYSQL_TYPE_DOUBLE;
    if (typeof value === 'boolean') return MYSQL_TYPE_TINY;
    if (typeof value === 'object') return MYSQL_TYPE_JSON;
    return MYSQL_TYPE_VAR_STRING;
  };

  const cols = result.columns || [];
  push(encodeLenenc(cols.length));
  const sampleRow = (result.rows && result.rows[0]) || null;
  const types = [];
  for (let ci = 0; ci < cols.length; ci++) {
    let sample;
    if (sampleRow !== null) {
      if (Array.isArray(sampleRow)) sample = sampleRow[ci];
      else sample = sampleRow[cols[ci]];
    }
    const t = inferType(cols[ci], sample);
    types.push(t);
    push(columnDefinition({ name: cols[ci], table: result.table || '', type: t, length: 1024 }));
  }
  push(eofPacket());

  const encodeValue = (v, type) => {
    if (v === null || v === undefined) return null;
    if (type === MYSQL_TYPE_LONG || type === MYSQL_TYPE_LONGLONG || type === MYSQL_TYPE_DOUBLE) {
      const num = Number(v);
      if (type === MYSQL_TYPE_DOUBLE) {
        if (!Number.isFinite(num)) return encodeLenencString(String(v));
        const b = Buffer.alloc(8); b.writeDoubleLE(num, 0); return b;
      }
      if (Number.isInteger(num) && num <= 2147483647 && num >= -2147483648) {
        const b = Buffer.alloc(4); b.writeInt32LE(num, 0); return b;
      }
      if (!Number.isFinite(num)) return encodeLenencString(String(v));
      const b = Buffer.alloc(8); b.writeBigInt64LE(BigInt(Math.trunc(num)), 0); return b;
    }
    if (type === MYSQL_TYPE_TINY) {
      const b = Buffer.alloc(1); b.writeInt8(v ? 1 : 0, 0); return b;
    }
    if (type === MYSQL_TYPE_DATE || type === MYSQL_TYPE_DATETIME) {
      const s = String(v);
      const m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}):(\d{2}))?/);
      if (!m) return encodeLenencString(String(v));
      const hasTime = !!m[4];
      const buf = hasTime ? Buffer.alloc(8) : Buffer.alloc(5);
      let off = 0;
      buf[off++] = hasTime ? 7 : 4;
      buf.writeUInt16LE(parseInt(m[1], 10), off); off += 2;
      buf[off++] = parseInt(m[2], 10);
      buf[off++] = parseInt(m[3], 10);
      if (hasTime) {
        buf[off++] = parseInt(m[4], 10);
        buf[off++] = parseInt(m[5], 10);
        buf[off++] = parseInt(m[6], 10);
      }
      return buf;
    }
    return encodeLenencString(typeof v === 'object' ? JSON.stringify(v) : v);
  };

  for (const row of result.rows || []) {
    const parts = [Buffer.from([0x00])];
    const nb = Buffer.alloc(Math.ceil(cols.length / 8));
    const encoded = [];
    for (let i = 0; i < cols.length; i++) {
      const v = Array.isArray(row) ? row[i] : row[cols[i]];
      if (v === null || v === undefined) {
        nb[Math.floor(i / 8)] |= (1 << (i % 8));
        encoded.push(null);
      } else {
        encoded.push(encodeValue(v, types[i]));
      }
    }
    parts.push(nb);
    for (const e of encoded) if (e !== null) parts.push(e);
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
    this.seed = genSeed(20);
    this.buffer = Buffer.alloc(0);
    this.sequence = 0;
    this.authenticated = false;
    this.user = null;
    this.authFails = 0;
    this.multiStatements = false;
    this._stmts = new Map();
    this._stmtSeq = 0;
    this.session = {
      lastInsertId: 0,
      rowCount: 0,
      foundRows: 0,
      connectionId: server._connectionCounter,
      currentDb: null,
      sysvars: {},
    };
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
    this._armIdleTimer();
    this._send(handshakePacket(this.connectionId, this.seed));
  }

  _armIdleTimer() {
    if (this._idleTimer) { clearTimeout(this._idleTimer); this._idleTimer = null; }
    const ttl = this.server.idleTimeout;
    if (!this.authenticated) return;
    if (ttl <= 0) return;
    this._idleTimer = setTimeout(() => {
      this.server._onSecurityEvent({ type: 'idle-timeout', user: this.user, remote: this.socket.remoteAddress });
      this.socket.destroy();
    }, ttl);
    this._idleTimer.unref();
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
    this._armIdleTimer();
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
          if (!this.server._safeDbName(db)) {
            this._malicious('COM_INIT_DB with invalid database name');
            return;
          }
          this.server._switchDb(this, db)
            .then(() => this._send(okPacket()))
            .catch(e => this._send(errPacket(e.code || 1049, e.message)));
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
        case 0x11: this._handleChangeUser(body, cmdSeq); break; // COM_CHANGE_USER
        case 0x0e: this._send(okPacket()); break; // COM_PING
        case 0x1f: this._send(okPacket()); break; // COM_RESET_CONNECTION
        case 0x16: this._handleStmtPrepare(body); break; // COM_STMT_PREPARE
        case 0x17: this._handleStmtExecute(body); break; // COM_STMT_EXECUTE
        case 0x18: break; // COM_STMT_SEND_LONG_DATA (忽略)
        case 0x19: this._handleStmtClose(body); break; // COM_STMT_CLOSE
        case 0x1a: this._send(okPacket()); break; // COM_STMT_RESET
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

  _handleChangeUser(body, cmdSeq) {
    (async () => {
      try {
        let pos = 0;
        const userEnd = body.indexOf(0, pos);
        if (userEnd === -1) throw new Error('malformed COM_CHANGE_USER');
        const user = body.slice(pos, userEnd).toString('utf8');
        pos = userEnd + 1;
        const lenenc = parseLenenc(body, pos);
        let authResponse = Buffer.alloc(0);
        if (lenenc.value !== null) {
          authResponse = body.slice(pos + lenenc.size, pos + lenenc.size + lenenc.value);
          pos += lenenc.size + lenenc.value;
        } else {
          pos += lenenc.size;
        }
        let db = null;
        if (pos < body.length) {
          const dbEnd = body.indexOf(0, pos);
          if (dbEnd !== -1) {
            db = body.slice(pos, dbEnd).toString('utf8');
          }
        }
        const valid = this.server._checkAuth(user, authResponse, this.seed);
        if (!valid) {
          this._send(errPacket(1045, `Access denied for user '${user}'`));
          return;
        }
        if (db) {
          if (!this.server._canAccessDb(user, db)) {
            this._send(errPacket(1044, `Access denied for user '${user}' to database '${db}'`));
            return;
          }
          try {
            await this.server._getDatabase(db);
          } catch (e) {
            this._send(errPacket(1049, `Unknown database '${db}'`));
            return;
          }
        }
        this.user = user;
        this.currentDb = db;
        this._send(okPacket());
      } catch (e) {
        this._send(errPacket(toMysqlErrno(e), e.message));
      }
    })();
  }

  async _handleAuth(payload) {
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
      this._armIdleTimer();
      if (db) {
        if (!this.server._canAccessDb(this.user, db)) {
          this._send(errPacket(1044, `Access denied for user '${this.user}' to database '${db}'`));
          this.socket.end();
          return;
        }
        try {
          if (!this.server._dbExists(db)) await this.server.createDatabase(db);
          await this.server._getDatabase(db);
          this.currentDb = db;
        } catch (e) {
          this._send(errPacket(1049, `Unknown database '${db}'`));
          this.socket.end();
          return;
        }
      }
      this._send(okPacket());
    } catch (e) {
      this._send(errPacket(1105, 'auth failed: ' + e.message));
      this.socket.end();
    }
  }

  countPlaceholders(sql) {
    let n = 0;
    let inStr = null;
    for (let i = 0; i < sql.length; i++) {
      const c = sql[i];
      if (inStr) {
        if (c === '\\' && i + 1 < sql.length) { i++; continue; }
        if (c === inStr) inStr = null;
        continue;
      }
      if (c === "'" || c === '"' || c === '`') { inStr = c; continue; }
      if (c === '?' && sql[i + 1] === '?') { i++; continue; }
      if (c === '?') n++;
    }
    return n;
  }

  _handleStmtPrepare(body) {
    try {
      const sql = body.toString('utf8');
      const numParams = this.countPlaceholders(sql);
      let numColumns = 0;
      try {
        const stmt = parseSQL(sql);
        if (stmt && stmt.type === 'select' && stmt.columns) numColumns = stmt.columns.length;
      } catch (e) { /* 无法解析的 SQL 仍可 prepare */ }
      const stmtId = ++this._stmtSeq;
      this._stmts.set(stmtId, { sql, numParams, numColumns });

      const pkt = Buffer.alloc(12);
      let off = 0;
      pkt[off++] = 0x00;
      pkt.writeUInt32LE(stmtId, off); off += 4;
      pkt.writeUInt16LE(numColumns, off); off += 2;
      pkt.writeUInt16LE(numParams, off); off += 2;
      pkt[off++] = 0x00;
      pkt.writeUInt16LE(0, off);
      this._send(pkt);

      if (numParams > 0) {
        for (let i = 0; i < numParams; i++) {
          this._send(columnDefinition({ name: '?', type: MYSQL_TYPE_VAR_STRING }));
        }
        this._send(eofPacket());
      }
      if (numColumns > 0) {
        for (let i = 0; i < numColumns; i++) {
          this._send(columnDefinition({ name: 'col' + (i + 1), type: MYSQL_TYPE_VAR_STRING }));
        }
        this._send(eofPacket());
      }
    } catch (e) {
      this._send(errPacket(toMysqlErrno(e), e.message));
    }
  }

  _handleStmtClose(body) {
    if (body.length >= 4) {
      const stmtId = body.readUInt32LE(0);
      this._stmts.delete(stmtId);
    }
  }

  _handleStmtExecute(body) {
    try {
      if (body.length < 9) throw new Error('malformed COM_STMT_EXECUTE');
      const stmtId = body.readUInt32LE(0);
      const stmt = this._stmts.get(stmtId);
      if (!stmt) {
        this._send(errPacket(1243, 'Unknown prepared statement handler (' + stmtId + ') given to mysqld_stmt_execute'));
        return;
      }
      const flags = body[4];
      const iteration = body.readUInt32LE(5);
      let values = null;
      if (stmt.numParams > 0) {
        let off = 9;
        const numParams = stmt.numParams;
        const nullBitmapLen = Math.ceil(numParams / 8);
        if (body.length < off + nullBitmapLen) throw new Error('malformed COM_STMT_EXECUTE params');
        const nullBitmap = body.slice(off, off + nullBitmapLen);
        off += nullBitmapLen;
        if (off >= body.length) throw new Error('malformed COM_STMT_EXECUTE params');
        const newParamsBound = body[off];
        off += 1;
        let types = stmt.types;
        if (newParamsBound & 0x01) {
          if (body.length < off + numParams * 2) throw new Error('malformed COM_STMT_EXECUTE types');
          types = [];
          for (let i = 0; i < numParams; i++) types.push(body.readUInt16LE(off + i * 2));
          stmt.types = types;
          off += numParams * 2;
        }
        if (!types) throw new Error('Parameter types unknown for prepared statement');
        values = [];
        for (let i = 0; i < numParams; i++) {
          const isNull = nullBitmap[Math.floor(i / 8)] & (1 << (i % 8));
          if (isNull) { values.push(null); continue; }
          const type = types[i] & 0xff;
          const parsed = this._readParamValue(body, off, type);
          values.push(parsed.value);
          off = parsed.off;
        }
      }
      this._handleQuery(stmt.sql, values !== null && values.length > 0 ? values : undefined);
    } catch (e) {
      this._send(errPacket(toMysqlErrno(e), e.message));
    }
  }

  _readParamValue(buf, off, type) {
    switch (type) {
      case MYSQL_TYPE_NULL: return { value: null, off };
      case 0x01: { const v = buf.readInt8(off); return { value: v, off: off + 1 }; } // TINY
      case 0x02: { const v = buf.readInt16LE(off); return { value: v, off: off + 2 }; } // SHORT
      case 0x03: { const v = buf.readInt32LE(off); return { value: v, off: off + 4 }; } // LONG
      case 0x08: { const v = buf.readBigInt64LE(off); return { value: Number(v), off: off + 8 }; } // LONGLONG
      case 0x04: { const v = buf.readFloatLE(off); return { value: v, off: off + 4 }; } // FLOAT
      case MYSQL_TYPE_DOUBLE: { const v = buf.readDoubleLE(off); return { value: v, off: off + 8 }; }
      case 0x0a: case 0x07: case 0x0b: case MYSQL_TYPE_DATETIME: { // DATE/TIMESTAMP/DATETIME/TIME
        const len = buf[off];
        off += 1;
        if (len === 0) return { value: null, off };
        let value;
        if (type === 0x0b) { // TIME
          let sign = 1;
          let p = off;
          if (buf[p] !== 0) sign = -1;
          p += 1;
          const days = buf.readUInt32LE(p); p += 4;
          const hour = buf[p++];
          const min = buf[p++];
          const sec = buf[p++];
          value = sign * (days * 24 + hour) + ':' + String(min).padStart(2, '0') + ':' + String(sec).padStart(2, '0');
        } else {
          let p = off;
          const year = buf.readUInt16LE(p); p += 2;
          const month = buf[p++];
          const day = buf[p++];
          let hour = 0, minute = 0, second = 0;
          if (len >= 7) { hour = buf[p++]; minute = buf[p++]; second = buf[p++]; }
          value = String(year).padStart(4, '0') + '-' + String(month).padStart(2, '0') + '-' + String(day).padStart(2, '0');
          if (len >= 7) value += ' ' + String(hour).padStart(2, '0') + ':' + String(minute).padStart(2, '0') + ':' + String(second).padStart(2, '0');
        }
        off += len;
        return { value, off };
      }
      case 0xfc: case 0xfd: case 0xfe: case 0xf9: case 0xf6: { // BLOB / VAR_STRING / STRING / ...
        const { value, off: noff } = readLenenc(buf, off);
        return { value, off: noff };
      }
      case 0xf0: { // NULL
        return { value: null, off };
      }
      default: {
        const { value, off: noff } = readLenenc(buf, off);
        return { value, off: noff };
      }
    }
  }

  _handleQuery(sql, values) {
    (async () => {
      try {
        const hasParams = values !== undefined && values !== null && values.length > 0;
        const processedSql = hasParams ? applyParams(sql, values) : sql;
        const statements = splitStatements(processedSql);
        if (statements.length > 1 && !this.multiStatements) {
          throw new Error(`too many statements (${statements.length} > 1)`);
        }
        for (const stmtSql of statements) {
          const stmt = parseSQL(stmtSql);
          switch (stmt.type) {
            case 'use': {
              if (!this.server._canAccessDb(this.user, stmt.database)) {
                this._send(errPacket(1044, `Access denied for user '${this.user}' to database '${stmt.database}'`));
                continue;
              }
              try {
                await this.server._getDatabase(stmt.database);
                this.currentDb = stmt.database;
                this._send(okPacket());
              } catch (e) {
                this._send(errPacket(1049, `Unknown database '${stmt.database}'`));
              }
              continue;
            }
            case 'showDatabases': {
              const dbs = await this.server.listDatabases();
              const allowed = this.server._userDbList(this.user);
              const names = allowed === null ? dbs : dbs.filter(n => allowed.includes(n));
              const { packets, sequence } = resultSetPacket({
                type: 'showDatabases', columns: ['Database'], rows: names.map(n => [n]),
              }, null, this.sequence);
              this.sequence = sequence;
              this.socket.write(Buffer.concat(packets));
              continue;
            }
            case 'createDatabase': {
              if (!this.server._canAccessDb(this.user, stmt.database)) {
                this._send(errPacket(1044, `Access denied for user '${this.user}' to database '${stmt.database}'`));
                continue;
              }
              await this.server.createDatabase(stmt.database, { ifNotExists: stmt.ifNotExists });
              this._send(okPacket());
              continue;
            }
            case 'dropDatabase': {
              await this.server.dropDatabase(stmt.database, { ifExists: stmt.ifExists });
              this._send(okPacket());
              continue;
            }
            default:
              break;
          }
          const routed = await this.server._route(stmt, stmtSql, this.currentDb, this.user);
          const engine = routed.engine;
          const sqlToRun = routed.sql;
          const r = await executeSQL(engine, sqlToRun, {
            allowComments: this.server.allowComments,
            safety: this.server.safety,
            maxStatements: 1,
            session: this.session,
          });
          if (r.type === 'select' || r.type === 'showTables' || r.type === 'showDatabases' || r.type === 'describe'
            || r.type === 'showColumns' || r.type === 'showIndex' || r.type === 'showCreateTable'
            || r.type === 'showVariables' || r.type === 'showStatus' || r.type === 'showGrants' || r.type === 'showWarnings') {
            this.session.foundRows = (r.raw && r.raw.length !== undefined) ? r.raw.length : (r.rows ? r.rows.length : 0);
            let schema = null;
            if (r.table) {
              schema = engine.getTableSchema
                ? await engine.getTableSchema(r.table)
                : (engine._schemas ? engine._schemas[r.table] : null);
            }
            const { packets, sequence } = hasParams
              ? binaryResultSetPacket(r, schema, this.sequence)
              : resultSetPacket(r, schema, this.sequence);
            this.sequence = sequence;
            this.socket.write(Buffer.concat(packets));
          } else {
            if (r.type === 'insert') {
              this.session.lastInsertId = r.insertId;
              this.session.rowCount = r.affectedRows;
            } else if (r.type === 'update' || r.type === 'delete' || r.type === 'truncate') {
              this.session.rowCount = r.affectedRows;
            }
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
    this.allowComments = options.allowComments === true;
    this.maxPacketSize = options.maxPacketSize || 1024 * 1024;
    this.handshakeTimeout = options.handshakeTimeout != null ? options.handshakeTimeout : 10000;
    this.idleTimeout = options.idleTimeout != null ? options.idleTimeout : 300000;
    this.maxAuthFails = options.maxAuthFails || 3;
    this.maxConnections = options.maxConnections || 128;
    this._engine = null;
    this._ownEngine = false;
    this._databases = new Map();
    this._dbDir = options.dataDir ? path.resolve(options.dataDir) : null;
    this._defaultDbName = options.defaultDatabase || 'default';
    this._connectionCounter = 0;
    this._sockets = new Set();
    this._securityHandler = typeof options.onSecurityEvent === 'function' ? options.onSecurityEvent : null;
  }

  _onSecurityEvent(event) {
    if (this._securityHandler) {
      try { this._securityHandler(event); } catch (e) {}
    }
  }

  async _getEngine(dbName) {
    if (dbName) return this._getDatabase(dbName);
    if (this._dbDir) {
      return this._getDatabase(this._defaultDbName, { autoCreate: true });
    }
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

  _dbExists(name) {
    if (this._databases.has(name)) return true;
    const dir = this._dbPath(name);
    return !!(dir && fs.existsSync(dir));
  }

  // 语句路由：解析库前缀（db.table）与 SHOW TABLES FROM db，
  // 决定执行引擎，并把 db.table 改写为 table 后交给对应库引擎执行。
  async _route(stmt, sql, currentDb, user) {
    if (stmt.type === 'showTables' && stmt.database) {
      return { engine: await this._getDatabase(stmt.database), sql };
    }
    const tables = [];
    const collect = (s) => {
      if (!s) return;
      if (s.type === 'createTable') tables.push(s.name);
      else if (s.type === 'dropTable') tables.push(s.table);
      else if (s.type === 'insert') tables.push(s.name);
      else if (s.type === 'update') tables.push(s.table);
      else if (s.type === 'delete') tables.push(s.table);
      else if (s.type === 'describe') tables.push(s.table);
      else if (s.type === 'select' && s.from) {
        for (const t of s.from.tables) tables.push(t.table);
        for (const j of s.from.joins) tables.push(j.item.table);
      }
    };
    collect(stmt);
    const isInfoSchema = tables.some(t => t && String(t).toLowerCase().startsWith('information_schema.'));
    if (isInfoSchema) {
      return { engine: await this._getEngine(currentDb), sql };
    }
    let db = null;
    for (const t of tables) {
      if (t && t.indexOf('.') !== -1) {
        const d = t.split('.')[0];
        if (db && d !== db) {
          const err = new Error(`Cross-database references are not supported in one statement`);
          err.code = 1105;
          throw err;
        }
        db = d;
      }
    }
    if (db) {
      if (!this._dbExists(db)) await this.createDatabase(db);
      const engine = await this._getDatabase(db);
      let s = sql;
      for (const t of tables) {
        if (t && t.indexOf('.') !== -1) {
          s = s.replace(new RegExp('\\b' + t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'g'), t.split('.')[1]);
        }
      }
      return { engine, sql: s };
    }
    if (this._dbDir && !currentDb && this.auth && !this._canAccessDb(user, this._defaultDbName)) {
      const err = new Error('No database selected');
      err.code = 1046;
      throw err;
    }
    return { engine: await this._getEngine(currentDb), sql };
  }

  _safeDbName(name) {
    if (typeof name !== 'string' || name.length === 0 || name.length > 64) return false;
    if (!/^[a-zA-Z0-9_$.\-]+$/.test(name)) return false;
    if (name === '.' || name === '..' || name.includes('..')) return false;
    return true;
  }

  _dbPath(name) {
    if (!this._dbDir) return null;
    if (!this._safeDbName(name)) return null;
    return path.join(this._dbDir, name);
  }

  async _getDatabase(name, opts = {}) {
    if (!this._safeDbName(name)) {
      const err = new Error(`Unknown database '${name}'`);
      err.code = 1049;
      throw err;
    }
    if (this._databases.has(name)) return this._databases.get(name);
    const dir = this._dbPath(name);
    if (dir && !fs.existsSync(dir)) {
      if (opts.autoCreate) {
        fs.mkdirSync(dir, { recursive: true });
      } else {
        const err = new Error(`Unknown database '${name}'`);
        err.code = 1049;
        throw err;
      }
    }
    const engine = dir ? new Database(dir, { mode: 'hybrid' }) : new Database(':memory:');
    if (typeof engine.start === 'function') await engine.start();
    this._databases.set(name, engine);
    return engine;
  }

  async listDatabases() {
    if (!this._dbDir) return ['jsql'];
    let names = [];
    if (fs.existsSync(this._dbDir)) {
      names = fs.readdirSync(this._dbDir).filter(n => {
        const p = path.join(this._dbDir, n);
        return fs.statSync(p).isDirectory() && this._safeDbName(n);
      });
    }
    for (const n of this._databases.keys()) {
      if (!names.includes(n)) names.push(n);
    }
    return names.sort();
  }

  async createDatabase(name, opts = {}) {
    if (!this._safeDbName(name)) {
      const err = new Error(`Invalid database name '${name}'`);
      err.code = 1105;
      throw err;
    }
    if (this._databases.has(name)) {
      if (opts.ifNotExists) return this._databases.get(name);
      const err = new Error(`Can't create database '${name}'; database exists`);
      err.code = 1007;
      throw err;
    }
    const dir = this._dbPath(name);
    if (dir && fs.existsSync(dir)) {
      if (opts.ifNotExists) return this._getDatabase(name);
      const err = new Error(`Can't create database '${name}'; database exists`);
      err.code = 1007;
      throw err;
    }
    if (dir) fs.mkdirSync(dir, { recursive: true });
    const engine = dir ? new Database(dir, { mode: 'hybrid' }) : new Database(':memory:');
    if (typeof engine.start === 'function') await engine.start();
    this._databases.set(name, engine);
    return engine;
  }

  async dropDatabase(name, opts = {}) {
    if (!this._safeDbName(name)) {
      const err = new Error(`Unknown database '${name}'`);
      err.code = 1049;
      throw err;
    }
    const engine = this._databases.get(name);
    if (!engine) {
      if (opts.ifExists) return;
      const err = new Error(`Can't drop database '${name}'; database doesn't exist`);
      err.code = 1008;
      throw err;
    }
    if (typeof engine.stop === 'function') {
      try { await engine.stop(); } catch (e) {}
    }
    this._databases.delete(name);
    const dir = this._dbPath(name);
    if (dir && fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  _userDbList(user) {
    if (!this.auth) return null;
    const entry = this.auth[user];
    if (entry && typeof entry === 'object') {
      if (Array.isArray(entry.databases)) return entry.databases;
      return null;
    }
    return [];
  }

  _canAccessDb(user, dbName) {
    const list = this._userDbList(user);
    if (list === null) return true;
    return list.includes(dbName);
  }

  async _switchDb(conn, dbName) {
    if (!this._canAccessDb(conn.user, dbName)) {
      const err = new Error(`Access denied for user '${conn.user}' to database '${dbName}'`);
      err.code = 1044;
      throw err;
    }
    await this._getDatabase(dbName);
    conn.currentDb = dbName;
  }

  _checkAuth(user, authResponse, seed) {
    if (this.auth) {
      if (!Object.prototype.hasOwnProperty.call(this.auth, user)) return false;
      const entry = this.auth[user];
      const pwd = entry && typeof entry === 'object' ? entry.password : entry;
      if (!pwd) return authResponse.length === 0;
      const pwdHash1 = crypto.createHash('sha1').update(pwd).digest();
      const pwdHash2 = crypto.createHash('sha1').update(pwdHash1).digest();
      const seedHash = crypto.createHash('sha1').update(Buffer.concat([seed, pwdHash2])).digest();
      const expected = Buffer.alloc(20);
      for (let i = 0; i < 20; i++) expected[i] = pwdHash1[i] ^ seedHash[i];
      return authResponse.length === 20 && crypto.timingSafeEqual(expected, authResponse);
    }
    if (this.user === null) {
      // 未配置认证：默认拒绝所有登录（防配置遗漏导致认证旁路）。
      // 仅当显式设置 noAuth: true 时允许无认证连接（仅限本地开发）。
      return this.options.noAuth === true;
    }
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
    const ready = this._dbDir ? Promise.resolve() : this._getEngine();
    ready.then(() => {
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
      const stops = [];
      if (this._ownEngine && this._engine && typeof this._engine.stop === 'function') {
        stops.push(this._engine.stop());
      }
      for (const engine of this._databases.values()) {
        if (engine && typeof engine.stop === 'function') stops.push(engine.stop());
      }
      this._databases.clear();
      if (stops.length > 0) {
        Promise.allSettled(stops).then(() => cb && cb());
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
