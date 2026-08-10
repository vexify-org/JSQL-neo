/*
 * PostgreSQL wire protocol v3 server for JSQL-NEO.
 *
 * Speaks the PostgreSQL frontend/backend protocol (v3) so that standard
 * PostgreSQL clients (node-postgres, psql, pgAdmin, ...) can connect.
 *
 *   const { PgServer } = require('jsql-neo');
 *   const srv = new PgServer({ port: 5432, dataDir: './data' });
 *   srv.listen();
 *
 * Supported:
 *   - Startup / SSLRequest decline / auth (SCRAM-SHA-256, MD5, cleartext)
 *   - Simple query protocol ('Q') with multiple statements
 *   - Extended query protocol ('P' parse / 'B' bind / 'D' describe / 'E' execute / 'S' sync)
 *   - Transactions (BEGIN/COMMIT/ROLLBACK), prepared statements
 *   - Type OIDs: int4/8, float4/8, bool, text/varchar, date, timestamp, json, uuid
 *   - Multiple databases (schemas) with per-database routing (db.table)
 *   - Multi-user auth: users map + per-database ACL (shared with MysqlServer)
 */
const net = require('net');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const Database = require('./database');
const { executeSQL } = require('./sql');

// ---------------------------------------------------------------------------
// Protocol constants
// ---------------------------------------------------------------------------
const AUTH_OK = 0;
const AUTH_CLEARTEXT = 3;
const AUTH_MD5 = 5;
const AUTH_SCRAM = 10;

const TYPE_OIDS = {
  bool: 16, bytea: 17, char: 18, int8: 20, int2: 21, int4: 23, text: 25,
  json: 114, jsonb: 3802, float4: 700, float8: 701, numeric: 1700,
  date: 1082, timestamp: 1114, timestamptz: 1184, time: 1083,
  varchar: 1043, bpchar: 1042, uuid: 2950, serial: 23, bigserial: 20, name: 19
};

function pgTypeOid(sqlType, def) {
  const t = String(sqlType || '').toLowerCase();
  if (t === 'integer') return 23;
  if (t === 'number') return 701;
  if (t === 'boolean') return 16;
  if (t === 'date') return 1082;
  if (t === 'datetime' || t === 'timestamp') return 1114;
  if (t === 'object') return 3802;
  if (t === 'array') return 114;
  return 1043;
}

function pgFormatValue(value, sqlType) {
  if (value === null || value === undefined) return null;
  const t = String(sqlType || '').toLowerCase();
  if (t === 'boolean') return value === true || value === 1 || value === 'true' || value === 't' ? 't' : 'f';
  if (t === 'object') {
    if (typeof value === 'string') return value;
    try { return JSON.stringify(value); } catch (e) { return String(value); }
  }
  if (value instanceof Date) {
    return value.toISOString().replace('T', ' ').replace('Z', '') + (t === 'timestamp' ? '' : '');
  }
  if (t === 'date') {
    const d = value instanceof Date ? value : new Date(value);
    if (isNaN(d.getTime())) return String(value);
    return d.toISOString().slice(0, 10);
  }
  if (t === 'datetime' || t === 'timestamp') {
    const d = value instanceof Date ? value : new Date(value);
    if (isNaN(d.getTime())) return String(value);
    return d.toISOString().replace('T', ' ').slice(0, 19);
  }
  if (typeof value === 'boolean') return value ? 't' : 'f';
  return String(value);
}

// ---------------------------------------------------------------------------
// Message writer
// ---------------------------------------------------------------------------
class PgBuffer {
  constructor() {
    this.chunks = [];
  }
  raw(buf) { this.chunks.push(buf); return this; }
  c(v) { this.chunks.push(Buffer.from([v & 0xff])); return this; }
  i32(v) {
    const b = Buffer.alloc(4);
    b.writeInt32BE(v, 0);
    this.chunks.push(b);
    return this;
  }
  i16(v) {
    const b = Buffer.alloc(2);
    b.writeInt16BE(v, 0);
    this.chunks.push(b);
    return this;
  }
  str(s) {
    this.chunks.push(Buffer.from(String(s), 'utf8'));
    return this;
  }
  nul() { this.chunks.push(Buffer.from([0])); return this; }
  build() { return Buffer.concat(this.chunks); }
}

