/*
 * #499 回归测试：doc/changelog.md 须覆盖最新版本，且 [Unreleased] 在文件顶部。
 *   node test/issue-499.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
async function t(name, fn) {
  try { await fn(); passed++; console.log(`ok - ${name}`); }
  catch (e) { failed++; console.error(`not ok - ${name}\n  ${e && e.message}`); }
}

(async () => {
  const root = path.join(__dirname, '..');
  const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
  const text = fs.readFileSync(path.join(root, 'doc', 'changelog.md'), 'utf8');

  await t('#499 doc/changelog.md 含当前版本段落', async () => {
    assert.ok(new RegExp('^## (?:\\[)?' + version.replace(/\./g, '\\.') + '(?:\\])?\\b', 'm').test(text),
      `missing ${version} section`);
  });

  await t('#499 [Unreleased] 位于文件顶部（首个版本段之前）', async () => {
    const lines = text.split('\n');
    const u = lines.findIndex(l => /^## \[Unreleased\]/.test(l));
    const firstVersion = lines.findIndex(l => /^## (?:\[)?\d/.test(l));
    assert.ok(u >= 0, 'no [Unreleased]');
    assert.ok(u < firstVersion, `Unreleased@${u} should precede first version@${firstVersion}`);
  });

  await t('#499 覆盖 6.8.5 之后的版本', async () => {
    for (const v of ['6.8.5', '6.8.26', '6.10.0']) {
      assert.ok(text.includes(v), `missing ${v}`);
    }
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
})();
