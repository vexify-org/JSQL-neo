/*
 * Issue #54 — 未起别名的聚合列列名是 "SUM([object Object])"。
 *
 * scalarColumnName 对 c.aggregate 直接做字符串拼接，而 c.column 是 AST 节点对象，
 * 于是被 String() 成 "[object Object]"。应输出 "SUM(b)"。
 */
const path = require('path');
const ROOT = path.join(__dirname, '..');
const { Database } = require(path.join(ROOT, 'index.js'));
const { executeSQL } = require(path.join(ROOT, 'lib', 'sql.js'));

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('[OK]  ', name); }
  else { fail++; console.log('[FAIL]', name, extra !== undefined ? '-> ' + JSON.stringify(extra).slice(0, 300) : ''); }
}

(async () => {
  const db = new Database(':memory:');
  const q = (sql) => executeSQL(db, sql, { safety: false });
  await q('CREATE TABLE s (id INTEGER PRIMARY KEY, b INTEGER, c INTEGER, name TEXT)');
  await q("INSERT INTO s VALUES (1,10,1,'a'),(2,20,2,'b'),(3,30,3,'c')");

  let r = await q('SELECT SUM(b) FROM s');
  ok('#54 SUM 列名为 SUM(b)', r.columns[0] === 'SUM(b)', r.columns);
  ok('#54 SUM 值正确', r.rows[0][0] === 60, r.rows);

  r = await q('SELECT AVG(b), MIN(b), MAX(b), COUNT(b), COUNT(*) FROM s');
  ok('#54 AVG/MIN/MAX/COUNT 列名可读',
    JSON.stringify(r.columns) === JSON.stringify(['AVG(b)', 'MIN(b)', 'MAX(b)', 'COUNT(b)', 'COUNT(*)']), r.columns);

  r = await q('SELECT SUM(b+c) FROM s');
  ok('#54 聚合参数是表达式时列名不含 [object Object]', !/\[object Object\]/.test(r.columns[0]), r.columns);
  ok('#54 表达式聚合值正确（1+10+2+20+3+30=66）', r.rows[0][0] === 66, r.rows);

  r = await q('SELECT SUM(b) AS total FROM s');
  ok('#54 有别名时别名优先', r.columns[0] === 'total', r.columns);

  r = await q('SELECT MAX(LENGTH(name)) FROM s');
  ok('#54 函数参数聚合列名不含 [object Object]', !/\[object Object\]/.test(r.columns[0]), r.columns);

  r = await q('SELECT SUM(b), COUNT(*) FROM s');
  ok('#54 多列各自命名', JSON.stringify(r.columns) === JSON.stringify(['SUM(b)', 'COUNT(*)']), r.columns);

  r = await q('SELECT c, SUM(b) FROM s GROUP BY c');
  ok('#54 GROUP BY 路径同样正确', JSON.stringify(r.columns) === JSON.stringify(['c', 'SUM(b)']), r.columns);

  // raw 对象的键名也要可读
  ok('#54 raw 键名为 SUM(b)', Object.keys(r.raw[0]).includes('SUM(b)'), Object.keys(r.raw[0]));

  console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed\n`);
  if (fail > 0) process.exit(1);
})();
