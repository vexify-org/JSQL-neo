/*
 * #496 回归测试：ZADD 支持 NX / XX / CH / INCR 选项。
 *   node test/issue-496.test.js
 */
const assert = require('assert');
const net = require('net');
const path = require('path');
const { createRedisServer } = require(path.join(__dirname, '..', 'index.js'));

function frame(args) {
  const parts = [Buffer.from(`*${args.length}\r\n`)];
  for (const a of args) {
    const s = Buffer.from(String(a), 'utf8');
    parts.push(Buffer.from(`$${s.length}\r\n`), s, Buffer.from('\r\n'));
  }
  return Buffer.concat(parts);
}
function call(srv, args) {
  return new Promise((resolve) => {
    const sock = net.connect(srv.server.address().port, '127.0.0.1');
    const chunks = [];
    let timer;
    const done = () => { clearTimeout(timer); resolve(Buffer.concat(chunks).toString('utf8')); sock.end(); };
    sock.on('connect', () => sock.write(frame(args)));
    sock.on('data', (c) => { chunks.push(c); clearTimeout(timer); timer = setTimeout(done, 30); });
    sock.on('error', () => { clearTimeout(timer); resolve(''); });
  });
}
async function withServer(fn) {
  const srv = createRedisServer({ port: 0, dataDir: ':memory:' });
  await new Promise((r) => srv.listen(r));
  try { return await fn(srv); } finally { srv.stop(); }
}

let passed = 0, failed = 0;
async function t(name, fn) {
  try { await fn(); passed++; console.log('ok - ' + name); }
  catch (e) { failed++; console.error('not ok - ' + name + '\n  ' + (e && e.message)); }
}

(async () => {
  await t('#496 wire: NX 只添加新成员，不覆盖已有', async () => {
    await withServer(async (srv) => {
      assert.strictEqual(await call(srv, ['ZADD', 'z', 'NX', '1', 'm']), ':1\r\n');
      assert.strictEqual(await call(srv, ['ZSCORE', 'z', 'm']), '$1\r\n1\r\n');
      assert.strictEqual(await call(srv, ['ZADD', 'z', 'NX', '9', 'm']), ':0\r\n');
      assert.strictEqual(await call(srv, ['ZSCORE', 'z', 'm']), '$1\r\n1\r\n');
      assert.strictEqual(await call(srv, ['ZADD', 'z', 'NX', '2', 'n']), ':1\r\n');
    });
  });

  await t('#496 wire: XX 只更新已有成员，不新建', async () => {
    await withServer(async (srv) => {
      await call(srv, ['ZADD', 'z', '1', 'm']);
      assert.strictEqual(await call(srv, ['ZADD', 'z', 'XX', '5', 'm']), ':0\r\n');
      assert.strictEqual(await call(srv, ['ZSCORE', 'z', 'm']), '$1\r\n5\r\n');
      assert.strictEqual(await call(srv, ['ZADD', 'z', 'XX', '7', 'ghost']), ':0\r\n');
      assert.strictEqual(await call(srv, ['ZCARD', 'z']), ':1\r\n');
      assert.strictEqual(await call(srv, ['ZADD', 'fresh', 'XX', '5', 'm']), ':0\r\n');
      assert.strictEqual(await call(srv, ['EXISTS', 'fresh']), ':0\r\n');
    });
  });

  await t('#496 wire: CH 返回新增/变更成员数', async () => {
    await withServer(async (srv) => {
      await call(srv, ['ZADD', 'z', '1', 'm']);
      assert.strictEqual(await call(srv, ['ZADD', 'z', 'CH', '10', 'm']), ':1\r\n');
      assert.strictEqual(await call(srv, ['ZADD', 'z', 'CH', '10', 'm']), ':0\r\n');
      assert.strictEqual(await call(srv, ['ZADD', 'z', 'CH', '3', 'n']), ':1\r\n');
    });
  });

  await t('#496 wire: INCR 分数自增并返回新分数', async () => {
    await withServer(async (srv) => {
      await call(srv, ['ZADD', 'z', '10', 'm']);
      assert.strictEqual(await call(srv, ['ZADD', 'z', 'INCR', '2', 'm']), '$2\r\n12\r\n');
      assert.strictEqual(await call(srv, ['ZSCORE', 'z', 'm']), '$2\r\n12\r\n');
      assert.strictEqual(await call(srv, ['ZADD', 'z', 'INCR', '3', 'new']), '$1\r\n3\r\n');
    });
  });

  await t('#496 wire: 非法选项与 NX+XX 冲突 → syntax error', async () => {
    await withServer(async (srv) => {
      assert.strictEqual(await call(srv, ['ZADD', 'z', 'BAD', '1', 'm']), '-ERR syntax error\r\n');
      assert.strictEqual(await call(srv, ['ZADD', 'z', 'NX', 'XX', '1', 'm']), '-ERR syntax error\r\n');
      assert.strictEqual(await call(srv, ['ZADD', 'z', 'INCR', '1', 'm', '2', 'n']), '-ERR syntax error\r\n');
    });
  });

  await t('#496 execute 直调：普通 ZADD 不受影响', async () => {
    const srv = createRedisServer({ dataDir: ':memory:' });
    assert.strictEqual(srv.execute('ZADD', ['z', '1', 'a', '2', 'b']), 2);
    assert.strictEqual(srv.execute('ZRANGE', ['z', '0', '-1']).join(','), 'a,b');
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
