/* ---- BigInt 在数学标量函数与一元负号里的精度回归 ---- */
/*
 * 起点：SELECT -9223372036854775807 静默返回 0。
 * 根因：mysqlNum() 没有 bigint 分支，掉到最后的 `return 0`；negate 又
 * 把所有入参都过一遍 mysqlNum。修完后顺带发现 Math.* 不接受 BigInt
 * （ABS/SQRT/POWER/FLOOR/CEIL/MOD 抛 TypeError），以及「一律降级 number」
 * 会把 MOD(9007199254740993, 2) 算成 0 这种更糟的静默错值。
 *
 * 现在分两类：整数语义函数走 BigInt 精确路径，浮点函数降级为 DOUBLE。
 */
const path = require('path');
const ROOT = path.join(__dirname, '..');
const { Database, executeSQL } = require(path.join(ROOT, 'index.js'));

let pass = 0, fail = 0;
function ok(name, cond, got) {
  if (cond) { pass++; console.log('[OK]   ' + name); }
  else { fail++; console.log('[FAIL] ' + name + ' -> ' + JSON.stringify(got, (k, v) => typeof v === 'bigint' ? v.toString() + 'n' : v)); }
}

(async () => {
  const db = new Database(':memory:', { autoSave: false });
  const q = async (sql) => {
    const r = await executeSQL(db, sql, { safety: false });
    return r.rows[0][0];
  };
  const BIG = '9223372036854775807';          // int64 max
  const ODD = '9007199254740993';             // 2^53 + 1，float64 无法精确表示

  // ---------- 一元负号保精度 ----------
  ok('正的大整数仍精确', await q(`SELECT ${BIG}`) === BIG, null);
  ok('负的大整数精确取负（此前静默变 0）', await q(`SELECT -${BIG}`) === '-' + BIG, null);
  ok('int64 min 取负', await q('SELECT -9223372036854775808') === '-9223372036854775808', null);
  ok('普通负数仍是 number', await q('SELECT -5') === -5, null);
  ok('普通负小数仍是 number', await q('SELECT -1.5') === -1.5, null);

  // ---------- 整数语义的数学函数：BigInt 精确路径 ----------
  ok('ABS 大负数精确', await q(`SELECT ABS(-${BIG})`) === BIG, null);
  ok('ABS 普通负数', await q('SELECT ABS(-5)') === 5, null);
  ok('SIGN 大正数', await q(`SELECT SIGN(${BIG})`) === 1, null);
  ok('SIGN 大负数', await q(`SELECT SIGN(-${BIG})`) === -1, null);
  ok(`MOD(${ODD}, 2) = 1（降级 number 会算成 0）`,
    String(await q(`SELECT MOD(${ODD}, 2)`)) === '1', null);
  ok('MOD 被自身整除 = 0', String(await q(`SELECT MOD(${ODD}, ${ODD})`)) === '0', null);
  ok('FLOOR 大整数不变', String(await q(`SELECT FLOOR(${ODD})`)) === ODD, null);
  ok('CEIL 大整数不变', String(await q(`SELECT CEIL(${ODD})`)) === ODD, null);
  ok('POWER 大整数指数 1 精确', String(await q(`SELECT POWER(${ODD}, 1)`)) === ODD, null);
  ok('MOD 除零仍 NULL', await q('SELECT MOD(5, 0)') === null, null);

  // ---------- 浮点运算：降级 DOUBLE，不抛错也不静默给 0 ----------
  const sq = await q(`SELECT SQRT(${ODD})`);
  ok('SQRT 大整数返回有限数值', typeof sq === 'number' && Number.isFinite(sq) && sq > 0, sq);
  const lg = await q(`SELECT LOG(${ODD})`);
  ok('LOG 大整数不再抛 TypeError', lg === null || (typeof lg === 'number' && Number.isFinite(lg)), lg);
  ok('#65 SQRT(-1) 仍返回 NULL', await q('SELECT SQRT(-1)') === null, null);
  ok('#65 POWER(-2,0.5) 仍返回 NULL', await q('SELECT POWER(-2,0.5)') === null, null);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => {
  console.log('[FAIL] unexpected exception: ' + e.stack.split('\n').slice(0, 3).join('\n'));
  process.exit(1);
});
