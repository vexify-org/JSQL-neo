/*
 * #361 importFromJSON 多表导入中途失败不回滚，残留半成品库。
 *   node test/issue-361.test.js
 */
const assert = require('assert');
const { Database } = require('../index.js');
const migrate = require('../lib/migrate');

let passed = 0, failed = 0;
async function t(name, fn) {
  try { await fn(); passed++; console.log(`ok - ${name}`); }
  catch (e) { failed++; console.error(`not ok - ${name}\n  ${e && e.message}`); }
}

(async () => {
  await t('#361 中途失败应回滚已建表与已插入行', async () => {
    const db = new Database(':memory:', { autoSave: false });
    try {
      let err = null;
      try {
        await migrate.importFromJSON(db, {
          a: { schema: { id: { type: 'integer', primaryKey: true }, s: { type: 'string' } },
                rows: [{ id: 1, s: 'keep-me' }] },
          b: { schema: { id: { type: 'integer', primaryKey: true }, n: { type: 'integer' } },
                rows: [{ id: 1, n: 'not-a-number' }] },
        });
      } catch (e) { err = e; }
      assert.ok(err, '非法行应抛错');
      assert.deepStrictEqual(await db.getTables(), [], '失败后不应残留任何表');
    } finally { await db.stop(); }
  });

  await t('#361 覆盖既有表时失败应恢复原表数据', async () => {
    const db = new Database(':memory:', { autoSave: false });
    try {
      await db.createTable('a', { id: { type: 'integer', primaryKey: true }, s: { type: 'string' } });
      await db.insert('a', { id: 1, s: 'original' });
      let err = null;
      try {
        await migrate.importFromJSON(db, {
          a: { schema: { id: 'integer', s: 'string' }, rows: [{ id: 2, s: 'replaced' }] },
          b: { schema: { id: 'integer', n: 'integer' }, rows: [{ id: 1, n: 'bad' }] },
        }, { overwrite: true });
      } catch (e) { err = e; }
      assert.ok(err);
      assert.deepStrictEqual(await db.getTables(), ['a']);
      const rows = await db.find('a', {});
      assert.strictEqual(rows.length, 1);
      assert.strictEqual(rows[0].s, 'original');
    } finally { await db.stop(); }
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
