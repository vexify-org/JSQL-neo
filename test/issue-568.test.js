/* #568: find/count/distinct 等读命令不得自动建表 */
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
    const eng = await srv._getEngine('test');
    await t('find on missing collection does not create table', async () => {
      assert.strictEqual(eng.hasTable('ghost'), false);
      const r = await call('find', { find: 'ghost', filter: {} });
      assert.deepStrictEqual(r.cursor.firstBatch, []);
      assert.strictEqual(eng.hasTable('ghost'), false);
    });
    await t('count on missing collection does not create table', async () => {
      const r = await call('count', { count: 'ghost2', query: {} });
      assert.strictEqual(r.n, 0);
      assert.strictEqual(eng.hasTable('ghost2'), false);
    });
    await t('distinct on missing collection does not create table', async () => {
      const r = await call('distinct', { distinct: 'ghost3', key: 'a' });
      assert.deepStrictEqual(r.values, []);
      assert.strictEqual(eng.hasTable('ghost3'), false);
    });
    await t('listCollections does not show ghost collections', async () => {
      const r = await call('listCollections', { listCollections: 1 });
      const names = r.cursor.firstBatch.map(x => x.name);
      assert.ok(!names.includes('ghost'));
      assert.ok(!names.includes('ghost2'));
    });
    await t('insert still creates table', async () => {
      await call('insert', { insert: 'real', documents: [{ _id: 1 }] });
      assert.strictEqual(eng.hasTable('real'), true);
    });
  } finally { srv.close(); }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
