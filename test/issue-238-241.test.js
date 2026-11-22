/*
 * Regression tests for issues #238-#241.
 *   node test/issue-238-241.test.js
 */
const path = require('path');
const ROOT = path.join(__dirname, '..');
const { formatDate, validateDateType } = require(path.join(ROOT, 'lib', 'date-types.js'));
const Cache = require(path.join(ROOT, 'lib', 'cache.js'));
const { JSQL } = require(path.join(ROOT, 'index.js'));

let passed = 0, failed = 0;
function ok(name, cond, extra) {
  if (cond) { passed++; console.log('[OK]', name); }
  else { failed++; console.log('[FAIL]', name, extra !== undefined ? '→ ' + JSON.stringify(extra) : ''); }
}

(async () => {
  // #238
  const f1 = formatDate('2024-01-02 13:45:59', 'YYYY-MM-DD HH:mm:ss HH');
  const f2 = formatDate('2024-01-02', 'YYYY YYYY');
  ok('#238 repeated format tokens all replaced', f1 === '2024-01-02 13:45:59 13' && f2 === '2024 2024', { f1, f2 });

  // #239
  const dates = ['0099-01-02', '0050-06-15', '0001-12-31'];
  let allOk = true;
  for (const s of dates) {
    try { if (validateDateType(s, 'date', 'd') !== s) allOk = false; } catch (e) { allOk = false; }
  }
  ok('#239 years 0001-0099 are valid', allOk);
  ok('#239 formatDate keeps low year', formatDate('0099-01-02', 'YYYY') === '0099', formatDate('0099-01-02', 'YYYY'));

  // #241
  {
    const c = new Cache();
    ['a*', 'ab', 'a?'].forEach(k => c.set(k, 1));
    const star = c.keys('a\\*');
    const qm = c.keys('a\\?');
    ok('#241 Cache.keys glob backslash escape', JSON.stringify(star) === JSON.stringify(['a*']) && JSON.stringify(qm) === JSON.stringify(['a?']), { star, qm });
    c.close();
  }

  // CSV literal \\N must not collapse to NULL
  {
    const fs = require('fs');
    const os = require('os');
    const { Database, migrate } = require(path.join(ROOT, 'index.js'));
    const db = new Database(':memory:');
    await db.query('CREATE TABLE t (id INTEGER PRIMARY KEY, s TEXT)', { safety: false });
    await db.query("INSERT INTO t VALUES (1,'\\\\N'),(2,NULL)", { safety: false });
    const csv = await migrate.exportTableToCSV(db, 't');
    const db2 = new Database(':memory:');
    await db2.query('CREATE TABLE t (id INTEGER PRIMARY KEY, s TEXT)', { safety: false });
    await migrate.importFromCSV(db2, 't', csv);
    const r = (await db2.query('SELECT * FROM t ORDER BY id', { safety: false })).rows;
    ok('CSV literal \\N round-trips without becoming NULL', JSON.stringify(r) === JSON.stringify([[1, '\\N'], [2, null]]), r);
    db.stop(); db2.stop();
  }

  // PG aborted transaction also rejects SET
  {
    const { Client } = (() => { try { return require(path.join(ROOT, 'node_modules', 'pg')); } catch (e) { return {}; } })();
    if (Client) {
      const { createPgServer } = require(path.join(ROOT, 'lib', 'pg_server.js'));
      const srv = createPgServer({ port: 0, host: '127.0.0.1', dataDir: ':memory:', noAuth: true });
      await new Promise((r) => srv.listen(r));
      const c = new Client({ host: '127.0.0.1', port: srv.address.port, user: 'root', database: 'app' });
      await c.connect();
      await c.query('BEGIN');
      try { await c.query('SELECT * FROM no_such_table'); } catch (e) { /* aborted */ }
      let code = null;
      try { await c.query('SET search_path=foo'); } catch (e) { code = e.code; }
      ok('PG aborted transaction rejects SET too', code === '25P02', code);
      await c.query('ROLLBACK');
      await c.end(); srv.close();
    } else {
      console.log('[SKIP] PG aborted SET (pg not installed)');
    }
  }

  // CSV BOM header
  {
    const { Database, migrate } = require(path.join(ROOT, 'index.js'));
    const db = new Database(':memory:');
    await db.query('CREATE TABLE t (id INTEGER PRIMARY KEY, s TEXT)', { safety: false });
    await migrate.importFromCSV(db, 't', '\uFEFFid,s\n1,hi\n');
    const r = (await db.query('SELECT * FROM t', { safety: false })).rows;
    ok('CSV BOM header is stripped', JSON.stringify(r) === JSON.stringify([[1, 'hi']]), r);
    db.stop();
  }

  // Redis valid text starting with the binary marker must round-trip
  {
    const net = require('net');
    const { createRedisServer } = require(path.join(ROOT, 'lib', 'redis_server.js'));
    const srv = createRedisServer({ port: 0, dataDir: null });
    await new Promise((r) => srv.listen(r));
    const sock = net.connect(srv.server.address().port, '127.0.0.1');
    await new Promise((r) => sock.on('connect', r));
    const chunks = [];
    sock.on('data', (c) => chunks.push(c));
    const val = Buffer.from('\u0001hello', 'utf8');
    sock.write(Buffer.concat([Buffer.from('*3\r\n$3\r\nSET\r\n$1\r\nk\r\n$' + val.length + '\r\n'), val, Buffer.from('\r\n')]));
    sock.write(Buffer.from('*2\r\n$3\r\nGET\r\n$1\r\nk\r\n'));
    await new Promise((r) => setTimeout(r, 120));
    const out = Buffer.concat(chunks);
    const at = out.indexOf('$' + val.length + '\r\n');
    ok('Redis leading \\u0001 text is not treated as binary', at >= 0 && out.slice(at + 3 + String(val.length).length, at + 3 + String(val.length).length + val.length).equals(val), out.toString('hex'));
    sock.end(); srv.stop();
  }

  // Mongo unique index must also block UPDATE to a duplicate key
  {
    const { createMongoServer } = require(path.join(ROOT, 'lib', 'mongo_server.js'));
    const mongo = createMongoServer({ dataDir: ':memory:' });
    await mongo._dispatch('createIndexes', { createIndexes: 'c', indexes: [{ key: { email: 1 }, name: 'email_1', unique: true }], $db: 'test' });
    await mongo._dispatch('insert', { insert: 'c', documents: [{ email: 'a@x.com' }, { email: 'b@x.com' }], $db: 'test' });
    const upd = await mongo._dispatch('update', { update: 'c', updates: [{ q: { email: 'b@x.com' }, u: { $set: { email: 'a@x.com' } } }], $db: 'test' });
    ok('Mongo unique index enforced on UPDATE', upd.ok === 0, upd);
  }

  // #240
  {
    const db = new JSQL();
    await db.start();
    await db.createTable('t', {
      id: { type: 'integer', primaryKey: true },
      v: { type: 'integer' },
      s: { type: 'string' },
    });
    await db.insert('t', { id: 1, v: 10, s: 'aa' });
    await db.insert('t', { id: 2, v: 20, s: 'bb' });
    const sum = await db.query('SELECT SUM(v) AS s FROM t');
    const avg = await db.query('SELECT AVG(v) AS v FROM t');
    const count = await db.query('SELECT COUNT(*) AS c FROM t');
    const plain = await db.query('SELECT s FROM t');
    ok('#240 aggregate column types do not use alias', sum.columnTypes[0] !== 'VARCHAR(255)' && avg.columnTypes[0] !== 'INT', { sum: sum.columnTypes, avg: avg.columnTypes });
    ok('#240 COUNT is INT', count.columnTypes[0] === 'INT', count.columnTypes);
    ok('#240 plain string column type', plain.columnTypes[0] === 'VARCHAR(255)', plain.columnTypes);
    await db.stop();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
