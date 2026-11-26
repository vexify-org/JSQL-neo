/*
 * #475 回归测试：非唯一二级索引定义必须随 schema 落盘并在重开后重建。
 *   node test/issue-475.test.js
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Database, executeSQL } = require(path.join(__dirname, '..', 'index.js'));

let passed = 0, failed = 0;
async function t(name, fn) {
  try { await fn(); passed++; console.log(`ok - ${name}`); }
  catch (e) { failed++; console.error(`not ok - ${name}\n  ${e && e.message}`); }
}

(async () => {
  await t('#475 CREATE INDEX 重开库后 _indexes 仍含该列', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsql-475-'));
    const file = path.join(dir, 't.json');
    const db = new Database(file, { autoSave: false });
    await executeSQL(db, 'CREATE TABLE t (id INT PRIMARY KEY, name VARCHAR(32), city VARCHAR(32))', { safety: false });
    await executeSQL(db, 'CREATE INDEX idx_city ON t (city)', { safety: false });
    await db.insert('t', { id: 1, name: 'a', city: 'BJ' });
    assert.ok(db._tables.t._indexes.city, 'index present before save');
    await db.stop();

    const db2 = new Database(file, { autoSave: false });
    await db2.start();
    assert.ok(db2._tables.t._indexes.city, 'index rebuilt after reopen');
    assert.deepStrictEqual([...db2._tables.t._indexes.city.keys()], ['BJ']);
    await db2.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
})();
