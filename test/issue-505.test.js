/*
 * #505 回归测试：doc/mysql.md 不得把 jsql serve 误称为「立即响应」的单协议模式。
 *   node test/issue-505.test.js
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
  const text = fs.readFileSync(path.join(__dirname, '..', 'doc', 'mysql.md'), 'utf8');

  await t('#505 FAQ 不再把 jsql serve 列进立即响应模式', async () => {
    assert.ok(!/单协议模式（`createMysqlServer` \/ `jsql serve`）会立即响应/.test(text));
  });

  await t('#505 说明 jsql serve 默认多协议嗅探需等 sniffTimeout', async () => {
    assert.ok(/jsql serve/.test(text) && /sniffTimeout/.test(text), 'expected sniffTimeout explanation');
    assert.ok(/--mysql-only/.test(text), 'expected --mysql-only mention');
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
})();
