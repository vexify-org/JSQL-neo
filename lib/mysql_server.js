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

/**
 * 词法扫描 SQL，将字符串字面量和注释中的字符替换为空格（保持长度不变）。
 * 这样在替换时可以通过检查对应位置是否为空格来判断是否在字符串/注释中。
 */
function _maskStringsAndComments(sql) {
  const chars = sql.split('');
  let i = 0;
  while (i < chars.length) {
    const c = chars[i];
    // 单引号字符串
    if (c === "'") {
      i++;
      while (i < chars.length && chars[i] !== "'") {
        if (chars[i] === '\\' && i + 1 < chars.length) {
          chars[i] = ' ';
          chars[i + 1] = ' ';
          i += 2;
        } else {
          chars[i] = ' ';
          i++;
        }
      }
      if (i < chars.length) i++; // skip closing quote
      continue;
    }
    // 双引号字符串
    if (c === '"') {
      i++;
      while (i < chars.length && chars[i] !== '"') {
        if (chars[i] === '\\' && i + 1 < chars.length) {
          chars[i] = ' ';
          chars[i + 1] = ' ';
          i += 2;
        } else {
          chars[i] = ' ';
          i++;
        }
      }
      if (i < chars.length) i++; // skip closing quote
      continue;
    }
    // 单行注释 --
    if (c === '-' && chars[i + 1] === '-') {
      while (i < chars.length && chars[i] !== '\n') {
        chars[i] = ' ';
        i++;
      }
      continue;
    }
    // 多行注释 /* */
    if (c === '/' && chars[i + 1] === '*') {
      chars[i] = ' ';
      chars[i + 1] = ' ';
      i += 2;
      while (i < chars.length && !(chars[i] === '*' && chars[i + 1] === '/')) {
        chars[i] = ' ';
        i++;
      }
      if (i < chars.length) {
        chars[i] = ' ';
        chars[i + 1] = ' ';
        i += 2;
      }
      continue;
    }
    i++;
  }
  return chars.join('');
}

const SERVER_VERSION = '8.0.0-jsql-neo';
const CLIENT_PROTOCOL_41 = 0x00000001 << 9;
const CLIENT_SECURE_CONNECTION = 0x00008000;
const CLIENT_PLUGIN_AUTH = 0x00080000;
const CLIENT_CONNECT_WITH_DB = 0x00000008;
// CLIENT_LONG_PASSWORD 已废弃但保留协议兼容性（客户端可能发送此标志）
const CLIENT_LONG_PASSWORD = 0x00000001;
const CLIENT_TRANSACTIONS = 0x00002000;
const CLIENT_MULTI_STATEMENTS = 0x00010000;
const CLIENT_MULTI_RESULTS = 0x00020000;
const CLIENT_LONG_FLAG = 0x00000004;
const CLIENT_DEPRECATE_EOF = 0x01000000;
const CLIENT_SSL = 0x00000800; // #425
const UNIQUE_KEY_FLAG = 0x0004; // #490
const BLOB_FLAG = 0x0010; // #491
const SERVER_STATUS_AUTOCOMMIT = 0x0002;
const SERVER_STATUS_IN_TRANS = 0x0001; // #372
const SERVER_MORE_RESULTS_EXISTS = 0x0008;
const CHARSET_UTF8 = 0x2d;   // #212: 45 = utf8mb4_general_ci（33 是 utf8mb3/cesu8）
const CHARSET_LATIN1 = 0x08; // latin1_swedish_ci
const PARAM_UNSIGNED_FLAG = 0x0020; // COM_STMT_EXECUTE 参数块 flags 高字节无符号位

// 会话字符集名 → 列定义通告的 collation/charsetNr（#393）
function charsetNrByName(name) {
  const n = String(name || '').toLowerCase();
  if (n === 'latin1') return CHARSET_LATIN1;
  return CHARSET_UTF8;
}

const MYSQL_TYPE_TINY = 1, MYSQL_TYPE_SHORT = 2, MYSQL_TYPE_LONG = 3,
  MYSQL_TYPE_LONGLONG = 8, MYSQL_TYPE_INT24 = 9, MYSQL_TYPE_DATE = 10,
  MYSQL_TYPE_YEAR = 13, MYSQL_TYPE_NEWDATE = 14, MYSQL_TYPE_DATETIME = 12,
  MYSQL_TYPE_DOUBLE = 5, MYSQL_TYPE_STRING = 254, MYSQL_TYPE_VAR_STRING = 253,
  MYSQL_TYPE_BLOB = 252, MYSQL_TYPE_JSON = 245, MYSQL_TYPE_NULL = 6;

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
  // 0xfe: 8-byte int64
  if (first === 0xfe) {
    const low = buf.readUInt32LE(offset + 1);
    const high = buf.readUInt32LE(offset + 5);
    return { value: low + high * 4294967296, size: 9 };
  }
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

function eofPacket(status = SERVER_STATUS_AUTOCOMMIT) {
  const b = new PacketBuilder();
  b.byte(0xfe);
  b.int16(0);
  b.int16(status);
  return b.build();
}

