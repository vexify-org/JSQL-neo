/* #427: update 回复 nModified 不计 no-op / upsert，upsert 需回 upserted */
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
    await call('insert', { insert: 't', documents: [{ _id: 'a', n: 5 }] });
    await t('no-op $min reports n:1 nModified:0', async () => {
      const r = await call('update', { update: 't', updates: [{ q: { _id: 'a' }, u: { $min: { n: 10 } } }] });
      assert.strictEqual(r.n, 1);
      assert.strictEqual(r.nModified, 0);
    });
    await t('real modification reports nModified:1', async () => {
      const r = await call('update', { update: 't', updates: [{ q: { _id: 'a' }, u: { $set: { n: 7 } } }] });
      assert.strictEqual(r.n, 1);
      assert.strictEqual(r.nModified, 1);
    });
    await t('upsert reports n:1 nModified:0 and upserted array', async () => {
      const r = await call('update', { update: 't', updates: [{ q: { _id: 'zz' }, u: { $set: { z: 1 } }, upsert: true }] });
      assert.strictEqual(r.n, 1);
      assert.strictEqual(r.nModified, 0);
      assert.deepStrictEqual(r.upserted, [{ index: 0, _id: 'zz' }]);
    });
  } finally { srv.close(); }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
