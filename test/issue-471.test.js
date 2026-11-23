/*
 * #471 回归测试：标量子查询返回多列必须报 1241（ER_OPERAND_COLUMNS）。
 *
 * MySQL 行为：
 *   SELECT (SELECT a, b FROM t)  → ERROR 1241 Operand should contain 1 column(s)
 * 此前实现只取 rows[0][0]，多余列被静默丢弃（`#258` 只覆盖了多行 → 1242）。
 *
 * 同时确认没有误伤多值上下文：IN / EXISTS / = ANY 子查询允许（不校验列数）。
 *
 *   node test/issue-471.test.js
 */
const assert = require('assert');
const path = require('path');
const { Database } = require(path.join(__dirname, '..', 'index.js'));

let passed = 0, failed = 0;
async function t(name, fn) {
  try { await fn(); passed++; console.log(`ok - ${name}`); }
  catch (e) { failed++; console.error(`not ok - ${name}\n  ${e && e.message}`); }
}

const q = (db, sql) => db.query(sql, { safety: false });

async function codeOf(db, sql) {
  try { await q(db, sql); return null; } catch (e) { return e && e.code; }
}

(async () => {
  // #471 主场景：SELECT 列表里的多列标量子查询（issue 原文复现）
  await t('#471 多列标量子查询 → 1241（issue 复现）', async () => {
    const db = new Database(':memory:');
    await q(db, 'CREATE TABLE a (id INT, dept TEXT, sal INT)');
    await q(db, "INSERT INTO a VALUES (1,'x',100)");
    const code = await codeOf(db, 'SELECT id, (SELECT dept, sal FROM a WHERE id=1) s FROM a WHERE id=1');
    assert.strictEqual(code, 1241);
    await db.close();
  });

  await t('#471 1241 错误消息与 MySQL 一致', async () => {
    const db = new Database(':memory:');
    await q(db, 'CREATE TABLE a (id INT, dept TEXT, sal INT)');
    await q(db, "INSERT INTO a VALUES (1,'x',100)");
    let err = null;
    try { await q(db, 'SELECT (SELECT dept, sal FROM a WHERE id=1) AS s'); } catch (e) { err = e; }
    assert.ok(err, 'expected error');
    assert.strictEqual(err.code, 1241);
    assert.strictEqual(err.message, 'Operand should contain 1 column(s)');
    await db.close();
  });

  await t('#471 空结果集的多列标量子查询同样 → 1241（编译期语义）', async () => {
    const db = new Database(':memory:');
    await q(db, 'CREATE TABLE a (id INT, dept TEXT, sal INT)');
    const code = await codeOf(db, 'SELECT (SELECT dept, sal FROM a WHERE id=999) AS s');
    assert.strictEqual(code, 1241);
    await db.close();
  });

  await t('#471 相关（correlated）多列标量子查询 → 1241', async () => {
    const db = new Database(':memory:');
    await q(db, 'CREATE TABLE a (id INT, dept TEXT)');
    await q(db, 'CREATE TABLE b (id INT, x INT, y INT)');
    await q(db, "INSERT INTO a VALUES (1,'p'),(2,'q')");
    await q(db, 'INSERT INTO b VALUES (1,10,20),(2,30,40)');
    const code = await codeOf(db, 'SELECT id, (SELECT x, y FROM b WHERE b.id = a.id) AS s FROM a');
    assert.strictEqual(code, 1241);
    await db.close();
  });

  // 未误伤：单列标量子查询仍正常工作
  await t('#471 单列标量子查询仍正常', async () => {
    const db = new Database(':memory:');
    await q(db, 'CREATE TABLE a (id INT, dept TEXT, sal INT)');
    await q(db, "INSERT INTO a VALUES (1,'x',100)");
    const r = await q(db, 'SELECT id, (SELECT dept FROM a WHERE id=1) s FROM a WHERE id=1');
    assert.deepStrictEqual(r.rows, [[1, 'x']]);
    await db.close();
  });

  await t('#471 相关单列标量子查询仍正常（逐行重算）', async () => {
    const db = new Database(':memory:');
    await q(db, 'CREATE TABLE a (id INT)');
    await q(db, 'CREATE TABLE b (id INT, x INT, y INT)');
    await q(db, 'INSERT INTO a VALUES (1),(2)');
    await q(db, 'INSERT INTO b VALUES (1,10,20),(2,30,40)');
    const r = await q(db, 'SELECT id, (SELECT x FROM b WHERE b.id = a.id) s FROM a ORDER BY id');
    assert.deepStrictEqual(r.rows, [[1, 10], [2, 30]]);
    await db.close();
  });

  await t('#471 单列 COUNT(*) 标量子查询仍正常', async () => {
    const db = new Database(':memory:');
    await q(db, 'CREATE TABLE a (id INT)');
    await q(db, 'INSERT INTO a VALUES (1),(2)');
    const r = await q(db, 'SELECT (SELECT COUNT(*) FROM a) AS c');
    assert.deepStrictEqual(r.rows, [[2]]);
    await db.close();
  });

  await t('#471 SELECT * 子查询单列源表仍正常', async () => {
    const db = new Database(':memory:');
    // 显式单列主键：`SELECT *` 展开就是 1 列（无隐式 id 行号列）
    await q(db, 'CREATE TABLE one (v INT PRIMARY KEY)');
    await q(db, 'INSERT INTO one VALUES (7)');
    const r = await q(db, 'SELECT (SELECT * FROM one) AS v');
    assert.deepStrictEqual(r.rows, [[7]]);
    await db.close();
  });

  // #258 不回归：单列多行 → 1242
  await t('#471 #258 单列多行标量子查询仍报 1242', async () => {
    const db = new Database(':memory:');
    await q(db, 'CREATE TABLE t (id INT)');
    await q(db, 'INSERT INTO t VALUES (1),(2)');
    const code = await codeOf(db, 'SELECT (SELECT id FROM t) AS x');
    assert.strictEqual(code, 1242);
    await db.close();
  });

  // 多值上下文不校验列数（仅取首列语义，保持既有行为）
  await t('#471 IN (SELECT 两列) 不受影响', async () => {
    const db = new Database(':memory:');
    await q(db, 'CREATE TABLE a (id INT, sal INT)');
    await q(db, 'INSERT INTO a VALUES (1,100),(2,200)');
    const r = await q(db, 'SELECT id FROM a WHERE id IN (SELECT id, sal FROM a) ORDER BY id');
    assert.deepStrictEqual(r.rows, [[1], [2]]);
    await db.close();
  });

  await t('#471 EXISTS (SELECT 两列) 不受影响', async () => {
    const db = new Database(':memory:');
    await q(db, 'CREATE TABLE a (id INT, sal INT)');
    await q(db, 'INSERT INTO a VALUES (1,100)');
    const r = await q(db, 'SELECT id FROM a WHERE EXISTS (SELECT id, sal FROM a WHERE id = 999)');
    assert.deepStrictEqual(r.rows, []);
    await db.close();
  });

  await t('#471 = ANY (SELECT 两列) 不受影响', async () => {
    const db = new Database(':memory:');
    await q(db, 'CREATE TABLE a (id INT, sal INT)');
    await q(db, 'INSERT INTO a VALUES (1,100),(2,200)');
    const r = await q(db, 'SELECT id FROM a WHERE id = ANY (SELECT id, sal FROM a) ORDER BY id');
    assert.deepStrictEqual(r.rows, [[1], [2]]);
    await db.close();
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
