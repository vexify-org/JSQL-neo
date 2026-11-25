/*
 * #504 回归测试：AUTH 同时支持 AUTH <password> 与 AUTH <user> <pass>。
 *   node test/issue-504.test.js
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
function callSameSocket(srv, argSets) {
  return new Promise((resolve) => {
    const sock = net.connect(srv.server.address().port, '127.0.0.1');
    const chunks = [];
    let timer;
    const done = () => { clearTimeout(timer); resolve(Buffer.concat(chunks).toString('utf8')); sock.end(); };
    sock.on('connect', () => { for (const args of argSets) sock.write(frame(args)); });
    sock.on('data', (c) => { chunks.push(c); clearTimeout(timer); timer = setTimeout(done, 50); });
    sock.on('error', () => { clearTimeout(timer); resolve(''); });
  });
}
async function withServer(opts, fn) {
  const srv = createRedisServer(Object.assign({ port: 0, dataDir: ':memory:' }, opts));
  await new Promise((r) => srv.listen(r));
  try { return await fn(srv); } finally { srv.stop(); }
}

let passed = 0, failed = 0;
async function t(name, fn) {
  try { await fn(); passed++; console.log('ok - ' + name); }
  catch (e) { failed++; console.error('not ok - ' + name + '\n  ' + (e && e.message)); }
}

(async () => {
  await t('#504 execute: 单参 AUTH password 仍有效', async () => {
    const srv = createRedisServer({ dataDir: ':memory:', password: 'p' });
    assert.strictEqual(srv.execute('AUTH', ['p']), 'OK');
    assert.throws(() => srv.execute('AUTH', ['wrong']), /invalid password/);
  });

  await t('#504 execute: 两参 AUTH user pass 按密码校验通过', async () => {
    const srv = createRedisServer({ dataDir: ':memory:', password: 'p' });
    assert.strictEqual(srv.execute('AUTH', ['u', 'p']), 'OK');
    assert.strictEqual(srv.execute('AUTH', ['default', 'p']), 'OK');
    assert.throws(() => srv.execute('AUTH', ['u', 'wrong']), /invalid password/);
  });

  await t('#504 wire: AUTH u p 通过认证后可执行 PING', async () => {
    await withServer({ password: 'p' }, async (srv) => {
      const out = await callSameSocket(srv, [['AUTH', 'u', 'p'], ['PING']]);
      assert.ok(out.startsWith('+OK\r\n'), out);
      assert.ok(out.includes('+PONG\r\n'), out);
    });
  });

  await t('#504 wire: 未配置密码时 AUTH 报 no password is set', async () => {
    await withServer({}, async (srv) => {
      assert.strictEqual(await call(srv, ['AUTH', 'u', 'p']),
        '-ERR Client sent AUTH, but no password is set\r\n');
    });
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
