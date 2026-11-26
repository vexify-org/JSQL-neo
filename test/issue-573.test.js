/*
 * #573 回归测试：unknown command 错误原样回显客户端发送的命令令牌大小写。
 *   node test/issue-573.test.js
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
  await t('#573 wire: 小写 getset → unknown command 保留小写', async () => {
    await withServer(async (srv) => {
      assert.strictEqual(await call(srv, ['getset', 'k', 'v']),
        "-ERR unknown command 'getset'\r\n");
    });
  });

  await t('#573 wire: 大写 GETSET → unknown command 保留大写', async () => {
    await withServer(async (srv) => {
      assert.strictEqual(await call(srv, ['GETSET', 'k', 'v']),
        "-ERR unknown command 'GETSET'\r\n");
    });
  });

  await t('#573 wire: 混合大小写 GetSet → 原样回显', async () => {
    await withServer(async (srv) => {
      assert.strictEqual(await call(srv, ['GetSet', 'k', 'v']),
        "-ERR unknown command 'GetSet'\r\n");
    });
  });

  await t('#573 inline: 小写 foobar → 原样回显', async () => {
    await withServer(async (srv) => {
      assert.strictEqual(await call(srv, ['foobar']), "-ERR unknown command 'foobar'\r\n");
    });
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
