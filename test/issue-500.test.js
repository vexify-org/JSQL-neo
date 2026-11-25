/*
 * #500 回归测试：插件上下文 ctx.table(name) 应返回 Table 实例（Pure JS 引擎）。
 *   node test/issue-500.test.js
 */
const assert = require('assert');
const path = require('path');
const { Database } = require(path.join(__dirname, '..', 'index.js'));

let passed = 0, failed = 0;
async function t(name, fn) {
  try { await fn(); passed++; console.log(`ok - ${name}`); }
  catch (e) { failed++; console.error(`not ok - ${name}\n  ${e && e.message}`); }
}

(async () => {
  await t('#500 ctx.table 存在且返回已建表的 Table 实例', async () => {
    const db = new Database(':memory:');
    await db.createTable('users', { name: { type: 'string' } });
    let ctx;
    db.use({ name: 'p', install(_db, c) { ctx = c; } });
    assert.strictEqual(typeof ctx.table, 'function');
    const table = ctx.table('users');
    assert.ok(table, 'ctx.table("users") should return a table instance');
    assert.strictEqual(typeof table.insert, 'function');
    assert.strictEqual(typeof table.find, 'function');
    await db.close();
  });

  await t('#500 ctx.table 查不到表时返回 null', async () => {
    const db = new Database(':memory:');
    let ctx;
    db.use({ name: 'p', install(_db, c) { ctx = c; } });
    assert.strictEqual(ctx.table('missing'), null);
    await db.close();
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
