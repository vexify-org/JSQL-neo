// #379: CancelRequest 必须校验 pid/secret，只对匹配后端设置取消标记（57014）
const assert = require('assert');
const H = require('./issue-pg5-helper.js');
let passed = 0, failed = 0;
async function t(name, fn) {
  try { await fn(); passed++; console.log('ok - ' + name); }
  catch (e) { failed++; console.error('not ok - ' + name + '\n  ' + e.message); }
}
function keyOf(c) {
  const k = c.auth.find((p) => p.type === 0x4b);
  assert.ok(k, 'expected BackendKeyData');
  return { pid: k.payload.readInt32BE(0), secret: k.payload.readInt32BE(4) };
}
(async () => {
  await t('#379 正确密钥取消后查询回 57014，伪造密钥被忽略', async () => {
    const h = await H.startServer();
    try {
      const c = await H.pgConnect(h.port);
      const key = keyOf(c);
      await H.sendCancelRequest(h.port, key.pid, key.secret);
      c.sock.write(H.queryMsg('SELECT 1'));
      const out = await H.pgDrain(c.rd, 300);
      const err = out.find((p) => p.type === 0x45);
      assert.ok(err, 'valid cancel should abort query; frames=' + out.map((p) => p.type.toString(16)).join(','));
      assert.strictEqual(H.errorFields(err).C, '57014');
      assert.strictEqual(out.filter((p) => p.type === 0x44).length, 0);

      const c2 = await H.pgConnect(h.port);
      const key2 = keyOf(c2);
      await H.sendCancelRequest(h.port, key2.pid + 999999, 42);
      c2.sock.write(H.queryMsg('SELECT 1'));
      const out2 = await H.pgDrain(c2.rd, 300);
      assert.strictEqual(out2.filter((p) => p.type === 0x45).length, 0, 'bogus cancel must be ignored');
      assert.ok(out2.some((p) => p.type === 0x44), 'query should succeed after bogus cancel');
    } finally { h.close(); }
  });
  console.log(`${passed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
})().catch((e) => { console.error(e); process.exitCode = 1; });
