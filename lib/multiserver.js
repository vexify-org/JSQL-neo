/*
 * Multi-protocol multiplexing server for JSQL-NEO.
 *
 * Listens on ONE port and sniffs the first bytes of each connection to route
 * to the correct wire-protocol handler:
 *
 *   - PostgreSQL : first byte 0x00 (big-endian Int32 length, length < 2^24)
 *   - MySQL      : first byte 0x0a/0x0d (protocol handshake version / cap flag)
 *   - Redis      : anything else (ASCII command or RESP prefix)
 *
 * This lets every npm database client (mysql2, pg, ioredis, sequelize, knex,
 * typeorm, redis-cli, psql, phpMyAdmin ...) connect to the same endpoint.
 */
const net = require('net');
const fs = require('fs');
const path = require('path');
const Database = require('./database');
const { MysqlServer, MysqlConnection } = require('./mysql_server');
const { PgServer, PgConnection } = require('./pg_server');
const { RedisServer } = require('./redis_server');
const { MongoServer } = require('./mongo_server');

function sniffProtocol(buf) {
  if (buf.length < 1) return null;
  // MongoDB 先检查：opCode 校验更具体，避免消息长度为 256 倍数时
  // 首字节 0x00 被误判为 PG（PG 也用 0x00 开头）
  if (buf.length >= 16) {
    const opc = buf.readInt32LE(12);
    if (opc === 2012 || opc === 2013 || opc === 2004) {
      const len = buf.readInt32LE(0);
      if (len >= 16 && len <= 48 * 1024 * 1024) return 'mongo';
    }
  }
  const b = buf[0];
  if (b === 0x00) return 'pg';
  if (b === 0x0a || b === 0x0d) return 'mysql';
  return 'redis';
}

class MultiServer {
  constructor(options = {}) {
    this.options = options;
    this.port = options.port ?? 5432;
    this.host = options.host || '127.0.0.1';
    this.dataDir = options.dataDir || null;
    // 静默连接的兜底协议：MySQL 客户端等待服务器先发握手包，
    // 而空闲的 Redis 连接也不主动发包，只能按配置的二选一处理。
    this.idleProtocol = options.idleProtocol || 'mysql';
    this.sniffTimeout = options.sniffTimeout != null ? options.sniffTimeout : 200;
    // 共享 SQL 引擎：三种 SQL 协议读写同一份数据
    this._engines = new Map();
    const getEngine = async (dbName) => {
      const key = dbName || 'default';
      if (this._engines.has(key)) return this._engines.get(key);
      if (this.dataDir && this.dataDir !== ':memory:') {
        // 防止 PG/MySQL 传来的库名做路径穿越
        if (typeof key !== 'string' || !/^[A-Za-z0-9_$.\-]+$/.test(key) || key.includes('..') || key === '.') {
          const err = new Error(`Invalid database name '${key}'`);
          err.code = 1049;
          throw err;
        }
      }
      let engine;
      if (this.dataDir && this.dataDir !== ':memory:') {
        const dbPath = path.join(this.dataDir, key);
        let stat = null;
        try { stat = fs.statSync(dbPath); } catch (e) { /* not created yet */ }
        // 兼容旧版单文件库：目录模式会 EISDIR，文件模式会覆盖目录
        engine = stat && stat.isFile()
          ? new Database(dbPath, { autoSave: true })
          : new Database(dbPath, { mode: 'hybrid' });
      } else {
        engine = new Database(':memory:', { autoSave: false });
      }
      this._engines.set(key, engine);
      return engine;
    };
    // 三个底层服务器共享同一个数据目录（不各自 listen）
    const baseOpts = { ...options, port: 0, host: this.host };
    this.mysql = new MysqlServer(baseOpts);
    this.mysql._getEngine = getEngine;
    this.pg = new PgServer(baseOpts);
    this.pg._getEngine = getEngine;
    this.pg._engines = this._engines;
    this.redis = new RedisServer({ ...baseOpts });
    this.mongo = new MongoServer(baseOpts);
    this.mongo._getEngine = getEngine;

    // MySQL 的库级操作也必须走共享引擎，否则同一目录会被打开两次（split brain）
    const dbError = (message, code) => {
      const err = new Error(message);
      err.code = code;
      return err;
    };
    const dbDir = this.dataDir && this.dataDir !== ':memory:' ? path.resolve(this.dataDir) : null;
    const safeDbName = (name) => this.mysql._safeDbName(name);
    const dbPath = (name) => (dbDir && safeDbName(name) ? path.join(dbDir, name) : null);

    const getDatabase = async (name, opts = {}) => {
      if (!safeDbName(name)) throw dbError(`Unknown database '${name}'`, 1049);
      if (this._engines.has(name)) return this._engines.get(name);
      const dir = dbPath(name);
      if (dir && !fs.existsSync(dir)) {
        if (opts.autoCreate) fs.mkdirSync(dir, { recursive: true });
        else throw dbError(`Unknown database '${name}'`, 1049);
      }
      return getEngine(name);
    };

    this.mysql._getDatabase = getDatabase;
    this.mysql._dbExists = (name) => {
      if (this._engines.has(name)) return true;
      const dir = dbPath(name);
      return !!(dir && fs.existsSync(dir));
    };
    this.mysql.createDatabase = async (name, opts = {}) => {
      if (!safeDbName(name)) throw dbError(`Invalid database name '${name}'`, 1105);
      if (this._engines.has(name) || (dbPath(name) && fs.existsSync(dbPath(name)))) {
        if (opts.ifNotExists) return getDatabase(name);
        throw dbError(`Can't create database '${name}'; database exists`, 1007);
      }
      const dir = dbPath(name);
      if (dir) fs.mkdirSync(dir, { recursive: true });
      return getEngine(name);
    };
    this.mysql.dropDatabase = async (name, opts = {}) => {
      if (!safeDbName(name)) throw dbError(`Unknown database '${name}'`, 1049);
      const engine = this._engines.get(name);
      const dir = dbPath(name);
      const hasDir = !!(dir && fs.existsSync(dir));
      if (!engine && !hasDir) {
        if (opts.ifExists) return;
        throw dbError(`Can't drop database '${name}'; database doesn't exist`, 1008);
      }
      if (engine && typeof engine.stop === 'function') {
        try { await engine.stop(); } catch (e) { /* ignore */ }
      }
      this._engines.delete(name);
      this.mysql._databases.delete(name);
      if (hasDir) fs.rmSync(dir, { recursive: true, force: true });
    };
    this.mysql.listDatabases = async () => {
      const names = new Set(this._engines.keys());
      if (dbDir && fs.existsSync(dbDir)) {
        for (const n of fs.readdirSync(dbDir)) {
          const p = path.join(dbDir, n);
          try {
            if (fs.statSync(p).isDirectory() && safeDbName(n)) names.add(n);
          } catch (e) { /* ignore */ }
        }
      }
      if (names.size === 0) return ['jsql'];
      return Array.from(names).sort();
    };

    this._server = null;
    this._sockets = new Set();
  }

