/* ---- 回归：#455 / #456 / #457 / #458 / #459 ---- */
/*
 * #455 Database#importCSV 第二条 CSV 路径不再把非数值整数静默置 0、非真值布尔静默置 false。
 * #456 MultiServer 收满 16 字节（或嗅探超时）前不提交路由，Mongo 分片/短首包不误判到 Redis。
 * #457 COM_RESET_CONNECTION 释放预处理语句句柄并复位会话状态，旧 stmtId EXECUTE 报 1243。
 * #458 INCR/DECR/INCRBY/DECRBY 对非字符串键回 WRONGTYPE，非整数字符串仍回整数格式错误。
 * #459 查询游标绑定创建连接，另一连接 getMore 回 43 cursorNotFound。
 *
 * 全部走真实 socket / 公共 API：MySQL 手拼二进制帧，Redis 走 RESP，Mongo 走 OP_MSG，
 * MultiServer 走真实 TCP 连接嗅探；不直接调用私有类做断言。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const jsql = require(path.join(ROOT, 'index.js'));
const { createMysqlServer } = require(path.join(ROOT, 'lib', 'mysql_server.js'));
const { createRedisServer } = require(path.join(ROOT, 'lib', 'redis_server.js'));
const { createMongoServer, bsonDocument, bsonReadDocument } = require(path.join(ROOT, 'lib', 'mongo_server.js'));
const { createMultiServer } = require(path.join(ROOT, 'lib', 'multiserver.js'));

let passed = 0, failed = 0;
async function t(name, fn) {
  try { await fn(); passed++; console.log(`ok - ${name}`); }
  catch (e) { failed++; console.error(`not ok - ${name}\n  ${e && e.stack || e}`); }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function connect(port) {
  return new Promise((resolve, reject) => {
    const s = net.connect(port, '127.0.0.1', () => resolve(s));
    s.on('error', reject);
  });
}

function readSome(socket, ms = 1200) {
  return new Promise((resolve) => {
    const chunks = [];
    const done = () => { clearTimeout(t); socket.removeListener('data', onData); resolve(Buffer.concat(chunks)); };
    const onData = (c) => chunks.push(c);
    const t = setTimeout(done, ms);
    socket.on('data', onData);
  });
}

/* ---------- Redis RESP 客户端 ---------- */
function redisFrame(args) {
  const parts = args.map((a) => {
    const b = Buffer.from(String(a));
    return '$' + b.length + '\r\n' + b + '\r\n';
  });
  return Buffer.from('*' + args.length + '\r\n' + parts.join(''));
}
function redisCall(srv, args) {
  return new Promise((resolve) => {
    const port = srv.server.address().port;
    const sock = net.connect(port, '127.0.0.1');
    const chunks = [];
    let timer;
    const done = () => { clearTimeout(timer); resolve(Buffer.concat(chunks).toString('utf8')); sock.end(); };
    sock.on('connect', () => sock.write(redisFrame(args)));
    sock.on('data', (c) => { chunks.push(c); clearTimeout(timer); timer = setTimeout(done, 30); });
    sock.on('error', () => { clearTimeout(timer); resolve(''); });
  });
}

/* ---------- Mongo OP_MSG 客户端 ---------- */
function mongoOpMsg(doc) {
  const p = bsonDocument(doc);
  const head = Buffer.alloc(16);
  head.writeInt32LE(16 + 4 + 1 + p.length, 0);
  head.writeInt32LE(1, 4);
  head.writeInt32LE(0, 8);
  head.writeInt32LE(2013, 12);
  return Buffer.concat([head, Buffer.alloc(4), Buffer.from([0]), p]);
}
function mongoOn(sock, doc) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const onData = (c) => {
      chunks.push(c);
      const buf = Buffer.concat(chunks);
      if (buf.length >= 16 && buf.length >= buf.readInt32LE(0)) {
        sock.removeListener('data', onData);
        try { resolve(bsonReadDocument(buf.slice(21), 0).value); }
        catch (e) { reject(e); }
      }
    };
    sock.on('data', onData);
    sock.write(mongoOpMsg(doc));
  });
}

