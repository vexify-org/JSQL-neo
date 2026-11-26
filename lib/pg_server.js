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

function pgSchemaType(def) {
  if (!def) return 'string';
  if (def.intType === 'bigint') return 'bigint';
  if (def.numericType === 'numeric') return 'numeric';
  if (def.rawType) return def.rawType;
  return def.type;
}

// 类型 OID 口径：PostgreSQL 16 pg_type.h（#371）
function pgTypeOid(sqlType) {
  const t = String(sqlType || '').toLowerCase();
  switch (t) {
    case 'bigint': case 'int8': case 'bigserial': return 20;
    case 'smallint': case 'int2': return 21;
    case 'integer': case 'int': case 'int4': case 'serial': return 23;
    case 'boolean': case 'bool': return 16;
    case 'bytea': return 17;
    case 'text': case 'string': case 'name': return 25;
    case 'char': return 18;
    case 'varchar': case 'bpchar': case 'character varying': return 1043;
    case 'date': return 1082;
    case 'time': return 1083;
    case 'timestamp': case 'datetime': return 1114;
    case 'timestamptz': return 1184;
    case 'real': case 'float4': return 700;
    case 'double': case 'double precision': case 'float': case 'float8': case 'number': return 701;
    case 'numeric': case 'decimal': return 1700;
    case 'json': return 114;
    case 'jsonb': case 'object': return 3802;
    case 'uuid': return 2950;
    case 'array': return 1009;           // text[] 兜底（引擎未保留元素类型）
    default: return 1043;
  }
}

// RowDescription.typlen：定长类型给字节宽，变长类型给 -1（#371）
function pgTypeLen(sqlType) {
  const t = String(sqlType || '').toLowerCase();
  if (t === 'boolean' || t === 'bool') return 1;
  if (t === 'smallint' || t === 'int2') return 2;
  if (t === 'integer' || t === 'int' || t === 'int4' || t === 'serial') return 4;
  if (t === 'bigint' || t === 'int8' || t === 'bigserial') return 8;
  if (t === 'real' || t === 'float4') return 4;
  if (t === 'double' || t === 'double precision' || t === 'float' || t === 'float8' || t === 'number') return 8;
  // 保持 #371 既有的 typlen 口径（timestamptz/uuid 等仍通告 -1）
  return -1;
}

function pgFormatValue(value, sqlType) {
  if (value === null || value === undefined) return null;
  const t = String(sqlType || '').toLowerCase();
  // #386：bytea 文本输出按 PG 默认 bytea_output=hex：`\x` + 小写十六进制
  if (t === 'bytea') {
    const buf = Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8');
    return '\\x' + buf.toString('hex');
  }
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
    // #215：引擎 TIMESTAMP 存 Unix 秒；数值必须按秒还原，不能当毫秒
    if (typeof value === 'number') {
      const ms = value < 1e12 ? value * 1000 : value;
      const d = new Date(ms);
      if (isNaN(d.getTime())) return String(value);
      return d.toISOString().replace('T', ' ').slice(0, 19);
    }
    // DATETIME 在引擎里是 'YYYY-MM-DD HH:MM:SS' 字符串，原样透传，不要二次换算时区
    if (typeof value === 'string') return value;
    const d = value instanceof Date ? value : new Date(value);
    if (isNaN(d.getTime())) return String(value);
    return d.toISOString().replace('T', ' ').slice(0, 19);
  }
  // #214：numeric 以十进制字符串下发，避免 double 二次舍入
  if (t === 'numeric' || t === 'decimal') return String(value);
  if (typeof value === 'boolean') return value ? 't' : 'f';
  return String(value);
}

// #378/#353/#370：解析层不认识的命令由服务端自己处理，Parse 校验时放行
function isPgSpecialCommand(sql) {
  return /^\s*(LISTEN|UNLISTEN|NOTIFY|COPY)\b/i.test(String(sql || ''));
}

// #380：按顶层分号切分语句（跳过字符串/注释里的分号），用于判定是否需要隐式事务
function pgSplitStatements(sql) {
  const parts = []; let cur = '';
  let inSingle = false, inDouble = false, inLine = false, inBlock = false;
  const s = String(sql || '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i], n = s[i + 1];
    if (inLine) { cur += c; if (c === '\n') inLine = false; continue; }
    if (inBlock) { cur += c; if (c === '*' && n === '/') { cur += n; i++; inBlock = false; } continue; }
    if (inSingle) { cur += c; if (c === "'") { if (n === "'") { cur += n; i++; } else inSingle = false; } continue; }
    if (inDouble) { cur += c; if (c === '"') { if (n === '"') { cur += n; i++; } else inDouble = false; } continue; }
    if (c === '-' && n === '-') { cur += '-'; cur += '-'; i++; inLine = true; continue; }
    if (c === '/' && n === '*') { cur += '/'; cur += '*'; i++; inBlock = true; continue; }
    if (c === "'") { inSingle = true; cur += c; continue; }
    if (c === '"') { inDouble = true; cur += c; continue; }
    if (c === ';') { parts.push(cur); cur = ''; continue; }
    cur += c;
  }
  parts.push(cur);
  return parts.map((p) => p.trim()).filter(Boolean);
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

// #374：PG 二进制 numeric — int16 ndigits/weight/sign/dscale + base-10000 数字数组
function pgEncodeNumericBinary(value) {
  let s = String(value == null ? '' : value).trim();
  if (!/^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(s)) {
    const b = Buffer.alloc(8); b.writeDoubleBE(Number(value) || 0, 0); return b;
  }
  let sign = 0;
  if (s[0] === '-') { sign = 0x4000; s = s.slice(1); }
  else if (s[0] === '+') s = s.slice(1);
  let exp = 0;
  const em = /[eE][+-]?\d+$/.exec(s);
  if (em) { exp = Number(s.slice(em.index + 1)); s = s.slice(0, em.index); }
  let [intPart, fracPart = ''] = s.split('.');
  if (exp > 0) intPart += '0'.repeat(exp);
  else if (exp < 0) {
    const digits = intPart + fracPart, cut = -exp;
    if (cut >= digits.length) { intPart = '0'; fracPart = '0'.repeat(cut - digits.length) + digits; }
    else { const pos = digits.length - cut; intPart = digits.slice(0, pos); fracPart = digits.slice(pos); }
  }
  const dscale = fracPart.length;
  const intPad = (4 - (intPart.length % 4)) % 4;
  const fracPad = (4 - (fracPart.length % 4)) % 4;
  const all = '0'.repeat(intPad) + intPart + fracPart + '0'.repeat(fracPad);
  const groups = [];
  for (let i = 0; i < all.length; i += 4) groups.push(Number(all.slice(i, i + 4)));
  let weight = (intPart.length + intPad) / 4 - 1;
  while (groups.length > 1 && groups[0] === 0) { groups.shift(); weight--; }
  while (groups.length > 1 && groups[groups.length - 1] === 0) groups.pop();
  if (groups.length === 1 && groups[0] === 0) { groups.length = 0; weight = 0; }
  const p = new PgBuffer();
  p.i16(groups.length); p.i16(weight); p.i16(sign); p.i16(dscale);
  for (const g of groups) p.i16(g);
  return p.build();
}

function pgDateMillis(value) {
  if (value instanceof Date) return Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate());
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value));
  if (m) return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const ms = Date.parse(String(value));
  return isNaN(ms) ? 0 : ms;
}

