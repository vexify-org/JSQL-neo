/*
 * #539 回归测试：disable() 级联回扫时个别依赖模块文件损坏，不应阻断目标模块自身禁用。
 *   node test/issue-539.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
process.chdir(ROOT);
const { ModuleManager } = require(path.join(ROOT, 'lib', 'mod.js'));

let passed = 0, failed = 0;
async function t(name, fn) {
  try { await fn(); passed++; console.log(`ok - ${name}`); }
  catch (e) { failed++; console.error(`not ok - ${name}\n  ${e && e.message}`); }
}

const dir = path.join(__dirname, '.tmp-issue-539');
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(dir, { recursive: true });
try {
  fs.writeFileSync(path.join(dir, 'b.js'), "module.exports = { name: 'b', hooks: {} };\n");
  fs.writeFileSync(path.join(dir, 'a.js'), "module.exports = { name: 'a', depends: ['b'], hooks: {} };\n");
  fs.writeFileSync(path.join(dir, 'c.js'), "module.exports = { name: 'c', depends: ['b'], hooks: {} };\n");
  const cfg = path.join(dir, 'mixed.config.json');

  const mgr = new ModuleManager(cfg);
  mgr.add(path.join(dir, 'b.js'));
  mgr.add(path.join(dir, 'a.js'));
  mgr.add(path.join(dir, 'c.js'));
  mgr.enable('b'); mgr.enable('a'); mgr.enable('c');

  // 回扫时会加载 c.js，此处令其损坏
  fs.writeFileSync(path.join(dir, 'c.js'), '!!! broken {{{');

  (async () => {
    await t('#539 disable(b) 不因损坏的依赖模块而抛错', () => {
      const r = mgr.disable('b');
      assert.strictEqual(r.ok, true);
    });

    await t('#539 目标模块 b 与依赖它的 a 均被禁用', () => {
      const byName = Object.fromEntries(mgr.list().map(m => [m.name, m.enabled]));
      assert.strictEqual(byName.b, false);
      assert.strictEqual(byName.a, false);
    });

    await t('#539 损坏模块被跳过、保持原状态且禁用结果已持久化', () => {
      const byName = Object.fromEntries(mgr.list().map(m => [m.name, m.enabled]));
      assert.strictEqual(byName.c, true);
      const reloaded = new ModuleManager(cfg);
      const r2 = Object.fromEntries(reloaded.list().map(m => [m.name, m.enabled]));
      assert.strictEqual(r2.b, false);
      assert.strictEqual(r2.a, false);
    });

    console.log(`\n${passed} passed, ${failed} failed`);
    fs.rmSync(dir, { recursive: true, force: true });
    process.exit(failed === 0 ? 0 : 1);
  })().catch((e) => { console.error('FATAL', e); process.exit(1); });
} catch (e) {
  console.error('FATAL setup', e);
  process.exit(1);
}