function mysqlSqlState(errno) {
  return ({
    1048: '23000', 1050: '42S01', 1054: '42S22', 1062: '23000',
    1064: '42000', 1065: '42000', 1102: '42000', 1136: '21S01', 1146: '42S02',
    1264: '22003', 1406: '22001', 3819: 'HY000',
  })[errno] || 'HY000';
}

function errPacket(errno, message, sqlState) {
  if (!sqlState) sqlState = mysqlSqlState(errno);
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
  // 引擎异常可能只有 message 没有 ER_ 前缀，补常见回退映射（#274）
  const text = String((e && e.message) || '');
  if (!m) {
    if (/no such table|table .*(doesn't|does not) exist/i.test(text)) return 1146;
    if (/no such column|unknown column/i.test(text)) return 1054;
    if (/duplicate entry|unique constraint/i.test(text)) return 1062;
    if (/cannot be null|not null constraint/i.test(text)) return 1048;
    if (/syntax error|unexpected token|expected /i.test(text)) return 1064;
  }
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
  b.raw(encodeLenencString(column.database || ''));
  b.raw(encodeLenencString(column.table || ''));
  b.raw(encodeLenencString(column.table || ''));
  b.raw(encodeLenencString(column.name || ''));
  b.raw(encodeLenencString(column.name || ''));
  b.raw(encodeLenenc(0x0c));
  b.int16(column.charset || CHARSET_UTF8);
  b.int32(column.length || 1024);
  b.byte(column.type !== undefined ? column.type : MYSQL_TYPE_VAR_STRING);
  b.int16(column.flags || 0);
  b.byte(0);
  b.int16(0);
  return b.build();
}

function columnFlags(def) {
  if (!def) return 0;
  let flags = 0;
  if (def.required || def.primaryKey || def.primary_key || def.autoIncrement) flags |= 0x0001; // NOT_NULL
  if (def.primaryKey || def.primary_key) flags |= 0x0002; // PRI_KEY
  if (def.unique && !def.primaryKey && !def.primary_key) flags |= UNIQUE_KEY_FLAG; // #490 唯一键
  if (def.autoIncrement) flags |= 0x0200; // AUTO_INCREMENT
  if (def.unsigned) flags |= 0x0020; // UNSIGNED
  if (isBlobColumn(def)) flags |= BLOB_FLAG; // #491 TEXT/BLOB 列
  return flags;
}

// #491/#554：引擎把 TEXT/TINYINT/SMALLINT 折叠成 string/integer，
// 原始声明宽度保存在 rawType/intType 中，按它细分协议类型码。
function isBlobColumn(def) {
  const raw = def && def.rawType ? String(def.rawType).toLowerCase() : '';
  return raw === 'text' || raw === 'tinytext' || raw === 'mediumtext' || raw === 'longtext'
    || raw === 'blob' || raw === 'tinyblob' || raw === 'mediumblob' || raw === 'longblob'
    || (def && def.type === 'binary');
}

function columnTypeFromSchema(def) {
  const type = def && def.type ? String(def.type).toLowerCase() : 'string';
  const raw = def && def.rawType ? String(def.rawType).toLowerCase() : '';
  if (type === 'bigint' || (def && def.intType === 'bigint') || raw === 'bigint') return MYSQL_TYPE_LONGLONG;
  if (raw === 'tinyint') return MYSQL_TYPE_TINY; // #554
  if (raw === 'smallint') return MYSQL_TYPE_SHORT; // #554
  if (type === 'integer' || type === 'int') return MYSQL_TYPE_LONG;
  if (type === 'number' || type === 'float' || type === 'double' || type === 'real' || type === 'numeric' || type === 'decimal') return MYSQL_TYPE_DOUBLE;
  if (type === 'boolean' || type === 'bool') return MYSQL_TYPE_TINY;
  if (type === 'date') return MYSQL_TYPE_DATE;
  if (type === 'datetime' || type === 'timestamp') return MYSQL_TYPE_DATETIME;
  if (type === 'object' || type === 'array') return MYSQL_TYPE_JSON;
  if (isBlobColumn(def)) return MYSQL_TYPE_BLOB; // #491
  return MYSQL_TYPE_VAR_STRING;
}

function resultSetPacket(result, tableSchema, baseSeq, rawRow, status = SERVER_STATUS_AUTOCOMMIT, charsetNr = CHARSET_UTF8) {
  const packets = [];
  let sequence = baseSeq || 0;
  const push = (buf) => { // #408: 单个包超过 16MB 时切分为 0xffffff 的续传分片
    let off = 0;
    do {
      const part = buf.slice(off, off + 0xffffff);
      const header = Buffer.alloc(4);
      header.writeUIntLE(part.length, 0, 3);
      header[3] = sequence;
      sequence = (sequence + 1) & 0xff;
      packets.push(header);
      packets.push(part);
      off += part.length;
    } while (off < buf.length);
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
    if (name === null || name === undefined) name = 'col_' + ci;
    let sample;
    if (sampleRow !== null) {
      if (Array.isArray(sampleRow)) sample = sampleRow[ci];
      else sample = sampleRow[name];
    }
    const col = {
      name: String(name),
      table: result.table || '',
      database: result.database || '',
      type: inferType(name, sample),
      flags: columnFlags(tableSchema && tableSchema[name]),
      length: 1024,
      charset: charsetNr,
    };
    push(columnDefinition(col));
  }
  push(eofPacket(status));

  for (const row of result.rows || []) {
    if (!row) continue;
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
  push(eofPacket(status));
  return { packets, sequence };
}

// #373: 二进制结果行编码，EXECUTE(游标) 与 COM_STMT_FETCH 共用同一套布局
function pushBinaryRows(push, rows, cols, types, encodeValue, start, count) {
  const end = Math.min(start + count, rows.length);
  for (let i = start; i < end; i++) {
    const row = rows[i];
    const parts = [Buffer.from([0x00])];
    const nb = Buffer.alloc(Math.ceil((cols.length + 2) / 8));
    const encoded = [];
    for (let c = 0; c < cols.length; c++) {
      const v = Array.isArray(row) ? row[c] : row[cols[c]];
      if (v === null || v === undefined) {
        const bit = c + 2; // 二进制协议 NULL bitmap 前两位保留
        nb[Math.floor(bit / 8)] |= (1 << (bit % 8));
        encoded.push(null);
      } else {
        encoded.push(encodeValue(v, types[c]));
      }
    }
    parts.push(nb);
    for (const e of encoded) if (e !== null) parts.push(e);
    push(Buffer.concat(parts));
  }
  return end;
}

function binaryResultSetPacket(result, tableSchema, baseSeq, status = SERVER_STATUS_AUTOCOMMIT, charsetNr = CHARSET_UTF8, cursor = false) {
  const packets = [];
  let sequence = baseSeq || 0;
  const push = (buf) => { // #408: 单个包超过 16MB 时切分为 0xffffff 的续传分片
    let off = 0;
    do {
      const part = buf.slice(off, off + 0xffffff);
      const header = Buffer.alloc(4);
      header.writeUIntLE(part.length, 0, 3);
      header[3] = sequence;
      sequence = (sequence + 1) & 0xff;
      packets.push(header);
      packets.push(part);
      off += part.length;
    } while (off < buf.length);
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
    push(columnDefinition({ name: String(cols[ci]), table: result.table || '', database: result.database || '', type: t, flags: columnFlags(tableSchema && tableSchema[cols[ci]]), length: 1024, charset: charsetNr }));
  }
  push(eofPacket(status));

  const encodeValue = (v, type) => {
    if (v === null || v === undefined) return null;
    if (type === MYSQL_TYPE_LONG || type === MYSQL_TYPE_LONGLONG || type === MYSQL_TYPE_DOUBLE) {
      const num = Number(v);
      if (!Number.isFinite(num)) return encodeLenencString(String(v));
      if (type === MYSQL_TYPE_DOUBLE) {
        const b = Buffer.alloc(8); b.writeDoubleLE(num, 0); return b;
      }
      if (!Number.isFinite(num)) return encodeLenencString(String(v));
      if (type === MYSQL_TYPE_LONG) {
        // 4 字节 LONG：总是写 4 字节（#32）。超出 int32 范围时钳位，
        // 不能写 8 字节，否则二进制结果集的行布局被破坏（下一列错位）。
        let n = Math.trunc(num);
        if (n > 2147483647) n = 2147483647;
        if (n < -2147483648) n = -2147483648;
        const b = Buffer.alloc(4); b.writeInt32LE(n, 0); return b;
      }
      // MYSQL_TYPE_LONGLONG：始终写 8 字节，超出 int64 范围时钳位（保持行布局）。
      let bi = typeof v === 'bigint' ? v : BigInt(Math.trunc(num));
      const INT64_MAX = 9223372036854775807n;
      const INT64_MIN = -9223372036854775808n;
      if (bi > INT64_MAX) bi = INT64_MAX;
      if (bi < INT64_MIN) bi = INT64_MIN;
      const b = Buffer.alloc(8); b.writeBigInt64LE(bi, 0); return b;
    }
    if (type === MYSQL_TYPE_TINY) { // #554: TINYINT 可能被声明为 TINY，按数值而非布尔编码
      let n = typeof v === 'boolean' ? (v ? 1 : 0) : Math.trunc(Number(v));
      if (!Number.isFinite(n)) n = 0;
      if (n > 127) n = 127;
      if (n < -128) n = -128;
      const b = Buffer.alloc(1); b.writeInt8(n, 0); return b;
    }
    if (type === MYSQL_TYPE_SHORT) { // #554: SMALLINT 声明为 SHORT，按 2 字节整数编码
      let n = Math.trunc(Number(v));
      if (!Number.isFinite(n)) n = 0;
      if (n > 32767) n = 32767;
      if (n < -32768) n = -32768;
      const b = Buffer.alloc(2); b.writeInt16LE(n, 0); return b;
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

  if (cursor) {
    // #373: 游标 EXECUTE 只下发列元数据，数据行留给 COM_STMT_FETCH
    return { packets, sequence, cursorData: { result, cols, types, pos: 0, encodeValue } };
  }
  pushBinaryRows(push, result.rows || [], cols, types, encodeValue, 0, Infinity);
  push(eofPacket(status)); // #426 与文本路径/列定义 EOF 使用同一状态位
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
    this._fragParts = null; // #408 入站分片重组缓冲
    this._fragLen = 0;
    this._skipBytes = 0;
    this._skipFragments = false;
    this.authenticated = false;
    this.user = null;
    this.authFails = 0;
    this.multiStatements = false;
    // #372：BEGIN/COMMIT 后状态位从不置 IN_TRANS，客户端无法判断是否处于事务
    this._inTransaction = false;
    this._stmts = new Map();
    this._stmtSeq = 0;
    this.session = {
      lastInsertId: 0,
      rowCount: 0,
      foundRows: 0,
      connectionId: server._connectionCounter,
      currentDb: null,
      sysvars: {},
      charset: 'utf8mb4',
      charsetNr: CHARSET_UTF8,
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
    // #408: 出站超过 16MB 时按 0xffffff 分片，避免 3 字节长度字段被截断
    let off = 0;
    do {
      const part = payload.slice(off, off + 0xffffff);
      const header = Buffer.alloc(4);
      header.writeUIntLE(part.length, 0, 3);
      header[3] = this.sequence;
      this.sequence = (this.sequence + 1) & 0xff;
      this.socket.write(Buffer.concat([header, part]));
      off += part.length;
    } while (off < payload.length);
  }

  _onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    this._armIdleTimer();
    while (true) {
      if (this._skipBytes > 0) { // 丢弃超限包的剩余字节（可能跨多次 data 事件）
        const n = Math.min(this._skipBytes, this.buffer.length);
        this.buffer = this.buffer.slice(n);
        this._skipBytes -= n;
        if (this._skipBytes > 0) return;
        if (!this._skipFragments) continue;
      }
      if (this._skipFragments) { // 丢弃超限消息的后续续片，不再重复报错
        if (this.buffer.length < 4) return;
        const len = this.buffer.readUIntLE(0, 3);
        if (this.buffer.length < 4 + len) return;
        this.buffer = this.buffer.slice(4 + len);
        if (len < 0xffffff) this._skipFragments = false;
        continue;
      }
      if (this.buffer.length < 4) return;
      const len = this.buffer.readUIntLE(0, 3);
      const seq = this.buffer[3];
      const accumulated = this._fragLen + len;
      // #408: 超限先回 1153 ERR_Packet，不直接销毁连接；丢弃整条（含续片）消息
      if (len > this.server.maxPacketSize || accumulated > this.server.maxPacketSize) {
        this.sequence = (seq + 1) & 0xff;
        this._send(errPacket(1153, 'Got a packet bigger than \'max_allowed_packet\' bytes'));
        this._fragParts = null;
        this._fragLen = 0;
        this._skipFragments = (len === 0xffffff);
        this._skipBytes = len + 4;
        continue;
      }
      if (this.buffer.length < 4 + len) return;
      const payload = this.buffer.slice(4, 4 + len);
      this.buffer = this.buffer.slice(4 + len);
      if (len === 0xffffff) { // 续传分片，等后续包重组
        if (!this._fragParts) { this._fragParts = []; this._fragLen = 0; }
        this._fragParts.push(payload);
        this._fragLen += payload.length;
        continue;
      }
      const full = this._fragParts && this._fragParts.length
        ? Buffer.concat(this._fragParts.concat([payload])) : payload;
      this._fragParts = null;
      this._fragLen = 0;
      this._handlePacket(full, seq);
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
            // #272：非法库名回 ERR_Packet，不能直接销毁连接
            this._send(errPacket(1102, `Incorrect database name '${db}'`));
            break;
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
        case 0x0d: { // #392 COM_PROCESS_KILL：按 connection_id 终止会话
          if (body.length < 4) { this._send(errPacket(1105, 'malformed COM_PROCESS_KILL')); break; }
          const targetId = body.readUInt32LE(0);
          const target = this.server._connections.get(targetId);
          if (!target) { this._send(errPacket(1094, `Unknown thread id: ${targetId}`)); break; }
          if (this.server.auth && target.user !== this.user) {
            this._send(errPacket(1045, 'Access denied; you need the SUPER privilege for this operation'));
            break;
          }
          this._send(okPacket());
          if (target === this) target.socket.end(); // 先冲刷 OK 再关闭自身
          else target.socket.destroy();
          break;
        }
        case 0x1f: { // COM_RESET_CONNECTION —— #457：释放预处理句柄并复位会话状态
          this._stmts.clear();
          this._stmtSeq = 0;
          this._inTransaction = false;
          this.session.lastInsertId = 0;
          this.session.rowCount = 0;
          this.session.foundRows = 0;
          this.session.sysvars = {};
          this.session.charset = 'utf8mb4';
          this.session.charsetNr = CHARSET_UTF8;
          this._send(okPacket());
          break;
        }
        case 0x16: this._handleStmtPrepare(body); break; // COM_STMT_PREPARE
        case 0x17: this._handleStmtExecute(body); break; // COM_STMT_EXECUTE
        case 0x18: this._handleStmtSendLongData(body); break; // COM_STMT_SEND_LONG_DATA
        case 0x19: this._handleStmtClose(body); break; // COM_STMT_CLOSE
        case 0x1a: this._handleStmtReset(body); break; // COM_STMT_RESET
        case 0x1c: { // #373 COM_STMT_FETCH：从游标句柄批量取行
          if (body.length < 8) { this._send(errPacket(1105, 'malformed COM_STMT_FETCH')); break; }
          const stmtId = body.readUInt32LE(0);
          const numRows = body.readUInt32LE(4);
          const stmt = this._stmts.get(stmtId);
          if (!stmt) {
            this._send(errPacket(1243, 'Unknown prepared statement handler (' + stmtId + ') given to mysqld_stmt_fetch'));
            break;
          }
          const cur = stmt.cursor;
          if (!cur) { this._send(errPacket(1105, 'No cursor is open for this statement')); break; }
          const rows = Array.isArray(cur.result.rows) ? cur.result.rows : [];
          cur.pos = pushBinaryRows((buf) => this._send(buf), rows, cur.cols, cur.types, cur.encodeValue, cur.pos, numRows);
          this._send(eofPacket(SERVER_STATUS_AUTOCOMMIT | (this._inTransaction ? SERVER_STATUS_IN_TRANS : 0)));
          break;
        }
        case 0x0a: { // COM_PROCESS_INFO
          const seq = this.sequence;
          this.sequence = (this.sequence + 1) & 0xff;
          this._send(encodeLenenc(1));
          this._send(columnDefinition({ name: 'Id', type: MYSQL_TYPE_LONG }));
          this._send(eofPacket());
          // #95：结果行字段必须是 length-encoded string。
          // 此前直接发裸字节 0x31（'1'），客户端把它当字段长度读后续 49 字节 → 协议失步。
          this._send(encodeLenencString('1'));
          this._send(eofPacket());
          break;
        }
        case 0x09: { // COM_STATISTICS —— 回统计字符串包，非 OK 包
          const stats = 'Uptime: ' + Math.floor(process.uptime()) +
            '  Threads: ' + this.server._sockets.size +
            '  Questions: ' + this.session.foundRows +
            '  Slow queries: 0  Opens: 0  Flush tables: 1  Open tables: 0  Queries per second avg: 0.000';
          this._send(Buffer.from(stats, 'utf8'));
          break;
        }
        case 0x04: { // #307 COM_FIELD_LIST
          (async () => {
            try {
              const table = body.toString('utf8').split('\0')[0];
              const eng = await this.server._getDatabase(this.currentDb);
              const schema = await eng.getTableSchema(table);
              if (!schema) { this._send(errPacket(1146, `Table '${this.currentDb}.${table}' doesn't exist`)); return; }
              for (const [n, d] of Object.entries(schema)) {
                this._send(columnDefinition({ name: n, table, database: this.currentDb, type: columnTypeFromSchema(d), flags: columnFlags(d) }));
              }
              this._send(eofPacket());
            } catch (e) {
              this._send(errPacket(toMysqlErrno(e), e.message));
            }
          })();
          break;
        }
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
      if (payload.length < 32) throw new Error('malformed handshake response');
      const caps = payload.readUInt32LE(0);
      // #425：SSLRequest 是仅含 32 字节固定头、无用户名/认证响应的包，
      // 不能按登录包解析。服务端未启用 TLS，回 ERR 并结束握手。
      if ((caps & CLIENT_SSL) && payload.length <= 32) {
        this.server._onSecurityEvent({ type: 'ssl-unsupported', remote: this.socket.remoteAddress });
        this._send(errPacket(1043, 'SSL is not supported by this server'));
        this.socket.end();
        return;
      }
      let pos = 32; // 4 caps + 4 maxpacket + 1 charset + 23 reserved
      // #393：登录包字符集字节（偏移 8）记入会话，作为初始结果集 charsetNr
      if (payload.length > 8) this.session.charsetNr = payload[8] || CHARSET_UTF8;
      const userEnd = payload.indexOf(0, pos);
      if (userEnd === -1) throw new Error('malformed handshake response: missing username');
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
          // #394：握手指定的库不存在时回 1049 Unknown database，不再隐式建库（与 COM_INIT_DB 一致）
          if (!this.server._dbExists(db)) {
            this._send(errPacket(1049, `Unknown database '${db}'`));
            this.socket.end();
            return;
          }
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
      // P2-4: countPlaceholders 不跳过注释——注释中的 ? 不应计入占位符
      if (c === '-' && sql[i + 1] === '-') {
        while (i < sql.length && sql[i] !== '\n') i++;
        continue;
      }
      if (c === '#') {
        while (i < sql.length && sql[i] !== '\n') i++;
        continue;
      }
      if (c === '/' && sql[i + 1] === '*') {
        i += 2;
        while (i + 1 < sql.length && !(sql[i] === '*' && sql[i + 1] === '/')) i++;
        i += 2;
        continue;
      }
      if (c === '?' && sql[i + 1] === '?') { i++; continue; }
      if (c === '?') n++;
    }
    return n;
  }

  _handleStmtPrepare(body) {
    (async () => {
      try {
        const sql = body.toString('utf8');
        const numParams = this.countPlaceholders(sql);
        // #273：列元数据来自真实 SQL/schema，不能再用 col1/col2 占位
        let colDefs = [];
        try {
          const stmt = parseSQL(sql);
          if (stmt && stmt.type === 'select') {
            let schema = null;
            try {
              const eng = await this.server._getDatabase(this.currentDb);
              const from = stmt.from && stmt.from.tables && stmt.from.tables[0];
              if (from && from.table && eng.getTableSchema) schema = await eng.getTableSchema(from.table);
            } catch (e) { schema = null; }
            const cols = stmt.columns || [];
            for (let i = 0; i < cols.length; i++) {
              const c = cols[i];
              if (c.expr === '*' && schema) {
                for (const [n, d] of Object.entries(schema)) {
                  colDefs.push({ name: n, table: null, database: this.currentDb, type: columnTypeFromSchema(d), flags: columnFlags(d) });
                }
                continue;
              }
              const name = c.alias || (typeof c.expr === 'string' ? c.expr : 'col' + (i + 1));
              const def = schema && schema[name];
              const type = c.aggregate ? MYSQL_TYPE_DOUBLE : columnTypeFromSchema(def || {});
              colDefs.push({ name, table: null, database: this.currentDb, type, flags: columnFlags(def) });
            }
          }
        } catch (e) { /* 无法解析的 SQL 仍可 prepare */ }
        const numColumns = colDefs.length;
        const stmtId = ++this._stmtSeq;
        this._stmts.set(stmtId, { sql, numParams, numColumns, columnDefs: colDefs, types: null, longData: new Map(), cursor: null });

        const pkt = Buffer.alloc(12);
        let off = 0;
        pkt[off++] = 0x00;
        pkt.writeUInt32LE(stmtId, off); off += 4;
        pkt.writeUInt16LE(numColumns, off); off += 2;
        pkt.writeUInt16LE(numParams, off); off += 2;
        pkt[off++] = 0x00;
        pkt.writeUInt16LE(0, off);
        this._send(pkt);

        for (let i = 0; i < numParams; i++) {
          this._send(columnDefinition({ name: '?', type: MYSQL_TYPE_VAR_STRING }));
        }
        if (numParams > 0) this._send(eofPacket());
        for (const cd of colDefs) this._send(columnDefinition(cd));
        if (numColumns > 0) this._send(eofPacket());
      } catch (e) {
        this._send(errPacket(toMysqlErrno(e), e.message));
      }
    })();
  }

  _handleStmtClose(body) {
    if (body.length >= 4) {
      const stmtId = body.readUInt32LE(0);
      this._stmts.delete(stmtId);
    }
  }

  // #389：COM_STMT_SEND_LONG_DATA 分片按序累积到语句参数缓冲，待下一次 EXECUTE 消费
  _handleStmtSendLongData(body) {
    if (body.length < 6) return;
    const stmtId = body.readUInt32LE(0);
    const paramNo = body.readUInt16LE(4);
    const stmt = this._stmts.get(stmtId);
    if (!stmt) return;
    const chunk = body.slice(6);
    const acc = stmt.longData.get(paramNo);
    if (acc) acc.push(chunk);
    else stmt.longData.set(paramNo, [chunk]);
    // 协议规定该命令无响应包
  }

  // #391：COM_STMT_RESET 清空参数绑定类型与累积的长数据，下一次 EXECUTE 必须重绑
  _handleStmtReset(body) {
    if (body.length >= 4) {
      const stmtId = body.readUInt32LE(0);
      const stmt = this._stmts.get(stmtId);
      if (stmt) {
        stmt.types = null;
        stmt.longData.clear();
        stmt.cursor = null; // #373
      }
    }
    this._send(okPacket());
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
      const useCursor = (flags & 0x03) !== 0; // #373: CURSOR_TYPE_READ_ONLY / FOR_UPDATE
      if (!useCursor) stmt.cursor = null;
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
          const typeWord = types[i];
          const type = typeWord & 0xff;
          const unsigned = ((typeWord >> 8) & PARAM_UNSIGNED_FLAG) !== 0;
          const parsed = this._readParamValue(body, off, type, unsigned);
          values.push(parsed.value);
          off = parsed.off;
        }
        // #389：累积的 SEND_LONG_DATA 分片优先于 EXECUTE 块内同参数值，消费后清空
        if (stmt.longData.size > 0) {
          for (const [paramNo, chunks] of stmt.longData) {
            if (paramNo >= 0 && paramNo < values.length) {
              values[paramNo] = Buffer.concat(chunks).toString('utf8');
            }
          }
          stmt.longData.clear();
        }
      }
      // #211：COM_STMT_EXECUTE 的结果集恒为二进制格式，即使没有占位符
      this._handleQuery(stmt.sql, values !== null && values.length > 0 ? values : undefined, true, useCursor ? stmt : null);
    } catch (e) {
      this._send(errPacket(toMysqlErrno(e), e.message));
    }
  }

  _readParamValue(buf, off, type, unsigned = false) {
    switch (type) {
      case MYSQL_TYPE_NULL: return { value: null, off };
      case 0x01: { // TINY
        const v = unsigned ? buf.readUInt8(off) : buf.readInt8(off);
        return { value: v, off: off + 1 };
      }
      case 0x02: { // SHORT
        const v = unsigned ? buf.readUInt16LE(off) : buf.readInt16LE(off);
        return { value: v, off: off + 2 };
      }
      case 0x03: { // LONG
        const v = unsigned ? buf.readUInt32LE(off) : buf.readInt32LE(off);
        return { value: v, off: off + 4 };
      }
      case MYSQL_TYPE_INT24: { // #424: MEDIUMINT，3 字节小端
        const v = buf.readUIntLE(off, 3);
        return { value: v, off: off + 3 };
      }
      case MYSQL_TYPE_YEAR: { // #424: YEAR，2 字节小端
        return { value: buf.readUInt16LE(off), off: off + 2 };
      }
      case MYSQL_TYPE_NEWDATE: { // #424: NEWDATE，7 字节日期时间结构
        const year = buf.readUInt16LE(off);
        const mo = buf[off + 2], day = buf[off + 3];
        const hh = buf[off + 4], mi = buf[off + 5], ss = buf[off + 6];
        const value = String(year).padStart(4, '0') + '-' + String(mo).padStart(2, '0') + '-' + String(day).padStart(2, '0')
          + ' ' + String(hh).padStart(2, '0') + ':' + String(mi).padStart(2, '0') + ':' + String(ss).padStart(2, '0');
        return { value, off: off + 7 };
      }
      case 0x08: { // LONGLONG
        const v = unsigned ? buf.readBigUInt64LE(off) : buf.readBigInt64LE(off);
        return { value: Number(v), off: off + 8 };
      }
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

  _handleQuery(sql, values, binary = false, cursorStmt = null) {
    (async () => {
      try {
        // #393：SET NAMES <charset> [COLLATE ...] 同时切换 client/connection/results 字符集
        const namesMatch = sql.match(/^\s*SET\s+NAMES\s+([A-Za-z0-9_]+)(?:\s+COLLATE\s+[A-Za-z0-9_]+)?\s*;?\s*$/i);
        if (namesMatch) {
          const cs = namesMatch[1].toLowerCase();
          this.session.sysvars['character_set_client'] = cs;
          this.session.sysvars['character_set_connection'] = cs;
          this.session.sysvars['character_set_results'] = cs;
          this.session.charset = cs;
          this.session.charsetNr = charsetNrByName(cs);
          this._send(okPacket());
          return;
        }
        const hasParams = values !== undefined && values !== null && values.length > 0;
        const processedSql = hasParams ? applyParams(sql, values) : sql;
        const statements = splitStatements(processedSql);
        if (statements.length > 1 && !this.multiStatements) {
          throw new Error(`too many statements (${statements.length} > 1)`);
        }
        for (let si = 0; si < statements.length; si++) {
          const stmtSql = statements[si];
          // #210：非末结果必须置 SERVER_MORE_RESULTS_EXISTS，客户端才会继续读下一个结果集
          const status = SERVER_STATUS_AUTOCOMMIT
            | (this._inTransaction ? SERVER_STATUS_IN_TRANS : 0)
            | (si < statements.length - 1 ? SERVER_MORE_RESULTS_EXISTS : 0);
          // #497: mysql.user 虚拟表 —— doc/mysql.md 承诺的内部认证元数据，
          // 引擎没有该物理表，在协议层直接构造结果集，避免误报 1146。
          const mysqlUserMatch = /\bfrom\s+mysql\.user\b/i.exec(stmtSql);
          if (mysqlUserMatch) {
            const selectPart = /^\s*select\s+([\s\S]+)$/i.exec(stmtSql.slice(0, mysqlUserMatch.index));
            const allCols = ['User', 'Host', 'authentication_string'];
            const selected = selectPart && selectPart[1].trim() !== '*'
              ? selectPart[1].split(',').map(s => s.trim().replace(/^`|`$/g, ''))
              : allCols;
            const auth = this.server.auth;
            const users = auth && typeof auth === 'object' ? Object.keys(auth) : [];
            const rows = users.map(u => [u, '%', '']);
            const pickedRows = rows.map(r => selected.map(c => {
              const idx = allCols.findIndex(x => x.toLowerCase() === String(c).toLowerCase());
              return idx >= 0 ? r[idx] : null;
            }));
            const virtual = { type: 'select', columns: selected, rows: pickedRows };
            const { packets, sequence } = binary
              ? binaryResultSetPacket(virtual, null, this.sequence, status, this.session.charsetNr)
              : resultSetPacket(virtual, null, this.sequence, null, status, this.session.charsetNr);
            this.sequence = sequence;
            this.socket.write(Buffer.concat(packets));
            continue;
          }
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
                this._send(okPacket(0, 0, status));
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
              }, null, this.sequence, null, status);
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
              this._send(okPacket(0, 0, status));
              continue;
            }
            case 'dropDatabase': {
              if (!this.server._canAccessDb(this.user, stmt.database)) {
                this._send(errPacket(1044, `Access denied for user '${this.user}' to database '${stmt.database}'`));
                continue;
              }
              await this.server.dropDatabase(stmt.database, { ifExists: stmt.ifExists });
              this._send(okPacket(0, 0, status));
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
          if (r && r.table) r.database = this.currentDb;
          if (r.type === 'select' || r.type === 'showTables' || r.type === 'showDatabases' || r.type === 'describe'
            || r.type === 'showColumns' || r.type === 'showIndex' || r.type === 'showCreateTable'
            || r.type === 'showVariables' || r.type === 'showStatus' || r.type === 'showGrants' || r.type === 'showWarnings') {
            if (r.type === 'showVariables') {
              // #393：会话 sysvars（如 SET NAMES 写入的 character_set_connection）覆盖内置默认值
              for (const row of r.rows || []) {
                if (Array.isArray(row)) {
                  const key = String(row[0]).toLowerCase();
                  if (this.session.sysvars[key] !== undefined) row[1] = String(this.session.sysvars[key]);
                }
              }
            }
            this.session.foundRows = (r.raw && r.raw.length !== undefined) ? r.raw.length : (r.rows ? r.rows.length : 0);
            let schema = null;
            if (r.table) {
              schema = engine.getTableSchema
                ? await engine.getTableSchema(r.table)
                : (engine._schemas ? engine._schemas[r.table] : null);
            }
            const { packets, sequence, cursorData } = binary
              ? binaryResultSetPacket(r, schema, this.sequence, status, this.session.charsetNr, !!cursorStmt)
              : resultSetPacket(r, schema, this.sequence, null, status, this.session.charsetNr);
            this.sequence = sequence;
            if (cursorData) cursorStmt.cursor = cursorData; // #373: 保存游标句柄供 FETCH 使用
            this.socket.write(Buffer.concat(packets));
          } else {
            // #372：BEGIN 之后置位，COMMIT/ROLLBACK 之后清零；OK 包按执行后的状态回
            if (r.type === 'begin') this._inTransaction = true;
            else if (r.type === 'commit' || r.type === 'rollback') this._inTransaction = false;
            if (r.type === 'insert') {
              this.session.lastInsertId = r.insertId;
              this.session.rowCount = r.affectedRows;
            } else if (r.type === 'update' || r.type === 'delete' || r.type === 'truncate') {
              this.session.rowCount = r.affectedRows;
            }
            const afterStatus = SERVER_STATUS_AUTOCOMMIT
              | (this._inTransaction ? SERVER_STATUS_IN_TRANS : 0)
              | (si < statements.length - 1 ? SERVER_MORE_RESULTS_EXISTS : 0);
            this._send(okPacket(r.affectedRows || 0, r.insertId || 0, afterStatus));
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
    this.port = options.port ?? 3306;
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
    this._dbDir = options.dataDir && options.dataDir !== ':memory:' ? path.resolve(options.dataDir) : null;
    this._defaultDbName = options.defaultDatabase || 'default';
    this._connectionCounter = 0;
    this._sockets = new Set();
    this._connections = new Map(); // #392: connectionId → MysqlConnection
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
      if (user && this.auth && !this._canAccessDb(user, stmt.database)) {
        const err = new Error(`Access denied for user '${user}' to database '${stmt.database}'`);
        err.code = 1044;
        throw err;
      }
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
      if (user && this.auth && !this._canAccessDb(user, db)) {
        const err = new Error(`Access denied for user '${user}' to database '${db}'`);
        err.code = 1044;
        throw err;
      }
      if (!this._dbExists(db)) await this.createDatabase(db);
      const engine = await this._getDatabase(db);
      let s = sql;
      for (const t of tables) {
        if (t && t.indexOf('.') !== -1) {
          // #97：每次 s.replace 都会缩短 s（剥掉 db. 前缀），但 offset 是相对当前 s 的。
          // 此前 masked 只基于最初始的完整 s 算一次，后续 replace 的 offset 相对 masked
          // 整体"提前"，掩码守卫误判 → ≥2 个 db.table 时改写错位（错库/错表）。
          // 所以每次替换前必须基于**当前 s** 重算掩码，保证 offset 对齐。
          const masked = _maskStringsAndComments(s);
          const re = new RegExp('\\b' + t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'g');
          s = s.replace(re, (match, offset) => {
            // 如果匹配位置在字符串字面量或注释中，不替换。
            // _maskStringsAndComments 把字符串/注释内的字符置为空格，
            // 因此 masked[offset] === ' ' 表示该位置在字面量/注释里（#31）。
            if (masked[offset] === ' ') return match;
            return t.split('.')[1];
          });
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
    // 未配置认证：允许访问
    if (!this.auth) return true;
    const list = this._userDbList(user);
    // _userDbList 返回 null 表示该用户有全局访问权限
    if (list === null) return true;
    // 空数组表示用户有受限数据库集，dbName 必须明确在列表中
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
        const conn = new MysqlConnection(socket, this);
        this._connections.set(conn.connectionId, conn);
        socket.on('close', () => {
          this._sockets.delete(socket);
          this._connections.delete(conn.connectionId);
        });
      });
      this._server.once('error', err => {
        if (err && err.code === 'EADDRINUSE') {
          const friendly = new Error(
            `MysqlServer 端口 ${this.port} 已被占用（EADDRINUSE）。` +
            `请换一个空闲端口，或传 port: 0 让系统分配临时端口。`
          );
          friendly.code = 'EADDRINUSE';
          friendly.cause = err;
          if (typeof this.options.onError === 'function') this.options.onError(friendly);
          else if (cb) cb(friendly);
          else console.error('[jsql-neo] mysql server error:', friendly.message);
        } else if (typeof this.options.onError === 'function') this.options.onError(err);
        else if (cb) cb(err);
        else console.error('[jsql-neo] mysql server error:', err.message);
      });
      this._server.listen(this.port, this.host, cb ? () => cb() : undefined);
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

module.exports = { createMysqlServer, MysqlServer, MysqlConnection };
