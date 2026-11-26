/*
 * #436 回归测试：QueryBuilder 聚合按 SQL 语义忽略 NULL，空集返回 NULL。
 *   node test/issue-436.test.js
 */
const assert = require('assert');
const path = require('path');
const { Database, Query } = require(path.join(__dirname, '..', 'index.js'));

let passed = 0, failed = 0;
async function t(name, fn) {
  try { await fn(); passed++; console.log(`ok - ${name}`); }
  catch (e) { failed++; console.error(`not ok - ${name}\n  ${e && e.message}`); }
}

(async () => {
  const db = new Database(':memory:', { autoSave: false });
  await db.createTable('q', { v: { type: 'integer' } });
  await db.insert('q', { v: 10 });
  await db.insert('q', { v: 20 });
  await db.insert('q', { v: null });
  const table = db._tables.q;

  await t('#436 min/avg 忽略 NULL：min=10 avg=15', async () => {
    const qb = new Query(table);
    assert.strictEqual(qb.sum('v'), 30);
    assert.strictEqual(qb.min('v'), 10);
    assert.strictEqual(qb.max('v'), 20);
    assert.strictEqual(qb.avg('v'), 15);
  });

  await t('#436 count() 仍是 COUNT(*)', async () => {
    assert.strictEqual(new Query(table).count(), 3);
  });

  await t('#436 空集 avg/min/max/sum 返回 null', async () => {
    const qb = new Query(table, { v: 999 });
    assert.strictEqual(qb.avg('v'), null);
    assert.strictEqual(qb.min('v'), null);
    assert.strictEqual(qb.max('v'), null);
    assert.strictEqual(qb.sum('v'), null);
    assert.strictEqual(qb.count(), 0);
  });

  await db.stop();
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
})();
