/**
 * Bug hunt: BigInt 参与算术/位运算时被静默塌成 0（v6.6.2 复现，纯 JS 引擎）
 *
 * 根因：mysqlNum() 没有 BigInt 分支，落到 `return 0`，而 negate、'%'、'DIV'、
 * '& | ^ << >>' 以及 ABS/SIGN/CEIL/FLOOR/MOD/POW/SQRT/TRUNCATE 都走它。
 * 表现分三档：
 *   1. 静默错值（最危险）：SELECT -9223372036854775807 → 0
 *      SELECT 9223372036854775807 % 3 → 0（真值 1）、SIGN(bigint) → 0
 *   2. 直接崩溃：ABS/CEIL/FLOOR/SQRT/POW(bigint) 抛
 *      "Cannot convert a BigInt value to a number"；MOD 抛 "Cannot mix BigInt…"
 *   3. 32 位截断：位运算写 (x|0)，4294967296 & 4294967296 → 0（真值 2^32）
 * 同一 bug 家族在 resolveOperand('arith')、evaluateExpr('binary') 与
 * resolveOperand 的重复 'binary' case 中各有一份实现，因此三处都要修。
 */
const { executeSQL } = require('../lib/sql.js');
const Database = require('../lib/database.js');

let passed = 0, failed = 0;
function ok(name, cond, got) {
  if (cond) passed++;
  else { failed++; console.log('[FAIL]', name, got !== undefined ? '-> ' + JSON.stringify(got, (k, v) => typeof v === 'bigint' ? String(v) + 'n' : v) : ''); }
}

const B = BigInt(Number.MAX_SAFE_INTEGER) + 1000n;      // 超过 2^53 的 BigInt 字面量
const I64MAX = 9223372036854775807n;

(async () => {
  const db = new Database(':memory:');
  const val = async (sql) => {
    const r = await executeSQL(db, sql, { safety: false });
    return r.rows[0][0];
  };
  const num = (v) => typeof v === 'bigint' ? v : (typeof v === 'string' && /^-?\d+$/.test(v) ? BigInt(v) : v);

  // ---- 1. 一元负号不再塌成 0
  ok('小整数负号仍正常', await val('SELECT -5 AS v') === -5);
  ok('-bigint 字面量不塌成 0', num(await val(`SELECT -${I64MAX} AS v`)) === -I64MAX, await val(`SELECT -${I64MAX} AS v`));

  // ---- 2. 取模 / 整除走 BigInt 精确路径
  ok('bigint % 3 精确', num(await val(`SELECT ${I64MAX} % 3 AS v`)) === I64MAX % 3n);
  ok('bigint DIV 3 精确', num(await val(`SELECT ${I64MAX} DIV 3 AS v`)) === I64MAX / 3n);
  ok('MOD(bigint, 3) 不崩溃', num(await val(`SELECT MOD(${I64MAX}, 3) AS v`)) === I64MAX % 3n);
  ok('普通 % / DIV 不受影响', await val('SELECT 7 % 3 AS v') === 1 && await val('SELECT 7 DIV 2 AS v') === 3 && await val('SELECT -7 DIV 2 AS v') === -3);
  ok('除零仍返回 NULL', await val('SELECT 5 DIV 0 AS v') === null && await val('SELECT 5 % 0 AS v') === null && await val('SELECT MOD(5,0) AS v') === null);

  // ---- 3. 位运算 64 位（此前 (x|0) 截到 32 位）
  ok('大数 & 不再为 0', await val('SELECT 4294967296 & 4294967296 AS v') === 4294967296);
  ok('大数 | 不再为 0', await val('SELECT 8589934592 | 0 AS v') === 8589934592);
  ok('掩码 64 位', await val('SELECT -1 & 4294967295 AS v') === 4294967295);
  ok('<< / >> 保持既有语义', await val('SELECT 1 << 8 AS v') === 256 && await val('SELECT 1 << 40 AS v') === 1099511627776 && await val('SELECT 1099511627776 >> 40 AS v') === 1);
  ok('~0 仍为 -1', await val('SELECT ~0 AS v') === -1);

  // ---- 4. 数值函数不再崩溃 / 不再静默错值
  for (const fn of ['ABS', 'CEIL', 'CEILING', 'FLOOR']) {
    let r;
    try { r = await val(`SELECT ${fn}(-${I64MAX}) AS v`); } catch (e) { r = 'THREW ' + e.message; }
    ok(`${fn}(bigint) 不崩溃`, typeof r !== 'string' || /^-?\d+$/.test(r), r);
    // ABS 取绝对值，CEIL/FLOOR 对已是整数的 BigInt 不变
    ok(`${fn}(-bigint) 值正确`, num(r) === (fn === 'ABS' ? I64MAX : -I64MAX), r);
  }
  ok('ABS(BIGINT_MIN) 不再为 0', num(await val('SELECT ABS(-9223372036854775808) AS v')) === 9223372036854775808n);
  ok('SIGN(bigint) 不再为 0', await val(`SELECT SIGN(${I64MAX}) AS v`) === 1 && await val(`SELECT SIGN(-${I64MAX}) AS v`) === -1);
  ok('SIGN(0) 仍为 0', await val('SELECT SIGN(0) AS v') === 0);
  ok('ROUND(bigint) 不丢精度', num(await val(`SELECT ROUND(${I64MAX}) AS v`)) === I64MAX);
  ok('TRUNCATE(bigint, -2) 精确', num(await val(`SELECT TRUNCATE(${I64MAX}, -2) AS v`)) === (I64MAX / 100n) * 100n);
  ok('TRUNCATE(-bigint, -2) 向零截断', num(await val(`SELECT TRUNCATE(-${I64MAX}, -2) AS v`)) === -((I64MAX / 100n) * 100n));
  ok('SQRT/POW(bigint) 不崩溃', await val('SELECT SQRT(4) AS v') === 2 && await val(`SELECT POW(${I64MAX}, 0) AS v`) === 1);

  // ---- 5. 走真实 BIGINT 列，而非只有字面量
  await executeSQL(db, 'CREATE TABLE big (id INT PRIMARY KEY, bi BIGINT)', { safety: false });
  await executeSQL(db, `INSERT INTO big (id, bi) VALUES (1, ${I64MAX}), (2, 3)`, { safety: false });
  const cell = async (sql) => num((await executeSQL(db, sql, { safety: false })).rows[0][0]);
  ok('BIGINT 列 % 3', await cell('SELECT bi % 3 v FROM big WHERE id = 1') === I64MAX % 3n);
  ok('BIGINT 列 negate', await cell('SELECT -bi v FROM big WHERE id = 1') === -I64MAX);
  ok('BIGINT 列 ABS', await cell('SELECT ABS(bi) v FROM big WHERE id = 1') === I64MAX);
  ok('小整数列不受影响', await cell('SELECT ABS(bi) v FROM big WHERE id = 2') === 3 && await cell('SELECT bi % 3 v FROM big WHERE id = 2') === 0);

  console.log(`\nbigint-arith: ${passed} passed, ${failed} failed`);
  db.stop();
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
