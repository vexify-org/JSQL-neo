/*
 * MongoDB wire protocol (OP_MSG, 3.6+) server for JSQL-NEO.
 *
 * Lets the official `mongodb` npm driver (and mongosh / Compass) connect to
 * jsql-neo as if it were a MongoDB server. Documents are stored as rows of a
 * JSQL table named after the MongoDB collection.
 *
 * Commands supported (minimal but practical):
 *   hello / isMaster / ping / buildInfo / getParameter / endSessions
 *   listDatabases / listCollections / create / drop
 *   insert / find / getMore / update / delete / count / aggregate($match,$count)
 */
const net = require('net');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const Database = require('./database');
const { ObjectId, valuesEqual, arrayIncludesValue, mapKey, orAnyElement, anyElementRange } = require('./objectid');
const { getPath, setPath, unsetPath, applyModifier } = require('./nedb_compat');

const OP_MSG = 2013;
const OP_COMPRESSED = 2012;
const OP_QUERY = 2004;
const OP_REPLY = 1;

const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;

/** #567：OP_MSG 尾部校验和用 CRC-32C（Castagnoli，反射多项式 0x82F63B78） */
const CRC32C_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = (c & 1) ? (0x82f63b78 ^ (c >>> 1)) : (c >>> 1);
    table[i] = c >>> 0;
  }
  return table;
})();
function crc32c(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC32C_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * #396：把扩展 JSON 的 Int64 标记（`$numberLong` / `$long`）或 BigInt 解析成
 * 范围内的 BigInt。直接 `BigInt(String(...))` 解析，不经过 `Number()` 中转
 * （先 Number 会把 >2^53 的值四舍五入，再 BigInt 触发裸 RangeError）；
 * 越界给明确的 BSON 错误，而不是静默截断。
 */
function parseInt64Value(marker, field) {
  let raw = marker;
  if (marker && typeof marker === 'object' && !Array.isArray(marker)) {
    raw = marker.$numberLong !== undefined ? marker.$numberLong : marker.$long;
  }
  let val;
  if (typeof raw === 'bigint') val = raw;
  else {
    const s = String(raw === null ? '' : raw).trim();
    if (!/^[+-]?\d+$/.test(s)) throw new Error(`BSON $numberLong invalid value: '${raw}' (field '${field}')`);
    try { val = BigInt(s); }
    catch (e) { throw new Error(`BSON $numberLong invalid value: '${raw}' (field '${field}')`); }
  }
  if (val < INT64_MIN || val > INT64_MAX) {
    throw new Error(`BSON $numberLong out of int64 range: '${raw}' (field '${field}')`);
  }
  return val;
}

/**
 * #432：BSON 字符串必须是合法 UTF-8。Buffer.toString('utf8') 对非法字节
 * 静默产出 U+FFFD；用「解码再编码字节完全一致」做严格校验，非法报文报错。
 */
function decodeUtf8Strict(buf, start, end, field) {
  const bytes = buf.subarray(start, end);
  const s = bytes.toString('utf8');
  if (!Buffer.from(s, 'utf8').equals(bytes)) {
    throw new Error(`BSON invalid UTF-8 string (field '${field}')`);
  }
  return s;
}
function encodeUtf8Strict(str, field) {
  // 孤立代理项经 Buffer.from 会变成 U+FFFD，显式拒绝
  const bytes = Buffer.from(str, 'utf8');
  if (decodeUtf8Strict(bytes, 0, bytes.length, field) !== str) {
    throw new Error(`BSON invalid UTF-8 string (field '${field}')`);
  }
  return bytes;
}

/** #403：Decimal128 编解码。保留 34 位十进制精度，不走 double。 */
const DECIMAL128_BIAS = 6176n;
function decimal128ToNumberString(buf, pos) {
  const high32 = buf.readUInt32LE(pos + 12);
  const negative = (high32 >>> 31) === 1;
  const combination = (high32 >>> 26) & 0x1f;
  let biasedExp, sigMsb;
  if ((combination >> 3) === 3) {
    if (combination === 30) return negative ? '-Infinity' : 'Infinity';
    if (combination === 31) return 'NaN';
    biasedExp = (high32 >>> 15) & 0x3fff;
    sigMsb = 8 + ((high32 >>> 14) & 1);
  } else {
    sigMsb = (high32 >>> 14) & 0x7;
    biasedExp = (high32 >>> 17) & 0x3fff;
  }
  // 114 位有效数：4 个 32 位字（buffer 中低字在前）
  const words = [
    (high32 & 0x3fff) | (sigMsb << 14),
    buf.readUInt32LE(pos + 8),
    buf.readUInt32LE(pos + 4),
    buf.readUInt32LE(pos),
  ];
  let coeff = 0n;
  for (const w of words) coeff = (coeff << 32n) | BigInt(w >>> 0);
  if (coeff === 0n) return negative ? '-0' : '0';
  const exponent = biasedExp - Number(DECIMAL128_BIAS);
  return (negative ? '-' : '') + coeff.toString() + 'E' + (exponent >= 0 ? '+' : '') + exponent;
}
function decimal128FromNumberString(str, field) {
  const raw = String(str).trim();
  // 解码产出的原始 16 字节封装，无损回写
  if (/^0x[0-9a-fA-F]{32}$/.test(raw)) return Buffer.from(raw.slice(2), 'hex');
  if (/^[+-]?inf(inity)?$/i.test(raw)) {
    const out = Buffer.alloc(16);
    if (raw[0] === '-') out[15] = 0xf8; else out[15] = 0x78;
    return out;
  }
  if (/^nan$/i.test(raw)) {
    const out = Buffer.alloc(16);
    out[15] = 0x7c;
    return out;
  }
  const m = raw.match(/^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/);
  if (!m || (!m[2] && !m[3])) throw new Error(`BSON $numberDecimal invalid value: '${str}' (field '${field}')`);
  const negative = m[1] === '-';
  const intPart = m[2] || '';
  const fracPart = m[3] || '';
  const digits = (intPart + fracPart).replace(/^0+(?=\d)/, '');
  let exponent = (m[4] ? parseInt(m[4], 10) : 0) - fracPart.length;
  let coeff = BigInt(digits || '0');
  if (coeff === 0n) exponent = 0;
  if (coeff > 10n ** 34n - 1n) throw new Error(`BSON $numberDecimal too many digits: '${str}' (field '${field}')`);
  const biasedExp = BigInt(exponent) + DECIMAL128_BIAS;
  if (biasedExp < 0n || biasedExp > 12287n) throw new Error(`BSON $numberDecimal exponent out of range: '${str}' (field '${field}')`);
  const highCoeff = coeff >> 64n;
  const lowCoeff = coeff & ((1n << 64n) - 1n);
  let high;
  if (((highCoeff >> 49n) & 1n) === 1n) {
    high = (3n << 61n) | ((biasedExp & 0x3fffn) << 47n) | (highCoeff & 0x7fffffffffffn);
  } else {
    high = ((biasedExp & 0x3fffn) << 49n) | (highCoeff & 0x1ffffffffffffn);
  }
  if (negative) high |= (1n << 63n);
  const out = Buffer.alloc(16);
  out.writeBigUInt64LE(lowCoeff, 0);
  out.writeBigUInt64LE(high & ((1n << 64n) - 1n), 8);
  return out;
}

/* ------------------------------------------------------------------ */
/* BSON                                                               */
/* ------------------------------------------------------------------ */

function appendBytes(buf, b) {
  const out = Buffer.concat([buf, b]);
  return out;
}

function bsonDocument(obj) {
  // 简易 BSON 文档编码（定长后修正 size）
  let body = Buffer.alloc(4); // size placeholder
  for (const [k, v] of Object.entries(obj || {})) {
    const name = encodeUtf8Strict(k, k);
    if (v === null || v === undefined) {
      body = Buffer.concat([body, Buffer.from([0x0A]), name, Buffer.from([0])]);
      continue;
    }
    if (typeof v === 'number') {
      // #284：整数按 BSON 规范编 Int32(0x10) / Int64(0x12)，只有真正的浮点
      // 才用 Double(0x01)。此前一律编 double，导致线上类型与驱动预期不符
      // （$type:'int' 永远匹配不到），且 int32 本可 4 字节却占了 8 字节。
      if (Number.isInteger(v)) {
        if (v >= -2147483648 && v <= 2147483647) {
          const b = Buffer.alloc(4);
          b.writeInt32LE(v, 0);
          body = Buffer.concat([body, Buffer.from([0x10]), name, Buffer.from([0]), b]);
        } else if (Number.isSafeInteger(v)) {
          const b = Buffer.alloc(8);
          b.writeBigInt64LE(BigInt(v), 0);
          body = Buffer.concat([body, Buffer.from([0x12]), name, Buffer.from([0]), b]);
        } else {
          // 超出安全整数范围：double 已是唯一无损的表示
          const b = Buffer.alloc(8);
          b.writeDoubleLE(v, 0);
          body = Buffer.concat([body, Buffer.from([0x01]), name, Buffer.from([0]), b]);
        }
        continue;
      }
      const b = Buffer.alloc(8);
      b.writeDoubleLE(v, 0);
      body = Buffer.concat([body, Buffer.from([0x01]), name, Buffer.from([0]), b]);
      continue;
    }
    if (typeof v === 'bigint') {
      // #396：原生 BigInt 直接按 Int64 写入，越界显式报错
      if (v < INT64_MIN || v > INT64_MAX) throw new Error(`BSON bigint out of int64 range: ${v} (field '${k}')`);
      const b = Buffer.alloc(8);
      b.writeBigInt64LE(v, 0);
      body = Buffer.concat([body, Buffer.from([0x12]), name, Buffer.from([0]), b]);
      continue;
    }
    if (v && typeof v === 'object' && !Array.isArray(v) && (v.$numberLong !== undefined || v.$long !== undefined)) {
      // #396：扩展 JSON Int64 标记 `$numberLong` / `$long` 都编成 0x12；
      // 直接 BigInt 解析十进制字符串，不走 Number() 中转，越界抛明确错误。
      const val = parseInt64Value(v, k);
      const b = Buffer.alloc(8);
      b.writeBigInt64LE(val, 0);
      body = Buffer.concat([body, Buffer.from([0x12]), name, Buffer.from([0]), b]);
      continue;
    }
    // #403/#404/#397：特殊 BSON 类型标记必须在通用 object 分支之前处理
    if (v && typeof v === 'object' && !Array.isArray(v) && v.$numberDecimal !== undefined) {
      const b = decimal128FromNumberString(v.$numberDecimal, k);
      body = Buffer.concat([body, Buffer.from([0x13]), name, Buffer.from([0]), b]);
      continue;
    }
    if (v && typeof v === 'object' && !Array.isArray(v) && v.$timestamp !== undefined) {
      const ts = v.$timestamp || {};
      const b = Buffer.alloc(8);
      b.writeUInt32LE(Number(ts.i) >>> 0, 0); // 规范：increment 在前、timestamp 在后
      b.writeUInt32LE(Number(ts.t) >>> 0, 4);
      body = Buffer.concat([body, Buffer.from([0x11]), name, Buffer.from([0]), b]);
      continue;
    }
    if (v && typeof v === 'object' && !Array.isArray(v) && v.$minKey !== undefined) {
      body = Buffer.concat([body, Buffer.from([0xFF]), name, Buffer.from([0])]);
      continue;
    }
    if (v && typeof v === 'object' && !Array.isArray(v) && v.$maxKey !== undefined) {
      body = Buffer.concat([body, Buffer.from([0x7F]), name, Buffer.from([0])]);
      continue;
    }
    if (v instanceof RegExp) {
      body = Buffer.concat([body, Buffer.from([0x0B]), name, Buffer.from([0]),
        encodeUtf8Strict(v.source, k), Buffer.from([0]),
        encodeUtf8Strict(v.flags, k), Buffer.from([0])]);
      continue;
    }
    if (v && typeof v === 'object' && !Array.isArray(v) && v.$regex !== undefined) {
      body = Buffer.concat([body, Buffer.from([0x0B]), name, Buffer.from([0]),
        encodeUtf8Strict(String(v.$regex), k), Buffer.from([0]),
        encodeUtf8Strict(String(v.$options || ''), k), Buffer.from([0])]);
      continue;
    }
    if (typeof v === 'boolean') {
      body = Buffer.concat([body, Buffer.from([0x08]), name, Buffer.from([0]), Buffer.from([v ? 1 : 0])]);
      continue;
    }
    if (typeof v === 'string') {
      const str = encodeUtf8Strict(v, k);
      const lenBuf = Buffer.alloc(4);
      lenBuf.writeInt32LE(str.length + 1, 0);
      body = Buffer.concat([body, Buffer.from([0x02]), name, Buffer.from([0]), lenBuf, str, Buffer.from([0])]);
      continue;
    }
    if (Buffer.isBuffer(v)) {
      // #285：BSON Binary 布局 = type 0x05 + 字段名 + int32 长度 +
      // **1 字节 subtype** + length 字节数据。
      // 此前写成 Buffer.from([0, 0])（两个字节），比规范多 1 字节 ——
      // 解码端按规范只跳 1 个 subtype 字节，于是冗余 0x00 被当成数据首字节，
      // 整个字节流错位（[1,2,3,4] 读回成 [0,0,1,2]），且后续字段解析失步。
      const lenBuf = Buffer.alloc(4);
      lenBuf.writeInt32LE(v.length, 0);
      const subtype = (v.subtype !== undefined && v.subtype !== null) ? (v.subtype & 0xff) : 0;
      body = Buffer.concat([body, Buffer.from([0x05]), name, Buffer.from([0]), lenBuf,
        Buffer.from([subtype]), v]);
      continue;
    }
    if (v instanceof Date) {
      const b = Buffer.alloc(8);
      b.writeBigInt64LE(BigInt(v.getTime()), 0);
      body = Buffer.concat([body, Buffer.from([0x09]), name, Buffer.from([0]), b]);
      continue;
    }
    if (v instanceof ObjectId) {
      // 必须在通用 object 分支之前：ObjectId 落回 0x03 会丢类型
      body = Buffer.concat([body, Buffer.from([0x07]), name, Buffer.from([0]), v.bytes]);
      continue;
    }
    if (Array.isArray(v)) {
      const arrObj = {};
      v.forEach((x, i) => { arrObj[String(i)] = x; });
      const sub = bsonDocument(arrObj);
      body = Buffer.concat([body, Buffer.from([0x04]), name, Buffer.from([0]), sub]);
      continue;
    }
    if (typeof v === 'object') {
      const sub = bsonDocument(v);
      body = Buffer.concat([body, Buffer.from([0x03]), name, Buffer.from([0]), sub]);
      continue;
    }
    // fallback: int32
    const b = Buffer.alloc(4);
    b.writeInt32LE(Number(v) || 0, 0);
    body = Buffer.concat([body, Buffer.from([0x10]), name, Buffer.from([0]), b]);
  }
  body = Buffer.concat([body, Buffer.from([0])]);
  body.writeInt32LE(body.length, 0);
  return body;
}

function bsonReadDocument(buf, pos) {
  const start = pos;
  const size = buf.readInt32LE(pos); pos += 4;
  const end = start + size;
  const obj = {};
  while (pos < end - 1) {
    const type = buf[pos++];
    // cstring field name
    const nameEnd = buf.indexOf(0, pos);
    if (nameEnd < 0 || nameEnd >= end) throw new Error('BSON malformed field name');
    const name = decodeUtf8Strict(buf, pos, nameEnd, '<field name>');
    pos = nameEnd + 1;
    const r = bsonReadValue(buf, pos, type, end);
    obj[name] = r.value;
    pos = r.pos;
  }
  return { value: obj, pos: end };
}

function bsonReadValue(buf, pos, type, end) {
  switch (type) {
    case 0x01: { const v = buf.readDoubleLE(pos); return { value: v, pos: pos + 8 }; }
    case 0x02: {
      const len = buf.readInt32LE(pos); pos += 4;
      if (len < 1 || pos + len > end) throw new Error('BSON malformed string length');
      const v = decodeUtf8Strict(buf, pos, pos + len - 1, '<string>');
      return { value: v, pos: pos + len };
    }
    case 0x03: { const r = bsonReadDocument(buf, pos); return { value: r.value, pos: r.pos }; }
    case 0x04: {
      const r = bsonReadDocument(buf, pos);
      const arr = [];
      for (let i = 0; i < Object.keys(r.value).length; i++) arr.push(r.value[String(i)]);
      return { value: arr, pos: r.pos };
    }
    case 0x05: { const len = buf.readInt32LE(pos); return { value: buf.slice(pos + 5, pos + 5 + len), pos: pos + 5 + len }; }
    case 0x07: { return { value: ObjectId.fromBytes(buf.slice(pos, pos + 12)), pos: pos + 12 }; }
    case 0x08: { return { value: buf[pos] !== 0, pos: pos + 1 }; }
    case 0x09: { return { value: new Date(Number(buf.readBigInt64LE(pos))), pos: pos + 8 }; }
    case 0x0A: { return { value: null, pos }; }
    case 0x0B: {
      // #397：pattern cstring + flags cstring；必须推进实际字节，后续字段才能继续解析
      const pEnd = buf.indexOf(0, pos);
      if (pEnd < 0 || pEnd >= end) throw new Error('BSON malformed RegExp pattern');
      const pattern = decodeUtf8Strict(buf, pos, pEnd, '$regex');
      const fEnd = buf.indexOf(0, pEnd + 1);
      if (fEnd < 0 || fEnd > end) throw new Error('BSON malformed RegExp flags');
      const flags = decodeUtf8Strict(buf, pEnd + 1, fEnd, '$options');
      return { value: { $regex: pattern, $options: flags }, pos: fEnd + 1 };
    }
    case 0x10: { return { value: buf.readInt32LE(pos), pos: pos + 4 }; }
    case 0x11: {
      // #404：Timestamp 是 uint32 increment + uint32 timestamp，不能压成裸 Number
      const i = buf.readUInt32LE(pos);
      const t = buf.readUInt32LE(pos + 4);
      return { value: { $timestamp: { t, i } }, pos: pos + 8 };
    }
    case 0x12: {
      // #396：Int64 必须无损往返 —— 保留完整 64 位值为扩展 JSON `$numberLong`
      // 字符串标记，不再经 Number() 降级成双精度（>2^53 会丢末三位精度）。
      const big = buf.readBigInt64LE(pos);
      return { value: { $numberLong: big.toString() }, pos: pos + 8 };
    }
    case 0x13: {
      // #403：16 字节 Decimal128，按十进制字符串无损回传，游标推进 16
      return { value: { $numberDecimal: decimal128ToNumberString(buf, pos) }, pos: pos + 16 };
    }
    case 0xFF: { return { value: { $minKey: 1 }, pos }; } // #404：零字节占位
    case 0x7F: { return { value: { $maxKey: 1 }, pos }; }
    default: return { value: null, pos: end };
  }
}

function cloneDoc(v) {
  if (v instanceof ObjectId) return v;
  if (Array.isArray(v)) return v.map(cloneDoc);
  if (v && typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v)) out[k] = cloneDoc(v[k]);
    return out;
  }
  return v;
}

