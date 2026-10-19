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

    const row = await db.findById('users', 1);
    ok('findById returns flat row', row && row.id === 1 && row.name === 'Alice' && row.age === 30 && !('fields' in row), row);

    const rows = await db.find('users', {});
    ok('find returns flat rows', rows.length === 2 && rows[1].name === 'Bob' && rows[1].id === 2, rows);
    ok('filter match', (await db.find('users', { age: 25 })).length === 1);
    ok('filter no match', (await db.find('users', { age: 99 })).length === 0);
    ok('count', (await db.count('users')) === 2);

    await db.updateByIds('users', [[1, { age: 99 }]]);
    await new Promise(r => setTimeout(r, 150));
    ok('updateByIds applied', (await db.findById('users', 1)).age === 99, await db.findById('users', 1));

    await db.removeByIds('users', [2]);
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
    ok('snake_case pk respected', (await db.findById('t3', 7)).name === 'b', await db.findById('t3', 7));
    ok('explicit pk bumps next id', (await db.findById('t3', 1)).name === 'a');

    await db.createTable('cfg', 'key string primary key, value string');
    const cfgIds = await db.insert('cfg', { key: 'a', value: '1' });
    ok('full shorthand string schema', cfgIds[0] === 'a' && (await db.findById('cfg', 'a')).value === '1', cfgIds);
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

  /* ---------- non-auto pk: id resolution by pk value ---------- */
  {
    const db = new JSQL();
    await db.start();
    await db.createTable('config', { key: { type: 'string', primaryKey: true }, value: 'string' });
    const ids = await db.insert('config', [{ key: 'a', value: '1' }, { key: 'b', value: '2' }]);
    ok('non-auto pk insert returns pk values', JSON.stringify(ids) === JSON.stringify(['a', 'b']), ids);

    const a = await db.findById('config', 'a');
    ok('findById resolves string pk', a && a.value === '1' && !('fields' in a), a);
    ok('findById pk miss returns null', await db.findById('config', 'nope') === null);

    await db.updateById('config', 'b', { value: '22' });
    await new Promise(r => setTimeout(r, 150));
    ok('updateById resolves string pk', (await db.findById('config', 'b')).value === '22', await db.findById('config', 'b'));

    await db.removeById('config', 'a');
    await new Promise(r => setTimeout(r, 150));
    ok('removeById resolves string pk', (await db.count('config')) === 1, await db.count('config'));

    await db.updateByIds('config', [['b', { value: '222' }]]);
    await new Promise(r => setTimeout(r, 150));
    ok('updateByIds resolves string pk', (await db.findById('config', 'b')).value === '222', await db.findById('config', 'b'));

    await db.removeByIds('config', ['b']);
    await new Promise(r => setTimeout(r, 150));
    ok('removeByIds resolves string pk', (await db.count('config')) === 0, await db.count('config'));
    await db.stop();
  }

  /* ---------- transaction aliases (beginTransaction / rollback / commit) ---------- */
  {
    const db = new JSQL();
    await db.start();
    await db.createTable('tx', { id: 'integer primary key auto_increment', name: 'string' });
    await db.insert('tx', { name: 'n1' });
    await db.beginTransaction();
    await db.insert('tx', { name: 'n2' });
    await db.rollback();
    ok('rollback reverts insert', (await db.count('tx')) === 1, await db.count('tx'));
    await db.beginTransaction();
    await db.insert('tx', { name: 'n3' });
    await db.commit();
    ok('commit keeps insert', (await db.count('tx')) === 2, await db.count('tx'));
    await db.stop();
  }

/* ---- schema 字段名下划线写法：两引擎必须一致（静默正确性 bug）---- */
/*
 * README 与官方示例用下划线写法（primary_key / auto_increment）。
 * native_client 交给 Rust 前会归一化，纯 JS 的 table.js 此前不认 ——
 * 结果纯 JS 下自增 id 根本不生成、find({id:1}) 永远空，且**不报任何错**。
 */
{
  const SNAKE = { id: { type: 'integer', primary_key: true, auto_increment: true }, name: { type: 'string' } };

  // native
  {
    const d = new JSQL();
    await d.start();
    await d.createTable('snk', SNAKE);
    await d.insert('snk', [{ name: 'a' }, { name: 'b' }]);
    await new Promise(r => setTimeout(r, 200));
    const rows = await d.find('snk', {});
    const first = rows.find(r => r.name === 'a');
    ok('schema 下划线写法 · native：自增 id 生成', !!(first && first.id !== undefined), rows);
    const got = await d.findById('snk', first && first.id);
    ok('schema 下划线写法 · native：findById 命中', !!(got && got.name === 'a'), got);
    await d.stop();
  }

  // pure JS
  {
    const Database = require(path.join(ROOT, 'lib', 'database'));
    const d = new Database(':memory:');
    await d.createTable('snk', SNAKE);
    await d.insert('snk', [{ name: 'a' }, { name: 'b' }]);
    const rows = await d.find('snk', {});
    const first = rows.find(r => r.name === 'a');
    ok('schema 下划线写法 · pure-js：自增 id 生成', !!(first && first.id !== undefined), rows);
    const got = await d.findById('snk', first && first.id);
    ok('schema 下划线写法 · pure-js：findById 命中', !!(got && got.name === 'a'), got);
  }
}
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(e => {
  console.error('[FATAL]', e.stack.split('\n').slice(0, 3).join('\n'));
  process.exit(1);
});