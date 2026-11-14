/*
 * Issue #50 — DATETIME 列把 ISO-8601 的 Z / 时区偏移当成本地时间原样存储。
 *
 * 历史：#50 引入了「带时区标记 → 换算到本地时区；无标记 → 本地字面值」的语义。
 * 自 6.6.0 起引擎改为 **UTC 稳定基准**（见 #75）：
 *   - 带 Z / ±HH:MM → 先换算成绝对时刻，再以 UTC 墙上时间落库；
 *   - 不带时区标记 → 字面值即 UTC 墙上时间，原样落库。
 * 这样 '2024-01-15T10:30:00Z' 与 '2024-01-15 10:30:00' 落库一致，
 * 且结果与运行主机时区无关（旧语义在不同 TZ 的机器上落库值不同）。
 *
 * 断言全部用 Date.UTC 计算期望值，故任何 TZ 下都成立。
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
/** 绝对时刻（毫秒）→ UTC 墙上时间 'YYYY-MM-DD HH:MM:SS' —— 即落库格式 */
function utcStr(ms) {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())} ` +
    `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}`;
}
/** 带时区标记的 ISO 串 → 落库值（UTC 墙上时间） */
function storedOf(iso) { return utcStr(Date.parse(iso)); }

(async () => {
  const db = new Database(':memory:');
  const q = (sql) => executeSQL(db, sql, { safety: false });
  await q('CREATE TABLE t (id INTEGER PRIMARY KEY, dt DATETIME)');

  // 1) 带 Z：绝对时刻不变，按 UTC 墙上时间存储
  await q("INSERT INTO t (id, dt) VALUES (1, '2024-01-15T10:30:00Z')");
  let r = await q('SELECT dt FROM t WHERE id = 1');
  const expectZ = storedOf('2024-01-15T10:30:00Z');
  ok('#50 ISO Z 按绝对时刻存储（UTC 墙上时间）', r.rows[0][0] === expectZ, { got: r.rows[0][0], want: expectZ });
  ok('#50 Z 字面量具体值：2024-01-15 10:30:00', r.rows[0][0] === '2024-01-15 10:30:00', r.rows[0][0]);

  // 2) 带正偏移 +02:00
  await q("INSERT INTO t (id, dt) VALUES (2, '2024-01-15T10:30:00+02:00')");
  r = await q('SELECT dt FROM t WHERE id = 2');
  const expectPlus2 = storedOf('2024-01-15T10:30:00+02:00');
  ok('#50 ISO +02:00 偏移正确换算', r.rows[0][0] === expectPlus2, { got: r.rows[0][0], want: expectPlus2 });

  // 3) 带负偏移 -05:00
  await q("INSERT INTO t (id, dt) VALUES (3, '2024-01-15T10:30:00-05:00')");
  r = await q('SELECT dt FROM t WHERE id = 3');
  const expectMinus5 = storedOf('2024-01-15T10:30:00-05:00');
  ok('#50 ISO -05:00 偏移正确换算', r.rows[0][0] === expectMinus5, { got: r.rows[0][0], want: expectMinus5 });

  // 4) 带毫秒 + Z（#82：保留亚秒精度，不再静默截断为整秒）
  await q("INSERT INTO t (id, dt) VALUES (4, '2024-01-15T10:30:00.500Z')");
  r = await q('SELECT dt FROM t WHERE id = 4');
  ok('#50 带毫秒的 Z 同样换算（保留亚秒 .500）', r.rows[0][0] === '2024-01-15 10:30:00.500', r.rows[0][0]);

  // 5) 不带时区标记：字面值即 UTC 墙上时间，原样保存（与 Z 等价）
  await q("INSERT INTO t (id, dt) VALUES (5, '2024-01-15T10:30:00')");
  await q("INSERT INTO t (id, dt) VALUES (6, '2024-01-15 10:30:00')");
  r = await q('SELECT dt FROM t WHERE id IN (5,6)');
  ok('#50 无时区的 ISO 串按字面值保存', r.rows[0][0] === '2024-01-15 10:30:00', r.rows[0][0]);
  ok('#50 MySQL 格式原样保留', r.rows[1][0] === '2024-01-15 10:30:00', r.rows[1][0]);
  // 与 1) 同一行值完全相同 → 无时区与 Z 在 UTC 基准下等价（round-trip 闭合的关键）
  ok('#50 无时区与 Z 落库一致', r.rows[0][0] === expectZ && r.rows[1][0] === expectZ, r.rows);

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
    const want = storedOf(s);
    ok(`#50 等价写法 ${s} 换算正确`, got === want, { got, want });
  }

  // 9) DATETIME 存储的是「瞬间」：跨日/跨年的 UTC 换算会改变日期部分
  await q('CREATE TABLE crossyear (id INTEGER PRIMARY KEY, dt DATETIME)');
  await q("INSERT INTO crossyear VALUES (1, '2024-01-01T00:30:00+09:00')");
  r = await q('SELECT dt FROM crossyear WHERE id = 1');
  // +09:00 的 2024-01-01 00:30 == 2023-12-31 15:30Z（跨回上一年）
  const expectCross = storedOf('2024-01-01T00:30:00+09:00');
  ok('#50 时区换算可跨年', r.rows[0][0] === expectCross, { got: r.rows[0][0], want: expectCross });
  ok('#50 跨年具体值 2023-12-31 15:30:00', r.rows[0][0] === '2023-12-31 15:30:00', r.rows[0][0]);

  // 10) 主机时区无关性：同一 INSERT 在任何 TZ 下都得到同一落库值
  ok('#50 落库值与主机时区无关（无时区字面量）',
    validateDateType('2024-01-15 10:30:00', 'datetime', 'dt') === '2024-01-15 10:30:00',
    validateDateType('2024-01-15 10:30:00', 'datetime', 'dt'));
  ok('#50 TIMESTAMP 落库值与主机时区无关',
    validateDateType('2020-01-02 03:04:05', 'timestamp', 'ts') === Math.floor(Date.UTC(2020, 0, 2, 3, 4, 5) / 1000),
    validateDateType('2020-01-02 03:04:05', 'timestamp', 'ts'));
})();

setTimeout(() => {
  console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed\n`);
  if (fail > 0) process.exit(1);
}, 10);
