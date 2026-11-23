/* ---- 回归：#395 / #396 / #413 / #428 / #430 ---- */
/*
 * #395 Redis MGET 遇 hash/list/set/zset 键静默回 nil，应整条回 WRONGTYPE。
 * #396 BSON Int64 回读降级 Number 丢精度；编码器不认 $numberLong，$long 越界裸 RangeError。
 * #413 $rename 源/目路径重叠（a → a.b）整棵源子树被移除导致数据丢失。
 * #428 killCursors 未实现（code 59），游标无空闲超时、永久驻留 _cursors。
 * #430 insert 文档无 _id 时不生成 ObjectId，落库文档缺 _id。
 *
 * 全部走真实协议帧：Redis 用 RESP socket，Mongo 用 OP_MSG socket；
 * 内部函数断言仅作为补充。
 */
const path = require('path');
const net = require('net');
const assert = require('assert');
const ROOT = path.join(__dirname, '..');
const { createRedisServer } = require(path.join(ROOT, 'lib', 'redis_server.js'));
const { createMongoServer, bsonDocument, bsonReadDocument } = require(path.join(ROOT, 'lib', 'mongo_server.js'));

let passed = 0, failed = 0;
async function t(name, fn) {
  try { await fn(); passed++; console.log(`ok - ${name}`); }
  catch (e) { failed++; console.error(`not ok - ${name}\n  ${e && e.message}`); }
}

/* ---------- Redis RESP 客户端 ---------- */
function redisFrame(args) {
  const parts = args.map((a) => { const b = Buffer.from(String(a)); return '$' + b.length + '\r\n' + b + '\r\n'; });
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
  const h = Buffer.alloc(16);
  h.writeInt32LE(16 + 4 + 1 + p.length, 0);
  h.writeInt32LE(1, 4); h.writeInt32LE(0, 8); h.writeInt32LE(2013, 12);
  return Buffer.concat([h, Buffer.alloc(4), Buffer.from([0]), p]);
}
function mongoCall(srv, doc) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(srv._server.address().port, '127.0.0.1', () => sock.write(mongoOpMsg(doc)));
    const chunks = [];
    sock.on('error', reject);
    sock.on('data', (c) => {
      chunks.push(c);
      const buf = Buffer.concat(chunks);
      if (buf.length >= 16 && buf.length >= buf.readInt32LE(0)) {
        try { resolve(bsonReadDocument(buf.slice(21), 0).value); }
        catch (e) { reject(e); }
        sock.end();
      }
    });
  });
}

