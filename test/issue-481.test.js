/*
 * #481 大文件导入内存：parseCSV 一次性物化全部记录。
 * 修复后提供 parseCSVStream 生成器，importFromCSV 边取边分批 insert。
 *   node test/issue-481.test.js
 */
const assert = require('assert');
const migrate = require('../lib/migrate');

let passed = 0, failed = 0;
async function t(name, fn) {
  try { await fn(); passed++; console.log(`ok - ${name}`); }
  catch (e) { failed++; console.error(`not ok - ${name}\n  ${e && e.message}`); }
}

const csv = 'id,name\n' + Array.from({ length: 1000 }, (_, i) => `${i},user_${i}`).join('\n') + '\n';

(async () => {
  await t('#481 提供惰性 parseCSVStream 生成器', async () => {
    assert.strictEqual(typeof migrate.parseCSVStream, 'function', '缺少流式解析接口');
    const it = migrate.parseCSVStream(csv, {});
    assert.strictEqual(typeof it.next, 'function', 'parseCSVStream 应返回迭代器');
    // 遇到第 4 行才会触碰 maxRows 护栏：先取两行应安全返回，证明未提前物化全部行
    let rows = 0;
    const guard = migrate.parseCSVStream(csv, { maxRows: 3 });
    assert.deepStrictEqual(guard.next().value, ['id', 'name']);
    assert.deepStrictEqual(guard.next().value, ['0', 'user_0']);
    assert.throws(() => { for (const _ of guard) rows++; }, /too many rows/i);
  });

  await t('#481 parseCSVStream 逐行产出与 parseCSV 一致', async () => {
    const all = [...migrate.parseCSVStream(csv, {})];
    assert.deepStrictEqual(all, migrate.parseCSV(csv, {}));
    assert.strictEqual(all.length, 1001);
  });

  await t('#481 importFromCSV 流式路径按 chunkSize 分批写入', async () => {
    const batches = [];
    const fake = {
      hasTable: () => true,
      getTableSchema: () => ({ id: { type: 'integer' }, name: { type: 'string' } }),
      insert: async (_t, rows) => { batches.push(rows.length); return rows.map(() => 1); }
    };
    const r = await migrate.importFromCSV(fake, 't', csv, { chunkSize: 100 });
    assert.strictEqual(r.inserted, 1000);
    assert.strictEqual(batches.length, 10);
    assert.ok(batches.every(n => n === 100), JSON.stringify(batches));
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
