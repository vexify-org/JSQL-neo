// #551: 命名 portal 在 COMMIT 后必须销毁，再 Execute 回 34000 invalid_portal_name
const assert = require('assert');
const H = require('./issue-pg5-helper.js');
let passed = 0, failed = 0;
async function t(name, fn) {
  try { await fn(); passed++; console.log('ok - ' + name); }
  catch (e) { failed++; console.error('not ok - ' + name + '\n  ' + e.message); }
}
(async () => {
  await t('#551 COMMIT 后 portal 不再可执行', async () => {
    const h = await H.startServer();
    try {
      const c = await H.pgConnect(h.port);
      c.sock.write(H.queryMsg('CREATE TABLE pt (id INT, v TEXT)')); await H.pgDrain(c.rd);
      c.sock.write(H.queryMsg("INSERT INTO pt VALUES (1, 'a')")); await H.pgDrain(c.rd);
      c.sock.write(H.queryMsg('BEGIN')); await H.pgDrain(c.rd);
      c.sock.write(Buffer.concat([
        H.parseMsg('s1', 'SELECT id, v FROM pt', []), H.bindMsg('p1', 's1', []),
        H.executeMsg('p1'), H.syncMsg()
      ]));
      const inTxn = await H.pgDrain(c.rd, 300);
      assert.ok(inTxn.some((p) => p.type === 0x44), 'in-txn Execute should return DataRow');
      c.sock.write(H.queryMsg('COMMIT')); await H.pgDrain(c.rd);
      c.sock.write(Buffer.concat([H.executeMsg('p1'), H.syncMsg()]));
      const after = await H.pgDrain(c.rd, 300);
      assert.strictEqual(after.filter((p) => p.type === 0x44).length, 0, 'no DataRow after COMMIT');
      const err = after.find((p) => p.type === 0x45);
      assert.ok(err, 'expected ErrorResponse after COMMIT');
      assert.strictEqual(H.errorFields(err).C, '34000');
    } finally { h.close(); }
  });
  console.log(`${passed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
})().catch((e) => { console.error(e); process.exitCode = 1; });
