/*
 * #486 回归测试：从持久化配置恢复的模块路径，enable/get/api/applyTo 前必须重新做 cwd 边界校验。
 *   node test/issue-486.test.js
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
process.chdir(ROOT);
const { ModuleManager } = require(path.join(ROOT, 'lib', 'mod.js'));

let passed = 0, failed = 0;
async function t(name, fn) {
  try { await fn(); passed++; console.log(`ok - ${name}`); }
  catch (e) { failed++; console.error(`not ok - ${name}\n  ${e && e.message}`); }
}

const dir = path.join(__dirname, '.tmp-issue-486');
const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'jsql-mod-outside-'));
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(dir, { recursive: true });
const outsideFile = path.join(outside, 'outside.js');
fs.writeFileSync(outsideFile, "module.exports = { name: 'outside', hooks: {} };\n");
const validFile = path.join(dir, 'valid.js');
fs.writeFileSync(validFile, "module.exports = { name: 'valid', hooks: {} };\n");

const entry = (name, filePath, enabled) => ({
  name, path: filePath, enabled, priority: 0, depends: [], addedAt: 1
});
const cfgDisabled = path.join(dir, 'disabled.config.json');
fs.writeFileSync(cfgDisabled, JSON.stringify({ modules: [entry('outside', outsideFile, false)] }));
const cfgEnabled = path.join(dir, 'enabled.config.json');
fs.writeFileSync(cfgEnabled, JSON.stringify({ modules: [
  entry('valid', validFile, true), entry('outside', outsideFile, true)
] }));

(async () => {
  await t('#486 add() 仍拒绝 cwd 之外的路径', () => {
    const m = new ModuleManager(path.join(dir, 'clean.config.json'));
    assert.throws(() => m.add(outsideFile), /outside working directory/);
  });

  await t('#486 enable() 不加载配置里的越界路径', () => {
    const m = new ModuleManager(cfgDisabled);
    assert.throws(() => m.enable('outside'), /outside working directory/);
    assert.strictEqual(m.find('outside').enabled, false);
  });

  await t('#486 get()/api() 不加载配置里的越界路径', () => {
    const m = new ModuleManager(cfgDisabled);
    assert.throws(() => m.get('outside'), /outside working directory/);
    assert.throws(() => m.api('outside'), /outside working directory/);
  });

  await t('#486 applyTo() 跳过越界条目，合法条目仍可加载', () => {
    const m = new ModuleManager(cfgEnabled);
    const used = [];
    const fakeDb = { use(plugin) { used.push(plugin.name); return this; } };
    m.applyTo(fakeDb);
    assert.deepStrictEqual(used, ['valid']);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
