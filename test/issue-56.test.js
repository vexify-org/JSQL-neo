/*
 * Issue #56 — SUM/AVG 对 >2^53 的整数丢精度。
 *
 * 聚合累加用 Number(v) 的浮点加法，9007199254740993 + 9007199254740992
 * 会被舍入成 18014398509481984。修复：整数输入用 BigInt 精确累加，
 * 结果超出安全范围时以 BigInt 返回（executeSQL 收尾转字符串），
 * 安全范围内仍返回 number，浮点输入保持原行为。
 */
const path = require('path');
const ROOT = path.join(__dirname, '..');
const { Database } = require(path.join(ROOT, 'index.js'));
const { executeSQL } = require(path.join(ROOT, 'lib', 'sql.js'));

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('[OK]  ', name); }
  else { fail++; console.log('[FAIL]', name, extra !== undefined ? '-> ' + JSON.stringify(extra, (k, v) => (typeof v === 'bigint' ? v.toString() + 'n' : v)).slice(0, 400) : ''); }
}
// 聚合结果可能是 number / bigint / 超出 2^53 后被 finalize 成字符串
const s = (v) => String(v);

(async () => {
  const db = new Database(':memory:', { autoSave: false });
  const q = (sql) => executeSQL(db, sql, { safety: false });
  await q('CREATE TABLE b (id INTEGER PRIMARY KEY AUTOINCREMENT, x BIGINT)');
  await q('INSERT INTO b (x) VALUES (9007199254740993),(9007199254740992)');

  let r = await q('SELECT SUM(x) FROM b');
  ok('#56 SUM >2^53 精确 => 18014398509481985', s(r.rows[0][0]) === '18014398509481985', r.rows);

  r = await q('SELECT AVG(x) FROM b');
  ok('#56 AVG => 9007199254740992.5（double 下等于 9007199254740992）',
    Number(r.rows[0][0]) === 9007199254740992.5, r.rows);

  r = await q('SELECT SUM(x), AVG(x) FROM b');
  ok('#56 SUM+AVG 同列', s(r.rows[0][0]) === '18014398509481985' && Number(r.rows[0][1]) === 9007199254740992.5, r.rows);

  r = await q('SELECT id, SUM(x) AS t FROM b GROUP BY id ORDER BY id');
  ok('#56 GROUP BY 单行 SUM 不丢精度',
    s(r.rows[0][1]) === '9007199254740993' && s(r.rows[1][1]) === '9007199254740992', r.rows);

  // 安全范围 / 普通浮点不能回归
  await q('CREATE TABLE small (n INTEGER, f DOUBLE)');
  await q('INSERT INTO small (n, f) VALUES (1,1.5),(2,2.5),(3,3.5)');
  r = await q('SELECT SUM(n), AVG(n) FROM small');
  ok('#56 小整数 SUM 仍是 number 6', r.rows[0][0] === 6 && typeof r.rows[0][0] === 'number', r.rows);
  ok('#56 小整数 AVG 仍是 number 2', r.rows[0][1] === 2 && typeof r.rows[0][1] === 'number', r.rows);
  r = await q('SELECT SUM(f), AVG(f) FROM small');
  ok('#56 浮点 SUM 保持 7.5', r.rows[0][0] === 7.5 && typeof r.rows[0][0] === 'number', r.rows);
  ok('#56 浮点 AVG 保持 2.5', r.rows[0][1] === 2.5, r.rows);

  // 空集语义不能被改坏
  r = await q('SELECT SUM(n) FROM small WHERE n > 100');
  ok('#56 空集 SUM 仍为 NULL', r.rows[0][0] === null, r.rows);
  r = await q('SELECT AVG(n) FROM small WHERE n > 100');
  ok('#56 空集 AVG 仍为 NULL', r.rows[0][0] === null, r.rows);

  // 负值 / 混合字符串数字
  await q("CREATE TABLE mix (k TEXT)");
  await q("INSERT INTO mix (k) VALUES ('9007199254740993'),('1')");
  r = await q('SELECT SUM(k) FROM mix');
  ok('#56 十进制字符串参与精确求和', s(r.rows[0][0]) === '9007199254740994', r.rows);

  // DISTINCT 仍然有效
  r = await q('SELECT SUM(DISTINCT x) FROM b');
  ok('#56 SUM(DISTINCT) 正常', s(r.rows[0][0]) === '18014398509481985', r.rows);

  console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed\n`);
  if (fail > 0) process.exit(1);
})();
