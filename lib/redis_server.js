/*
 * JSQL-NEO Redis-compatible server (RESP2, zero dependencies).
 *
 *   const { createRedisServer } = require('jsql-neo');
 *   const srv = createRedisServer({ port: 6379, dataDir: './data' });
 *   srv.listen();
 *
 * Supported commands:
 *   PING, ECHO, SET, GET, SETNX, DEL, EXISTS, KEYS, TYPE, EXPIRE, TTL, PERSIST,
 *   INCR, DECR, INCRBY, DECRBY, APPEND, STRLEN,
 *   HSET, HGET, HGETALL, HDEL, HEXISTS, HLEN, HKEYS, HVALS,
 *   LPUSH, RPUSH, LPOP, RPOP, LLEN, LRANGE, LINDEX, LREM,
 *   SADD, SREM, SMEMBERS, SISMEMBER, SCARD,
 *   DBSIZE, FLUSHALL, FLUSHDB, SELECT, INFO, AUTH, QUIT
 *
 * Persistence: keys are held in memory and snapshotted to data.rdb.json
 * (debounced 500ms) plus a final snapshot on shutdown.
 */
const net = require('net');
const fs = require('fs');
const path = require('path');

// Redis score/increment 必须是完整合法浮点数；parseFloat 会吞掉尾随垃圾（"1abc" → 1）
function parseRedisFloat(raw) {
  const s = String(raw).trim();
  if (/^[+-]?inf(inity)?$/i.test(s)) return s.startsWith('-') ? -Infinity : Infinity;
  if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(s)) {
    throw new Error('ERR value is not a valid float');
  }
  return Number(s);
}

// #175：索引必须是严格十进制整数；parseInt 会把 "x" 变 NaN、把 "1.5" 截断。
function parseRedisInt(raw) {
  const s = String(raw).trim();
  if (!/^-?\d+$/.test(s)) throw new Error('ERR value is not an integer or out of range');
  const n = Number(s);
  if (!Number.isSafeInteger(n)) throw new Error('ERR value is not an integer or out of range');
  return n;
}

// Redis glob：* / ? / [abc] / [!abc] / [a-c]；其余正则元字符按字面转义
function globToRegex(pattern) {
  const p = String(pattern);
  let src = '^';
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === '*') { src += '.*'; continue; }
    if (c === '?') { src += '.'; continue; }
    if (c === '[') {
      const close = p.indexOf(']', i + 1);
      if (close > i + 1) {
        let body = p.slice(i + 1, close).replace(/\\/g, '\\\\');
        if (body[0] === '!' || body[0] === '^') body = '^' + body.slice(1);
        src += '[' + body + ']';
        i = close;
        continue;
      }
    }
    src += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(src + '$');
}

// #225：bulk 载荷二进制安全。合法 UTF-8 仍按字符串保存（与历史行为/测试一致），
// 非法字节用 \u0001 前缀 + latin1 保真；回包时还原原始字节。
const BIN_PREFIX = '\u0001';
function decodeBulk(buf) {
  const s = buf.toString('utf8');
  if (Buffer.from(s, 'utf8').equals(buf)) return s;
  return BIN_PREFIX + buf.toString('latin1');
}
function bulkToBuffer(v) {
  const s = String(v);
  if (s.startsWith(BIN_PREFIX)) return Buffer.from(s.slice(BIN_PREFIX.length), 'latin1');
  return Buffer.from(s, 'utf8');
}

const TYPE_SIGNATURES = {
  PING: 0, ECHO: 1, SET: -2, SETNX: 2, GET: 1, DEL: -1, EXISTS: -1, KEYS: 1,
  TYPE: 1, EXPIRE: 2, TTL: 1, PERSIST: 1,
  INCR: 1, DECR: 1, INCRBY: 2, DECRBY: 2, APPEND: 2, STRLEN: 1,
  MSET: -2, MGET: -1,
  HSET: -3, HGET: 2, HGETALL: 1, HDEL: -2, HEXISTS: 2, HLEN: 1, HKEYS: 1, HVALS: 1,
  LPUSH: -2, RPUSH: -2, LPOP: -1, RPOP: -1, LLEN: 1, LRANGE: 3, LINDEX: 2, LREM: 3,
  SADD: -2, SREM: -2, SMEMBERS: 1, SISMEMBER: 2, SCARD: 1,
  ZADD: -3, ZRANGE: 3, ZREVRANGE: 3, ZSCORE: 2, ZCARD: 1, ZREM: -2, ZINCRBY: 3,
  DBSIZE: 0, FLUSHALL: 0, FLUSHDB: 0, SELECT: 1, INFO: 0, AUTH: 1, QUIT: 0,
};

// #177：这些命令的成功回复是 RESP simple string；其余字符串结果一律走 bulk。
const SIMPLE_STRING_CMDS = new Set(['SET', 'MSET', 'SELECT', 'AUTH', 'FLUSHALL', 'FLUSHDB', 'TYPE']);

