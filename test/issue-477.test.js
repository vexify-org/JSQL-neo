/*
 * #477 CSV 重复表头：后列静默覆盖前列，warnings 通道无记录。
 *   node test/issue-477.test.js
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
  await t('#477 重复表头记入 warnings（列名 + 位置）', async () => {
    const db = new Database(':memory:', { autoSave: false });
    try {
      const r = await migrate.importFromCSV(db, 'dup', 'id,name,name,age\n1,alice,Alice,30\n', {
        schema: { id: 'integer', name: 'string', age: 'integer' }
      });
      assert.strictEqual(r.inserted, 1);
      assert.ok(r.warnings && r.warnings.some(w => w.kind === 'duplicateHeader' && w.column === 'name'),
        `缺少 duplicateHeader 告警: ${JSON.stringify(r.warnings)}`);
      const w = r.warnings.find(w => w.kind === 'duplicateHeader');
      assert.ok(Array.isArray(w.indices) && w.indices.includes(1) && w.indices.includes(2), JSON.stringify(w));
    } finally { await db.stop(); }
  });

  await t('#477 strictRows 下重复表头中止', async () => {
    const db = new Database(':memory:', { autoSave: false });
    try {
      await assert.rejects(
        () => migrate.importFromCSV(db, 'dup', 'id,name,name\n1,alice,Alice\n', {
          schema: { id: 'integer', name: 'string' }, strictRows: true
        }),
        /duplicate.*header|重复表头/i
      );
    } finally { await db.stop(); }
  });

  await t('#477 无重复表头时不产生 duplicateHeader 告警', async () => {
    const db = new Database(':memory:', { autoSave: false });
    try {
      const r = await migrate.importFromCSV(db, 'ok', 'id,name\n1,alice\n', {
        schema: { id: 'integer', name: 'string' }
      });
      assert.ok(!r.warnings || !r.warnings.some(w => w.kind === 'duplicateHeader'));
    } finally { await db.stop(); }
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
