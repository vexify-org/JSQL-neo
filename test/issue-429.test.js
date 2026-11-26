/* #429: writeConcern 的 w/j 必须校验，非法标签回 writeConcernError */
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
    await t('valid w:majority j:true accepted without writeConcernError', async () => {
      const r = await call('insert', { insert: 't', documents: [{ _id: 'a', v: 1 }], writeConcern: { w: 'majority', j: true } });
      assert.strictEqual(r.ok, 1);
      assert.strictEqual(r.writeConcernError, undefined);
    });
    await t('invalid w tag returns writeConcernError', async () => {
      const r = await call('insert', { insert: 't', documents: [{ _id: 'b', v: 1 }], writeConcern: { w: 'bogus-tag' } });
      assert.ok(r.writeConcernError, 'expected writeConcernError in ' + JSON.stringify(r));
      assert.ok(r.writeConcernError.code);
      assert.ok(/w/.test(r.writeConcernError.errmsg || ''));
    });
    await t('update also validates writeConcern', async () => {
      const r = await call('update', { update: 't', updates: [{ q: { _id: 'a' }, u: { $set: { v: 2 } } }], writeConcern: { w: 'bogus' } });
      assert.ok(r.writeConcernError, 'expected writeConcernError in ' + JSON.stringify(r));
    });
    await t('no writeConcern = no error field', async () => {
      const r = await call('insert', { insert: 't', documents: [{ _id: 'c' }] });
      assert.strictEqual(r.writeConcernError, undefined);
    });
  } finally { srv.close(); }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
