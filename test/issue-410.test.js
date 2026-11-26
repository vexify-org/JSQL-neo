/* #410: $group._id 对象表达式应逐行求值 */
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
      { _id: 'a', x: 1, c: 10 }, { _id: 'b', x: 2, c: 20 }, { _id: 'd', x: 1, c: 30 },
    ] });
    await t('object _id groups by evaluated expression', async () => {
      const r = await call('aggregate', { aggregate: 't', pipeline: [
        { $group: { _id: { k: '$x' }, total: { $sum: '$c' } } },
      ] });
      const rows = r.cursor.firstBatch.map(x => ({ k: x._id.k, total: x.total })).sort((a, b) => a.k - b.k);
      assert.deepStrictEqual(rows, [{ k: 1, total: 40 }, { k: 2, total: 20 }]);
    });
    await t('nested object _id expression', async () => {
      const r = await call('aggregate', { aggregate: 't', pipeline: [
        { $group: { _id: { g: { v: '$x' } }, n: { $sum: 1 } } },
      ] });
      const rows = r.cursor.firstBatch.map(x => x._id.g.v).sort((a, b) => a - b);
      assert.deepStrictEqual(rows, [1, 2]);
    });
  } finally { srv.close(); }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