  listen(cb) {
    this._server = net.createServer((socket) => {
      this._sockets.add(socket);
      socket.on('error', () => {});
      socket.on('close', () => this._sockets.delete(socket));
      let first = Buffer.alloc(0);
      let routed = false;
      // MySQL 客户端会先等服务器握手包，不主动发字节；超时后按 idleProtocol 处理
      const t = setTimeout(() => {
        if (routed) return;
        routed = true;
        socket.removeListener('data', sniff);
        try { this._route(socket, first); } catch (e) { socket.destroy(); }
      }, this.sniffTimeout);
      t.unref();
      const sniff = (chunk) => {
        first = Buffer.concat([first, chunk]);
        if (routed) return;
        if (first.length < 4) return; // 等至少 4 字节再判断
        routed = true;
        clearTimeout(t);
        socket.removeListener('data', sniff);
        try {
          this._route(socket, first);
        } catch (e) {
          socket.destroy();
        }
      };
      socket.on('data', sniff);
    });
    this._server.listen(this.port, this.host, cb || (() => {}));
    this._server.on('error', (err) => {
      if (this.options.onError) this.options.onError(err);
      else if (cb) cb(err);
      else console.error('[jsql-neo] multi-protocol server error:', err.message);
    });
    return this;
  }

  _route(socket, first) {
    const proto = sniffProtocol(first) || this.idleProtocol;
    if (proto === 'mysql') {
      const conn = new MysqlConnection(socket, this.mysql);
      conn._onData(first);
    } else if (proto === 'pg') {
      const conn = new PgConnection(socket, this.pg);
      conn._onData(first);
    } else if (proto === 'mongo') {
      this.mongo._handleSocket(socket, first);
    } else {
      this.redis._handleSocket(socket, first.toString('utf8'));
    }
  }

  get address() {
    return this._server ? this._server.address() : null;
  }

  close(cb) {
    for (const s of this._sockets) s.destroy();
    const stops = [];
    for (const engine of this._engines.values()) {
      if (engine && typeof engine.stop === 'function') stops.push(engine.stop());
    }
    const done = () => { if (this._server) { this._server.close(cb || (() => {})); this._server = null; } else if (cb) cb(); };
    if (stops.length > 0) Promise.allSettled(stops).then(done);
    else done();
    return this;
  }
}

function createMultiServer(options) {
  return new MultiServer(options || {});
}

module.exports = { MultiServer, createMultiServer, sniffProtocol };