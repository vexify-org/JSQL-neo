/*
 * Issue #53 — BTree.remove(key, rowIndex) 在「同一 key 挂着多行」时返回 false，
 * 即使那一行确实被删掉了。返回契约错误，调用方（索引维护）会以为删除失败。
 */
const path = require('path');
const BTree = require(path.join(__dirname, '..', 'lib', 'btree.js'));

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('[OK]  ', name); }
  else { fail++; console.log('[FAIL]', name, extra !== undefined ? '-> ' + JSON.stringify(extra).slice(0, 300) : ''); }
}

try {
  // 最小复现
  const t = new BTree(4);
  t.insert(46, 17);
  t.insert(46, 18);

  const r = t.remove(46, 17);
  ok('#53 删除重复 key 中的一行返回 true', r === true, r);
  ok('#53 剩余行仍可查到', JSON.stringify(t.search(46)) === JSON.stringify([18]), t.search(46));
  ok('#53 size 正确递减', t.size === 1, t.size);

  // 再删剩下的那一行：key 整个消失
  const r2 = t.remove(46, 18);
  ok('#53 删掉最后一行返回 true', r2 === true, r2);
  ok('#53 key 已不存在', JSON.stringify(t.search(46)) === JSON.stringify([]), t.search(46));
  ok('#53 size 归零', t.size === 0, t.size);

  // 删不存在的行仍返回 false
  t.insert(7, 1);
  ok('#53 行号不存在返回 false', t.remove(7, 99) === false);
  ok('#53 不存在的 key 返回 false', t.remove(12345, 1) === false);
  ok('#53 误删后数据完好', JSON.stringify(t.search(7)) === JSON.stringify([1]), t.search(7));

  // 大量重复 key + 删除，条目不应丢失
  const big = new BTree(4);
  for (let i = 0; i < 40; i++) big.insert(5, i);
  for (let i = 0; i < 20; i++) ok(`#53 重复 key 批量删除第${i}行返回 true`, big.remove(5, i) === true);
  const left = big.search(5);
  ok('#53 批量删除后剩余行完整', JSON.stringify(left) === JSON.stringify(Array.from({ length: 20 }, (_, i) => i + 20)), left);
  ok('#53 批量删除后 size 按 distinct keys 计（1）', big.size === 1, big.size);
} catch (e) {
  fail++;
  console.log('[FAIL] unexpected exception:', (e && e.stack) || e);
}

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed\n`);
if (fail > 0) process.exit(1);
