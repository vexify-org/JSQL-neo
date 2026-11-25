// #552: 扩展批次中 Bind 报错后排队的 Execute 必须丢弃，直到 Sync 只发一个 ErrorResponse
const assert = require('assert');
const H = require('./issue-pg5-helper.js');
let passed = 0, failed = 0;
async function t(name, fn) {
  try { await fn(); passed++; console.log('ok - ' + name); }
  catch (e) { failed++; console.error('not ok - ' + name + '\n  ' + e.message); }
}
(async () => {
  await t('#552 Bind 错误后 Execute 被丢弃，批次仅一个 E', async () => {
    const h = await H.startServer();
    try {
      const c = await H.pgConnect(h.port);
      c.sock.write(H.queryMsg('CREATE TABLE bt (id INT)')); await H.pgDrain(c.rd);
      c.sock.write(Buffer.concat([
        H.parseMsg('s1', 'SELECT id FROM bt', []),
        H.bindMsg('p1', 'ghost_stmt', []),
        H.executeMsg('p1'),
        H.syncMsg()
      ]));
      const out = await H.pgDrain(c.rd, 400);
      const errs = out.filter((p) => p.type === 0x45);
      assert.strictEqual(errs.length, 1, 'ErrorResponse count=' + errs.length + ' frames=' + out.map((p) => p.type.toString(16)).join(','));
      assert.ok(/ghost_stmt/.test(H.errorFields(errs[0]).M));
      assert.strictEqual(out.filter((p) => p.type === 0x5a).length, 1, 'exactly one ReadyForQuery');
    } finally { h.close(); }
  });
  console.log(`${passed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
})().catch((e) => { console.error(e); process.exitCode = 1; });
