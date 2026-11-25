/* #414: update arrayFilters + $[identifier] 过滤位置更新 */
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
    await call('insert', { insert: 't', documents: [{ _id: 'a', arr: [1, 2, 3] }] });
    await t('arrayFilters i:0 updates arr[0] to 7', async () => {
      const r = await call('update', { update: 't', updates: [{
        q: { _id: 'a' }, u: { $set: { 'arr.$[i]': 7 } }, arrayFilters: [{ i: 0 }],
      }] });
      assert.strictEqual(r.nModified, 1);
      const found = await call('find', { find: 't', filter: { _id: 'a' } });
      assert.deepStrictEqual(found.cursor.firstBatch[0].arr, [7, 2, 3]);
    });
    await t('arrayFilters with operator matches multiple elements', async () => {
      // 当前 arr 为 [7,2,3]，$lte:3 命中后两个元素
      const r = await call('update', { update: 't', updates: [{
        q: { _id: 'a' }, u: { $set: { 'arr.$[i]': 9 } }, arrayFilters: [{ i: { $lte: 3 } }],
      }] });
      assert.strictEqual(r.nModified, 1);
      const found = await call('find', { find: 't', filter: { _id: 'a' } });
      assert.deepStrictEqual(found.cursor.firstBatch[0].arr, [7, 9, 9]);
    });
    await t('no matching element => nModified 0, array unchanged', async () => {
      const r = await call('update', { update: 't', updates: [{
        q: { _id: 'a' }, u: { $set: { 'arr.$[i]': 99 } }, arrayFilters: [{ i: 123 }],
      }] });
      assert.strictEqual(r.n, 1);
      assert.strictEqual(r.nModified, 0);
      const found = await call('find', { find: 't', filter: { _id: 'a' } });
      assert.deepStrictEqual(found.cursor.firstBatch[0].arr, [7, 9, 9]);
    });
  } finally { srv.close(); }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
