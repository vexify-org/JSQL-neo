/*
 * DML 与表约束回归测试。
 *
 * 覆盖两类曾静默出错的问题：
 *   1. 无主键表批量删除删错行 —— 存储层把 id 当 1-based 行号，
 *      边解析边删会让后续行号整体左移（DELETE ... WHERE id <= 2
 *      在 5 行表上只删掉 1 行，且留下的是第 2 行）。
 *   2. UPDATE 改主键/唯一列不校验冲突 —— 直接 Object.assign，
 *      静默产生两行同主键（MySQL / SQLite 都会报 UNIQUE constraint failed）。
 *
 * 每个用例独立建库，避免状态污染。
 */
const path = require('path');

const ROOT = path.join(__dirname, '..');
const { Database } = require(path.join(ROOT, 'index.js'));
const { executeSQL } = require(path.join(ROOT, 'lib/sql.js'));

const OPTS = { safety: false };
let pass = 0, fail = 0;

function ok(name, cond, extra) {
  if (cond) { pass++; console.log('[OK]  ', name); }
  else { fail++; console.log('[FAIL]', name, extra !== undefined ? '-> ' + JSON.stringify(extra) : ''); }
}
const rowsOf = r => (Array.isArray(r) ? r[0] : r).rows;
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** 跑一个用例：每次给全新的 :memory: 库 */
async function t(name, fn) {
  const db = new Database(':memory:');
  try {
    const r = await fn({
      exec: (sql) => executeSQL(db, sql, OPTS),
      rows: (sql) => executeSQL(db, sql, OPTS).then(rowsOf),
      scalar: (sql) => executeSQL(db, sql, OPTS).then(r => rowsOf(r)[0][0]),
      mustFail: async (sql) => {
        try { await executeSQL(db, sql, OPTS); return '本该报错却成功了'; }
        catch (e) { return true; }
      },
    });
    if (r === true) ok(name, true);
    else ok(name, false, r);
  } catch (e) {
    ok(name, false, String(e.message || e).slice(0, 120));
  } finally {
    try { await db.stop(); } catch (_) { /* ignore */ }
  }
}

