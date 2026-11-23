// © Vexify 2026 All Rights Reserved.
/**
 * NeDB 兼容层 — Datastore
 * 提供 NeDB 风格的 insert/find/findOne/update/remove/count 等 API，
 * 底层复用 JSQL 引擎（WASM / Native / Pure JS）。
 */

const Database = require('./database');

let uidCounter = 0;
function genId() {
  uidCounter++;
  return (Date.now() + uidCounter * 37).toString(36) + Math.random().toString(36).slice(2, 8);
}

function getPath(obj, path) {
  if (!path) return obj;
  const parts = String(path).split('.');
  let cur = obj;
  for (const p of parts) {
    if (cur === null || cur === undefined || typeof cur !== 'object') return undefined;
    cur = cur[p];
  }
  return cur;
}

function setPath(obj, path, value) {
  const parts = String(path).split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (cur[parts[i]] === null || typeof cur[parts[i]] !== 'object') cur[parts[i]] = {};
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = value;
}

function unsetPath(obj, path) {
  const parts = String(path).split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (cur === null || typeof cur !== 'object') return;
    cur = cur[parts[i]];
  }
  if (cur && typeof cur === 'object') delete cur[parts[parts.length - 1]];
}

function arraysEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (!looseEqual(a[i], b[i])) return false;
  return true;
}

function looseEqual(a, b) {
  if (a === b) return true;
  if (a === null || b === null || a === undefined || b === undefined) return false;
  if (typeof a === 'number' && typeof b === 'number') {
    const na = Number(a), nb = Number(b);
    if (!Number.isNaN(na) && !Number.isNaN(nb)) return na === nb;
  }
  if (Array.isArray(a) && Array.isArray(b)) return arraysEqual(a, b);
  if (typeof a === 'object' && typeof b === 'object' && a !== null && b !== null) {
    const ka = Object.keys(a), kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    return ka.every(k => looseEqual(a[k], b[k]));
  }
  return false;
}

function matchOperator(value, op, expected) {
  switch (op) {
    case '$eq': return looseEqual(value, expected);
    case '$ne': return !looseEqual(value, expected);
    case '$lt': return value !== undefined && (value === null ? 0 < expected : value < expected);
    case '$lte': return value !== undefined && (value === null ? 0 <= expected : value <= expected);
    case '$gt': return value !== undefined && (value === null ? 0 > expected : value > expected);
    case '$gte': return value !== undefined && (value === null ? 0 >= expected : value >= expected);
    case '$in': return Array.isArray(expected) && expected.some(e => looseEqual(value, e));
    case '$nin': return Array.isArray(expected) && !expected.some(e => looseEqual(value, e));
    case '$exists': return expected ? value !== undefined : value === undefined;
    case '$regex': {
      // #88：$regex 用字符串模式（'a'）时直接用字符串作正则源，不能取 .source
      // （只有 RegExp 才有 .source）。此前 new RegExp(undefined) = /(?:)/ 匹配一切，
      // 导致 find({ $regex: 'a' }) 返回全表。
      const src = typeof expected === 'string' ? expected : (expected && expected.source);
      const flags = (expected && expected.flags) || 'i';
      return typeof value === 'string' && new RegExp(src, flags).test(value);
    }
    case '$size': return Array.isArray(value) && value.length === expected;
    default: return false;
  }
}

function matchFieldValue(value, condition) {
  if (condition === null || condition === undefined) {
    return value === null || value === undefined;
  }
  if (condition instanceof RegExp) {
    return typeof value === 'string' && condition.test(value);
  }
  if (typeof condition === 'object' && !Array.isArray(condition) && Object.keys(condition).some(k => k.startsWith('$'))) {
    for (const [op, expected] of Object.entries(condition)) {
      if (op === '$not') {
        if (matchFieldValue(value, expected)) return false;
      } else if (op === '$and') {
        if (!Array.isArray(expected) || !expected.every(c => matchFieldValue(value, c))) return false;
      } else if (op === '$or') {
        if (!Array.isArray(expected) || !expected.some(c => matchFieldValue(value, c))) return false;
      } else if (op === '$elemMatch') {
        if (!Array.isArray(value) || !value.some(el => match(el, expected))) return false;
      } else {
        if (!matchOperator(value, op, expected)) return false;
      }
    }
    return true;
  }
  return looseEqual(value, condition);
}

