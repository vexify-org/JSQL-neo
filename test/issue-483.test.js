/*
 * #483 JSON 导出→导入往返丢失列元数据（length / text 类型）。
 *   node test/issue-483.test.js
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
  await t('#483 normalizeSchema 保留 length 与 text 类型', async () => {
    const s = migrate.normalizeSchema({
      id: { type: 'integer', primaryKey: true },
      name: { type: 'string', length: 255, required: true },
      bio: { type: 'text' },
    });
    assert.strictEqual(s.name.length, 255);
    assert.strictEqual(s.name.required, true);
    assert.strictEqual(s.bio.type, 'text');
  });

  await t('#483 JSON 导出→导入往返 schema 闭合', async () => {
    const db = new Database(':memory:', { autoSave: false });
    const db2 = new Database(':memory:', { autoSave: false });
    try {
      await db.createTable('meta', {
        id: { type: 'integer', primaryKey: true },
        name: { type: 'string', length: 255, required: true },
        bio: { type: 'text' },
      });
      await db.insert('meta', [{ name: 'a', bio: 'x' }]);
      const payload = await migrate.exportTableToJSON(db, 'meta');
      await migrate.importFromJSON(db2, payload);
      const s1 = await db.getTableSchema('meta');
      const s2 = await db2.getTableSchema('meta');
      assert.deepStrictEqual(s2, s1);
      assert.strictEqual((await db2.find('meta', {}))[0].name, 'a');
    } finally { await db.stop(); await db2.stop(); }
  });

  await t('#483 maxLength 别名回迁为 length，且已有 length 不被覆盖', async () => {
    const s = migrate.normalizeSchema({
      a: { type: 'string', maxLength: 64 },
      b: { type: 'string', length: 10, maxLength: 64 },
    });
    assert.strictEqual(s.a.length, 64);
    assert.strictEqual(s.b.length, 10);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
