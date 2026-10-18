/*
 * 差分模糊测试：_compileMatcher（快路径）必须与 _matchRow（原实现）逐行一致。
 *
 * 背景：_matchRow 每行都做 Object.entries(query) / Object.keys(condition) /
 * 一串 startswith 判断。实测这部分占单次全表扫描耗时的 **98%** ——
 * 10 万行点查 13.9ms/次，其中 13.6ms 是反射开销；同样语义的手写循环只要 0.28ms。
 * $like / $regex 更糟：正则每行每字段重编一次。
 *
 * _compileMatcher 把这些一次性挪到循环外。语义必须一字不差 ——
 * 这个测试用随机数据 × 随机查询做交叉验证来保证。
 *
 * 它抓到过真 bug：$nin 的 target 非数组时，原实现返回 false（不匹配），
 * 而编译版一度漏判、当成通过。
 */
const path = require('path');

const ROOT = path.join(__dirname, '..');
const Database = require(path.join(ROOT, 'lib/database'));

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, extra) {
  if (cond) { pass++; } else { fail++; failures.push(name + (extra !== undefined ? '  -> ' + JSON.stringify(extra).slice(0, 170) : '')); }
}

(async () => {
  const db = new Database(':memory:', { autoSave: false });
  await db.createTable('f', {
    id: { type: 'integer', primaryKey: true },
    num: { type: 'integer' },
    str: { type: 'string' },
    flt: { type: 'float' },
    arr: { type: 'array' },
    obj: { type: 'object' },
  });
  const STRS = ['a', 'ab', 'Ab', 'abc', 'b', '', 'a%b', 'a_b', 'A', 'zzz', 'aXb'];
  const NUMS = [0, 1, 2, 3, 5, 10, -1, -5, 100, 25, 50];   // num 是 integer 列
  const rows = [];
  for (let i = 1; i <= 400; i++) {
    rows.push({
      id: i,
      num: NUMS[i % NUMS.length],
      str: STRS[i % STRS.length],
      flt: (i % 17) / 2,
      arr: i % 3 === 0 ? [1, 2, 3] : (i % 3 === 1 ? ['x', 'y'] : []),
      obj: i % 4 === 0 ? { city: 'SH', n: i } : (i % 4 === 1 ? { city: 'BJ' } : { n: 1 }),
    });
  }
  await db.insert('f', rows);
  const t = db._tables.f;
  const all = t._rows;

  // ---- 可复现的伪随机（固定种子，失败可重放）----
  let seed = 12345;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const pick = (a) => a[Math.floor(rnd() * a.length)];

  const FIELDS = ['num', 'str', 'flt', 'arr', 'obj', 'obj.city', 'id'];
  const OPS = ['$eq', '$ne', '$gt', '$gte', '$lt', '$lte', '$in', '$nin', '$between',
    '$exists', '$isNull', '$startsWith', '$endsWith', '$contains', '$type', '$size',
    '$like', '$regex'];

  const genValue = (op) => {
    switch (op) {
      case '$in': case '$nin':
        return [pick(NUMS), pick(STRS), pick(NUMS)].slice(0, 1 + Math.floor(rnd() * 3));
      case '$between': return [pick(NUMS), pick(NUMS)].sort((a, b) => a - b);
      case '$exists': case '$isNull': return rnd() < 0.5;
      case '$type': return pick(['string', 'number', 'object', 'undefined', 'boolean']);
      case '$size': return pick([0, 1, 2, 3]);
      case '$startsWith': case '$endsWith': return pick(['a', 'A', 'b', 'ab', '']);
      case '$like': return pick(['a%', '%b', 'a_b', '%', 'a%b', 'A%', '_', 'abc']);
      case '$regex': return pick(['^a', 'b$', '[0-9]+', 'a.*b', '.']);
      case '$gt': case '$gte': case '$lt': case '$lte': case '$eq': case '$ne':
        return rnd() < 0.25 ? null : pick(rnd() < 0.5 ? NUMS : STRS);
      default: return pick(NUMS);
    }
  };
  const genFieldCond = () => {
    const f = pick(FIELDS);
    if (rnd() < 0.35) return { [f]: genValue(pick(OPS)) };
    const ops = {};
    const n = 1 + Math.floor(rnd() * 2);
    for (let i = 0; i < n; i++) ops[pick(OPS)] = genValue(pick(OPS));
    return { [f]: ops };
  };
  const genQuery = () => {
    const r = rnd();
    if (r < 0.12) return {};                                     // 空查询
    if (r < 0.30) {                                              // $or
      const n = 1 + Math.floor(rnd() * 3);
      return { $or: Array.from({ length: n }, () => genFieldCond()) };
    }
    if (r < 0.42) {                                              // $and
      const n = 1 + Math.floor(rnd() * 3);
      return { $and: Array.from({ length: n }, () => genFieldCond()) };
    }
    if (r < 0.50) return { $not: genFieldCond() };               // $not
    const q = {};                                                // 普通多字段
    const n = 1 + Math.floor(rnd() * 3);
    for (let i = 0; i < n; i++) Object.assign(q, genFieldCond());
    return q;
  };

  // ---- 差分比对 ----
  const N = 4000;
  let mismatches = 0, empty = 0;
  for (let i = 0; i < N; i++) {
    const q = genQuery();
    if (Object.keys(q).length === 0) empty++;
    let fast, slow, e1 = null, e2 = null;
    try { fast = all.filter(r => t._compileMatcher(q)(r)); } catch (e) { e1 = e.message; }
    try { slow = all.filter(r => t._matchRow(r, q)); } catch (e) { e2 = e.message; }
    if (e1 || e2) {
      // 抛错行为也必须一致
      if (!!e1 !== !!e2) { mismatches++; if (failures.length < 10) failures.push('抛错不一致 ' + JSON.stringify(q)); }
      continue;
    }
    if (fast.length !== slow.length) {
      mismatches++;
      if (failures.length < 10) failures.push(`行数不一致 ${fast.length} vs ${slow.length} : ${JSON.stringify(q)}`);
      continue;
    }
    for (let j = 0; j < fast.length; j++) {
      if (fast[j] !== slow[j]) { mismatches++; if (failures.length < 10) failures.push('行内容不一致 ' + JSON.stringify(q)); break; }
    }
  }
  ok(`差分模糊测试 ${N} 个随机查询零偏差（含 ${empty} 个空查询）`, mismatches === 0, failures.slice(0, 4));
  console.log(`  随机查询 ${N} 个，偏差 ${mismatches}`);

  // ---- 定向验证：逐个操作符 + 边界 ----
  const dir = [
    [{ num: 25 }, '等值'],
    [{ num: { $eq: 25 } }, '$eq'],
    [{ num: { $ne: 25 } }, '$ne'],
    [{ num: { $gt: 50 } }, '$gt'],
    [{ num: { $gte: 100 } }, '$gte'],
    [{ num: { $lt: 0 } }, '$lt'],
    [{ num: { $lte: 0 } }, '$lte'],
    [{ num: { $in: [1, 25] } }, '$in'],
    [{ num: { $nin: [1, 25] } }, '$nin'],
    [{ num: { $nin: true } }, '$nin 非数组 target（曾在此分歧）'],
    [{ num: { $nin: 'Ab' } }, '$nin 字符串 target'],
    [{ num: { $in: true } }, '$in 非数组 target'],
    [{ num: { $between: [1, 50] } }, '$between'],
    [{ num: { $between: true } }, '$between 非数组'],
    [{ num: { $exists: true } }, '$exists'],
    [{ num: { $isNull: true } }, '$isNull'],
    [{ str: { $startsWith: 'a' } }, '$startsWith'],
    [{ str: { $endsWith: 'b' } }, '$endsWith'],
    [{ arr: { $contains: 1 } }, '$contains'],
    [{ arr: { $size: 3 } }, '$size'],
    [{ obj: { $type: 'object' } }, '$type'],
    [{ str: { $like: 'a%' } }, '$like'],
    [{ str: { $like: 'a_b' } }, '$like _'],
    [{ str: { $like: 'a%b' } }, '$like 转义 %'],
    [{ str: { $regex: '^a' } }, '$regex'],
    [{ 'obj.city': 'SH' }, '点号路径'],
    [{ obj: { city: 'SH' } }, '嵌套对象'],
    [{ obj: { city: 'SH', n: 1 } }, '嵌套对象两字段'],
    [{ $or: [{ num: 1 }, { str: 'b' }] }, '$or'],
    [{ $and: [{ num: 1 }, { str: 'a' }] }, '$and'],
    [{ $not: { num: 1 } }, '$not'],
    [{ num: { $gt: 0 }, str: { $startsWith: 'a' } }, '多字段'],
    [{}, '空查询'],
    [{ $or: [{ num: { $nin: true } }] }, '$or 内 $nin 非数组'],
  ];
  for (const [q, label] of dir) {
    const fast = all.filter(r => t._compileMatcher(q)(r));
    const slow = all.filter(r => t._matchRow(r, q));
    ok('定向: ' + label, fast.length === slow.length && fast.every((r, i) => r === slow[i]),
      { fast: fast.length, slow: slow.length });
  }

  // ---- 软删除模式下也必须一致 ----
  {
    await db.query('DELETE FROM f WHERE id <= 40', { safety: false });
    const q = { num: 25 };
    const fast = t._applyFilterOptimized(t._getVisibleRows(), q);
    const slow = t._rows.filter(r => !r._deleted).filter(r => t._matchRow(r, q));
    ok('软删除模式下一致', fast.length === slow.length && fast.every((r, i) => r === slow[i]),
      { fast: fast.length, slow: slow.length });
  }

  // ---- LIKE / REGEX 的正则只编译一次（性能回归护栏）----
  {
    const q = { str: { $like: 'a%' } };
    const m = t._compileMatcher(q);
    const t0 = Date.now();
    for (let i = 0; i < 300; i++) all.filter(r => m(r));
    const ms = Date.now() - t0;
    ok(`编译版 LIKE 300 次全表扫描在 ${ms}ms 内（原实现每行重编正则）`, ms < 1500, ms);
    console.log(`  编译版 LIKE ×300 全表扫描: ${ms}ms`);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (failures.length) { console.log('\n失败项:'); failures.slice(0, 15).forEach(f => console.log('  - ' + f)); }
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('💥', e); process.exit(1); });
