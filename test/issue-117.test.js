/* ---- Issue #117：MATH_SCALAR_FNS 里声明的 15 个数学函数必须真正求值 ---- */
/*
 * LOG / LOG10 / LOG2 / LN / EXP / SIN / COS / TAN / ASIN / ACOS / ATAN /
 * ATAN2 / DEGREES / RADIANS / COT 此前在 applyScalarFunction 里没有 case
 * 分支，落到 default 静默返回 NULL。
 *
 * MySQL 8.0 语义：
 *   - 任一参数为 NULL → NULL；
 *   - 定义域外（LOG(0)、LN(-1)、ASIN(2)、LOG(1, x)…）→ NULL；
 *   - LOG(X) 为自然对数，LOG(B, X) 为以 B 为底；ATAN(Y, X) 等同 ATAN2(Y, X)。
 *
 *   node test/issue-117.test.js
 */
const path = require('path');
const ROOT = path.join(__dirname, '..');
const { Database, executeSQL } = require(path.join(ROOT, 'index.js'));

let pass = 0, fail = 0;
function ok(name, cond, got) {
  if (cond) { pass++; console.log('[OK]   ' + name); }
  else { fail++; console.log('[FAIL] ' + name + ' -> ' + JSON.stringify(got)); }
}
const near = (a, b) => typeof a === 'number' && Math.abs(a - b) < 1e-12;

(async () => {
  const db = new Database(':memory:', { autoSave: false });
  const q = async (sql) => {
    const r = await executeSQL(db, sql, { safety: false });
    return r.rows[0][0];
  };
  const eq = async (expr, want) => {
    const got = await q('SELECT ' + expr);
    ok(`${expr} = ${want}`, want === null ? got === null : near(got, want), got);
  };

  // ---------- issue 里的复现语句 ----------
  {
    const r = await executeSQL(db,
      'SELECT LOG2(8), LOG10(100), LN(1), EXP(0), SIN(0), COS(0), TAN(0), DEGREES(3.141592653589793), RADIANS(180)',
      { safety: false });
    const want = [3, 2, 0, 1, 0, 1, 0, 180, Math.PI];
    ok('issue 复现语句', r.rows[0].length === want.length && r.rows[0].every((v, i) => near(v, want[i])), r.rows[0]);
  }

  // ---------- 每个函数的取值 ----------
  await eq('LOG(EXP(1))', 1);
  await eq('LOG(2, 8)', 3);
  await eq('LOG(10, 1000)', 3);
  await eq('LN(EXP(2))', 2);
  await eq('LOG10(1000)', 3);
  await eq('LOG2(1024)', 10);
  await eq('EXP(1)', Math.E);
  await eq('SIN(1.5707963267948966)', 1);
  await eq('COS(3.141592653589793)', -1);
  await eq('TAN(0.7853981633974483)', Math.tan(Math.PI / 4));
  await eq('COT(1)', 1 / Math.tan(1));
  await eq('ASIN(1)', Math.PI / 2);
  await eq('ACOS(1)', 0);
  await eq('ATAN(1)', Math.PI / 4);
  await eq('ATAN(1, 1)', Math.PI / 4);
  await eq('ATAN(-1, -1)', Math.atan2(-1, -1));
  await eq('ATAN2(1, 1)', Math.PI / 4);
  await eq('ATAN2(1, 0)', Math.PI / 2);
  await eq('DEGREES(3.141592653589793)', 180);
  await eq('RADIANS(90)', Math.PI / 2);
  await eq("EXP('0')", 1);

  // ---------- 定义域外 → NULL（不能漏出 NaN / Infinity）----------
  await eq('LOG(0)', null);
  await eq('LN(-1)', null);
  await eq('LOG10(0)', null);
  await eq('LOG2(-8)', null);
  await eq('LOG(1, 8)', null);
  await eq('LOG(-2, 8)', null);
  await eq('LOG(2, 0)', null);
  await eq('ASIN(2)', null);
  await eq('ACOS(-1.5)', null);
  await eq('COT(0)', null);
  await eq('EXP(1000)', null);

  // ---------- NULL 传播 ----------
  for (const expr of ['LOG(NULL)', 'LOG(NULL, 8)', 'LOG(2, NULL)', 'LN(NULL)', 'LOG10(NULL)', 'LOG2(NULL)',
    'EXP(NULL)', 'SIN(NULL)', 'COS(NULL)', 'TAN(NULL)', 'COT(NULL)', 'ASIN(NULL)', 'ACOS(NULL)',
    'ATAN(NULL)', 'ATAN(1, NULL)', 'ATAN2(NULL, 1)', 'ATAN2(1, NULL)', 'DEGREES(NULL)', 'RADIANS(NULL)']) {
    await eq(expr, null);
  }

  // ---------- BigInt 入参降级为 number（issue #38 的路径）----------
  await eq('LOG2(9007199254740993)', 53);

  // ---------- 用在表数据上 ----------
  await executeSQL(db, 'CREATE TABLE m (id INT, x DOUBLE)', { safety: false });
  await executeSQL(db, 'INSERT INTO m VALUES (1, 100), (2, 0), (3, NULL)', { safety: false });
  const rows = (await executeSQL(db, 'SELECT id, LOG10(x) AS l FROM m ORDER BY id', { safety: false })).rows;
  ok('LOG10 列计算：[2, NULL, NULL]', JSON.stringify(rows.map(r => r[1])) === '[2,null,null]', rows);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => {
  console.log('[FAIL] unexpected exception: ' + e.stack.split('\n').slice(0, 3).join('\n'));
  process.exit(1);
});