// #81：$pull 的“元素是否命中”判定。
// 数组元素可能是标量（'red'）或对象（{name:'red'}）；条件 v 可能是
// 原始值、正则、$op 对象，或普通对象查询（按字段匹配，NeDB 语义）。
function elementMatch(el, v) {
  const isQueryObject = v && typeof v === 'object' && !Array.isArray(v) &&
    !(v instanceof RegExp) && !Object.keys(v).some(k => k.startsWith('$'));
  return isQueryObject ? match(el, v) : matchFieldValue(el, v);
}

function match(doc, query) {
  if (!query) return true;
  if (typeof query === 'function') return !!query(doc);
  if (query instanceof RegExp) return matchFieldValue(doc, query);

  if (query.$and) return query.$and.every(q => match(doc, q));
  if (query.$or) return query.$or.some(q => match(doc, q));
  if (query.$not) return !match(doc, query.$not);
  if (query.$where && typeof query.$where === 'function') {
    if (!query.$where.call(doc, doc)) return false;
  }

  for (const [key, condition] of Object.entries(query)) {
    if (key.startsWith('$')) continue;
    const value = getPath(doc, key);
    if (Array.isArray(value)) {
      if (Array.isArray(condition)) {
        if (!arraysEqual(value, condition)) return false;
      } else if (condition && typeof condition === 'object' && !(condition instanceof RegExp) && Object.keys(condition).some(k => k.startsWith('$'))) {
        if (!matchFieldValue(value, condition)) return false;
      } else {
        if (!value.some(el => matchFieldValue(el, condition))) return false;
      }
    } else {
      if (!matchFieldValue(value, condition)) return false;
    }
  }
  return true;
}

