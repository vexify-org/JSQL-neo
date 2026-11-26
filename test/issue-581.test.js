/*
 * #581 回归测试：UPDATE SET 引用未知列必须报 1054，且不得写入行对象。
 */
const assert = require('assert');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const { Database } = require(path.join(ROOT, 'index.js'));

let passed = 0, failed = 0;
async function t(name, fn) {
  try { await fn(); passed++; console.log(`ok - ${name}`); }
  catch (e) { failed++; console.error(`not ok - ${name}\n  ${e && e.message}`); }
}

(async () => {
  await t('#581 SQL UPDATE SET 未知列报 1054 且不生效', async () => {
    const db = new Database(':memory:');
    const run = (s) => db.query(s, { safety: false });
    await run('CREATE TABLE t (id INT PRIMARY KEY, v INT)');
    await run("INSERT INTO t VALUES (1,10),(2,20)");
    let err = null;
    try { await run('UPDATE t SET zz=5 WHERE id=1'); } catch (e) { err = e; }
    assert.ok(err, 'expected unknown-column error');
    assert.strictEqual(err.code, 1054);
    assert.match(err.message, /Unknown column 'zz'/);
    const r = await run('SELECT * FROM t');
    assert.deepStrictEqual(r.rows, [[1, 10], [2, 20]]);
    assert.ok(!Object.prototype.hasOwnProperty.call(db._tables.t._rows[0], 'zz'),
      'unknown key leaked into stored row');
    await db.stop();
  });

  await t('#581 合法的 UPDATE 不受影响', async () => {
    const db = new Database(':memory:');
    const run = (s) => db.query(s, { safety: false });
    await run('CREATE TABLE t (id INT PRIMARY KEY, v INT)');
    await run("INSERT INTO t VALUES (1,10)");
    await run('UPDATE t SET v=99 WHERE id=1');
    const r = await run('SELECT * FROM t');
    assert.deepStrictEqual(r.rows, [[1, 99]]);
    await db.stop();
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
