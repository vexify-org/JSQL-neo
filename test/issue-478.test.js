/*
 * #478 JSON 导入 rows 非数组（对象/字符串）时静默建空表。
 *   node test/issue-478.test.js
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
  await t('#478 rows 为对象时收集 errors（表名 + 实际类型）', async () => {
    const db = new Database(':memory:', { autoSave: false });
    try {
      const r = await migrate.importFromJSON(db, {
        g: { schema: { id: 'integer' }, rows: { id: 1 } },
      });
      assert.ok(Array.isArray(r.errors), `缺少 errors: ${JSON.stringify(r)}`);
      const e = r.errors.find(x => x.table === 'g' && /rows/i.test(x.reason || x.error || ''));
      assert.ok(e, JSON.stringify(r.errors));
      assert.strictEqual(e.type, 'object');
    } finally { await db.stop(); }
  });

  await t('#478 rows 为字符串时收集 errors', async () => {
    const db = new Database(':memory:', { autoSave: false });
    try {
      const r = await migrate.importFromJSON(db, {
        g: { schema: { id: 'integer' }, rows: 'oops' },
      });
      assert.ok(r.errors.some(x => x.table === 'g' && x.type === 'string'), JSON.stringify(r.errors));
    } finally { await db.stop(); }
  });

  await t('#478 strict 下 rows 非数组中止且不残留表', async () => {
    const db = new Database(':memory:', { autoSave: false });
    try {
      await assert.rejects(
        () => migrate.importFromJSON(db, { g: { schema: { id: 'integer' }, rows: { id: 1 } } }, { strict: true }),
        /rows/i
      );
      assert.deepStrictEqual(await db.getTables(), []);
    } finally { await db.stop(); }
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
