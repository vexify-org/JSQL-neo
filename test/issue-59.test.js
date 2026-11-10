/*
 * Issue #59 — WHERE 子句拒绝裸布尔谓词（#21/#42 回归）。
 *
 * WHERE 1 / WHERE col / WHERE name 这类没有显式比较运算符的谓词，
 * 在布尔上下文里应按 MySQL 三值逻辑的 truthiness 求值：
 *   数字/布尔 → <> 0；字符串 → 非空；NULL → 未知（不匹配）。
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

  await q('CREATE TABLE t (id INT PRIMARY KEY, active INT, name TEXT, flag INT)');
  await q("INSERT INTO t VALUES (1, 1, 'a', 1), (2, 0, NULL, 0), (3, 5, 'c', 1)");

  // 裸列谓词
  let r = await q('SELECT id FROM t WHERE active');
  ok('#59 WHERE active（整数列 truthiness）=> [1,3]', j(r.rows) === j([[1], [3]]), r.rows);

  r = await q('SELECT id FROM t WHERE name');
  ok('#59 WHERE name（非空字符串）=> [1,3]', j(r.rows) === j([[1], [3]]), r.rows);

  r = await q('SELECT id FROM t WHERE flag');
  ok('#59 WHERE flag => [1,3]', j(r.rows) === j([[1], [3]]), r.rows);

  // 裸常量谓词
  r = await q('SELECT id FROM t WHERE 1');
  ok('#59 WHERE 1 恒真 => 全部行', j(r.rows) === j([[1], [2], [3]]), r.rows);

  r = await q('SELECT id FROM t WHERE 0');
  ok('#59 WHERE 0 恒假 => 空', j(r.rows) === j([]), r.rows);

  r = await q("SELECT id FROM t WHERE ''");
  ok('#59 WHERE 空字符串 => 空', j(r.rows) === j([]), r.rows);

  // 与 ORDER BY / 逻辑运算组合
  r = await q('SELECT id FROM t WHERE active ORDER BY id DESC');
  ok('#59 WHERE 裸谓词 + ORDER BY', j(r.rows) === j([[3], [1]]), r.rows);

  r = await q('SELECT id FROM t WHERE 1 AND id > 1 ORDER BY id');
  ok('#59 WHERE 裸谓词 AND 比较式', j(r.rows) === j([[2], [3]]), r.rows);

  r = await q('SELECT id FROM t WHERE 0 OR active');
  ok('#59 WHERE 裸谓词 OR 裸谓词', j(r.rows) === j([[1], [3]]), r.rows);

  // HAVING 裸谓词
  r = await q('SELECT active, COUNT(*) AS c FROM t GROUP BY active HAVING flag ORDER BY active');
  ok('#59 HAVING 裸谓词', j(r.rows) === j([[1, 1], [5, 1]]), r.rows);

  // 不破坏 #21/#42 既有比较语义
  r = await q('SELECT id FROM t WHERE active = 1');
  ok('#59 普通比较未回归（= 1）', j(r.rows) === j([[1]]), r.rows);

  r = await q('SELECT id FROM t WHERE active IN (0, 5) ORDER BY id');
  ok('#59 普通比较未回归（IN）', j(r.rows) === j([[2], [3]]), r.rows);

  r = await q('SELECT id FROM t WHERE name IS NULL');
  ok('#59 IS NULL 未回归', j(r.rows) === j([[2]]), r.rows);

  r = await q('SELECT id FROM t WHERE active BETWEEN 1 AND 3');
  ok('#59 BETWEEN 未回归', j(r.rows) === j([[1]]), r.rows);

  console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed\n`);
  if (fail > 0) process.exit(1);
})();