function pgTimestampMillis(value) {
  if (typeof value === 'number') return value < 1e12 ? value * 1000 : value; // #215 引擎存 Unix 秒
  if (value instanceof Date) return value.getTime();
  let s = String(value).trim().replace(' ', 'T');
  if (!/[zZ+-]\d{2}:?\d{2}$/.test(s)) s += 'Z';
  const ms = Date.parse(s);
  return isNaN(ms) ? 0 : ms;
}

// #277/#374：按列的结果格式码编码二进制 DataRow
function pgEncodeBinary(value, type) {
  const t = String(type || '').toLowerCase();
  if (value === null || value === undefined) return Buffer.alloc(0);
  if (t === 'boolean' || t === 'bool') return Buffer.from([value ? 1 : 0]);
  if (t === 'smallint' || t === 'int2') {
    const b = Buffer.alloc(2); b.writeInt16BE(Number(value) | 0, 0); return b;
  }
  if (t === 'integer' || t === 'int' || t === 'int4' || t === 'serial') {
    const b = Buffer.alloc(4); b.writeInt32BE(Number(value) | 0, 0); return b;
  }
  if (t === 'bigint' || t === 'int8' || t === 'bigserial') {
    const b = Buffer.alloc(8); b.writeBigInt64BE(BigInt(value), 0); return b;
  }
  if (t === 'numeric' || t === 'decimal') return pgEncodeNumericBinary(value);
  if (t === 'real' || t === 'float4') {
    const b = Buffer.alloc(4); b.writeFloatBE(Number(value), 0); return b;
  }
  if (t === 'number' || t === 'float' || t === 'float8') {
    const b = Buffer.alloc(8); b.writeDoubleBE(Number(value), 0); return b;
  }
  if (t === 'date') {
    const b = Buffer.alloc(4);
    b.writeInt32BE(Math.floor((pgDateMillis(value) - Date.UTC(2000, 0, 1)) / 86400000), 0);
    return b;
  }
  if (t === 'timestamp' || t === 'timestamptz' || t === 'datetime') {
    const b = Buffer.alloc(8);
    b.writeBigInt64BE(BigInt((pgTimestampMillis(value) - Date.UTC(2000, 0, 1)) * 1000), 0);
    return b;
  }
  if (t === 'uuid') return Buffer.from(String(value).replace(/-/g, ''), 'hex');
  if (t === 'bytea') {
    if (Buffer.isBuffer(value)) return value;
    const s = String(value);
    // 引擎可能吃掉 SQL 字面量里的反斜杠，兼容 `\x...` 与 `x...` 两种十六进制文本输出
    const hm = /^(?:\\x|x)([0-9a-fA-F]+)$/.exec(s);
    if (hm && hm[1].length % 2 === 0) return Buffer.from(hm[1], 'hex');
    return Buffer.from(s, 'utf8');
  }
  return Buffer.from(pgFormatValue(value, type) === null ? '' : String(pgFormatValue(value, type)), 'utf8');
}

function buildDataRow(values, types, formats) {
  const p = new PgBuffer();
  p.i16(values.length);
  for (let i = 0; i < values.length; i++) {
    const fmt = formats && formats.length ? (formats.length === 1 ? formats[0] : formats[i]) : 0;
    if (values[i] === null || values[i] === undefined) {
      p.i32(-1);
      continue;
    }
    const b = fmt === 1
      ? pgEncodeBinary(values[i], types[i])
      : Buffer.from(pgFormatValue(values[i], types[i]) === null ? '' : String(pgFormatValue(values[i], types[i])), 'utf8');
    p.i32(b.length);
    p.raw(b);
  }
  return frame(0x44, p.build()); // 'D'
}

function buildRowDescription(columns, types, formats) {
  const p = new PgBuffer();
  p.i16(columns.length);
  for (let i = 0; i < columns.length; i++) {
    const c = columns[i];
    const fmt = formats && formats.length ? (formats.length === 1 ? formats[0] : formats[i]) : 0;
    p.str(c);
    p.nul();
    p.i32(0);              // table oid
    p.i16(0);              // column attnum
    p.i32(pgTypeOid(types[i]));
    p.i16(pgTypeLen(types[i]));  // typlen
    p.i32(-1);             // typmod
    p.i16(fmt === 1 ? 1 : 0);  // format code
  }
  return frame(0x54, p.build()); // 'T'
}

function buildCommandComplete(tag) {
  const p = new PgBuffer();
  p.str(tag).nul();
  return frame(0x43, p.build()); // 'C'
}

// #370：COPY 子协议帧
function buildCopyOutResponse(columns) {
  const p = new PgBuffer();
  p.c(0); p.i16(columns);                       // 整体 text 格式
  for (let i = 0; i < columns; i++) p.i16(0);    // 每列 text 格式
  return frame(0x48, p.build()); // 'H'
}
function buildCopyInResponse(columns) {
  const p = new PgBuffer();
  p.c(0); p.i16(columns);
  for (let i = 0; i < columns; i++) p.i16(0);
  return frame(0x47, p.build()); // 'G'
}
function buildCopyData(buf) { return frame(0x64, buf); } // 'd'
function buildCopyDone() { return frame(0x63, Buffer.alloc(0)); } // 'c'

