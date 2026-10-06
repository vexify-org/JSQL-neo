/*
 * 索引管理测试（CREATE INDEX / CREATE UNIQUE INDEX / DROP INDEX）。
 *
 * 此前 DROP INDEX 一律报「not supported」，根因是两层语义错配：
 *   - 标准 SQL 的 `DROP INDEX idx` 不带表名，而存储层 Table.dropIndex(field)
 *     收的是**列名** —— 索引名被当列名传，必然找不到
 *   - CREATE INDEX 是逐列建索引（复合索引 a,b 各建一个），
 *     但删除时只清首列，复合索引会残留一半
 * 另外还修了 CREATE INDEX 顺带往 SELECT 输出里塞一个 `id` 列的问题。
 */
const path = require('path');

const ROOT = path.join(__dirname, '..');
const { Database, JSQL, NativeJSQL } = require(path.join(ROOT, 'index.js'));
const { executeSQL } = require(path.join(ROOT, 'lib/sql.js'));

const OPTS = { safety: false };
let pass = 0, fail = 0;

function ok(name, cond, extra) {
  if (cond) { pass++; console.log('[OK]  ', name); }
  else { fail++; console.log('[FAIL]', name, extra !== undefined ? '-> ' + JSON.stringify(extra).slice(0, 120) : ''); }
}
const rowsOf = r => (Array.isArray(r) ? r[0] : r).rows;
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

async function t(name, fn) {
  const db = new Database(':memory:');
  try {
    const r = await fn({
      exec: (sql) => executeSQL(db, sql, OPTS),
      rows: (sql) => executeSQL(db, sql, OPTS).then(rowsOf),
      tbl: () => db._ensureTable('t'),
      db,
    });
    if (r === true) ok(name, true);
    else ok(name, false, r);
  } catch (e) {
    ok(name, false, String(e.message || e).slice(0, 110));
  } finally {
    try { await db.stop(); } catch (_) { /* ignore */ }
  }
}
const idxFields = (t) => Object.keys(t._indexes || {}).sort();