class RedisServer {
  constructor(opts = {}) {
    this.port = opts.port ?? 6379;
    this.host = opts.host || '127.0.0.1';
    this.password = opts.password || null;
    this.dataDir = opts.dataDir || null;
    this.onQuery = opts.onQuery || null;
    this.onError = opts.onError || null;
    this.databaseCount = opts.databases != null ? Number(opts.databases) : 16;
    if (!Number.isInteger(this.databaseCount) || this.databaseCount < 1 || this.databaseCount > 1024) {
      throw new Error('Redis databases must be an integer between 1 and 1024');
    }
    this.maxBufferSize = opts.maxBufferSize || 64 * 1024 * 1024;
    this.maxBulkLength = opts.maxBulkLength || 64 * 1024 * 1024;
    this.maxMultiBulkLength = opts.maxMultiBulkLength || 1024 * 1024;
    this.maxInlineLength = opts.maxInlineLength || 64 * 1024;
    this._dbs = new Map();
    for (let i = 0; i < this.databaseCount; i++) this._dbs.set(i, new Map());
    this.selected = 0;
    this.db = this._dbs.get(0);
    this._selected = new WeakMap();   // socket → db index
    this.snapshotTimer = null;
    this._authedSockets = new WeakMap();
    this._load();
  }

  snapshotPath() {
    // #187：':memory:' 是统一的纯内存哨兵，不能当成字面目录落盘
    if (!this.dataDir || this.dataDir === ':memory:') return null;
    return path.join(this.dataDir, 'data.rdb.json');
  }

  _restoreEntry(map, k, v) {
    // Restore type info: { _t: 'set', _v: [...] } → Set, { _t: 'date', _v: ... } → Date
    if (v && v._t === 'set' && Array.isArray(v._v)) map.set(k, new Set(v._v));
    else if (v && v._t === 'date') map.set(k, new Date(v._v));
    else map.set(k, v);
  }

  _applySnapshot(raw) {
    if (raw && raw.__jsql_redis__ === 2 && raw.databases && typeof raw.databases === 'object') {
      // v2：多 DB 快照 { __jsql_redis__: 2, databases: { "0": {...}, "1": {...} } }
      for (const [idxStr, entries] of Object.entries(raw.databases)) {
        const idx = Number(idxStr);
        const map = this._dbs.get(idx);
        if (!map || !entries || typeof entries !== 'object') continue;
        for (const [k, v] of Object.entries(entries)) this._restoreEntry(map, k, v);
      }
    } else {
      // v1：旧版只有单个 db，全部落到 0 号库
      for (const [k, v] of Object.entries(raw || {})) this._restoreEntry(this._dbs.get(0), k, v);
    }
  }

  _reportLoadError(message) {
    const err = new Error(message);
    if (this.onError) {
      try { this.onError(err); } catch (_) { /* 回调失败不影响启动 */ }
    }
    console.error('[jsql-neo] ' + message);
  }

  _load() {
    const p = this.snapshotPath();
    if (!p) return;
    const tmp = p + '.tmp';
    let raw = null;
    let source = null;

    if (fs.existsSync(p)) {
      try {
        raw = JSON.parse(fs.readFileSync(p, 'utf8'));
        source = p;
      } catch (e) {
        // #179：快照损坏不能静默当空库；先保留现场，再尝试 .tmp
        const backup = p + '.corrupt-' + Date.now();
        try { fs.renameSync(p, backup); } catch (_) { /* 备份失败也要继续报告 */ }
        this._reportLoadError(`redis snapshot corrupt (${p}): ${e.message}; backed up to ${backup}`);
      }
    }

    if (!raw && fs.existsSync(tmp)) {
      try {
        raw = JSON.parse(fs.readFileSync(tmp, 'utf8'));
        source = tmp;
      } catch (e) {
        const backup = tmp + '.corrupt-' + Date.now();
        try { fs.renameSync(tmp, backup); } catch (_) {}
        this._reportLoadError(`redis snapshot temp corrupt (${tmp}): ${e.message}; backed up to ${backup}`);
      }
    }

    if (!raw) return;
    this._applySnapshot(raw);
    if (source === tmp) {
      try { fs.renameSync(tmp, p); } catch (_) { /* 恢复失败不影响已加载数据 */ }
    }
  }

  _scheduleSnapshot() {
    if (!this.dataDir) return;
    if (this.snapshotTimer) clearTimeout(this.snapshotTimer);
    this.snapshotTimer = setTimeout(() => this._snapshot(), 500);
  }

