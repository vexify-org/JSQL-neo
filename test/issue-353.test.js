// #353: LISTEN/UNLISTEN/NOTIFY 与 AsynchronousNotification(A) 帧
const assert = require('assert');
const H = require('./issue-pg5-helper.js');
let passed = 0, failed = 0;
async function t(name, fn) {
  try { await fn(); passed++; console.log('ok - ' + name); }
  catch (e) { failed++; console.error('not ok - ' + name + '\n  ' + e.message); }
}
(async () => {
  await t('#353 LISTEN 订阅后收到 NOTIFY 的 A 帧，UNLISTEN 后不再收到', async () => {
    const h = await H.startServer();
    try {
      const c1 = await H.pgConnect(h.port);
      c1.sock.write(H.queryMsg('LISTEN foo'));
      const l = await H.pgDrain(c1.rd, 200);
      assert.ok(H.commandTags(l).includes('LISTEN'), 'LISTEN should return CommandComplete; frames=' + l.map((p) => p.type.toString(16)).join(','));
      const c2 = await H.pgConnect(h.port);
      c2.sock.write(H.queryMsg("NOTIFY foo, 'hello'"));
      const n = await H.pgDrain(c2.rd, 200);
      assert.ok(H.commandTags(n).includes('NOTIFY'), 'NOTIFY should return CommandComplete');
      const notifications = (await H.pgDrain(c1.rd, 200)).filter((p) => p.type === 0x41);
      assert.strictEqual(notifications.length, 1, 'expected one AsynchronousNotification');
      const s = notifications[0].payload.toString('utf8', 4);
      assert.ok(s.includes('foo') && s.includes('hello'), 'payload=' + JSON.stringify(s));

      c1.sock.write(H.queryMsg('UNLISTEN foo')); await H.pgDrain(c1.rd, 200);
      c2.sock.write(H.queryMsg("NOTIFY foo, 'again'")); await H.pgDrain(c2.rd, 200);
      const after = (await H.pgDrain(c1.rd, 200)).filter((p) => p.type === 0x41);
      assert.strictEqual(after.length, 0, 'no notification after UNLISTEN');
    } finally { h.close(); }
  });
  console.log(`${passed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
})().catch((e) => { console.error(e); process.exitCode = 1; });