/** #220：BSON 类型判别（数组/null/object 不能靠 typeof） */
function bsonTypeOf(v) {
  if (v === null || v === undefined) return 'null';
  if (Array.isArray(v)) return 'array';
  if (v instanceof ObjectId) return 'objectId';
  if (v instanceof Date) return 'date';
  if (typeof v === 'boolean') return 'bool';
  if (typeof v === 'number') return 'number';
  if (typeof v === 'string') return 'string';
  if (typeof v === 'object') return 'object';
  return typeof v;
}

/** #219：子文档深相等（数组有序、ObjectId 按字节） */
function deepEqualMongo(a, b) {
  if (a === b) return true;
  if (a instanceof ObjectId || b instanceof ObjectId) return valuesEqual(a, b);
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((x, i) => deepEqualMongo(x, b[i]));
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const ka = Object.keys(a), kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    return ka.every(k => Object.prototype.hasOwnProperty.call(b, k) && deepEqualMongo(a[k], b[k]));
  }
  return false;
}

/** #410：分组键对象需按内容规范化，不能靠对象身份（mapKey 对普通对象返回自身） */
function groupKeyOf(v) {
  if (v instanceof ObjectId) return mapKey(v);
  if (v && typeof v === 'object') {
    return '\0obj:' + JSON.stringify(v, (k, x) => (x instanceof ObjectId ? mapKey(x) : x));
  }
  return mapKey(v);
}

