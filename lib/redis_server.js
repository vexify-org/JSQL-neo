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

const TYPE_SIGNATURES = {
  PING: 0, ECHO: 1, SET: 2, SETNX: 2, GET: 1, DEL: -1, EXISTS: -1, KEYS: 1,
  TYPE: 1, EXPIRE: 2, TTL: 1, PERSIST: 1,
  INCR: 1, DECR: 1, INCRBY: 2, DECRBY: 2, APPEND: 2, STRLEN: 1,
  HSET: -3, HGET: 2, HGETALL: 1, HDEL: -2, HEXISTS: 2, HLEN: 1, HKEYS: 1, HVALS: 1,
  LPUSH: -2, RPUSH: -2, LPOP: 1, RPOP: 1, LLEN: 1, LRANGE: 3, LINDEX: 2, LREM: 3,
  SADD: -2, SREM: -2, SMEMBERS: 1, SISMEMBER: 2, SCARD: 1,
  DBSIZE: 0, FLUSHALL: 0, FLUSHDB: 0, SELECT: 1, INFO: 0, AUTH: 1, QUIT: 0,
};

class RedisServer {
  constructor(opts = {}) {
    this.port = opts.port || 6379;
    this.host = opts.host || '127.0.0.1';
    this.password = opts.password || null;
    this.dataDir = opts.dataDir || null;
    this.onQuery = opts.onQuery || null;
    this.db = new Map();
    this.snapshotTimer = null;
    this._load();
  }

  snapshotPath() {
    return this.dataDir ? path.join(this.dataDir, 'data.rdb.json') : null;
  }

