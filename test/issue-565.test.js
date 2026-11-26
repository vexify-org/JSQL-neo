/* #565: 查询操作符 $mod [divisor, remainder] */
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
    await call('insert', { insert: 'm', documents: [{ _id: 1, age: 10 }, { _id: 2, age: 20 }, { _id: 3, age: 30 }] });
    await t('$mod [7,3] only matches age%7==3 (age 10)', async () => {
      const r = await call('find', { find: 'm', filter: { age: { $mod: [7, 3] } } });
      assert.deepStrictEqual(r.cursor.firstBatch.map(x => x._id), [1]);
    });
    await t('$mod [7,5] matches none', async () => {
      const r = await call('find', { find: 'm', filter: { age: { $mod: [7, 5] } } });
      assert.deepStrictEqual(r.cursor.firstBatch.map(x => x._id), []);
    });
    await t('$mod works in aggregate $match too', async () => {
      const r = await call('aggregate', { aggregate: 'm', pipeline: [{ $match: { age: { $mod: [7, 3] } } }] });
      assert.deepStrictEqual(r.cursor.firstBatch.map(x => x._id), [1]);
    });
  } finally { srv.close(); }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
