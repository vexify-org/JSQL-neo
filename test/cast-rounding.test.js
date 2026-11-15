/* ---- CAST 到整数：MySQL 是四舍五入，不是截断 ---- */
/*
 * 差分探针发现 `CAST(1.9 AS SIGNED)` 返回 1，MySQL 8.0 返回 2 —— 小数转
 * 整数是 **四舍五入（半远离零）**，不是截断。此前用 Math.trunc。
 * 注意 Math.round 是「半向 +∞」，负数必须取绝对值再舍入，否则 -1.5 → -1。
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

  // ---------- 正数：四舍五入 ----------
  ok('CAST(1.4 AS SIGNED) = 1', await q('SELECT CAST(1.4 AS SIGNED)') === 1, null);
  ok('CAST(1.5 AS SIGNED) = 2（半远离零）', await q('SELECT CAST(1.5 AS SIGNED)') === 2, null);
  ok('CAST(1.9 AS SIGNED) = 2（此前错为 1）', await q('SELECT CAST(1.9 AS SIGNED)') === 2, null);
  ok('CAST(2.5 AS SIGNED) = 3', await q('SELECT CAST(2.5 AS SIGNED)') === 3, null);
  ok('CAST(2.4 AS SIGNED) = 2', await q('SELECT CAST(2.4 AS SIGNED)') === 2, null);

  // ---------- 负数：不能变成「半向 +∞」 ----------
  ok('CAST(-1.4 AS SIGNED) = -1', await q('SELECT CAST(-1.4 AS SIGNED)') === -1, null);
  ok('CAST(-1.5 AS SIGNED) = -2（半远离零）', await q('SELECT CAST(-1.5 AS SIGNED)') === -2, null);
  ok('CAST(-1.9 AS SIGNED) = -2', await q('SELECT CAST(-1.9 AS SIGNED)') === -2, null);

  // ---------- 字符串 ----------
  ok("CAST('1.9' AS SIGNED) = 2", await q("SELECT CAST('1.9' AS SIGNED)") === 2, null);
  ok("CAST('12abc' AS SIGNED) = 12（取数字前缀）", await q("SELECT CAST('12abc' AS SIGNED)") === 12, null);
  ok("CAST('abc' AS SIGNED) = 0", await q("SELECT CAST('abc' AS SIGNED)") === 0, null);
  ok("CAST('-1.5' AS SIGNED) = -2", await q("SELECT CAST('-1.5' AS SIGNED)") === -2, null);

  // ---------- UNSIGNED / NULL ----------
  ok('CAST(2.5 AS UNSIGNED) = 3', await q('SELECT CAST(2.5 AS UNSIGNED)') === 3, null);
  ok('CAST(-5 AS UNSIGNED) 按 2^64 回绕',
    String(await q('SELECT CAST(-5 AS UNSIGNED)')) === '18446744073709551611', null);
  ok('CAST(NULL AS SIGNED) = NULL', await q('SELECT CAST(NULL AS SIGNED)') === null, null);

  // ---------- 不回归：DECIMAL 标度（#96）与其它类型 ----------
  ok('CAST(123.456 AS DECIMAL(10,2)) = 123.46',
    await q('SELECT CAST(123.456 AS DECIMAL(10,2))') === 123.46, null);
  ok('CAST(1.9 AS CHAR) 仍是字符串', await q('SELECT CAST(1.9 AS CHAR)') === '1.9', null);
  ok('CAST(42 AS CHAR) 仍是字符串', await q('SELECT CAST(42 AS CHAR)') === '42', null);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => {
  console.log('[FAIL] unexpected exception: ' + e.stack.split('\n').slice(0, 3).join('\n'));
  process.exit(1);
});
