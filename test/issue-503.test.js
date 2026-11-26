/*
 * #503 回归测试：Cache.set(key, value, ttlMs) 必须按声明应用毫秒 TTL。
 *   node test/issue-503.test.js
 */
const assert = require('assert');
const path = require('path');
const Cache = require(path.join(__dirname, '..', 'lib', 'cache.js'));

let passed = 0, failed = 0;
async function t(name, fn) {
  try { await fn(); passed++; console.log(`ok - ${name}`); }
  catch (e) { failed++; console.error(`not ok - ${name}\n  ${e && e.message}`); }
}

(async () => {
  await t('#503 set 第三参 ttlMs 生效：1 秒后过期', async () => {
    const c = new Cache();
    c.set('k', 'v', 60);
    assert.strictEqual(c.get('k'), 'v');
    await new Promise(r => setTimeout(r, 120));
    assert.strictEqual(c.get('k'), null, 'key should have expired');
    c.close();
  });

  await t('#503 ttl(key) 返回正数剩余时间而非 -1', async () => {
    const c = new Cache();
    c.set('k', 'v', 5000);
    const remaining = c.ttl('k');
    assert.ok(remaining >= 4 && remaining <= 5, `ttl=${remaining}`);
    c.close();
  });

  await t('#503 不带 ttlMs 时行为不变（永不过期）', async () => {
    const c = new Cache();
    c.set('k', 'v');
    assert.strictEqual(c.ttl('k'), -1);
    assert.strictEqual(c.get('k'), 'v');
    c.close();
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
})();
