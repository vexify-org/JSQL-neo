// #493: Close 语句（DEALLOCATE）必须级联关闭绑定其上的 portal
const assert = require('assert');
const H = require('./issue-pg5-helper.js');
let passed = 0, failed = 0;
async function t(name, fn) {
  try { await fn(); passed++; console.log('ok - ' + name); }
  catch (e) { failed++; console.error('not ok - ' + name + '\n  ' + e.message); }
}
(async () => {
  await t('#493 DEALLOCATE 后 portal 返回 34000', async () => {
    const h = await H.startServer();
    try {
      const c = await H.pgConnect(h.port);
      c.sock.write(H.queryMsg('CREATE TABLE r5 (id INT)')); await H.pgDrain(c.rd);
      c.sock.write(H.queryMsg('INSERT INTO r5 VALUES (1)')); await H.pgDrain(c.rd);
      c.sock.write(Buffer.concat([H.parseMsg('s5', 'SELECT id FROM r5', []), H.bindMsg('p5', 's5', []), H.syncMsg()]));
      await H.pgDrain(c.rd, 250);
      c.sock.write(Buffer.concat([H.closeMsg(0x53, 's5'), H.syncMsg()]));
      await H.pgDrain(c.rd, 250);
      c.sock.write(Buffer.concat([H.executeMsg('p5'), H.syncMsg()]));
      const after = await H.pgDrain(c.rd, 300);
      assert.strictEqual(after.filter((p) => p.type === 0x44).length, 0, 'no DataRow after DEALLOCATE');
      const err = after.find((p) => p.type === 0x45);
      assert.ok(err, 'expected ErrorResponse');
      assert.strictEqual(H.errorFields(err).C, '34000');
    } finally { h.close(); }
  });
  console.log(`${passed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
})().catch((e) => { console.error(e); process.exitCode = 1; });
