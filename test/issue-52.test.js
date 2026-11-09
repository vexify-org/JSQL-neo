/*
 * Issue #52 — CASE WHEN 内嵌聚合恒为 0。
 *
 * `SELECT CASE WHEN COUNT(*) > 2 THEN 1 ELSE 0 END FROM t` 中，
 * 聚合节点没有按分组求值替换（resolveOperand 看不到 aggregate → null → 条件为假），
 * 且无 GROUP BY 时整表聚合识别只检查 c.scalar，漏了 c.caseExpr，
 * 于是输出逐行 0 而不是一行 1。
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
const j = (rows) => JSON.stringify(rows, (k, v) => (typeof v === 'bigint' ? v.toString() + 'n' : v));

(async () => {
  const db = new Database(':memory:');
  const q = (sql) => executeSQL(db, sql, { safety: false });
  await q('CREATE TABLE t (id INTEGER PRIMARY KEY, v INTEGER, g TEXT)');
  await q("INSERT INTO t VALUES (1,1,'a'),(2,2,'a'),(3,3,'b'),(4,4,'b')");

  let r = await q('SELECT CASE WHEN COUNT(*)>2 THEN 1 ELSE 0 END FROM t');
  ok('#52 整表聚合 CASE WHEN COUNT(*)>2 => [[1]]', j(r.rows) === j([[1]]), r.rows);

  r = await q('SELECT CASE WHEN COUNT(*)>10 THEN 1 ELSE 0 END FROM t');
  ok('#52 条件为假走 ELSE => [[0]]', j(r.rows) === j([[0]]), r.rows);

  r = await q('SELECT CASE WHEN SUM(v)>6 THEN 1 ELSE 0 END AS f FROM t');
  ok('#52 SUM 内嵌 CASE', j(r.rows) === j([[1]]), r.rows);

  r = await q('SELECT CASE WHEN SUM(v)>100 THEN 1 ELSE 0 END AS f FROM t');
  ok('#52 SUM 条件为假', j(r.rows) === j([[0]]), r.rows);

  r = await q('SELECT CASE WHEN COUNT(*)>2 THEN COUNT(*) ELSE 0 END FROM t');
  ok('#52 THEN 分支也是聚合 => [[4]]', j(r.rows) === j([[4]]), r.rows);

  r = await q('SELECT CASE WHEN COUNT(*)>2 THEN 1 ELSE 0 END AS f FROM t GROUP BY g');
  ok('#52 GROUP BY 路径每组计数=2，条件假', j(r.rows) === j([[0], [0]]), r.rows);

  r = await q('SELECT CASE WHEN COUNT(*)>=2 THEN 1 ELSE 0 END AS f FROM t GROUP BY g');
  ok('#52 GROUP BY 路径每组计数=2，条件真 => [[1],[1]]', j(r.rows) === j([[1], [1]]), r.rows);

  r = await q('SELECT g, CASE WHEN SUM(v)>3 THEN 1 ELSE 0 END AS f FROM t GROUP BY g');
  ok('#52 GROUP BY 每组 SUM', j(r.rows) === j([['a', 0], ['b', 1]]), r.rows);

  r = await q('SELECT CASE WHEN MAX(v)>=4 THEN 1 ELSE 0 END FROM t');
  ok('#52 MAX 内嵌 CASE', j(r.rows) === j([[1]]), r.rows);

  r = await q('SELECT COUNT(*) AS c, CASE WHEN COUNT(*)>2 THEN 1 ELSE 0 END AS f FROM t');
  ok('#52 普通聚合列与 CASE 聚合列共存', j(r.rows) === j([[4, 1]]), r.rows);

  r = await q('SELECT CASE WHEN COUNT(*)>2 THEN 1 ELSE 0 END AS f FROM t HAVING CASE WHEN COUNT(*)>2 THEN 1 ELSE 0 END = 1');
  ok('#52 HAVING 里的 CASE 聚合', j(r.rows) === j([[1]]), r.rows);

  console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed\n`);
  if (fail > 0) process.exit(1);
})();