  _snapshot() {
    if (this.snapshotTimer) { clearTimeout(this.snapshotTimer); this.snapshotTimer = null; }
    const p = this.snapshotPath();
    if (!p) return;
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const out = { __jsql_redis__: 2, databases: {} };
    const now = Date.now();
    for (const [idx, map] of this._dbs) {
      const entries = {};
      for (const [k, v] of map) {
        if (v && v.ttl && v.ttl <= now) continue;
        // Preserve type info: Set → { _t: 'set', _v: [...] }, Date → ISO string
        if (v instanceof Set) entries[k] = { _t: 'set', _v: [...v] };
        else if (v instanceof Date) entries[k] = { _t: 'date', _v: v.toISOString() };
        else entries[k] = v;
      }
      if (Object.keys(entries).length > 0) out.databases[String(idx)] = entries;
    }
    const tmp = p + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(out));
    try { fs.renameSync(tmp, p); } catch (e) { fs.unlinkSync(tmp); }
  }

  stop() {
    if (this.snapshotTimer) { clearTimeout(this.snapshotTimer); this.snapshotTimer = null; }
    this._snapshot();
    if (this.server) {
      this.server.close();
      this.server = null;
    }
  }

  /* ---------- value helpers ---------- */
  _get(key) {
    const v = this.db.get(key);
    if (!v) return null;
    if (v.ttl && v.ttl <= Date.now()) { this.db.delete(key); return null; }
    return v;
  }

  /* ---------- command execution ---------- */
  execute(cmd, args) {
    const sig = TYPE_SIGNATURES[cmd];
    if (sig === undefined) throw new Error(`ERR unknown command '${cmd}'`);
    // #172：负 arity 表示最少参数个数，-2/-3 等也必须校验
    if (sig >= 0 && args.length < sig) throw new Error(`ERR wrong number of arguments for '${cmd}' command`);
    if (sig < 0 && args.length < -sig) throw new Error(`ERR wrong number of arguments for '${cmd}' command`);
    switch (cmd) {
      case 'PING': return args.length ? args[0] : 'PONG';
      case 'ECHO': return args[0];
      case 'AUTH':
        if (!this.password) throw new Error('ERR Client sent AUTH, but no password is set');
        if (args[0] !== this.password) throw new Error('ERR invalid password');
        return 'OK';
      case 'SELECT': {
        if (!/^\d+$/.test(args[0])) throw new Error(`ERR invalid DB index`);
        const idx = parseInt(args[0], 10);
        if (idx >= this.databaseCount) throw new Error('ERR DB index is out of range');
        this.selected = idx;
        this.db = this._dbs.get(idx);
        return 'OK';
      }
      case 'SET': {
        const key = args[0];
        const val = args[1];
        // Parse optional arguments: EX seconds | PX milliseconds | NX | XX
        let ttl = null;
        let nx = false, xx = false;
        const seen = new Set();
        for (let i = 2; i < args.length; i++) {
          const opt = String(args[i]).toUpperCase();
          if ((opt === 'EX' || opt === 'PX' || opt === 'NX' || opt === 'XX') && seen.has(opt)) {
            throw new Error('ERR syntax error');
          }
          seen.add(opt);
          if (opt === 'EX') {
            const raw = String(args[++i]).trim();
            if (!/^[+-]?\d+$/.test(raw)) throw new Error("ERR invalid expire time in 'set' command");
            const secs = Number(raw);
            if (secs <= 0) throw new Error("ERR invalid expire time in 'set' command");
            ttl = Date.now() + secs * 1000;
          } else if (opt === 'PX') {
            const raw = String(args[++i]).trim();
            if (!/^[+-]?\d+$/.test(raw)) throw new Error("ERR invalid expire time in 'set' command");
            const ms = Number(raw);
            if (ms <= 0) throw new Error("ERR invalid expire time in 'set' command");
            ttl = Date.now() + ms;
          } else if (opt === 'NX') {
            nx = true;
          } else if (opt === 'XX') {
            xx = true;
          } else {
            throw new Error('ERR syntax error');
          }
        }
        if (nx && xx) throw new Error('ERR syntax error');
        const prev = this._get(key);
        if (nx && prev) return null;
        if (xx && !prev) return null;
        this.db.set(key, { type: 'string', val, ttl });
        this._scheduleSnapshot();
        return 'OK';
      }
      case 'SETNX': {
        const prev = this._get(args[0]);
        if (prev) return 0;
        this.db.set(args[0], { type: 'string', val: args[1], ttl: null });
        this._scheduleSnapshot();
        return 1;
      }
      case 'GET': {
        const v = this._get(args[0]);
        if (!v) return null;
        if (v.type !== 'string') throw new Error('WRONGTYPE Operation against a key holding the wrong kind of value');
        return v.val;
      }
      case 'APPEND': {
        const argCount = args.length;
        if (argCount > 2) throw new Error(`ERR wrong number of arguments for 'append' command`);
        const v = this._get(args[0]);
        // N2-fix: 对非 string 类型的 key（list/hash/set/zset）必须报 WRONGTYPE，
        // 此前静默把整值覆盖成 string，丢数据且与真 Redis 行为不符。
        if (v && v.type !== 'string') throw new Error('WRONGTYPE Operation against a key holding the wrong kind of value');
        const prev = v ? v.val : '';
        this.db.set(args[0], { type: 'string', val: prev + args[1], ttl: v ? v.ttl : null });
        this._scheduleSnapshot();
        return Buffer.byteLength(this.db.get(args[0]).val, 'utf8');
      }
      case 'STRLEN': {
        const v = this._get(args[0]);
        if (!v) return 0;
        if (v.type !== 'string') throw new Error('WRONGTYPE Operation against a key holding the wrong kind of value');
        return Buffer.byteLength(v.val, 'utf8');
      }
      case 'INCR': case 'DECR': case 'INCRBY': case 'DECRBY': {
        const by = cmd === 'INCRBY' || cmd === 'DECRBY' ? parseRedisInt(args[1]) : 1;
        if (isNaN(by)) throw new Error('ERR value is not an integer or out of range');
        const dir = cmd === 'DECR' || cmd === 'DECRBY' ? -1 : 1;
        const v = this._get(args[0]);
        let n;
        if (!v) { n = 0; }
        else if (v.type === 'string' && /^-?\d+$/.test(v.val)) { n = parseInt(v.val, 10); }
        else throw new Error('ERR value is not an integer or out of range');
        n += dir * by;
        this.db.set(args[0], { type: 'string', val: String(n), ttl: v ? v.ttl : null });
        this._scheduleSnapshot();
        return n;
      }
      case 'DEL': {
        // #176：过期但尚未清理的键不应计入删除数
        let n = 0;
        for (const k of args) {
          if (!this._get(k)) continue;
          this.db.delete(k);
          n++;
        }
        this._scheduleSnapshot();
        return n;
      }
      case 'EXISTS': {
        // Redis：重复 key 只计一次
        let n = 0;
        for (const k of new Set(args)) if (this._get(k)) n++;
        return n;
      }
      case 'KEYS': {
        const pat = args[0];
        // #228：完整 glob（含 [abc]/[!abc]/[a-c]），与 Cache.keys 语义一致
        const re = globToRegex(pat);
        const keys = [];
        for (const k of this.db.keys()) {
          if (re.test(k) && this._get(k)) keys.push(k);
        }
        return keys;
      }
      case 'TYPE': {
        const v = this._get(args[0]);
        return v ? v.type : 'none';
      }
      case 'EXPIRE': {
        const v = this._get(args[0]);
        if (!v) return 0;
        const secs = parseRedisInt(args[1]);
        if (isNaN(secs)) throw new Error('ERR value is not an integer or out of range');
        v.ttl = Date.now() + secs * 1000;
        this._scheduleSnapshot();
        return 1;
      }
      case 'TTL': {
        const v = this._get(args[0]);
        if (!v) return -2;
        if (!v.ttl) return -1;
        return Math.max(0, Math.round((v.ttl - Date.now()) / 1000));
      }
      case 'PERSIST': {
        const v = this._get(args[0]);
        if (!v || !v.ttl) return 0;
        v.ttl = null;
        this._scheduleSnapshot();
        return 1;
      }
      case 'HSET': {
        if (args.length % 2 !== 1) throw new Error(`ERR wrong number of arguments for 'hset' command`);
        const v = this._get(args[0]);
        if (v && v.type !== 'hash') throw new Error('WRONGTYPE Operation against a key holding the wrong kind of value');
        const h = v ? { ...v.val } : {};
        let n = 0;
        for (let i = 1; i < args.length; i += 2) {
          // #226：in 会遍历原型链，必须只判断自有字段
          if (!Object.prototype.hasOwnProperty.call(h, args[i])) n++;
          h[args[i]] = args[i + 1];
        }
        this.db.set(args[0], { type: 'hash', val: h, ttl: v ? v.ttl : null });
        this._scheduleSnapshot();
        return n;
      }
      case 'HGET': {
        const v = this._get(args[0]);
        if (!v) return null;
        if (v.type !== 'hash') throw new Error('WRONGTYPE Operation against a key holding the wrong kind of value');
        return v.val[args[1]] === undefined ? null : v.val[args[1]];
      }
      case 'HGETALL': {
        const v = this._get(args[0]);
        if (!v) return [];
        if (v.type !== 'hash') throw new Error('WRONGTYPE Operation against a key holding the wrong kind of value');
        return Object.entries(v.val).flat();
      }
      case 'HDEL': {
        const v = this._get(args[0]);
        if (!v) return 0;
        if (v.type !== 'hash') throw new Error('WRONGTYPE Operation against a key holding the wrong kind of value');
        let n = 0;
        for (const f of args.slice(1)) if (v.val[f] !== undefined) { delete v.val[f]; n++; }
        // #173：最后一个 field 删除后整个键也要删除
        if (Object.keys(v.val).length === 0) this.db.delete(args[0]);
        this._scheduleSnapshot();
        return n;
      }
      case 'HEXISTS': {
        const v = this._get(args[0]);
        if (v && v.type !== 'hash') throw new Error('WRONGTYPE Operation against a key holding the wrong kind of value');
        return (v && v.val[args[1]] !== undefined) ? 1 : 0;
      }
      case 'HLEN': {
        const v = this._get(args[0]);
        if (v && v.type !== 'hash') throw new Error('WRONGTYPE Operation against a key holding the wrong kind of value');
        return v ? Object.keys(v.val).length : 0;
      }
      case 'HKEYS': {
        const v = this._get(args[0]);
        if (v && v.type !== 'hash') throw new Error('WRONGTYPE Operation against a key holding the wrong kind of value');
        return v ? Object.keys(v.val) : [];
      }
      case 'HVALS': {
        const v = this._get(args[0]);
        if (v && v.type !== 'hash') throw new Error('WRONGTYPE Operation against a key holding the wrong kind of value');
        return v ? Object.values(v.val) : [];
      }
      case 'LPUSH': case 'RPUSH': {
        const v = this._get(args[0]);
        if (v && v.type !== 'list') throw new Error('WRONGTYPE Operation against a key holding the wrong kind of value');
        const list = v ? [...v.val] : [];
        if (cmd === 'LPUSH') {
          for (const val of args.slice(1)) list.unshift(val);
        } else {
          for (const __e of args.slice(1)) list.push(__e);
        }
        this.db.set(args[0], { type: 'list', val: list, ttl: v ? v.ttl : null });
        this._scheduleSnapshot();
        return list.length;
      }
      case 'LPOP': case 'RPOP': {
        // N3-fix: 支持可选 count 参数（Redis 6.2+）。旧实现忽略 count，LPOP key 2 只弹 1 个。
        // 无 count：弹 1 个，key 不存在时返回 nil（bulk null）。
        // 有 count：返回数组（最多 count 个元素），key 不存在时返回空数组；count<0 报错。
        const hasCount = args.length >= 2;
        let count = 1;
        if (hasCount) {
          count = parseInt(args[1], 10);
          if (isNaN(count) || count < 0) throw new Error('ERR value is out of range, must be positive');
        }
        const v = this._get(args[0]);
        if (!v) return hasCount ? [] : null;
        if (v.type !== 'list') throw new Error('WRONGTYPE Operation against a key holding the wrong kind of value');
        const popped = [];
        for (let i = 0; i < count && v.val.length > 0; i++) {
          popped.push(cmd === 'LPOP' ? v.val.shift() : v.val.pop());
        }
        if (v.val.length === 0) this.db.delete(args[0]);
        this._scheduleSnapshot();
        if (hasCount) return popped;
        return popped.length ? popped[0] : null;
      }
      case 'LLEN': {
        const v = this._get(args[0]);
        if (!v) return 0;
        if (v.type !== 'list') throw new Error('WRONGTYPE Operation against a key holding the wrong kind of value');
        return v.val.length;
      }
      case 'LRANGE': {
        const v = this._get(args[0]);
        if (!v) return [];
        if (v.type !== 'list') throw new Error('WRONGTYPE Operation against a key holding the wrong kind of value');
        let start = parseRedisInt(args[1]), stop = parseRedisInt(args[2]);
        const len = v.val.length;
        if (start < 0) start = Math.max(0, len + start);
        if (stop < 0) stop = len + stop;
        if (start > stop || start >= len) return [];
        return v.val.slice(start, Math.min(stop + 1, len));
      }
      case 'LINDEX': {
        const v = this._get(args[0]);
        if (!v) return null;
        if (v.type !== 'list') throw new Error('WRONGTYPE Operation against a key holding the wrong kind of value');
        let i = parseRedisInt(args[1]);
        if (i < 0) i = v.val.length + i;
        return v.val[i] === undefined ? null : v.val[i];
      }
      case 'LREM': {
        const v = this._get(args[0]);
        if (!v) return 0;
        if (v.type !== 'list') throw new Error('WRONGTYPE Operation against a key holding the wrong kind of value');
        const count = parseRedisInt(args[1]);
        const target = args[2];
        const out = [];
        let removed = 0;
        if (count > 0) {
          // 从头删除
          const maxRemove = count;
          for (const el of v.val) {
            if (el === target && removed < maxRemove) { removed++; continue; }
            out.push(el);
          }
        } else if (count < 0) {
          // 从尾删除
          const maxRemove = Math.abs(count);
          for (let i = v.val.length - 1; i >= 0; i--) {
            if (v.val[i] === target && removed < maxRemove) { removed++; continue; }
            out.unshift(v.val[i]);
          }
        } else {
          // count === 0: 删除所有
          for (const el of v.val) {
            if (el === target) { removed++; continue; }
            out.push(el);
          }
        }
        v.val = out;
        // #173：列表删空后键也要删除
        if (out.length === 0) this.db.delete(args[0]);
        this._scheduleSnapshot();
        return removed;
      }
      case 'SADD': case 'SREM': {
        const v = this._get(args[0]);
        if (v && v.type !== 'set') throw new Error('WRONGTYPE Operation against a key holding the wrong kind of value');
        const set = v ? new Set(v.val) : new Set();
        let n = 0;
        for (const m of args.slice(1)) {
          if (cmd === 'SADD') { if (!set.has(m)) { set.add(m); n++; } }
          else { if (set.delete(m)) n++; }
        }
        if (set.size === 0) this.db.delete(args[0]);
        else this.db.set(args[0], { type: 'set', val: [...set], ttl: v ? v.ttl : null });
        this._scheduleSnapshot();
        return n;
      }
      case 'SMEMBERS': {
        const v = this._get(args[0]);
        if (v && v.type !== 'set') throw new Error('WRONGTYPE Operation against a key holding the wrong kind of value');
        return v ? [...v.val] : [];
      }
      case 'SISMEMBER': {
        const v = this._get(args[0]);
        if (v && v.type !== 'set') throw new Error('WRONGTYPE Operation against a key holding the wrong kind of value');
        return (v && v.val.includes(args[1])) ? 1 : 0;
      }
      case 'SCARD': {
        const v = this._get(args[0]);
        if (v && v.type !== 'set') throw new Error('WRONGTYPE Operation against a key holding the wrong kind of value');
        return v ? v.val.length : 0;
      }
      case 'ZADD': {
        const key = args[0];
        const v = this._get(key);
        if (v && v.type !== 'zset') throw new Error('WRONGTYPE Operation against a key holding the wrong kind of value');
        const rest = args.slice(1);
        if (rest.length % 2 !== 0) throw new Error('ERR syntax error');
        // #174：先完整校验所有 (score, member)，任一非法则整条命令不产生变更
        const zset = v ? { ...v.val } : {};
        let added = 0;
        for (let i = 0; i < rest.length; i += 2) {
          const score = parseRedisFloat(rest[i]);
          const member = rest[i + 1];
          if (!(member in zset)) added++;
          zset[member] = score;
        }
        this.db.set(key, { type: 'zset', val: zset, ttl: v ? v.ttl : null });
        this._scheduleSnapshot();
        return added;
      }
      case 'ZRANGE': {
        const v = this._get(args[0]);
        if (!v) return [];
        if (v.type !== 'zset') throw new Error('WRONGTYPE Operation against a key holding the wrong kind of value');
        const start = parseRedisInt(args[1]);
        const stop = parseRedisInt(args[2]);
        const withScores = args[3] && args[3].toUpperCase() === 'WITHSCORES';
        const entries = Object.entries(v.val).sort((a, b) => a[1] - b[1] || (a[0] < b[0] ? -1 : 1));
        const from = start < 0 ? Math.max(0, entries.length + start) : start;
        const to = stop < 0 ? entries.length + stop : stop;
        const out = [];
        for (let i = from; i <= to && i < entries.length; i++) {
          out.push(entries[i][0]);
          if (withScores) out.push(entries[i][1]);
        }
        return out;
      }
      case 'ZREVRANGE': {
        const v = this._get(args[0]);
        if (!v) return [];
        if (v.type !== 'zset') throw new Error('WRONGTYPE Operation against a key holding the wrong kind of value');
        const start = parseRedisInt(args[1]);
        const stop = parseRedisInt(args[2]);
        const withScores = args[3] && args[3].toUpperCase() === 'WITHSCORES';
        const entries = Object.entries(v.val).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? 1 : -1));
        const from = start < 0 ? Math.max(0, entries.length + start) : start;
        const to = stop < 0 ? entries.length + stop : stop;
        const out = [];
        for (let i = from; i <= to && i < entries.length; i++) {
          out.push(entries[i][0]);
          if (withScores) out.push(entries[i][1]);
        }
        return out;
      }
      case 'ZSCORE': {
        const v = this._get(args[0]);
        if (v && v.type !== 'zset') throw new Error('WRONGTYPE Operation against a key holding the wrong kind of value');
        if (!v || !(args[1] in v.val)) return null;
        // ZSCORE 的分数恒为 bulk string（含整数分数），不能落进 integer reply（#67）
        return String(v.val[args[1]]);
      }
      case 'ZCARD': {
        const v = this._get(args[0]);
        if (!v) return 0;
        if (v.type !== 'zset') throw new Error('WRONGTYPE Operation against a key holding the wrong kind of value');
        return Object.keys(v.val).length;
      }
      case 'ZREM': {
        const v = this._get(args[0]);
        if (!v) return 0;
        if (v.type !== 'zset') throw new Error('WRONGTYPE Operation against a key holding the wrong kind of value');
        let n = 0;
        for (const m of args.slice(1)) {
          if (m in v.val) { delete v.val[m]; n++; }
        }
        // #173：最后一个成员删除后键也要删除
        if (Object.keys(v.val).length === 0) this.db.delete(args[0]);
        this._scheduleSnapshot();
        return n;
      }
      case 'ZINCRBY': {
        const key = args[0];
        const inc = parseRedisFloat(args[1]);
        const v = this._get(key);
        let zset;
        if (v && v.type === 'zset') zset = v.val;
        else if (v) throw new Error('WRONGTYPE Operation against a key holding the wrong kind of value');
        else { this.db.set(key, { type: 'zset', val: {} }); zset = this.db.get(key).val; }
        const member = args[2];
        zset[member] = (zset[member] || 0) + inc;
        this._scheduleSnapshot();
        // 同 ZSCORE：分数用 bulk string 回复（#67）
        return String(zset[member]);
      }
      case 'MSET': {
        const rest = args;
        if (rest.length % 2 !== 0) throw new Error('ERR wrong number of arguments');
        for (let i = 0; i < rest.length; i += 2) this.db.set(rest[i], { type: 'string', val: rest[i + 1], ttl: null });
        this._scheduleSnapshot();
        return 'OK';
      }
      case 'MGET': {
        return args.map((k) => {
          const v = this._get(k);
          return v && v.type === 'string' ? v.val : null;
        });
      }
      case 'DBSIZE': {
        let count = 0;
        const now = Date.now();
        for (const [k, v] of this.db) {
          if (v.ttl && v.ttl <= now) { this.db.delete(k); continue; }
          count++;
        }
        return count;
      }
      case 'FLUSHALL':
        for (const map of this._dbs.values()) map.clear();
        this._scheduleSnapshot();
        return 'OK';
      case 'FLUSHDB':
        this.db.clear();
        this._scheduleSnapshot();
        return 'OK';
      case 'INFO': {
        const lines = [
          '# Server',
          'redis_version:7.0.0',
          'jsql_neo_version:' + require('../package.json').version,
          '# Memory',
          'used_memory:' + JSON.stringify([...this.db.values()]).length,
          '# Stats',
          'db_size:' + this.db.size,
          'connected_clients:1',
        ];
        return lines.join('\r\n') + '\r\n';
      }
      case 'QUIT': return 'OK';
      default: throw new Error(`ERR unknown command '${cmd}'`);
    }
  }

  /* ---------- RESP protocol ---------- */
  listen(cb) {
    this.server = net.createServer((socket) => this._handleSocket(socket));
    this.server.on('error', (err) => {
      if (this.onError) this.onError(err);
      else if (cb) cb(err);
    });
    this.server.listen(this.port, this.host, cb ? () => cb() : undefined);
    return this;
  }

  /** 供多协议嗅探复用：把 socket 交给 Redis 处理，可携带已缓冲的首包 */
  _handleSocket(socket, existing = '') {
    // 刻意不 setEncoding('utf8')：RESP 的 $N 是**字节**长度，
    // 转成字符串再按字符切片会把多字节 UTF-8（中文等）截断。
    let buf = Buffer.isBuffer(existing) ? existing : Buffer.from(String(existing || ''), 'utf8');
    this._authedSockets.set(socket, false);

    const drain = () => {
      for (;;) {
        let msg;
        try {
          msg = this._parse(buf);
        } catch (e) {
          // 协议错误：回复错误并丢弃缓冲，避免一直卡在同一段坏数据上
          this._send(socket, (e instanceof Error) ? e : new Error('ERR Protocol error'));
          buf = Buffer.alloc(0);
          return;
        }
        if (!msg) break;
        buf = buf.slice(msg.consumed);
        if (msg.ignore) continue;
        this._handle(socket, msg.cmd, msg.args);
      }
    };

    socket.on('data', (chunk) => {
      const next = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
      if (buf.length + next.length > this.maxBufferSize) {
        try { this._send(socket, new Error('ERR Protocol error: request buffer limit exceeded')); } catch (_) {}
        socket.destroy();
        return;
      }
      buf = Buffer.concat([buf, next]);
      drain();
    });
    socket.on('error', () => {});
    drain();
  }

  /**
   * 解析一条 RESP2 请求，返回 { consumed, cmd, args } 或 null（数据不完整）。
   * buf 是 Buffer —— 所有长度计算都按**字节**进行。
   */
  _parse(buf) {
    if (!buf || buf.length === 0) return null;
    const crlf = (from) => buf.indexOf('\r\n', from, 'utf8');

    // 非 '*' 开头：inline 命令（telnet / nc 手工输入）
    if (buf[0] !== 0x2a) {
      const i = crlf(0);
      if (i < 0) {
        if (buf.length > this.maxInlineLength) throw new Error('ERR Protocol error: too big inline request');
        return null;
      }
      if (i > this.maxInlineLength) throw new Error('ERR Protocol error: too big inline request');
      const line = buf.slice(0, i).toString('utf8').trim();
      if (!line) return { consumed: i + 2, ignore: true };
      const parts = line.split(/\s+/);
      // 之前这里返回的是数组（cmd.map(...)），导致 switch(cmd) 永远匹配不上，
      // inline 输入一律被当成 unknown command。必须是字符串。
      const cmd = parts[0].toUpperCase();
      return { consumed: i + 2, cmd, args: parts.slice(1) };
    }

    const i = crlf(0);
    if (i < 0) return null;
    const n = parseInt(buf.slice(1, i).toString('utf8'), 10);
    if (isNaN(n)) throw new Error('ERR Protocol error: invalid multibulk length');
    if (n > this.maxMultiBulkLength) throw new Error('ERR Protocol error: invalid multibulk length');
    // *0（空命令）与 *-1（null 数组）此前会走到 parts[0].toUpperCase() 崩溃
    if (n <= 0) return { consumed: i + 2, ignore: true };

    let off = i + 2;
    const parts = [];
    for (let k = 0; k < n; k++) {
      if (buf.length <= off) return null;
      if (buf[off] !== 0x24) throw new Error('ERR Protocol error: expected bulk string');   // '$'
      const j = crlf(off);
      if (j < 0) return null;
      const len = parseInt(buf.slice(off + 1, j).toString('utf8'), 10);
      if (isNaN(len)) throw new Error('ERR Protocol error: invalid bulk length');
      if (len > this.maxBulkLength) throw new Error('ERR Protocol error: invalid bulk length');
      const start = j + 2;
      if (len === -1) { parts.push(null); off = start; continue; }   // $-1 null bulk
      if (len < -1) throw new Error('ERR Protocol error: invalid bulk length');
      if (buf.length < start + len + 2) return null;                 // 按字节判断
      // #225：非法 UTF-8 字节用 latin1 保真，合法文本仍保持字符串
      parts.push(decodeBulk(buf.slice(start, start + len)));
      off = start + len + 2;
    }
    const cmd = String(parts[0] || '').toUpperCase();
    return { consumed: off, cmd, args: parts.slice(1) };
  }

  _handle(socket, cmd, args) {
    const idx = this._selected.get(socket);
    const prevDb = this.db;
    const prevSelected = this.selected;
    // execute() 是同步的，这里临时切换 this.db 实现每连接独立的 SELECT
    this.db = this._dbs.get(idx === undefined ? 0 : idx) || this._dbs.get(0);
    try {
      if (this.onQuery) this.onQuery(cmd, args);
      if (cmd === 'AUTH') {
        if (!this.password) return this._send(socket, new Error('ERR Client sent AUTH, but no password is set'));
      }
      if (this.password && !this._authedSockets.get(socket)) {
        if (cmd === 'AUTH') {
          const ok = this.execute('AUTH', args);
          if (ok === 'OK') {
            this._authedSockets.set(socket, true);
            socket.write('+OK\r\n');
          } else {
            this._send(socket, ok);
          }
          return;
        }
        return this._send(socket, new Error('NOAUTH Authentication required.'));
      }
      if (cmd === 'QUIT') { socket.write('+OK\r\n'); socket.end(); return; }
      if (cmd === 'GET') {
        const r = this.execute(cmd, args);
        if (r === null) {
          this._send(socket, null);
        } else {
          // GET 返回值必须是 bulk string，即使内容是 "OK" 或 "PONG"
          const buf = bulkToBuffer(r);
          socket.write(Buffer.concat([Buffer.from('$' + buf.length + '\r\n'), buf, Buffer.from('\r\n')]));
        }
        return;
      }
      const r = this.execute(cmd, args);
      if (cmd === 'SELECT' && r === 'OK') this._selected.set(socket, this.selected);
      // #177：只有命令级状态回复用 simple string；数据内容（ECHO/HGET/...）一律 bulk
      if (cmd === 'PING' && args.length === 0) {
        socket.write('+PONG\r\n');
      } else if (typeof r === 'string' && SIMPLE_STRING_CMDS.has(cmd)) {
        socket.write('+' + r + '\r\n');
      } else {
        this._send(socket, r);
      }
    } catch (e) {
      this._send(socket, e);
    } finally {
      // SELECT 需要把全局指针留在新库上，兼容直接调用 execute() 的旧用法
      if (cmd !== 'SELECT') {
        this.db = prevDb;
        this.selected = prevSelected;
      }
    }
  }

  _send(socket, val) {
    const CRLF = Buffer.from('\r\n');
    const bulk = (v) => {
      const b = bulkToBuffer(v);
      return Buffer.concat([Buffer.from('$' + b.length + '\r\n', 'latin1'), b, CRLF]);
    };
    let out;
    if (val instanceof Error) {
      out = Buffer.from('-' + val.message + '\r\n', 'utf8');
    } else if (val === null) {
      out = Buffer.from('$-1\r\n');
    } else if (typeof val === 'number') {
      // RESP integer reply 只能是十进制整数；小数必须走 bulk string（#67）。
      out = Number.isInteger(val)
        ? Buffer.from(':' + val + '\r\n')
        : bulk(val);
    } else if (Array.isArray(val)) {
      const parts = [Buffer.from('*' + val.length + '\r\n')];
      for (const v of val) {
        parts.push((v === null || v === undefined) ? Buffer.from('$-1\r\n') : bulk(v));
      }
      out = Buffer.concat(parts);
    } else if (typeof val === 'string') {
      // 由调用方决定是否 simple string；这里默认按数据 bulk 编码
      out = bulk(val);
    } else {
      out = Buffer.from('$-1\r\n');
    }
    socket.write(out);
  }
}

function createRedisServer(opts = {}) {
  return new RedisServer(opts);
}

module.exports = { RedisServer, createRedisServer };
