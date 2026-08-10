/*
 * Regression tests for SQL JOIN null-fill correctness.
 * Zero runtime dependencies (uses Node builtins + in-repo libs only).
 *
 *   node test/join.test.js
 *
 * Covers:
 *   J1 LEFT JOIN unmatched rows null-fill right-table qualified columns
 *   J2 RIGHT JOIN unmatched rows null-fill left-table qualified columns
 *   J3 INNER JOIN unaffected
 *   J4 unqualified column reference in JOIN
 *   J5 WHERE filtering on the null-filled side
 *   J6 self-join with table alias
 *   J7 chained joins
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

async function setup(db) {
  await executeSQL(db, 'CREATE TABLE a (id INT PRIMARY KEY, a_name STRING)');
  await executeSQL(db, 'CREATE TABLE b (id INT PRIMARY KEY, a_id INT, b_name STRING)');
  await executeSQL(db, "INSERT INTO a VALUES (1,'A1'),(2,'A2'),(3,'A3')");
  await executeSQL(db, "INSERT INTO b VALUES (10,2,'B2'),(20,99,'B99')");
}

(async () => {
  /* ============ J1 LEFT JOIN null-fill ============ */
  {
    const db = new Database(':memory:', { autoSave: false });
    await setup(db);
    const r = await executeSQL(db, 'SELECT a.id AS aid, a.a_name, b.id AS bid, b.b_name FROM a LEFT JOIN b ON a.id = b.a_id');
    const row1 = r.rows[0]; // a=1 unmatched
    ok('J1 left unmatched row', row1 && row1[0] === 1 && row1[1] === 'A1' && row1[2] === null && row1[3] === null, row1);
    const row3 = r.rows[2]; // a=3 unmatched
    ok('J1 second unmatched row', row3 && row3[0] === 3 && row3[2] === null, row3);
    const row2 = r.rows[1]; // matched
    ok('J1 matched row intact', row2 && row2[0] === 2 && row2[1] === 'A2' && row2[2] === 10 && row2[3] === 'B2', row2);
  }

  /* ============ J2 RIGHT JOIN null-fill ============ */
  {
    const db = new Database(':memory:', { autoSave: false });
    await setup(db);
    const r = await executeSQL(db, 'SELECT a.id AS aid, a.a_name, b.id AS bid, b.b_name FROM a RIGHT JOIN b ON a.id = b.a_id');
    const b99 = r.rows[1]; // b=20 unmatched (a_id=99)
    ok('J2 right unmatched row', b99 && b99[0] === null && b99[1] === null && b99[2] === 20 && b99[3] === 'B99', b99);
    const b2 = r.rows[0]; // matched
    ok('J2 matched row intact', b2 && b2[0] === 2 && b2[1] === 'A2' && b2[2] === 10 && b2[3] === 'B2', b2);
  }

  /* ============ J3 INNER JOIN ============ */
  {
    const db = new Database(':memory:', { autoSave: false });
    await setup(db);
    const r = await executeSQL(db, 'SELECT a.id AS aid, b.id AS bid FROM a INNER JOIN b ON a.id = b.a_id');
    ok('J3 inner join', r.rows.length === 1 && r.rows[0][0] === 2 && r.rows[0][1] === 10, r.rows);
  }

  /* ============ J4 unqualified reference ============ */
  {
    const db = new Database(':memory:', { autoSave: false });
    await setup(db);
    const r = await executeSQL(db, 'SELECT a.id AS aid, b.b_name FROM a LEFT JOIN b ON a.id = b.a_id');
    ok('J4 unprefixed id resolves to left table', r.rows[0][0] === 1 && r.rows[0][1] === null, r.rows[0]);
  }

  /* ============ J5 WHERE on null-filled side ============ */
  {
    const db = new Database(':memory:', { autoSave: false });
    await setup(db);
    const r = await executeSQL(db, "SELECT a.id AS aid, b.b_name FROM a LEFT JOIN b ON a.id = b.a_id WHERE b.id IS NULL");
    ok('J5 left where b.id IS NULL', r.rows.length === 2 && r.rows.every(x => x[1] === null), r.rows);
    const r2 = await executeSQL(db, "SELECT a.a_name, b.id AS bid FROM a RIGHT JOIN b ON a.id = b.a_id WHERE a.id IS NULL");
    ok('J5 right where a.id IS NULL', r2.rows.length === 1 && r2.rows[0][0] === null && r2.rows[0][1] === 20, r2.rows);
  }

  /* ============ J6 self-join with alias ============ */
  {
    const db = new Database(':memory:', { autoSave: false });
    await executeSQL(db, 'CREATE TABLE emp (id INT PRIMARY KEY, mgr_id INT, name STRING)');
    await executeSQL(db, "INSERT INTO emp VALUES (1,NULL,'boss'),(2,1,'alice'),(3,999,'orphan')");
    const r = await executeSQL(db, 'SELECT e.name AS ename, m.name AS mname FROM emp e LEFT JOIN emp m ON e.mgr_id = m.id');
    ok('J6 self left join', r.rows.length === 3 && r.rows[0][0] === 'boss' && r.rows[0][1] === null && r.rows[1][1] === 'boss' && r.rows[2][1] === null, r.rows);
  }

  /* ============ J7 chained joins ============ */
  {
    const db = new Database(':memory:', { autoSave: false });
    await executeSQL(db, 'CREATE TABLE a (id INT PRIMARY KEY, a_name STRING)');
    await executeSQL(db, 'CREATE TABLE b (id INT PRIMARY KEY, a_id INT, b_name STRING)');
    await executeSQL(db, 'CREATE TABLE c (id INT PRIMARY KEY, b_id INT, c_name STRING)');
    await executeSQL(db, "INSERT INTO a VALUES (1,'A1'),(2,'A2'),(3,'A3')");
    await executeSQL(db, "INSERT INTO b VALUES (10,2,'B2'),(20,99,'B99')");
    await executeSQL(db, "INSERT INTO c VALUES (100,10,'C10'),(200,77,'C77')");
    const r = await executeSQL(db, 'SELECT a.id AS aid, b.id AS bid, c.id AS cid, c.c_name FROM a LEFT JOIN b ON a.id = b.a_id LEFT JOIN c ON b.id = c.b_id');
    ok('J7 chained left joins', r.rows.length === 3 && r.rows[1][1] === 10 && r.rows[1][2] === 100 && r.rows[1][3] === 'C10' && r.rows[0][1] === null && r.rows[0][2] === null, r.rows);
  }

  console.log(failed === 0 ? `\nALL ${passed} JOIN TESTS PASSED` : `\n${failed} FAILURES (${passed} passed)`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
