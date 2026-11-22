/*
 * Regression tests for #279 #282 #296 #297 #306.
 *   node test/issue-279-306.test.js
 */
const path = require('path');
const ROOT = path.join(__dirname, '..');
const SqliteDatabase = require(path.join(ROOT, 'lib', 'sqlite_compat.js'));
const { createMongoServer } = require(path.join(ROOT, 'lib', 'mongo_server.js'));

let passed = 0, failed = 0;
function ok(name, cond, extra) {
  if (cond) { passed++; console.log('[OK]', name); }
  else { failed++; console.log('[FAIL]', name, extra !== undefined ? '→ ' + JSON.stringify(extra) : ''); }
}

(async () => {
  // #296
  {
    const db = new SqliteDatabase(':memory:');
    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT, score REAL)');
    const cols = db.prepare('SELECT * FROM t').columns();
    const byName = Object.fromEntries(cols.map(c => [c.name, c.type]));
    ok('#296 sqlite columns() reports declared types', byName.id === 'INTEGER' && byName.name === 'TEXT' && byName.score === 'REAL', byName);
    db.close();
  }
  // #297
  {
    const db = new SqliteDatabase(':memory:');
    let e1 = null, e2 = null;
    try { db.exec(''); } catch (e) { e1 = e.message; }
    try { db.exec('   \n  '); } catch (e) { e2 = e.message; }
    ok('#297 empty and whitespace exec are both no-op', e1 === null && e2 === null, { e1, e2 });
    db.close();
  }
  // #306
  {
    const mysql = (() => { try { return require(path.join(ROOT, 'node_modules', 'mysql2/promise')); } catch (e) { return null; } })();
    if (mysql) {
      const { createMysqlServer } = require(path.join(ROOT, 'lib', 'mysql_server.js'));
      const srv = createMysqlServer({ port: 0, host: '127.0.0.1', dataDir: ':memory:', noAuth: true });
      await new Promise((r) => srv.listen(r));
      const conn = await mysql.createConnection({ host: '127.0.0.1', port: srv.address.port, user: 'root', database: 'app' });
      await conn.query('CREATE TABLE t (id INT)');
      const [, fields] = await conn.query('SELECT id FROM t');
      ok('#306 ColumnDefinition schema is database name', fields[0].schema === 'app' && fields[0].table === 't', { schema: fields[0].schema, table: fields[0].table });
      await conn.end();
      srv.close();
    } else {
      console.log('[SKIP] MySQL column schema (mysql2 not installed)');
    }
  }
  // #279
  {
    const mongo = createMongoServer({ dataDir: ':memory:' });
    const d = (cmd, doc) => mongo._dispatch(cmd, doc);
    await d('insert', { insert: 'c', documents: [{ _id: 1, tags: ['a', 'b'] }], $db: 'test' });
    await d('update', {
      update: 'c', $db: 'test',
      updates: [{ q: { _id: 1 }, u: { $push: { tags: { $each: ['x', 'y'], $position: 1, $slice: 3 } } } }],
    });
    const r = await d('find', { find: 'c', filter: { _id: 1 }, $db: 'test' });
    const tags = r.cursor.firstBatch[0].tags;
    ok('#279 $push honors $position and $slice', JSON.stringify(tags) === JSON.stringify(['a', 'x', 'y']), tags);
  }
  // #282
  {
    const mongo = createMongoServer({ dataDir: ':memory:' });
    const d = (cmd, doc) => mongo._dispatch(cmd, doc);
    await d('insert', { insert: 'u', documents: [{ _id: 1, b: 2 }], $db: 'test' });
    const r = await d('aggregate', { aggregate: 'u', pipeline: [{ $unwind: '$b' }], cursor: {}, $db: 'test' });
    const batch = r.cursor.firstBatch;
    ok('#282 $unwind keeps scalar field document', batch.length === 1 && batch[0].b === 2, batch);
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
