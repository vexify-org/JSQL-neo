/*
 * #412 回归测试：Mongo $inc 对非数值现有值/操作数必须报错，不做拼接或静默归零。
 *   node test/issue-412.test.js
 */
const assert = require('assert');
const path = require('path');
const { applyModifier } = require(path.join(__dirname, '..', 'lib', 'nedb_compat.js'));

let passed = 0, failed = 0;
async function t(name, fn) {
  try { await fn(); passed++; console.log(`ok - ${name}`); }
  catch (e) { failed++; console.error(`not ok - ${name}\n  ${e && e.message}`); }
}
function incError(doc, payload) {
  try { applyModifier(doc, { $inc: payload }); return null; }
  catch (e) { return e; }
}

(async () => {
  await t('#412 现有值为非数值字符串 → non-numeric 错误', async () => {
    const doc = { _id: 'a', s: 'abc' };
    const err = incError(doc, { s: 1 });
    assert.ok(err, 'expected error');
    assert.ok(/non-numeric/i.test(err.message), err.message);
    assert.strictEqual(doc.s, 'abc', 'document must not be mutated');
  });

  await t('#412 操作数为字符串 → non-numeric 错误（不拼接）', async () => {
    const doc = { _id: 'b', x: 1 };
    const err = incError(doc, { x: '5' });
    assert.ok(err, 'expected error');
    assert.ok(/non-numeric/i.test(err.message), err.message);
    assert.strictEqual(doc.x, 1);
  });

  await t('#412 合法数值递增保持数值类型', async () => {
    const doc = { x: 1 };
    applyModifier(doc, { $inc: { x: 2 } });
    assert.strictEqual(doc.x, 3);
  });

  await t('#412 字段不存在时按 0 起算', async () => {
    const doc = {};
    applyModifier(doc, { $inc: { n: 5 } });
    assert.strictEqual(doc.n, 5);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
})();