function applyProjection(doc, spec, matchFn) {
  if (!spec || typeof spec !== 'object') return doc;
  const entries = Object.entries(spec);
  // #411：投影值为 {$slice:...}/{$elemMatch:...} 时是对数组求值，不是普通包含
  const opSpecs = new Map();
  for (const [k, v] of entries) {
    if (k === '_id' || !v || typeof v !== 'object' || Array.isArray(v)
      || v instanceof ObjectId || v instanceof Date || v instanceof RegExp) continue;
    const ops = Object.keys(v).filter(x => x.startsWith('$'));
    if (ops.length === 0) continue;
    for (const op of ops) {
      if (op !== '$slice' && op !== '$elemMatch') throw new Error(`Unsupported projection operator: ${op}`);
    }
    opSpecs.set(k, v);
  }
  const inclusion = entries.filter(([k, v]) => k !== '_id' && !!v && !opSpecs.has(k));
  const exclusion = entries.filter(([k, v]) => k !== '_id' && !v);
  if (inclusion.length && exclusion.length) {
    throw new Error('Cannot do inclusion and exclusion in the same projection (except _id)');
  }
  const out = inclusion.length ? {} : cloneDoc(doc);
  if (inclusion.length && (spec._id === undefined || !!spec._id)) {
    const id = getPath(doc, '_id');
    if (id !== undefined) setPath(out, '_id', id);
  }
  for (const [k] of inclusion) {
    const v = getPath(doc, k);
    if (v !== undefined) setPath(out, k, cloneDoc(v));
  }
  for (const [k, op] of opSpecs) {
    const raw = getPath(doc, k);
    if (raw === undefined || !Array.isArray(raw)) continue;
    let projected;
    if (op.$slice !== undefined) {
      const s = op.$slice;
      if (Array.isArray(s)) {
        const skip = Number(s[0]) || 0, lim = Number(s[1]) || 0;
        projected = raw.slice(skip, skip + lim);
      } else {
        const n = Number(s) || 0;
        projected = n < 0 ? raw.slice(Math.max(0, raw.length + n)) : raw.slice(0, n);
      }
    } else if (op.$elemMatch !== undefined && typeof matchFn === 'function') {
      const hit = raw.find(el => elemMatches(el, op.$elemMatch, matchFn));
      if (hit === undefined) continue;
      projected = [cloneDoc(hit)];
    }
    if (projected !== undefined) setPath(out, k, projected);
  }
  if (!inclusion.length) {
    for (const [k] of exclusion) unsetPath(out, k);
    if (spec._id === 0 || spec._id === false) unsetPath(out, '_id');
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* 聚合表达式求值（$project 派生字段）                                 */
/* ------------------------------------------------------------------ */

function evalMongoExpr(expr, doc, vars) {
  if (expr === null || typeof expr !== 'object') {
    if (typeof expr === 'string' && expr.startsWith('$$')) {
      // #431：$lookup let 变量（$$var / $$ROOT）
      if (!vars) return undefined;
      const name = expr.slice(2);
      return name === 'ROOT' ? doc : vars[name];
    }
    if (typeof expr === 'string' && expr.startsWith('$')) return getPath(doc, expr.slice(1));
    return expr;
  }
  if (Array.isArray(expr)) return expr.map(x => evalMongoExpr(x, doc, vars));
  const args = (v) => (Array.isArray(v) ? v : [v]);
  const ev = (x) => evalMongoExpr(x, doc, vars);
  let result = expr;
  for (const [op, arg] of Object.entries(expr)) {
    switch (op) {
      case '$literal': result = arg; break;
      case '$toUpper': result = String(ev(arg)).toUpperCase(); break;
      case '$toLower': result = String(ev(arg)).toLowerCase(); break;
      case '$add': result = args(arg).reduce((s, x) => s + (Number(ev(x)) || 0), 0); break;
      case '$subtract': { const a = args(arg); result = (Number(ev(a[0])) || 0) - (Number(ev(a[1])) || 0); break; }
      case '$multiply': result = args(arg).reduce((s, x) => s * (Number(ev(x)) || 0), 1); break;
      case '$divide': { const a = args(arg); result = (Number(ev(a[0])) || 0) / (Number(ev(a[1])) || 1); break; }
      case '$concat': result = args(arg).map(x => String(ev(x))).join(''); break;
      case '$abs': result = Math.abs(Number(ev(arg)) || 0); break;
      case '$cond': { const c = args(arg); result = ev(c[0]) ? ev(c[1]) : ev(c[2]); break; }
      case '$ifNull': { const c = args(arg); const v = ev(c[0]); result = v === null || v === undefined ? ev(c[1]) : v; break; }
      case '$eq': { const c = args(arg); result = deepEqualMongo(ev(c[0]), ev(c[1])); break; }
      case '$ne': { const c = args(arg); result = !deepEqualMongo(ev(c[0]), ev(c[1])); break; }
      case '$gt': { const c = args(arg); result = ev(c[0]) > ev(c[1]); break; }
      case '$gte': { const c = args(arg); result = ev(c[0]) >= ev(c[1]); break; }
      case '$lt': { const c = args(arg); result = ev(c[0]) < ev(c[1]); break; }
      case '$lte': { const c = args(arg); result = ev(c[0]) <= ev(c[1]); break; }
      default: return expr;
    }
  }
  return result;
}

/** #410：$_id 对象表达式逐行求值（$ 开头当作表达式对象，否则逐字段递归） */
function evalMongoObject(expr, doc, vars) {
  if (expr && typeof expr === 'object' && !Array.isArray(expr)) {
    const keys = Object.keys(expr);
    if (keys.length > 0 && keys.every(k => k.startsWith('$'))) return evalMongoExpr(expr, doc, vars);
    const out = {};
    for (const [k, v] of Object.entries(expr)) out[k] = evalMongoObject(v, doc, vars);
    return out;
  }
  return evalMongoExpr(expr, doc, vars);
}

/** #411：投影 $elemMatch 共用 server._elemMatches 的匹配语义 */
function elemMatches(el, cond, matchFn) {
  if (el !== null && typeof el === 'object' && !Array.isArray(el)) return matchFn(el, cond);
  if (!cond || typeof cond !== 'object' || Array.isArray(cond)) return false;
  const keys = Object.keys(cond);
  return keys.length > 0 && keys.every(c => c[0] === '$')
    && matchFn({ _val: el }, { _val: cond });
}

/* ------------------------------------------------------------------ */
/* 排序（find 与 aggregate $sort 共用）                                */
/* ------------------------------------------------------------------ */

function sortRows(rows, sortSpec) {
  const sortKeys = Object.entries(sortSpec);
  return [...rows].sort((a, b) => {
    for (const [k, dir] of sortKeys) {
      const av = getPath(a, k); const bv = getPath(b, k);
      // valuesEqual：同字节 ObjectId 不 ===，缺这一道相等短路时
      // 相等键会破坏排序稳定性（sort+skip/limit 分页会丢/重文档）
      if (av === bv || valuesEqual(av, bv)) continue;
      const desc = Number(dir) < 0;
      // Issue #47：NULL 的位置随排序方向走（升序在前、降序在后），
      // 与 MongoDB 一致；此前固定返回 1/-1，升序时 null 恒排最后。
      if (av == null) return desc ? 1 : -1;
      if (bv == null) return desc ? -1 : 1;
      const cmp = av < bv ? -1 : 1;
      return desc ? -cmp : cmp;
    }
    return 0;
  });
}

/* ------------------------------------------------------------------ */
/* Server                                                             */
/* ------------------------------------------------------------------ */

class MongoServer {
  constructor(options = {}) {
    this.options = options;
    this.port = options.port ?? 27017;
    this.host = options.host || '127.0.0.1';
    this.dataDir = options.dataDir || null;
    this.maxMessageSize = options.maxMessageSize || 48 * 1024 * 1024;
    this._engine = null;
    this._server = null;
    this._sockets = new Set();
    this._dbCollections = new Map(); // db name → Set of collection names
    this._engineByDb = new Map();    // db name → Database (standalone 模式)
    this._indexesByColl = new Map(); // "db.coll" → [{ name, columns, unique }]
    this._cursors = new Map();       // #278：find/getMore 游标
    this._nextCursorId = 1;
    this._nextConnId = 0;            // #459：连接自增标识，游标绑定到创建它的连接
    // #428：游标空闲超时（默认 10 分钟，与 MongoDB 默认 cursor 超时一致），
    // 超时后后台清扫回收；可经 options.cursorIdleTimeoutMs 覆盖。
    this._cursorIdleTimeoutMs = Number(options.cursorIdleTimeoutMs) > 0
      ? Number(options.cursorIdleTimeoutMs) : 10 * 60 * 1000;
    this._cursorTimer = setInterval(() => this._sweepIdleCursors(), Math.min(this._cursorIdleTimeoutMs, 60 * 1000));
    if (typeof this._cursorTimer.unref === 'function') this._cursorTimer.unref();
    this._autoCollections = new Set(); // db.collection 由 Mongo 自动建表（可继续补列）
    this._startedAt = Date.now();
  }

  async _getEngine(db = null) {
    if (this._engineByDb && db) {
      if (!this._engineByDb.has(db)) this._engineByDb.set(db, this._createEngine(db));
      return this._engineByDb.get(db);
    }
    if (this._engine) return this._engine;
    this._engine = this._createEngine(null);
    return this._engine;
  }

  _createEngine(db) {
    if (this.dataDir && this.dataDir !== ':memory:') {
      // 与 multiserver 的共享引擎保持一致：目录走 hybrid 模式（每表 .jsql 增量刷盘），
      // 否则 legacy 单文件模式在 insert 路径上从不落盘，数据重启即丢。
      // 兼容旧版单文件库：已存在同名文件则继续用 legacy 模式。
      const dbPath = path.join(this.dataDir, db || 'default');
      let stat = null;
      try { stat = fs.statSync(dbPath); } catch (e) { /* not created yet */ }
      return stat && stat.isFile()
        ? new Database(dbPath, { autoSave: true })
        : new Database(dbPath, { mode: 'hybrid' });
    }
    return new Database(':memory:', { autoSave: false });
  }

  _inferSchema(docs) {
    const defs = {};
    const list = Array.isArray(docs) ? docs : (docs ? [docs] : []);
    for (const doc of list) {
      if (!doc || typeof doc !== 'object' || Array.isArray(doc)) continue;
      for (const [field, value] of Object.entries(doc)) {
        if (value === null || value === undefined || defs[field]) continue;
        let type = 'string';
        if (typeof value === 'number') type = Number.isInteger(value) ? 'integer' : 'number';
        else if (typeof value === 'boolean') type = 'boolean';
        else if (Array.isArray(value)) type = 'array';
        // Date / Buffer / ObjectId / 嵌套对象一律按 object 透传，避免改写类型
        else if (typeof value === 'object') type = 'object';
        defs[field] = { type };
      }
    }
    return defs;
  }

  /**
   * 集合是否真实存在（#315）。
   * 判据：engine 侧存在该表，或本进程已登记过该集合。
   * 注意不能调用 _ensureCollection —— 那会把集合「创建」出来。
   */
  async _collectionExists(name, db = null) {
    const engine = await this._getEngine(db);
    if (!engine) return false;
    const key = (db || 'default') + '.' + name;
    if (this._autoCollections && this._autoCollections.has(key)) return true;
    if (this._dbCollections && this._dbCollections.has(db) && this._dbCollections.get(db).has(name)) return true;
    if (typeof engine.hasTable === 'function') {
      try { if (engine.hasTable(name)) return true; } catch (_) { /* ignore */ }
    }
    if (engine._tables && engine._tables[name]) return true;
    if (engine._meta && engine._meta.tables && engine._meta.tables[name]) return true;
    return false;
  }

  async _ensureCollection(name, db = null, sample = null) {
    const engine = await this._getEngine(db);
    const key = (db || 'default') + '.' + name;
    const schema = engine.getTableSchema(name);
    const defs = this._inferSchema(sample);
    if (!schema) {
      // createTable 是 async：不 await 的 rejection 会变成 unhandled rejection
      // 杀死进程（并发首写同一集合时 ER_TABLE_EXISTS 就能触发）
      await engine.createTable(name, defs);
      this._autoCollections.add(key);
    } else if (Object.keys(schema).length === 0) {
      // #178：Mongo 自动建表后 schema 为空，SQL 侧 SELECT * 拿不到列。
      const table = typeof engine._ensureTable === 'function' ? engine._ensureTable(name) : null;
      if (table && typeof table.addColumn === 'function') {
        for (const field of Object.keys(defs)) {
          if (!table._schema[field]) table.addColumn(field, defs[field]);
        }
      }
      this._autoCollections.add(key);
    } else {
      // 文档型数据允许新字段；落到 schema 后落盘才不会丢列
      const table = typeof engine._ensureTable === 'function' ? engine._ensureTable(name) : null;
      if (table && typeof table.addColumn === 'function') {
        for (const field of Object.keys(defs)) {
          if (!table._schema[field]) table.addColumn(field, defs[field]);
        }
      }
    }
    if (db) {
      if (!this._dbCollections.has(db)) this._dbCollections.set(db, new Set());
      this._dbCollections.get(db).add(name);
    }
    return engine;
  }

  listen(cb) {
    this._server = net.createServer((socket) => this._handleSocket(socket));
    this._server.on('error', (err) => {
      if (typeof this.options.onError === 'function') this.options.onError(err);
      else if (cb) cb(err);
    });
    this._server.listen(this.port, this.host, cb ? () => cb() : undefined);
    return this;
  }

  _handleSocket(socket, existing) {
    this._sockets.add(socket);
    socket._mongoConnId = ++this._nextConnId; // #459：游标归属连接标识
    socket.on('close', () => this._sockets.delete(socket));
    let buf = Buffer.isBuffer(existing) ? Buffer.from(existing) : Buffer.alloc(0);
    if (buf.length > this.maxMessageSize) {
      socket.destroy();
      return;
    }
    socket.on('error', () => {});
    let processing = false;
    let again = false;
    const processLoop = async () => {
      if (processing) { again = true; return; }
      processing = true;
      try {
        for (;;) {
          if (buf.length < 4) break;
          const len = buf.readInt32LE(0);
          if (len < 16 || len > this.maxMessageSize) {
            socket.destroy();
            return;
          }
          if (buf.length < len) break;
          const msg = buf.slice(0, len);
          buf = buf.slice(len);
          try {
            await this._handleMessage(socket, msg);
          } catch (e) {
            try { socket.write(this._wrapMsg(bsonDocument({ ok: 0, errmsg: e.message || String(e) }), this._reqId(msg))); } catch (_) {}
          }
        }
      } finally {
        processing = false;
        if (again) { again = false; processLoop(); }
      }
    };
    socket.on('data', (chunk) => {
      if (buf.length + chunk.length > this.maxMessageSize * 2) {
        socket.destroy();
        return;
      }
      buf = Buffer.concat([buf, chunk]);
      processLoop();
    });
    if (buf.length > 0) processLoop();
  }

  _reqId(msg) {
    return msg.readInt32LE(4);
  }

  _wrapMsg(payload, responseTo) {
    const id = Math.floor(Math.random() * 0x7fffffff);
    const head = Buffer.alloc(16);
    head.writeInt32LE(16 + 4 + 1 + payload.length, 0); // messageLength
    head.writeInt32LE(id, 4);                      // requestID
    head.writeInt32LE(responseTo, 8);              // responseTo
    head.writeInt32LE(OP_MSG, 12);                 // opCode
    const flags = Buffer.alloc(4);
    return Buffer.concat([head, flags, Buffer.from([0x00]), payload]); // flagBits + kind0
  }

  _wrapReply(payload, requestId) {
    // OP_REPLY: header + responseFlags + cursorID + startingFrom + numberReturned + documents
    const n = 16 + 4 + 8 + 4 + 4 + payload.length;
    const head = Buffer.alloc(16);
    head.writeInt32LE(n, 0);
    head.writeInt32LE(requestId + 1000, 4);
    head.writeInt32LE(requestId, 8);
    head.writeInt32LE(OP_REPLY, 12);
    const rest = Buffer.alloc(4 + 8 + 4 + 4); // responseFlags=0, cursorID=0, startingFrom=0, numberReturned=1
    rest.writeInt32LE(1, 4 + 8 + 4);
    return Buffer.concat([head, rest, payload]);
  }

  async _handleMessage(socket, msg) {
    const op = msg.readInt32LE(12);
    if (op === OP_QUERY) {
      let p = 20; // header + flags
      while (p < msg.length && msg[p] !== 0) p++;
      const ns = msg.toString('utf8', 20, p);
      p = p + 1 + 8; // null terminator + numberToSkip + numberToReturn
      if (p >= msg.length || !ns.endsWith('.$cmd')) {
        socket.write(this._wrapReply(bsonDocument({ ok: 0, errmsg: 'legacy op only supports $cmd' }), this._reqId(msg)));
        return;
      }
      try {
        const body = bsonReadDocument(msg, p).value;
        const command = this._commandName(body);
        const reply = await this._dispatch(command, body, socket._mongoConnId);
        socket.write(this._wrapReply(bsonDocument(reply), this._reqId(msg)));
      } catch (e) {
        socket.write(this._wrapReply(bsonDocument({ ok: 0, errmsg: e.message || String(e) }), this._reqId(msg)));
      }
      return;
    }
    if (op === OP_COMPRESSED) {
      msg = this._decompress(msg);
    }
    if (!msg) {
      socket.write(this._wrapMsg(bsonDocument({ ok: 0, errmsg: 'compression not supported' }), this._reqId(msg || Buffer.alloc(16))));
      return;
    }
    const op2 = msg.readInt32LE(12);
    if (op2 !== OP_MSG) {
      socket.write(this._wrapMsg(bsonDocument({ ok: 0, errmsg: `opCode ${op2} not supported` }), this._reqId(msg)));
      return;
    }
    const flags = msg.readInt32LE(16);
    const hasChecksum = (flags & 1) !== 0;
    if (hasChecksum) {
      // #567：报文末尾 4 字节是 CRC-32C，必须校验而不是直接剥掉
      if (msg.length < 21 || crc32c(msg.subarray(0, msg.length - 4)) !== msg.readUInt32LE(msg.length - 4)) {
        socket.write(this._wrapMsg(bsonDocument({ ok: 0, code: 30093, errmsg: 'OP_MSG checksum mismatch' }), this._reqId(msg)));
        return;
      }
    }
    const msgEnd = hasChecksum ? msg.length - 4 : msg.length;
    let pos = 16 + 4; // header + flagBits
    const body = {};
    let sawBody = false;
    while (pos < msgEnd) {
      const kind = msg[pos++];
      if (kind === 0) {
        const r = bsonReadDocument(msg, pos);
        Object.assign(body, r.value);
        pos = r.pos;
        sawBody = true;
      } else if (kind === 1) {
        // Document sequence: int32 size, cstring identifier, BSON docs
        const size = msg.readInt32LE(pos);
        const end = pos + size;
        if (size < 5 || end > msgEnd) throw new Error('malformed document sequence');
        let p = pos + 4;
        const nameEnd = msg.indexOf(0, p);
        if (nameEnd < 0 || nameEnd >= end) throw new Error('malformed document sequence identifier');
        const ident = msg.toString('utf8', p, nameEnd);
        p = nameEnd + 1;
        const seq = [];
        while (p < end) {
          const r = bsonReadDocument(msg, p);
          seq.push(r.value);
          p = r.pos;
        }
        body[ident] = seq;
        pos = end;
      } else {
        socket.write(this._wrapMsg(bsonDocument({ ok: 0, errmsg: `section kind ${kind} not supported` }), this._reqId(msg)));
        return;
      }
    }
    if (!sawBody) {
      socket.write(this._wrapMsg(bsonDocument({ ok: 0, errmsg: 'missing OP_MSG body section' }), this._reqId(msg)));
      return;
    }
    const command = this._commandName(body);
    const reply = await this._dispatch(command, body, socket._mongoConnId);
    socket.write(this._wrapMsg(bsonDocument(reply), this._reqId(msg)));
  }

  _commandName(doc) {
    for (const k of Object.keys(doc)) {
      if (k === '$db' || k === 'lsid' || k === '$clusterTime' || k === '$readPreference' || k === 'readConcern' || k === 'writeConcern') continue;
      return k;
    }
    return 'ping';
  }

  _decompress(msg) {
    try {
      // OP_COMPRESSED 布局：16B 标准头 + int32 originalOpcode(16) +
      // int8 compressorId(20) + int32 uncompressedSize(21) + compressedMessage(25)。
      // compressorId：1=snappy，2=zlib，3=zstd。
      const origOp = msg.readInt32LE(16);
      const compId = msg[20];
      const uncompSize = msg.readInt32LE(21);
      const data = msg.slice(25);
      let out;
      if (compId === 2) out = zlib.inflateSync(data);          // zlib
      else return null;                                         // 1=snappy / 3=zstd 无内置支持
      if (uncompSize > 0 && out.length !== uncompSize) return null;
      const head = Buffer.from(msg.slice(0, 16));
      head.writeInt32LE(origOp, 12);
      return Buffer.concat([head, out]);
    } catch (e) {
      return null;
    }
  }

  _dbOf(doc, fallback = 'test') {
    return doc.$db || fallback;
  }

  /** #429：命令级 writeConcern 校验；非法 w/j 回 writeConcernError（ok 仍为 1） */
  _writeConcernError(doc) {
    const wc = doc && doc.writeConcern;
    if (!wc || typeof wc !== 'object' || Array.isArray(wc)) return null;
    if (wc.j !== undefined && typeof wc.j !== 'boolean') {
      return { code: 2, errmsg: 'writeConcern.j must be a boolean' };
    }
    if (wc.w !== undefined) {
      const w = wc.w;
      if (typeof w === 'number') {
        if (!Number.isFinite(w) || w < 0) return { code: 2, errmsg: `invalid writeConcern.w: ${w}` };
      } else if (typeof w === 'string') {
        // 单节点实现只认识 majority 与 0/1；未知标签必须显式报错
        if (w !== 'majority' && w !== '0' && w !== '1') {
          return { code: 2, errmsg: `Unknown writeConcern w: "${w}"` };
        }
      } else {
        return { code: 2, errmsg: `invalid writeConcern.w: ${JSON.stringify(w)}` };
      }
    }
    if (wc.wtimeout !== undefined && (!Number.isFinite(Number(wc.wtimeout)) || Number(wc.wtimeout) < 0)) {
      return { code: 2, errmsg: `invalid writeConcern.wtimeout: ${wc.wtimeout}` };
    }
    return null;
  }

  _withWriteConcern(reply, doc) {
    const err = this._writeConcernError(doc);
    if (err) reply.writeConcernError = err;
    return reply;
  }

  async _dispatch(cmd, doc, connId) {

    switch (cmd) {
      case 'hello':
      case 'isMaster':
      case 'ismaster':
        return {
          ok: 1, isWritablePrimary: true, helloOk: true, maxWireVersion: 17, minWireVersion: 0,
          maxBsonObjectSize: 16777216, maxMessageSizeBytes: 48000000, maxWriteBatchSize: 100000,
          localTime: new Date(), logicalSessionTimeoutMinutes: 30, connectionId: 1,
        };
      case 'ping': return { ok: 1 };
      case 'buildInfo': return { ok: 1, version: '6.0.0-jsql-neo', gitVersion: 'jsql-neo', versionArray: [6, 0, 0, 0] };
      case 'serverStatus': {
        const uptimeMs = Math.max(0, Date.now() - this._startedAt);
        return {
          ok: 1,
          host: this.host,
          version: '6.0.0-jsql-neo',
          process: 'mongod',
          pid: process.pid,
          uptime: Math.floor(uptimeMs / 1000),
          uptimeMillis: uptimeMs,
          localTime: new Date(),
          connections: { current: this._sockets.size, available: 100000, totalCreated: this._sockets.size },
          ok: 1,
        };
      }
      case 'getCmdLineOpts': return { ok: 1, argv: ['jsql-neo'], parsed: {} };
      case 'getParameter': return { ok: 1 };
      case 'endSessions': return { ok: 1 };
      case 'listDatabases': {
        // P3-17: listDatabases 只返回当前库——返回所有数据库
        const engine = await this._getEngine(this._dbOf(doc));
        const dbs = Object.keys(engine._meta && engine._meta.databases ? engine._meta.databases : { [this._dbOf(doc)]: 1 });
        // #569：dbs 已是库名数组，不能再 Object.keys 一次（否则得到下标 "0"）
        const databases = dbs.map(name => ({ name, sizeOnDisk: 1, empty: false }));
        return { ok: 1, databases, totalSize: databases.length };
      }
      case 'listCollections': {
        const engine = await this._getEngine(this._dbOf(doc));
        const tables = Object.keys(engine._meta && engine._meta.tables ? engine._meta.tables : (engine._tables || {}));
        const firstBatch = tables.map((t) => ({ name: t, type: 'collection', options: {}, info: { readOnly: false, uuid: '' } }));
        return { ok: 1, cursor: { id: { $long: 0 }, ns: `${this._dbOf(doc)}.$cmd.listCollections`, firstBatch } };
      }
      case 'create': {
        const engine = await this._ensureCollection(String(doc.create), this._dbOf(doc));
        return { ok: 1, ns: engine ? `${this._dbOf(doc)}.${doc.create}` : '' };
      }
      case 'drop': {
        try {
          const engine = await this._getEngine(this._dbOf(doc));
          // 必须 await：dropTable 是 async，同步 try/catch 接不住它的 rejection，
          // 不 await 会变成 unhandled rejection 直接杀死整个进程
          await engine.dropTable(String(doc.drop));
          return { ok: 1, ns: `${this._dbOf(doc)}.${doc.drop}` };
        } catch (e) {
          return { ok: 1, ns: `${this._dbOf(doc)}.${doc.drop}` }; // Mongo 对不存在的 collection drop 也返回 ok
        }
      }
      case 'insert': {
        const coll = String(doc.insert);
        const docs = doc.documents || [];
        const engine = await this._ensureCollection(coll, this._dbOf(doc), docs);
        const ids = [];
        const writeErrors = [];
        // #255：MongoDB 的 insert 命令 ordered 选项默认 true ——
        // 一旦某条文档写入失败（如 E11000 重复键），**后续文档不再插入**。
        // 此前循环从头到尾没读 doc.ordered，冲突之后continue 继续插下一条，
        // 导致「本应中止保护上游批次语义」的写入实际全部落库。
        const ordered = doc.ordered !== false;
        for (let i = 0; i < docs.length; i++) {
          const doc2 = { ...docs[i] };
          // #566：握手通告的 maxBsonObjectSize 必须在写入路径真正校验
          const bsonSize = bsonDocument(doc2).length;
          if (bsonSize > 16777216) {
            return { ok: 0, code: 10334, errmsg: `BSON document too large: ${bsonSize} bytes (max 16777216)` };
          }
          // #430：文档缺省 `_id` 时服务端兜底生成 ObjectId —— MongoDB 每条文档
          // 必有 `_id`；生成后再走既有唯一性查重与落库流程。
          if (doc2._id === undefined) doc2._id = ObjectId.generate();
          // 检查 _id 唯一性
          // Issue #44：索引查找是严格相等的，空结果不能直接当「不存在」——
          // 查询值与已存值的类型不一致时会漏判。这里再加一道按 schema 归一的直接扫描。
          // 相等判断走 valuesEqual：同字节 ObjectId 与同 hex String 是两个不同的键。
          if (doc2._id !== undefined) {
            let dup = false;
            const existing = await engine.find(coll, { _id: doc2._id });
            if (existing.length > 0) dup = true;
            if (!dup) {
              const table = typeof engine._ensureTable === 'function' ? engine._ensureTable(coll) : null;
              if (table && Array.isArray(table._rows) && typeof table._coerceQueryValue === 'function') {
                const idKey = table._coerceQueryValue('_id', doc2._id);
                if (table._rows.some((r) => r && !r._deleted && valuesEqual(r._id, idKey))) dup = true;
              }
            }
            if (dup) {
              // 真重复必须可见：ordered:false 下 MongoDB 逐条报 E11000 writeErrors，
              // 此前静默丢弃导致计数对不上也无从发现（同 hex 异类型 _id 误判为重复）
              writeErrors.push({
                index: i,
                code: 11000,
                errmsg: `E11000 duplicate key error collection: ${this._dbOf(doc)}.${coll} index: _id_ dup key: { _id: ${doc2._id instanceof ObjectId ? doc2._id.toString() : JSON.stringify(doc2._id)} }`,
                keyPattern: { _id: 1 },
                keyValue: { _id: doc2._id },
              });
              // #255：ordered:true 时首个写入失败即中止本批（后续文档不插入）
              if (ordered) break;
              continue;
            }
          }
          // #221：二级唯一索引必须真正拦截重复键
          {
            const idxKey = this._dbOf(doc) + '.' + coll;
            const uniqIdx = (this._indexesByColl.get(idxKey) || []).filter(ix => ix.unique && ix.name !== '_id_');
            if (uniqIdx.length > 0) {
              const existingRows = await engine.find(coll, {});
              let dupIdx = null;
              for (const ix of uniqIdx) {
                if (ix.columns.some(c => getPath(doc2, c) === undefined || getPath(doc2, c) === null)) continue;
                const hit = existingRows.some(r => ix.columns.every(c => deepEqualMongo(getPath(r, c), getPath(doc2, c))));
                if (hit) { dupIdx = ix; break; }
              }
              if (dupIdx) {
                const keyValue = Object.fromEntries(dupIdx.columns.map(c => [c, getPath(doc2, c)]));
                writeErrors.push({
                  index: i, code: 11000,
                  errmsg: `E11000 duplicate key error collection: ${this._dbOf(doc)}.${coll} index: ${dupIdx.name} dup key: ${JSON.stringify(keyValue)}`,
                  keyPattern: Object.fromEntries(dupIdx.columns.map(c => [c, 1])),
                  keyValue,
                });
                // #255：ordered:true 时首个写入失败即中止本批
                if (ordered) break;
                continue;
              }
            }
          }
          await engine.insert(coll, doc2);
          ids.push(doc2._id);
        }
        const reply = { ok: 1, n: ids.length };
        if (writeErrors.length > 0) reply.writeErrors = writeErrors;
        return this._withWriteConcern(reply, doc);
      }
      case 'findAndModify': {
        const coll = String(doc.findAndModify);
        const engine = await this._ensureCollection(coll, this._dbOf(doc));
        const q = doc.query || {};
        let rows = await this._matching(engine, coll, q);
        if (doc.sort && typeof doc.sort === 'object' && !Array.isArray(doc.sort)) {
          rows = sortRows(rows, doc.sort);
        }
        const found = rows[0] || null;
        const updateDoc = doc.update || {};
        const isModifier = Object.keys(updateDoc).some(k => k.startsWith('$'));
        let value = null;
        if (found) {
          if (doc.remove) {
            await this._removeRows(engine, coll, [found]);
            value = found;
          } else if (isModifier) {
            const patched = cloneDoc(found);
            applyModifier(patched, updateDoc, { strict: true });
            await this._patchRows(engine, coll, [found], updateDoc);
            value = doc.new ? patched : found;
          } else {
            // #218：无 $ 运算符 = replacement，整体替换而非合并
            const patched = cloneDoc(updateDoc);
            if (found._id !== undefined) patched._id = found._id;
            await this._replaceRows(engine, coll, [found], updateDoc);
            value = doc.new ? patched : found;
          }
        } else if (doc.upsert) {
          // #224：upsert 时修饰符必须求值，不能把 $inc 当字面字段
          let merged;
          if (isModifier) {
            merged = this._nonDollarQuery(q);
            applyModifier(merged, updateDoc, { strict: true });
          } else {
            merged = cloneDoc(updateDoc);
          }
          if (merged._id === undefined && q._id !== undefined) merged._id = q._id;
          await engine.insert(coll, merged);
          value = doc.new ? { ...merged } : null;
        }
        return this._withWriteConcern({ ok: 1, value, lastErrorObject: { n: found ? 1 : (doc.upsert ? 1 : 0), updatedExisting: !!found && !doc.remove } }, doc);
      }
      case 'distinct': {
        const coll = String(doc.distinct);
        const engine = await this._getEngine(this._dbOf(doc));
        const key = String(doc.key || '');
        const rows = await this._matching(engine, coll, doc.query);
        const seen = new Set();
        const values = [];
        for (const r of rows) {
          // #216：distinct 支持 dot notation，复用 getPath
          const v = getPath(r, key);
          if (v === undefined) continue;
          // ObjectId 与同 hex String 是不同的值：\0 前缀不会与 JSON.stringify 结果冲突
          const dk = v instanceof ObjectId ? '\0oid:' + v.toString() : JSON.stringify(v);
          if (!seen.has(dk)) { seen.add(dk); values.push(v); }
        }
        return { ok: 1, values };
      }
      case 'dropDatabase': {
        const dbName = String(doc.$db || 'test');
        const engine = await this._getEngine(dbName);
        const colls = this._dbCollections.get(dbName);
        if (colls) {
          for (const c of colls) {
            // 同上：await 接住 async dropTable 的 rejection
            try { await engine.dropTable(c); } catch (_) {}
          }
          this._dbCollections.delete(dbName);
        }
        return { ok: 1, dropped: dbName };
      }
      case 'find': {
        const coll = String(doc.find);
        const engine = await this._getEngine(this._dbOf(doc));
        let rows = await this._matching(engine, coll, doc.filter);
        // sort 必须先于 skip/limit：否则分页取到的是存储顺序的页
        if (doc.sort && typeof doc.sort === 'object' && !Array.isArray(doc.sort)) {
          rows = sortRows(rows, doc.sort);
        }
        const skip = typeof doc.skip === 'number' ? doc.skip : 0;
        if (skip > 0) rows = rows.slice(skip);
        const limit = typeof doc.limit === 'number' ? doc.limit : 0;
        // #316：MongoDB 的 find 负 limit 表示「取 |limit| 条并单批返回」。
        // 此前只判断 limit > 0，负值落到「不截断」分支，把整批文档全返回了。
        const effLimit = limit < 0 ? -limit : limit;
        if (effLimit > 0) rows = rows.slice(0, effLimit);
        const projection = doc.projection || doc.fields;
        if (projection) {
          const matcher = (el, cond) => this._elemMatches(el, cond);
          rows = rows.map(r => applyProjection(r, projection, matcher));
        }
        // #278：尊重 batchSize，剩余行留在游标里由 getMore 取
        const batchSize = Number(doc.batchSize) > 0 ? Math.trunc(Number(doc.batchSize)) : 101;
        const ns = `${this._dbOf(doc)}.${coll}`;
        const firstBatch = rows.slice(0, batchSize);
        let cursorId = 0;
        if (rows.length > firstBatch.length) {
          cursorId = this._nextCursorId++;
          this._cursors.set(cursorId, { rows: rows.slice(firstBatch.length), ns, coll, db: this._dbOf(doc), batchSize, lastActive: Date.now(), connId });
        }
        return { ok: 1, cursor: { id: { $long: cursorId }, ns, firstBatch } };
      }
      case 'getMore': {
        const id = this._parseCursorId(doc.getMore);
        const cur = this._cursors.get(id);
        if (!cur) return { ok: 0, errmsg: 'cursor not found', code: 43 };
        // #459：游标与创建它的连接绑定；其他连接 getMore 一律回 cursorNotFound(43)。
        if (cur.connId !== connId) return { ok: 0, errmsg: 'cursor not found', code: 43 };
        // #428：空闲超时后游标已被清扫，再 getMore 回 cursorNotFound(43)。
        if (Date.now() - (cur.lastActive || 0) > this._cursorIdleTimeoutMs) {
          this._cursors.delete(id);
          return { ok: 0, errmsg: 'cursor not found', code: 43 };
        }
        cur.lastActive = Date.now();
        const nextBatch = cur.rows.slice(0, cur.batchSize);
        cur.rows = cur.rows.slice(nextBatch.length);
        let nextId = id;
        if (cur.rows.length === 0) { this._cursors.delete(id); nextId = 0; }
        return { ok: 1, cursor: { id: { $long: nextId }, ns: cur.ns, nextBatch } };
      }
      case 'killCursors': {
        // #428：主动销毁游标。按 MongoDB 口径回
        // cursorsKilled / cursorsNotFound / cursorsAlive / cursorsUnknown。
        const ids = Array.isArray(doc.cursors) ? doc.cursors : [];
        const cursorsKilled = [];
        const cursorsNotFound = [];
        const cursorsAlive = [];
        const cursorsUnknown = [];
        for (const raw of ids) {
          const id = this._parseCursorId(raw);
          if (this._cursors.has(id)) {
            this._cursors.delete(id);
            cursorsKilled.push(raw);
          } else {
            cursorsNotFound.push(raw);
          }
        }
        return { ok: 1, cursorsKilled, cursorsNotFound, cursorsAlive, cursorsUnknown };
      }
      case 'update': {
        const coll = String(doc.update);
        const engine = await this._ensureCollection(coll, this._dbOf(doc));
        let n = 0, nModified = 0;
        const upserted = [];
        const updates = doc.updates || [];
        try {
        for (let ui = 0; ui < updates.length; ui++) {
          const u = updates[ui];
          const q = u.q || {};
          const updateDoc = u.u || {};
          const isModifier = Object.keys(updateDoc).some(k => k.startsWith('$'));
          const multi = u.multi === true;
          const targets = await this._matching(engine, coll, q);
          if (!targets.length && u.upsert) {
            // #224：upsert 时对查询等值字段应用修饰符
            let merged;
            if (isModifier) {
              merged = this._nonDollarQuery(q);
              const eff = u.arrayFilters ? this._expandArrayFilters(updateDoc, u.arrayFilters, merged) : updateDoc;
              applyModifier(merged, eff, { strict: true });
            } else {
              merged = cloneDoc(updateDoc);
            }
            if (merged._id === undefined && q._id !== undefined) merged._id = q._id;
            await engine.insert(coll, merged);
            n++;
            // #427：upsert 单独回 upserted，不计入 nModified
            upserted.push({ index: ui, _id: merged._id });
            continue;
          }
          const applyOne = async (target) => {
            // #414：$[id] 按 arrayFilters 与当前文档展开
            const eff = u.arrayFilters ? this._expandArrayFilters(updateDoc, u.arrayFilters, target) : updateDoc;
            let patched;
            if (isModifier) {
              patched = cloneDoc(target);
              applyModifier(patched, eff, { strict: true });
            } else {
              patched = cloneDoc(eff || {});
              if (target._id !== undefined) patched._id = target._id;
            }
            // #427：只有前后值真的变化才算 modified（no-op 不计）
            const changed = !deepEqualMongo(patched, target)
              || Object.keys(target).some(k => !(k in patched));
            if (isModifier) await this._patchRows(engine, coll, [target], eff);
            else await this._replaceRows(engine, coll, [target], eff);
            n++;
            if (changed) nModified++;
          };
          if (multi) {
            for (const target of targets) await applyOne(target);
          } else if (targets[0]) {
            await applyOne(targets[0]);
          }
        }
        } catch (e) {
          return this._withWriteConcern({ ok: 0, errmsg: e.message, code: 9, n, nModified }, doc);
        }
        const reply = { ok: 1, n, nModified };
        if (upserted.length > 0) reply.upserted = upserted;
        return this._withWriteConcern(reply, doc);
      }
      case 'delete': {
        const coll = String(doc.delete);
        const engine = await this._ensureCollection(coll, this._dbOf(doc));
        let n = 0;
        for (const d of (doc.deletes || [])) {
          const rows = await this._matching(engine, coll, d.q || {});
          // MongoDB delete: limit=1 means delete only one, limit=0 means delete all
          const toDelete = d.limit === 1 ? rows.slice(0, 1) : rows;
          if (toDelete.length > 0) await this._removeRows(engine, coll, toDelete);
          n += toDelete.length;
        }
        return this._withWriteConcern({ ok: 1, n }, doc);
      }
      case 'createIndexes': {
        // #221：登记唯一/普通索引定义，供 insert/update 校验与 listIndexes 返回
        const coll = String(doc.createIndexes);
        const dbName = this._dbOf(doc);
        await this._ensureCollection(coll, dbName);
        const key = dbName + '.' + coll;
        const list = this._indexesByColl.get(key) || [{ name: '_id_', columns: ['_id'], unique: true }];
        // #570：登记前的索引数量，不能硬编码为 1
        const numIndexesBefore = list.length;
        for (const spec of (doc.indexes || [])) {
          const keySpec = spec.key || {};
          const columns = Object.keys(keySpec);
          if (columns.length === 0) continue;
          const name = spec.name || columns.map(c => c + '_1').join('_');
          // #281：保留方向（{a:-1}），listIndexes 原样回包
          const entry = { name, columns, keySpec, unique: !!spec.unique, sparse: !!spec.sparse };
          const at = list.findIndex(i => i.name === name);
          if (at >= 0) list[at] = entry; else list.push(entry);
        }
        this._indexesByColl.set(key, list);
        return { ok: 1, createdCollectionAutomatically: false, numIndexesBefore, numIndexesAfter: list.length };
      }
      case 'listIndexes': {
        const coll = String(doc.listIndexes);
        const dbName = this._dbOf(doc);
        const key = dbName + '.' + coll;
        // #315：对不存在的集合必须按协议报 nsNotFound(26)，
        // 此前兜底塞了一条虚构的 _id_ 索引并回 ok:1，
        // 元数据巡检工具会把不存在的集合误判为「已有 _id_ 索引」。
        if (!this._indexesByColl.has(key) && !(await this._collectionExists(coll, dbName))) {
          return { ok: 0, errmsg: 'ns not found', code: 26 };
        }
        const list = this._indexesByColl.get(key) || [{ name: '_id_', columns: ['_id'], unique: true }];
        const ns = `${dbName}.${coll}`;
        const firstBatch = list.map(i => ({
          v: 2, key: i.keySpec || Object.fromEntries(i.columns.map(c => [c, 1])), name: i.name, ns,
        }));
        return { ok: 1, cursor: { id: { $long: 0 }, ns, firstBatch } };
      }
      case 'dropIndexes': {
        const coll = String(doc.dropIndexes);
        const key = this._dbOf(doc) + '.' + coll;
        const list = this._indexesByColl.get(key) || [];
        const spec = doc.index;
        if (spec === '*') {
          this._indexesByColl.set(key, [{ name: '_id_', columns: ['_id'], unique: true }]);
        } else {
          const name = typeof spec === 'string' ? spec : Object.keys(spec || {}).map(c => c + '_' + (spec[c] < 0 ? '-1' : '1')).join('_');
          this._indexesByColl.set(key, list.filter(i => i.name !== name));
        }
        return { ok: 1, nIndexesWas: list.length };
      }
      case 'count': {
        const coll = String(doc.count);
        const engine = await this._getEngine(this._dbOf(doc));
        let rows = await this._matching(engine, coll, doc.query);
        // #280：count 也要尊重 skip
        const skip = typeof doc.skip === 'number' && doc.skip > 0 ? Math.trunc(doc.skip) : 0;
        if (skip > 0) rows = rows.slice(skip);
        const limit = Number(doc.limit) > 0 ? Math.trunc(Number(doc.limit)) : 0;
        return { ok: 1, n: limit > 0 ? Math.min(rows.length, limit) : rows.length };
      }
      case 'countDocuments': {
        // 官方驱动的 collection.countDocuments() 发送此命令；filter 字段名与 count 的 query 不同。
        const coll = String(doc.countDocuments);
        const engine = await this._getEngine(this._dbOf(doc));
        let rows = await this._matching(engine, coll, doc.filter);
        const skip = typeof doc.skip === 'number' && doc.skip > 0 ? Math.trunc(doc.skip) : 0;
        if (skip > 0) rows = rows.slice(skip);
        const limit = Number(doc.limit) > 0 ? Math.trunc(Number(doc.limit)) : 0;
        return { ok: 1, n: limit > 0 ? Math.min(rows.length, limit) : rows.length };
      }
      case 'aggregate': {
        const coll = String(doc.aggregate);
        const engine = await this._getEngine(this._dbOf(doc));
        try {
          const rows = await this._runPipeline(await this._safeFind(engine, coll), doc.pipeline || [], doc, connId);
          return { ok: 1, cursor: { id: { $long: 0 }, ns: `${this._dbOf(doc)}.${coll}`, firstBatch: rows } };
        } catch (e) {
          if (e && e.code === 40324) return { ok: 0, errmsg: e.message, code: 40324 };
          throw e;
        }
      }
      default:
        // #222：未知命令必须按协议返回 CommandNotFound，而不是伪成功
        return { ok: 0, errmsg: `no such command: ${String(cmd)}`, code: 59 };
    }
  }

  /** 执行聚合管道；$lookup 子管道复用同一实现 */
  async _runPipeline(rows, pipeline, doc, connId, vars) {
    const STAGES = new Set(['$match', '$count', '$limit', '$skip', '$sort', '$project', '$unwind', '$lookup', '$group', '$addFields', '$set']);
    for (const stage of pipeline) {
      const stageName = Object.keys(stage || {})[0];
      if (!STAGES.has(stageName)) {
        const e = new Error(`Unrecognized pipeline stage name: '${stageName}'`);
        e.code = 40324;
        throw e;
      }
      if (stage.$match) rows = rows.filter((r) => this._match(r, stage.$match, vars));
      else if (stage.$count) rows = [{ [stage.$count]: rows.length }];
      else if (stage.$limit) rows = rows.slice(0, stage.$limit);
      else if (stage.$skip) rows = rows.slice(Number(stage.$skip) || 0);
      else if (stage.$sort) {
        rows = sortRows(rows, stage.$sort);
      }
      else if (stage.$project) {
        const plain = {};
        const exprFields = {};
        for (const [k, v] of Object.entries(stage.$project)) {
          if (v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof ObjectId)) exprFields[k] = v;
          else plain[k] = v;
        }
            const matcher = (el, cond) => this._elemMatches(el, cond);
            rows = rows.map((r) => {
              const out = applyProjection(r, plain, matcher);
              for (const [k, e] of Object.entries(exprFields)) setPath(out, k, evalMongoExpr(e, r, vars));
              return out;
            });
      }
      else if (stage.$addFields || stage.$set) {
        // #328：$addFields 是 MongoDB 4.2 起的标准 stage，$set 是它的别名。
        // 之前只列在 doc/mongodb.md 的支持表里，实现里没有分支，v6.8.21 把未知 stage
        // 改成显式 40324 之后，按文档写管道的用户会直接失败。
        const spec = stage.$addFields || stage.$set;
        rows = rows.map((r) => {
              const out = Object.assign({}, r);
              for (const [k, e] of Object.entries(spec || {})) setPath(out, k, evalMongoExpr(e, r, vars));
              return out;
        });
      }
      else if (stage.$unwind) {
        const cfg = typeof stage.$unwind === 'string'
          ? { path: stage.$unwind }
          : (stage.$unwind || {});
        const field = String(cfg.path || '').replace(/^\$/, '');
        const preserve = cfg.preserveNullAndEmptyArrays === true;
        // #571：includeArrayIndex 把数组下标写入输出文档；非数组/空数组为 null
        const idxField = typeof cfg.includeArrayIndex === 'string' && cfg.includeArrayIndex
          ? cfg.includeArrayIndex : null;
        const out = [];
        const pushNoIndex = (r) => {
          const nr = cloneDoc(r);
          if (idxField) setPath(nr, idxField, null);
          out.push(nr);
        };
        for (const r of rows) {
          const arr = getPath(r, field);
          // #282：非数组标量按单元素数组展开（保留文档），缺失/NULL 才按 preserve 处理
          if (!Array.isArray(arr)) {
            if (arr === undefined || arr === null) { if (preserve) pushNoIndex(r); continue; }
            pushNoIndex(r);
            continue;
          }
          if (arr.length === 0) {
            if (preserve) pushNoIndex(r);
            continue;
          }
          for (let i = 0; i < arr.length; i++) {
            const nr = cloneDoc(r);
            setPath(nr, field, cloneDoc(arr[i]));
            if (idxField) setPath(nr, idxField, i);
            out.push(nr);
          }
        }
        rows = out;
      }
      else if (stage.$lookup) {
        const cfg = stage.$lookup || {};
        const from = String(cfg.from || '');
        const localField = String(cfg.localField || '');
        const foreignField = String(cfg.foreignField || '');
        const as = String(cfg.as || '');
        const hasPipeline = Array.isArray(cfg.pipeline) && cfg.pipeline.length > 0;
        if (!from || !as || (!hasPipeline && (!localField || !foreignField))) {
          throw new Error('$lookup requires from, as and (localField/foreignField or pipeline)');
        }
        const foreignEngine = await this._ensureCollection(from, this._dbOf(doc));
        const foreignRows = await foreignEngine.find(from, {});
        // 子管道逐外层文档执行；let 变量按当前外层文档求值后注入作用域
        rows = await Promise.all(rows.map(async (r) => {
          let candidates = foreignRows;
          const lv = getPath(r, localField);
          if (localField && foreignField) {
            const locals = Array.isArray(lv) ? lv : [lv];
            candidates = foreignRows.filter(fr =>
              orAnyElement(getPath(fr, foreignField), el => locals.some(l => valuesEqual(l, el))));
          }
          let matched = candidates;
          if (hasPipeline) {
            const scope = { ...(vars || {}) };
            if (cfg.let && typeof cfg.let === 'object') {
              for (const [k, v] of Object.entries(cfg.let)) {
                scope[k] = evalMongoExpr(v, r, vars);
              }
            }
            matched = await this._runPipeline(candidates, cfg.pipeline, doc, connId, scope);
            if (!Array.isArray(matched)) matched = [];
          }
          const nr = cloneDoc(r);
          setPath(nr, as, matched.map(fr => cloneDoc(fr)));
          return nr;
        }));
      }
      else if (stage.$group) {
        const groups = new Map();
        const groupDef = stage.$group;
        // Pass 1: bucket all rows into groups
        for (const row of rows) {
          let gk;
              if (groupDef._id !== undefined) {
                // #410：对象形态 _id 是表达式对象，逐行求值（含嵌套 $ 引用）
                gk = evalMongoObject(groupDef._id, row, vars);
              } else {
            // no explicit _id: use the row's _id if it's a real user-set value,
            // not a numeric auto-generated one (auto-ids start at 1,2,...N)
            gk = row._id;
          }
              // 规范键：同字节 ObjectId 归并同组；对象按内容归并（#410）
              const gkey = groupKeyOf(gk);
              if (!groups.has(gkey)) groups.set(gkey, { v: gk, rows: [] });
              groups.get(gkey).rows.push(row);
        }
        // Pass 2: compute accumulators per group
        const out = [];
        for (const [, g] of groups) {
          const grow = g.rows;
          const doc = { _id: g.v };
          for (const [k, v] of Object.entries(groupDef)) {
            if (k === '_id' || v == null) continue;
            if (typeof v === 'object') {
              // $sum, $avg, $min, $max, $first, $last, $push, $addToSet
              // #312：$push / $addToSet 此前完全没实现 —— 累加器对象落到
              // 取值链之外，doc[k] 从未被赋值，整个数组列静默缺失。
              const acc = v.$sum ?? v.$avg ?? v.$min ?? v.$max ?? v.$first ?? v.$last
                ?? v.$push ?? v.$addToSet;
              if (acc !== undefined) {
                const isNumeric = v.$sum !== undefined || v.$avg !== undefined;
                if (typeof acc === 'number') {
                  // literal: $sum:1 (count) or $avg:3
                  if (v.$sum !== undefined) doc[k] = grow.length;
                  else if (v.$avg !== undefined) doc[k] = (doc[k] || 0) + acc;
                } else if (typeof acc === 'string' && acc.startsWith('$')) {
                  const field = acc.slice(1);
                  if (v.$push !== undefined) {
                    // 数组累加器：按组内文档顺序收集该字段值（MongoDB 语义）
                    doc[k] = grow.map(r => getPath(r, field));
                  } else if (v.$addToSet !== undefined) {
                    // 去重收集：按值深相等去重，保持首次出现顺序
                    const seen = [];
                    for (const r of grow) {
                      const val = getPath(r, field);
                      if (!seen.some(x => deepEqualMongo(x, val))) seen.push(val);
                    }
                    doc[k] = seen;
                  } else if (v.$sum !== undefined) {
                    const sum = grow.reduce((s, r) => s + (Number(getPath(r, field)) || 0), 0);
                    doc[k] = (doc[k] || 0) + sum;
                  } else if (v.$avg !== undefined) {
                    // Issue #45：null/undefined 不计入分子的同时也不计入分母；
                    // 全空组返回 null（MongoDB 语义），而不是 0。
                    const vals = grow
                      .map(r => getPath(r, field))
                      .filter(x => x !== null && x !== undefined)
                      .map(Number)
                      .filter(x => !Number.isNaN(x));
                    doc[k] = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
                  } else if (v.$min !== undefined) {
                    const vals = grow.map(r => getPath(r, field)).filter(v => v != null);
                    let best = null;
                    for (const x of vals) if (best === null || x < best) best = x;
                    doc[k] = best;
                  } else if (v.$max !== undefined) {
                    const vals = grow.map(r => getPath(r, field)).filter(v => v != null);
                    let best = null;
                    for (const x of vals) if (best === null || x > best) best = x;
                    doc[k] = best;
                  } else if (v.$first !== undefined) {
                    doc[k] = grow[0] ? getPath(grow[0], field) : null;
                  } else if (v.$last !== undefined) {
                    doc[k] = grow[grow.length - 1] ? getPath(grow[grow.length - 1], field) : null;
                  }
                }
              }
            } else if (typeof v === 'string' && v.startsWith('$')) {
              // direct field reference as accumulator value
              const field = v.slice(1);
              if (!doc.hasOwnProperty(k)) doc[k] = grow[0] ? getPath(grow[0], field) : null;
            }
          }
          out.push(doc);
        }
        rows = out;
      }
    }    return rows;
  }

  _idOf(row) {
    return row._id != null ? row._id : row.id;
  }

  /** #568：读路径遇到不存在的表返回空结果，而不是抛 Table doesn't exist */
  async _safeFind(engine, coll) {
    try {
      return await engine.find(coll, {});
    } catch (e) {
      if (/doesn't exist|does not exist|not found/i.test(String(e && e.message))) return [];
      throw e;
    }
  }

  async _matching(engine, coll, filter) {
    const rows = await this._safeFind(engine, coll);
    return rows.filter((r) => this._match(r, filter || {}));
  }

  _rowKey(engine, coll, row) {
    const table = engine._tables && engine._tables[coll];
    const pk = table && (table._primaryKey || table._autoIncrementField);
    // 有主键用主键值；Mongo 自建集合没有主键，传行对象走深度匹配
    return pk ? row[pk] : { ...row };
  }

  async _patchRows(engine, coll, rows, updateDoc) {
    const entries = [];
    const hasModifier = Object.keys(updateDoc || {}).some(k => k.startsWith('$'));
    for (const r of rows) {
      const key = this._rowKey(engine, coll, r);
      if (key === undefined) continue;
      if (!hasModifier) {
        entries.push([key, { ...updateDoc }]);
        continue;
      }
      // 完整深拷贝后应用运算符，避免嵌套对象被原地污染；未知运算符显式报错
      const doc = cloneDoc(r);
      applyModifier(doc, updateDoc, { strict: true });
      // updateByIds 是 Object.assign 合并：被 $unset 删除的顶层字段需显式置 undefined
      for (const k of Object.keys(r)) if (!(k in doc)) doc[k] = undefined;
      this._checkUniqueIndexes(engine, coll, doc, r);
      entries.push([key, doc]);
    }
    if (entries.length > 0) {
      await engine.updateByIds(coll, entries);
      // #223：$unset 必须真正删除键，不能留 undefined（BSON 会编码成 null）
      const table = engine._tables && engine._tables[coll];
      if (table && Array.isArray(table._rows)) {
        for (const row of table._rows) {
          for (const k of Object.keys(row)) if (row[k] === undefined) delete row[k];
        }
      }
    }
  }

  /** #218：replacement 语义 —— 整体替换文档，只保留 _id */
  async _replaceRows(engine, coll, rows, replacement) {
    const ids = [];
    const docs = [];
    for (const r of rows) {
      const key = this._rowKey(engine, coll, r);
      if (key === undefined) continue;
      const d = cloneDoc(replacement || {});
      if (r._id !== undefined) d._id = r._id;
      this._checkUniqueIndexes(engine, coll, d, r);
      ids.push(key);
      docs.push(d);
    }
    if (ids.length === 0) return;
    await engine.removeByIds(coll, ids);
    for (const d of docs) await engine.insert(coll, d);
  }

  /** #414：$[identifier] 按 arrayFilters 匹配到的数组下标展开为具体路径 */
  _expandArrayFilters(updateDoc, arrayFilters, target) {
    const filters = new Map();
    for (const f of (Array.isArray(arrayFilters) ? arrayFilters : [])) {
      for (const [k, v] of Object.entries(f || {})) filters.set(k, v);
    }
    const matchEl = (el, cond, idx) => {
      // 纯非负整数条件按数组下标定位（issue #414 的 {i:0} 形态）；
      // 操作符条件按元素值匹配。
      if (typeof cond === 'number' && Number.isInteger(cond) && cond >= 0) return idx === cond;
      const isOp = cond && typeof cond === 'object' && !Array.isArray(cond) && !(cond instanceof ObjectId)
        && Object.keys(cond).some(k => k.startsWith('$'));
      return isOp ? this._fieldMatch(el, cond) : valuesEqual(el, cond);
    };
    const out = {};
    for (const [mod, spec] of Object.entries(updateDoc || {})) {
      if (!spec || typeof spec !== 'object' || Array.isArray(spec)) { out[mod] = spec; continue; }
      const expanded = {};
      let hasPositional = false;
      for (const [path, val] of Object.entries(spec)) {
        const m = String(path).match(/^(.*)\.\$\[([A-Za-z_$][A-Za-z0-9_$]*)\](.*)$/);
        if (!m || !filters.has(m[2])) { expanded[path] = val; continue; }
        hasPositional = true;
        const arr = getPath(target, m[1]);
        if (!Array.isArray(arr)) continue;
        for (let i = 0; i < arr.length; i++) {
          if (matchEl(arr[i], filters.get(m[2]), i)) expanded[m[1] + '.' + i + m[3]] = val;
        }
      }
      out[mod] = hasPositional ? expanded : spec;
    }
    return out;
  }

  _nonDollarQuery(q) {
    const out = {};
    for (const [k, v] of Object.entries(q || {})) if (!k.startsWith('$')) out[k] = v;
    return out;
  }

  /** #221：写入/更新前按二级唯一索引查重 */
  _checkUniqueIndexes(engine, coll, doc, excludeRow) {
    let defs = [];
    for (const [key, list] of this._indexesByColl) {
      if (key.endsWith('.' + coll)) defs = defs.concat(list.filter(ix => ix.unique && ix.name !== '_id_'));
    }
    if (defs.length === 0) return;
    const table = engine && engine._tables && engine._tables[coll];
    if (!table || !Array.isArray(table._rows)) return;
    for (const ix of defs) {
      if (ix.columns.some(c => getPath(doc, c) === undefined || getPath(doc, c) === null)) continue;
      for (const row of table._rows) {
        if (row === excludeRow) continue;
        if (ix.columns.every(c => deepEqualMongo(getPath(row, c), getPath(doc, c)))) {
          const err = new Error(`E11000 duplicate key error collection: ${coll} index: ${ix.name} dup key: ${JSON.stringify(Object.fromEntries(ix.columns.map(c => [c, getPath(doc, c)])))}`);
          err.code = 11000;
          err.keyPattern = Object.fromEntries(ix.columns.map(c => [c, 1]));
          throw err;
        }
      }
    }
  }

  /** #428：清扫超过空闲超时仍未被 getMore 访问的游标，释放结果集快照。 */
  _sweepIdleCursors() {
    const now = Date.now();
    for (const [id, cur] of this._cursors) {
      if (now - (cur.lastActive || 0) > this._cursorIdleTimeoutMs) this._cursors.delete(id);
    }
  }

  /** 解析游标 id（兼容 number / `$long` / `$numberLong` 标记）。 */
  _parseCursorId(raw) {
    if (raw && typeof raw === 'object') {
      return Number(raw.$long ?? raw.$numberLong ?? raw.low ?? 0);
    }
    return Number(raw || 0);
  }

  async _removeRows(engine, coll, rows) {
    // 收集所有需要删除的行的 id，走 engine.removeByIds
    // 这样会写 WAL、触发 hooks、检查约束
    const ids = [];
    for (const r of rows) {
      const key = this._rowKey(engine, coll, r);
      if (key !== undefined) ids.push(key);
    }
    if (ids.length > 0) await engine.removeByIds(coll, ids);
  }

  /** $elemMatch 单元素求值：对象元素按子文档匹配；标量/数组元素只在操作符条件下可能命中 */
  _elemMatches(el, cond) {
    if (el !== null && typeof el === 'object' && !Array.isArray(el)) return this._match(el, cond);
    // 标量元素：{$elemMatch:{$gt:5}} 这类操作符条件包成 {_val: el} 求值；
    // {$elemMatch:{k:1}} 这类子文档条件对标量元素恒为 false。
    if (!cond || typeof cond !== 'object' || Array.isArray(cond)) return false;
    const keys = Object.keys(cond);
    return keys.length > 0 && keys.every(c => c[0] === '$')
      && this._match({ _val: el }, { _val: cond });
  }

  // 单个字段值的操作符求值；$not 递归取反。返回 false 表示不匹配。
  _fieldMatch(rv, cond) {
    if (cond && typeof cond === 'object' && !Array.isArray(cond) && !(cond instanceof ObjectId)) {
      const keys = Object.keys(cond);
      // 零枚举键对象（Date 等）是「值」不是条件：落进下面的操作符循环会
      // 一次都不执行、vacuous 返回 true —— {d: <Date>} 匹配全表（update/delete
      // 同路径）。按值相等处理。
      if (keys.length === 0) return orAnyElement(rv, el => valuesEqual(el, cond));
      // #219：条件是不含任何 $ 运算符的普通子文档时，按整文档深相等匹配
      if (keys.every(k => k[0] !== '$')) {
        return deepEqualMongo(rv, cond);
      }
    }
    for (const [op, v] of Object.entries(cond)) {
      if (op === '$not') { if (this._fieldMatch(rv, v)) return false; continue; }
      if (op === '$options') continue;
      // 等值/$in/$regex 家族带 Mongo 数组语义（任一元素命中即匹配），
      // $ne/$nin 是取反；范围操作符 null/缺失永不命中，数组只按元素比。
      if (op === '$eq' && !orAnyElement(rv, el => valuesEqual(el, v))) return false;
      if (op === '$ne' && orAnyElement(rv, el => valuesEqual(el, v))) return false;
      if (op === '$gt' && !anyElementRange(rv, el => el > v)) return false;
      if (op === '$gte' && !anyElementRange(rv, el => el >= v)) return false;
      if (op === '$lt' && !anyElementRange(rv, el => el < v)) return false;
      if (op === '$lte' && !anyElementRange(rv, el => el <= v)) return false;
      if (op === '$in' && !(Array.isArray(v) && orAnyElement(rv, el => arrayIncludesValue(v, el)))) return false;
      if (op === '$nin' && !(Array.isArray(v) && !orAnyElement(rv, el => arrayIncludesValue(v, el)))) return false;
      if (op === '$exists' && (v ? (rv === undefined) : (rv !== undefined))) return false;
      // 空 target 恒不匹配（[].every() vacuous true 的陷阱，PR #122 修复在合并中丢失）
      if (op === '$all' && !(Array.isArray(v) && v.length > 0 && v.every(t => orAnyElement(rv, el => valuesEqual(el, t))))) return false;
      if (op === '$regex') {
        // #217：$options 支持 i/m/s/x，全部映射到 JS RegExp 标志
        const opt = String(cond.$options || '');
        const flags = [...new Set(opt.match(/[ims]/g) || [])].join('');
        let pat = String(v);
        if (opt.includes('x')) pat = pat.replace(/\s+/g, '');
        const re = new RegExp(pat, flags);
        if (!orAnyElement(rv, el => typeof el === 'string' && re.test(el))) return false;
      }
      if (op === '$type') {
        if (v === 'objectId') { if (!(rv instanceof ObjectId)) return false; continue; }
        // #220：按 BSON 类型判别，不能直接用 typeof（数组/null 永远对不上）
        const actual = bsonTypeOf(rv);
        const wanted = String(v).toLowerCase();
        const aliases = {
          bool: 'bool', boolean: 'bool',
          int: 'number', long: 'number', double: 'number', number: 'number',
          null: 'null', array: 'array', object: 'object',
          string: 'string', date: 'date', objectid: 'objectId',
        };
        if (actual !== (aliases[wanted] || wanted)) return false;
      }
      if (op === '$size' && !(Array.isArray(rv) && rv.length === v)) return false;
      // #565：$mod [divisor, remainder] 匹配 rv % divisor === remainder
      if (op === '$mod') {
        const div = Array.isArray(v) ? Number(v[0]) : NaN;
        const rem = Array.isArray(v) ? Number(v[1]) : NaN;
        if (!Number.isFinite(div) || div === 0 || !Number.isFinite(rem)) return false;
        if (!orAnyElement(rv, el => Number(el) % div === rem)) return false;
      }
      if (op === '$elemMatch' && !(Array.isArray(rv) && rv.some((el) => this._elemMatches(el, v)))) return false;
    }
    return true;
  }

  _match(row, filter, vars) {
    for (const [k, cond] of Object.entries(filter || {})) {
      if (k === '$or') {
        if (!cond.some((f) => this._match(row, f, vars))) return false;
        continue;
      }
      if (k === '$and') {
        if (!cond.every((f) => this._match(row, f, vars))) return false;
        continue;
      }
      if (k === '$nor') {
        if (cond.some((f) => this._match(row, f, vars))) return false;
        continue;
      }
      if (k === '$not') {
        if (this._match(row, cond, vars)) return false;
        continue;
      }
      if (k === '$expr') {
        // #409：顶层 $expr 走聚合表达式求值，而不是按字段名取列
        if (!evalMongoExpr(cond, row, vars)) return false;
        continue;
      }
      const rv = getPath(row, k);
      // ObjectId 是值不是操作符对象：typeof 'object' 但无枚举键，会 vacuous 匹配全表
      if (cond && typeof cond === 'object' && !Array.isArray(cond) && !(cond instanceof ObjectId)) {
        if (!this._fieldMatch(rv, cond)) return false;
      } else if (!orAnyElement(rv, (el) => valuesEqual(el, cond))) {
        return false;
      }
    }
    return true;
  }

  get address() {
    return this._server ? this._server.address() : null;
  }

  close(cb) {
    if (this._cursorTimer) { clearInterval(this._cursorTimer); this._cursorTimer = null; }
    for (const s of this._sockets) s.destroy();
    const done = () => {
      if (this._server) { this._server.close(cb || (() => {})); this._server = null; }
      else if (cb) cb();
    };
    const engines = new Set(this._engineByDb ? this._engineByDb.values() : []);
    if (this._engine) engines.add(this._engine);
    const stops = [];
    for (const e of engines) if (e && typeof e.stop === 'function') stops.push(e.stop());
    if (stops.length > 0) Promise.allSettled(stops).then(done).catch(done);
    else done();
    return this;
  }
}

function createMongoServer(options) {
  return new MongoServer(options || {});
}

module.exports = { MongoServer, createMongoServer, bsonDocument, bsonReadDocument, crc32c };