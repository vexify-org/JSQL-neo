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
const path = require('path');
const zlib = require('zlib');
const Database = require('./database');

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
      const lenBuf = Buffer.alloc(4);
      lenBuf.writeInt32LE(v.length, 0);
      body = Buffer.concat([body, Buffer.from([0x05]), name, Buffer.from([0]), lenBuf, Buffer.from([0, v.buffer ? 0 : 0]), v]);
      continue;
    }
    if (v instanceof Date) {
      const b = Buffer.alloc(8);
      b.writeBigInt64LE(BigInt(v.getTime()), 0);
      body = Buffer.concat([body, Buffer.from([0x09]), name, Buffer.from([0]), b]);
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
    case 0x07: { return { value: buf.slice(pos, pos + 12).toString('hex'), pos: pos + 12 }; }
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

/* ------------------------------------------------------------------ */
/* Server                                                             */
/* ------------------------------------------------------------------ */

class MongoServer {
  constructor(options = {}) {
    this.options = options;
    this.port = options.port || 27017;
    this.host = options.host || '127.0.0.1';
    this.dataDir = options.dataDir || null;
    this._engine = null;
    this._server = null;
    this._sockets = new Set();
  }

  async _getEngine() {
    if (this._engine) return this._engine;
    if (this.dataDir && this.dataDir !== ':memory:') {
      this._engine = new Database(path.join(this.dataDir, 'default'), { autoSave: true });
    } else {
      this._engine = new Database(':memory:', { autoSave: false });
    }
    return this._engine;
  }

  async _ensureCollection(name) {
    const engine = await this._getEngine();
    if (!engine.getTableSchema(name)) {
      engine.createTable(name, {});
    }
    return engine;
  }

  listen(cb) {
    this._server = net.createServer((socket) => this._handleSocket(socket));
    this._server.listen(this.port, this.host, cb || (() => {}));
    return this;
  }

  _handleSocket(socket, existing) {
    this._sockets.add(socket);
    socket.on('close', () => this._sockets.delete(socket));
    let buf = Buffer.isBuffer(existing) ? Buffer.from(existing) : Buffer.alloc(0);
    socket.on('error', () => {});
    const process = async () => {
      for (;;) {
        if (buf.length < 4) break;
        const len = buf.readInt32LE(0);
        if (len < 16 || buf.length < len) break;
        const msg = buf.slice(0, len);
        buf = buf.slice(len);
        try {
          await this._handleMessage(socket, msg);
        } catch (e) {
          try { socket.write(this._wrapMsg(bsonDocument({ ok: 0, errmsg: e.message || String(e) }), this._reqId(msg))); } catch (_) {}
        }
      }
    };
    socket.on('data', async (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      await process();
    });
    if (buf.length > 0) process();
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
    let pos = 16 + 4; // header + flagBits
    const kind = msg[pos]; pos++; // section kind: 0 = single BSON doc
    if (kind !== 0) {
      socket.write(this._wrapMsg(bsonDocument({ ok: 0, errmsg: `section kind ${kind} not supported` }), this._reqId(msg)));
      return;
    }
    const body = bsonReadDocument(msg, pos).value;
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
      case 'buildInfo': return { ok: 1, version: '5.3.0-jsql-neo', gitVersion: 'jsql-neo', versionArray: [5, 3, 0, 0] };
      case 'getParameter': return { ok: 1 };
      case 'endSessions': return { ok: 1 };
      case 'listDatabases':
        return { ok: 1, databases: [{ name: this._dbOf(doc), sizeOnDisk: 1, empty: false }], totalSize: 1 };
      case 'listCollections': {
        const engine = await this._getEngine();
        const tables = Object.keys(engine._meta && engine._meta.tables ? engine._meta.tables : (engine._tables || {}));
        const firstBatch = tables.map((t) => ({ name: t, type: 'collection', options: {}, info: { readOnly: false, uuid: '' } }));
        return { ok: 1, cursor: { id: { $long: 0 }, ns: `${this._dbOf(doc)}.$cmd.listCollections`, firstBatch } };
      }
      case 'create': {
        const engine = await this._ensureCollection(String(doc.create));
        return { ok: 1, ns: engine ? `${this._dbOf(doc)}.${doc.create}` : '' };
      }
      case 'drop': {
        try {
          const engine = await this._getEngine();
          engine.dropTable(String(doc.drop));
          return { ok: 1, ns: `${this._dbOf(doc)}.${doc.drop}` };
        } catch (e) {
          return { ok: 1, ns: `${this._dbOf(doc)}.${doc.drop}` }; // Mongo 对不存在的 collection drop 也返回 ok
        }
      }
      case 'insert': {
        const coll = String(doc.insert);
        const engine = await this._ensureCollection(coll);
        const docs = doc.documents || [];
        const ids = [];
        for (const d of docs) {
          const doc2 = { ...d };
          ids.push(engine.insert(coll, doc2));
        }
        return { ok: 1, n: docs.length };
      }
      case 'findAndModify': {
        const coll = String(doc.findAndModify);
        const engine = await this._ensureCollection(coll);
        const q = doc.query || {};
        const rows = this._matching(engine, coll, q);
        const found = rows[0] || null;
        const set = doc.update && doc.update.$set ? doc.update.$set : (doc.update || {});
        let value = null;
        if (found) {
          if (doc.remove) {
            this._removeRows(engine, coll, [found]);
            value = found;
          } else {
            const patched = { ...found, ...set };
            this._patchRows(engine, coll, [found], set);
            value = doc.new ? patched : found;
          }
        } else if (doc.upsert) {
          const merged = { ...q, ...set };
          const id = engine.insert(coll, merged);
          value = doc.new ? { ...merged, _id: id } : null;
        }
        return { ok: 1, value, lastErrorObject: { n: found ? 1 : (doc.upsert ? 1 : 0), updatedExisting: !!found && !doc.remove } };
      }
      case 'distinct': {
        const coll = String(doc.distinct);
        const engine = await this._ensureCollection(coll);
        const key = String(doc.key || '');
        const rows = this._matching(engine, coll, doc.query);
        const seen = new Set();
        const values = [];
        for (const r of rows) {
          const v = r[key];
          if (!seen.has(JSON.stringify(v))) { seen.add(JSON.stringify(v)); values.push(v); }
        }
        return { ok: 1, values };
      }
      case 'dropDatabase':
        return { ok: 1, dropped: String(doc.dropDatabase || this._dbOf(doc)) };
      case 'find': {
        const coll = String(doc.find);
        const engine = await this._ensureCollection(coll);
        let rows = this._matching(engine, coll, doc.filter);
        const skip = typeof doc.skip === 'number' ? doc.skip : 0;
        if (skip > 0) rows = rows.slice(skip);
        const limit = typeof doc.limit === 'number' ? doc.limit : 0;
        if (limit > 0) rows = rows.slice(0, limit);
        return { ok: 1, cursor: { id: { $long: 0 }, ns: `${this._dbOf(doc)}.${coll}`, firstBatch: rows } };
      }
      case 'getMore':
        return { ok: 1, cursor: { id: { $long: 0 }, ns: String(doc.collection || ''), nextBatch: [] } };
      case 'update': {
        const coll = String(doc.update);
        const engine = await this._ensureCollection(coll);
        let n = 0;
        const updates = doc.updates || [];
        for (const u of updates) {
          const q = u.q || {};
          const set = u.u && u.u.$set ? u.u.$set : (u.u || {});
          // 单文档更新
          let targets = this._matching(engine, coll, q);
          let target = targets[0] || null;
          if (!target && u.upsert) {
            const merged = { ...q, ...set };
            engine.insert(coll, merged);
            n++;
            continue;
          }
          if (target) {
            this._patchRows(engine, coll, [target], set);
            n++;
          }
        }
        return { ok: 1, n, nModified: n };
      }
      case 'delete': {
        const coll = String(doc.delete);
        const engine = await this._ensureCollection(coll);
        let n = 0;
        for (const d of (doc.deletes || [])) {
          const rows = this._matching(engine, coll, d.q || {});
          if (rows.length > 0) this._removeRows(engine, coll, rows);
          n += rows.length;
        }
        return { ok: 1, n };
      }
      case 'count': {
        const coll = String(doc.count);
        const engine = await this._ensureCollection(coll);
        const rows = this._matching(engine, coll, doc.query);
        return { ok: 1, n: Number(doc.limit) > 0 ? Math.min(rows.length, doc.limit) : rows.length };
      }
      case 'aggregate': {
        const coll = String(doc.aggregate);
        const engine = await this._ensureCollection(coll);
        const pipeline = doc.pipeline || [];
        let rows = engine.find(coll, {});
        for (const stage of pipeline) {
          if (stage.$match) rows = rows.filter((r) => this._match(r, stage.$match));
          else if (stage.$count) rows = [{ [stage.$count]: rows.length }];
          else if (stage.$limit) rows = rows.slice(0, stage.$limit);
          else if (stage.$skip) rows = rows.slice(Number(stage.$skip) || 0);
          else if (stage.$sort) {
            const sortKeys = Object.entries(stage.$sort);
            rows = [...rows].sort((a, b) => {
              for (const [k, dir] of sortKeys) {
                const av = a[k]; const bv = b[k];
                if (av === bv) continue;
                if (av == null) return 1;
                if (bv == null) return -1;
                const cmp = av < bv ? -1 : 1;
                return Number(dir) < 0 ? -cmp : cmp;
              }
              return 0;
            });
          }
          else if (stage.$project) {
            const proj = stage.$project;
            rows = rows.map((r) => {
              const out = {};
              for (const [k, v] of Object.entries(proj)) {
                if (k === '_id' && v === 0) continue;
                if (v === 0) continue;
                if (typeof v === 'string' && v.startsWith('$')) out[k] = r[v.slice(1)];
                else if (v === 1) out[k] = r[k];
                else if (v === 0) { /* exclude */ }
                else out[k] = v;
              }
              return out;
            });
          }
          else if (stage.$unwind) {
            const field = String(stage.$unwind).replace(/^\$/, '');
            const out = [];
            for (const r of rows) {
              const arr = r[field];
              if (!Array.isArray(arr) || arr.length === 0) { out.push({ ...r, [field]: null }); continue; }
              for (const item of arr) out.push({ ...r, [field]: item });
            }
            rows = out;
          }
          else if (stage.$group) {
            const acc = {};
            for (const [k, v] of Object.entries(stage.$group)) {
              if (v && v.$sum === 1 && k !== '_id') acc[k] = rows.length;
            }
            rows = [{ _id: 1, ...acc }];
          }
        }
        return { ok: 1, cursor: { id: { $long: 0 }, ns: `${this._dbOf(doc)}.${coll}`, firstBatch: rows } };
      }
      default:
        return { ok: 1, n: 0 };
    }
  }

  _idOf(row) {
    return row._id != null ? row._id : row.id;
  }

  _matching(engine, coll, filter) {
    return engine.find(coll, {}).filter((r) => this._match(r, filter || {}));
  }

  _patchRows(engine, coll, rows, set) {
    const table = engine._ensureTable(coll);
    for (const r of rows) Object.assign(r, set);
    table._rebuildPKIndex && table._rebuildPKIndex();
    table._rebuildAllBTrees && table._rebuildAllBTrees();
    engine._markDirty && engine._markDirty(coll);
  }

  _removeRows(engine, coll, rows) {
    const table = engine._ensureTable(coll);
    const gone = new Set(rows);
    table._rows = table._rows.filter((r) => !gone.has(r));
    table._rebuildPKIndex && table._rebuildPKIndex();
    table._rebuildAllBTrees && table._rebuildAllBTrees();
    engine._markDirty && engine._markDirty(coll);
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
      if (cond && typeof cond === 'object' && !Array.isArray(cond)) {
        for (const [op, v] of Object.entries(cond)) {
          const rv = row[k];
          if (op === '$gt' && !(rv > v)) return false;
          if (op === '$gte' && !(rv >= v)) return false;
          if (op === '$lt' && !(rv < v)) return false;
          if (op === '$lte' && !(rv <= v)) return false;
          if (op === '$ne' && !(rv !== v)) return false;
          if (op === '$in' && !(v.includes(rv))) return false;
          if (op === '$nin' && v.includes(rv)) return false;
          if (op === '$exists' && (v ? (rv === undefined) : (rv !== undefined))) return false;
          if (op === '$regex') {
            const flags = String(cond.$options || '').includes('i') ? 'i' : '';
            if (typeof rv !== 'string' || !new RegExp(String(v), flags).test(rv)) return false;
          }
          if (op === '$type') {
            const t = v === 'string' ? 'string' : v === 'int' || v === 'long' || v === 'double' || v === 'number' ? 'number' : v === 'bool' ? 'boolean' : v === 'null' ? 'null' : v === 'array' ? 'array' : typeof rv;
            if (typeof rv !== t) return false;
          }
          if (op === '$size' && !(Array.isArray(rv) && rv.length === v)) return false;
          if (op === '$elemMatch' && !(Array.isArray(rv) && rv.some((el) => this._match(el, v)))) return false;
        }
      } else if (row[k] !== cond) {
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
    if (this._engine && typeof this._engine.stop === 'function') this._engine.stop().then(done).catch(done);
    else done();
    return this;
  }
}

function createMongoServer(options) {
  return new MongoServer(options || {});
}

module.exports = { MongoServer, createMongoServer, bsonDocument, bsonReadDocument };