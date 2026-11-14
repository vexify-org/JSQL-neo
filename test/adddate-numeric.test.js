/**
 * Bug hunt: ADDDATE/SUBDATE 的数字（天数）形式被静默忽略（v6.6.2）
 *
 * MySQL 里 ADDDATE(expr, days) 与 DATE_ADD(expr, INTERVAL days DAY) 等价，
 * 但 lib/sql.js 的 case 'DATE_ADD'/'ADDDATE' 只处理 __interval 形式，
 * 数字形式直接 fallthrough 返回原日期 —— 整个增量被丢掉且不报错。
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
  const one = async (sql) => (await executeSQL(db, sql, { safety: false })).rows[0][0];

  // ---- 数字形式：加/减 N 天
  ok('ADDDATE 数字形式加 5 天', await one("SELECT ADDDATE('2026-01-01', 5)") === '2026-01-06');
  ok('SUBDATE 数字形式减 5 天', await one("SELECT SUBDATE('2026-01-10', 5)") === '2026-01-05');
  ok('ADDDATE 负数等价减法', await one("SELECT ADDDATE('2026-01-10', -5)") === '2026-01-05');
  ok('SUBDATE 负数等价加法', await one("SELECT SUBDATE('2026-01-01', -5)") === '2026-01-06');
  ok('ADDDATE 0 天不变', await one("SELECT ADDDATE('2026-01-01', 0)") === '2026-01-01');

  // ---- 跨月 / 闰年 / 月末
  ok('ADDDATE 跨月', await one("SELECT ADDDATE('2026-01-31', 1)") === '2026-02-01');
  ok('ADDDATE 跨年', await one("SELECT ADDDATE('2026-12-31', 1)") === '2027-01-01');
  ok('ADDDATE 闰年 2 月', await one("SELECT ADDDATE('2024-02-28', 1)") === '2024-02-29');

  // ---- DATETIME 保留时间部分
  ok('ADDDATE 保留时分秒', await one("SELECT ADDDATE('2026-01-01 12:34:56', 5)") === '2026-01-06 12:34:56');

  // ---- 与 INTERVAL 形式等价（同一结果的两种写法）
  ok('数字形式 == INTERVAL 形式',
    await one("SELECT ADDDATE('2026-01-01', 5)") === await one("SELECT DATE_ADD('2026-01-01', INTERVAL 5 DAY)"));

  // ---- 字符串数字与列值
  ok('字符串天数按数字处理', await one("SELECT ADDDATE('2026-01-01', '5')") === '2026-01-06');
  await executeSQL(db, "CREATE TABLE d (id INT PRIMARY KEY, dt DATE, n INT)", { safety: false });
  await executeSQL(db, "INSERT INTO d (id, dt, n) VALUES (1, '2026-01-01', 10)", { safety: false });
  ok('列值作为天数', await one("SELECT ADDDATE(dt, n) FROM d WHERE id = 1") === '2026-01-11');

  // ---- 非法输入不再静默返回原值
  ok('非数字天数返回 NULL', await one("SELECT ADDDATE('2026-01-01', 'abc')") === null);
  ok('非法日期仍返回 NULL', await one("SELECT ADDDATE('not-a-date', 5)") === null);

  // ---- DATE_ADD / DATE_SUB 的 INTERVAL 形式不得回归
  ok('DATE_ADD INTERVAL 不回归', await one("SELECT DATE_ADD('2026-01-31', INTERVAL 1 MONTH)") === '2026-02-28');
  ok('DATE_SUB INTERVAL 不回归', await one("SELECT DATE_SUB('2026-03-01', INTERVAL 1 DAY)") === '2026-02-28');
  ok('DATE_ADD 其它单位不回归', await one("SELECT DATE_ADD('2026-01-01 00:00:00', INTERVAL 2 HOUR)") === '2026-01-01 02:00:00');

  console.log(`\nadddate-numeric: ${passed} passed, ${failed} failed`);
  db.stop();
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
