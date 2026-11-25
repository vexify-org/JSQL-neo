/**
 * BSON ObjectId — 一等 JS 值。
 *
 * 此前 BSON 解码把 0x07 直接转成 hex 字符串，类型信息在协议边界就丢了：
 * 同一 24-hex 的 ObjectId 与 String 在真实 MongoDB 里是两个不同的键，
 * 这里却会碰撞，insert 时第二篇文档被静默丢弃（insertMany ordered:false
 * 也不报 writeErrors）。
 *
 * 全库的相等判断都是严格 ===（table._matchRow / _matchOperator /
 * mongo_server._match / _id 查重扫描），所以跨实例的同字节 ObjectId
 * 必须经 valuesEqual() 比较；两个相同字节的实例永远不该用 === 判等。
 * 排序比较（< >）走 Symbol.toPrimitive → hex 字符串，字典序即字节序。
 */

const crypto = require('crypto');

const HEX_RE = /^[0-9a-f]{24}$/;

class ObjectId {
  constructor(input) {
    if (typeof input === 'string') {
      const hex = input.toLowerCase();
      if (!HEX_RE.test(hex)) throw new Error(`Invalid ObjectId string: '${input}'`);
      this._bytes = Buffer.from(hex, 'hex');
    } else if (Buffer.isBuffer(input)) {
      if (input.length !== 12) throw new Error(`Invalid ObjectId byte length: ${input.length}`);
      this._bytes = Buffer.from(input);
    } else if (input instanceof ObjectId) {
      this._bytes = Buffer.from(input._bytes);
    } else {
      throw new Error('ObjectId expects a 24-char hex string or 12-byte Buffer');
    }
    this._hex = null;
  }

  get bytes() {
    return this._bytes;
  }

  toString() {
    if (this._hex === null) this._hex = this._bytes.toString('hex');
    return this._hex;
  }

  equals(other) {
    return other instanceof ObjectId && this.toString() === other.toString();
  }

  // legacy 单文件 JSON 落盘 / 日志输出时保住值本身（hex），类型信息不保证
  toJSON() {
    return this.toString();
  }

  [Symbol.toPrimitive](hint) {
    return this.toString();
  }

  static fromBytes(buf) {
    return new ObjectId(buf);
  }

  static fromHex(hex) {
    return new ObjectId(hex);
  }

  /**
   * 生成新 ObjectId（#430：insert 缺省 `_id` 时服务端兜底）。
   * 布局遵循 BSON ObjectId 规范：4 字节大端秒级时间戳 + 5 字节随机 + 3 字节递增计数器。
   */
  static generate() {
    const bytes = Buffer.alloc(12);
    bytes.writeUInt32BE(Math.floor(Date.now() / 1000), 0);
    crypto.randomBytes(5).copy(bytes, 4);
    ObjectId._counter = ((ObjectId._counter ?? Math.floor(Math.random() * 0xffffff)) + 1) & 0xffffff;
    bytes.writeUIntBE(ObjectId._counter, 9, 3);
    return new ObjectId(bytes);
  }
}

/**
 * 严格 === 语义的 ObjectId / Date / Buffer / 数组扩展：
 *   同字节 ObjectId 相等；ObjectId 与 String 永不相等（这正是本修复点）；
 *   Date 按 getTime() 相等；Buffer 按字节内容相等（a.equals）；
 *   数组逐元素递归（长度先比）——{a:[1,2]} 整数组等值 / $in:[[$elem]] /
 *   $ne / $all 全靠这一处。shortcut: 数组内嵌套普通对象仍是引用严格相等，
 *   需要子文档深度等值时再升级（wire 端子文档条件已由 deepEqualMongo 覆盖）。
 *   热路径先走 ===，标量零额外开销。
 */
function valuesEqual(a, b) {
  if (a === b) return true;
  if (a instanceof ObjectId && b instanceof ObjectId) return a.equals(b);
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  if (Buffer.isBuffer(a) && Buffer.isBuffer(b)) return a.equals(b);
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((x, i) => valuesEqual(x, b[i]));
  }
  return false;
}

/** $in/$nin：普通值用 includes 快路径，未命中再走 valuesEqual（ObjectId 按字节、
 *  Date/Buffer/数组按内容——$in: [[1,2]] 这类整数组元素靠这里）。 */
function arrayIncludesValue(arr, v) {
  if (arr.includes(v)) return true;
  for (const t of arr) if (valuesEqual(t, v)) return true;
  return false;
}

/**
 * Mongo 数组字段语义（table.js / mongo_server.js 共用）：
 * 标量条件在字段值本身命中，或数组字段时任一元素命中，都算匹配。
 * {tags: "a"} / {$in} / {$eq} / {$regex} 走这条；$ne/$nin 是它的取反。
 */
function orAnyElement(value, pred) {
    if (Array.isArray(value)) return pred(value) || value.some(pred);
    return pred(value);
}

/**
 * Mongo 范围语义：null/缺失永不参与比较（JS 的 null > -1 是 true，属
 * 强制转换陷阱）；数组字段只按元素比较（数组整体的 >/< 是字符串拼接
 * 后的比较，无意义）。
 */
function anyElementRange(value, pred) {
    if (value === null || value === undefined) return false;
    if (Array.isArray(value)) return value.some(el => el !== null && el !== undefined && pred(el));
    return pred(value);
}

/**
 * Map/Set 的规范键：同字节 ObjectId 归并为同一键，且不与任何真实 BSON
 * 字符串冲突 —— BSON 的 cstring/string 以 \0 结尾，wire 上不可能出现含
 * \0 的字符串，'\0oid:' 前缀因此对 String 值是安全命名空间。
 */
function mapKey(v) {
  return v instanceof ObjectId ? '\0oid:' + v.toString() : v;
}

module.exports = { ObjectId, valuesEqual, arrayIncludesValue, mapKey, orAnyElement, anyElementRange };
