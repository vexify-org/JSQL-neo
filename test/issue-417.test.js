/*
 * #417 回归测试：写命令遇到已过期但未清理的残留键，必须视同键不存在。
 *   node test/issue-417.test.js
 */
const assert = require('assert');
const path = require('path');
const Cache = require(path.join(__dirname, '..', 'lib', 'cache.js'));

let passed = 0, failed = 0;
async function t(name, fn) {
  try { await fn(); passed++; console.log(`ok - ${name}`); }
  catch (e) { failed++; console.error(`not ok - ${name}\n  ${e && e.message}`); }
}
function expiredStringKey(c, key) {
  c.set(key, 'x');
  c._expires.set(key, Date.now() - 1000);
}

(async () => {
  await t('#417 hset 过期残留字符串键 → 新建 hash 而非 WRONGTYPE', async () => {
    const c = new Cache();
    expiredStringKey(c, 'h');
    assert.doesNotThrow(() => c.hset('h', 'f', 'v'));
    assert.strictEqual(c.hget('h', 'f'), 'v');
    c.close();
  });

  await t('#417 sadd 过期残留字符串键 → 新建 set', async () => {
    const c = new Cache();
    expiredStringKey(c, 's');
    assert.doesNotThrow(() => c.sadd('s', 'm'));
    assert.strictEqual(c.sismember('s', 'm'), 1);
    c.close();
  });

  await t('#417 lpush/rpush 过期残留字符串键 → 新建 list', async () => {
    const c = new Cache();
    expiredStringKey(c, 'l');
    assert.doesNotThrow(() => c.lpush('l', 'a'));
    expiredStringKey(c, 'r');
    assert.doesNotThrow(() => c.rpush('r', 'b'));
    assert.deepStrictEqual(c.lrange('l', 0, -1), ['a']);
    assert.deepStrictEqual(c.lrange('r', 0, -1), ['b']);
    c.close();
  });

  await t('#417 _incrby 过期残留键 → 从 0 开始而非在旧值上累加', async () => {
    const c = new Cache();
    expiredStringKey(c, 'n');
    assert.strictEqual(c.incr('n'), 1);
    c.close();
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
})();
