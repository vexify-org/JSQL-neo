/*
 * #476 importFromJSON 顶层数组：被当成下标 "0" 建幽灵表或静默零导入。
 *   node test/issue-476.test.js
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
  await t('#476 顶层数组（对象元素）应显式拒绝', async () => {
    const db = new Database(':memory:', { autoSave: false });
    try {
      await assert.rejects(
        () => migrate.importFromJSON(db, [
          { table: 'x', schema: { a: 'integer' }, rows: [{ a: 1 }] }
        ]),
        /expected an object map|顶层数组|数组/i
      );
      assert.deepStrictEqual(await db.getTables(), []);
    } finally { await db.stop(); }
  });

  await t('#476 数组形态 JSON 文本应显式拒绝', async () => {
    const db = new Database(':memory:', { autoSave: false });
    try {
      await assert.rejects(
        () => migrate.importFromJSON(db, '[{"a":1},{"a":2}]'),
        /expected an object map|顶层数组|数组/i
      );
    } finally { await db.stop(); }
  });

  await t('#476 合法单表形状仍可导入', async () => {
    const db = new Database(':memory:', { autoSave: false });
    try {
      const r = await migrate.importFromJSON(db, { table: 'x', schema: { a: 'integer' }, rows: [{ a: 1 }] });
      assert.strictEqual(r.inserted, 1);
      assert.deepStrictEqual(await db.getTables(), ['x']);
    } finally { await db.stop(); }
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