/* ---------- MySQL 二进制帧客户端 ---------- */
function mysqlFrame(payload, seq) {
  const h = Buffer.alloc(4);
  h.writeUIntLE(payload.length, 0, 3);
  h[3] = seq & 0xff;
  return Buffer.concat([h, payload]);
}
class RawMysql {
  constructor(sock) {
    this.sock = sock;
    this.buf = Buffer.alloc(0);
    this.packets = [];
    this.waiters = [];
    sock.on('data', (c) => {
      this.buf = Buffer.concat([this.buf, c]);
      for (;;) {
        if (this.buf.length < 4) break;
        const len = this.buf.readUIntLE(0, 3);
        if (this.buf.length < 4 + len) break;
        this.packets.push(this.buf.slice(4, 4 + len));
        this.buf = this.buf.slice(4 + len);
        const w = this.waiters.shift();
        if (w) w();
      }
    });
  }
  next() {
    return new Promise((res) => {
      if (this.packets.length) return res(this.packets.shift());
      this.waiters.push(() => res(this.packets.shift()));
    });
  }
  send(payload, seq = 0) { this.sock.write(mysqlFrame(payload, seq)); }
  command(cmdByte, body, seq = 0) {
    this.send(Buffer.concat([Buffer.from([cmdByte]), body || Buffer.alloc(0)]), seq);
  }
}

