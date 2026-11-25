/*
 * #530 回归测试：use() 的 install() 抛错后，已登记的钩子必须回滚，不留下孤儿钩子。
 *   node test/issue-530.test.js
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
  await t('#530 install 抛错后失败插件的钩子被撤销', async () => {
    const db = new Database(':memory:');
    let hookRan = 0;
    const plugin = {
      name: 'bad-install',
      hooks: { beforeInsert: [() => { hookRan++; }] },
      install() { throw new Error('install boom'); }
    };
    assert.throws(() => db.use(plugin), /install boom/);
    assert.strictEqual(db._hooks.beforeInsert.length, 0);
    await db.createTable('t', { id: { type: 'integer', primaryKey: true } });
    await db.insert('t', { id: 1 });
    assert.strictEqual(hookRan, 0);
    await db.close();
  });

  await t('#530 install 抛错不误删先前已注册插件的钩子', async () => {
    const db = new Database(':memory:');
    let goodRan = 0, badRan = 0;
    db.use({ name: 'good', hooks: { beforeInsert: [() => { goodRan++; }] } });
    const before = db._hooks.beforeInsert.length;
    assert.throws(() => db.use({
      name: 'bad',
      hooks: { beforeInsert: [() => { badRan++; }] },
      install() { throw new Error('boom'); }
    }), /boom/);
    assert.strictEqual(db._hooks.beforeInsert.length, before);
    await db.createTable('t', { id: { type: 'integer', primaryKey: true } });
    await db.insert('t', { id: 1 });
    assert.strictEqual(goodRan, 1);
    assert.strictEqual(badRan, 0);
    await db.close();
  });

  await t('#530 install 内通过 ctx.on 登记的钩子也在失败时回滚', async () => {
    const db = new Database(':memory:');
    let ran = 0;
    assert.throws(() => db.use({
      name: 'bad-ctx',
      install(_engine, ctx) {
        ctx.on('afterInsert', () => { ran++; });
        throw new Error('boom');
      }
    }), /boom/);
    assert.strictEqual(db._hooks.afterInsert.length, 0);
    await db.createTable('t', { id: { type: 'integer', primaryKey: true } });
    await db.insert('t', { id: 1 });
    assert.strictEqual(ran, 0);
    await db.close();
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