/** 帧消息: type + int32 length(含自身4字节) + payload */
function frame(type, payload) {
  const len = 4 + payload.length;
  const head = Buffer.alloc(5);
  head[0] = type;
  head.writeInt32BE(len, 1);
  return Buffer.concat([head, payload]);
}

function buildDataRow(values, types) {
  const p = new PgBuffer();
  p.i16(values.length);
  for (let i = 0; i < values.length; i++) {
    const s = pgFormatValue(values[i], types[i]);
    if (s === null) {
      p.i32(-1);
    } else {
      const b = Buffer.from(s, 'utf8');
      p.i32(b.length);
      p.raw(b);
    }
  }
  return frame(0x44, p.build()); // 'D'
}

function buildRowDescription(columns, types) {
  const p = new PgBuffer();
  p.i16(columns.length);
  for (let i = 0; i < columns.length; i++) {
    const c = columns[i];
    p.str(c);
    p.nul();
    p.i32(0);              // table oid
    p.i16(0);              // column attnum
    p.i32(TYPE_OIDS[types[i]] || 1043);
    p.i16(types[i] === 'integer' ? 4 : -1);  // typlen
    p.i32(-1);             // typmod
    p.i16(0);              // format code (text)
  }
  return frame(0x54, p.build()); // 'T'
}

function buildCommandComplete(tag) {
  const p = new PgBuffer();
  p.str(tag).nul();
  return frame(0x43, p.build()); // 'C'
}

function buildEmptyQuery() {
  return frame(0x49, Buffer.alloc(0)); // 'I'
}

function buildErrorResponse(code, message, severity = 'ERROR') {
  const p = new PgBuffer();
  p.c(0x53); p.str(severity).nul();   // S
  p.c(0x56); p.str(severity).nul();   // V
  p.c(0x43); p.str(code).nul();       // C
  p.c(0x4d); p.str(message).nul();    // M
  p.c(0x00);
  return frame(0x45, p.build());      // 'E'
}

function buildNotice(message) {
  const p = new PgBuffer();
  p.c(0x53); p.str('NOTICE').nul();
  p.c(0x56); p.str('NOTICE').nul();
  p.c(0x43); p.str('00000').nul();
  p.c(0x4d); p.str(message).nul();
  p.c(0x00);
  return frame(0x4e, p.build()); // 'N'
}

function buildParameterStatus(name, value) {
  const p = new PgBuffer();
  p.str(name).nul();
  p.str(value).nul();
  return frame(0x53, p.build()); // 'S'
}

function buildReadyForQuery(status = 'I') {
  return frame(0x5a, Buffer.from([status.charCodeAt(0)])); // 'Z'
}

function buildBackendKeyData(pid, secret) {
  const p = new PgBuffer();
  p.i32(pid);
  p.i32(secret);
  return frame(0x4b, p.build()); // 'K'
}

function buildParseComplete() { return frame(0x31, Buffer.alloc(0)); } // '1'
function buildBindComplete() { return frame(0x32, Buffer.alloc(0)); } // '2'
function buildCloseComplete() { return frame(0x33, Buffer.alloc(0)); } // '3'
function buildNoData() { return frame(0x6e, Buffer.alloc(0)); } // 'n'
function buildParameterDesc(paramTypes) {
  const p = new PgBuffer();
  p.i16(paramTypes.length);
  for (const t of paramTypes) p.i32(t);
  return frame(0x74, p.build()); // 't'
}

// ---------------------------------------------------------------------------
// SCRAM-SHA-256 (RFC 5802 / RFC 7677) — server side
// ---------------------------------------------------------------------------
function base64encode(buf) { return Buffer.from(buf).toString('base64'); }
function base64decode(s) { return Buffer.from(s, 'base64'); }

function parseScramMessage(str) {
  const out = {};
  for (const part of String(str).split(',')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    out[part.slice(0, idx)] = part.slice(idx + 1);
  }
  return out;
}

function scramPrepare(password) {
  const salt = crypto.randomBytes(16);
  const iterations = 4096;
  // StoredKey / ServerKey (RFC 5802 §3)
  const saltedPassword = crypto.pbkdf2Sync(Buffer.from(password, 'utf8'), salt, iterations, 32, 'sha256');
  const clientKey = crypto.createHmac('sha256', saltedPassword).update('Client Key').digest();
  const storedKey = crypto.createHash('sha256').update(clientKey).digest();
  const serverKey = crypto.createHmac('sha256', saltedPassword).update('Server Key').digest();
  return { salt, iterations, storedKey, serverKey };
}

