/* #570: createIndexes numIndexesBefore 反映登记前索引数量 */
const assert = require('assert');
const { createMongoServer } = require('../lib/mongo_server.js');

const srv = createMongoServer({ port: 0, dataDir: ':memory:' });
const call = (cmd, body) => srv._dispatch(cmd, Object.assign({ $db: 'test' }, body));

let passed = 0, failed = 0;
async function t(name, fn) {
  try { await fn(); passed++; console.log('ok - ' + name); }
  catch (e) { failed++; console.error('not ok - ' + name + '\n  ' + e.message); }
}

(async () => {
  try {
    await call('insert', { insert: 'c', documents: [{ a: 1 }] });
    await t('first createIndexes: before=1 after=2', async () => {
      const r = await call('createIndexes', { createIndexes: 'c', indexes: [{ key: { x: 1 }, name: 'x_1' }] });
      assert.strictEqual(r.numIndexesBefore, 1);
      assert.strictEqual(r.numIndexesAfter, 2);
    });
    await t('second createIndexes: before=2 after=3', async () => {
      const r = await call('createIndexes', { createIndexes: 'c', indexes: [{ key: { y: 1 }, name: 'y_1' }] });
      assert.strictEqual(r.numIndexesBefore, 2);
      assert.strictEqual(r.numIndexesAfter, 3);
    });
  } finally { srv.close(); }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
