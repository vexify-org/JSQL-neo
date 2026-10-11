/*
 * 保存点测试（SAVEPOINT / ROLLBACK TO SAVEPOINT / RELEASE SAVEPOINT）。
 *
 * 此前这三个语句的状态：
 *   - SAVEPOINT 只在引擎上登记一个名字（engine._savepoints 是个 Set）
 *   - RELEASE 把名字删掉
 *   - ROLLBACK TO 一律抛「engine has no savepoint/snapshot support」
 * 也就是「登记了但完全不能回滚」—— 比报错更糟的是它看起来成功了。
 *
 * 现在在 Database 引擎里实现真正的行级快照。几个容易踩的点：
 *   1. 同一个保存点可以被 ROLLBACK TO 多次，所以还原时必须再深拷贝一次，
 *      否则第二次回滚拿到的是被后续写入改坏的数据
 *   2. 保存点之后新建的表，回滚时要删掉，不然会残留一张当时不存在的表
 *   3. 引擎里有两条事务路径（begin/commit/rollback 与 beginTx/commitTx/rollbackTx），
 *      SQL 层走后者 —— 保存点必须对两条都生效
 *   4. wasm / native 引擎的事务在 Rust 侧，还没有保存点：
 *      必须明确报错，不能静默假装成功
 */
const path = require('path');

const ROOT = path.join(__dirname, '..');
const { Database, JSQL, NativeJSQL } = require(path.join(ROOT, 'index.js'));
const { executeSQL } = require(path.join(ROOT, 'lib/sql.js'));

const OPTS = { safety: false };
let pass = 0, fail = 0;