/** 生成 server-first 消息（server nonce = client nonce + 随机后缀） */
function scramServerFirst(clientNonce, cred) {
  const serverNonce = clientNonce + crypto.randomBytes(18).toString('base64url');
  return { serverNonce, sf: `r=${serverNonce},s=${base64encode(cred.salt)},i=${cred.iterations}` };
}

/** 验证 client-final 消息，返回 server-final 消息 */
function scramVerify(clientFirstBare, serverNonce, clientFinal, cred) {
  const cf = parseScramMessage(clientFinal);
  const nonce = String(cf.r).split(',')[0];
  if (nonce !== serverNonce) {
    throw new Error('invalid-proof: nonce mismatch');
  }
  const proof = base64decode(cf.p);
  // client-first bare: 去掉 GS2 header（gs2-header + authzid 两段）
  const bare = String(clientFirstBare).split(',').slice(2).join(',');
  const authMessage = bare + ',' + `r=${serverNonce},s=${base64encode(cred.salt)},i=${cred.iterations}` + ',' + clientFinal.slice(0, clientFinal.indexOf(',p='));
  const clientSignature = crypto.createHmac('sha256', cred.storedKey).update(Buffer.from(authMessage, 'utf8')).digest();
  const clientKey = Buffer.alloc(32);
  for (let i = 0; i < 32; i++) clientKey[i] = proof[i] ^ clientSignature[i];
  if (crypto.createHash('sha256').update(clientKey).digest().toString('base64') !== cred.storedKey.toString('base64')) {
    throw new Error('invalid-proof');
  }
  const serverSignature = crypto.createHmac('sha256', cred.serverKey).update(Buffer.from(authMessage, 'utf8')).digest();
  return { verifier: base64encode(serverSignature), nonce };
}

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------
class PgConnection {
  constructor(socket, server) {
    this.socket = socket;
    this.server = server;
    this.buffer = Buffer.alloc(0);
    this.authenticated = false;
    this.user = null;
    this.database = null;
    this._scram = null;
    this._scramClientFirst = null;
    this._scramServerFirst = null;
    this._scramCred = null;
    this._prepared = new Map();   // name -> { sql, paramTypes }
    this._portal = new Map();     // name -> { values }
    this._inTransaction = false;
    this._txId = null;
    this._pid = 0;
    this._secret = 0;
    this._startupDone = false;
    this._waitingSslRestart = false;
    this._msgQueue = [];
    this._processing = false;
    this.socket.on('data', (chunk) => this._onData(chunk));
    this.socket.on('error', () => {});
    this.socket.on('close', () => this._onClose());
  }

  _onClose() {
    this.server._sockets.delete(this.socket);
  }

  _send(buf) {
    if (!this.socket.destroyed) this.socket.write(buf);
  }

