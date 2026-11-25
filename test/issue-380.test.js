// #380: 多语句简单查询必须包在隐式事务里，任一句失败整批回滚
const assert = require('assert');
const H = require('./issue-pg5-helper.js');
let passed = 0, failed = 0;
async function t(name, fn) {
  try { await fn(); passed++; console.log('ok - ' + name); }
  catch (e) { failed++; console.error('not ok - ' + name + '\n  ' + e.message); }
}
(async () => {
  await t('#380 兄弟语句失败后同批写入回滚', async () => {
    const h = await H.startServer();
    try {
      const c = await H.pgConnect(h.port);
      c.sock.write(H.queryMsg('CREATE TABLE u (id INTEGER PRIMARY KEY, v TEXT)')); await H.pgDrain(c.rd);
      c.sock.write(H.queryMsg("INSERT INTO u VALUES (1, 'seed')")); await H.pgDrain(c.rd);
      c.sock.write(H.queryMsg("INSERT INTO u VALUES (2, 'b'); INSERT INTO u VALUES (1, 'dup');"));
      const batch = await H.pgDrain(c.rd, 300);
      assert.ok(batch.some((p) => p.type === 0x45), 'expected ErrorResponse for duplicate key');
      c.sock.write(H.queryMsg('SELECT id, v FROM u ORDER BY id'));
      const out = await H.pgDrain(c.rd, 300);
      const rows = out.filter((p) => p.type === 0x44).map(H.textValues);
      assert.deepStrictEqual(rows, [['1', 'seed']], 'failed batch must be rolled back');
    } finally { h.close(); }
  });
  console.log(`${passed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
})().catch((e) => { console.error(e); process.exitCode = 1; });
