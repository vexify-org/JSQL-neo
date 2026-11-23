/*
 * Regression tests for issues #181-#186.
 *   node test/issue-181-186.test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const { Database } = require(path.join(ROOT, 'index.js'));

let passed = 0, failed = 0;
function ok(name, cond, extra) {
  if (cond) { passed++; console.log('[OK]', name); }
  else { failed++; console.log('[FAIL]', name, extra !== undefined ? '→ ' + JSON.stringify(extra) : ''); }
}

const q = (db, sql) => db.query(sql, { safety: false });

async function columnarSqlWrites() {
  const db = new Database(':memory:');
  await q(db, 'CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)');
  await q(db, "INSERT INTO t (id,name) VALUES (1,'a'),(2,'b')");
  db.convertToColumnar('t');

  await q(db, "UPDATE t SET name='z' WHERE id=2");
  let rows = (await q(db, 'SELECT * FROM t')).rows;
  ok('#181 SQL UPDATE invalidates columnar', JSON.stringify(rows) === JSON.stringify([[1, 'a'], [2, 'z']]), rows);

  await q(db, 'DELETE FROM t WHERE id=1');
  rows = (await q(db, 'SELECT * FROM t')).rows;
  ok('#181 SQL DELETE invalidates columnar', JSON.stringify(rows) === JSON.stringify([[2, 'z']]), rows);
  const count = (await q(db, 'SELECT COUNT(*) FROM t')).rows;
  ok('#181 COUNT after SQL writes', JSON.stringify(count) === JSON.stringify([[1]]), count);
  db.stop();
}

async function subqueryMutations() {
  {
    const db = new Database(':memory:');
    await q(db, 'CREATE TABLE t (id INTEGER PRIMARY KEY, a INTEGER)');
    await q(db, 'INSERT INTO t (id,a) VALUES (1,10),(2,20),(3,5),(4,30)');
    const del = await q(db, 'DELETE FROM t WHERE id IN (SELECT id FROM t WHERE a > 10)');
    ok('#182 DELETE IN subquery affectedRows', del.affectedRows === 2, del.affectedRows);
    const rows = (await q(db, 'SELECT * FROM t')).rows;
    ok('#182 DELETE IN subquery rows', JSON.stringify(rows) === JSON.stringify([[1, 10], [3, 5]]), rows);
    db.stop();
  }
  {
    const db = new Database(':memory:');
    await q(db, 'CREATE TABLE t (id INTEGER PRIMARY KEY, a INTEGER)');
    await q(db, 'INSERT INTO t (id,a) VALUES (1,10),(2,20),(3,5),(4,30)');
    const upd = await q(db, 'UPDATE t SET a = a + 1 WHERE id IN (SELECT id FROM t WHERE a > 10)');
    ok('#182 UPDATE IN subquery affectedRows', upd.affectedRows === 2, upd.affectedRows);
    const rows = (await q(db, 'SELECT * FROM t')).rows;
    ok('#182 UPDATE IN subquery rows', JSON.stringify(rows) === JSON.stringify([[1, 10], [2, 21], [3, 5], [4, 31]]), rows);
    db.stop();
  }
  {
    const db = new Database(':memory:');
    await q(db, 'CREATE TABLE t (id INTEGER PRIMARY KEY, a INTEGER)');
    await q(db, 'INSERT INTO t (id,a) VALUES (1,10),(2,20)');
    const del = await q(db, 'DELETE FROM t WHERE EXISTS (SELECT 1 FROM t WHERE a > 15)');
    ok('#182 DELETE EXISTS subquery', del.affectedRows === 2, del.affectedRows);
    db.stop();
  }
}

async function qualifiedGroupOrder() {
  const db = new Database(':memory:');
  await q(db, 'CREATE TABLE t1 (a INTEGER PRIMARY KEY, b INTEGER)');
  await q(db, 'INSERT INTO t1 (a,b) VALUES (1,10),(2,20),(3,10),(4,NULL)');
  const asc = (await q(db, 'SELECT t1.b, COUNT(*) FROM t1 GROUP BY t1.b ORDER BY t1.b')).rows;
  const desc = (await q(db, 'SELECT t1.b, COUNT(*) FROM t1 GROUP BY t1.b ORDER BY t1.b DESC')).rows;
  ok('#183 qualified ORDER BY ASC', JSON.stringify(asc) === JSON.stringify([[null, 1], [10, 2], [20, 1]]), asc);
  ok('#183 qualified ORDER BY DESC', JSON.stringify(desc) === JSON.stringify([[20, 1], [10, 2], [null, 1]]), desc);
  db.stop();
}

async function csvRoundTrip() {
  const file = path.join(os.tmpdir(), 'jsql-csv-' + Date.now() + '.csv');
  fs.writeFileSync(file, 'id,name,note\r\n1,"a,b","line1\r\nline2"\r\n2, padded ,"he said ""hi"""\r\n', 'utf8');
  const db = new Database(':memory:');
  await q(db, 'CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT, note TEXT)');
  db.importCSV(file, 't');
  const rows = (await q(db, 'SELECT * FROM t')).rows;
  ok('#184 quoted newline', rows.length === 2 && rows[0][2] === 'line1\r\nline2', rows);
  ok('#184 quoted comma/quote', rows[0][1] === 'a,b' && rows[1][2] === 'he said "hi"', rows);
  ok('#184 unquoted spaces preserved', rows[1][1] === ' padded ', rows);

  const out = path.join(os.tmpdir(), 'jsql-csv-out-' + Date.now() + '.csv');
  db.exportCSV(out, 't');
  const db2 = new Database(':memory:');
  await q(db2, 'CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT, note TEXT)');
  db2.importCSV(out, 't');
  const rows2 = (await q(db2, 'SELECT * FROM t')).rows;
  ok('#184 export/import round-trip', JSON.stringify(rows2) === JSON.stringify(rows), rows2);
  db.stop(); db2.stop();
}

async function scalarFunctions() {
  const db = new Database(':memory:');
  const val = async (sql) => (await q(db, sql)).rows[0][0];
  ok('#185 YEARWEEK', await val("SELECT YEARWEEK('2026-11-21')") === 202646);
  ok('#185 WEEKOFYEAR', await val("SELECT WEEKOFYEAR('2026-11-21')") === 47);
  ok('#185 MID alias', await val("SELECT MID('abcdef',2,3)") === 'bcd');
  ok('#185 PERIOD_ADD', await val('SELECT PERIOD_ADD(202601,3)') === 202604);
  ok('#185 TIMESTAMP', await val("SELECT TIMESTAMP('2026-11-21','10:00:00')") === '2026-11-21 10:00:00');

  let err = null;
  try { await q(db, "SELECT UPPERR('abc')"); } catch (e) { err = e; }
  ok('#185 unknown function throws 1305', err && err.code === 1305 && /UPPERR/.test(err.message), err && err.message);

  await q(db, 'CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)');
  await q(db, "INSERT INTO t VALUES (1,'abc')");
  err = null;
  try { await q(db, "SELECT id FROM t WHERE SUBSTRNG(name,1,1)='a'"); } catch (e) { err = e; }
  ok('#185 unknown function in WHERE throws', err && err.code === 1305, err && err.message);
  db.stop();
}

async function limitExpressions() {
  const db = new Database(':memory:');
  await q(db, 'CREATE TABLE t (id INTEGER PRIMARY KEY)');
  await q(db, 'INSERT INTO t (id) VALUES (1),(2),(3),(4),(5)');

  for (const sql of [
    'SELECT id FROM t LIMIT 2+1',
    'SELECT id FROM t LIMIT 2 OFFSET 1+1',
    'SELECT id FROM t LIMIT 1.9',
    'SELECT id FROM t LIMIT ?',
  ]) {
    let err = null;
    try { await q(db, sql); } catch (e) { err = e; }
    ok('#186 rejects ' + sql, err && err.code === 1064, err && err.message);
  }

  ok('#186 LIMIT 2', JSON.stringify((await q(db, 'SELECT id FROM t LIMIT 2')).rows) === JSON.stringify([[1], [2]]));
  ok('#186 LIMIT 0,2', JSON.stringify((await q(db, 'SELECT id FROM t LIMIT 0,2')).rows) === JSON.stringify([[1], [2]]));
  ok('#186 LIMIT 2 OFFSET 1', JSON.stringify((await q(db, 'SELECT id FROM t LIMIT 2 OFFSET 1')).rows) === JSON.stringify([[2], [3]]));
  db.stop();
}

(async () => {
  await columnarSqlWrites();
  await subqueryMutations();
  await qualifiedGroupOrder();
  await csvRoundTrip();
  await scalarFunctions();
  await limitExpressions();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