// #353：后端主动推送的异步通知帧
function buildNotification(pid, channel, payload) {
  const p = new PgBuffer();
  p.i32(pid); p.str(channel).nul(); p.str(payload || '').nul();
  return frame(0x41, p.build()); // 'A'
}

function buildEmptyQuery() {
  return frame(0x49, Buffer.alloc(0)); // 'I'
}

function buildErrorResponse(code, message, severity = 'ERROR', extra = {}) {
  const p = new PgBuffer();
  p.c(0x53); p.str(severity).nul();   // S
  p.c(0x56); p.str(severity).nul();   // V
  p.c(0x43); p.str(code).nul();       // C
  p.c(0x4d); p.str(message).nul();    // M
  // #377：PG 客户端依赖 D/H/P 定位问题；此前这些字段完全不会出现
  if (extra.detail) { p.c(0x44); p.str(extra.detail).nul(); } // D
  if (extra.hint) { p.c(0x48); p.str(extra.hint).nul(); }     // H
  if (extra.position != null && Number.isFinite(Number(extra.position))) {
    p.c(0x50); p.str(String(extra.position)).nul();           // P
  }
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

// #93：PG 二进制参数解码。Bind 的 parameter format code=1 时按参数类型（OID）解码，
// 不能按 UTF-8 文本读。常见 OID：int4=23, int8=20, float8=701, float4=700, bool=16。
function decodeBinaryParam(buf, typeOid) {
  if (typeOid === 23) return buf.length >= 4 ? buf.readInt32BE(0) : null;          // int4
  if (typeOid === 20) return buf.length >= 8 ? buf.readBigInt64BE(0) : null;       // int8
  if (typeOid === 701) return buf.length >= 8 ? buf.readDoubleBE(0) : null;        // float8
  if (typeOid === 700) return buf.length >= 4 ? buf.readFloatBE(0) : null;         // float4
  if (typeOid === 16) return buf.length >= 1 ? buf[0] !== 0 : null;                // bool
  return buf.toString('utf8');
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
    this._extendedBatch = false; // #381
    this._skipUntilSync = false; // #552：批次出错后丢弃消息直到 Sync
    this._copyIn = null;         // #370：COPY FROM STDIN 状态
    this.authenticated = false;
    this.user = null;
    this.database = null;
    // #375/#376：会话 GUC 表，启动包回填、SET 更新并广播 ParameterStatus
    this._guc = {
      application_name: '',
      search_path: 'public',
      client_encoding: 'UTF8',
      server_encoding: 'UTF8',
      DateStyle: 'ISO, MDY',
      integer_datetimes: 'on',
      standard_conforming_strings: 'on',
      timezone: 'UTC',
      bytea_output: 'hex'
    };
    this._scram = null;
    this._scramClientFirst = null;
    this._scramServerFirst = null;
    this._scramCred = null;
    this._prepared = new Map();   // name -> { sql, paramTypes }
    this._portal = new Map();     // name -> { values }
    this._listenChannels = new Set(); // #353：本连接订阅的频道
    this._inTransaction = false;
    this._txAborted = false;
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
    if (this._pid && this._secret) {
      this.server._backends.delete(this._pid + ':' + this._secret); // #379
    }
    if (this._listenChannels) { // #353
      for (const ch of this._listenChannels) {
        const set = this.server._channels.get(ch);
        if (set) { set.delete(this); if (set.size === 0) this.server._channels.delete(ch); }
      }
    }
  }

  _send(buf) {
    if (!this.socket.destroyed) this.socket.write(buf);
  }

  _onData(chunk) {
    const max = this.server.maxMessageSize;
    if (this.buffer.length + chunk.length > max * 2) {
      this.socket.destroy();
      return;
    }
    this.buffer = Buffer.concat([this.buffer, chunk]);
    if (!this._startupDone || this._waitingSslRestart) {
      // 首消息: 长度 + 协议号（SSLRequest 拒绝后客户端重发的 startup 也是无类型消息）
      if (this.buffer.length < 4) return;
      const len = this.buffer.readInt32BE(0);
      if (len < 8 || len > max) {
        this.socket.destroy();
        return;
      }
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
      if (len < 4 || len > max) {
        this._send(buildErrorResponse('08P01', 'invalid or oversized protocol message length'));
        this.socket.destroy();
        return;
      }
      if (this.buffer.length < 1 + len) break;
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
      this._pending = (this._pending || Promise.resolve()).then(async () => {
        try {
          // #552：批次内任一消息出错后，丢弃剩余消息直到 Sync，只允许一个 ErrorResponse
          if (this._skipUntilSync) {
            if (type === 0x53) { // 'S' Sync：结束丢弃状态并回 ReadyForQuery
              this._skipUntilSync = false;
              this._extendedBatch = false;
              this._send(buildReadyForQuery(this._rfqStatus()));
            }
            return;
          }
          if (type === 0x51) { // 'Q' simple query（async）
            await this._handleSimpleQuery(body.toString('utf8').replace(/\0$/, ''));
          } else {
            await this._handleMessage(type, body);
          }
        } catch (e) {
          this._send(buildErrorResponse(
            this._pgErrorCode(e),
            e && e.message ? e.message : String(e),
            'ERROR',
            { position: (e && e.position) ||
                (() => { const m = /at position (\d+)/.exec(String((e && e.message) || '')); return m ? Number(m[1]) : undefined; })(),
              detail: e && e.detail, hint: e && e.hint }));
          // #381：扩展协议错误不能在 Sync 之前发 ReadyForQuery，否则 Sync 再发一帧 → 双 Z
          if (!this._extendedBatch) this._send(buildReadyForQuery(this._rfqStatus()));
          else this._skipUntilSync = true; // #552：等待 Sync，期间所有消息丢弃
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
    // #379：CancelRequest 在新建连接上发送，载荷 pid+secret 必须匹配活动后端
    if (version === 80877102) {
      if (body.length >= 16) {
        const pid = body.readInt32BE(8);
        const secret = body.readInt32BE(12);
        const target = this.server._backends.get(pid + ':' + secret);
        if (target) target._cancelRequested = true; // 只给匹配后端打取消标记
      }
      this.socket.end(); // 取消连接本身不回任何帧
      return;
    }
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
      const nameEnd = body.indexOf(0, pos);
      if (nameEnd < 0) break;
      const name = body.toString('utf8', pos, nameEnd);
      pos = nameEnd + 1;
      if (name === '') break;
      const valEnd = body.indexOf(0, pos);
      if (valEnd < 0) break;
      params[name] = body.toString('utf8', pos, valEnd);
      pos = valEnd + 1;
    }
    this.user = params.user || 'postgres';
    this.database = params.database || this.user;
    // #376：保留启动包携带的会话参数，认证后随 ParameterStatus 回填
    for (const k of ['application_name', 'search_path', 'client_encoding', 'DateStyle', 'timezone', 'standard_conforming_strings']) {
      if (params[k] !== undefined) this._guc[k] = params[k];
    }
    this._pid = 10000 + (this.server._connSeq++ % 8000);
    this._secret = Math.floor(Math.random() * 0x7fffffff);
    this._startAuth();
  }

  _startAuth() {
    const password = this.server._userPassword(this.user);
    if (password === undefined) {
      // 用户不存在
      this._send(buildErrorResponse('28P01', `password authentication failed for user "${this.user}"`));
      this.socket.end();
      return;
    }
    if (password === null || password === '') {
      // 无密码 → trust
      this._completeAuth();
      return;
    }
    // #336：默认 SCRAM，文档承诺的明文/MD5 通过 authMethod 显式启用
    const entry = this.server.auth && this.server.auth[this.user];
    const method = String((entry && typeof entry === 'object' && entry.authMethod)
      || this.server.options.authMethod || 'scram').toLowerCase();
    if (method === 'cleartext' || method === 'password') {
      this._authMethod = 'cleartext';
      const p = new PgBuffer(); p.i32(AUTH_CLEARTEXT);
      this._send(frame(0x52, p.build())); // 'R' AuthenticationCleartextPassword
      return;
    }
    if (method === 'md5') {
      this._authMethod = 'md5';
      this._md5Salt = crypto.randomBytes(4);
      const p = new PgBuffer(); p.i32(AUTH_MD5); p.raw(this._md5Salt);
      this._send(frame(0x52, p.build())); // 'R' AuthenticationMD5Password + salt
      return;
    }
    this._authMethod = 'scram';
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
    const expected = this.server._userPassword(this.user);
    if (this._authMethod === 'cleartext') {
      const received = body.toString('utf8').replace(/\0+$/, '');
      if (received === expected) this._completeAuth();
      else { this._send(buildErrorResponse('28P01', 'password authentication failed for user "' + this.user + '"')); this.socket.end(); }
      return;
    }
    if (this._authMethod === 'md5') {
      const inner = crypto.createHash('md5').update(Buffer.concat([Buffer.from(String(expected)), this._md5Salt])).digest('hex');
      const want = 'md5' + crypto.createHash('md5').update(inner + this._md5Salt.toString('hex'), 'utf8').digest('hex');
      if (body.toString('utf8').replace(/\0+$/, '') === want) this._completeAuth();
      else { this._send(buildErrorResponse('28P01', 'password authentication failed for user "' + this.user + '"')); this.socket.end(); }
      return;
    }
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
      this._send(buildErrorResponse('28P01', 'password authentication failed for user "' + this.user + '"'));
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
    this._send(buildParameterStatus('server_encoding', this._guc.server_encoding));
    this._send(buildParameterStatus('client_encoding', this._guc.client_encoding));
    this._send(buildParameterStatus('DateStyle', this._guc.DateStyle));
    this._send(buildParameterStatus('integer_datetimes', this._guc.integer_datetimes));
    this._send(buildParameterStatus('standard_conforming_strings', this._guc.standard_conforming_strings));
    // #376：启动包提交的会话参数（含空 application_name）认证后回填
    this._send(buildParameterStatus('application_name', this._guc.application_name || ''));
    this._send(buildParameterStatus('search_path', this._guc.search_path || 'public'));
    this._send(buildBackendKeyData(this._pid, this._secret));
    // #379：下发 BackendKeyData 时登记 pid/secret → 连接，供 CancelRequest 校验
    this.server._backends.set(this._pid + ':' + this._secret, this);
    this._send(buildReadyForQuery('I'));
  }

  _getEngine() {
    return this.server._getEngine(this.database);
  }

  async _handleMessage(type, body) {
    switch (type) {
      case 0x50: { // 'P' parse
        this._extendedBatch = true;
        const parts = this._splitCStrings(body);
        const name = parts[0], sql = parts[1];
        const nParams = body.readInt16BE(this._cstringLen(body, 0) + this._cstringLen(body, this._cstringLen(body, 0)));
        const paramTypes = [];
        let off = this._cstringLen(body, 0) + this._cstringLen(body, this._cstringLen(body, 0)) + 2;
        for (let i = 0; i < nParams; i++) { paramTypes.push(body.readInt32BE(off)); off += 4; }
        // #378：Parse 阶段做语法校验，非法 SQL 回 ErrorResponse 且不写入 _prepared
        if (!isPgSpecialCommand(sql)) {
          try {
            this.server._parseForDescribe(sql, this.database);
          } catch (e) {
            const m = String((e && e.message) || '');
            const pm = /at position (\d+)/.exec(m);
            this._send(buildErrorResponse(this._pgErrorCode(e), m, 'ERROR', { position: pm ? Number(pm[1]) : undefined }));
            return;
          }
        }
        this._prepared.set(name, { sql, paramTypes });
        this._send(buildParseComplete());
        break;
      }
      case 0x42: { // 'B' bind
        this._extendedBatch = true;
        const n0 = this._cstringLen(body, 0);
        const portal = body.toString('utf8', 0, n0 - 1);
        const stmtName = body.toString('utf8', n0, n0 + this._cstringLen(body, n0) - 1);
        const stmt = this._prepared.get(stmtName);
        if (!stmt) throw new Error(`prepared statement "${stmtName}" does not exist`);
        let off = n0 + this._cstringLen(body, n0);
        const nFormats = body.readInt16BE(off); off += 2;
        if (nFormats < 0) throw new Error('invalid Bind format count');
        const formats = [];
        for (let i = 0; i < nFormats; i++) { formats.push(body.readInt16BE(off)); off += 2; }
        const nValues = body.readInt16BE(off); off += 2;
        if (nValues < 0) throw new Error('invalid Bind parameter count');
        const values = [];
        for (let i = 0; i < nValues; i++) {
          const vlen = body.readInt32BE(off); off += 4;
          if (vlen === -1) { values.push(null); continue; }
          if (vlen < 0 || off + vlen > body.length) throw new Error('invalid Bind parameter length');
          const fmt = formats.length > 0 ? formats[Math.min(i, formats.length - 1)] : 0;
          // #93：fmt=1（binary）时按参数类型解码，此前一律按 UTF-8 文本读导致二进制参数错乱。
          const pt = (stmt.paramTypes && stmt.paramTypes[i]) || 0;
          const raw = body.slice(off, off + vlen);
          values.push(fmt === 1 ? decodeBinaryParam(raw, pt) : body.toString('utf8', off, off + vlen));
          off += vlen;
        }
        // #276：Bind 参数个数必须与 SQL 里的 $n 占位符数量一致
        const maxParam = (String(stmt.sql).match(/\$(\d+)/g) || [])
          .reduce((mx, tok) => Math.max(mx, Number(tok.slice(1)) || 0), 0);
        if (nValues !== maxParam) {
          const err = new Error(`bind message supplies ${nValues} parameters, but prepared statement requires ${maxParam}`);
          err.sqlState = '08P01';
          throw err;
        }
        // #277：Bind 末尾还有结果格式码列表（0=text，1=binary）
        const resultFormats = [];
        if (off + 2 <= body.length) {
          const nResultFormats = body.readInt16BE(off); off += 2;
          for (let i = 0; i < nResultFormats && off + 2 <= body.length; i++) {
            resultFormats.push(body.readInt16BE(off)); off += 2;
          }
        }
        this._portal.set(portal, { values, stmt, resultFormats });
        this._send(buildBindComplete());        break;
      }
      case 0x44: // 'D' describe
        this._extendedBatch = true;
        this._handleDescribe(body);
        break;
      case 0x45: { // 'E' execute
        this._extendedBatch = true;
        const portalName = body.toString('utf8', 0, this._cstringLen(body, 0) - 1);
        const portal = this._portal.get(portalName);
        if (!portal) throw new Error(`portal "${portalName}" does not exist`);
        return this._execute(portal);
      }
      case 0x43: // 'C' close
        this._extendedBatch = true;
        this._handleClose(body);
        break;
      case 0x53: // 'S' sync
        this._extendedBatch = false;
        this._send(buildReadyForQuery(this._rfqStatus()));
        break;
      case 0x64: // 'd' CopyData（#370）
        if (this._copyIn) this._copyIn.chunks.push(Buffer.from(body));
        break;
      case 0x63: // 'c' CopyDone（#370）
        if (this._copyIn) await this._finishCopyIn(false);
        break;
      case 0x66: // 'f' CopyFail（#370）
        if (this._copyIn) await this._finishCopyIn(true);
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
    // #254：名称解析 off-by-one。
    // _cstringLen(body, 1) 返回「从 start=1 起到 NUL 的长度（含 NUL）」，
    // 而 toString 的 end 是相对 buffer 起点的**绝对**位置。
    // 此前写成 _cstringLen(body,1)-1 → 少 1 字节 → 's1' 被读成 's'、
    // 单字符名 's' 被读成空串，导致「预编译语句不存在」。
    const name = body.toString('utf8', 1, this._cstringLen(body, 1));
    if (kind === 0x53) { // 'S' statement
      const stmt = this._prepared.get(name);
      if (!stmt) throw new Error(`prepared statement "${name}" does not exist`);
      // #309：无参语句 ParameterDescription 应为 paramCount=0
      this._send(buildParameterDesc(stmt.paramTypes || []));
      const cols = this._describeCols(stmt.sql);
      // #352：_describeCols 返回 { columns, types } 对象，此前误判 cols.length 恒为 undefined，
      // 导致 SELECT 的 Describe statement 一律回 NoData，从不发 RowDescription。
      if (cols && cols.columns && cols.columns.length > 0) {
        this._send(buildRowDescription(cols.columns, cols.types));
      } else {
        this._send(buildNoData());
      }
    } else if (kind === 0x50) { // 'P' portal
      const portal = this._portal.get(name);
      if (!portal) throw new Error(`portal "${name}" does not exist`);
      const cols = this._describeCols(portal.stmt.sql);
      if (cols && cols.columns && cols.columns.length > 0) {
        const fmts = this._columnFormats(cols.columns.length, portal.resultFormats);
        this._send(buildRowDescription(cols.columns, cols.types, fmts));
      } else {
        this._send(buildNoData());
      }
    }
  }

  _handleClose(body) {
    const kind = body[0];
    // #254：与 _handleDescribe 同样的 off-by-one（名称少读 1 字节）
    const name = body.toString('utf8', 1, this._cstringLen(body, 1));
    if (kind === 0x53) { // 'S' 关闭预处理语句：级联关闭绑定到它的 portal（#493）
      const stmt = this._prepared.get(name);
      this._prepared.delete(name);
      if (stmt) {
        for (const [portalName, portal] of this._portal) {
          if (portal.stmt === stmt) this._portal.delete(portalName);
        }
      }
    } else if (kind === 0x50) this._portal.delete(name);
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
          for (const [name, def] of Object.entries(schema)) push(name, pgSchemaType(def));
        } else if (c.expr) {
          const nm = String(c.expr).includes('.') ? String(c.expr).slice(String(c.expr).lastIndexOf('.') + 1) : c.expr;
          push(nm, schema[nm] ? pgSchemaType(schema[nm]) : 'string');
        }
      }
      return { columns, types };
    } catch (e) {
      return null;
    }
  }

  _astType(node, schema) {
    if (!node) return 'string';
    if (node.type === 'column') return schema[node.name] ? pgSchemaType(schema[node.name]) : 'string';
    if (node.type === 'cast') return String(node.to).includes('int') ? 'integer' : 'string';
    if (node.type === 'func') {
      const n = String(node.name).toUpperCase();
      if (n === 'COUNT' || n === 'SUM' || n === 'AVG' || n === 'MIN' || n === 'MAX') return 'number';
      return 'string';
    }
    if (node.type === 'value') return typeof node.value === 'number' ? 'number' : 'string';
    return 'string';
  }

  // #370：服务器端 COPY TO STDOUT，发 H + d* + c + CommandComplete
  async _handleCopyOut(table) {
    const engine = await this._getEngine();
    const res = await executeSQL(engine, `SELECT * FROM ${table}`, {
      dialect: 'pg', safety: false, session: { currentDb: this.database, connectionId: this._pid }
    });
    const r = (Array.isArray(res) ? res : [res])[0] || {};
    const cols = r.columns || [];
    this._send(buildCopyOutResponse(cols.length));
    for (const row of r.rows || []) {
      const line = row.map((v) => v === null || v === undefined ? '\\N'
        : String(v).replace(/\\/g, '\\\\').replace(/\t/g, '\\t').replace(/\n/g, '\\n').replace(/\r/g, '\\r')).join('\t') + '\n';
      this._send(buildCopyData(Buffer.from(line, 'utf8')));
    }
    this._send(buildCopyDone());
    this._send(buildCommandComplete(`COPY ${(r.rows || []).length}`));
  }

  // #370：COPY FROM STDIN 进入 Copy 状态，先回 G，等 CopyData/CopyDone
  _startCopyIn(table) {
    this._copyIn = { table, chunks: [] };
    const schema = this.server._tableSchema(this.database, String(table).replace(/"/g, ''));
    this._send(buildCopyInResponse(schema ? Object.keys(schema).length : 0));
  }

  async _finishCopyIn(failed) {
    const copy = this._copyIn;
    if (!copy) return;
    this._copyIn = null;
    if (failed) {
      this._send(buildErrorResponse('57014', 'COPY FROM STDIN failed'));
      this._send(buildReadyForQuery(this._rfqStatus()));
      return;
    }
    const text = Buffer.concat(copy.chunks).toString('utf8');
    const lines = text.split('\n').filter((l) => l.length > 0 && l !== '\\.');
    const engine = await this._getEngine();
    let inserted = 0;
    for (const line of lines) {
      const cells = line.split('\t').map((v) => v === '\\N' ? null
        : v.replace(/\\([\\tnr])/g, (m, c) => ({ '\\': '\\', t: '\t', n: '\n', r: '\r' })[c]));
      const literals = cells.map((v) => v === null ? 'NULL' : "'" + String(v).replace(/'/g, "''") + "'").join(', ');
      await executeSQL(engine, `INSERT INTO ${copy.table} VALUES (${literals})`, {
        dialect: 'pg', safety: false, session: { currentDb: this.database, connectionId: this._pid }
      });
      inserted++;
    }
    this._send(buildCommandComplete(`COPY ${inserted}`));
    this._send(buildReadyForQuery(this._rfqStatus()));
  }

  _unlisten(ch) {
    this._listenChannels.delete(ch);
    const set = this.server._channels.get(ch);
    if (set) { set.delete(this); if (set.size === 0) this.server._channels.delete(ch); }
  }

  // #353：LISTEN / UNLISTEN / NOTIFY 由服务端维护订阅表并广播 A 帧
  async _tryNotifyCommand(sql) {
    const s = String(sql || '').trim();
    let m = /^LISTEN\s+([A-Za-z_][\w$]*)\s*;?$/i.exec(s);
    if (m) {
      const ch = m[1];
      this._listenChannels.add(ch);
      let set = this.server._channels.get(ch);
      if (!set) { set = new Set(); this.server._channels.set(ch, set); }
      set.add(this);
      this._send(buildCommandComplete('LISTEN'));
      return true;
    }
    m = /^UNLISTEN\s+(\*|[A-Za-z_][\w$]*)\s*;?$/i.exec(s);
    if (m) {
      if (m[1] === '*') { for (const ch of Array.from(this._listenChannels)) this._unlisten(ch); }
      else this._unlisten(m[1]);
      this._send(buildCommandComplete('UNLISTEN'));
      return true;
    }
    m = /^NOTIFY\s+([A-Za-z_][\w$]*)(?:\s*,\s*(.+?))?\s*;?$/i.exec(s);
    if (m) {
      const ch = m[1];
      let payload = '';
      if (m[2]) {
        payload = m[2].trim().replace(/;\s*$/, '');
        if ((payload[0] === "'" && payload.endsWith("'")) || (payload[0] === '"' && payload.endsWith('"'))) {
          payload = payload.slice(1, -1).replace(/''/g, "'");
        }
      }
      const set = this.server._channels.get(ch);
      if (set) for (const conn of set) conn._send(buildNotification(this._pid, ch, payload));
      this._send(buildCommandComplete('NOTIFY'));
      return true;
    }
    return false;
  }

  async _handleSimpleQuery(sql) {
    const trimmed = sql.trim();
    // #387：只含空白/分号/注释的查询串不包含任何 SQL 语句，按协议必须回 EmptyQueryResponse。
    const effective = trimmed
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/--[^\r\n]*/g, '')
      .replace(/;/g, '')
      .trim();
    if (!effective) {
      this._send(buildEmptyQuery());
      this._send(buildReadyForQuery(this._rfqStatus()));
      return;
    }
    // aborted 事务里除 ROLLBACK/COMMIT 外一律拒绝（SET 也不能绕过）
    if (this._txAborted && !/^(ROLLBACK|COMMIT)\b/i.test(trimmed)) {
      this._send(buildErrorResponse('25P02', 'current transaction is aborted, commands ignored until end of transaction block'));
      this._send(buildReadyForQuery(this._rfqStatus()));
      return;
    }
    if (/^SET\b/i.test(trimmed)) {
      this._handleSet(trimmed);
      return;
    }
    // #370：COPY 子协议（解析层不识别 COPY，需在服务端拦截）
    const copyOut = /^COPY\s+(\S+)\s+TO\s+STDOUT\b/i.exec(trimmed);
    if (copyOut) {
      await this._handleCopyOut(copyOut[1].replace(/;/g, ''));
      this._send(buildReadyForQuery(this._rfqStatus()));
      return;
    }
    const copyIn = /^COPY\s+(\S+)\s+FROM\s+STDIN\b/i.exec(trimmed);
    if (copyIn) {
      this._startCopyIn(copyIn[1].replace(/;/g, ''));
      return; // ReadyForQuery 延后到 CopyDone/CopyFail
    }
    // #353：LISTEN/UNLISTEN/NOTIFY
    if (await this._tryNotifyCommand(trimmed)) {
      this._send(buildReadyForQuery(this._rfqStatus()));
      return;
    }
    // #380：多语句简单查询包在隐式事务中，任一句失败整批回滚；显式事务保持原路径
    const statements = pgSplitStatements(sql);
    const hasExplicitTxn = statements.some((s) => /^(BEGIN|START\s+TRANSACTION|COMMIT|END|ROLLBACK|ABORT|SAVEPOINT|RELEASE)\b/i.test(s));
    if (statements.length > 1 && !hasExplicitTxn && !this._inTransaction) {
      const engine = await this._getEngine();
      if (engine && typeof engine.beginTx === 'function' && typeof engine.rollbackTx === 'function') {
        const tx = await engine.beginTx();
        try {
          await this._executeSql(sql, null, null);
          await engine.commitTx(tx);
        } catch (e) {
          await engine.rollbackTx(tx);
          throw e;
        }
        this._send(buildReadyForQuery(this._rfqStatus()));
        return;
      }
    }
    try {
      await this._executeSql(sql, null, null);
    } catch (e) {
      if (this._inTransaction) this._txAborted = true;
      this._send(buildErrorResponse(
        this._pgErrorCode(e),
        e && e.message ? e.message : String(e),
        'ERROR',
        { position: (e && e.position) ||
            (() => { const m = /at position (\d+)/.exec(String((e && e.message) || '')); return m ? Number(m[1]) : undefined; })(),
          detail: e && e.detail, hint: e && e.hint }));
      this._send(buildReadyForQuery(this._rfqStatus()));
      return;
    }
    this._send(buildReadyForQuery(this._rfqStatus()));
  }

  // #375：SET 解析会话 GUC，更新会话表并广播 ParameterStatus；未识别参数回 42704。
  _handleSet(sql) {
    const m = /^SET\s+(?:SESSION\s+|LOCAL\s+)?([A-Za-z_][A-Za-z0-9_.]*)\s*(?:TO|=)\s*(.+?)\s*;?$/i.exec(sql);
    if (!m) {
      this._send(buildErrorResponse('42601', 'syntax error in SET command'));
      this._send(buildReadyForQuery(this._rfqStatus()));
      return;
    }
    const name = m[1].toLowerCase();
    const rawValue = m[2].trim();
    let value;
    if (/^DEFAULT$/i.test(rawValue)) {
      value = this._defaultGuc(name);
    } else {
      const q = rawValue[0];
      if ((q === "'" || q === '"') && rawValue.length >= 2 && rawValue.endsWith(q)) {
        value = rawValue.slice(1, -1).replace(/''/g, "'");
      } else {
        value = rawValue;
      }
    }
    const known = ['application_name', 'search_path', 'client_encoding', 'server_encoding', 'DateStyle',
      'timezone', 'bytea_output', 'standard_conforming_strings', 'default_transaction_read_only', 'integer_datetimes'];
    if (!known.includes(name)) {
      this._send(buildErrorResponse('42704', `unrecognized configuration parameter "${m[1]}"`));
      this._send(buildReadyForQuery(this._rfqStatus()));
      return;
    }
    this._guc[name] = value;
    this._send(buildParameterStatus(name, value));
    this._send(buildCommandComplete('SET'));
    this._send(buildReadyForQuery(this._rfqStatus()));
  }

  _defaultGuc(name) {
    const defaults = {
      application_name: '', search_path: 'public', client_encoding: 'UTF8', server_encoding: 'UTF8',
      DateStyle: 'ISO, MDY', timezone: 'UTC', bytea_output: 'hex', standard_conforming_strings: 'on',
      default_transaction_read_only: 'off', integer_datetimes: 'on'
    };
    return Object.prototype.hasOwnProperty.call(defaults, name) ? defaults[name] : '';
  }

  async _execute(portal) {
    if (this._txAborted) {
      this._send(buildErrorResponse('25P02', 'current transaction is aborted, commands ignored until end of transaction block'));
      return;
    }
    try {
      const { sql } = portal.stmt;
      // #353/#370：扩展协议下同样支持通知命令与 COPY TO STDOUT
      if (await this._tryNotifyCommand(sql)) return;
      const cm = /^COPY\s+(\S+)\s+TO\s+STDOUT\b/i.exec(String(sql).trim());
      if (cm) { await this._handleCopyOut(cm[1].replace(/;/g, '')); return; }
      await this._executeSql(sql, portal.values || [], portal.resultFormats);
    } catch (e) {
      if (this._inTransaction) this._txAborted = true;
      this._send(buildErrorResponse(this._pgErrorCode(e), e && e.message ? e.message : String(e)));
    }
  }

  async _executeSql(sql, values, resultFormats) {
    // #379：被 CancelRequest 标记的后端在（下一个/在途）语句入口回 57014
    if (this._cancelRequested) {
      this._cancelRequested = false;
      const err = new Error('canceling statement due to user request');
      err.sqlState = '57014';
      throw err;
    }
    const engine = await this._getEngine();
    const ctx = {
      session: { currentDb: this.database, connectionId: this._pid },
      params: values || []
    };
    let results;
    if (values && values.length > 0) {
      // 交给 executeSQL/applyParams 处理 $n：会跳过字符串字面量和注释，
      // 不会再像正则那样把 '$1' 替换进 SQL 文本里。
      results = await executeSQL(engine, sql, values, { dialect: 'pg', safety: false, session: ctx.session });
    } else {
      results = await executeSQL(engine, sql, { dialect: 'pg', safety: false, session: ctx.session });
    }
    const list = Array.isArray(results) ? results : [results];
    for (const res of list) {
      this._emitResult(res, resultFormats);
    }
  }

  _columnFormats(count, resultFormats) {
    if (!resultFormats || resultFormats.length === 0) return null;
    const out = new Array(count).fill(0);
    for (let i = 0; i < count; i++) out[i] = resultFormats.length === 1 ? resultFormats[0] : (resultFormats[i] || 0);
    return out;
  }

  _emitResult(res, resultFormats) {
    if (!res) return;
    if (res.type === 'select') {
      const types = this._resultTypes(res);
      const fmts = this._columnFormats((res.columns || []).length, resultFormats);
      if (res.columns && res.columns.length > 0) {
        this._send(buildRowDescription(res.columns, types, fmts));
      }
      for (const row of res.rows || []) {
        this._send(buildDataRow(row, types, fmts));
      }
      const tag = `SELECT ${(res.rows || []).length}`;
      this._send(buildCommandComplete(tag));
    } else if (res.type === 'insert' || res.type === 'update' || res.type === 'delete') {
      // PG CommandComplete tag：INSERT 是 "INSERT <oid> <count>"，UPDATE/DELETE 是
      // "UPDATE <count>" / "DELETE <count>"（#33）。缺了 OID 段会让客户端把 count
      // 解析到 OID 槽位、rowCount 变 NaN。
      const count = res.affectedRows != null ? res.affectedRows : 0;
      const tag = res.type === 'insert' ? `INSERT 0 ${count}` : `${String(res.type).toUpperCase()} ${count}`;
      this._send(buildCommandComplete(tag));
    } else if (res.type === 'begin' || res.type === 'commit' || res.type === 'rollback') {
      this._inTransaction = res.type === 'begin';
      this._txAborted = false;
      // #551：portal 生命周期止于事务结束，COMMIT/ROLLBACK 后不可再 Execute
      if (res.type !== 'begin') this._portal.clear();
      this._send(buildCommandComplete(String(res.type).toUpperCase()));
    } else if (res.type === 'createTable' || res.type === 'dropTable' || res.type === 'createDatabase' || res.type === 'dropDatabase'
      || res.type === 'alterTable' || res.type === 'createIndex' || res.type === 'dropIndex' || res.type === 'truncate') {
      // #308/#553：DDL CommandComplete tag 用真实语句类型，恒 OK 会让客户端误判命令
      const tags = {
        createTable: 'CREATE TABLE', dropTable: 'DROP TABLE', createDatabase: 'CREATE DATABASE', dropDatabase: 'DROP DATABASE',
        alterTable: 'ALTER TABLE', createIndex: 'CREATE INDEX', dropIndex: 'DROP INDEX',
        truncate: 'TRUNCATE TABLE 1'   // PG 的 tag 数字为被截断的表数
      };
      this._send(buildCommandComplete(tags[res.type] || 'OK'));
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
        for (const [name, def] of Object.entries(schema)) t[name] = pgSchemaType(def);
      }
    } catch (e) {}
    return (res.columns || []).map(c => t[c] || 'string');
  }

  _rfqStatus() {
    // #213：aborted 事务态 'E'
    return this._txAborted ? 'E' : (this._inTransaction ? 'T' : 'I');
  }

  _pgErrorCode(e) {
    if (!e) return 'XX000';
    if (e.sqlState) return e.sqlState;
    if (/current transaction is aborted/i.test(String(e.message || ''))) return '25P02';
    const codeKey = e.code;
    const m = String(e.message || '');
    // Map JSQL error keys to PG SQLSTATE codes
    if (codeKey === 'ER_NO_SUCH_TABLE' || /Table .* doesn't exist/i.test(m)) return '42P01';
    if (codeKey === 'ER_TABLE_EXISTS' || /already exists/i.test(m)) return '42P07';
    if (codeKey === 'ER_DUP_ENTRY' || m.includes('ER_DUP_ENTRY') || /Duplicate entry/i.test(m)) return '23505';
    // #465：引擎对缺列抛 "no such column: x"（非 MySQL "Unknown column"），同样归 undefined_column
    if (codeKey === 'ER_BAD_FIELD_ERROR' || /Unknown column|no such column/i.test(m)) return '42703';
    if (codeKey === 'ER_CANT_DROP_FIELD' || /Cannot drop column/i.test(m)) return '428NF';
    if (codeKey === 'ER_DUP_FIELDNAME' || /Duplicate column name/i.test(m)) return '42711';
    if (codeKey === 'ER_BAD_NULL_ERROR' || /cannot be null/i.test(m)) return '23502';
    if (codeKey === 'ER_CHECK_CONSTRAINT' || /Check constraint/i.test(m)) return '23514';
    if (codeKey === 'ER_DATA_TOO_LONG' || /Data too long/i.test(m)) return '22001';
    if (codeKey === 'ER_OUT_OF_RANGE' || /Out of range/i.test(m)) return '22003';
    if (codeKey === 'ER_NO_REFERENCED_ROW' || /foreign key/i.test(m)) return '23503';
    // #556：调用不存在的函数为 42883 undefined_function（独立于缺列/语法）
    if (/FUNCTION\s+.*\s+does not exist/i.test(m)) return '42883';
    // #551/#493：portal 不存在 → 34000 invalid_portal_name / invalid_cursor_name
    if (/portal\s+".*"\s+does not exist/i.test(m)) return '34000';
    if (codeKey === 'ER_SYNTAX_ERROR' || /syntax|Unexpected token|Expected/i.test(m)) return '42601';
    // #465：日期/时间值越界 → 22008；格式无法解析 → 22007（ER_INVALID_DATE 码 1292）
    if (/date\/time field value out of range|time value out of range/i.test(m)) return '22008';
    if (codeKey === 1292 && /date|time|datetime|timestamp/i.test(m)) return '22007';
    if (/Incorrect date|Invalid date|invalid datetime|invalid date format/i.test(m)) return '22007';
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
    this.port = options.port ?? 5432;
    this.host = options.host || '127.0.0.1';
    this.auth = options.auth || null;           // { user: { password, databases: [...] } }
    this.noAuth = options.noAuth === true;
    this.dataDir = options.dataDir || null;
    this.maxMessageSize = options.maxMessageSize || 64 * 1024 * 1024;
    this.version = require('../package.json').version;
    this._server = null;
    this._sockets = new Set();
    this._connSeq = 0;
    this._backends = new Map();   // #379：`pid:secret` → PgConnection
    this._channels = new Map();   // #353：channel → Set<PgConnection>
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
    // 未配置 auth 时与 MySQL 行为保持一致：不做库级限制
    if (!this.auth) return true;
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
    this._server.on('error', (err) => {
      if (this.options.onError) this.options.onError(err);
      else if (cb) cb(err);
      else console.error('[jsql-neo] pg server error:', err.message);
    });
    this._server.listen(this.port, this.host, cb ? () => cb() : undefined);
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

// README 的 createXxxServer 工厂系列里，PG 这个之前漏了实现：
// index.js 一直从本模块解构 createPgServer，实际拿到 undefined。
function createPgServer(options) {
  return new PgServer(options || {});
}

module.exports = { PgServer, createPgServer, PgConnection, buildRowDescription, buildDataRow, buildCommandComplete, buildErrorResponse, buildReadyForQuery, buildParameterStatus, buildBackendKeyData, buildParseComplete, buildBindComplete, buildCloseComplete, buildNoData, buildParameterDesc, decodeBinaryParam, TYPE_OIDS, pgTypeOid, pgFormatValue };
