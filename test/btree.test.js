/*
 * B-Tree 专项回归测试 — 覆盖 GitHub Issue #3 的三个 bug 及随机混合操作不变量。
 *   node test/btree.test.js
 */
const BTree = require('../lib/btree');

let passed = 0, failed = 0;
function ok(name, cond, extra) {
  if (cond) { passed++; }
  else { failed++; console.log('[FAIL]', name, extra !== undefined ? '-> ' + JSON.stringify(extra) : ''); }
}

function validate(bt) {
  const errs = [];
  (function walk(node) {
    if (node.leaf) {
      if (node.children.length !== 0) errs.push('leaf has children');
      for (let i = 1; i < node.keys.length; i++) if (node.keys[i] <= node.keys[i - 1]) errs.push('leaf unsorted');
    } else {
      if (node.children.length !== node.keys.length + 1) errs.push('internal children !== keys+1');
      for (let i = 1; i < node.keys.length; i++) if (node.keys[i] <= node.keys[i - 1]) errs.push('internal unsorted');
      node.children.forEach(walk);
    }
  })(bt._root);
  return errs;
}

/* ---- Issue #3 Bug #1: 删除崩溃 ---- */
{
  const bt = new BTree(4);
  for (let i = 0; i < 20; i++) bt.insert(i, i);
  const removed = bt.remove(0, 0);
  ok('issue#3 Bug#1 remove(0,0) no crash', removed === true && bt.search(0).length === 0 && bt.size === 19);
}

/* ---- Issue #3 Bug #2: entries() 乱序重复 ---- */
{
  const bt = new BTree(4);
  for (let i = 0; i < 20; i++) bt.insert(i, i);
  const e = bt.entries();
  let dup = 0, disorder = 0;
  for (let i = 0; i < e.length; i++) {
    if (i > 0 && e[i].key <= e[i - 1].key) disorder++;
    for (let j = i + 1; j < e.length; j++) if (e[i].key === e[j].key) dup++;
  }
  ok('issue#3 Bug#2 entries sorted & dedup', e.length === 20 && dup === 0 && disorder === 0, { len: e.length, dup, disorder });
}

/* ---- Issue #3 Bug #3: 唯一索引返回所有 values ---- */
{
  const bt = new BTree(4, true);
  bt.insert('a', 1); bt.insert('a', 2); bt.insert('a', 3);
  ok('issue#3 Bug#3 unique search single value', JSON.stringify(bt.search('a')) === '[1]' && bt.size === 1);
  const n = new BTree(4, false);
  n.insert('a', 1); n.insert('a', 2); n.insert('b', 5);
  ok('non-unique accumulates values', JSON.stringify(n.search('a')) === '[1,2]');
  n.remove('a', 1); n.remove('a', 2); n.remove('a', 3);
  ok('non-unique remove value keeps key until last', n.search('a').length === 0 && n.size === 1);
}

/* ---- 多值键删除只影响目标 rowIndex（size 对照 distinct keys） ---- */
{
  const bt = new BTree(8);
  bt.insert('x', 1); bt.insert('x', 2); bt.insert('x', 3);
  bt.remove('x', 2);
  ok('multi-value remove one keeps others', JSON.stringify(bt.search('x').sort()) === '[1,3]' && bt.size === 1);
}

/* ---- 随机顺序插入/删除压力 ---- */
for (const order of [4, 8, 16, 64]) {
  for (let trial = 0; trial < 15; trial++) {
    const bt = new BTree(order);
    const n = 200;
    const seq = [...Array(n).keys()];
    for (let i = n - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [seq[i], seq[j]] = [seq[j], seq[i]]; }
    for (const k of seq) bt.insert(k, k);
    const e = validate(bt);
    ok('o' + order + ' insert invariant t' + trial, e.length === 0, e.slice(0, 2));
    for (const k of seq) bt.remove(k, k);
    ok('o' + order + ' full removal t' + trial, bt.size === 0 && bt.entries().length === 0 && validate(bt).length === 0);
  }
}

/* ---- 随机混合操作 vs 参考模型 ---- */
for (let t = 0; t < 25; t++) {
  const order = [4, 8, 64][t % 3];
  const bt = new BTree(order);
  const ref = new Map(); // key -> Set(rowIndex)
  let okAll = true;
  for (let op = 0; op < 300; op++) {
    const k = Math.floor(Math.random() * 40);
    if (Math.random() < 0.55) {
      const r = Math.floor(Math.random() * 5);
      bt.insert(k, r);
      if (!ref.has(k)) ref.set(k, new Set());
      ref.get(k).add(r);
    } else {
      const r = Math.floor(Math.random() * 5);
      bt.remove(k, r);
      if (ref.has(k)) { ref.get(k).delete(r); if (ref.get(k).size === 0) ref.delete(k); }
    }
    if (op % 60 === 0) {
      for (let x = 0; x < 40 && okAll; x++) {
        const got = bt.search(x);
        const exp = ref.has(x) ? [...ref.get(x)].sort((a, b) => a - b) : [];
        const g = got ? [...got].sort((a, b) => a - b) : [];
        if (JSON.stringify(g) !== JSON.stringify(exp)) okAll = false;
      }
      const es = bt.entries();
      const emap = new Map(es.map(e => [e.key, [...e.value].sort((a, b) => a - b)]));
      for (const [key, vals] of ref) {
        const g = emap.get(key);
        if (!g || JSON.stringify([...vals].sort()) !== JSON.stringify(g)) okAll = false;
      }
      const gtExp = [...ref.keys()].filter(k => k > 20).flatMap(k => [...ref.get(k)]).sort((a, b) => a - b);
      const gt = bt.greaterThan(20).sort((a, b) => a - b);
      if (JSON.stringify(gt) !== JSON.stringify(gtExp)) okAll = false;
      const ltExp = [...ref.keys()].filter(k => k < 20).flatMap(k => [...ref.get(k)]).sort((a, b) => a - b);
      const lt = bt.lessThan(20).sort((a, b) => a - b);
      if (JSON.stringify(lt) !== JSON.stringify(ltExp)) okAll = false;
      if (validate(bt).length) okAll = false;
    }
  }
  ok('random mixed t' + t + ' vs reference', okAll && bt.size === ref.size, { size: bt.size, ref: ref.size });
}

console.log(failed === 0 ? `\nALL ${passed} BTREE TESTS PASSED` : `\n${failed} FAILURES (${passed} passed)`);
process.exit(failed === 0 ? 0 : 1);
