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
const path = require('path');
const Database = require('./database');
const { MysqlServer, MysqlConnection } = require('./mysql_server');
const { PgServer, PgConnection } = require('./pg_server');
const { RedisServer } = require('./redis_server');
const { MongoServer } = require('./mongo_server');

function sniffProtocol(buf) {
  if (buf.length < 1) return null;
  const b = buf[0];
  if (b === 0x00) return 'pg';
  if (b === 0x0a || b === 0x0d) return 'mysql';
  // MongoDB: header 前 4 字节 = int32LE 长度，第 13 字节 = opCode(OP_QUERY 2004 / OP_COMPRESSED 2012 / OP_MSG 2013)
  if (buf.length >= 16) {
    const opc = buf.readInt32LE(12);
    if (opc === 2012 || opc === 2013 || opc === 2004) {
      const len = buf.readInt32LE(0);
      if (len >= 16 && len <= 48 * 1024 * 1024) return 'mongo';
    }
  }
  return 'redis';
}

class MultiServer {
  constructor(options = {}) {
    this.options = options;
    this.port = options.port || 5432;
    this.host = options.host || '127.0.0.1';
    this.dataDir = options.dataDir || null;
    // 共享 SQL 引擎：三种 SQL 协议读写同一份数据
    this._engines = new Map();
    const getEngine = async (dbName) => {
      const key = dbName || 'default';
      if (this._engines.has(key)) return this._engines.get(key);
      let engine;
      if (this.dataDir && this.dataDir !== ':memory:') {
        engine = new Database(path.join(this.dataDir, key), { autoSave: true });
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
    this.redis = new RedisServer({ ...baseOpts });
    this.mongo = new MongoServer(baseOpts);
    this.mongo._getEngine = getEngine;
    this._server = null;
    this._sockets = new Set();
  }

  listen(cb) {
    this._server = net.createServer((socket) => {
      this._sockets.add(socket);
      socket.on('close', () => this._sockets.delete(socket));
      let first = Buffer.alloc(0);
      let routed = false;
      // MySQL 客户端会先等服务器握手包，不主动发字节；超时后按 MySQL 处理
      const t = setTimeout(() => {
        if (!routed) { routed = true; socket.removeListener('data', sniff); this._route(socket, first); }
      }, 200);
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
      else throw err;
    });
    return this;
  }

  _route(socket, first) {
    const proto = sniffProtocol(first) || 'mysql'; // 无字节（MySQL 客户端等握手）→ 按 MySQL 处理
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