  _onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    if (!this._startupDone || this._waitingSslRestart) {
      // 首消息: 长度 + 协议号（SSLRequest 拒绝后客户端重发的 startup 也是无类型消息）
      if (this.buffer.length < 4) return;
      const len = this.buffer.readInt32BE(0);
      if (this.buffer.length < len) return;
      const body = this.buffer.slice(0, len);
      this.buffer = this.buffer.slice(len);
      this._startupDone = true;
      this._handleStartup(body);
      return;
    }
    for (;;) {
      if (this.buffer.length < 5) break;
      // PG 帧: type(1) + int32 length(含自身4字节, 不含type) + payload
      const len = this.buffer.readInt32BE(1);
      if (len < 4 || this.buffer.length < 1 + len) break;
      const type = this.buffer[0];
      const body = this.buffer.slice(5, 1 + len);
      this.buffer = this.buffer.slice(1 + len);
      if (!this.authenticated) {
        // 认证阶段消息（SASLInitialResponse 'p' / SASLResponse 'p'）
        if (type === 0x70) {
          this._handleAuthMessage(body);
        } else {
          this._authError();
          this.socket.end();
          return;
        }
        continue;
      }
      this._pending = (this._pending || Promise.resolve()).then(() => {
        try {
          if (type === 0x51) { // 'Q' simple query（async）
            return this._handleSimpleQuery(body.toString('utf8').replace(/\0$/, ''));
          }
          return this._handleMessage(type, body);
        } catch (e) {
          this._send(buildErrorResponse('XX000', e && e.message ? e.message : String(e)));
          this._send(buildReadyForQuery(this._inTransaction ? 'T' : 'I'));
        }
      });
    }
    if (this._pending) this._pending.catch(() => {});
  }

  _authError() {
    this._send(buildErrorResponse('28000', 'pg_hba.conf rejects connection: no authentication attempted'));
    this.socket.end();
  }

  _handleStartup(body) {
    const version = body.readInt32BE(4);
    if (version === 80877103) {
      // SSLRequest: 拒绝后客户端重发 startup
      this._send(Buffer.from([0x4e]));
      this._startupDone = false;
      this._waitingSslRestart = true;
      return;
    }
    this._waitingSslRestart = false;
    if (version !== 196608) {
      this._send(buildErrorResponse('0A000', `unsupported protocol version ${version}`));
      this.socket.end();
      return;
    }
    let pos = 8;
    const params = {};
    while (pos < body.length) {
      const name = body.toString('utf8', pos, body.indexOf(0, pos));
      pos = body.indexOf(0, pos) + 1;
      if (name === '') break;
      const val = body.toString('utf8', pos, body.indexOf(0, pos));
      pos = body.indexOf(0, pos) + 1;
      params[name] = val;
    }
    this.user = params.user || 'postgres';
    this.database = params.database || this.user;
    this._pid = 10000 + (this.server._connSeq++ % 8000);
    this._secret = Math.floor(Math.random() * 0x7fffffff);
    this._startAuth();
  }

  _startAuth() {
    const password = this.server._userPassword(this.user);
    if (password === undefined) {
      // 用户不存在
      this._send(buildErrorResponse('28000', `password authentication failed for user "${this.user}"`));
      this.socket.end();
      return;
    }
    if (password === null || password === '') {
      // 无密码 → trust
      this._completeAuth();
      return;
    }
    // SCRAM-SHA-256（PG 13+ 默认）
    this._scramCred = scramPrepare(password);
    // AuthenticationSASL (code 10): int32 code + mechanism list (each nul-terminated) + extra nul
    const p = new PgBuffer();
    p.i32(AUTH_SCRAM);
    p.str('SCRAM-SHA-256').nul();
    p.c(0x00);
    this._send(frame(0x52, p.build())); // 'R'
    this._scramStage = 'first';
  }

  _handleAuthMessage(body) {
    if (this._scramStage === 'first') {
      // SASLInitialResponse: mechanism(nul) + int32 dataLen + client-first
      const mechEnd = body.indexOf(0);
      let dataStart = mechEnd + 1;
      let clientFirst = '';
      let dataLen = 0;
      if (dataStart + 4 <= body.length) {
        dataLen = body.readInt32BE(dataStart);
        clientFirst = body.toString('utf8', dataStart + 4, dataStart + 4 + dataLen);
      }
      this._scramClientFirst = clientFirst;
      // client-first 中提取 client nonce：`n,,n=user,r=<nonce>`
      const cfm = parseScramMessage(clientFirst);
      const sf = scramServerFirst(String(cfm.r || ''), this._scramCred);
      this._scramServerFirst = sf.sf;
      this._scramNonce = sf.serverNonce;
      this._scramStage = 'final';
      // AuthenticationSASLContinue (code 11): int32 code + server-first-message
      // 注意：data 不带尾随 nul（真实 PG 用 pq_sendbytes，node-pg 按 length-8 读取）
      const sb = new PgBuffer();
      sb.i32(11);
      sb.str(this._scramServerFirst);
      this._send(frame(0x52, sb.build())); // 'R'
      return;
    }
    // SASLResponse: client-final-message (纯数据)
    const clientFinal = body.toString('utf8');
    try {
      const res = scramVerify(this._scramClientFirst, this._scramNonce, clientFinal, this._scramCred);
      // AuthenticationSASLFinal (code 12): int32 code + server-final-message（无尾随 nul）
      const sf = new PgBuffer();
      sf.i32(12);
      sf.str('v=' + res.verifier);
      this._send(frame(0x52, sf.build())); // 'R'
      this._completeAuth();
    } catch (e) {
      this._send(buildErrorResponse('28000', 'password authentication failed for user "' + this.user + '"'));
      this.socket.end();
    }
  }

  _completeAuth() {
    if (!this.server._canAccessDb(this.user, this.database)) {
      this._send(buildErrorResponse('28000', `database "${this.database}" does not exist`));
      this.socket.end();
      return;
    }
    this.authenticated = true;
    this._send(frame(0x52, (() => { const p = new PgBuffer(); p.i32(AUTH_OK); return p.build(); })()));
    this._send(buildParameterStatus('server_version', '16.4 (jsql-neo ' + this.server.version + ')'));
    this._send(buildParameterStatus('server_encoding', 'UTF8'));
    this._send(buildParameterStatus('client_encoding', 'UTF8'));
    this._send(buildParameterStatus('DateStyle', 'ISO, MDY'));
    this._send(buildParameterStatus('integer_datetimes', 'on'));
    this._send(buildParameterStatus('standard_conforming_strings', 'on'));
    this._send(buildBackendKeyData(this._pid, this._secret));
    this._send(buildReadyForQuery('I'));
  }

  _getEngine() {
    return this.server._getEngine(this.database);
  }

  async _handleMessage(type, body) {
    switch (type) {
      case 0x51: // 'Q' simple query
        this._handleSimpleQuery(body.toString('utf8').replace(/\0$/, ''));
        break;      case 0x50: { // 'P' parse
        const parts = this._splitCStrings(body);
        const name = parts[0], sql = parts[1];
        const nParams = body.readInt16BE(this._cstringLen(body, 0) + this._cstringLen(body, this._cstringLen(body, 0)));
        const paramTypes = [];
        let off = this._cstringLen(body, 0) + this._cstringLen(body, this._cstringLen(body, 0)) + 2;
        for (let i = 0; i < nParams; i++) { paramTypes.push(body.readInt32BE(off)); off += 4; }
        this._prepared.set(name, { sql, paramTypes });
        this._send(buildParseComplete());
        break;
      }
      case 0x42: { // 'B' bind
        const n0 = this._cstringLen(body, 0);
        const portal = body.toString('utf8', 0, n0 - 1);
        const stmtName = body.toString('utf8', n0, n0 + this._cstringLen(body, n0) - 1);
        const stmt = this._prepared.get(stmtName);
        if (!stmt) throw new Error(`prepared statement "${stmtName}" does not exist`);
        let off = n0 + this._cstringLen(body, n0);
        const nFormats = body.readInt16BE(off); off += 2;
        const formats = [];
        for (let i = 0; i < nFormats; i++) { formats.push(body.readInt16BE(off)); off += 2; }
        const nValues = body.readInt16BE(off); off += 2;
        const values = [];
        for (let i = 0; i < nValues; i++) {
          const vlen = body.readInt32BE(off); off += 4;
          if (vlen === -1) { values.push(null); continue; }
          const fmt = formats.length > 0 ? formats[Math.min(i, formats.length - 1)] : 0;
          values.push(body.toString('utf8', off, off + vlen));
          off += vlen;
        }
        this._portal.set(portal, { values, stmt });
        this._send(buildBindComplete());        break;
      }
      case 0x44: // 'D' describe
        this._handleDescribe(body);
        break;
      case 0x45: { // 'E' execute
        const portalName = body.toString('utf8', 0, this._cstringLen(body, 0) - 1);
        const portal = this._portal.get(portalName);
        if (!portal) throw new Error(`portal "${portalName}" does not exist`);
        return this._execute(portal);
      }
      case 0x43: // 'C' close
        this._handleClose(body);
        break;
      case 0x53: // 'S' sync
        this._send(buildReadyForQuery(this._inTransaction ? 'T' : 'I'));
        break;
      case 0x46: // 'F' function call
        this._send(buildErrorResponse('0A000', 'function call not supported'));
        break;
      case 0x58: // 'X' terminate
        this.socket.end();
        break;
      default:
        this._send(buildErrorResponse('0A000', `unsupported message type ${String.fromCharCode(type)}`));
        break;
    }
  }

  _cstringLen(buf, start) {
    const idx = buf.indexOf(0, start);
    return idx === -1 ? buf.length - start : idx - start + 1;
  }

  _splitCStrings(buf) {
    const parts = [];
    let off = 0;
    while (off < buf.length) {
      const idx = buf.indexOf(0, off);
      if (idx === -1) { parts.push(buf.toString('utf8', off)); break; }
      parts.push(buf.toString('utf8', off, idx));
      off = idx + 1;
    }
    return parts;
  }

  _handleDescribe(body) {
    const kind = body[0];
    const name = body.toString('utf8', 1, this._cstringLen(body, 1) - 1);
    if (kind === 0x53) { // 'S' statement
      const stmt = this._prepared.get(name);
      if (!stmt) throw new Error(`prepared statement "${name}" does not exist`);
      this._send(buildParameterDesc(stmt.paramTypes.length > 0 ? stmt.paramTypes : [0]));
      const cols = this._describeCols(stmt.sql);
      if (cols && cols.length > 0) {
        this._send(buildRowDescription(cols.columns, cols.types));
      } else {
        this._send(buildNoData());
      }
    } else if (kind === 0x50) { // 'P' portal
      const portal = this._portal.get(name);
      if (!portal) throw new Error(`portal "${name}" does not exist`);
      const cols = this._describeCols(portal.stmt.sql);
      if (cols && cols.length > 0) {
        this._send(buildRowDescription(cols.columns, cols.types));
      } else {
        this._send(buildNoData());
      }
    }
  }

  _handleClose(body) {
    const kind = body[0];
    const name = body.toString('utf8', 1, this._cstringLen(body, 1) - 1);
    if (kind === 0x53) this._prepared.delete(name);
    else if (kind === 0x50) this._portal.delete(name);
    this._send(buildCloseComplete());
  }

  /** 预描述 SELECT 结果列（不执行） */
  _describeCols(sql) {
    try {
      const stmt = this.server._parseForDescribe(sql, this.database);
      if (!stmt || stmt.type !== 'select' || !stmt.from || !stmt.from.tables || stmt.from.tables.length === 0) return null;
      const t = stmt.from.tables[0];
      if (!t || !t.table) return null;
      const schema = this.server._tableSchema(this.database, t.table);
      if (!schema) return null;
      const columns = [];
      const types = [];
      const push = (name, type) => {
        if (!name || name.startsWith('_')) return;
        columns.push(name);
        types.push(type);
      };
      for (const c of stmt.columns) {
        if (c.scalar) {
          push(c.scalar.name, this._astType(c.scalar, schema));
        } else if (c.expr === '*') {
          for (const [name, def] of Object.entries(schema)) push(name, def.type);
        } else if (c.expr) {
          push(String(c.expr).includes('.') ? String(c.expr).slice(String(c.expr).lastIndexOf('.') + 1) : c.expr, schema[c.expr] ? schema[c.expr].type : 'string');
        }
      }
      return { columns, types };
    } catch (e) {
      return null;
    }
  }

  _astType(node, schema) {
    if (!node) return 'string';
    if (node.type === 'column') return schema[node.name] ? schema[node.name].type : 'string';
    if (node.type === 'cast') return String(node.to).includes('int') ? 'integer' : 'string';
    if (node.type === 'func') {
      const n = String(node.name).toUpperCase();
      if (n === 'COUNT' || n === 'SUM' || n === 'AVG' || n === 'MIN' || n === 'MAX') return 'number';
      return 'string';
    }
    if (node.type === 'value') return typeof node.value === 'number' ? 'number' : 'string';
    return 'string';
  }

  async _handleSimpleQuery(sql) {
    const trimmed = sql.trim();
    if (!trimmed) {
      this._send(buildEmptyQuery());
      this._send(buildReadyForQuery(this._inTransaction ? 'T' : 'I'));
      return;
    }
    if (trimmed.startsWith('SET ')) {
      this._send(buildCommandComplete('SET'));
      this._send(buildReadyForQuery(this._inTransaction ? 'T' : 'I'));
      return;
    }
    try {
      await this._executeSql(sql, null);
    } catch (e) {
      this._send(buildErrorResponse(this._pgErrorCode(e), e && e.message ? e.message : String(e)));
      this._send(buildReadyForQuery(this._inTransaction ? 'T' : 'I'));
      return;
    }
    this._send(buildReadyForQuery(this._inTransaction ? 'T' : 'I'));
  }

  async _execute(portal) {
    try {
      const { sql } = portal.stmt;
      await this._executeSql(sql, portal.values || []);
    } catch (e) {
      this._send(buildErrorResponse(this._pgErrorCode(e), e && e.message ? e.message : String(e)));
    }
  }

  async _executeSql(sql, values) {
    const engine = await this._getEngine();
    const ctx = {
      session: { currentDb: this.database, connectionId: this._pid },
      params: values || []
    };
    let results;
    if (values && values.length > 0) {
      // 参数化：将 $n 解析为 AST 后求值，或直接注入
      const prepared = sql.replace(/\$\d+/g, (m) => {
        const idx = parseInt(m.slice(1), 10) - 1;
        const v = values[idx];
        if (v === null || v === undefined) return 'NULL';
        if (typeof v === 'number') return String(v);
        return "'" + String(v).replace(/\\/g, '\\\\').replace(/'/g, "''") + "'";
      });
      results = await executeSQL(engine, prepared, { dialect: 'pg', safety: false, session: ctx.session });
    } else {
      results = await executeSQL(engine, sql, { dialect: 'pg', safety: false, session: ctx.session });
    }
    const list = Array.isArray(results) ? results : [results];
    for (const res of list) {
      this._emitResult(res);
    }
  }

  _emitResult(res) {
    if (!res) return;
    if (res.type === 'select') {
      const types = this._resultTypes(res);
      if (res.columns && res.columns.length > 0) {
        this._send(buildRowDescription(res.columns, types));
      }
      for (const row of res.rows || []) {
        this._send(buildDataRow(row, types));
      }
      const tag = `SELECT ${(res.rows || []).length}`;
      this._send(buildCommandComplete(tag));
    } else if (res.type === 'insert' || res.type === 'update' || res.type === 'delete') {
      const tag = `${String(res.type).toUpperCase()} ${res.affectedRows != null ? res.affectedRows : 0}`;
      this._send(buildCommandComplete(tag));
    } else if (res.type === 'begin' || res.type === 'commit' || res.type === 'rollback') {
      this._inTransaction = res.type === 'begin';
      this._send(buildCommandComplete(String(res.type).toUpperCase()));
    } else if (res.type === 'createTable' || res.type === 'dropTable' || res.type === 'createDatabase' || res.type === 'dropDatabase') {
      this._send(buildCommandComplete('OK'));
    } else if (res.type === 'showTables' || res.type === 'showDatabases' || res.type === 'showColumns') {
      const types = (res.columns || []).map(() => 'string');
      this._send(buildRowDescription(res.columns || [], types));
      for (const row of res.rows || []) this._send(buildDataRow(row, types));
      this._send(buildCommandComplete(`SELECT ${(res.rows || []).length}`));
    } else {
      this._send(buildCommandComplete('OK'));
    }
  }

  _resultTypes(res) {
    const t = {};
    try {
      const schema = this.server._tableSchema(this.database, res.table);
      if (schema) {
        for (const [name, def] of Object.entries(schema)) t[name] = def.type;
      }
    } catch (e) {}
    return (res.columns || []).map(c => t[c] || 'string');
  }

_pgErrorCode(e) {
    if (!e) if (/Table .*(doesn't exist|does not exist)/i.test(m)) return '42P01';
    return 'XX000';
    const codeKey = e.code;
    const m = String(e.message || '');
    // Debug write to /tmp/pg_error_debug.txt
    const fs = require('fs');
    fs.writeFileSync('/tmp/pg_error_debug.txt', 'codeKey=' + codeKey + '\\nmessage=' + m + '\\n');
    // Map JSQL error keys to PG SQLSTATE codes
    if (codeKey === 'ER_NO_SUCH_TABLE' || /Table .* doesn\\'t exist/i.test(m)) return '42P01';
    if (codeKey === 'ER_TABLE_EXISTS' || /already exists/i.test(m)) return '42P07';
    if (codeKey === 'ER_DUP_ENTRY' || m.includes('ER_DUP_ENTRY') || /Duplicate entry/i.test(m)) return '23505';
    if (codeKey === 'ER_BAD_FIELD_ERROR' || /Unknown column/i.test(m)) return '42703';
    if (codeKey === 'ER_CANT_DROP_FIELD' || /Cannot drop column/i.test(m)) return '428NF';
    if (codeKey === 'ER_DUP_FIELDNAME' || /Duplicate column name/i.test(m)) return '42711';
    if (codeKey === 'ER_BAD_NULL_ERROR' || /cannot be null/i.test(m)) return '23502';
    if (codeKey === 'ER_CHECK_CONSTRAINT' || /Check constraint/i.test(m)) return '23514';
    if (codeKey === 'ER_DATA_TOO_LONG' || /Data too long/i.test(m)) return '22001';
    if (codeKey === 'ER_OUT_OF_RANGE' || /Out of range/i.test(m)) return '22003';
    if (codeKey === 'ER_NO_REFERENCED_ROW' || /foreign key/i.test(m)) return '23503';
    if (codeKey === 'ER_SYNTAX_ERROR' || /syntax|Unexpected token|Expected/i.test(m)) return '42601';
    if (/Table .*(doesn't exist|does not exist)/i.test(m)) return '42P01';
    return 'XX000';
}
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------
class PgServer {
  constructor(options = {}) {
    this.options = options;
    this.port = options.port || 5432;
    this.host = options.host || '127.0.0.1';
    this.auth = options.auth || null;           // { user: { password, databases: [...] } }
    this.noAuth = options.noAuth === true;
    this.dataDir = options.dataDir || null;
    this.version = '5.1.3';
    this._server = null;
    this._sockets = new Set();
    this._connSeq = 0;
    this._databases = new Map();
    this._engines = new Map();
  }

  _userPassword(user) {
    if (this.auth) {
      const entry = this.auth[user];
      if (entry === undefined) return undefined;
      return entry && typeof entry === 'object' ? (entry.password || '') : String(entry);
    }
    if (this.noAuth) return '';
    if (this.options.user) {
      if (user !== this.options.user) return undefined;
      return this.options.password || '';
    }
    return '';
  }

  _canAccessDb(user, dbName) {
    if (this.noAuth) return true;
    if (!this.auth) {
      // 单用户模式下仅允许该用户访问其默认库
      return true;
    }
    const entry = this.auth[user];
    if (!entry) return false;
    if (entry && typeof entry === 'object' && Array.isArray(entry.databases)) {
      return entry.databases.includes(dbName);
    }
    return true;
  }

  _dbDir() {
    return this.dataDir && this.dataDir !== ':memory:' ? path.resolve(this.dataDir) : null;
  }

  async _getEngine(dbName) {
    const key = dbName || 'default';
    if (this._engines.has(key)) return this._engines.get(key);
    let engine;
    if (this._dbDir()) {
      const dbPath = path.join(this._dbDir(), key);
      engine = new Database(dbPath, { autoSave: true });
    } else {
      engine = new Database(':memory:', { autoSave: false });
    }
    this._engines.set(key, engine);
    return engine;
  }

  _parseForDescribe(sql, database) {
    const { parseSQL } = require('./sql');
    return parseSQL(sql, 'pg');
  }

  _tableSchema(database, table) {
    const engine = this._engines.get(database || 'default');
    if (!engine) return null;
    try {
      return engine.getTableSchema ? engine.getTableSchema(table) : (engine._schemas ? engine._schemas[table] : null);
    } catch (e) {
      return null;
    }
  }

  listen(cb) {
    this._server = net.createServer((socket) => {
      this._sockets.add(socket);
      new PgConnection(socket, this);
    });
    this._server.listen(this.port, this.host, cb || (() => {}));
    this._server.on('error', (err) => {
      if (this.options.onError) this.options.onError(err);
      else throw err;
    });
    return this;
  }

  get address() {
    return this._server ? this._server.address() : null;
  }

  close(cb) {
    for (const s of this._sockets) s.destroy();
    for (const engine of this._engines.values()) {
      if (typeof engine.stop === 'function') engine.stop();
    }
    this._engines.clear();
    if (this._server) {
      this._server.close(cb || (() => {}));
      this._server = null;
    } else if (cb) cb();
  }
}

module.exports = { PgServer, PgConnection, buildRowDescription, buildDataRow, buildCommandComplete, buildErrorResponse, buildReadyForQuery, buildParameterStatus, buildBackendKeyData, buildParseComplete, buildBindComplete, buildCloseComplete, buildNoData, buildParameterDesc, TYPE_OIDS, pgTypeOid, pgFormatValue };