function applyModifier(doc, update, opts = {}) {
  const allowed = new Set(['$set', '$unset', '$inc', '$mul', '$min', '$max',
    '$push', '$addToSet', '$pop', '$pull', '$rename', '$currentDate', '$bit']);
  for (const [op, payload] of Object.entries(update || {})) {
    if (!op.startsWith('$')) continue;
    if (!allowed.has(op)) {
      if (opts.strict) throw new Error(`unknown modifier: ${op}`);
      continue;
    }
    if (op === '$set') {
      for (const [k, v] of Object.entries(payload)) setPath(doc, k, v);
    } else if (op === '$unset') {
      for (const k of Object.keys(payload)) unsetPath(doc, k);
    } else if (op === '$inc') {
      for (const [k, v] of Object.entries(payload)) {
        const cur = getPath(doc, k);
        setPath(doc, k, (Number(cur) || 0) + v);
      }
    } else if (op === '$mul') {
      for (const [k, v] of Object.entries(payload)) {
        const cur = getPath(doc, k);
        setPath(doc, k, cur === undefined ? 0 : (Number(cur) || 0) * v);
      }
    } else if (op === '$min') {
      for (const [k, v] of Object.entries(payload)) {
        const cur = getPath(doc, k);
        if (cur === undefined || v < cur) setPath(doc, k, v);
      }
    } else if (op === '$max') {
      for (const [k, v] of Object.entries(payload)) {
        const cur = getPath(doc, k);
        if (cur === undefined || v > cur) setPath(doc, k, v);
      }
    } else if (op === '$push') {
      for (const [k, v] of Object.entries(payload)) {
        const cur = getPath(doc, k);
        let arr = Array.isArray(cur) ? cur.slice() : [];
        if (v && typeof v === 'object' && v.$each) {
          const items = Array.isArray(v.$each) ? v.$each.slice() : [];
          if (Number.isInteger(v.$position)) {
            let pos = v.$position < 0 ? Math.max(arr.length + v.$position, 0) : Math.min(v.$position, arr.length);
            arr.splice(pos, 0, ...items);
          } else {
            arr.push(...items);
          }
          if (Number.isInteger(v.$slice)) {
            arr = v.$slice === 0 ? [] : (v.$slice > 0 ? arr.slice(0, v.$slice) : arr.slice(v.$slice));
          }
        } else {
          arr.push(v);
        }
        setPath(doc, k, arr);
      }
    } else if (op === '$addToSet') {
      for (const [k, v] of Object.entries(payload)) {
        const cur = getPath(doc, k);
        const arr = Array.isArray(cur) ? cur : [];
        if (v && typeof v === 'object' && v.$each) {
          for (const e of v.$each) if (!arr.some(x => looseEqual(x, e))) arr.push(e);
        } else {
          if (!arr.some(x => looseEqual(x, v))) arr.push(v);
        }
        setPath(doc, k, arr);
      }
    } else if (op === '$pop') {
      for (const [k, v] of Object.entries(payload)) {
        const arr = getPath(doc, k);
        if (Array.isArray(arr)) setPath(doc, k, v < 0 ? arr.slice(1) : arr.slice(0, -1));
      }
    } else if (op === '$pull') {
      for (const [k, v] of Object.entries(payload)) {
        const arr = getPath(doc, k);
        // #81：$pull 之前把条件包成 { k: v }（硬编码键 "k"），导致永远不匹配、
        // 数组原样保留（no-op）。
        // NeDB 语义：对数组每个元素做 match(element, v) —— 标量元素直接与 v 比较，
        // 对象元素按字段匹配。这里用 elementMatch 统一处理，真正把匹配元素移除。
        if (Array.isArray(arr)) setPath(doc, k, arr.filter(el => !elementMatch(el, v)));
      }
    } else if (op === '$rename') {
      for (const [from, to] of Object.entries(payload)) {
        // #413：源路径与目标路径互为前缀（如 a → a.b）属于自引用冲突，
        // 真实 MongoDB 不允许在同一子树内移动字段；先检测并报错，
        // 不能先写嵌套目标再删源把整棵源子树（含刚写入的目标）一起抹掉。
        const fromParts = String(from).split('.');
        const toParts = String(to).split('.');
        const common = Math.min(fromParts.length, toParts.length);
        let prefix = true;
        for (let i = 0; i < common; i++) {
          if (fromParts[i] !== toParts[i]) { prefix = false; break; }
        }
        if (prefix && fromParts.length !== toParts.length) {
          throw new Error(`$rename: source path '${from}' and target path '${to}' overlap; cannot rename within the same subtree`);
        }
        const v = getPath(doc, from);
        if (v !== undefined) {
          // 先写目标、再删源叶子路径；unsetPath 只移除源叶子，不连带删除目标嵌套与兄弟字段。
          setPath(doc, to, v);
          unsetPath(doc, from);
        }
      }
    } else if (op === '$currentDate') {
      const now = new Date().toISOString();
      for (const [k, v] of Object.entries(payload)) {
        if (v === true || (v && typeof v === 'object') || v === '$type') setPath(doc, k, now);
      }
    } else if (op === '$bit') {
      for (const [k, bits] of Object.entries(payload)) {
        const cur = Number(getPath(doc, k)) || 0;
        let v = cur;
        if (bits && bits.and !== undefined) v = v & Number(bits.and);
        if (bits && bits.or !== undefined) v = v | Number(bits.or);
        if (bits && bits.xor !== undefined) v = v ^ Number(bits.xor);
        setPath(doc, k, v);
      }
    }
  }
  return doc;
}

function isModifier(update) {
  return Object.keys(update || {}).some(k => k.startsWith('$'));
}

class Cursor {
  constructor(datastore, query, projection) {
    this._store = datastore;
    this._query = query || {};
    this._projection = projection || null;
    this._sort = null;
    this._limit = null;
    this._skip = 0;
  }

  sort(spec) {
    this._sort = spec;
    return this;
  }

  limit(n) {
    this._limit = n;
    return this;
  }

  skip(n) {
    this._skip = n;
    return this;
  }

  projection(p) {
    this._projection = p;
    return this;
  }

  async _run() {
    return this._store._findDocs(this._query, {
      sort: this._sort, limit: this._limit, skip: this._skip, projection: this._projection,
    });
  }

  exec(cb) {
    const p = this._run();
    if (cb) {
      p.then(docs => { if (this._limit === 0) cb(null, []); else cb(null, docs); }, err => cb(err));
      return p;
    }
    return this._limit === 0 ? Promise.resolve([]) : p;
  }

  toArray(cb) {
    return this.exec(cb);
  }

  async count(cb) {
    const docs = await this._store._findDocs(this._query, {});
    if (cb) cb(null, docs.length);
    return docs.length;
  }

  then(resolve, reject) {
    return this._run().then(resolve, reject);
  }
}

