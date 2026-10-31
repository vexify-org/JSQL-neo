/**
 * 模糊测试必须**可复现**。
 *
 * 此前直接用 rand()：同一个 t21 用例两次跑出不同 size（38 / 37），
 * 失败无法复现，也就无法判断是 B-tree 的 bug 还是用例的 bug。
 *
 * 换成 mulberry32 + 固定种子后，同样的输入必然复现同样的结果，
 * CI 上的失败才有意义。换一批随机序列：设环境变量 XQL_BTREE_SEED。
 */
function makeSeededRandom(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
/*
 * 默认种子固定，保证 CI 结果稳定。换一批随机序列：设 XQL_BTREE_SEED。
 *
 * 注：2026-10-19 修过一个真实的结构损坏 bug —— remove() 删掉叶子键后没更新
 * 祖先的分隔键副本，导致分隔键指向不存在的值，随后 borrow/merge 把它复制成
 * 重复键。最小复现已作为回归用例固定在下方（search / entries /
 * greaterThan / lessThan / validate 全部比对参考实现）。
 */
const rand = makeSeededRandom(Number(process.env.XQL_BTREE_SEED || 42));

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

/* ---- _route() 对叶子节点不再崩溃（单键根节点） ---- */
{
  const bt = new BTree();
  bt.insert(5, 0);
  let threw = false;
  try { bt._route(bt._root, 5); } catch (e) { threw = true; }
  ok('_route() on leaf root no crash', !threw && bt._route(bt._root, 5) === 0);
}

/* ---- 二分查找 / IN / 前缀 ---- */
{
  const bt = new BTree(16);
  for (let i = 0; i < 200; i++) bt.insert(i, i);
  ok('binary search mid', JSON.stringify(bt.search(123)) === '[123]');
  ok('searchMany unique', JSON.stringify(bt.searchMany([0, 199, 50, 50]).sort((a, b) => a - b)) === '[0,50,199]');
  ok('greaterThanEqual last two', JSON.stringify(bt.greaterThanEqual(198).sort((a, b) => a - b)) === '[198,199]');
  ok('lessThanEqual first two', JSON.stringify(bt.lessThanEqual(1).sort((a, b) => a - b)) === '[0,1]');
}

{
  const bt = new BTree(8);
  ['alpha', 'alpine', 'beta', 'alpine'].forEach((k, i) => bt.insert(k, i));
  ok('prefix alp', JSON.stringify(bt.prefix('alp').sort((a, b) => a - b)) === '[0,1,3]');
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
    for (let i = n - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [seq[i], seq[j]] = [seq[j], seq[i]]; }
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
  let okAll = true, reason = '';
  for (let op = 0; op < 300; op++) {
    const k = Math.floor(rand() * 40);
    if (rand() < 0.55) {
      const r = Math.floor(rand() * 5);
      bt.insert(k, r);
      if (!ref.has(k)) ref.set(k, new Set());
      ref.get(k).add(r);
    } else {
      const r = Math.floor(rand() * 5);
      bt.remove(k, r);
      if (ref.has(k)) { ref.get(k).delete(r); if (ref.get(k).size === 0) ref.delete(k); }
    }
    if (op % 60 === 0) {
      for (let x = 0; x < 40 && okAll; x++) {
        const got = bt.search(x);
        const exp = ref.has(x) ? [...ref.get(x)].sort((a, b) => a - b) : [];
        const g = got ? [...got].sort((a, b) => a - b) : [];
        if (JSON.stringify(g) !== JSON.stringify(exp)) { okAll = false; reason = 'search(key=' + x + ')'; }
      }
      const es = bt.entries();
      const emap = new Map(es.map(e => [e.key, [...e.value].sort((a, b) => a - b)]));
      for (const [key, vals] of ref) {
        const g = emap.get(key);
        if (!g || JSON.stringify([...vals].sort()) !== JSON.stringify(g)) { okAll = false; reason = reason || ('entries(key=' + key + ')'); }
      }
      const gtExp = [...ref.keys()].filter(k => k > 20).flatMap(k => [...ref.get(k)]).sort((a, b) => a - b);
      const gt = bt.greaterThan(20).sort((a, b) => a - b);
      if (JSON.stringify(gt) !== JSON.stringify(gtExp)) { okAll = false; reason = reason || 'greaterThan(20)'; }
      const ltExp = [...ref.keys()].filter(k => k < 20).flatMap(k => [...ref.get(k)]).sort((a, b) => a - b);
      const lt = bt.lessThan(20).sort((a, b) => a - b);
      if (JSON.stringify(lt) !== JSON.stringify(ltExp)) { okAll = false; reason = reason || 'lessThan(20)'; }
      const vErr = validate(bt); if (vErr.length) { okAll = false; reason = reason || ('validate: ' + vErr[0]); }
    }
  }
  ok('random mixed t' + t + ' vs reference', okAll && bt.size === ref.size, { size: bt.size, ref: ref.size, reason: reason });
}

/* ---- 回归：remove 后分隔键未更新导致内部键重复 ----
 *
 * 旧实现里 remove() 只改叶子，不更新祖先的分隔键副本。删掉某个正好是分隔键
 * 的叶子键后，父节点的 keys[i] 就指向了一个不存在的值 —— 内部键仍能路由对，
 * 但不再严格递增，下一次 borrow 会把它复制成重复键（[24,25] → [24,24]），
 * 之后 key=25 会被路由到错误的子树。
 */
{
  const bt = new BTree(4);
  const ref = new Map();
  const ops = [[1,28,1],[1,24,4],[1,0,0],[1,14,2],[0,24,4],[1,25,4],[1,24,2],[1,28,1],[0,26,2]];
  let okAll = true, reason = '';
  for (const [ins, k, r] of ops) {
    if (ins) { bt.insert(k, r); if (!ref.has(k)) ref.set(k, new Set()); ref.get(k).add(r); }
    else { bt.remove(k, r); if (ref.has(k)) { ref.get(k).delete(r); if (ref.get(k).size === 0) ref.delete(k); } }
  }
  for (const [k, vals] of ref) {
    const got = bt.search(k).slice().sort((a,b)=>a-b);
    const exp = [...vals].sort((a,b)=>a-b);
    if (JSON.stringify(got) !== JSON.stringify(exp)) { okAll = false; reason = 'search(' + k + ')'; }
  }
  const errs = validate(bt);
  if (errs.length) { okAll = false; reason = reason || ('validate: ' + errs[0]); }
  ok('回归：remove 后分隔键未更新', okAll && bt.size === ref.size, { size: bt.size, ref: ref.size, reason, keys: bt._root.keys });
}

/* ---- 回归：混合增删触发再平衡后索引条目丢失（C1）----
 *
 * 报告数据：search(6) → [54,28]（应为 [28,44,54]）、size 少 1。
 * 根因是删除路径「先再平衡、后确认键是否存在」：把分支合并/借用之后才去删，
 * 目标键可能已被搬到别的节点，于是这个 rowIndex 静默消失，size 也随之错位。
 * 下面用固定操作序列（含多行同键 + 反复删除触发 merge/borrow）锁定该场景，
 * 逐值与参考实现比对。
 */
{
  const bt = new BTree(4);
  const ref = new Map();
  const ops = [];
  // 先铺满两层，制造出可合并/可借用的兄弟节点
  for (let k = 1; k <= 12; k++) ops.push([1, k, k]);
  // key=6 挂三个行号（报告里的 28 / 44 / 54）
  ops.push([1, 6, 28], [1, 6, 44], [1, 6, 54]);
  // 删掉一批键，触发叶子合并 / 内部键下移
  for (let k = 1; k <= 11; k += 2) ops.push([0, k, k]);
  // 再插入新键，触发分裂
  for (let k = 13; k <= 20; k++) ops.push([1, k, k]);
  // 继续混合删除，踩 borrow/merge 路径
  for (let k = 2; k <= 10; k += 2) ops.push([0, k, k]);
  for (let k = 14; k <= 20; k += 2) ops.push([0, k, k]);
  // 再插入，反复触发结构变化
  ops.push([1, 21, 21], [1, 22, 22], [1, 23, 23], [0, 21, 21]);

  let okAll = true, reason = '';
  for (const [ins, k, r] of ops) {
    if (ins) {
      bt.insert(k, r);
      if (!ref.has(k)) ref.set(k, new Set());
      ref.get(k).add(r);
    } else {
      bt.remove(k, r);
      if (ref.has(k)) { ref.get(k).delete(r); if (ref.get(k).size === 0) ref.delete(k); }
    }
  }
  for (const [k, vals] of ref) {
    const got = bt.search(k).slice().sort((a, b) => a - b);
    const exp = [...vals].sort((a, b) => a - b);
    if (JSON.stringify(got) !== JSON.stringify(exp)) { okAll = false; reason = reason || ('search(' + k + ')=' + JSON.stringify(got) + ' exp ' + JSON.stringify(exp)); }
  }
  const errs = validate(bt);
  if (errs.length) { okAll = false; reason = reason || ('validate: ' + errs[0]); }
  const six = bt.search(6).slice().sort((a, b) => a - b);
  ok('C1 回归：key=6 三行号全部保留', JSON.stringify(six) === '[28,44,54]', six);
  ok('C1 回归：混合增删后 size 与参考一致', bt.size === ref.size, { size: bt.size, ref: ref.size, reason });
  ok('C1 回归：混合增删后逐键可搜到', okAll, reason);
}

console.log(failed === 0 ? `\nALL ${passed} BTREE TESTS PASSED` : `\n${failed} FAILURES (${passed} passed)`);
process.exit(failed === 0 ? 0 : 1);