(async () => {
  console.log('\n--- 无主键表：批量删除曾删错行 ---');
  await t('无主键 DELETE 多个连续行', async ({ exec, rows }) => {
    await exec(`CREATE TABLE t (id INT)`);
    await exec(`INSERT INTO t VALUES (1),(2),(3),(4),(5)`);
    await exec(`DELETE FROM t WHERE id <= 2`);
    return eq(await rows(`SELECT id FROM t ORDER BY id`), [[3], [4], [5]]);
  });
  await t('无主键 DELETE IN 列表', async ({ exec, rows }) => {
    await exec(`CREATE TABLE t (id INT)`);
    await exec(`INSERT INTO t VALUES (1),(2),(3),(4),(5)`);
    await exec(`DELETE FROM t WHERE id IN (1,4)`);
    return eq(await rows(`SELECT id FROM t ORDER BY id`), [[2], [3], [5]]);
  });
  await t('无主键 DELETE 单行（回归对照）', async ({ exec, rows }) => {
    await exec(`CREATE TABLE t (id INT)`);
    await exec(`INSERT INTO t VALUES (1),(2),(3)`);
    await exec(`DELETE FROM t WHERE id = 2`);
    return eq(await rows(`SELECT id FROM t ORDER BY id`), [[1], [3]]);
  });
  await t('无主键 DELETE 全部', async ({ exec, rows }) => {
    await exec(`CREATE TABLE t (id INT)`);
    await exec(`INSERT INTO t VALUES (1),(2),(3)`);
    await exec(`DELETE FROM t`);
    return eq(await rows(`SELECT id FROM t`), []);
  });
  await t('有主键 DELETE 多个（回归对照）', async ({ exec, rows }) => {
    await exec(`CREATE TABLE t (id INT PRIMARY KEY)`);
    await exec(`INSERT INTO t VALUES (1),(2),(3),(4),(5)`);
    await exec(`DELETE FROM t WHERE id <= 2`);
    return eq(await rows(`SELECT id FROM t ORDER BY id`), [[3], [4], [5]]);
  });
  await t('无主键 DELETE 后行数正确', async ({ exec, scalar }) => {
    await exec(`CREATE TABLE t (id INT)`);
    await exec(`INSERT INTO t VALUES (1),(2),(3)`);
    const r = await exec(`DELETE FROM t WHERE id > 1`);
    if (r.affectedRows !== 2) return { affectedRows: r.affectedRows, want: 2 };
    return eq(await scalar(`SELECT COUNT(*) AS c FROM t`), 1);
  });

  console.log('\n--- UPDATE 改主键 / 唯一列曾不校验冲突 ---');
  await t('UPDATE 主键成已存在值 → 报错', async ({ exec, mustFail }) => {
    await exec(`CREATE TABLE t (id INT PRIMARY KEY, v INT)`);
    await exec(`INSERT INTO t VALUES (1,10),(2,20)`);
    return mustFail(`UPDATE t SET id = 1 WHERE id = 2`);
  });
  await t('UPDATE 主键冲突后数据未损坏', async ({ exec, rows }) => {
    await exec(`CREATE TABLE t (id INT PRIMARY KEY, v INT)`);
    await exec(`INSERT INTO t VALUES (1,10),(2,20),(3,30)`);
    try { await exec(`UPDATE t SET id = 1 WHERE id = 2`); } catch (_) { /* expected */ }
    return eq(await rows(`SELECT id, v FROM t ORDER BY id`), [[1, 10], [2, 20], [3, 30]]);
  });
  await t('UPDATE 主键成不冲突值 → 成功', async ({ exec, rows }) => {
    await exec(`CREATE TABLE t (id INT PRIMARY KEY, v INT)`);
    await exec(`INSERT INTO t VALUES (1,10),(2,20),(3,30)`);
    await exec(`UPDATE t SET id = 9 WHERE id = 2`);
    return eq(await rows(`SELECT id, v FROM t ORDER BY id`), [[1, 10], [3, 30], [9, 20]]);
  });
  await t('UPDATE 主键为自身值 → 允许', async ({ exec, scalar }) => {
    await exec(`CREATE TABLE t (id INT PRIMARY KEY, v INT)`);
    await exec(`INSERT INTO t VALUES (1,10),(9,20)`);
    await exec(`UPDATE t SET id = 9 WHERE id = 9`);
    return eq(await scalar(`SELECT COUNT(*) AS c FROM t`), 2);
  });
  await t('UPDATE UNIQUE 列成已存在值 → 报错', async ({ exec, mustFail }) => {
    await exec(`CREATE TABLE t (id INT PRIMARY KEY, e TEXT UNIQUE)`);
    await exec(`INSERT INTO t VALUES (1,'a'),(2,'b')`);
    return mustFail(`UPDATE t SET e = 'a' WHERE id = 2`);
  });
  await t('UPDATE UNIQUE 列成不冲突值 → 成功', async ({ exec, rows }) => {
    await exec(`CREATE TABLE t (id INT PRIMARY KEY, e TEXT UNIQUE)`);
    await exec(`INSERT INTO t VALUES (1,'a'),(2,'b')`);
    await exec(`UPDATE t SET e = 'c' WHERE id = 2`);
    return eq(await rows(`SELECT id, e FROM t ORDER BY id`), [[1, 'a'], [2, 'c']]);
  });
  await t('UPDATE 非约束列不受影响', async ({ exec, rows }) => {
    await exec(`CREATE TABLE t (id INT PRIMARY KEY, v INT)`);
    await exec(`INSERT INTO t VALUES (1,10),(2,20)`);
    await exec(`UPDATE t SET v = 99 WHERE id = 1`);
    return eq(await rows(`SELECT id, v FROM t ORDER BY id`), [[1, 99], [2, 20]]);
  });

  console.log('\n--- 既有约束行为回归对照 ---');
  await t('INSERT 主键重复 → 报错', async ({ exec, mustFail }) => {
    await exec(`CREATE TABLE t (id INT PRIMARY KEY)`);
    await exec(`INSERT INTO t VALUES (1)`);
    return mustFail(`INSERT INTO t VALUES (1)`);
  });
  await t('INSERT NOT NULL 违反 → 报错', async ({ exec, mustFail }) => {
    await exec(`CREATE TABLE t (id INT, v TEXT NOT NULL)`);
    return mustFail(`INSERT INTO t VALUES (1,NULL)`);
  });
  await t('INSERT UNIQUE 重复 → 报错', async ({ exec, mustFail }) => {
    await exec(`CREATE TABLE t (id INT, e TEXT UNIQUE)`);
    await exec(`INSERT INTO t VALUES (1,'a')`);
    return mustFail(`INSERT INTO t VALUES (2,'a')`);
  });
  await t('UNIQUE 允许多个 NULL', async ({ exec, scalar }) => {
    await exec(`CREATE TABLE t (id INT, e TEXT UNIQUE)`);
    await exec(`INSERT INTO t VALUES (1,NULL),(2,NULL)`);
    return eq(await scalar(`SELECT COUNT(*) AS c FROM t`), 2);
  });
  await t('删除后主键可复用', async ({ exec, scalar }) => {
    await exec(`CREATE TABLE t (id INT PRIMARY KEY, v TEXT)`);
    await exec(`INSERT INTO t VALUES (1,'a')`);
    await exec(`DELETE FROM t WHERE id = 1`);
    await exec(`INSERT INTO t VALUES (1,'c')`);
    return eq(await scalar(`SELECT v FROM t WHERE id = 1`), 'c');
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