(async () => {
  // ================= #395 MGET WRONGTYPE =================
  await t('#395 MGET 遇 hash/list/set/zset 整条回 WRONGTYPE（Redis 7 语义）', async () => {
    const srv = createRedisServer({ port: 0, dataDir: null });
    await new Promise((r) => srv.listen(r));
    try {
      await redisCall(srv, ['HSET', 'h', 'f', '1']);
      await redisCall(srv, ['RPUSH', 'l', 'a']);
      await redisCall(srv, ['SADD', 's', 'x']);
      await redisCall(srv, ['ZADD', 'z', '1', 'm']);
      await redisCall(srv, ['SET', 'str', 'hello']);

      for (const k of ['h', 'l', 's', 'z']) {
        const reply = await redisCall(srv, ['MGET', k]);
        assert.ok(reply.startsWith('-WRONGTYPE Operation against a key holding the wrong kind of value'),
          `MGET ${k} 应回 WRONGTYPE，实际: ${JSON.stringify(reply)}`);
      }
      // 混合请求：任一槽位是错误类型，整条命令失败（不回部分结果）
      const mixed = await redisCall(srv, ['MGET', 'str', 'h']);
      assert.ok(mixed.startsWith('-WRONGTYPE Operation against a key holding the wrong kind of value'),
        `MGET 混合类型应整条 WRONGTYPE，实际: ${JSON.stringify(mixed)}`);

      // 对照：纯字符串键与缺失键行为不回归
      const strReply = await redisCall(srv, ['MGET', 'str']);
      assert.strictEqual(strReply, '*1\r\n$5\r\nhello\r\n', strReply);
      const missReply = await redisCall(srv, ['MGET', 'nosuch']);
      assert.strictEqual(missReply, '*1\r\n$-1\r\n', missReply);
    } finally { srv.stop(); }
  });

  // ================= #396 BSON Int64 无损往返 =================
  await t('#396 Int64 经 $numberLong/$long 无损往返，越界明确报错', async () => {
    // 补充：编码器单元断言
    const enc = bsonDocument({ a: { $numberLong: '42' } });
    assert.ok(enc.toString('hex').includes('126100'), '$numberLong 应编成 Int64(0x12)');
    const encLong = bsonDocument({ b: { $long: '-9223372036854775808' } });
    assert.ok(encLong.toString('hex').includes('126200'), '$long 应编成 Int64(0x12)');
    assert.throws(() => bsonDocument({ c: { $numberLong: '9223372036854775808' } }), /out of int64 range/, '越界应明确报错');
    assert.throws(() => bsonDocument({ d: { $numberLong: 'abc' } }), /invalid value/, '非法整数字面量应报错');

    // 真实协议路径：insert → find 往返
    const srv = createMongoServer({ dataDir: ':memory:' });
    await new Promise((r) => srv.listen(r));
    try {
      await mongoCall(srv, { insert: 't', documents: [{
        _id: 'i64',
        n: { $numberLong: '9223372036854775807' },
        m: { $long: '-9223372036854775808' },
      }], $db: 'test' });
      const res = await mongoCall(srv, { find: 't', filter: { _id: 'i64' }, $db: 'test' });
      const doc = res.cursor.firstBatch[0];
      assert.ok(doc, '应回读到文档');
      assert.strictEqual(doc.n.$numberLong, '9223372036854775807', 'Int64 最大值无损往返');
      assert.strictEqual(doc.m.$numberLong, '-9223372036854775808', 'Int64 最小值无损往返');
      // 不允许降级成双精度（末三位被改写的 9223372036854776000）
      assert.notStrictEqual(doc.n.$numberLong, '9223372036854776000');
    } finally { srv.close(); }
  });

  // ================= #413 $rename 重叠报错 + 兄弟保留 =================
  await t('#413 $rename 源/目路径重叠报错且兄弟字段保留；平铺重命名不回归', async () => {
    const srv = createMongoServer({ dataDir: ':memory:' });
    await new Promise((r) => srv.listen(r));
    try {
      await mongoCall(srv, { insert: 't', documents: [
        { _id: 'r', a: { x: 1 }, keep: 2 },
        { _id: 'c', c: 5 },
      ], $db: 'test' });

      // 重叠重命名 a → a.b：必须报错，且不得丢字段
      const upd = await mongoCall(srv, { update: 't', updates: [{ q: { _id: 'r' }, u: { $rename: { a: 'a.b' } } }], $db: 'test' });
      assert.notStrictEqual(upd.ok, 1, `重叠 rename 不应成功: ${JSON.stringify(upd)}`);

      const after = await mongoCall(srv, { find: 't', filter: { _id: 'r' }, $db: 'test' });
      const row = after.cursor.firstBatch[0];
      assert.deepStrictEqual(row.a, { x: 1 }, '源子树必须原样保留');
      assert.strictEqual(row.keep, 2, '兄弟字段必须保留');
      assert.strictEqual(getNested(row, 'a.b'), undefined, '不得写入重叠目标');

      // 对照：平铺字段重命名正常
      const flat = await mongoCall(srv, { update: 't', updates: [{ q: { _id: 'c' }, u: { $rename: { c: 'd' } } }], $db: 'test' });
      assert.strictEqual(flat.ok, 1, `平铺 rename 应成功: ${JSON.stringify(flat)}`);
      const afterFlat = await mongoCall(srv, { find: 't', filter: { _id: 'c' }, $db: 'test' });
      assert.strictEqual(afterFlat.cursor.firstBatch[0].d, 5);
    } finally { srv.close(); }
  });

  // ================= #428 killCursors + 空闲超时 =================
  await t('#428 killCursors 回 cursorsKilled；空闲超时回收游标', async () => {
    const srv = createMongoServer({ dataDir: ':memory:' });
    await new Promise((r) => srv.listen(r));
    try {
      await mongoCall(srv, { insert: 't', documents: [{ _id: '1' }, { _id: '2' }, { _id: '3' }, { _id: '4' }, { _id: '5' }], $db: 'test' });
      const f = await mongoCall(srv, { find: 't', filter: {}, batchSize: 1, $db: 'test' });
      const cid = f.cursor.id;
      assert.ok(cid, '应生成游标 id');
      assert.strictEqual(srv._cursors.size, 1, 'find 后游标已登记');

      const killed = await mongoCall(srv, { killCursors: 't', cursors: [cid], $db: 'test' });
      assert.strictEqual(killed.ok, 1, JSON.stringify(killed));
      assert.deepStrictEqual(killed.cursorsKilled, [cid]);
      assert.deepStrictEqual(killed.cursorsNotFound, []);
      assert.deepStrictEqual(killed.cursorsAlive, []);
      assert.deepStrictEqual(killed.cursorsUnknown, []);
      assert.strictEqual(srv._cursors.size, 0, 'killCursors 后游标应移除');

      // 不存在的游标进 cursorsNotFound
      const missing = await mongoCall(srv, { killCursors: 't', cursors: [{ $numberLong: '999999' }], $db: 'test' });
      assert.strictEqual(missing.ok, 1);
      assert.strictEqual(missing.cursorsNotFound.length, 1);
    } finally { srv.close(); }

    // 空闲超时：短超时配置下，未取完的游标被后台清扫，再 getMore 回 cursorNotFound(43)
    const idleMs = 120;
    const srv2 = createMongoServer({ dataDir: ':memory:', cursorIdleTimeoutMs: idleMs });
    await new Promise((r) => srv2.listen(r));
    try {
      await mongoCall(srv2, { insert: 't2', documents: [{ _id: '1' }, { _id: '2' }, { _id: '3' }], $db: 'test' });
      const f2 = await mongoCall(srv2, { find: 't2', filter: {}, batchSize: 1, $db: 'test' });
      assert.strictEqual(srv2._cursors.size, 1);
      await new Promise((r) => setTimeout(r, idleMs + 250));
      assert.strictEqual(srv2._cursors.size, 0, '空闲超时后游标应被清扫');
      const gm = await mongoCall(srv2, { getMore: f2.cursor.id, collection: 't2', $db: 'test' });
      assert.strictEqual(gm.ok, 0);
      assert.strictEqual(gm.code, 43, '超时后 getMore 应回 cursorNotFound(43)');
    } finally { srv2.close(); }
  });

  // ================= #430 insert 自动生成 ObjectId =================
  await t('#430 insert 缺 _id 自动生成 ObjectId；显式重复 _id 走 duplicate key', async () => {
    const srv = createMongoServer({ dataDir: ':memory:' });
    await new Promise((r) => srv.listen(r));
    try {
      const ins = await mongoCall(srv, { insert: 't', documents: [{ name: 'x' }, { name: 'y' }], $db: 'test' });
      assert.strictEqual(ins.ok, 1);
      assert.strictEqual(ins.n, 2);

      const res = await mongoCall(srv, { find: 't', filter: {}, $db: 'test' });
      const rows = res.cursor.firstBatch;
      assert.strictEqual(rows.length, 2);
      const ids = rows.map(r => String(r._id));
      for (const id of ids) assert.ok(/^[0-9a-f]{24}$/.test(id), `_id 应为 24 位 hex ObjectId: ${id}`);
      assert.notStrictEqual(ids[0], ids[1], '两篇文档 _id 不得相同');

      // 显式 _id 冲突仍走 E11000 duplicate key 语义
      await mongoCall(srv, { insert: 't', documents: [{ _id: 'dup', v: 1 }], $db: 'test' });
      const dup = await mongoCall(srv, { insert: 't', documents: [{ _id: 'dup', v: 2 }], $db: 'test' });
      assert.strictEqual(dup.ok, 1);
      assert.ok(dup.writeErrors && dup.writeErrors.length === 1, JSON.stringify(dup));
      assert.strictEqual(dup.writeErrors[0].code, 11000);
    } finally { srv.close(); }
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });

function getNested(obj, path) {
  return path.split('.').reduce((cur, p) => (cur == null ? cur : cur[p]), obj);
}
