/*
 * Regression tests for issues #101 / #102 / #103.
 *
 *   node test/issue-101-103.test.js
 *
 * #101 自连接：左表未起别名、SQL 里用原表名（t.col）引用列
 *      → INNER JOIN 必须返回匹配行，LEFT JOIN 必须保留左表行
 * #102 窗口函数 PERCENT_RANK() / CUME_DIST() 此前落到 default 分支恒返回 NULL
 * #103 窗口函数 ORDER BY col DESC 的 NULL 排序必须与普通 ORDER BY 一致
 */
const path = require('path');

const ROOT = path.join(__dirname, '..');
const Database = require(path.join(ROOT, 'lib/database'));
const { executeSQL } = require(path.join(ROOT, 'lib/sql'));

let passed = 0, failed = 0;
function ok(name, cond, extra) {
  if (cond) { passed++; console.log('[OK]', name); }
  else { failed++; console.log('[FAIL]', name, extra !== undefined ? '-> ' + JSON.stringify(extra) : ''); }
}
function eq(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

function near(a, b) { return typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) < 1e-9; }

(async () => {
  /* ===================== #101 自连接 ===================== */
  {
    const db = new Database(':memory:', { autoSave: false });
    await executeSQL(db, 'CREATE TABLE t (id INT, v INT)');
    await executeSQL(db, 'INSERT INTO t VALUES (1,10),(2,20),(3,30)');
    const q = sql => executeSQL(db, sql);

    let r = await q('SELECT t.id, b.id AS bid FROM t JOIN t b ON t.id = b.id ORDER BY t.id');
    ok('#101 INNER 自连接（左表用原表名限定）返回匹配行',
      eq(r.rows, [[1, 1], [2, 2], [3, 3]]), r.rows);

    r = await q('SELECT t.id, b.id AS bid FROM t LEFT JOIN t b ON t.id = b.id ORDER BY t.id');
    ok('#101 LEFT 自连接（左表用原表名限定）左表行保留且不全是 NULL',
      eq(r.rows, [[1, 1], [2, 2], [3, 3]]), r.rows);

    r = await q('SELECT t.id, b.v AS bv FROM t JOIN t b ON t.id = b.id - 1 ORDER BY t.id');
    ok('#101 自连接 ON 条件不对称（b.id = t.id + 1）',
      eq(r.rows, [[1, 20], [2, 30]]), r.rows);

    r = await q('SELECT t.id, b.id AS bid FROM t LEFT JOIN t b ON t.id = b.id - 1 ORDER BY t.id');
    ok('#101 LEFT 自连接存在未匹配行时右侧补 NULL',
      eq(r.rows, [[1, 2], [2, 3], [3, null]]), r.rows);

    // 双侧显式别名仍然正常
    r = await q('SELECT a.id, b.id AS bid FROM t a JOIN t b ON a.id = b.id ORDER BY a.id');
    ok('#101 双侧都起别名不受影响', eq(r.rows, [[1, 1], [2, 2], [3, 3]]), r.rows);

    // 左表别名 + 右表原表名
    r = await q('SELECT a.id, t.id AS tid FROM t a JOIN t ON a.id = t.id ORDER BY a.id');
    ok('#101 左表别名 + 右表用原表名', eq(r.rows, [[1, 1], [2, 2], [3, 3]]), r.rows);

    // 同名表三实例：第一实例用表名，后面用自动别名
    r = await q('SELECT t.id FROM t JOIN t b ON t.id = b.id JOIN t c ON t.id = c.id ORDER BY t.id');
    ok('#101 三个自连接实例', eq(r.rows, [[1], [2], [3]]), r.rows);

    // 非自连接的表名限定引用不该受影响
    await executeSQL(db, 'CREATE TABLE u (id INT, t_id INT)');
    await executeSQL(db, 'INSERT INTO u VALUES (7,2),(8,3)');
    r = await q('SELECT t.id, u.id AS uid FROM t JOIN u ON u.t_id = t.id ORDER BY t.id');
    ok('#101 普通 JOIN 不受影响', eq(r.rows, [[2, 7], [3, 8]]), r.rows);
  }

  /* ===================== #102 PERCENT_RANK / CUME_DIST ===================== */
  {
    const db = new Database(':memory:', { autoSave: false });
    await executeSQL(db, 'CREATE TABLE w (id INT, g TEXT, v INT)');
    await executeSQL(db, "INSERT INTO w VALUES (1,'a',10),(2,'a',20),(3,'a',20),(4,'a',30),(5,'b',5)");
    const q = sql => executeSQL(db, sql);

    let r = await q("SELECT id, PERCENT_RANK() OVER (PARTITION BY g ORDER BY v) AS pr FROM w WHERE g='a' ORDER BY id");
    ok('#102 PERCENT_RANK 含并列值',
      eq(r.rows, [[1, 0], [2, 1 / 3], [3, 1 / 3], [4, 1]]), r.rows);

    r = await q("SELECT id, CUME_DIST() OVER (PARTITION BY g ORDER BY v) AS cd FROM w WHERE g='a' ORDER BY id");
    ok('#102 CUME_DIST 含并列值',
      eq(r.rows, [[1, 0.25], [2, 0.75], [3, 0.75], [4, 1]]), r.rows);

    // 多分区
    r = await q('SELECT id, PERCENT_RANK() OVER (PARTITION BY g ORDER BY v) AS pr FROM w ORDER BY g, id');
    ok('#102 PERCENT_RANK 多分区（b 分区单行 → 0）',
      eq(r.rows, [[1, 0], [2, 1 / 3], [3, 1 / 3], [4, 1], [5, 0]]), r.rows);

    r = await q('SELECT id, CUME_DIST() OVER (PARTITION BY g ORDER BY v) AS cd FROM w ORDER BY g, id');
    ok('#102 CUME_DIST 多分区（b 分区单行 → 1）',
      eq(r.rows, [[1, 0.25], [2, 0.75], [3, 0.75], [4, 1], [5, 1]]), r.rows);

    // 单行分区
    await executeSQL(db, 'CREATE TABLE s1 (id INT, v INT)');
    await executeSQL(db, 'INSERT INTO s1 VALUES (1, 42)');
    r = await q('SELECT PERCENT_RANK() OVER (ORDER BY v) AS pr, CUME_DIST() OVER (ORDER BY v) AS cd FROM s1');
    ok('#102 单行分区：PERCENT_RANK=0，CUME_DIST=1（无除零）',
      eq(r.rows, [[0, 1]]), r.rows);

    // 全同值
    await executeSQL(db, 'CREATE TABLE same (id INT, v INT)');
    await executeSQL(db, 'INSERT INTO same VALUES (1,5),(2,5),(3,5)');
    r = await q('SELECT id, PERCENT_RANK() OVER (ORDER BY v) AS pr, CUME_DIST() OVER (ORDER BY v) AS cd FROM same ORDER BY id');
    ok('#102 全同值：PERCENT_RANK 全 0，CUME_DIST 全 1',
      eq(r.rows, [[1, 0, 1], [2, 0, 1], [3, 0, 1]]), r.rows);

    // 乱序插入
    await executeSQL(db, 'CREATE TABLE unsorted (id INT, v INT)');
    await executeSQL(db, 'INSERT INTO unsorted VALUES (1,30),(2,10),(3,20),(4,40)');
    r = await q('SELECT id, PERCENT_RANK() OVER (ORDER BY v) AS pr, CUME_DIST() OVER (ORDER BY v) AS cd FROM unsorted ORDER BY id');
    ok('#102 乱序插入',
      eq(r.rows, [[1, 2 / 3, 0.75], [2, 0, 0.25], [3, 1 / 3, 0.5], [4, 1, 1]]), r.rows);

    // NULL 值（NULL 属于同一 peer 组；ASC 时 NULL 排最前）
    await executeSQL(db, 'CREATE TABLE withnull (id INT, v INT)');
    await executeSQL(db, 'INSERT INTO withnull VALUES (1,NULL),(2,10),(3,NULL),(4,20)');
    r = await q('SELECT id, PERCENT_RANK() OVER (ORDER BY v) AS pr, CUME_DIST() OVER (ORDER BY v) AS cd FROM withnull ORDER BY id');
    ok('#102 含 NULL：NULL 视为同一组，ASC 排最前',
      eq(r.rows, [[1, 0, 0.5], [2, 2 / 3, 0.75], [3, 0, 0.5], [4, 1, 1]]), r.rows);

    // 无 ORDER BY：全部互为 peer
    r = await q('SELECT id, PERCENT_RANK() OVER () AS pr, CUME_DIST() OVER () AS cd FROM unsorted ORDER BY id');
    ok('#102 无 ORDER BY：PERCENT_RANK=0 / CUME_DIST=1',
      eq(r.rows, [[1, 0, 1], [2, 0, 1], [3, 0, 1], [4, 0, 1]]), r.rows);

    // 与 RANK 的一致性：PR = (RANK-1)/(n-1)
    r = await q('SELECT id, RANK() OVER (ORDER BY v) AS rk, PERCENT_RANK() OVER (ORDER BY v) AS pr FROM unsorted ORDER BY id');
    ok('#102 PERCENT_RANK == (RANK-1)/(n-1)',
      r.rows.every(([, rk, pr]) => near(pr, (rk - 1) / 3)), r.rows);
  }

  /* ===================== #103 窗口 ORDER BY DESC 的 NULL 排序 ===================== */
  {
    const db = new Database(':memory:', { autoSave: false });
    await executeSQL(db, 'CREATE TABLE n (id INT, v INT)');
    await executeSQL(db, 'INSERT INTO n VALUES (1,10),(2,NULL),(3,30),(4,NULL),(5,20)');
    const q = sql => executeSQL(db, sql);

    // 普通 ORDER BY 的基准行为：ASC → NULL 最前；DESC → NULL 最后
    let r = await q('SELECT id, v FROM n ORDER BY v ASC, id');
    ok('#103 基线：普通 ORDER BY ASC NULL 在前',
      eq(r.rows, [[2, null], [4, null], [1, 10], [5, 20], [3, 30]]), r.rows);

    r = await q('SELECT id, v FROM n ORDER BY v DESC, id');
    ok('#103 基线：普通 ORDER BY DESC NULL 在后',
      eq(r.rows, [[3, 30], [5, 20], [1, 10], [2, null], [4, null]]), r.rows);

    // ROW_NUMBER：DESC 时 NULL 应拿最后的名次
    r = await q('SELECT id, ROW_NUMBER() OVER (ORDER BY v DESC, id) AS rn FROM n ORDER BY id');
    ok('#103 ROW_NUMBER OVER (ORDER BY v DESC) NULL 拿到最后名次',
      eq(r.rows, [[1, 3], [2, 4], [3, 1], [4, 5], [5, 2]]), r.rows);

    r = await q('SELECT id, ROW_NUMBER() OVER (ORDER BY v ASC, id) AS rn FROM n ORDER BY id');
    ok('#103 ROW_NUMBER OVER (ORDER BY v ASC) NULL 拿到最前名次',
      eq(r.rows, [[1, 3], [2, 1], [3, 5], [4, 2], [5, 4]]), r.rows);

    // LAG / LEAD 跟随同一排序
    r = await q('SELECT id, LAG(v) OVER (ORDER BY v DESC) AS lg FROM n ORDER BY id');
    ok('#103 LAG OVER (ORDER BY v DESC) 与普通 DESC 顺序一致',
      eq(r.rows, [[1, 20], [2, 10], [3, null], [4, null], [5, 30]]), r.rows);

    r = await q('SELECT id, LEAD(v) OVER (ORDER BY v DESC) AS ld FROM n ORDER BY id');
    ok('#103 LEAD OVER (ORDER BY v DESC) 与普通 DESC 顺序一致',
      eq(r.rows, [[1, null], [2, null], [3, 20], [4, null], [5, 10]]), r.rows);

    // RANK / DENSE_RANK：两个 NULL 并列，且排在最后
    r = await q('SELECT id, RANK() OVER (ORDER BY v DESC) AS rk, DENSE_RANK() OVER (ORDER BY v DESC) AS dr FROM n ORDER BY id');
    ok('#103 RANK/DENSE_RANK DESC：NULL 并列且排在最后',
      eq(r.rows, [[1, 3, 3], [2, 4, 4], [3, 1, 1], [4, 4, 4], [5, 2, 2]]), r.rows);

    r = await q('SELECT id, RANK() OVER (ORDER BY v ASC) AS rk, DENSE_RANK() OVER (ORDER BY v ASC) AS dr FROM n ORDER BY id');
    ok('#103 RANK/DENSE_RANK ASC：NULL 并列且排在最前',
      eq(r.rows, [[1, 3, 2], [2, 1, 1], [3, 5, 4], [4, 1, 1], [5, 4, 3]]), r.rows);

    // 累计帧（SUM OVER ORDER BY DESC）也要走同一排序
    r = await q('SELECT id, SUM(v) OVER (ORDER BY v DESC ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS s FROM n ORDER BY id');
    ok('#103 SUM OVER (ORDER BY v DESC) 累计帧：NULL 在最后且被 SUM 忽略',
      eq(r.rows, [[1, 60], [2, 60], [3, 30], [4, 60], [5, 50]]), r.rows);

    // 多分区 + DESC + NULL
    await executeSQL(db, 'CREATE TABLE p (id INT, g TEXT, v INT)');
    await executeSQL(db, "INSERT INTO p VALUES (1,'a',10),(2,'a',NULL),(3,'b',20),(4,'b',NULL),(5,'b',30)");
    r = await q('SELECT id, ROW_NUMBER() OVER (PARTITION BY g ORDER BY v DESC, id) AS rn FROM p ORDER BY id');
    ok('#103 PARTITION BY + DESC：每个分区内 NULL 都排最后',
      eq(r.rows, [[1, 1], [2, 2], [3, 2], [4, 3], [5, 1]]), r.rows);

    // NULL 在首/中/尾三种位置都覆盖
    await executeSQL(db, 'CREATE TABLE mix (id INT, v INT)');
    await executeSQL(db, 'INSERT INTO mix VALUES (1,NULL),(2,5),(3,NULL),(4,10),(5,NULL)');
    r = await q('SELECT id, ROW_NUMBER() OVER (ORDER BY v DESC, id) AS rn FROM mix ORDER BY id');
    ok('#103 NULL 在首/中/尾：DESC 时全部聚在尾部',
      eq(r.rows, [[1, 3], [2, 2], [3, 4], [4, 1], [5, 5]]), r.rows);

    r = await q('SELECT id, ROW_NUMBER() OVER (ORDER BY v ASC, id) AS rn FROM mix ORDER BY id');
    ok('#103 NULL 在首/中/尾：ASC 时全部聚在头部',
      eq(r.rows, [[1, 1], [2, 4], [3, 2], [4, 5], [5, 3]]), r.rows);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})().catch(e => {
  console.error('[FATAL]', e && e.stack || e);
  process.exit(1);
});
