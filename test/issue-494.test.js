/*
 * #494 回归测试：SET ... KEEPTTL 更新值但保留既有 TTL。
 *   node test/issue-494.test.js
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
const ttlOf = (reply) => Number(reply.slice(1, -2));

let passed = 0, failed = 0;
async function t(name, fn) {
  try { await fn(); passed++; console.log('ok - ' + name); }
  catch (e) { failed++; console.error('not ok - ' + name + '\n  ' + (e && e.message)); }
}

(async () => {
  await t('#494 wire: SET KEEPTTL 保留已有 TTL 且更新值', async () => {
    await withServer(async (srv) => {
      await call(srv, ['SET', 'kt', 'v', 'EX', '60']);
      const before = ttlOf(await call(srv, ['TTL', 'kt']));
      assert.ok(before > 55 && before <= 60, 'before=' + before);
      assert.strictEqual(await call(srv, ['SET', 'kt', 'v2', 'KEEPTTL']), '+OK\r\n');
      const after = ttlOf(await call(srv, ['TTL', 'kt']));
      assert.ok(after > 55 && after <= 60, 'after=' + after);
      assert.strictEqual(await call(srv, ['GET', 'kt']), '$2\r\nv2\r\n');
    });
  });

  await t('#494 wire: 永久键 KEEPTTL 后仍永久', async () => {
    await withServer(async (srv) => {
      await call(srv, ['SET', 'noexp', 'v']);
      assert.strictEqual(await call(srv, ['SET', 'noexp', 'v2', 'KEEPTTL']), '+OK\r\n');
      assert.strictEqual(await call(srv, ['TTL', 'noexp']), ':-1\r\n');
    });
  });

  await t('#494 wire: KEEPTTL 与 EX 互斥 → syntax error', async () => {
    await withServer(async (srv) => {
      await call(srv, ['SET', 'kt2', 'v', 'EX', '60']);
      assert.strictEqual(await call(srv, ['SET', 'kt2', 'v2', 'KEEPTTL', 'EX', '10']),
        '-ERR syntax error\r\n');
    });
  });

  await t('#494 execute 直调：KEEPTTL 生效', async () => {
    const srv = createRedisServer({ dataDir: ':memory:' });
    srv.execute('SET', ['k', 'v', 'EX', '60']);
    const ttlBefore = srv.execute('TTL', ['k']);
    assert.strictEqual(srv.execute('SET', ['k', 'new', 'KEEPTTL']), 'OK');
    assert.strictEqual(srv.execute('GET', ['k']), 'new');
    assert.ok(Math.abs(srv.execute('TTL', ['k']) - ttlBefore) <= 1);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
