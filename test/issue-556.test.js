// #556: 未定义函数调用错误码应为 42883 undefined_function，而非 XX000
const assert = require('assert');
const H = require('./issue-pg5-helper.js');
let passed = 0, failed = 0;
async function t(name, fn) {
  try { await fn(); passed++; console.log('ok - ' + name); }
  catch (e) { failed++; console.error('not ok - ' + name + '\n  ' + e.message); }
}
(async () => {
  await t('#556 SELECT 不存在的函数 → 42883', async () => {
    const h = await H.startServer();
    try {
      const c = await H.pgConnect(h.port);
      c.sock.write(H.queryMsg('CREATE TABLE ft2 (id INT)')); await H.pgDrain(c.rd);
      c.sock.write(H.queryMsg('INSERT INTO ft2 VALUES (1)')); await H.pgDrain(c.rd);
      c.sock.write(H.queryMsg('SELECT nosuchfunc(1) FROM ft2'));
      const out = await H.pgDrain(c.rd, 250);
      const err = out.find((p) => p.type === 0x45);
      assert.ok(err, 'expected ErrorResponse; frames=' + out.map((p) => p.type.toString(16)).join(','));
      assert.strictEqual(H.errorFields(err).C, '42883');
    } finally { h.close(); }
  });
  console.log(`${passed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
})().catch((e) => { console.error(e); process.exitCode = 1; });
