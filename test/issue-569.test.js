/* #569: listDatabases 应返回真实库名，不能对数组二次 Object.keys */
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
    await call('insert', { insert: 'c', documents: [{ a: 1 }] });
    await t('databases[].name is real db name test', async () => {
      const r = await call('listDatabases', { listDatabases: 1 });
      assert.strictEqual(r.databases.length, 1);
      assert.strictEqual(r.databases[0].name, 'test');
    });
  } finally { srv.close(); }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
