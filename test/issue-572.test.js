/*
 * #572 回归测试：wrong-arity 错误必须使用命令的规范小写名。
 *   node test/issue-572.test.js
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
  await t('#572 wire: SET 缺值 → 命令名小写 set', async () => {
    await withServer(async (srv) => {
      assert.strictEqual(await call(srv, ['SET', 'k']),
        "-ERR wrong number of arguments for 'set' command\r\n");
    });
  });

  await t('#572 wire: INCRBY 缺增量 → 命令名小写 incrby', async () => {
    await withServer(async (srv) => {
      assert.strictEqual(await call(srv, ['INCRBY', 'x']),
        "-ERR wrong number of arguments for 'incrby' command\r\n");
    });
  });

  await t('#572 execute 直调同样使用小写命令名', async () => {
    const srv = createRedisServer({ dataDir: ':memory:' });
    assert.throws(() => srv.execute('SET', ['k']), /'set' command/);
    assert.throws(() => srv.execute('INCRBY', ['x']), /'incrby' command/);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
