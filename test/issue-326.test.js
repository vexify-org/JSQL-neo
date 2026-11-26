/*
 * #326 回归测试：UNIQUE 列的小写变体必须按 ci 口径被拒绝（含 INSERT IGNORE）。
 *   node test/issue-326.test.js
 */
const assert = require('assert');
const path = require('path');
const { Database, executeSQL } = require(path.join(__dirname, '..', 'index.js'));

let passed = 0, failed = 0;
async function t(name, fn) {
  try { await fn(); passed++; console.log(`ok - ${name}`); }
  catch (e) { failed++; console.error(`not ok - ${name}\n  ${e && e.message}`); }
}
async function codeOf(db, sql) {
  try { await executeSQL(db, sql, { safety: false }); return null; }
  catch (e) { return e && e.code; }
}

(async () => {
  await t('#326 小写变体普通插入被 UNIQUE 拒绝（1062）', async () => {
    const db = new Database(':memory:');
    await executeSQL(db, 'CREATE TABLE uq (name TEXT UNIQUE)', { safety: false });
    await executeSQL(db, "INSERT INTO uq VALUES ('Ada')", { safety: false });
    assert.strictEqual(await codeOf(db, "INSERT INTO uq VALUES ('ada')"), 1062);
    await db.stop();
  });

  await t('#326 单行 insert({ignore:true}) 小写变体降级为 warning 且不落库', async () => {
    const db = new Database(':memory:');
    await executeSQL(db, 'CREATE TABLE uq2 (name TEXT UNIQUE)', { safety: false });
    await executeSQL(db, "INSERT INTO uq2 VALUES ('Ada')", { safety: false });
    const r = await db._tables.uq2.insert({ name: 'ada' }, { ignore: true });
    assert.ok(Array.isArray(r), 'duplicate row should be skipped');
    assert.ok(r.warnings && r.warnings.length > 0, 'expected warning');
    const rows = await db.find('uq2', {});
    assert.strictEqual(rows.length, 1);
    await db.stop();
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
})();
