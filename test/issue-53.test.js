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

  // 多叶子场景：40 个 key × 5 行，order=4 会分裂成多层；逐行删除全部应都返回 true
  const multi = new BTree(4);
  for (let k = 0; k < 40; k++) for (let r = 0; r < 5; r++) multi.insert(k, k * 100 + r);
  ok('#53 多叶子：size 按 distinct keys 计', multi.size === 40, multi.size);
  let allTrue = true;
  let rowsRemoved = 0;
  for (let k = 0; k < 40; k++) {
    for (let r = 0; r < 5; r++) {
      if (multi.remove(k, k * 100 + r) !== true) allTrue = false;
      rowsRemoved++;
      const expect = 4 - r;   // 删到第 r 行后剩下的行数
      const leftN = multi.search(k).length;
      if (leftN !== expect) { allTrue = false; console.log('[FAIL] 残留行数不对', k, r, leftN, expect); }
    }
  }
  ok('#53 多叶子：删除全部行都返回 true 且无残留', allTrue && rowsRemoved === 200, { allTrue, rowsRemoved });
  ok('#53 多叶子：全部删完后 size 归零', multi.size === 0, multi.size);

  // 删除不存在的行不能改动已有行；重复删除同一行第二次应返回 false
  const noop = new BTree(4);
  noop.insert(3, 30);
  noop.insert(3, 31);
  ok('#53 删不存在的 rowIndex 返回 false 且 no-op', noop.remove(3, 99) === false && noop.size === 1);
  ok('#53 同一行重复删除第二次返回 false', noop.remove(3, 30) === true && noop.remove(3, 30) === false);
  ok('#53 重复删除后剩余行不变', JSON.stringify(noop.search(3)) === JSON.stringify([31]), noop.search(3));

  // unique 索引：重复插入被忽略，删除仍应返回 true
  const uni = new BTree(64, true);
  uni.insert(5, 1);
  uni.insert(5, 2);   // unique：忽略
  ok('#53 unique：重复插入不增加 size', uni.size === 1, uni.size);
  ok('#53 unique：删除返回 true 且 size 归零', uni.remove(5, 1) === true && uni.size === 0, uni.size);
} catch (e) {
  fail++;
  console.log('[FAIL] unexpected exception:', (e && e.stack) || e);
}

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed\n`);
if (fail > 0) process.exit(1);
