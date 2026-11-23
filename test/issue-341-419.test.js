/*
 * #341 #344 #390 #419 回归测试（SQL 解析 / 语义）。
 *
 * 全部走公共 API：Database.query / executeSQL（与既有 issue-*.test.js 同一入口）。
 *
 *   #341  `--` 注释 opener 按 MySQL 口径要求后跟空白/控制字符/行尾；
 *         `1--5` 是 1 - (-5) = 6，不是注释。
 *   #344  窗口帧简写（只给起始 bound）缺省结束 bound 为 CURRENT ROW，
 *         与 ROWS BETWEEN <start> AND CURRENT ROW 等价。
 *   #390  INSERT ... SELECT 无目标列清单时按位置映射到目标表列；
 *         列数不符按 MySQL 报 1136。
 *   #419  限定星号 `o.*` 只展开该表（或其别名）的列，不再把右表列一并投影。
 *
 * 注：#342 经复核，投影后的裸标识符是 MySQL 合法别名（AS 可省略），
 * 与残留 token 在词法上无法区分，故不收紧；合法别名写法继续保留。
 */
const assert = require('assert');
const { Database } = require('../index.js');

let passed = 0, failed = 0;
async function t(name, fn) {
  try { await fn(); passed++; console.log(`ok - ${name}`); }
  catch (e) { failed++; console.error(`not ok - ${name}\n  ${e && e.message}`); }
}

(async () => {
  // #341：`--` 后必须是空白/控制字符/行尾才构成注释
  await t('#341 `1--5` 按减号解析为 6（不是注释）', async () => {
    const db = new Database(':memory:');
    const r = await db.query('SELECT 1--5 AS x', { safety: false });
    assert.deepStrictEqual(r.rows, [[6]]);
    assert.strictEqual(r.columns[0], 'x');
    await db.close();
  });

  await t('#341 `-- ` 带空白仍是行注释', async () => {
    const db = new Database(':memory:');
    const r = await db.query('SELECT 1 -- 5', { safety: false });
    assert.deepStrictEqual(r.rows, [[1]]);
    await db.close();
  });

  // 合法别名写法必须继续工作（#342 复核：裸 ident 是 MySQL 合法别名）
  await t('合法别名：AS 显式别名 / 裸 ident 别名', async () => {
    const db = new Database(':memory:');
    const r1 = await db.query('SELECT 1 AS x', { safety: false });
    assert.deepStrictEqual(r1.rows, [[1]]);
    assert.strictEqual(r1.columns[0], 'x');
    const r2 = await db.query('SELECT 1 x', { safety: false });
    assert.deepStrictEqual(r2.rows, [[1]]);
    assert.strictEqual(r2.columns[0], 'x');
    await db.close();
  });

  await t('残留非别名 token 仍报语法错误', async () => {
    const db = new Database(':memory:');
    await assert.rejects(() => db.query('SELECT 1 2', { safety: false }), /Unexpected token|syntax/i);
    await assert.rejects(() => db.query('SELECT 1 WHERE 1 = 1 junk', { safety: false }), /Unexpected token|syntax/i);
    await db.close();
  });

  // #344：简写帧 ROWS UNBOUNDED PRECEDING 缺省 AND CURRENT ROW（累计求和）
  await t('#344 简写窗口帧累计求和 10/50/70/120/150', async () => {
    const db = new Database(':memory:');
    await db.query('CREATE TABLE w (a INT, v INT)', { safety: false });
    await db.query('INSERT INTO w VALUES (1,10),(2,40),(3,20),(4,50),(5,30)', { safety: false });
    const r = await db.query(
      'SELECT a, v, SUM(v) OVER (ORDER BY a ROWS UNBOUNDED PRECEDING) s FROM w ORDER BY a',
      { safety: false });
    assert.deepStrictEqual(r.rows, [[1, 10, 10], [2, 40, 50], [3, 20, 70], [4, 50, 120], [5, 30, 150]]);
    await db.close();
  });

  await t('#344 显式 BETWEEN ... AND CURRENT ROW 与简写帧结果一致', async () => {
    const db = new Database(':memory:');
    await db.query('CREATE TABLE w2 (a INT, v INT)', { safety: false });
    await db.query('INSERT INTO w2 VALUES (1,10),(2,40),(3,20),(4,50),(5,30)', { safety: false });
    const r = await db.query(
      'SELECT a, v, SUM(v) OVER (ORDER BY a ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) s FROM w2 ORDER BY a',
      { safety: false });
    assert.deepStrictEqual(r.rows, [[1, 10, 10], [2, 40, 50], [3, 20, 70], [4, 50, 120], [5, 30, 150]]);
    await db.close();
  });

  // #390：INSERT ... SELECT 按位置映射，表达式列正确落库
  await t('#390 INSERT...SELECT 表达式列按位置写入', async () => {
    const db = new Database(':memory:');
    await db.query('CREATE TABLE t (a INT, b INT)', { safety: false });
    await db.query('INSERT INTO t VALUES (1,10),(2,20)', { safety: false });
    await db.query('INSERT INTO t SELECT a+100, b FROM t', { safety: false });
    const r = await db.query('SELECT a, b FROM t ORDER BY a, b', { safety: false });
    assert.deepStrictEqual(r.rows, [[1, 10], [2, 20], [101, 10], [102, 20]]);
    await db.close();
  });

  await t('#390 SELECT 列数多于目标表列报 1136', async () => {
    const db = new Database(':memory:');
    await db.query('CREATE TABLE t2 (a INT, b INT)', { safety: false });
    await db.query('INSERT INTO t2 VALUES (1,10)', { safety: false });
    await assert.rejects(
      () => db.query('INSERT INTO t2 SELECT a, b, a FROM t2', { safety: false }),
      /1136|Column count|value count/i);
    await db.close();
  });

  // #419：限定星号只展开本表列
  await t('#419 SELECT o.* 只投影 o 表列', async () => {
    const db = new Database(':memory:');
    await db.query('CREATE TABLE o (id INT, cid INT, v INT)', { safety: false });
    await db.query('CREATE TABLE c (cid INT, name VARCHAR(10))', { safety: false });
    await db.query('INSERT INTO o VALUES (1,1,100),(2,2,200)', { safety: false });
    await db.query("INSERT INTO c VALUES (1,'a')", { safety: false });
    const r = await db.query('SELECT o.* FROM o JOIN c ON o.cid = c.cid', { safety: false });
    assert.deepStrictEqual(r.columns, ['o.id', 'o.cid', 'o.v']);
    assert.ok(!r.columns.some((k) => k.startsWith('c.')), '不应投影右表 c 的列');
    assert.deepStrictEqual(r.rows, [[1, 1, 100]]);
    await db.close();
  });

  await t('#419 裸 SELECT * 仍展开全部连接表列（回归保护）', async () => {
    const db = new Database(':memory:');
    await db.query('CREATE TABLE o2 (id INT, cid INT, v INT)', { safety: false });
    await db.query('CREATE TABLE c2 (cid INT, name VARCHAR(10))', { safety: false });
    await db.query('INSERT INTO o2 VALUES (1,1,100)', { safety: false });
    await db.query("INSERT INTO c2 VALUES (1,'a')", { safety: false });
    const r = await db.query('SELECT * FROM o2 JOIN c2 ON o2.cid = c2.cid', { safety: false });
    assert.ok(r.columns.some((k) => k.endsWith('.v')), '裸 * 仍应含左表 v 列');
    assert.ok(r.columns.some((k) => k.endsWith('.name')), '裸 * 仍应含右表 name 列');
    await db.close();
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
