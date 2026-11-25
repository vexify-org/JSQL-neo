/* #431: $lookup pipeline / let 高级形式 */
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
    await call('insert', { insert: 'c', documents: [{ _id: 'a', name: 'Ann' }, { _id: 'b', name: 'Bob' }] });
    await call('insert', { insert: 'o', documents: [{ _id: 'o1', cid: 'a', amt: 5 }] });
    await t('pipeline $project is applied to joined docs', async () => {
      const r = await call('aggregate', { aggregate: 'o', pipeline: [{ $lookup: {
        from: 'c', localField: 'cid', foreignField: '_id', as: 'people',
        pipeline: [{ $project: { name: 1, _id: 0 } }], let: { c: '$cid' },
      } }] });
      assert.deepStrictEqual(r.cursor.firstBatch[0].people, [{ name: 'Ann' }]);
    });
    await t('pipeline $match filters joined docs', async () => {
      const r = await call('aggregate', { aggregate: 'o', pipeline: [{ $lookup: {
        from: 'c', localField: 'cid', foreignField: '_id', as: 'people',
        pipeline: [{ $match: { name: 'Nobody' } }],
      } }] });
      assert.deepStrictEqual(r.cursor.firstBatch[0].people, []);
    });
    await t('basic lookup without pipeline still works', async () => {
      const r = await call('aggregate', { aggregate: 'o', pipeline: [{ $lookup: {
        from: 'c', localField: 'cid', foreignField: '_id', as: 'people',
      } }] });
      assert.deepStrictEqual(r.cursor.firstBatch[0].people, [{ _id: 'a', name: 'Ann' }]);
    });
  } finally { srv.close(); }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
