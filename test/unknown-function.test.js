/**
 * Bug hunt: 未知函数静默返回 NULL（v6.6.2）
 *
 * applyScalarFunction 的 default 分支写 `return null`，所以任何拼错/不存在的
 * 函数名都会得到 NULL 且 ok=true，调用方以为「数据为空」。引擎对未知列早已
 * 显式抛 no such column（_validateColumnRefs），函数路径漏了同一处理。
 *
 * 附带：本 PR 补上 default 暴露出的三角/对数函数族（此前根本不存在，
 * 测试里 `SELECT LOG(-5)`、`SELECT ACOS(2)` 是靠空值「假通过」的）。
 */
const { executeSQL } = require('../lib/sql.js');
const Database = require('../lib/database.js');

let passed = 0, failed = 0;
function ok(name, cond, got) {
  if (cond) passed++;
  else { failed++; console.log('[FAIL]', name, got !== undefined ? '-> ' + JSON.stringify(got) : ''); }
}

(async () => {
  const db = new Database(':memory:');
  await executeSQL(db, 'CREATE TABLE z (id INT PRIMARY KEY, v INT)', { safety: false });
  await executeSQL(db, 'INSERT INTO z (id, v) VALUES (1, 10), (2, 20)', { safety: false });
  const run = async (sql, opts) => executeSQL(db, sql, Object.assign({ safety: false }, opts || {}));
  const throws = async (sql, like) => {
    try { const r = await run(sql); return { threw: false, r }; }
    catch (e) { return { threw: true, msg: String(e.message || ''), code: e.code }; }
  };

  // ---- 1. 未知标量函数不再静默返回 NULL
  for (const sql of ['SELECT nosuchfunc(1) v', 'SELECT date_ad(\'2026-01-01\', 5) v', 'SELECT upperx(v) FROM z', 'SELECT NOW2() v', 'SELECT JSON_EXTRACTX(1) v']) {
    const t = await throws(sql);
    ok('未知函数抛错: ' + sql, t.threw && /does not exist/.test(t.msg), t.threw ? t.msg : JSON.stringify(t.r.rows));
  }

  // ---- 2. 未知函数被当作聚合时同样抛错（以前返回 [[null],[null]]）
  for (const sql of ['SELECT SUMM(v) FROM z', 'SELECT COUNTX(*) FROM z', 'SELECT MEDIAN(v) FROM z']) {
    const t = await throws(sql);
    ok('未知聚合抛错: ' + sql, t.threw && /does not exist/.test(t.msg), t.threw ? t.msg : JSON.stringify(t.r.rows));
  }

  // ---- 3. MySQL 错误码 1305 + 函数名可定位
  const t1 = await throws('SELECT date_ad(1) v');
  ok('错误码为 1305', t1.code === 1305, t1.code);
  ok('错误消息含原函数名', /date_ad/.test(t1.msg), t1.msg);

  // ---- 4. 已知函数不得被误杀（大小写、聚合、带表与否）
  for (const sql of ["SELECT UPPER('a') v", "SELECT upper('a') v", "SELECT CONCAT('a','b') v", 'SELECT COUNT(*) v FROM z', 'SELECT SUM(v) v FROM z', 'SELECT MAX(v) v FROM z', 'SELECT ROUND(1.5) v']) {
    const t = await throws(sql);
    ok('已知函数仍可用: ' + sql, !t.threw, t.threw ? t.msg : undefined);
  }

  // ---- 5. 用户自定义函数（executeSQL opts.functions）不被误杀
  const udf = await run('SELECT mydouble(21) v', { functions: { MYDOUBLE: (x) => Number(x) * 2 } });
  ok('UDF 仍可调用', udf.rows[0][0] === 42, udf.rows);

  // ---- 6. 补齐的数学函数：语义按 MySQL
  const one = async (sql) => (await run(sql)).rows[0][0];
  ok('LOG(X) 是自然对数（MySQL 语义）', await one('SELECT LOG(100) v') > 4.6 && await one('SELECT LOG(100) v') < 4.61, await one('SELECT LOG(100) v'));
  ok('LOG(B, X) 以 B 为底', await one('SELECT LOG(2, 8) v') === 3);
  ok('LOG 底为 1 返回 NULL', await one('SELECT LOG(1, 5) v') === null);
  ok('LN == LOG 单参', await one('SELECT LN(100) v') === await one('SELECT LOG(100) v'));
  ok('LOG10(1000) = 3', await one('SELECT LOG10(1000) v') === 3);
  ok('LOG2(8) = 3', await one('SELECT LOG2(8) v') === 3);
  ok('PI() 常量', await one('SELECT PI() v') === Math.PI);
  ok('三角函数弧度制', await one('SELECT SIN(0) v') === 0 && await one('SELECT COS(0) v') === 1 && await one('SELECT TAN(0) v') === 0);
  ok('ASIN/ACOS 域外返回 NULL', await one('SELECT ACOS(2) v') === null && await one('SELECT ASIN(2) v') === null);
  ok('ACOS(-5)/LOG(-5) 域外 NULL（#65 断言现在真实成立）', await one('SELECT LOG(-5) v') === null && await one('SELECT ACOS(2) v') === null);
  ok('EXP 溢出返回 NULL 而非 Infinity', await one('SELECT EXP(1000) v') === null);
  ok('EXP(0) = 1', await one('SELECT EXP(0) v') === 1);
  ok('CBRT(27) = 3', await one('SELECT CBRT(27) v') === 3);
  ok('DEGREES/RADIANS 互逆', await one('SELECT DEGREES(PI()) v') === 180 && await one('SELECT RADIANS(180) v') === Math.PI);
  ok('ATAN2 双参', await one('SELECT ATAN2(1, 1) v') === Math.atan2(1, 1));
  ok('COT(0) 不发散成 Infinity', await one('SELECT COT(0) v') === null);
  ok('非数字入参返回 NULL', await one("SELECT LOG('abc') v") === null && await one('SELECT ACOS(NULL) v') === null);

  // ---- 7. 与未知列行为一致（都是显式错误，不静默）
  const tCol = await throws('SELECT nosuchcol FROM z');
  ok('未知列仍报 no such column（回归）', tCol.threw && /no such column/.test(tCol.msg), tCol.msg);

  console.log(`\nunknown-function: ${passed} passed, ${failed} failed`);
  db.stop();
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
