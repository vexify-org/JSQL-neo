/*
 * Issue #57 — UNION / INTERSECT / EXCEPT 静默丢弃 ORDER BY / LIMIT / OFFSET。
 *
 * 语法层把组合查询尾部的 ORDER BY/LIMIT/OFFSET 挂在最右侧 SELECT 上，
 * 执行层却在 concat 后直接返回，导致这些子句完全失效。
 * 修复后：尾部子句提升为整个组合结果的语义（标准 SQL），按左列名/列序号排序分页。
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
const j = (rows) => JSON.stringify(rows);

(async () => {
  const db = new Database(':memory:');
  const q = (sql) => executeSQL(db, sql, { safety: false });

  let r = await q('SELECT 1 AS x UNION SELECT 2 UNION SELECT 3 LIMIT 1');
  ok('#57 UNION ... LIMIT 1 => [[1]]', j(r.rows) === j([[1]]), r.rows);

  r = await q('SELECT 1 AS x UNION SELECT 2 UNION SELECT 3 ORDER BY x DESC LIMIT 1');
  ok('#57 UNION ... ORDER BY x DESC LIMIT 1 => [[3]]', j(r.rows) === j([[3]]), r.rows);

  r = await q('SELECT 1 AS x UNION SELECT 2 UNION SELECT 3 ORDER BY 1 DESC LIMIT 1');
  ok('#57 ORDER BY 列序号 => [[3]]', j(r.rows) === j([[3]]), r.rows);

  r = await q('SELECT 1 AS x UNION SELECT 2 UNION SELECT 3 ORDER BY x DESC LIMIT 2 OFFSET 1');
  ok('#57 LIMIT 2 OFFSET 1 => [[2],[1]]', j(r.rows) === j([[2], [1]]), r.rows);

  r = await q('SELECT 1 AS x UNION ALL SELECT 1 UNION ALL SELECT 1 LIMIT 2');
  ok('#57 UNION ALL LIMIT 2 => 2 行', r.rows.length === 2, r.rows);

  r = await q('SELECT 1 AS x UNION SELECT 2 UNION SELECT 3 LIMIT 1 OFFSET 1');
  ok('#57 LIMIT 1 OFFSET 1 => [[2]]', j(r.rows) === j([[2]]), r.rows);

  r = await q('SELECT 1 AS x EXCEPT SELECT 2 LIMIT 1');
  ok('#57 EXCEPT + LIMIT => [[1]]', j(r.rows) === j([[1]]), r.rows);

  r = await q('SELECT 1 AS x INTERSECT SELECT 1 INTERSECT SELECT 1 LIMIT 1');
  ok('#57 INTERSECT + LIMIT => [[1]]', j(r.rows) === j([[1]]), r.rows);

  // 表数据上的组合查询
  await q('CREATE TABLE u1 (id INTEGER PRIMARY KEY AUTOINCREMENT, v INTEGER)');
  await q('CREATE TABLE u2 (id INTEGER PRIMARY KEY AUTOINCREMENT, v INTEGER)');
  await q('INSERT INTO u1 (v) VALUES (1),(3)');
  await q('INSERT INTO u2 (v) VALUES (2),(4)');
  r = await q('SELECT v FROM u1 UNION SELECT v FROM u2 ORDER BY v DESC LIMIT 2');
  ok('#57 两表 UNION + ORDER BY v DESC LIMIT 2 => [[4],[3]]', j(r.rows) === j([[4], [3]]), r.rows);

  r = await q('SELECT v FROM u1 UNION SELECT v FROM u2 ORDER BY v LIMIT 3 OFFSET 1');
  ok('#57 两表 UNION + LIMIT/OFFSET => [[2],[3],[4]]', j(r.rows) === j([[2], [3], [4]]), r.rows);

  r = await q('SELECT v FROM u1 UNION ALL SELECT v FROM u2 ORDER BY 1 LIMIT 1');
  ok('#57 表数据 ORDER BY 1', j(r.rows) === j([[1]]), r.rows);

  // 不改变无尾部子句的行为
  r = await q('SELECT 1 AS x UNION SELECT 2');
  ok('#57 无 LIMIT 行为不变', j(r.rows) === j([[1], [2]]), r.rows);

  // 子句顺序正常（ORDER BY 在 LIMIT 前）已验证；LIMIT 在 ORDER BY 之前非法，不测

  console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed\n`);
  if (fail > 0) process.exit(1);
})();
