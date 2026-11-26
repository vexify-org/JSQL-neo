/* #566: 超过 maxBsonObjectSize(16MiB) 的文档插入必须被拒绝 code 10334 */
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
    await t('17MiB document insert rejected with BSONObjectTooLarge', async () => {
      const big = 'x'.repeat(17 * 1024 * 1024);
      const r = await call('insert', { insert: 'big', documents: [{ _id: 'b1', blob: big }] });
      assert.strictEqual(r.ok, 0);
      assert.strictEqual(r.code, 10334);
    });
    await t('small document still inserts', async () => {
      const r = await call('insert', { insert: 'small', documents: [{ _id: 1, v: 'ok' }] });
      assert.strictEqual(r.ok, 1);
      assert.strictEqual(r.n, 1);
    });
  } finally { srv.close(); }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