(async () => {
  // ================= #455 CSV 静默类型转换 =================
  await t('#455 非法整数/布尔不再静默置 0/false，warnings 可观测；合法值与空值语义不变', async () => {
    const file = path.join(os.tmpdir(), `jsql-455-${Date.now()}-${Math.random().toString(36).slice(2)}.csv`);
    fs.writeFileSync(file, 'id,big,flag,note\n1,abc,maybe,x\n2,10,true,y\n3,20,false,z\n', 'utf8');
    try {
      const db = new jsql.Database(':memory:');
      await db.query('CREATE TABLE t (id INTEGER PRIMARY KEY, big INTEGER, flag BOOLEAN, note TEXT)', { safety: false });
      const res = db.importCSV(file, 't');

      assert.strictEqual(res.count, 2, '仅两行合法数据入库');
      assert.ok(Array.isArray(res.warnings) && res.warnings.length >= 1, '脏行必须带回 warnings');

      const rows = await db.find('t', {}, {});
      assert.deepStrictEqual(rows.map((r) => r.id), [2, 3], '脏行 id=1 不得落库');
      const r2 = rows.find((r) => r.id === 2);
      assert.strictEqual(r2.big, 10);
      assert.strictEqual(r2.flag, true);
      const r3 = rows.find((r) => r.id === 3);
      assert.strictEqual(r3.big, 20);
      assert.strictEqual(r3.flag, false);
      // 脏值不得伪装成 0 / false 落库
      assert.ok(!rows.some((r) => r.id === 1 && r.big === 0 && r.flag === false));
      db.stop();

      // strict 模式：不可解析的类型值直接抛错，不降级落库
      const db2 = new jsql.Database(':memory:');
      await db2.query('CREATE TABLE s (id INTEGER PRIMARY KEY, big INTEGER)', { safety: false });
      let err = null;
      try { db2.importCSV(file, 's', { strict: true }); } catch (e) { err = e; }
      assert.ok(err, 'strict: true 时非法整数应抛类型错误');
      db2.stop();
    } finally {
      fs.rmSync(file, { force: true });
    }
  });

  // ================= #456 MultiServer 16 字节嗅探 =================
  await t('#456 Mongo 分片首包（4 字节前缀）不误判到 Redis；RESP 连接仍落 Redis', async () => {
    const calls = { mongo: 0, redis: 0 };
    const srv = createMultiServer({ port: 0, host: '127.0.0.1', dataDir: ':memory:', noAuth: true });
    await new Promise((r) => srv.listen(r));
    try {
      const origMongo = srv.mongo._handleSocket.bind(srv.mongo);
      const origRedis = srv.redis._handleSocket.bind(srv.redis);
      srv.mongo._handleSocket = (s, f) => { calls.mongo++; return origMongo(s, f); };
      srv.redis._handleSocket = (s, f) => { calls.redis++; return origRedis(s, f); };

      // Mongo OP_MSG hello：先只发前 4 字节长度，滞留片刻后再发剩余帧
      const hello = mongoOpMsg({ hello: 1, helloOk: true, $db: 'admin' });
      const s1 = await connect(srv.address.port);
      s1.write(hello.slice(0, 4));
      await sleep(80); // 4–15 字节阶段不得提前提交路由
      s1.write(hello.slice(4));
      const reply1 = await readSome(s1, 1500);
      s1.end();

      assert.strictEqual(calls.mongo, 1, 'Mongo 分片首包必须落到 mongo 处理器');
      assert.strictEqual(calls.redis, 0, '不得误判到 redis 处理器');
      assert.ok(reply1.length >= 16 && reply1.readInt32LE(12) === 2013, 'Mongo hello 应回 OP_MSG');

      // 对照：真实 RESP PING 连接仍走 Redis
      const s2 = await connect(srv.address.port);
      s2.write(Buffer.from('PING\r\n'));
      const reply2 = await readSome(s2, 1000);
      s2.end();
      assert.ok(reply2.toString('utf8').startsWith('+PONG'), reply2.toString());
      assert.strictEqual(calls.redis, 1, 'RESP 连接应落到 redis 处理器');
    } finally {
      await new Promise((r) => srv.close(r));
    }
  });

  // ================= #457 COM_RESET_CONNECTION =================
  await t('#457 RESET_CONNECTION 后旧 stmtId EXECUTE 报 1243；连接仍可用、可重新 PREPARE', async () => {
    const srv = createMysqlServer({ port: 0, host: '127.0.0.1', noAuth: true, dataDir: ':memory:', safety: false });
    await new Promise((r) => srv.listen(r));
    let sock;
    try {
      sock = net.connect(srv.address.port, '127.0.0.1');
      const client = new RawMysql(sock);
      await client.next(); // 服务器握手包

      // 极简登录包：caps=0，无 secure connection，无默认库；noAuth 下放行
      const head = Buffer.alloc(32);
      head[8] = 0x2d;
      const auth = Buffer.concat([head, Buffer.from('u\0', 'utf8'), Buffer.from([0])]);
      client.send(auth, 0);
      const authRes = await client.next();
      assert.strictEqual(authRes[0], 0x00, '登录应回 OK');

      const q1 = client.command(0x03, Buffer.from('CREATE TABLE r1 (id INT PRIMARY KEY, v TEXT NOT NULL)', 'utf8'));
      const createRes = await client.next();
      assert.notStrictEqual(createRes[0], 0xff, '建表成功');
      client.command(0x03, Buffer.from("INSERT INTO r1 (id,v) VALUES (1,'a')", 'utf8'));
      const insertRes = await client.next();
      assert.notStrictEqual(insertRes[0], 0xff, '插入成功');

      client.command(0x16, Buffer.from('SELECT v FROM r1 WHERE id = ?', 'utf8'));
      const prep = await client.next();
      assert.strictEqual(prep[0], 0x00, 'PREPARE 成功');
      const stmtId = prep.readUInt32LE(1);
      const numParams = prep.readUInt16LE(7);
      const numColumns = prep.readUInt16LE(5);
      // 排空 PREPARE 后续的参数定义 / 列定义 / EOF 包，避免堵在复位响应前
      for (let i = 0; i < numParams; i++) await client.next();
      if (numParams > 0) await client.next();
      for (let i = 0; i < numColumns; i++) await client.next();
      if (numColumns > 0) await client.next();

      // COM_RESET_CONNECTION
      client.command(0x1f, Buffer.alloc(0));
      const resetRes = await client.next();
      assert.strictEqual(resetRes[0], 0x00, 'RESET 回 OK');

      // 旧 stmtId EXECUTE：必须回 1243 ER_UNKNOWN_STMT_HANDLER
      const execBody = Buffer.alloc(9);
      execBody.writeUInt32LE(stmtId, 0);
      client.command(0x17, execBody);
      const execRes = await client.next();
      assert.strictEqual(execRes[0], 0xff, '旧句柄应回 ERR 包');
      assert.strictEqual(execRes.readUInt16LE(1), 1243, '错误码应为 1243');

      // 连接仍可用：COM_PING 回 OK（单包，不遗留结果集帧）
      client.command(0x0e);
      const pingRes = await client.next();
      assert.strictEqual(pingRes[0], 0x00, 'reset 后连接仍响应 PING');

      // 可重新 PREPARE 新语句
      client.command(0x16, Buffer.from('SELECT v FROM r1', 'utf8'));
      const prep2 = await client.next();
      assert.strictEqual(prep2[0], 0x00, 'reset 后可重新 PREPARE');
    } finally {
      if (sock) sock.end();
      await new Promise((r) => srv.close(r));
    }
  });

  // ================= #458 Redis WRONGTYPE =================
  await t('#458 INCR/DECR/INCRBY/DECRBY 对 hash/list/set/zset 回 WRONGTYPE；非整数字符串回整数错误', async () => {
    const srv = createRedisServer({ port: 0, dataDir: null });
    await new Promise((r) => srv.listen(r));
    try {
      await redisCall(srv, ['HSET', 'h', 'f', '1']);
      await redisCall(srv, ['RPUSH', 'l', 'a']);
      await redisCall(srv, ['SADD', 's', 'x']);
      await redisCall(srv, ['ZADD', 'z', '1', 'm']);

      const wrongTypeCases = [
        ['INCR', 'h'],
        ['INCRBY', 'l', '2'],
        ['DECR', 'h'],
        ['DECRBY', 'l', '1'],
        ['INCR', 's'],
        ['INCR', 'z'],
      ];
      for (const args of wrongTypeCases) {
        const reply = await redisCall(srv, args);
        assert.ok(reply.startsWith('-WRONGTYPE Operation against a key holding the wrong kind of value'),
          `${args.join(' ')} 应回 WRONGTYPE，实际: ${JSON.stringify(reply)}`);
      }

      // 字符串键但值非整数：仍回整数格式错误，不能降级成 WRONGTYPE
      await redisCall(srv, ['SET', 'str', 'abc']);
      const badInt = await redisCall(srv, ['INCR', 'str']);
      assert.ok(badInt.includes('value is not an integer or out of range'), badInt);

      // 数字字符串与缺失键行为不变
      await redisCall(srv, ['SET', 'num', '10']);
      const inc = await redisCall(srv, ['INCR', 'num']);
      assert.strictEqual(inc, ':11\r\n', inc);
      const miss = await redisCall(srv, ['DECRBY', 'fresh', '3']);
      assert.strictEqual(miss, ':-3\r\n', miss);
    } finally {
      srv.stop();
    }
  });

  // ================= #459 Mongo 游标连接归属 =================
  await t('#459 跨连接 getMore 回 43 cursorNotFound；原连接仍可取完剩余批次', async () => {
    const srv = createMongoServer({ dataDir: ':memory:' });
    await new Promise((r) => srv.listen(r));
    let sockA, sockB;
    try {
      const port = srv._server.address().port;
      sockA = net.connect(port, '127.0.0.1');
      await mongoOn(sockA, { insert: 'c', documents: [
        { _id: 1 }, { _id: 2 }, { _id: 3 }, { _id: 4 }, { _id: 5 },
      ], $db: 'test' });
      const f = await mongoOn(sockA, { find: 'c', filter: {}, batchSize: 2, $db: 'test' });
      const cid = f.cursor.id;
      assert.ok(cid, 'find 应生成非零游标 id');

      // 另一连接 getMore：必须 43 cursorNotFound
      sockB = net.connect(port, '127.0.0.1');
      const cross = await mongoOn(sockB, { getMore: cid, collection: 'c', $db: 'test' });
      assert.strictEqual(cross.ok, 0, JSON.stringify(cross));
      assert.strictEqual(cross.code, 43, '跨连接 getMore 应回 43');

      // 原连接仍可取剩余批次
      const same = await mongoOn(sockA, { getMore: cid, collection: 'c', $db: 'test' });
      assert.strictEqual(same.ok, 1, JSON.stringify(same));
      assert.strictEqual(same.cursor.nextBatch.length, 2, same.cursor.nextBatch);
    } finally {
      if (sockA) sockA.end();
      if (sockB) sockB.end();
      srv.close();
    }
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