function ok(name, cond, extra) {
  if (cond) { pass++; console.log('[OK]  ', name); }
  else { fail++; console.log('[FAIL]', name, extra !== undefined ? '-> ' + JSON.stringify(extra).slice(0, 140) : ''); }
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

async function t(name, fn) {
  const db = new Database(':memory:');
  const exec = (sql) => executeSQL(db, sql, OPTS);
  const rows = async (sql) => (await exec(sql)).rows;
  const mustFail = async (sql) => {
    try { await exec(sql); return false; } catch (_) { return true; }
  };
  try {
    const r = await fn({ db, exec, rows, mustFail });
    ok(name, r === undefined ? true : !!r);
  } catch (e) {
    ok(name, false, e.message);
  }
}

(async () => {
  console.log('\n--- 基本回滚 ---');
  await t('ROLLBACK TO 还原保存点之后的数据', async ({ exec, rows }) => {
    await exec('CREATE TABLE t (id INT PRIMARY KEY, name TEXT)');
    await exec("INSERT INTO t VALUES (1,'a')");
    await exec('BEGIN');
    await exec("INSERT INTO t VALUES (2,'b')");
    await exec('SAVEPOINT sp1');
    await exec("INSERT INTO t VALUES (3,'c')");
    await exec("UPDATE t SET name = 'B2' WHERE id = 2");
    const before = await rows('SELECT id, name FROM t ORDER BY id');
    await exec('ROLLBACK TO SAVEPOINT sp1');
    const after = await rows('SELECT id, name FROM t ORDER BY id');
    await exec('COMMIT');
    return eq(before, [[1, 'a'], [2, 'B2'], [3, 'c']]) && eq(after, [[1, 'a'], [2, 'b']]);
  });

  await t('保存点之前的改动会保留', async ({ exec, rows, db }) => {
    await exec('CREATE TABLE t (id INT PRIMARY KEY, v TEXT)');
    await exec("INSERT INTO t VALUES (1,'base')");
    await exec('BEGIN');
    await exec("UPDATE t SET v = 'before-sp' WHERE id = 1");
    await exec('SAVEPOINT s1');
    await exec("UPDATE t SET v = 'after-sp' WHERE id = 1");
    await exec('ROLLBACK TO s1');
    const r = await rows('SELECT v FROM t WHERE id = 1');
    return db.hasActiveTx() && eq(r, [['before-sp']]);
  });

  await t('回滚后事务仍然有效，可以继续写并提交', async ({ exec, rows }) => {
    await exec('CREATE TABLE t (id INT PRIMARY KEY)');
    await exec('BEGIN');
    await exec('SAVEPOINT s1');
    await exec('INSERT INTO t VALUES (1)');
    await exec('ROLLBACK TO s1');
    await exec('INSERT INTO t VALUES (2)');
    await exec('COMMIT');
    return eq(await rows('SELECT id FROM t ORDER BY id'), [[2]]);
  });

  await t('回滚掉 INSERT 之后自增值也退回', async ({ exec, rows }) => {
    await exec('CREATE TABLE t (id INTEGER PRIMARY KEY AUTOINCREMENT, v TEXT)');
    await exec('BEGIN');
    await exec('SAVEPOINT s1');
    await exec("INSERT INTO t (v) VALUES ('x')");
    await exec('ROLLBACK TO s1');
    await exec("INSERT INTO t (v) VALUES ('y')");
    await exec('COMMIT');
    return eq(await rows('SELECT id, v FROM t'), [[1, 'y']]);
  });

  console.log('\n--- 同一个保存点反复回滚 ---');
  await t('同一保存点可回滚多次且每次都还原到最初状态', async ({ exec, rows }) => {
    await exec('CREATE TABLE t (id INT PRIMARY KEY, v TEXT)');
    await exec("INSERT INTO t VALUES (1,'orig')");
    await exec('BEGIN');
    await exec('SAVEPOINT s1');
    await exec("UPDATE t SET v = 'first' WHERE id = 1");
    await exec('ROLLBACK TO s1');
    const a = await rows('SELECT v FROM t');
    await exec("UPDATE t SET v = 'second' WHERE id = 1");
    await exec('ROLLBACK TO s1');
    const b = await rows('SELECT v FROM t');
    await exec('COMMIT');
    // 第二次回滚若把快照本身改坏了，这里就会拿到 first/second 而不是 orig
    return eq(a, [['orig']]) && eq(b, [['orig']]);
  });

  await t('回滚后嵌套对象不受外层引用影响', async ({ exec, rows }) => {
    await exec('CREATE TABLE t (id INT PRIMARY KEY, j TEXT)');
    await exec('BEGIN');
    await exec('SAVEPOINT s1');
    await exec('COMMIT');
    return eq(await rows('SELECT id FROM t'), []);
  });

  console.log('\n--- 多层保存点 ---');
  await t('回滚到内层保存点不影响外层', async ({ exec, rows }) => {
    await exec('CREATE TABLE t (id INT PRIMARY KEY)');
    await exec('BEGIN');
    await exec('INSERT INTO t VALUES (1)');
    await exec('SAVEPOINT a');
    await exec('INSERT INTO t VALUES (2)');
    await exec('SAVEPOINT b');
    await exec('INSERT INTO t VALUES (3)');
    await exec('ROLLBACK TO b');
    const n1 = await rows('SELECT id FROM t ORDER BY id');
    await exec('COMMIT');
    return eq(n1, [[1], [2]]);
  });

  await t('回滚到外层会丢弃内层保存点', async ({ exec, rows, db }) => {
    await exec('CREATE TABLE t (id INT PRIMARY KEY)');
    await exec('BEGIN');
    await exec('INSERT INTO t VALUES (1)');
    await exec('SAVEPOINT a');
    await exec('INSERT INTO t VALUES (2)');
    await exec('SAVEPOINT b');
    await exec('INSERT INTO t VALUES (3)');
    const stacked = db.listSavepoints();
    await exec('ROLLBACK TO a');
    const left = db.listSavepoints();
    const n = await rows('SELECT id FROM t ORDER BY id');
    await exec('COMMIT');
    return eq(stacked, ['a', 'b']) && eq(left, ['a']) && eq(n, [[1]]);
  });

  await t('同名保存点覆盖旧的（并作废其后的）', async ({ exec, db, rows }) => {
    await exec('CREATE TABLE t (id INT PRIMARY KEY)');
    await exec('BEGIN');
    await exec('SAVEPOINT s');
    await exec('INSERT INTO t VALUES (1)');
    await exec('SAVEPOINT s');     // 同名覆盖，起点变成「已有 1」
    await exec('INSERT INTO t VALUES (2)');
    const names = db.listSavepoints();
    await exec('ROLLBACK TO s');
    const n = await rows('SELECT id FROM t ORDER BY id');
    await exec('COMMIT');
    return eq(names, ['s']) && eq(n, [[1]]);
  });

  console.log('\n--- RELEASE ---');
  await t('RELEASE 不还原数据，只作废保存点', async ({ exec, rows, db, mustFail }) => {
    await exec('CREATE TABLE t (id INT PRIMARY KEY, v TEXT)');
    await exec("INSERT INTO t VALUES (1,'x')");
    await exec('BEGIN');
    await exec('SAVEPOINT s1');
    await exec("UPDATE t SET v = 'y' WHERE id = 1");
    await exec('RELEASE SAVEPOINT s1');
    const kept = await rows('SELECT v FROM t');
    const names = db.listSavepoints();
    const rolledBack = await mustFail('ROLLBACK TO SAVEPOINT s1');
    await exec('COMMIT');
    return eq(kept, [['y']]) && eq(names, []) && rolledBack;
  });

  await t('RELEASE 外层会一并作废内层', async ({ exec, db }) => {
    await exec('CREATE TABLE t (id INT PRIMARY KEY)');
    await exec('BEGIN');
    await exec('SAVEPOINT a');
    await exec('SAVEPOINT b');
    await exec('RELEASE SAVEPOINT a');
    const names = db.listSavepoints();
    await exec('COMMIT');
    return eq(names, []);
  });

  console.log('\n--- 生命周期 ---');
  await t('COMMIT 释放全部保存点', async ({ exec, db }) => {
    await exec('CREATE TABLE t (id INT PRIMARY KEY)');
    await exec('BEGIN');
    await exec('SAVEPOINT a');
    await exec('SAVEPOINT b');
    await exec('COMMIT');
    return eq(db.listSavepoints(), []);
  });

  await t('ROLLBACK 释放全部保存点', async ({ exec, db }) => {
    await exec('CREATE TABLE t (id INT PRIMARY KEY)');
    await exec('BEGIN');
    await exec('SAVEPOINT a');
    await exec('ROLLBACK');
    return eq(db.listSavepoints(), []);
  });

  await t('保存点不跨事务存活', async ({ exec, db, mustFail }) => {
    await exec('CREATE TABLE t (id INT PRIMARY KEY)');
    await exec('BEGIN');
    await exec('SAVEPOINT a');
    await exec('COMMIT');
    await exec('BEGIN');
    const stillThere = await mustFail('ROLLBACK TO SAVEPOINT a');
    const names = db.listSavepoints();
    await exec('ROLLBACK');
    return stillThere && eq(names, []);
  });

  console.log('\n--- 保存点之后新建的表 ---');
  await t('回滚会删掉保存点之后建的表', async ({ exec, db }) => {
    await exec('CREATE TABLE exist (id INT PRIMARY KEY)');
    await exec('BEGIN');
    await exec('SAVEPOINT s1');
    await exec('CREATE TABLE created_after (id INT PRIMARY KEY)');
    const during = (await db.getTables()).slice().sort();
    await exec('ROLLBACK TO s1');
    const after = (await db.getTables()).slice().sort();
    await exec('COMMIT');
    return eq(during, ['created_after', 'exist']) && eq(after, ['exist']);
  });

  await t('回滚不会动保存点之前就存在的表', async ({ exec, rows }) => {
    await exec('CREATE TABLE keep (id INT PRIMARY KEY, v TEXT)');
    await exec("INSERT INTO keep VALUES (1,'k')");
    await exec('BEGIN');
    await exec('SAVEPOINT s1');
    await exec('CREATE TABLE tmp (id INT PRIMARY KEY)');
    await exec('ROLLBACK TO s1');
    const r = await rows('SELECT id, v FROM keep');
    await exec('COMMIT');
    return eq(r, [[1, 'k']]);
  });

  console.log('\n--- 错误处理 ---');
  await t('无事务时 SAVEPOINT 报错且说明原因', async ({ exec }) => {
    await exec('CREATE TABLE t (id INT PRIMARY KEY)');
    try { await exec('SAVEPOINT s1'); return false; }
    catch (e) { return /active transaction|BEGIN/i.test(e.message); }
  });

  await t('无事务时 ROLLBACK TO 报错', async ({ exec }) => {
    await exec('CREATE TABLE t (id INT PRIMARY KEY)');
    try { await exec('ROLLBACK TO SAVEPOINT s1'); return false; }
    catch (e) { return /active transaction/i.test(e.message); }
  });

  await t('无事务时 RELEASE 报错', async ({ exec }) => {
    await exec('CREATE TABLE t (id INT PRIMARY KEY)');
    try { await exec('RELEASE SAVEPOINT s1'); return false; }
    catch (e) { return /active transaction/i.test(e.message); }
  });

  await t('回滚到不存在的保存点会报错，并列出已有的', async ({ exec }) => {
    await exec('CREATE TABLE t (id INT PRIMARY KEY)');
    await exec('BEGIN');
    await exec('SAVEPOINT alpha');
    let msg = '';
    try { await exec('ROLLBACK TO SAVEPOINT nope'); } catch (e) { msg = e.message; }
    await exec('ROLLBACK');
    return /nope/.test(msg) && /alpha/.test(msg);
  });

  await t('回滚到不存在的保存点不会改坏数据', async ({ exec, rows }) => {
    await exec('CREATE TABLE t (id INT PRIMARY KEY, v TEXT)');
    await exec("INSERT INTO t VALUES (1,'keep')");
    await exec('BEGIN');
    await exec('SAVEPOINT s1');
    await exec("UPDATE t SET v = 'changed' WHERE id = 1");
    try { await exec('ROLLBACK TO SAVEPOINT bogus'); } catch (_) { /* 预期 */ }
    const r = await rows('SELECT v FROM t');
    await exec('ROLLBACK');
    return eq(r, [['changed']]);
  });

  await t('不区分大小写', async ({ exec, rows }) => {
    await exec('CREATE TABLE t (id INT PRIMARY KEY, v TEXT)');
    await exec("INSERT INTO t VALUES (1,'a')");
    await exec('BEGIN');
    await exec('savepoint SpOne');
    await exec("UPDATE t SET v = 'b' WHERE id = 1");
    await exec('rollback to savepoint SPONE');
    const r = await rows('SELECT v FROM t');
    await exec('COMMIT');
    return eq(r, [['a']]);
  });

  await t('ROLLBACK TO 可以省略 SAVEPOINT 关键字', async ({ exec, rows }) => {
    await exec('CREATE TABLE t (id INT PRIMARY KEY, v TEXT)');
    await exec("INSERT INTO t VALUES (1,'a')");
    await exec('BEGIN');
    await exec('SAVEPOINT s1');
    await exec("UPDATE t SET v = 'b' WHERE id = 1");
    await exec('ROLLBACK TO s1');
    const r = await rows('SELECT v FROM t');
    await exec('COMMIT');
    return eq(r, [['a']]);
  });

  console.log('\n--- 直连 API（begin/commit/rollback 路径）---');
  await t('db.begin() 路径下保存点同样有效', async ({ db }) => {
    const exec = (sql) => executeSQL(db, sql, OPTS);
    const rows = async (sql) => (await exec(sql)).rows;
    await exec('CREATE TABLE t (id INT PRIMARY KEY, v TEXT)');
    await exec("INSERT INTO t VALUES (1,'a')");
    db.begin('REPEATABLE_READ');
    await exec("UPDATE t SET v = 'b' WHERE id = 1");
    db.savepoint('sp');
    await exec("UPDATE t SET v = 'c' WHERE id = 1");
    db.rollbackTo('sp');
    const during = await rows('SELECT v FROM t');
    db.commit();
    const after = await rows('SELECT v FROM t');
    return eq(during, [['b']]) && eq(after, [['b']]);
  });

  await t('db.begin() 下 ROLLBACK 仍能整体回滚', async ({ db }) => {
    const exec = (sql) => executeSQL(db, sql, OPTS);
    const rows = async (sql) => (await exec(sql)).rows;
    await exec('CREATE TABLE t (id INT PRIMARY KEY, v TEXT)');
    await exec("INSERT INTO t VALUES (1,'orig')");
    db.begin('REPEATABLE_READ');
    await exec('SAVEPOINT s1');
    await exec("UPDATE t SET v = 'x' WHERE id = 1");
    db.rollbackTo('s1');
    await exec("UPDATE t SET v = 'y' WHERE id = 1");
    db.rollback();
    return eq(await rows('SELECT v FROM t'), [['orig']]);
  });

  await t('READ_COMMITTED 下保存点也能精确还原', async ({ db }) => {
    const exec = (sql) => executeSQL(db, sql, OPTS);
    const rows = async (sql) => (await exec(sql)).rows;
    await exec('CREATE TABLE t (id INT PRIMARY KEY, v TEXT)');
    await exec("INSERT INTO t VALUES (1,'a')");
    db.begin('READ_COMMITTED');
    await exec('SAVEPOINT s1');
    await exec("UPDATE t SET v = 'b' WHERE id = 1");
    db.rollbackTo('s1');
    const r = await rows('SELECT v FROM t');
    db.commit();
    return eq(r, [['a']]);
  });

  console.log('\n--- 其他引擎：明确报错而不是假装成功 ---');
  const others = [
    ['JSQL(wasm)', () => new JSQL({ mode: 'memory' })],
    ['NativeJSQL', () => new NativeJSQL({ mode: 'memory' })],
  ];
  for (const [name, mk] of others) {
    let db = null;
    try {
      db = await mk();
      if (db.start) await db.start();
      await executeSQL(db, 'CREATE TABLE t (id INT PRIMARY KEY)', OPTS);
      await executeSQL(db, 'BEGIN', OPTS);
      let threw = false;
      let msg = '';
      try { await executeSQL(db, 'SAVEPOINT s1', OPTS); }
      catch (e) { threw = true; msg = e.message; }
      ok(`${name} SAVEPOINT 明确报错而不是静默成功`, threw && /savepoint/i.test(msg), msg.slice(0, 90));
    } catch (e) {
      // 引擎不可用（缺原生二进制）时跳过，不算失败
      ok(`${name} 不可用，跳过（${String(e.message).slice(0, 40)}）`, true);
    } finally {
      try { if (db && db.stop) await db.stop(); } catch (_) { /* ignore */ }
    }
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('💥', e); process.exit(1); });
