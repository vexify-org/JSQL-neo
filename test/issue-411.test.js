/* #411: find 投影 $slice / $elemMatch 数组操作符 */
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
    await call('insert', { insert: 't', documents: [
      { _id: 'p', arr: [1, 2, 3, 4], scores: [{ v: 9 }, { v: 3 }] },
    ] });
    await t('$slice:2 truncates array', async () => {
      const r = await call('find', { find: 't', filter: {}, projection: { arr: { $slice: 2 } } });
      assert.deepStrictEqual(r.cursor.firstBatch[0].arr, [1, 2]);
    });
    await t('$slice:[1,2] skips and limits', async () => {
      const r = await call('find', { find: 't', filter: {}, projection: { arr: { $slice: [1, 2] } } });
      assert.deepStrictEqual(r.cursor.firstBatch[0].arr, [2, 3]);
    });
    await t('$elemMatch projection keeps only first matching element', async () => {
      const r = await call('find', { find: 't', filter: {}, projection: { scores: { $elemMatch: { v: { $gte: 5 } } } } });
      assert.deepStrictEqual(r.cursor.firstBatch[0].scores, [{ v: 9 }]);
    });
    await t('ordinary object projection value still clones normally', async () => {
      const r = await call('find', { find: 't', filter: {}, projection: { scores: 1 } });
      assert.deepStrictEqual(r.cursor.firstBatch[0].scores, [{ v: 9 }, { v: 3 }]);
    });
  } finally { srv.close(); }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
