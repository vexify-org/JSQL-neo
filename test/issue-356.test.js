/*
 * #356 回归测试：活跃事务中再次 beginTx() 必须报 1568，不得覆盖外层快照。
 */
const assert = require('assert');
const path = require('path');
const { Database } = require(path.join(__dirname, '..', 'index.js'));

(async () => {
  const db = new Database(':memory:');
  await db.createTable('t', { id: { type: 'integer', primaryKey: true }, v: { type: 'string' } });
  await db.insert('t', { id: 1, v: 'baseline' });

  await db.beginTx();
  await db.insert('t', { id: 2, v: 'outer-tx' });
  let err = null;
  try { await db.beginTx(); } catch (e) { err = e; }
  assert.ok(err, 'nested beginTx must be rejected');
  assert.strictEqual(err.code, 1568);
  await db.insert('t', { id: 3, v: 'inner-tx' });

  await db.rollbackTx();
  const rows = (await db.find('t')).map(r => [r.id, r.v]);
  assert.deepStrictEqual(rows, [[1, 'baseline']], 'outer write must be rolled back: ' + JSON.stringify(rows));

  await db.stop();
  console.log('3 passed, 0 failed');
})().catch((e) => { console.error('not ok - #356\n  ' + e.message); process.exit(1); });
