/*
 * Native (.node N-API) regression tests
 *   node test/native.test.js
 * Covers: NativeJSQL CRUD + flat row shape, shorthand/snake_case schemas,
 * disk persistence, and the better-sqlite3 compat layer on the native engine.
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const ROOT = path.join(__dirname, '..');

let passed = 0, failed = 0;
function ok(name, cond, extra) {
  if (cond) { passed++; console.log('[OK]', name); }
  else { failed++; console.log('[FAIL]', name, extra !== undefined ? JSON.stringify(extra) : ''); }
}

(async () => {
  const { JSQL } = require(path.join(ROOT, 'lib', 'native_client'));

  /* ---------- basic CRUD + flat row shape ---------- */
  {
    const db = new JSQL();
    await db.start();
    await db.createTable('users', { id: 'integer primary key auto_increment', name: 'string', age: 'integer' });
    const ids = await db.insert('users', [{ name: 'Alice', age: 30 }, { name: 'Bob', age: 25 }]);
    ok('batch insert returns ids', Array.isArray(ids) && ids.length === 2, ids);

    const row = db.findById('users', 1);
    ok('findById returns flat row', row && row.id === 1 && row.name === 'Alice' && row.age === 30 && !('fields' in row), row);

    const rows = await db.find('users', {});
    ok('find returns flat rows', rows.length === 2 && rows[1].name === 'Bob' && rows[1].id === 2, rows);
    ok('filter match', (await db.find('users', { age: 25 })).length === 1);
    ok('filter no match', (await db.find('users', { age: 99 })).length === 0);
    ok('count', (await db.count('users')) === 2);

    db.updateByIds('users', [[1, { age: 99 }]]);
    await new Promise(r => setTimeout(r, 150));
    ok('updateByIds applied', db.findById('users', 1).age === 99, db.findById('users', 1));

    db.removeByIds('users', [2]);
    await new Promise(r => setTimeout(r, 150));
    ok('removeByIds applied', (await db.count('users')) === 1, await db.count('users'));
    await db.stop();
  }

  /* ---------- shorthand and snake_case schemas ---------- */
  {
    const db = new JSQL();
    await db.start();
    await db.createTable('t2', { name: 'string unique', n: 'number', ok: 'boolean' });
    await db.insert('t2', { name: 'x', n: 1.5, ok: true });
    const r2 = (await db.find('t2', {}))[0];
    ok('shorthand schema fields', r2.name === 'x' && r2.n === 1.5 && r2.ok === true, r2);

    await db.createTable('t3', { id: { type: 'integer', primary_key: true, auto_increment: true }, name: { type: 'string' } });
    await db.insert('t3', { name: 'a' });
    await db.insert('t3', { id: 7, name: 'b' });
    ok('snake_case pk respected', db.findById('t3', 7).name === 'b', db.findById('t3', 7));
    ok('explicit pk bumps next id', db.findById('t3', 1).name === 'a');
    await db.stop();
  }

  /* ---------- disk persistence roundtrip ---------- */
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsql-native-'));
    const db = new JSQL({ path: dir, mode: 'disk' });
    await db.start();
    await db.createTable('p', { id: { type: 'integer', primaryKey: true, autoIncrement: true }, v: { type: 'string' } });
    await db.insert('p', { v: 'persisted' });
    await db.stop();
    const db2 = new JSQL({ path: dir, mode: 'disk' });
    await db2.start();
    ok('tables restored', db2.getTables().includes('p'));
    ok('rows persisted', (await db2.find('p', {}))[0].v === 'persisted', await db2.find('p', {}));
    await db2.stop();
  }

  /* ---------- better-sqlite3 compat on native engine ---------- */
  {
    const Database = require(path.join(ROOT, 'lib', 'sqlite_compat'));
    const db = new Database(':memory:', { engine: 'native' });
    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY AUTOINCREMENT, name STRING, age INTEGER)');
    const r = db.prepare('INSERT INTO t (name, age) VALUES (?, ?)').run('a', 1);
    ok('compat run returns changes', r.changes === 1 && r.lastInsertRowid === 1, r);
    db.prepare('INSERT INTO t (name, age) VALUES (?, ?)').run('b', 2);
    ok('compat select', db.prepare('SELECT * FROM t WHERE age = ?').get(1).name === 'a');
    db.prepare('UPDATE t SET age = 99 WHERE name = ?').run('b');
    ok('compat update', db.prepare('SELECT age FROM t WHERE name = ?').get('b').age === 99);
    db.exec('BEGIN');
    db.prepare('INSERT INTO t (name) VALUES (?)').run('tx');
    db.exec('ROLLBACK');
    ok('compat rollback', db.prepare('SELECT COUNT(*) AS n FROM t').get().n === 2);
    const buf = db.serialize();
    db.close();
    const db2 = new Database(':memory:', { engine: 'native' });
    db2.deserialize(buf);
    ok('compat serialize roundtrip', db2.prepare('SELECT COUNT(*) AS n FROM t').get().n === 2);
    db2.close();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(e => {
  console.error('[FATAL]', e.stack.split('\n').slice(0, 3).join('\n'));
  process.exit(1);
});