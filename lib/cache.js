const fs = require('fs');
const path = require('path');

class Cache {
  constructor(options = {}) {
    this._data = new Map();
    this._expires = new Map();
    this._ttlTimer = null;
    this._db = 0;
    this._dbs = [this._data];
    this._dbsExpires = [this._expires];
    this._persistPath = options.path || null;
    this._saveInterval = options.saveInterval || 0;
    this._dirty = false;
    if (this._persistPath) this._load();
    if (this._saveInterval > 0) this._startAutoSave();
    this._startTTLCleaner();
  }

  set(key, value) { this._getData().set(String(key), String(value)); this._dirty = true; return 'OK'; }
  get(key) {
    const k = String(key);
    if (this._isExpired(k)) return null;
    const val = this._getData().get(k);
    return val !== undefined ? val : null;
  }
  del(...keys) {
    let count = 0;
    for (const key of keys) { const k = String(key); if (this._getData().delete(k)) count++; this._getExpires().delete(k); }
    if (count > 0) this._dirty = true;
    return count;
  }
  exists(...keys) {
    let count = 0;
    for (const key of keys) { const k = String(key); if (!this._isExpired(k) && this._getData().has(k)) count++; }
    return count;
  }
  keys(pattern = '*') {
    const regex = new RegExp('^' + pattern.replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
    const result = [];
    for (const key of this._getData().keys()) { if (!this._isExpired(key) && regex.test(key)) result.push(key); }
    return result;
  }
  type(key) {
    const k = String(key);
    if (this._isExpired(k)) return 'none';
    const val = this._getData().get(k);
    if (val === undefined) return 'none';
    if (typeof val === 'string') return 'string';
    if (Array.isArray(val)) return val._type === 'hash' ? 'hash' : 'list';
    if (val instanceof Set) return 'set';
    return 'string';
  }
  expire(key, seconds) {
    const k = String(key);
    if (!this._getData().has(k)) return 0;
    this._getExpires().set(k, Date.now() + seconds * 1000);
    return 1;
  }
  ttl(key) {
    const k = String(key);
    if (!this._getData().has(k)) return -2;
    const expiry = this._getExpires().get(k);
    if (expiry === undefined) return -1;
    const remaining = Math.ceil((expiry - Date.now()) / 1000);
    return remaining > 0 ? remaining : -2;
  }
  persist(key) { return this._getExpires().delete(String(key)) ? 1 : 0; }
  incr(key) { return this._incrby(key, 1); }
  decr(key) { return this._incrby(key, -1); }
  incrby(key, increment) { return this._incrby(key, increment); }
  decrby(key, decrement) { return this._incrby(key, -decrement); }
  _incrby(key, delta) {
    const k = String(key);
    const cur = this._getData().get(k);
    const val = (cur !== undefined ? Number(cur) : 0) + delta;
    if (!Number.isFinite(val)) throw new Error('value is not an integer or out of range');
    this._getData().set(k, String(val));
    this._dirty = true;
    return val;
  }

  hset(key, field, value) {
    const k = String(key);
    let hash = this._getData().get(k);
    if (!hash || hash._type !== 'hash') { hash = { _type: 'hash' }; this._getData().set(k, hash); }
    const existed = hash[field] !== undefined;
    hash[field] = String(value);
    this._dirty = true;
    return existed ? 0 : 1;
  }
  hget(key, field) {
    const k = String(key);
    if (this._isExpired(k)) return null;
    const hash = this._getData().get(k);
    if (!hash || typeof hash !== 'object' || hash._type !== 'hash') return null;
    return hash[field] !== undefined ? hash[field] : null;
  }
  hgetall(key) {
    const k = String(key);
    if (this._isExpired(k)) return null;
    const hash = this._getData().get(k);
    if (!hash || typeof hash !== 'object' || hash._type !== 'hash') return null;
    const result = {};
    for (const [f, v] of Object.entries(hash)) { if (f !== '_type') result[f] = v; }
    return result;
  }
  hdel(key, ...fields) {
    const k = String(key);
    const hash = this._getData().get(k);
    if (!hash || typeof hash !== 'object' || hash._type !== 'hash') return 0;
    let count = 0;
    for (const field of fields) { if (delete hash[field]) count++; }
    if (count > 0) this._dirty = true;
    return count;
  }
  hkeys(key) {
    const k = String(key);
    if (this._isExpired(k)) return [];
    const hash = this._getData().get(k);
    if (!hash || typeof hash !== 'object' || hash._type !== 'hash') return [];
    return Object.keys(hash).filter(f => f !== '_type');
  }
  hlen(key) {
    const k = String(key);
    if (this._isExpired(k)) return 0;
    const hash = this._getData().get(k);
    if (!hash || typeof hash !== 'object' || hash._type !== 'hash') return 0;
    return Object.keys(hash).filter(f => f !== '_type').length;
  }

  lpush(key, ...values) {
    const k = String(key);
    let list = this._getData().get(k);
    if (!list || !Array.isArray(list) || list._type === 'hash') { list = []; this._getData().set(k, list); }
    list.unshift(...values.map(String).reverse());
    this._dirty = true;
    return list.length;
  }
  rpush(key, ...values) {
    const k = String(key);
    let list = this._getData().get(k);
    if (!list || !Array.isArray(list) || list._type === 'hash') { list = []; this._getData().set(k, list); }
    list.push(...values.map(String));
    this._dirty = true;
    return list.length;
  }
  lpop(key) {
    const k = String(key);
    const list = this._getData().get(k);
    if (!list || !Array.isArray(list) || list._type === 'hash') return null;
    if (list.length === 0) return null;
    this._dirty = true;
    return list.shift();
  }
  rpop(key) {
    const k = String(key);
    const list = this._getData().get(k);
    if (!list || !Array.isArray(list) || list._type === 'hash') return null;
    if (list.length === 0) return null;
    this._dirty = true;
    return list.pop();
  }
  llen(key) {
    const k = String(key);
    if (this._isExpired(k)) return 0;
    const list = this._getData().get(k);
    if (!list || !Array.isArray(list) || list._type === 'hash') return 0;
    return list.length;
  }
  lrange(key, start, stop) {
    const k = String(key);
    if (this._isExpired(k)) return [];
    const list = this._getData().get(k);
    if (!list || !Array.isArray(list) || list._type === 'hash') return [];
    if (start < 0) start = Math.max(list.length + start, 0);
    if (stop < 0) stop = list.length + stop;
    return list.slice(start, stop + 1);
  }

  sadd(key, ...members) {
    const k = String(key);
    let set = this._getData().get(k);
    if (!set || !(set instanceof Set)) { set = new Set(); this._getData().set(k, set); }
    let count = 0;
    for (const m of members) { if (!set.has(String(m))) { set.add(String(m)); count++; } }
    if (count > 0) this._dirty = true;
    return count;
  }
  srem(key, ...members) {
    const k = String(key);
    const set = this._getData().get(k);
    if (!set || !(set instanceof Set)) return 0;
    let count = 0;
    for (const m of members) { if (set.delete(String(m))) count++; }
    if (count > 0) this._dirty = true;
    return count;
  }
  smembers(key) {
    const k = String(key);
    if (this._isExpired(k)) return [];
    const set = this._getData().get(k);
    if (!set || !(set instanceof Set)) return [];
    return [...set];
  }
  sismember(key, member) {
    const k = String(key);
    if (this._isExpired(k)) return 0;
    const set = this._getData().get(k);
    if (!set || !(set instanceof Set)) return 0;
    return set.has(String(member)) ? 1 : 0;
  }
  scard(key) {
    const k = String(key);
    if (this._isExpired(k)) return 0;
    const set = this._getData().get(k);
    if (!set || !(set instanceof Set)) return 0;
    return set.size;
  }

  flushall() {
    for (let i = 0; i < this._dbs.length; i++) { if (this._dbs[i]) this._dbs[i].clear(); if (this._dbsExpires[i]) this._dbsExpires[i].clear(); }
    this._data = this._dbs[0] = new Map();
    this._expires = this._dbsExpires[0] = new Map();
    this._db = 0;
    this._dirty = true;
    return 'OK';
  }
  flushdb() { this._getData().clear(); this._getExpires().clear(); this._dirty = true; return 'OK'; }
  dbsize() {
    let count = 0;
    for (const key of this._getData().keys()) { if (!this._isExpired(key)) count++; }
    return count;
  }
  select(index) {
    const idx = Number(index);
    if (idx < 0 || idx > 15) throw new Error('DB index out of range');
    this._db = idx;
    if (!this._dbs[idx]) { this._dbs[idx] = new Map(); this._dbsExpires[idx] = new Map(); }
    this._data = this._dbs[idx];
    this._expires = this._dbsExpires[idx];
    return 'OK';
  }

  save() {
    if (!this._persistPath) return;
    const dump = { version: 1, databases: [] };
    for (let i = 0; i < this._dbs.length; i++) {
      const db = this._dbs[i];
      if (!db || db.size === 0) continue;
      const data = {};
      for (const [key, val] of db) {
        const exp = this._dbsExpires[i];
        if (exp && exp.has(key) && exp.get(key) <= Date.now()) continue;
        if (val instanceof Set) data[key] = { _t: 'set', _v: [...val] };
        else if (Array.isArray(val)) data[key] = { _t: 'list', _v: val };
        else if (typeof val === 'object' && val._type === 'hash') {
          const clean = {}; for (const [f, v] of Object.entries(val)) { if (f !== '_type') clean[f] = v; }
          data[key] = { _t: 'hash', _v: clean };
        } else data[key] = { _t: 'string', _v: val };
      }
      const expires = {};
      const expMap = this._dbsExpires[i];
      if (expMap) { for (const [key, ttl] of expMap) { if (ttl > Date.now()) expires[key] = ttl; } }
      if (Object.keys(data).length > 0 || Object.keys(expires).length > 0) dump.databases.push({ index: i, data, expires });
    }
    const dir = path.dirname(this._persistPath);
    if (dir) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(this._persistPath + '.tmp', JSON.stringify(dump), 'utf8');
    fs.renameSync(this._persistPath + '.tmp', this._persistPath);
    this._dirty = false;
    return 'OK';
  }

  _load() {
    try {
      if (!fs.existsSync(this._persistPath)) return;
      const dump = JSON.parse(fs.readFileSync(this._persistPath, 'utf8'));
      if (dump.version !== 1) return;
      for (const db of dump.databases || []) {
        const idx = db.index;
        if (!this._dbs[idx]) { this._dbs[idx] = new Map(); this._dbsExpires[idx] = new Map(); }
        const data = this._dbs[idx], expires = this._dbsExpires[idx];
        for (const [key, entry] of Object.entries(db.data || {})) {
          if (entry._t === 'set') data.set(key, new Set(entry._v));
          else if (entry._t === 'list') data.set(key, entry._v);
          else if (entry._t === 'hash') data.set(key, { _type: 'hash', ...entry._v });
          else data.set(key, entry._v);
        }
        for (const [key, ttl] of Object.entries(db.expires || {})) { if (ttl > Date.now()) expires.set(key, ttl); }
      }
      this._data = this._dbs[this._db] || new Map();
      this._expires = this._dbsExpires[this._db] || new Map();
    } catch (_) { /* ignore */ }
  }

  _startAutoSave() { this._saveTimer = setInterval(() => { if (this._dirty) this.save(); }, this._saveInterval); }
  _startTTLCleaner() {
    this._ttlTimer = setInterval(() => {
      for (let i = 0; i < this._dbs.length; i++) {
        const exp = this._dbsExpires[i]; if (!exp) continue;
        const now = Date.now();
        for (const [key, ttl] of exp) { if (ttl <= now) { if (this._dbs[i]) this._dbs[i].delete(key); exp.delete(key); } }
      }
    }, 1000);
  }

  close() { if (this._persistPath && this._dirty) this.save(); if (this._saveTimer) clearInterval(this._saveTimer); if (this._ttlTimer) clearInterval(this._ttlTimer); }
  _isExpired(key) {
    const expiry = this._getExpires().get(key);
    if (expiry !== undefined && expiry <= Date.now()) { this._getData().delete(key); this._getExpires().delete(key); return true; }
    return false;
  }
  _getData() { return this._data; }
  _getExpires() { return this._expires; }

  static redisPlugin(db, options = {}) {
    const cache = new Cache(options);
    db._cache = cache;
    const redisMethods = ['set','get','del','exists','keys','type','expire','ttl','persist','incr','decr','incrby','decrby','hset','hget','hgetall','hdel','hkeys','hlen','lpush','rpush','lpop','rpop','llen','lrange','sadd','srem','smembers','sismember','scard','flushall','flushdb','dbsize','select'];
    for (const m of redisMethods) {
      db[m] = cache[m].bind(cache);
    }
    return cache;
  }
}

module.exports = Cache;
