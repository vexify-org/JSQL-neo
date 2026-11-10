/*
 * Issue #50 — DATETIME 列把 ISO-8601 的 Z / 时区偏移当成本地时间原样存储。
 *
 * '2024-01-15T10:30:00Z' 表示 UTC 10:30，在 UTC+8 环境落库应为 '2024-01-15 18:30:00'，
 * 而不是丢掉 Z 变成 10:30:00。不带时区标记的写法仍按本地时间字面值处理（MySQL 语义）。
 *
 * 注意：断言按运行环境时区动态计算期望值，CI 在 UTC 下同样成立。
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

const pad2 = (n) => String(n).padStart(2, '0');
function localStr(utcMs) {
  const d = new Date(utcMs);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ` +
    `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

(async () => {
  const db = new Database(':memory:');
  const q = (sql) => executeSQL(db, sql, { safety: false });
  await q('CREATE TABLE t (id INTEGER PRIMARY KEY, dt DATETIME)');

  // 1) 带 Z：UTC → 本地
  await q("INSERT INTO t (id, dt) VALUES (1, '2024-01-15T10:30:00Z')");
  let r = await q('SELECT dt FROM t WHERE id = 1');
  const expectZ = localStr(Date.parse('2024-01-15T10:30:00Z'));
  ok('#50 ISO Z 按 UTC 转本地时区', r.rows[0][0] === expectZ, { got: r.rows[0][0], want: expectZ });
  if (new Date().getTimezoneOffset() === -480) {
    ok('#50 UTC+8 下 Z 时间 +8 小时', r.rows[0][0] === '2024-01-15 18:30:00', r.rows[0][0]);
  }

  // 2) 带正偏移 +02:00
  await q("INSERT INTO t (id, dt) VALUES (2, '2024-01-15T10:30:00+02:00')");
  r = await q('SELECT dt FROM t WHERE id = 2');
  const expectPlus2 = localStr(Date.parse('2024-01-15T10:30:00+02:00'));
  ok('#50 ISO +02:00 偏移正确换算', r.rows[0][0] === expectPlus2, { got: r.rows[0][0], want: expectPlus2 });

  // 3) 带负偏移 -05:00
  await q("INSERT INTO t (id, dt) VALUES (3, '2024-01-15T10:30:00-05:00')");
  r = await q('SELECT dt FROM t WHERE id = 3');
  const expectMinus5 = localStr(Date.parse('2024-01-15T10:30:00-05:00'));
  ok('#50 ISO -05:00 偏移正确换算', r.rows[0][0] === expectMinus5, { got: r.rows[0][0], want: expectMinus5 });

  // 4) 带毫秒 + Z
  await q("INSERT INTO t (id, dt) VALUES (4, '2024-01-15T10:30:00.500Z')");
  r = await q('SELECT dt FROM t WHERE id = 4');
  ok('#50 带毫秒的 Z 同样换算（毫秒截断）', r.rows[0][0] === expectZ, r.rows[0][0]);

  // 5) 不带时区标记：仍是字面值（本地时间），不能被当成 UTC
  await q("INSERT INTO t (id, dt) VALUES (5, '2024-01-15T10:30:00')");
  await q("INSERT INTO t (id, dt) VALUES (6, '2024-01-15 10:30:00')");
  r = await q('SELECT dt FROM t WHERE id IN (5,6)');
  ok('#50 无时区的 ISO 串按字面值保存', r.rows[0][0] === '2024-01-15 10:30:00', r.rows[0][0]);
  ok('#50 MySQL 格式原样保留', r.rows[1][0] === '2024-01-15 10:30:00', r.rows[1][0]);

  // 6) 纯日期列不受影响
  await q('CREATE TABLE d (id INTEGER PRIMARY KEY, dd DATE)');
  await q("INSERT INTO d (id, dd) VALUES (1, '2024-01-15')");
  r = await q('SELECT dd FROM d');
  ok('#50 DATE 列行为不变', r.rows[0][0] === '2024-01-15', r.rows[0][0]);

  // 7) 直接调用 date-types 的规范化函数
  const { validateDateType } = require(path.join(ROOT, 'lib', 'date-types.js'));
  ok('#50 validateDateType datetime Z',
    validateDateType('2024-01-15T10:30:00Z', 'datetime', 'dt') === expectZ,
    validateDateType('2024-01-15T10:30:00Z', 'datetime', 'dt'));
  ok('#50 validateDateType 非法日期仍报错',
    (() => { try { validateDateType('2024-13-45T10:30:00Z', 'datetime', 'dt'); return false; } catch (e) { return true; } })());

  // 8) 更多等价写法：小写 z、紧凑偏移 ±HHMM、非整点时区、跨年、带空格的偏移
  const isoCases = [
    '2024-01-15T10:30:00z',
    '2024-01-15T10:30:00-0500',
    '2024-01-15T10:30:00+0530',
    '2024-12-31T23:59:59Z',
    '2024-02-29T00:00:00+09:00',
    '2024-01-15 10:30:00+08:00',
  ];
  await q('CREATE TABLE tz (id INTEGER PRIMARY KEY, dt DATETIME)');
  for (let i = 0; i < isoCases.length; i++) {
    const s = isoCases[i];
    await q(`INSERT INTO tz (id, dt) VALUES (${i + 1}, '${s}')`);
    const got = (await q(`SELECT dt FROM tz WHERE id = ${i + 1}`)).rows[0][0];
    const want = localStr(Date.parse(s));
    ok(`#50 等价写法 ${s} 换算正确`, got === want, { got, want });
  }

  // 9) DATETIME 存储的是「瞬间」：跨日/跨年的 UTC 换算会改变日期部分
  await q('CREATE TABLE crossyear (id INTEGER PRIMARY KEY, dt DATETIME)');
  await q("INSERT INTO crossyear VALUES (1, '2024-01-01T00:30:00+09:00')");
  r = await q('SELECT dt FROM crossyear WHERE id = 1');
  // UTC+8 下应为 2023-12-31 23:30:00（跨回上一年）
  const expectCross = localStr(Date.parse('2024-01-01T00:30:00+09:00'));
  ok('#50 时区换算可跨年', r.rows[0][0] === expectCross, { got: r.rows[0][0], want: expectCross });
  if (new Date().getTimezoneOffset() === -480) {
    ok('#50 UTC+8 跨年具体值', r.rows[0][0] === '2023-12-31 23:30:00', r.rows[0][0]);
  }
})();

setTimeout(() => {
  console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed\n`);
  if (fail > 0) process.exit(1);
}, 10);