(async () => {
  console.log('\n--- CREATE INDEX ---');
  await t('单列索引建后可查', async ({ exec, tbl, rows }) => {
    await exec(`CREATE TABLE t (a INT, b TEXT)`);
    await exec(`CREATE INDEX idx_a ON t(a)`);
    if (!idxFields(tbl()).includes('a')) return { fields: idxFields(tbl()) };
    return eq(await rows(`SELECT b FROM t WHERE a = 1`), []);
  });
  await t('复合索引逐列建', async ({ exec, tbl }) => {
    await exec(`CREATE TABLE t (a INT, b TEXT, c INT)`);
    await exec(`CREATE UNIQUE INDEX idx_ab ON t(a,b)`);
    return eq(idxFields(tbl()), ['a', 'b']);
  });
  await t('多索引并存', async ({ exec, tbl }) => {
    await exec(`CREATE TABLE t (a INT, b TEXT, c INT)`);
    await exec(`CREATE INDEX i1 ON t(a)`);
    await exec(`CREATE INDEX i2 ON t(b)`);
    await exec(`CREATE INDEX i3 ON t(c)`);
    return eq(idxFields(tbl()), ['a', 'b', 'c']);
  });
  await t('建索引不影响查询结果', async ({ exec, rows }) => {
    await exec(`CREATE TABLE t (a INT, b TEXT)`);
    await exec(`INSERT INTO t VALUES (1,'x'),(2,'y'),(3,'z')`);
    const before = await rows(`SELECT a, b FROM t ORDER BY a`);
    await exec(`CREATE INDEX idx_a ON t(a)`);
    return eq(await rows(`SELECT a, b FROM t ORDER BY a`), before);
  });
  await t('建索引前后 SELECT * 列一致', async ({ exec, rows }) => {
    // 注意：CREATE TABLE t (a INT, b TEXT) 本身会补一个自增主键 id，
    // 所以基线是 ['id','a','b']，不是 ['a','b']。要验证的是「建索引不改变列集」。
    await exec(`CREATE TABLE t (a INT, b TEXT)`);
    await exec(`INSERT INTO t VALUES (1,'x')`);
    const before = await rows(`SELECT * FROM t`);
    await exec(`CREATE INDEX idx_a ON t(a)`);
    return eq(await rows(`SELECT * FROM t`), before);
  });
  await t('索引对查询正确性无影响（重复值）', async ({ exec, rows }) => {
    await exec(`CREATE TABLE t (a INT, b TEXT)`);
    await exec(`INSERT INTO t VALUES (1,'x'),(1,'y'),(2,'z')`);
    await exec(`CREATE INDEX idx_a ON t(a)`);
    return eq(await rows(`SELECT b FROM t WHERE a = 1 ORDER BY b`), [['x'], ['y']]);
  });

  console.log('\n--- DROP INDEX ---');
  await t('DROP INDEX 按索引名删（不带表名）', async ({ exec, tbl }) => {
    await exec(`CREATE TABLE t (a INT, b TEXT)`);
    await exec(`CREATE INDEX idx_a ON t(a)`);
    await exec(`DROP INDEX idx_a`);
    return eq(idxFields(tbl()), []);
  });
  await t('DROP INDEX 后查询仍正确', async ({ exec, rows, tbl }) => {
    await exec(`CREATE TABLE t (a INT, b TEXT)`);
    await exec(`INSERT INTO t VALUES (1,'x'),(2,'y')`);
    await exec(`CREATE INDEX idx_a ON t(a)`);
    await exec(`DROP INDEX idx_a`);
    if (idxFields(tbl()).length) return { leftover: idxFields(tbl()) };
    return eq(await rows(`SELECT b FROM t WHERE a = 2`), [['y']]);
  });
  await t('DROP INDEX 复合索引清掉全部列', async ({ exec, tbl }) => {
    await exec(`CREATE TABLE t (a INT, b TEXT, c INT)`);
    await exec(`CREATE UNIQUE INDEX idx_ab ON t(a,b)`);
    await exec(`DROP INDEX idx_ab`);
    // 此前只删首列，b 会残留
    return eq(idxFields(tbl()), []);
  });
  await t('DROP INDEX 只删指定的，其余保留', async ({ exec, tbl }) => {
    await exec(`CREATE TABLE t (a INT, b TEXT, c INT)`);
    await exec(`CREATE INDEX i1 ON t(a)`);
    await exec(`CREATE INDEX i2 ON t(b)`);
    await exec(`CREATE INDEX i3 ON t(c)`);
    await exec(`DROP INDEX i2`);
    return eq(idxFields(tbl()), ['a', 'c']);
  });
  await t('DROP INDEX IF EXISTS 不存在的索引 → skipped', async ({ exec }) => {
    await exec(`CREATE TABLE t (a INT)`);
    const r = await exec(`DROP INDEX IF EXISTS nope`);
    return r.skipped === true;
  });
  await t('DROP INDEX 不存在的索引 → 报错', async ({ exec }) => {
    await exec(`CREATE TABLE t (a INT)`);
    let threw = false;
    try { await exec(`DROP INDEX nope`); } catch (_) { threw = true; }
    return threw;
  });
  await t('DROP INDEX t.idx 形式', async ({ exec, tbl }) => {
    await exec(`CREATE TABLE t (a INT)`);
    await exec(`CREATE INDEX idx_a ON t(a)`);
    await exec(`DROP INDEX t.idx_a`);
    return eq(idxFields(tbl()), []);
  });
  await t('删除后索引可重建', async ({ exec, tbl }) => {
    await exec(`CREATE TABLE t (a INT)`);
    await exec(`CREATE INDEX i1 ON t(a)`);
    await exec(`DROP INDEX i1`);
    await exec(`CREATE INDEX i2 ON t(a)`);
    return eq(idxFields(tbl()), ['a']);
  });
  await t('DROP TABLE 不受残留索引影响', async ({ exec, rows }) => {
    await exec(`CREATE TABLE t (a INT)`);
    await exec(`CREATE INDEX i1 ON t(a)`);
    await exec(`DROP INDEX i1`);
    await exec(`DROP TABLE t`);
    let threw = false;
    try { await exec(`SELECT * FROM t`); } catch (_) { threw = true; }
    return threw;
  });
  await t('建索引不破坏已有数据', async ({ exec, rows }) => {
    await exec(`CREATE TABLE t (a INT, b TEXT)`);
    await exec(`INSERT INTO t VALUES (1,'x'),(2,'y'),(3,'z')`);
    await exec(`CREATE INDEX idx_a ON t(a)`);
    await exec(`DROP INDEX idx_a`);
    return eq(await rows(`SELECT a, b FROM t ORDER BY a`), [[1, 'x'], [2, 'y'], [3, 'z']]);
  });

  console.log('\n--- 三个 engine 行为一致 ---');
  // JSQL(wasm) / NativeJSQL 的索引由 Rust 侧二进制管理，JS 层看不到 _indexes，
  // 也没有 createIndex/dropIndex 钩子 —— DDL 会明确报「不支持」而不是静默成功。
  // 这里验证 Database（JS 引擎）的索引可建可删，并确认另外两个报的是明确的错。
  {
    const db = new Database(':memory:');
    try {
      await executeSQL(db, `CREATE TABLE t (a INT, b TEXT)`, OPTS);
      await executeSQL(db, `CREATE INDEX idx_a ON t(a)`, OPTS);
      const built = !!db._ensureTable('t')._indexes.a;
      const r = await executeSQL(db, `DROP INDEX idx_a`, OPTS);
      const left = Object.keys(db._ensureTable('t')._indexes).length;
      ok('Database 建/删索引', built && r.ok === true && left === 0, { built, left });
    } catch (e) {
      ok('Database 建/删索引', false, String(e.message).slice(0, 80));
    } finally { try { await db.stop(); } catch (_) { /* ignore */ } }
  }
  for (const [name, mk] of [
    ['JSQL', () => new JSQL({ mode: 'memory' })],
    ['NativeJSQL', () => new NativeJSQL({ mode: 'memory' })],
  ]) {
    const db = await mk();
    if (db.start) await db.start();
    try {
      await executeSQL(db, `CREATE TABLE t (a INT)`, OPTS);
      let msg = '', failed = false;
      try { await executeSQL(db, `CREATE INDEX i ON t(a)`, OPTS); } catch (e) { failed = true; msg = String(e.message); }
      // 要么真支持（CREATE 成功且 DROP 也成功），要么给明确的「不支持」——
      // 最糟的是 CREATE 静默成功让人以为索引生效了。
      if (failed) {
        ok(`${name} 索引 DDL 明确报不支持`, /not supported/i.test(msg), msg.slice(0, 60));
      } else {
        let dropOk = false, dropMsg = '';
        try { await executeSQL(db, `DROP INDEX i`, OPTS); dropOk = true; } catch (e) { dropMsg = String(e.message); }
        ok(`${name} 索引 DDL 成对可用`, dropOk, dropMsg.slice(0, 60));
      }
    } catch (e) {
      ok(`${name} 索引 DDL`, false, String(e.message).slice(0, 80));
    } finally { try { await db.stop(); } catch (_) { /* ignore */ } }
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
