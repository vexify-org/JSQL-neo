/* #571: $unwind includeArrayIndex 应输出数组下标字段 */
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
    await call('insert', { insert: 'u', documents: [{ _id: 1, tags: ['x', 'y'] }, { _id: 2, tags: [] }] });
    await t('includeArrayIndex writes 0/1 on each unwound doc', async () => {
      const r = await call('aggregate', { aggregate: 'u', pipeline: [
        { $unwind: { path: '$tags', includeArrayIndex: 'idx' } },
      ] });
      const rows = r.cursor.firstBatch.filter(x => x._id === 1);
      assert.deepStrictEqual(rows, [{ _id: 1, tags: 'x', idx: 0 }, { _id: 1, tags: 'y', idx: 1 }]);
    });
    await t('string $unwind form still works (no idx)', async () => {
      const r = await call('aggregate', { aggregate: 'u', pipeline: [{ $unwind: '$tags' }] });
      assert.strictEqual(r.cursor.firstBatch.length, 2);
      assert.strictEqual(r.cursor.firstBatch[0].idx, undefined);
    });
  } finally { srv.close(); }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
