/* ---- MySQL 天数/秒数 ↔ 日期/时间 互转函数 ---- */
/*
 * 这五个函数此前完全没实现，调用时落到 applyScalarFunction 的 default
 * 静默返回 null —— 很容易被误读成「数据里没这个值」。
 * 基准与 6.6.0 起的 UTC 墙上时间口径一致。
 */
const path = require('path');
const ROOT = path.join(__dirname, '..');
const { Database, executeSQL } = require(path.join(ROOT, 'index.js'));

let pass = 0, fail = 0;
function ok(name, cond, got) {
  if (cond) { pass++; console.log('[OK]   ' + name); }
  else { fail++; console.log('[FAIL] ' + name + ' -> ' + JSON.stringify(got)); }
}

(async () => {
  const db = new Database(':memory:', { autoSave: false });
  const q = async (sql) => (await executeSQL(db, sql, { safety: false })).rows[0][0];

  // ---------- TO_DAYS / FROM_DAYS ----------
  ok('TO_DAYS epoch = 719528', await q("SELECT TO_DAYS('1970-01-01')") === 719528, null);
  ok('FROM_DAYS(719528) = 1970-01-01', await q('SELECT FROM_DAYS(719528)') === '1970-01-01', null);
  for (const d of ['2024-05-06', '2024-02-29', '2000-01-01', '1999-12-31']) {
    const v = await q(`SELECT FROM_DAYS(TO_DAYS('${d}'))`);
    ok('TO_DAYS/FROM_DAYS 往返 ' + d, v === d, v);
  }
  ok('TO_DAYS 非法日期 → NULL', await q("SELECT TO_DAYS('bad')") === null, null);
  ok('TO_DAYS(NULL) → NULL', await q('SELECT TO_DAYS(NULL)') === null, null);
  ok('FROM_DAYS(NULL) → NULL', await q('SELECT FROM_DAYS(NULL)') === null, null);

  // ---------- TO_SECONDS ----------
  ok('TO_SECONDS epoch = 62167219200',
    await q("SELECT TO_SECONDS('1970-01-01 00:00:00')") === 62167219200, null);
  ok('TO_SECONDS 累加当日秒数',
    await q("SELECT TO_SECONDS('1970-01-01 01:02:03')") === 62167219200 + 3723, null);
  ok('TO_SECONDS 非法 → NULL', await q("SELECT TO_SECONDS('bad')") === null, null);

  // ---------- TIME_TO_SEC / SEC_TO_TIME ----------
  ok("TIME_TO_SEC('12:30:45') = 45045", await q("SELECT TIME_TO_SEC('12:30:45')") === 45045, null);
  ok("TIME_TO_SEC('-12:30:45') = -45045", await q("SELECT TIME_TO_SEC('-12:30:45')") === -45045, null);
  ok("TIME_TO_SEC('100:00:00') 支持超过 24h", await q("SELECT TIME_TO_SEC('100:00:00')") === 360000, null);
  ok("TIME_TO_SEC('12:30') 省略秒", await q("SELECT TIME_TO_SEC('12:30')") === 45000, null);
  ok('SEC_TO_TIME(45045)', await q('SELECT SEC_TO_TIME(45045)') === '12:30:45', null);
  ok('SEC_TO_TIME(-45045) 带负号', await q('SELECT SEC_TO_TIME(-45045)') === '-12:30:45', null);
  ok('SEC_TO_TIME(360000) 超过 24h', await q('SELECT SEC_TO_TIME(360000)') === '100:00:00', null);
  ok('SEC_TO_TIME(0)', await q('SELECT SEC_TO_TIME(0)') === '00:00:00', null);
  ok('TIME_TO_SEC / SEC_TO_TIME 往返',
    await q("SELECT SEC_TO_TIME(TIME_TO_SEC('50:01:02'))") === '50:01:02', null);
  ok('TIME_TO_SEC 非法 → NULL', await q("SELECT TIME_TO_SEC('bad')") === null, null);
  ok('SEC_TO_TIME(NULL) → NULL', await q('SELECT SEC_TO_TIME(NULL)') === null, null);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => {
  console.log('[FAIL] unexpected exception: ' + e.stack.split('\n').slice(0, 3).join('\n'));
  process.exit(1);
});
