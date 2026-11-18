/* ---- Issue #114：方差/标准差族的总体 vs 样本语义回归 ---- */
/*
 * MySQL 8.0 语义：
 *   VARIANCE(expr)   = VAR_POP(expr)     → 总体方差（分母 n）
 *   VAR_POP(expr)                        → 总体方差（分母 n）
 *   VAR_SAMP(expr)                       → 样本方差（分母 n-1）
 *   STDDEV(expr)     = STDDEV_POP(expr)  → 总体标准差
 *   STD(expr)        = STDDEV_POP(expr)  → 总体标准差（此前静默返回 NULL）
 *   STDDEV_SAMP(expr)                    → 样本标准差
 *
 * 此前无后缀版本全部落进 n-1 分支，结果系统性偏大。
 *
 *   node test/issue-114.test.js
 */
const path = require('path');
const ROOT = path.join(__dirname, '..');
const { Database, executeSQL } = require(path.join(ROOT, 'index.js'));

let pass = 0, fail = 0;
function ok(name, cond, got) {
  if (cond) { pass++; console.log('[OK]   ' + name); }
  else { fail++; console.log('[FAIL] ' + name + ' -> ' + JSON.stringify(got)); }
}
function near(a, b, eps = 1e-12) {
  return typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) < eps;
}

(async () => {
  const db = new Database(':memory:', { autoSave: false });
  const q = async (sql) => {
    const r = await executeSQL(db, sql, { safety: false });
    return r.rows[0][0];
  };

  // ---------- 无后缀版本 = 总体 ----------
  const variance123 = await q("SELECT VARIANCE(1,2,3)");
  ok('VARIANCE(1,2,3) = 2/3（总体）', near(variance123, 2 / 3), variance123);

  const stddev123 = await q("SELECT STDDEV(1,2,3)");
  ok('STDDEV(1,2,3) = √(2/3)（总体）', near(stddev123, Math.sqrt(2 / 3)), stddev123);

  const std123 = await q("SELECT STD(1,2,3)");
  ok('STD(1,2,3) = √(2/3)（STDDEV_POP 别名，不再为 NULL）',
    near(std123, Math.sqrt(2 / 3)), std123);

  // ---------- _POP / _SAMP 保持不变 ----------
  const varPop = await q("SELECT VAR_POP(1,2,3)");
  ok('VAR_POP(1,2,3) = 2/3', near(varPop, 2 / 3), varPop);

  const varSamp = await q("SELECT VAR_SAMP(1,2,3)");
  ok('VAR_SAMP(1,2,3) = 1', near(varSamp, 1), varSamp);

  const stddevPop = await q("SELECT STDDEV_POP(1,2,3)");
  ok('STDDEV_POP(1,2,3) = √(2/3)', near(stddevPop, Math.sqrt(2 / 3)), stddevPop);

  const stddevSamp = await q("SELECT STDDEV_SAMP(1,2,3)");
  ok('STDDEV_SAMP(1,2,3) = 1', near(stddevSamp, 1), stddevSamp);

  // ---------- 小样本 n=2：此前 VARIANCE 结果翻倍 ----------
  const v1020 = await q("SELECT VARIANCE(10,20)");
  ok('VARIANCE(10,20) = 25（不是 50）', near(v1020, 25), v1020);

  const s1020 = await q("SELECT VAR_SAMP(10,20)");
  ok('VAR_SAMP(10,20) = 50', near(s1020, 50), s1020);

  // ---------- 单列聚合（issue 原始复现） ----------
  const sub = '(SELECT 1 v UNION ALL SELECT 2 UNION ALL SELECT 3) t';
  const vAgg = await q(`SELECT VARIANCE(v) FROM ${sub}`);
  ok('VARIANCE(v) 聚合 = 2/3', near(vAgg, 2 / 3), vAgg);

  const sAgg = await q(`SELECT STDDEV(v) FROM ${sub}`);
  ok('STDDEV(v) 聚合 = √(2/3)', near(sAgg, Math.sqrt(2 / 3)), sAgg);

  const stdAgg = await q(`SELECT STD(v) FROM ${sub}`);
  ok('STD(v) 聚合 = √(2/3)', near(stdAgg, Math.sqrt(2 / 3)), stdAgg);

  const vpAgg = await q(`SELECT VAR_POP(v) FROM ${sub}`);
  ok('VAR_POP(v) 聚合 = 2/3', near(vpAgg, 2 / 3), vpAgg);

  const vsAgg = await q(`SELECT VAR_SAMP(v) FROM ${sub}`);
  ok('VAR_SAMP(v) 聚合 = 1', near(vsAgg, 1), vsAgg);

  // ---------- 分组聚合 ----------
  await executeSQL(db, 'CREATE TABLE g (k INT, v INT)', { safety: false });
  await executeSQL(db, 'INSERT INTO g (k, v) VALUES (1,1),(1,2),(1,3),(2,10),(2,20)', { safety: false });
  const rows = (await executeSQL(db, 'SELECT k, VARIANCE(v) AS var, STD(v) AS sd, VAR_SAMP(v) AS vs FROM g GROUP BY k ORDER BY k', { safety: false })).rows;
  ok('分组聚合返回 2 行', rows.length === 2, rows.length);
  ok('组 k=1 VARIANCE = 2/3', rows[0] && near(rows[0][1], 2 / 3), rows[0] && rows[0][1]);
  ok('组 k=1 STD = √(2/3)', rows[0] && near(rows[0][2], Math.sqrt(2 / 3)), rows[0] && rows[0][2]);
  ok('组 k=2 VARIANCE = 25', rows[1] && near(rows[1][1], 25), rows[1] && rows[1][1]);

  // ---------- NULL 处理：全 NULL → NULL ----------
  await executeSQL(db, 'CREATE TABLE n (v INT)', { safety: false });
  await executeSQL(db, 'INSERT INTO n (v) VALUES (NULL)', { safety: false });
  ok('全 NULL 的 VARIANCE 返回 NULL', await q('SELECT VARIANCE(v) FROM n') === null, null);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => {
  console.log('[FAIL] unexpected exception: ' + e.stack.split('\n').slice(0, 3).join('\n'));
  process.exit(1);
});
