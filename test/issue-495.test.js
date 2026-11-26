/*
 * #495 回归测试：EXPIRE 拒绝 0 与负数秒，回 invalid expire time。
 *   node test/issue-495.test.js
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
  await t('#495 wire: EXPIRE key 0 → invalid expire time', async () => {
    await withServer(async (srv) => {
      await call(srv, ['SET', 'k1', 'v']);
      assert.strictEqual(await call(srv, ['EXPIRE', 'k1', '0']),
        "-ERR invalid expire time in 'expire' command\r\n");
      assert.strictEqual(await call(srv, ['TTL', 'k1']), ':-1\r\n');
    });
  });

  await t('#495 wire: EXPIRE key -5 → invalid expire time', async () => {
    await withServer(async (srv) => {
      await call(srv, ['SET', 'k2', 'v']);
      assert.strictEqual(await call(srv, ['EXPIRE', 'k2', '-5']),
        "-ERR invalid expire time in 'expire' command\r\n");
      assert.strictEqual(await call(srv, ['TTL', 'k2']), ':-1\r\n');
    });
  });

  await t('#495 wire: 带条件选项的非法时间同样报错', async () => {
    await withServer(async (srv) => {
      await call(srv, ['SET', 'k3', 'v']);
      assert.strictEqual(await call(srv, ['EXPIRE', 'k3', '0', 'NX']),
        "-ERR invalid expire time in 'expire' command\r\n");
    });
  });

  await t('#495 execute 直调对 0/负数抛错', async () => {
    const srv = createRedisServer({ dataDir: ':memory:' });
    srv.execute('SET', ['k', 'v']);
    assert.throws(() => srv.execute('EXPIRE', ['k', '0']), /invalid expire time/);
    assert.throws(() => srv.execute('EXPIRE', ['k', '-5']), /invalid expire time/);
  });

  await t('#495 正数 EXPIRE 仍正常（不误伤）', async () => {
    await withServer(async (srv) => {
      await call(srv, ['SET', 'k4', 'v']);
      assert.strictEqual(await call(srv, ['EXPIRE', 'k4', '5']), ':1\r\n');
      const ttl = await call(srv, ['TTL', 'k4']);
      assert.ok(/^:\d+\r\n$/.test(ttl) && Number(ttl.slice(1, -2)) > 0, ttl);
    });
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
