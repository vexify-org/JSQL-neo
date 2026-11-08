/*
 * Issue #48 — mysql_compat 把 FLOAT/DOUBLE 列的 result metadata 报成
 * LONGLONG(8)，客户端按类型解码会误判。
 *
 * 修复：整数 → 8 (LONGLONG)，非整数 → 5 (DOUBLE)。
 */
const path = require('path');
const { createConnection } = require(path.join(__dirname, '..', 'lib', 'mysql_compat.js'));

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('[OK]  ', name); }
  else { fail++; console.log('[FAIL]', name, extra !== undefined ? '-> ' + JSON.stringify(extra).slice(0, 300) : ''); }
}

(async () => {
  try {
    const conn = createConnection();
    await conn.connect();
    await conn.query('CREATE TABLE m (id INTEGER PRIMARY KEY, i INTEGER, d DOUBLE, s TEXT)');
    await conn.query("INSERT INTO m (id, i, d, s) VALUES (1, 42, 1.5, 'x')");

    const [rows, fields] = await conn.query('SELECT i, d, s FROM m');
    const typeOf = (name) => (fields.find(f => f.name === name) || {}).type;

    ok('#48 INTEGER 列仍为 LONGLONG(8)', typeOf('i') === 8, { i: typeOf('i'), rows });
    ok('#48 DOUBLE 列为 DOUBLE(5)', typeOf('d') === 5, { d: typeOf('d') });
    ok('#48 TEXT 列为 VAR_STRING(253)', typeOf('s') === 253, { s: typeOf('s') });
    ok('#48 行数据未受影响', rows.length === 1 && rows[0].i === 42 && rows[0].d === 1.5, rows);

    await conn.end();
  } catch (e) {
    fail++;
    console.log('[FAIL] unexpected exception:', e && e.stack || e);
  }

  console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed\n`);
  if (fail > 0) process.exit(1);
})();
