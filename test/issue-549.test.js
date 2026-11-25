/*
 * #549 回归测试：undo() 回滚快照后必须重建 _pkIndex，主键点查不能指向错行。
 */
const assert = require('assert');
const path = require('path');
const { Database } = require(path.join(__dirname, '..', 'index.js'));

(async () => {
  const db = new Database(':memory:', { versioning: true, maxVersions: 20 });
  await db.query('CREATE TABLE t(id INTEGER PRIMARY KEY, v STRING)');
  await db.insertMany('t', [{ id: 1, v: 'A' }, { id: 2, v: 'B' }, { id: 3, v: 'C' }]);
  await db.snapshot('t');
  await db.removeById('t', 2);   // swap-last：C3 落到位置 1
  await db.snapshot('t');
  await db.undo('t', 1);         // 恢复 [A1,B2,C3]

  const t = db._tables.t;
  assert.deepStrictEqual(t._rows.map(r => [r.id, r.v]), [[1, 'A'], [2, 'B'], [3, 'C']]);
  assert.strictEqual(t.findById(3).v, 'C', 'pk 3 应指向 C 行');
  assert.strictEqual(t.findById(2).v, 'B', 'pk 2 应指向 B 行');
  assert.strictEqual(t._pkIndex.get(3), 2, 'pkIndex[3] 应指向下标 2');
  assert.strictEqual(t._pkIndex.get(2), 1, 'pkIndex[2] 应指向下标 1');

  await db.stop();
  console.log('5 passed, 0 failed');
})().catch((e) => { console.error('not ok - #549\n  ' + e.message); process.exit(1); });
