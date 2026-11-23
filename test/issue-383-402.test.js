const assert = require('assert');
const { Database } = require('../index.js');
const { createRedisServer } = require('../lib/redis_server.js');

let passed = 0, failed = 0;
async function t(name, fn) {
  try { await fn(); passed++; console.log(`ok - ${name}`); }
  catch (e) { failed++; console.error(`not ok - ${name}\n  ${e && e.message}`); }
}

(async () => {
  // #383：before* 钩子中止时返回值必须符合各 API 的契约
  await t('#383 钩子中止按返回类型兜底', async () => {
    const db = new Database(':memory:');
    await db.query('CREATE TABLE t (id INT PRIMARY KEY, a INT)', { safety: false });
    await db.query('INSERT INTO t VALUES (1, 10)', { safety: false });
    const original = db._runHooks;
    db._runHooks = async () => false;
    assert.strictEqual(await db.count('t'), 0);
    assert.deepStrictEqual(await db.updateById('t', 1, { a: 2 }), { ok: false, error: 'aborted' });
    assert.deepStrictEqual(await db.updateByIds('t', [[1, { a: 2 }]]), { ok: false, count: 0, error: 'aborted' });
    assert.deepStrictEqual(await db.removeById('t', 1), { ok: false, error: 'aborted' });
    assert.deepStrictEqual(await db.removeByIds('t', [1]), { ok: false, count: 0, error: 'aborted' });
    db._runHooks = original;
    assert.strictEqual(await db.count('t'), 1, '恢复钩子后应正常计数');
    await db.close();
  });

  // #385：RENAME TABLE 后视图定义中的基表引用必须同步
  await t('#385 RENAME TABLE 重写视图引用', async () => {
    const db = new Database(':memory:');
    await db.query('CREATE TABLE t (id INT PRIMARY KEY, a INT)', { safety: false });
    await db.query('INSERT INTO t VALUES (1, 10)', { safety: false });
    await db.query('CREATE VIEW v AS SELECT a FROM t WHERE a > 0', { safety: false });
    await db.query('ALTER TABLE t RENAME TO t2', { safety: false });
    const r = await db.query('SELECT * FROM v', { safety: false });
    assert.deepStrictEqual(r.rows, [[10]]);
    assert.strictEqual(db._views.v.select.from.tables[0].table, 't2');
    await db.close();
  });

  // #400：INFO 支持 section、内存按字节、连接数真实
  await t('#400 INFO 指标与 section 过滤', async () => {
    const srv = createRedisServer({ dataDir: null });
    srv.execute('SET', ['k', 'v']);
    srv._clients.add({}); srv._clients.add({});
    const info = srv.execute('INFO', []);
    assert.ok(info.includes('used_memory:'), '缺 used_memory');
    const mem = Number(/used_memory:(\d+)/.exec(info)[1]);
    assert.ok(mem > 0);
    assert.ok(info.includes('connected_clients:2'), `连接数错误: ${info}`);
    assert.ok(info.includes('# Keyspace'));
    assert.ok(info.includes('db0:keys=1'));
    const onlyMem = srv.execute('INFO', ['memory']).split('\r\n');
    assert.strictEqual(onlyMem[0], '# Memory');
    assert.ok(!onlyMem.some((l) => l.startsWith('# Server')), 'section=memory 不应返回 Server 段');
  });

  // #401：ZSET 无穷大分数出站必须为 inf / -inf
  await t('#401 ZSET 分数 ±inf 协议格式', async () => {
    const srv = createRedisServer({ dataDir: null });
    srv.execute('ZADD', ['z', 'inf', 'a', '-inf', 'b']);
    assert.strictEqual(srv.execute('ZSCORE', ['z', 'a']), 'inf');
    assert.strictEqual(srv.execute('ZSCORE', ['z', 'b']), '-inf');
    assert.deepStrictEqual(srv.execute('ZRANGE', ['z', '0', '-1', 'WITHSCORES']), ['b', '-inf', 'a', 'inf']);
    srv.execute('ZINCRBY', ['z', '1', 'b']);
    assert.strictEqual(srv.execute('ZSCORE', ['z', 'b']), '-inf');
  });

  // #402：PING / ECHO 超参数必须报 arity 错误
  await t('#402 PING/ECHO 参数上界校验', async () => {
    const srv = createRedisServer({ dataDir: null });
    assert.strictEqual(srv.execute('PING', []), 'PONG');
    assert.strictEqual(srv.execute('PING', ['hi']), 'hi');
    assert.throws(() => srv.execute('PING', ['a', 'b']), /wrong number of arguments for 'PING' command/);
    assert.strictEqual(srv.execute('ECHO', ['hi']), 'hi');
    assert.throws(() => srv.execute('ECHO', ['a', 'b']), /wrong number of arguments for 'ECHO' command/);
    assert.throws(() => srv.execute('ECHO', []), /wrong number of arguments for 'ECHO' command/);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
