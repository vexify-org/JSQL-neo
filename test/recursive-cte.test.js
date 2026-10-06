/*
 * 递归 CTE（WITH RECURSIVE）测试。
 *
 * 此前解析层能识别（recursive:true、UNION ALL 结构都对），
 * 但执行时把 CTE 的自身引用内联成子查询，导致报 no such column；
 * 修好后又暴露三个问题，逐个都曾让结果错误：
 *   1. 虚拟行被加了表名前缀 → 递归项里的 `n+1` 取不到值
 *   2. 每轮把全部累积行喂回递归项 → 行数按轮递增（1..5 得到 1,2,2,3,2,3,…）
 *   3. 只限制迭代次数不够，行数翻倍会先打爆内存（实测 OOM）
 */
const path = require('path');

const ROOT = path.join(__dirname, '..');
const { Database, JSQL, NativeJSQL } = require(path.join(ROOT, 'index.js'));
const { executeSQL } = require(path.join(ROOT, 'lib/sql.js'));
const { parseSQL } = require(path.join(ROOT, 'lib/sql.js'));

const OPTS = { safety: false };
let pass = 0, fail = 0;

function ok(name, cond, extra) {
  if (cond) { pass++; console.log('[OK]  ', name); }
  else { fail++; console.log('[FAIL]', name, extra !== undefined ? '-> ' + JSON.stringify(extra).slice(0, 120) : ''); }
}
const rowsOf = r => (Array.isArray(r) ? r[0] : r).rows;
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** 每个用例独立 :memory: 库，避免状态污染 */
async function t(name, sql, expect, engineName) {
  const db = engineName === 'JSQL' ? new JSQL({ mode: 'memory' })
    : engineName === 'NativeJSQL' ? new NativeJSQL({ mode: 'memory' })
      : new Database(':memory:');
  try {
    if (db.start) await db.start();
    const got = rowsOf(await executeSQL(db, sql, OPTS));
    if (eq(got, expect)) ok(name, true);
    else ok(name, false, { got, expect });
  } catch (e) {
    ok(name, false, String(e.message || e).slice(0, 100));
  } finally {
    try { await db.stop(); } catch (_) { /* ignore */ }
  }
}

(async () => {
  console.log('\n--- 解析 ---');
  {
    const a = parseSQL('WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM c WHERE n<5) SELECT * FROM c');
    ok('识别 RECURSIVE', a.recursive === true, a.recursive);
    ok('记录显式列名', JSON.stringify(a.ctes[0].columns) === '["n"]', a.ctes[0].columns);
    ok('记录 UNION ALL', a.ctes[0].select.union && a.ctes[0].select.union.all === true);
    // RECURSIVE 放在第一个 CTE 之后也接受
    const b = parseSQL('WITH k AS (SELECT 1 AS m), RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM c WHERE n<3) SELECT * FROM c');
    ok('CTE 之间的 RECURSIVE 也能解析', b.ctes.length === 2, b.ctes.length);
  }

  console.log('\n--- 基本递归 ---');
  await t('计数 1..5', 'WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM c WHERE n<5) SELECT * FROM c',
    [[1], [2], [3], [4], [5]]);
  await t('1..10 求和 = 55', 'WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM c WHERE n<10) SELECT SUM(n) AS s FROM c',
    [[55]]);
  await t('倒计数 3..1', 'WITH RECURSIVE c(n) AS (SELECT 3 UNION ALL SELECT n-1 FROM c WHERE n>1) SELECT * FROM c',
    [[3], [2], [1]]);
  await t('显式列名 + 外层过滤',
    'WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c WHERE x<3) SELECT * FROM c WHERE x>1',
    [[2], [3]]);
  await t('UNION（去重）终止',
    'WITH RECURSIVE c(n) AS (SELECT 1 UNION SELECT 1 FROM c WHERE n<3) SELECT * FROM c',
    [[1]]);
  await t('多列递归',
    'WITH RECURSIVE c(a,b) AS (SELECT 1,1 UNION ALL SELECT a+1,b+a FROM c WHERE a<4) SELECT * FROM c',
    [[1, 1], [2, 2], [3, 4], [4, 7]]);
  await t('外层聚合递归结果',
    'WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM c WHERE n<4) SELECT COUNT(*) AS k, MAX(n) AS mx FROM c',
    [[4, 4]]);
  await t('多锚点分支（UNION 链 > 2 节）',
    'WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT n+1 FROM c WHERE n<3) SELECT * FROM c',
    [[1], [2], [2], [3], [3]]);
  await t('日期序列',
    `WITH RECURSIVE d(x) AS (SELECT DATE('2026-01-01') UNION ALL SELECT DATE_ADD(x, INTERVAL 1 DAY) FROM d WHERE x < DATE('2026-01-04')) SELECT * FROM d`,
    [['2026-01-01'], ['2026-01-02'], ['2026-01-03'], ['2026-01-04']]);
  await t('递归 CTE 与普通 JOIN',
    'WITH c(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM c WHERE n<3) SELECT c1.n, c2.n FROM c c1, c c2 WHERE c2.n = c1.n + 1 ORDER BY c1.n',
    [[1, 2], [2, 3]]);
  await t('递归 CTE 可被外层引用多次',
    'WITH c(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM c WHERE n<3) SELECT (SELECT COUNT(*) FROM c) AS a, (SELECT MAX(n) FROM c) AS b',
    [[3, 3]]);

  console.log('\n--- 安全性：无限递归必须有兜底 ---');
  {
    const db = new Database(':memory:');
    const t0 = Date.now();
    let got = null, err = null;
    try {
      // WHERE 恒真 → 无限增长
      got = rowsOf(await executeSQL(db, 'WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM c) SELECT COUNT(*) AS k FROM c', OPTS));
    } catch (e) { err = e; }
    ok('无限递归不 OOM、不挂死（有限时间内返回）', err !== null || (got && got[0][0] > 0), err ? String(err.message).slice(0, 60) : got);
    ok('兜底在 30s 内返回', Date.now() - t0 < 30000, ((Date.now() - t0) / 1000).toFixed(1) + 's');
    await db.stop();
  }

  console.log('\n--- 非递归 CTE 回归对照 ---');
  await t('普通 CTE 不受影响', 'WITH x AS (SELECT 1 AS n) SELECT * FROM x', [[1]]);
  await t('普通 CTE 引用前一个',
    'WITH a AS (SELECT 1 AS m), b AS (SELECT m+1 AS n FROM a) SELECT * FROM b', [[2]]);
  await t('普通 CTE 显式列名',
    'WITH x(q) AS (SELECT 5) SELECT q FROM x', [[5]]);
  await t('非递归 UNION ALL 正常',
    'SELECT 1 AS n UNION ALL SELECT 2', [[1], [2]]);
  await t('UNION 去重正常', 'SELECT 1 AS n UNION SELECT 1', [[1]]);
  await t('INTERSECT / EXCEPT 正常',
    'SELECT 1 AS n UNION SELECT 2 INTERSECT SELECT 1', [[1]]);

  console.log('\n--- 三个 engine 一致性 ---');
  for (const eng of ['JSQL', 'NativeJSQL', 'Database']) {
    await t(`${eng} 递归 CTE`, 'WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM c WHERE n<4) SELECT * FROM c',
      [[1], [2], [3], [4]], eng);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
