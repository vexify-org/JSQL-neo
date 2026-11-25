// #336: 服务端支持明文/MD5 口令认证（文档承诺），SCRAM 仍为默认
const assert = require('assert');
const crypto = require('crypto');
const net = require('net');
const H = require('./issue-pg5-helper.js');
let passed = 0, failed = 0;
async function t(name, fn) {
  try { await fn(); passed++; console.log('ok - ' + name); }
  catch (e) { failed++; console.error('not ok - ' + name + '\n  ' + e.message); }
}
async function connectAndReadAuth(port) {
  const sock = net.connect(port, '127.0.0.1');
  await new Promise((r, j) => { sock.once('connect', r); sock.once('error', j); });
  const rd = H.pgReader(sock);
  sock.write(H.pgStartup('postgres', 'app'));
  const p = await rd.read(1500);
  assert.ok(p && p.type === 0x52, 'expected Authentication request (R)');
  return { sock, rd, auth: p };
}
(async () => {
  await t('#336 authMethod=cleartext 回 R=3 且明文口令可完成认证', async () => {
    const h = await H.startServer({ noAuth: false, auth: { postgres: { password: 'secret' } }, authMethod: 'cleartext' });
    try {
      const c = await connectAndReadAuth(h.port);
      assert.strictEqual(c.auth.payload.readInt32BE(0), 3, 'expected CleartextPassword (3)');
      c.sock.write(H.pgMsg(0x70, H.cstr('secret')));
      const frames = [];
      for (;;) { const p = await c.rd.read(500); if (!p) break; frames.push(p); if (p.type === 0x5a) break; }
      assert.ok(frames.some((p) => p.type === 0x52 && p.payload.readInt32BE(0) === 0), 'expected AuthenticationOk');
      assert.ok(frames.some((p) => p.type === 0x5a), 'expected ReadyForQuery');
    } finally { h.close(); }
  });
  await t('#336 authMethod=md5 回 R=5 且可完成认证', async () => {
    const h = await H.startServer({ noAuth: false, auth: { postgres: { password: 'secret' } }, authMethod: 'md5' });
    try {
      const c = await connectAndReadAuth(h.port);
      assert.strictEqual(c.auth.payload.readInt32BE(0), 5, 'expected MD5Password (5)');
      const salt = c.auth.payload.slice(4, 8);
      const inner = crypto.createHash('md5').update(Buffer.concat([Buffer.from('secret'), salt])).digest('hex');
      const resp = 'md5' + crypto.createHash('md5').update(inner + salt.toString('hex'), 'utf8').digest('hex');
      c.sock.write(H.pgMsg(0x70, H.cstr(resp)));
      const frames = [];
      for (;;) { const p = await c.rd.read(500); if (!p) break; frames.push(p); if (p.type === 0x5a) break; }
      assert.ok(frames.some((p) => p.type === 0x52 && p.payload.readInt32BE(0) === 0), 'expected AuthenticationOk');
    } finally { h.close(); }
  });
  await t('#336 默认仍为 SCRAM (10)', async () => {
    const h = await H.startServer({ noAuth: false, auth: { postgres: { password: 'secret' } } });
    try {
      const c = await connectAndReadAuth(h.port);
      assert.strictEqual(c.auth.payload.readInt32BE(0), 10);
    } finally { h.close(); }
  });
  console.log(`${passed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
})().catch((e) => { console.error(e); process.exitCode = 1; });
