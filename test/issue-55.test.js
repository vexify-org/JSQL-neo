/*
 * Issue #55 — Query.cache() 复用不同过滤条件时返回过期结果。
 *
 * 缓存只按 TTL 判断，key 里不含 where/orderBy/limit/offset 等可变参数，
 * 于是同一个 Query 实例改了条件后仍命中旧缓存。
 * 修复后缓存键必须覆盖查询参数：参数变化 → 失配 → 重新执行。
 */
const path = require('path');
const ROOT = path.join(__dirname, '..');
const { Database } = require(path.join(ROOT, 'index.js'));
const { executeSQL } = require(path.join(ROOT, 'lib', 'sql.js'));

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('[OK]  ', name); }
  else { fail++; console.log('[FAIL]', name, extra !== undefined ? '-> ' + JSON.stringify(extra).slice(0, 400) : ''); }
}
const ids = (rows) => rows.map(r => Number(r.id));

(async () => {
  const db = new Database(':memory:');
  const q = (sql) => executeSQL(db, sql, { safety: false });
  await q('CREATE TABLE c (id INTEGER PRIMARY KEY AUTOINCREMENT, g TEXT, n INTEGER)');
  await q("INSERT INTO c (g, n) VALUES ('a',1),('b',2),('a',3),('b',4)");
  const t = db.c;

  // 核心复现
  const qb = t.where({ g: 'a' }).cache(60000);
  const a1 = qb.get();
  ok('#55 首次 g=a => [1,3]', JSON.stringify(ids(a1)) === JSON.stringify([1, 3]), a1);
  const b1 = qb.where({ g: 'b' }).get();
  ok('#55 改成 g=b 后不得返回旧缓存 => [2,4]', JSON.stringify(ids(b1)) === JSON.stringify([2, 4]), b1);
  const a2 = qb.where({ g: 'a' }).get();
  ok('#55 切回 g=a => [1,3]', JSON.stringify(ids(a2)) === JSON.stringify([1, 3]), a2);

  // 参数变化都必须失配
  const qo = t.where({}).cache(60000);
  const asc = qo.orderBy('g', 'asc').get();
  ok('#55 orderBy g asc => [1,3,2,4]', JSON.stringify(ids(asc)) === JSON.stringify([1, 3, 2, 4]), asc);
  // 追加 id DESC 后组内顺序应反转 => [3,1,4,2]，若命中旧缓存则仍是 [1,3,2,4]
  const desc = qo.orderBy('id', 'desc').get();
  ok('#55 orderBy 变化不复用旧排序 => [3,1,4,2]',
    JSON.stringify(ids(desc)) === JSON.stringify([3, 1, 4, 2]), desc);

  const ql = t.where({}).cache(60000);
  const lim1 = ql.limit(1).get();
  ok('#55 limit=1 => 1 行', lim1.length === 1, lim1);
  const lim2 = ql.limit(3).get();
  ok('#55 limit 变化 => 3 行', lim2.length === 3, lim2);
  const off = ql.offset(1).get();
  ok('#55 offset 变化 => 3 行', off.length === 3, off);

  // 真正相同参数仍要走缓存（否则等于禁用缓存）
  const qs = t.where({ g: 'b' }).cache(60000);
  const s1 = qs.get();
  await q("UPDATE c SET n = 99 WHERE g = 'b'");
  const s2 = qs.get();
  ok('#55 相同参数再次 get 命中缓存（未看到 UPDATE）', JSON.stringify(ids(s2)) === JSON.stringify(ids(s1)) && s2[0].n !== 99, s2);
  await q("UPDATE c SET n = 2 WHERE id = 2");
  await q("UPDATE c SET n = 4 WHERE id = 4");

  // invalidateCache 仍然有效
  const qi = t.where({ g: 'a' }).cache(60000);
  qi.get();
  await q("UPDATE c SET n = 77 WHERE id = 1");
  qi.invalidateCache();
  const iv = qi.get();
  ok('#55 invalidateCache 后重新执行', iv.find(r => Number(r.id) === 1).n === 77, iv);
  await q("UPDATE c SET n = 1 WHERE id = 1");

  // 值类型不同的条件不能共用缓存
  const qv = t.where({ n: 2 }).cache(60000);
  const v1 = qv.get();
  ok('#55 where n=2', JSON.stringify(ids(v1)) === JSON.stringify([2]), v1);
  const v2 = qv.where({ n: '2' }).get();
  ok('#55 where n="2" 语义等值，结果一致', JSON.stringify(ids(v2)) === JSON.stringify([2]), v2);

  // select 变化
  const qsel = t.where({}).cache(60000);
  qsel.select(['id']).get();
  const sel2 = qsel.select(['id', 'g']).get();
  ok('#55 select 变化 => 新字段可见', Object.keys(sel2[0]).sort().join(',') === 'g,id', Object.keys(sel2[0]));

  console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed\n`);
  if (fail > 0) process.exit(1);
})();
