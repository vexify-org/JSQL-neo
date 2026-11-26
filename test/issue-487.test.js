/*
 * #487 回归测试：重复 use() 同一无名插件实例/函数不应重复登记钩子。
 *   node test/issue-487.test.js
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
  await t('#487 同一无名插件对象 use 两次只登记一份钩子', async () => {
    const db = new Database(':memory:');
    let calls = 0;
    const plugin = { hooks: { beforeInsert: [() => { calls++; }] } };
    db.use(plugin);
    db.use(plugin);
    assert.strictEqual(db._hooks.beforeInsert.length, 1);
    await db.createTable('t', { id: { type: 'integer', primaryKey: true } });
    await db.insert('t', { id: 1 });
    assert.strictEqual(calls, 1);
    await db.close();
  });

  await t('#487 同一函数式插件 use 两次只 install 一次', () => {
    const db = new Database(':memory:');
    let installs = 0;
    const fn = () => { installs++; };
    db.use(fn);
    db.use(fn);
    assert.strictEqual(installs, 1);
  });

  await t('#487 具名插件仍按 name 去重，不同无名插件互不干扰', async () => {
    const db = new Database(':memory:');
    let a = 0, b = 0;
    const named = { name: 'dup', hooks: { beforeInsert: [() => { a++; }] } };
    db.use(named); db.use(named);
    db.use({ hooks: { beforeInsert: [() => { b++; }] } });
    db.use({ hooks: { beforeInsert: [() => { b++; }] } });
    await db.createTable('t', { id: { type: 'integer', primaryKey: true } });
    await db.insert('t', { id: 1 });
    assert.strictEqual(a, 1);
    assert.strictEqual(b, 2);
    await db.close();
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
