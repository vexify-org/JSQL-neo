/* #409: 查询顶层 $expr 应走聚合表达式求值 */
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
    await call('insert', { insert: 't', documents: [{ _id: 'a', x: 1, y: 1 }, { _id: 'b', x: 2, y: 9 }] });
    await t('$expr $eq field comparison matches a', async () => {
      const r = await call('find', { find: 't', filter: { $expr: { $eq: ['$x', '$y'] } } });
      assert.deepStrictEqual(r.cursor.firstBatch.map(x => x._id), ['a']);
    });
    await t('$expr $gt field comparison matches b', async () => {
      const r = await call('find', { find: 't', filter: { $expr: { $gt: ['$y', '$x'] } } });
      assert.deepStrictEqual(r.cursor.firstBatch.map(x => x._id), ['b']);
    });
    await t('$expr combines with normal predicates', async () => {
      const r = await call('find', { find: 't', filter: { x: 2, $expr: { $lt: ['$y', 20] } } });
      assert.deepStrictEqual(r.cursor.firstBatch.map(x => x._id), ['b']);
    });
  } finally { srv.close(); }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
