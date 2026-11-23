/*
 * Regression tests for #322 #323 #324 #325.
 */
const path = require('path');
const ROOT = path.join(__dirname, '..');
const { Database, executeSQL } = require(path.join(ROOT, 'index.js'));
let passed = 0, failed = 0;
function ok(name, cond, extra) {
  if (cond) { passed++; console.log('[OK]', name); }
  else { failed++; console.log('[FAIL]', name, extra !== undefined ? '→ ' + JSON.stringify(extra) : ''); }
}
const q = (db, sql) => executeSQL(db, sql, { safety: false });

(async () => {
  const db = new Database(':memory:');
  await q(db, 'SELECT 1');
  // #322 CASE 各子表达式支持二元表达式
  const cases = [
    [["SELECT CASE WHEN 1 THEN 1 + 2 END"], 3],
    [["SELECT CASE WHEN 1 THEN 1 / 2 END"], 0.5],
    [["SELECT CASE WHEN 0 THEN 'y' ELSE 1 + 0 END"], 1],
    [["SELECT CASE 1 + 1 WHEN 2 THEN 'two' END"], 'two'],
    [["SELECT CASE WHEN 1 THEN 1 = 1 END"], 1],
    [["SELECT CASE WHEN 1 THEN 1 AND 0 END"], 0],
  ];
  for (const [sql, expected] of cases) {
    let got, err;
    try { got = (await q(db, sql[0])).rows[0][0]; } catch (e) { err = e.message; }
    ok('#322 ' + sql[0], !err && String(got) === String(expected), err || got);
  }
  // #323 窗口 PARTITION BY / ORDER BY 二元表达式
  {
    await q(db, 'CREATE TABLE w (id INT, g INT, v INT)');
    await q(db, 'INSERT INTO w VALUES (1,1,10),(2,1,20),(3,2,30)');
    let rows, err;
    try {
      rows = (await q(db, 'SELECT id, SUM(v) OVER (PARTITION BY g % 2 ORDER BY v + 0) AS s FROM w')).rows;
    } catch (e) { err = e.message; }
    ok('#323 window expression parses and computes', !err && rows.length === 3, err || rows);
  }
  // #324 YEARWEEK 默认 mode 0
  {
    const one = async (sql) => (await q(db, sql)).rows[0][0];
    ok('#324 YEARWEEK default 2023-01-01', Number(await one("SELECT YEARWEEK('2023-01-01')")) === 202301, await one("SELECT YEARWEEK('2023-01-01')"));
    ok('#324 YEARWEEK default 2026-01-01', Number(await one("SELECT YEARWEEK('2026-01-01')")) === 202600, await one("SELECT YEARWEEK('2026-01-01')"));
    ok('#324 YEARWEEK mode 0 matches WEEK', Number(await one("SELECT YEARWEEK('2026-01-01', 0)")) === 202600, await one("SELECT YEARWEEK('2026-01-01', 0)"));
  }
  // #325 DECIMAL 负数半值远离零
  {
    const one = async (sql) => (await q(db, sql)).rows[0][0];
    ok('#325 CAST -1.5 DECIMAL(10,0)', Number(await one('SELECT CAST(-1.5 AS DECIMAL(10,0))')) === -2, await one('SELECT CAST(-1.5 AS DECIMAL(10,0))'));
    ok('#325 CAST -1.25 DECIMAL(10,1)', Number(await one('SELECT CAST(-1.25 AS DECIMAL(10,1))')) === -1.3, await one('SELECT CAST(-1.25 AS DECIMAL(10,1))'));
    ok('#325 CAST -1.5 string DECIMAL(10,0)', Number(await one("SELECT CAST('-1.5' AS DECIMAL(10,0))")) === -2, await one("SELECT CAST('-1.5' AS DECIMAL(10,0))"));
    ok('#325 positive half unchanged', Number(await one('SELECT CAST(1.25 AS DECIMAL(10,1))')) === 1.3, await one('SELECT CAST(1.25 AS DECIMAL(10,1))'));
  }
  db.stop();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
