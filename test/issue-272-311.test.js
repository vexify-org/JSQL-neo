/*
 * Regression tests for #272 #274 #308 #309 #311.
 *   node test/issue-272-311.test.js
 */
const path = require('path');
const ROOT = path.join(__dirname, '..');

let passed = 0, failed = 0;
function ok(name, cond, extra) {
  if (cond) { passed++; console.log('[OK]', name); }
  else { failed++; console.log('[FAIL]', name, extra !== undefined ? '→ ' + JSON.stringify(extra) : ''); }
}

(async () => {
  const mysql = (() => { try { return require(path.join(ROOT, 'node_modules', 'mysql2/promise')); } catch (e) { return null; } })();
  if (mysql) {
    const { createMysqlServer } = require(path.join(ROOT, 'lib', 'mysql_server.js'));
    const srv = createMysqlServer({ port: 0, host: '127.0.0.1', dataDir: ':memory:', noAuth: true });
    await new Promise((r) => srv.listen(r));
    const conn = await mysql.createConnection({ host: '127.0.0.1', port: srv.address.port, user: 'root' });
    await conn.query('CREATE DATABASE IF NOT EXISTS app'); await conn.query('USE app');
    // #274
    let missing = null;
    try { await conn.query('SELECT * FROM no_such_table'); } catch (e) { missing = e; }
    ok('#274 missing table errno/sqlstate', missing && missing.errno === 1146 && missing.sqlState === '42S02', missing && { errno: missing.errno, state: missing.sqlState });
    // #272
    try { await conn.changeUser({ database: 'bad/name' }); } catch (e) { /* expected */ }
    let alive = null;
    try { await conn.query('SELECT 1 AS x'); alive = 1; } catch (e) { alive = e.message; }
    ok('#272 invalid COM_INIT_DB keeps connection alive', alive === 1, alive);
    await conn.end();
    srv.close();
  } else {
    console.log('[SKIP] MySQL protocol tests (mysql2 not installed)');
  }

  // #311 boolean typlen = 1
  {
    const { buildRowDescription, buildParameterDesc } = require(path.join(ROOT, 'lib', 'pg_server.js'));
    const buf = buildRowDescription(['b'], ['boolean']);
    // frame: type(1)+len(4)+count(2)+name('b'+nul=2)+tableoid(4)+attnum(2)+typeoid(4)+typlen(2)
    const typlen = buf.readInt16BE(5 + 2 + 2 + 4 + 2 + 4);
    ok('#311 PG boolean typlen is 1', typlen === 1, typlen);
    // #309 builder emits paramCount=0 for empty list
    const pd = buildParameterDesc([]);
    ok('#309 ParameterDescription has zero params', pd.readInt16BE(5) === 0, pd.readInt16BE(5));
  }

  // #308 DDL tag (pg driver exposes only the leading word, so check it is not "OK")
  {
    const { Client } = (() => { try { return require(path.join(ROOT, 'node_modules', 'pg')); } catch (e) { return {}; } })();
    if (Client) {
      const { createPgServer } = require(path.join(ROOT, 'lib', 'pg_server.js'));
      const srv = createPgServer({ port: 0, host: '127.0.0.1', dataDir: ':memory:', noAuth: true });
      await new Promise((r) => srv.listen(r));
      const c = new Client({ host: '127.0.0.1', port: srv.address.port, user: 'root', database: 'app' });
      await c.connect();
      const r = await c.query('CREATE TABLE t (id INT)');
      ok('#308 PG DDL CommandComplete tag is statement type', r.command === 'CREATE', r.command);
      await c.end();
      srv.close();
    } else {
      console.log('[SKIP] PG DDL tag (pg not installed)');
    }
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
