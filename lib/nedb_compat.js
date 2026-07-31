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
  if (typeof a === 'number' || typeof b === 'number') {
    const na = Number(a), nb = Number(b);
    if (!Number.isNaN(na) && !Number.isNaN(nb)) return na === nb;
  }
  if (Array.isArray(a) && Array.isArray(b)) return arraysEqual(a, b);
  if (typeof a === 'object' && typeof b === 'object' && a !== null && b !== null) {
    const ka = Object.keys(a), kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    return ka.every(k => looseEqual(a[k], b[k]));
  }
  return String(a) === String(b);
}

function matchOperator(value, op, expected) {
  switch (op) {
    case '$eq': return looseEqual(value, expected);
    case '$ne': return !looseEqual(value, expected);
    case '$lt': return value !== null && value !== undefined && value < expected;
    case '$lte': return value !== null && value !== undefined && value <= expected;
    case '$gt': return value !== null && value !== undefined && value > expected;
    case '$gte': return value !== null && value !== undefined && value >= expected;
    case '$in': return Array.isArray(expected) && expected.some(e => looseEqual(value, e));
    case '$nin': return Array.isArray(expected) && !expected.some(e => looseEqual(value, e));
    case '$exists': return expected ? value !== undefined : value === undefined;
    case '$regex':
      return typeof value === 'string' && new RegExp(expected.source, expected.flags || 'i').test(value);
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

function applyModifier(doc, update) {
  for (const [op, payload] of Object.entries(update)) {
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
        const arr = Array.isArray(cur) ? cur : [];
        if (v && typeof v === 'object' && v.$each) arr.push(...v.$each);
        else arr.push(v);
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
        if (Array.isArray(arr)) setPath(doc, k, arr.filter(el => !match(el, { k: v })));
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
    if (cb) p.then(docs => cb(null, docs), err => cb(err)).catch(() => {});
    return p;
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
      await db.insert(name, rows);
      await db.flush();
      const inserted = arr.map((d, i) => JSON.parse(rows[i]._doc));
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
      docs = docs.map(d => {
        const out = {};
        for (const [k, include] of Object.entries(opts.projection)) {
          if (include) out[k] = getPath(d, k);
        }
        if (d._id !== undefined && opts.projection._id !== 0) out._id = d._id;
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
      if (matched.length === 0 && opts.upsert) {
        const base = {};
        for (const [k, v] of Object.entries(query)) {
          if (!k.startsWith('$')) base[k] = v;
        }
        const newDoc = isModifier(update)
          ? { ...base, ...(update.$set || {}) }
          : { ...update };
        if (newDoc._id === undefined) newDoc._id = genId();
        await db.insert(name, { _doc: JSON.stringify(newDoc) });
        await db.flush();
        upserted = { ...newDoc };
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
          if (JSON.stringify(next) !== JSON.stringify(doc)) {
            updates.push([id, { _doc: JSON.stringify(next) }]);
            affected++;
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
        const docs = await this._findDocs(query, { limit: opts.multi ? 1e9 : 1 });
        return { numAffected: affected, affectedDocuments: docs, upsert: upserted };
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
    return { fieldName: options.fieldName, unique: options.unique === true };
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

module.exports = { Datastore, Cursor };
