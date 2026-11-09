/*
 * Issue #51 — GROUP BY <expression> 崩溃。
 *
 * GROUP BY 解析此前只接受裸列引用（parseColumnRef），遇到 a%2、b+1 这类表达式
 * 会在 GROUP BY 之后报 "Unexpected token ... after statement"。
 * 修复后应支持任意标量表达式分组，且结果正确。
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
const norm = (rows) => rows.map(r => r.map(v => (typeof v === 'bigint' ? Number(v) : v))).sort((a, b) => String(a[0]).localeCompare(String(b[0])));

(async () => {
  const db = new Database(':memory:');
  const q = (sql) => executeSQL(db, sql, { safety: false });
  await q('CREATE TABLE g (id INTEGER PRIMARY KEY, a INTEGER, b INTEGER)');
  await q('INSERT INTO g VALUES (1,1,10),(2,2,20),(3,3,30),(4,4,40)');

  let r = await q('SELECT a%2 AS p, COUNT(*) FROM g GROUP BY a%2');
  ok('#51 GROUP BY a%2 不抛错且结果正确',
    JSON.stringify(norm(r.rows)) === JSON.stringify([[0, 2], [1, 2]]), r.rows);

  r = await q('SELECT a%2 AS p, COUNT(*) FROM g GROUP BY p');
  ok('#51 GROUP BY 别名仍然可用',
    JSON.stringify(norm(r.rows)) === JSON.stringify([[0, 2], [1, 2]]), r.rows);

  r = await q('SELECT b+1 AS bp, COUNT(*) FROM g GROUP BY b+1');
  ok('#51 GROUP BY 算术表达式 b+1',
    JSON.stringify(norm(r.rows)) === JSON.stringify([[11, 1], [21, 1], [31, 1], [41, 1]]), r.rows);

  r = await q("SELECT UPPER('x') AS u, COUNT(*) FROM g GROUP BY UPPER('x')");
  ok('#51 GROUP BY 函数表达式', r.rows.length === 1 && Number(r.rows[0][1]) === 4, r.rows);

  r = await q('SELECT a%2 AS p, SUM(b) AS s FROM g GROUP BY a%2 ORDER BY p');
  ok('#51 表达式分组 + 聚合 + ORDER BY',
    JSON.stringify(norm(r.rows)) === JSON.stringify([[0, 60], [1, 40]]), r.rows);

  r = await q('SELECT a%2 AS p, COUNT(*) FROM g GROUP BY a%2 HAVING COUNT(*) > 2');
  ok('#51 表达式分组 + HAVING', r.rows.length === 0, r.rows);

  r = await q('SELECT a, COUNT(*) FROM g GROUP BY a');
  ok('#51 朴素列分组未被破坏', r.rows.length === 4, r.rows);

  r = await q('SELECT a, b, COUNT(*) FROM g GROUP BY a, b');
  ok('#51 多列分组未被破坏', r.rows.length === 4, r.rows);

  console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed\n`);
  if (fail > 0) process.exit(1);
})();
