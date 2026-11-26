/*
 * #498 回归测试：doc/*.md 版本横幅必须与 package.json 一致。
 *   node test/issue-498.test.js
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
  const files = ['index.md', 'quick-start.md', 'sql-reference.md', 'cli.md', 'columnar.md', 'changelog.md'];

  await t(`#498 文档版本横幅统一为 v${version}`, async () => {
    const stale = [];
    for (const f of files) {
      const text = fs.readFileSync(path.join(root, 'doc', f), 'utf8');
      const head = text.split('\n').slice(0, 5).join('\n');
      if (!head.includes(version)) stale.push(f + ': ' + head.split('\n').filter(Boolean).slice(0, 2).join(' | '));
    }
    assert.deepStrictEqual(stale, [], `stale docs:\n${stale.join('\n')}`);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
})();