class Datastore {
  constructor(options = {}) {
    this.filename = options.filename || null;
    this.database = options.database || options.engine || null;
    this._ownEngine = false;
    this._started = false;
    this._indexes = [];   // #193：ensureIndex 登记的索引（含 unique 约束）
  }

  _uniqueFields() {
    const out = ['_id'];
    for (const ix of this._indexes || []) if (ix && ix.unique && ix.fieldName) out.push(ix.fieldName);
    return [...new Set(out)];
  }

  _uniqueError(field, value) {
    const e = new Error(`Unique constraint violated for key ${field}`);
    e.errorType = 'uniqueViolated';
    e.key = field;
    e.value = value;
    return e;
  }

  /** 检查 doc 在 unique 字段上是否与 docs（排除 excludeDoc）冲突 */
  _assertUnique(doc, docs, excludeDoc) {
    for (const f of this._uniqueFields()) {
      const v = getPath(doc, f);
      if (v === undefined || v === null) continue;
      const key = JSON.stringify(v);
      for (const other of docs) {
        if (!other || other === excludeDoc || other === doc) continue;
        const ov = getPath(other, f);
        if (ov !== undefined && ov !== null && JSON.stringify(ov) === key) {
          throw this._uniqueError(f, v);
        }
      }
    }
  }

  async _ensureEngine() {
    if (this.database) {
      if (!this._started) {
        if (typeof this.database.start === 'function') await this.database.start();
        this._started = true;
      }
      return this.database;
    }
    this.database = new Database(this.filename || ':memory:');
    if (typeof this.database.start === 'function') await this.database.start();
    this._ownEngine = true;
    this._started = true;
    return this.database;
  }

  async _tableName() {
    return this._table || (this._table = 'nedb_' + (this.filename ? require('path').basename(this.filename).replace(/\.db$/, '').replace(/[^a-zA-Z0-9_]/g, '_') : 'data'));
  }

  async _ensureTable() {
    const db = await this._ensureEngine();
    const name = await this._tableName();
    if (typeof db.hasTable === 'function' && await db.hasTable(name)) {
      return name;
    }
    await db.createTable(name, { _doc: { type: 'string' } });
    return name;
  }

  loadDatabase(cb) {
    const p = this._ensureEngine().then(() => this._ensureTable()).then(() => undefined);
    if (cb) p.then(() => cb(null), err => cb(err));
    return p;
  }

  insert(docs, cb) {
    const single = !Array.isArray(docs);
    const arr = single ? [docs] : docs;
    if (arr.length === 0) {
      const p = Promise.resolve(single ? null : []);
      if (cb) p.then(r => cb(null, r), err => cb(err));
      return p;
    }
    const p = (async () => {
      const db = await this._ensureEngine();
      const name = await this._ensureTable();
      const rows = arr.map(d => {
        const doc = { ...d };
        if (doc._id === undefined) doc._id = genId();
        this._lastInserted = doc;
        return { _doc: JSON.stringify(doc) };
      });
      // #190 / #193：显式 _id 与 unique 索引字段在写入前查重（整批原子）
      const uniqueFields = this._uniqueFields();
      const existing = await this._readDocs();
      const seen = new Map();
      for (const f of uniqueFields) {
        const set = new Set();
        for (const { doc } of existing) {
          const v = getPath(doc, f);
          if (v !== undefined && v !== null) set.add(JSON.stringify(v));
        }
        seen.set(f, set);
      }
      const insertedDocs = rows.map(r => JSON.parse(r._doc));
      for (const doc of insertedDocs) {
        for (const f of uniqueFields) {
          const v = getPath(doc, f);
          if (v === undefined || v === null) continue;
          const k = JSON.stringify(v);
          if (seen.get(f).has(k)) throw this._uniqueError(f, v);
          seen.get(f).add(k);
        }
      }
      await db.insert(name, rows);
      await db.flush();
      const inserted = insertedDocs;
      return single ? inserted[0] : inserted;
    })();
    if (cb) p.then(r => cb(null, r), err => cb(err));
    return p;
  }

