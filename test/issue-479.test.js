/*
 * #479 JSON 导入条目缺 schema 被静默跳过，调用方无法发现漏导。
 *   node test/issue-479.test.js
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
  await t('#479 缺 schema 的条目记入 errors/skipped', async () => {
    const db = new Database(':memory:', { autoSave: false });
    try {
      const r = await migrate.importFromJSON(db, {
        g: { rows: [{ id: 1 }] },
        h: { schema: { id: 'integer' }, rows: [{ id: 2 }] },
      });
      assert.deepStrictEqual(r.created, ['h']);
      assert.ok(Array.isArray(r.errors), `缺少 errors: ${JSON.stringify(r)}`);
      assert.ok(r.errors.some(e => e.table === 'g' && /schema/i.test(e.reason || e.error || '')),
        JSON.stringify(r.errors));
      assert.strictEqual(r.skipped, 1);
    } finally { await db.stop(); }
  });

  await t('#479 strict 下缺 schema 直接抛错', async () => {
    const db = new Database(':memory:', { autoSave: false });
    try {
      await assert.rejects(
        () => migrate.importFromJSON(db, { g: { rows: [{ id: 1 }] } }, { strict: true }),
        /schema/i
      );
      assert.deepStrictEqual(await db.getTables(), []);
    } finally { await db.stop(); }
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
