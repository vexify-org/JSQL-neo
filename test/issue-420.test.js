/*
 * #420 回归测试：INCR/DECR/INCRBY/DECRBY 走 BigInt，INT64 越界必须报 overflow。
 *   node test/issue-420.test.js
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
  await t('#420 wire: INT64_MAX + 1 → overflow 错误，原值不变', async () => {
    await withServer(async (srv) => {
      await call(srv, ['SET', 'o', '9223372036854775807']);
      assert.strictEqual(await call(srv, ['INCR', 'o']),
        '-ERR increment or decrement would overflow\r\n');
      assert.strictEqual(await call(srv, ['GET', 'o']), '$19\r\n9223372036854775807\r\n');
    });
  });

  await t('#420 wire: INT64_MIN - 1 → overflow 错误', async () => {
    await withServer(async (srv) => {
      await call(srv, ['SET', 'n', '-9223372036854775808']);
      assert.strictEqual(await call(srv, ['DECR', 'n']),
        '-ERR increment or decrement would overflow\r\n');
    });
  });

  await t('#420 wire: 2^53 以上的安全累加不丢精度', async () => {
    await withServer(async (srv) => {
      await call(srv, ['SET', 'big', '9007199254740993']);
      assert.strictEqual(await call(srv, ['INCR', 'big']), ':9007199254740994\r\n');
      assert.strictEqual(await call(srv, ['GET', 'big']), '$16\r\n9007199254740994\r\n');
    });
  });

  await t('#420 wire: INCRBY 大增量不丢精度', async () => {
    await withServer(async (srv) => {
      await call(srv, ['SET', 'x', '10']);
      assert.strictEqual(await call(srv, ['INCRBY', 'x', '9007199254740993']),
        ':9007199254741003\r\n');
      assert.strictEqual(await call(srv, ['DECRBY', 'y', '3']), ':-3\r\n');
    });
  });

  await t('#420 execute 直调：普通 INCR 仍返回 number，非法值仍报错', async () => {
    const srv = createRedisServer({ dataDir: ':memory:' });
    srv.execute('SET', ['n', '10']);
    assert.strictEqual(srv.execute('INCR', ['n']), 11);
    assert.throws(() => srv.execute('INCRBY', ['n', 'x']), /value is not an integer/);
    srv.execute('SET', ['s', 'abc']);
    assert.throws(() => srv.execute('INCR', ['s']), /value is not an integer or out of range/);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