  async _readDocs() {
    const db = await this._ensureEngine();
    const name = await this._ensureTable();
    const all = await db.find(name, {}, { limit: 1e9, offset: 0 });
    const rows = [];
    for (let i = 0; i < all.length; i++) {
      const row = all[i];
      const raw = row.fields ? row.fields._doc : row._doc;
      if (typeof raw !== 'string') continue;
      try {
        rows.push({ row, id: rowId(row, all), doc: JSON.parse(raw) });
      } catch (e) {
        // skip corrupted row
      }
    }
    return rows;
  }

  async _findDocs(query, opts = {}) {
    const entries = await this._readDocs();
    let docs = entries.filter(({ doc }) => match(doc, query)).map(({ doc }) => doc);
    if (opts.sort) {
      const keys = Object.entries(opts.sort);
      docs.sort((a, b) => {
        for (const [k, dir] of keys) {
          const av = getPath(a, k), bv = getPath(b, k);
          if (av === bv) continue;
          const cmp = av === undefined || av === null ? -1 : (bv === undefined || bv === null ? 1 : (av < bv ? -1 : 1));
          if (cmp !== 0) return dir >= 0 ? cmp : -cmp;
        }
        return 0;
      });
    }
    if (opts.skip) docs = docs.slice(opts.skip);
    if (opts.limit !== null && opts.limit !== undefined) docs = docs.slice(0, opts.limit);
    if (opts.projection) {
      const spec = opts.projection;
      const keys = Object.keys(spec).filter(k => k !== '_id');
      const includes = keys.filter(k => spec[k]);
      const excludes = keys.filter(k => !spec[k]);
      // #191：除 _id 外不能混用包含/排除
      if (includes.length > 0 && excludes.length > 0) {
        throw new Error('Cannot both keep and omit fields except for _id');
      }
      const includeMode = includes.length > 0;
      docs = docs.map(d => {
        if (includeMode) {
          const out = {};
          for (const k of includes) { const v = getPath(d, k); if (v !== undefined) setPath(out, k, v); }
          if (d._id !== undefined && spec._id !== 0) out._id = d._id;
          return out;
        }
        // 排除模式：先整体拷贝，再删除排除字段
        const out = {};
        for (const k of Object.keys(d)) out[k] = d[k];
        for (const k of excludes) unsetPath(out, k);
        if (spec._id === 0) delete out._id;
        return out;
      });
    }
    return docs;
  }

  find(query, projection, cb) {
    if (typeof projection === 'function') { cb = projection; projection = null; }
    const cursor = new Cursor(this, query, projection);
    if (cb) cursor.exec(cb);
    return cursor;
  }

  findOne(query, cb) {
    const p = (async () => {
      const docs = await this._findDocs(query, { limit: 1 });
      return docs.length > 0 ? docs[0] : null;
    })();
    if (cb) p.then(d => cb(null, d), err => cb(err));
    return p;
  }

  update(query, update, options = {}, cb) {
    if (typeof options === 'function') { cb = options; options = {}; }
    const opts = { multi: options.multi === true, upsert: options.upsert === true, returnUpdatedDocs: options.returnUpdatedDocs === true };
    const p = (async () => {
      const db = await this._ensureEngine();
      const name = await this._ensureTable();
      const entries = await this._readDocs();
      const matched = entries.filter(({ doc }) => match(doc, query));
      let affected = 0;
      let upserted = null;
      const updatedDocs = [];
      if (matched.length === 0 && opts.upsert) {
        const base = {};
        for (const [k, v] of Object.entries(query)) {
          if (!k.startsWith('$')) base[k] = v;
        }
        // #194：upsert 必须应用全部修饰符，而不是只展开 $set
        let newDoc;
        if (isModifier(update)) {
          newDoc = base;
          applyModifier(newDoc, update);
        } else {
          newDoc = { ...update };
        }
        if (newDoc._id === undefined) newDoc._id = genId();
        this._assertUnique(newDoc, entries.map(e => e.doc), null);
        await db.insert(name, { _doc: JSON.stringify(newDoc) });
        await db.flush();
        affected = 1;
        upserted = { ...newDoc };
        updatedDocs.push(newDoc);
      } else {
        const targets = opts.multi ? matched : matched.slice(0, 1);
        const updates = [];
        for (const { row, id, doc } of targets) {
          if (id === undefined) continue;
          const next = { ...doc };
          if (isModifier(update)) {
            applyModifier(next, update);
          } else {
            for (const k of Object.keys(next)) delete next[k];
            Object.assign(next, update);
            next._id = doc._id;
          }
          // #193：UPDATE 也不能撞上 unique 字段
          this._assertUnique(next, entries.map(e => e.doc), doc);
          if (JSON.stringify(next) !== JSON.stringify(doc)) {
            updates.push([id, { _doc: JSON.stringify(next) }]);
            affected++;
            updatedDocs.push(next);
          }
        }
        if (updates.length > 0) {
          if (typeof db.updateByIds === 'function') {
            await db.updateByIds(name, updates);
          } else {
            for (const [id, data] of updates) await db.updateById(name, id, data);
          }
          await db.flush();
        }
      }
      if (opts.returnUpdatedDocs) {
        // #192：非 multi 返回单个文档；未命中返回 null
        let affectedDocuments;
        if (upserted) affectedDocuments = upserted;
        else if (opts.multi) affectedDocuments = updatedDocs;
        else affectedDocuments = updatedDocs.length ? updatedDocs[0] : null;
        return { numAffected: affected, affectedDocuments, upsert: upserted };
      }
      return affected;
    })();
    if (cb) p.then(r => cb(null, r), err => cb(err));
    return p;
  }

