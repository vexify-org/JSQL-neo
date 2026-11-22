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
    const name = Buffer.from(k, 'utf8');
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
    if (v && v.$long !== undefined) {
      const b = Buffer.alloc(8);
      b.writeBigInt64LE(BigInt(Math.trunc(Number(v.$long))), 0);
      body = Buffer.concat([body, Buffer.from([0x12]), name, Buffer.from([0]), b]);
      continue;
    }
    if (typeof v === 'boolean') {
      body = Buffer.concat([body, Buffer.from([0x08]), name, Buffer.from([0]), Buffer.from([v ? 1 : 0])]);
      continue;
    }
    if (typeof v === 'string') {
      const str = Buffer.from(v, 'utf8');
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
    const name = buf.toString('utf8', pos, nameEnd);
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
      const v = buf.toString('utf8', pos, pos + len - 1);
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
    case 0x10: { return { value: buf.readInt32LE(pos), pos: pos + 4 }; }
    case 0x11: { return { value: Number(buf.readBigInt64LE(pos)), pos: pos + 8 }; }
    case 0x12: { return { value: Number(buf.readBigInt64LE(pos)), pos: pos + 8 }; }
    case 0x13: { return { value: buf.readDoubleLE(pos + 1), pos: pos + 17 }; }
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

function applyProjection(doc, spec) {
  if (!spec || typeof spec !== 'object') return doc;
  const entries = Object.entries(spec);
  const inclusion = entries.filter(([k, v]) => k !== '_id' && !!v);
  const exclusion = entries.filter(([k, v]) => k !== '_id' && !v);
  if (inclusion.length && exclusion.length) {
    throw new Error('Cannot do inclusion and exclusion in the same projection (except _id)');
  }
  if (inclusion.length) {
    const out = {};
    if (spec._id === undefined || !!spec._id) {
      const id = getPath(doc, '_id');
      if (id !== undefined) setPath(out, '_id', id);
    }
    for (const [k] of inclusion) {
      const v = getPath(doc, k);
      if (v !== undefined) setPath(out, k, cloneDoc(v));
    }
    return out;
  }
  const out = cloneDoc(doc);
  for (const [k] of exclusion) unsetPath(out, k);
  if (spec._id === 0 || spec._id === false) unsetPath(out, '_id');
  return out;
}

/* ------------------------------------------------------------------ */
/* 聚合表达式求值（$project 派生字段）                                 */
/* ------------------------------------------------------------------ */

function evalMongoExpr(expr, doc) {
  if (expr === null || typeof expr !== 'object') {
    if (typeof expr === 'string' && expr.startsWith('$')) return getPath(doc, expr.slice(1));
    return expr;
  }
  if (Array.isArray(expr)) return expr.map(x => evalMongoExpr(x, doc));
  const args = (v) => (Array.isArray(v) ? v : [v]);
  let result = expr;
  for (const [op, arg] of Object.entries(expr)) {
    switch (op) {
      case '$literal': result = arg; break;
      case '$toUpper': result = String(evalMongoExpr(arg, doc)).toUpperCase(); break;
      case '$toLower': result = String(evalMongoExpr(arg, doc)).toLowerCase(); break;
      case '$add': result = args(arg).reduce((s, x) => s + (Number(evalMongoExpr(x, doc)) || 0), 0); break;
      case '$subtract': { const a = args(arg); result = (Number(evalMongoExpr(a[0], doc)) || 0) - (Number(evalMongoExpr(a[1], doc)) || 0); break; }
      case '$multiply': result = args(arg).reduce((s, x) => s * (Number(evalMongoExpr(x, doc)) || 0), 1); break;
      case '$divide': { const a = args(arg); result = (Number(evalMongoExpr(a[0], doc)) || 0) / (Number(evalMongoExpr(a[1], doc)) || 1); break; }
      case '$concat': result = args(arg).map(x => String(evalMongoExpr(x, doc))).join(''); break;
      case '$abs': result = Math.abs(Number(evalMongoExpr(arg, doc)) || 0); break;
      case '$cond': { const c = args(arg); result = evalMongoExpr(c[0], doc) ? evalMongoExpr(c[1], doc) : evalMongoExpr(c[2], doc); break; }
      case '$ifNull': { const c = args(arg); const v = evalMongoExpr(c[0], doc); result = v === null || v === undefined ? evalMongoExpr(c[1], doc) : v; break; }
      default: return expr;
    }
  }
  return result;
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
    this._autoCollections = new Set(); // db.collection 由 Mongo 自动建表（可继续补列）
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
      engine.createTable(name, defs);
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
        const reply = await this._dispatch(command, body);
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
    const msgEnd = (flags & 1) ? msg.length - 4 : msg.length; // checksumPresent
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
    const reply = await this._dispatch(command, body);
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
      const origOp = msg.readInt32LE(16);
      const uncompSize = msg.readInt32LE(20);
      const compId = msg[24];
      const data = msg.slice(25);
      let out;
      if (compId === 2) out = zlib.inflateSync(data);          // zlib
      else if (compId === 3) { /* zstd 无内置支持 */ return null; }
      else if (compId === 1) { /* snappy 无内置支持 */ return null; }
      else return null;
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

  async _dispatch(cmd, doc) {

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
      case 'getParameter': return { ok: 1 };
      case 'endSessions': return { ok: 1 };
      case 'listDatabases': {
        // P3-17: listDatabases 只返回当前库——返回所有数据库
        const engine = await this._getEngine(this._dbOf(doc));
        const dbs = Object.keys(engine._meta && engine._meta.databases ? engine._meta.databases : { [this._dbOf(doc)]: 1 });
        const databases = Object.keys(dbs).map(name => ({ name, sizeOnDisk: 1, empty: false }));
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
          engine.dropTable(String(doc.drop));
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
        return reply;
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
        return { ok: 1, value, lastErrorObject: { n: found ? 1 : (doc.upsert ? 1 : 0), updatedExisting: !!found && !doc.remove } };
      }
      case 'distinct': {
        const coll = String(doc.distinct);
        const engine = await this._ensureCollection(coll, this._dbOf(doc));
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
            try { engine.dropTable(c); } catch (_) {}
          }
          this._dbCollections.delete(dbName);
        }
        return { ok: 1, dropped: dbName };
      }
      case 'find': {
        const coll = String(doc.find);
        const engine = await this._ensureCollection(coll, this._dbOf(doc));
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
        if (projection) rows = rows.map(r => applyProjection(r, projection));
        return { ok: 1, cursor: { id: { $long: 0 }, ns: `${this._dbOf(doc)}.${coll}`, firstBatch: rows } };
      }
      case 'getMore':
        return { ok: 1, cursor: { id: { $long: 0 }, ns: String(doc.collection || ''), nextBatch: [] } };
      case 'update': {
        const coll = String(doc.update);
        const engine = await this._ensureCollection(coll, this._dbOf(doc));
        let n = 0;
        const updates = doc.updates || [];
        try {
        for (const u of updates) {
          const q = u.q || {};
          const updateDoc = u.u || {};
          const isModifier = Object.keys(updateDoc).some(k => k.startsWith('$'));
          const multi = u.multi === true;
          let targets = await this._matching(engine, coll, q);
          if (!targets.length && u.upsert) {
            // #224：upsert 时对查询等值字段应用修饰符
            let merged;
            if (isModifier) {
              merged = this._nonDollarQuery(q);
              applyModifier(merged, updateDoc, { strict: true });
            } else {
              merged = cloneDoc(updateDoc);
            }
            if (merged._id === undefined && q._id !== undefined) merged._id = q._id;
            await engine.insert(coll, merged);
            n++;
            continue;
          }
          if (multi) {
            // 更新所有匹配的行
            for (const target of targets) {
              if (isModifier) await this._patchRows(engine, coll, [target], updateDoc);
              else await this._replaceRows(engine, coll, [target], updateDoc);
              n++;
            }
          } else {
            // 只更新第一条
            const target = targets[0] || null;
            if (target) {
              if (isModifier) await this._patchRows(engine, coll, [target], updateDoc);
              else await this._replaceRows(engine, coll, [target], updateDoc);
              n++;
            }
          }
        }
        } catch (e) {
          return { ok: 0, errmsg: e.message, code: 9, n, nModified: 0 };
        }
        return { ok: 1, n, nModified: n };
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
        return { ok: 1, n };
      }
      case 'createIndexes': {
        // #221：登记唯一/普通索引定义，供 insert/update 校验与 listIndexes 返回
        const coll = String(doc.createIndexes);
        const dbName = this._dbOf(doc);
        await this._ensureCollection(coll, dbName);
        const key = dbName + '.' + coll;
        const list = this._indexesByColl.get(key) || [{ name: '_id_', columns: ['_id'], unique: true }];
        for (const spec of (doc.indexes || [])) {
          const columns = Object.keys(spec.key || {});
          if (columns.length === 0) continue;
          const name = spec.name || columns.map(c => c + '_1').join('_');
          const entry = { name, columns, unique: !!spec.unique, sparse: !!spec.sparse };
          const at = list.findIndex(i => i.name === name);
          if (at >= 0) list[at] = entry; else list.push(entry);
        }
        this._indexesByColl.set(key, list);
        return { ok: 1, createdCollectionAutomatically: false, numIndexesBefore: 1, numIndexesAfter: list.length };
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
          v: 2, key: Object.fromEntries(i.columns.map(c => [c, 1])), name: i.name, ns,
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
          const name = typeof spec === 'string' ? spec : Object.keys(spec || {}).map(c => c + '_1').join('_');
          this._indexesByColl.set(key, list.filter(i => i.name !== name));
        }
        return { ok: 1, nIndexesWas: list.length };
      }
      case 'count': {
        const coll = String(doc.count);
        const engine = await this._ensureCollection(coll, this._dbOf(doc));
        const rows = await this._matching(engine, coll, doc.query);
        return { ok: 1, n: Number(doc.limit) > 0 ? Math.min(rows.length, doc.limit) : rows.length };
      }
      case 'aggregate': {
        const coll = String(doc.aggregate);
        const engine = await this._ensureCollection(coll, this._dbOf(doc));
        const pipeline = doc.pipeline || [];
        let rows = await engine.find(coll, {});
        for (const stage of pipeline) {
          if (stage.$match) rows = rows.filter((r) => this._match(r, stage.$match));
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
            rows = rows.map((r) => {
              const out = applyProjection(r, plain);
              for (const [k, e] of Object.entries(exprFields)) setPath(out, k, evalMongoExpr(e, r));
              return out;
            });
          }
          else if (stage.$unwind) {
            const cfg = typeof stage.$unwind === 'string'
              ? { path: stage.$unwind }
              : (stage.$unwind || {});
            const field = String(cfg.path || '').replace(/^\$/, '');
            const preserve = cfg.preserveNullAndEmptyArrays === true;
            const out = [];
            for (const r of rows) {
              const arr = getPath(r, field);
              if (!Array.isArray(arr) || arr.length === 0) {
                if (preserve) out.push(cloneDoc(r));
                continue;
              }
              for (const item of arr) {
                const nr = cloneDoc(r);
                setPath(nr, field, cloneDoc(item));
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
            if (!from || !localField || !foreignField || !as) {
              throw new Error('$lookup requires from, localField, foreignField and as');
            }
            const foreignEngine = await this._ensureCollection(from, this._dbOf(doc));
            const foreignRows = await foreignEngine.find(from, {});
            rows = rows.map((r) => {
              const lv = getPath(r, localField);
              const locals = Array.isArray(lv) ? lv : [lv];
              const matched = foreignRows.filter(fr =>
                orAnyElement(getPath(fr, foreignField), el => locals.some(l => valuesEqual(l, el))));
              const nr = cloneDoc(r);
              setPath(nr, as, matched.map(fr => cloneDoc(fr)));
              return nr;
            });
          }
          else if (stage.$group) {
            const groups = new Map();
            const groupDef = stage.$group;
            // Pass 1: bucket all rows into groups
            for (const row of rows) {
              let gk;
              if (groupDef._id !== undefined) {
                // explicit _id expression
                if (typeof groupDef._id === 'string' && groupDef._id.startsWith('$')) {
                  gk = getPath(row, groupDef._id.slice(1));
                } else {
                  gk = groupDef._id;
                }
              } else {
                // no explicit _id: use the row's _id if it's a real user-set value,
                // not a numeric auto-generated one (auto-ids start at 1,2,...N)
                gk = row._id;
              }
              // 规范键：同字节 ObjectId 归并同组（\0 前缀不可能与真实 BSON 字符串冲突）
              if (!groups.has(mapKey(gk))) groups.set(mapKey(gk), { v: gk, rows: [] });
              groups.get(mapKey(gk)).rows.push(row);
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
        }
        return { ok: 1, cursor: { id: { $long: 0 }, ns: `${this._dbOf(doc)}.${coll}`, firstBatch: rows } };
      }
      default:
        // #222：未知命令必须按协议返回 CommandNotFound，而不是伪成功
        return { ok: 0, errmsg: `no such command: ${String(cmd)}`, code: 59 };
    }
  }

  _idOf(row) {
    return row._id != null ? row._id : row.id;
  }

  async _matching(engine, coll, filter) {
    const rows = await engine.find(coll, {});
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
    // #219：条件是不含任何 $ 运算符的普通子文档时，按整文档深相等匹配
    if (cond && typeof cond === 'object' && !Array.isArray(cond) && !(cond instanceof ObjectId)) {
      const keys = Object.keys(cond);
      if (keys.length > 0 && keys.every(k => k[0] !== '$')) {
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
      if (op === '$all' && !(Array.isArray(v) && v.every(t => orAnyElement(rv, el => valuesEqual(el, t))))) return false;
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
      if (op === '$elemMatch' && !(Array.isArray(rv) && rv.some((el) => this._elemMatches(el, v)))) return false;
    }
    return true;
  }

  _match(row, filter) {
    for (const [k, cond] of Object.entries(filter || {})) {
      if (k === '$or') {
        if (!cond.some((f) => this._match(row, f))) return false;
        continue;
      }
      if (k === '$and') {
        if (!cond.every((f) => this._match(row, f))) return false;
        continue;
      }
      if (k === '$nor') {
        if (cond.some((f) => this._match(row, f))) return false;
        continue;
      }
      if (k === '$not') {
        if (this._match(row, cond)) return false;
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

module.exports = { MongoServer, createMongoServer, bsonDocument, bsonReadDocument };