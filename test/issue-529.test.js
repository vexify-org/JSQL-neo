/*
 * #529 回归测试：insertMany 必须维护已有 legacy hash 二级索引。
 *   node test/issue-529.test.js
 */
const assert = require('assert');
const path = require('path');
const { Database } = require(path.join(__dirname, '..', 'index.js'));

let passed = 0, failed = 0;
async function t(name, fn) {
  try { await fn(); passed++; console.log(`ok - ${name}`); }
  catch (e) { failed++; console.error(`not ok - ${name}\n  ${e && e.message}`); }
}

(async () => {
  await t('#529 建索引后 insertMany 同值行全部可被 find 命中', async () => {
    const db = new Database(':memory:');
    await db.query('CREATE TABLE t(id INTEGER PRIMARY KEY, c STRING)', { safety: false });
    await db.insertMany('t', [{ id: 1, c: 'x' }, { id: 2, c: 'y' }]);
    db._tables.t.createIndex('c');
    await db.insertMany('t', [{ id: 3, c: 'x' }, { id: 4, c: 'y' }, { id: 5, c: 'x' }]);
    const found = (await db.find('t', { c: 'x' })).map(r => r.id).sort((a, b) => a - b);
    assert.deepStrictEqual(found, [1, 3, 5]);
    await db.stop();
  });

  await t('#529 索引 Map 登记了新插入行的位置', async () => {
    const db = new Database(':memory:');
    await db.query('CREATE TABLE t(id INTEGER PRIMARY KEY, c STRING)', { safety: false });
    await db.insertMany('t', [{ id: 1, c: 'x' }]);
    db._tables.t.createIndex('c');
    await db.insertMany('t', [{ id: 2, c: 'x' }, { id: 3, c: 'x' }]);
    assert.deepStrictEqual(db._tables.t._indexes.c.get('x'), [0, 1, 2]);
    await db.stop();
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
})();