  _load() {
    const p = this.snapshotPath();
    if (!p || !fs.existsSync(p)) return;
    try {
      const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
      for (const [k, v] of Object.entries(raw)) this.db.set(k, v);
    } catch (_) {}
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
    const out = {};
    const now = Date.now();
    for (const [k, v] of this.db) {
      if (v.ttl && v.ttl <= now) continue;
      out[k] = v;
    }
    const tmp = p + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(out));
    fs.renameSync(tmp, p);
  }

  stop() {
    if (this.snapshotTimer) clearTimeout(this.snapshotTimer);
    this._snapshot();
    if (this.server) this.server.close();
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
    if (sig > 0 && args.length < sig) throw new Error(`ERR wrong number of arguments for '${cmd}' command`);
    if (sig === -1 && args.length < 1) throw new Error(`ERR wrong number of arguments for '${cmd}' command`);
    switch (cmd) {
      case 'PING': return args.length ? args[0] : 'PONG';
      case 'ECHO': return args[0];
      case 'AUTH':
        if (!this.password) throw new Error('ERR Client sent AUTH, but no password is set');
        if (args[0] !== this.password) throw new Error('ERR invalid password');
        return 'OK';
      case 'SELECT':
        if (!/^\d+$/.test(args[0])) throw new Error(`ERR invalid DB index`);
        this.selected = parseInt(args[0], 10);
        return 'OK';
      case 'SET': {
        const prev = this._get(args[0]);
        this.db.set(args[0], { type: 'string', val: args[1], ttl: null });
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
        const v = this._get(args[0]);
        const prev = v && v.type === 'string' ? v.val : '';
        this.db.set(args[0], { type: 'string', val: prev + args[1], ttl: v ? v.ttl : null });
        this._scheduleSnapshot();
        return this.db.get(args[0]).val.length;
      }
      case 'STRLEN': {
        const v = this._get(args[0]);
        if (!v) return 0;
        if (v.type !== 'string') throw new Error('WRONGTYPE Operation against a key holding the wrong kind of value');
        return v.val.length;
      }
      case 'INCR': case 'DECR': case 'INCRBY': case 'DECRBY': {
        const by = cmd === 'INCRBY' || cmd === 'DECRBY' ? parseInt(args[1], 10) : 1;
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
        let n = 0;
        for (const k of args) if (this.db.delete(k)) n++;
        this._scheduleSnapshot();
        return n;
      }
      case 'EXISTS': {
        let n = 0;
        for (const k of args) if (this._get(k)) n++;
        return n;
      }
      case 'KEYS': {
        const pat = args[0];
        const re = new RegExp('^' + pat.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
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
        v.ttl = Date.now() + parseInt(args[1], 10) * 1000;
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
        return 1;
      }
      case 'HSET': {
        if (args.length % 2 !== 1) throw new Error(`ERR wrong number of arguments for 'hset' command`);
        const v = this._get(args[0]);
        const h = (v && v.type === 'hash') ? { ...v.val } : {};
        let n = 0;
        for (let i = 1; i < args.length; i += 2) {
          if (!(args[i] in h)) n++;
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
        this._scheduleSnapshot();
        return n;
      }
      case 'HEXISTS': {
        const v = this._get(args[0]);
        return (v && v.type === 'hash' && v.val[args[1]] !== undefined) ? 1 : 0;
      }
      case 'HLEN': {
        const v = this._get(args[0]);
        return v && v.type === 'hash' ? Object.keys(v.val).length : 0;
      }
      case 'HKEYS': {
        const v = this._get(args[0]);
        return v && v.type === 'hash' ? Object.keys(v.val) : [];
      }
      case 'HVALS': {
        const v = this._get(args[0]);
        return v && v.type === 'hash' ? Object.values(v.val) : [];
      }
      case 'LPUSH': case 'RPUSH': {
        const v = this._get(args[0]);
        const list = (v && v.type === 'list') ? [...v.val] : [];
        if (cmd === 'LPUSH') list.unshift(...args.slice(1));
        else list.push(...args.slice(1));
        this.db.set(args[0], { type: 'list', val: list, ttl: v ? v.ttl : null });
        this._scheduleSnapshot();
        return list.length;
      }
      case 'LPOP': case 'RPOP': {
        const v = this._get(args[0]);
        if (!v) return null;
        if (v.type !== 'list') throw new Error('WRONGTYPE Operation against a key holding the wrong kind of value');
        const el = cmd === 'LPOP' ? v.val.shift() : v.val.pop();
        this._scheduleSnapshot();
        return el === undefined ? null : el;
      }
      case 'LLEN': {
        const v = this._get(args[0]);
        return v && v.type === 'list' ? v.val.length : 0;
      }
      case 'LRANGE': {
        const v = this._get(args[0]);
        if (!v) return [];
        if (v.type !== 'list') throw new Error('WRONGTYPE Operation against a key holding the wrong kind of value');
        let start = parseInt(args[1], 10), stop = parseInt(args[2], 10);
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
        let i = parseInt(args[1], 10);
        if (i < 0) i = v.val.length + i;
        return v.val[i] === undefined ? null : v.val[i];
      }
      case 'LREM': {
        const v = this._get(args[0]);
        if (!v) return 0;
        if (v.type !== 'list') throw new Error('WRONGTYPE Operation against a key holding the wrong kind of value');
        const count = parseInt(args[1], 10);
        const target = args[2];
        const out = [];
        let removed = 0;
        const remaining = Math.abs(count);
        for (const el of v.val) {
          if (el === target && (count === 0 || removed < remaining)) { removed++; continue; }
          out.push(el);
        }
        v.val = out;
        this._scheduleSnapshot();
        return removed;
      }
      case 'SADD': case 'SREM': {
        const v = this._get(args[0]);
        const set = (v && v.type === 'set') ? new Set(v.val) : new Set();
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
        return v && v.type === 'set' ? [...v.val] : [];
      }
      case 'SISMEMBER': {
        const v = this._get(args[0]);
        return (v && v.type === 'set' && v.val.includes(args[1])) ? 1 : 0;
      }
      case 'SCARD': {
        const v = this._get(args[0]);
        return v && v.type === 'set' ? v.val.length : 0;
      }
      case 'DBSIZE': return this.db.size;
      case 'FLUSHALL': case 'FLUSHDB':
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
  listen() {
    this.server = net.createServer((socket) => {
      let buf = Buffer.alloc(0);
      socket.setEncoding('utf8');
      socket.on('data', (chunk) => {
        buf += chunk;
        for (;;) {
          const msg = this._parse(buf);
          if (!msg) break;
          buf = buf.slice(msg.consumed);
          this._handle(socket, msg.cmd, msg.args);
        }
      });
      socket.on('error', () => {});
    });
    this.server.listen(this.port, this.host);
    return this;
  }

  _parse(buf) {
    if (buf[0] !== '*') {
      const i = buf.indexOf('\r\n');
      if (i < 0) return null;
      const cmd = buf.slice(0, i).trim().split(/\s+/);
      if (!cmd.length) return null;
      return { consumed: i + 2, cmd: cmd.map(c => c.toUpperCase()), args: cmd.slice(1) };
    }
    const i = buf.indexOf('\r\n');
    if (i < 0) return null;
    const n = parseInt(buf.slice(1, i), 10);
    if (isNaN(n)) throw new Error('ERR Protocol error');
    let off = i + 2;
    const parts = [];
    for (let k = 0; k < n; k++) {
      if (buf[off] !== '$') throw new Error('ERR Protocol error: expected bulk string');
      const j = buf.indexOf('\r\n', off);
      if (j < 0) return null;
      const len = parseInt(buf.slice(off + 1, j), 10);
      if (isNaN(len)) throw new Error('ERR Protocol error');
      if (buf.length < j + 2 + len + 2) return null;
      parts.push(buf.slice(j + 2, j + 2 + len));
      off = j + 2 + len + 2;
    }
    const cmd = parts[0].toUpperCase();
    return { consumed: off, cmd, args: parts.slice(1) };
  }

  _handle(socket, cmd, args) {
    try {
      if (this.onQuery) this.onQuery(cmd, args);
      if (cmd === 'AUTH') {
        if (!this.password) return this._send(socket, -new Error('ERR Client sent AUTH, but no password is set'));
      }
      if (this.password && !this._authed) {
        if (cmd === 'AUTH') { const ok = this.execute('AUTH', args); this._authed = ok === 'OK'; return this._send(socket, ok); }
        return this._send(socket, -new Error('NOAUTH Authentication required.'));
      }
      if (cmd === 'QUIT') { this._send(socket, 'OK'); socket.end(); return; }
      const r = this.execute(cmd, args);
      this._send(socket, r);
    } catch (e) {
      this._send(socket, -e);
    }
  }

  _send(socket, val) {
    let out;
    if (val instanceof Error) {
      out = '-' + val.message + '\r\n';
    } else if (val === null) {
      out = '$-1\r\n';
    } else if (typeof val === 'number') {
      out = ':' + val + '\r\n';
    } else if (Array.isArray(val)) {
      out = '*' + val.length + '\r\n' + val.map(v => '$' + String(v).length + '\r\n' + v + '\r\n').join('');
    } else if (typeof val === 'string') {
      if (val === 'OK' || val === 'PONG') {
        out = '+' + val + '\r\n';
      } else {
        out = '$' + Buffer.byteLength(val, 'utf8') + '\r\n' + val + '\r\n';
      }
    } else {
      out = '$-1\r\n';
    }
    socket.write(out);
  }
}

function createRedisServer(opts = {}) {
  return new RedisServer(opts);
}

module.exports = { RedisServer, createRedisServer };