  remove(query, options = {}, cb) {
    if (typeof options === 'function') { cb = options; options = {}; }
    const multi = options.multi === true;
    const p = (async () => {
      const db = await this._ensureEngine();
      const name = await this._ensureTable();
      const entries = await this._readDocs();
      const toRemove = entries.filter(({ doc }) => match(doc, query));
      const targets = multi ? toRemove : toRemove.slice(0, 1);
      const ids = targets.map(t => t.id).filter(id => id !== undefined);
      if (ids.length > 0) {
        await db.removeByIds(name, ids);
        await db.flush();
      }
      return targets.length;
    })();
    if (cb) p.then(r => cb(null, r), err => cb(err));
    return p;
  }

  count(query, cb) {
    const p = this._findDocs(query, {}).then(docs => docs.length);
    if (cb) p.then(n => cb(null, n), err => cb(err));
    return p;
  }

  async ensureIndex(options = {}) {
    await this._ensureEngine();
    // #193：保存索引定义，insert/update 依此强制 unique
    const ix = { fieldName: options.fieldName, unique: options.unique === true };
    if (ix.fieldName) {
      const at = this._indexes.findIndex(i => i.fieldName === ix.fieldName);
      if (at >= 0) this._indexes[at] = ix; else this._indexes.push(ix);
    }
    return ix;
  }

  /**
   * 移除指定字段的索引（#302）。
   * NeDB 的 Datastore 接口包含 removeIndex(fieldName, cb)；
   * 此前完全缺失，调用即 TypeError，迁移应用启动清理旧索引时直接崩。
   * 支持同步返回与 NeDB 风格的 callback 两种签名。
   */
  async removeIndex(fieldName, cb) {
    const name = String(fieldName);
    const before = this._indexes.length;
    this._indexes = this._indexes.filter(i => !i || i.fieldName !== name);
    const removed = before - this._indexes.length;
    const p = Promise.resolve(removed);
    if (cb) p.then(n => cb(null, n), err => cb(err));
    return p;
  }

  /**
   * 列出当前所有索引（#302）。
   * NeDB 的 Datastore 接口包含 getIndexes()；此前缺失，调用即 TypeError。
   * 支持同步返回与 NeDB 风格的 callback 两种签名。
   */
  async getIndexes(cb) {
    const list = (this._indexes || []).map(i => ({
      fieldName: i.fieldName,
      unique: i.unique === true,
    }));
    const p = Promise.resolve(list);
    if (cb) p.then(n => cb(null, n), err => cb(err));
    return p;
  }

  async compaction() {
    const db = await this._ensureEngine();
    if (typeof db.compact === 'function') return db.compact();
    return undefined;
  }

  async stop() {
    if (this.database && this._ownEngine && typeof this.database.stop === 'function') {
      await this.database.stop();
    }
  }
}

function rowId(row, all) {
  if (row && typeof row === 'object' && 'id' in row && row.fields) return row.id;
  const idx = all.indexOf(row);
  return idx === -1 ? undefined : idx + 1;
}

module.exports = { Datastore, Cursor, getPath, setPath, unsetPath, applyModifier };
