/*
 * #574 回归测试：MSET 奇数参数 wrong-arity 必须带命令名。
 *   node test/issue-574.test.js
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
  await t('#574 wire: MSET 奇数参数带命令名 mset', async () => {
    await withServer(async (srv) => {
      assert.strictEqual(await call(srv, ['MSET', 'a', '1', 'b']),
        "-ERR wrong number of arguments for 'mset' command\r\n");
    });
  });

  await t('#574 execute 直调错误消息带 mset', async () => {
    const srv = createRedisServer({ dataDir: ':memory:' });
    assert.throws(() => srv.execute('MSET', ['a', '1', 'b']), /for 'mset' command/);
  });

  await t('#574 偶数参数 MSET 仍正常（不误伤）', async () => {
    await withServer(async (srv) => {
      assert.strictEqual(await call(srv, ['MSET', 'a', '1', 'b', '2']), '+OK\r\n');
      assert.strictEqual(await call(srv, ['MGET', 'a', 'b']), '*2\r\n$1\r\n1\r\n$1\r\n2\r\n');
    });
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
