/*
 * WASM (.wasm) regression tests
 *   node test/wasm.test.js
 * Covers: JSQL CRUD + flat row shape, shorthand schemas, pk-aware by-id CRUD,
 * non-auto pk insert backfill, and beginTransaction / rollback / commit.
 */
const path = require('path');
const ROOT = path.join(__dirname, '..');

let passed = 0, failed = 0;
function ok(name, cond, extra) {
  if (cond) { passed++; console.log('[OK]', name); }
  else { failed++; console.log('[FAIL]', name, extra !== undefined ? JSON.stringify(extra) : ''); }
}

(async () => {
  const { JSQL } = require(path.join(ROOT, 'lib', 'wasm_client'));

  /* ---------- basic CRUD + flat row shape ---------- */
  {
    const db = new JSQL({ modules: false });
    await db.start();
    await db.createTable('users', { id: 'integer primary key auto_increment', name: 'string', age: 'integer' });
    const ids = await db.insert('users', [{ name: 'Alice', age: 30 }, { name: 'Bob', age: 25 }]);
    ok('wasm batch insert returns ids', Array.isArray(ids) && ids.length === 2, ids);

    const row = await db.findById('users', 1);
    ok('wasm findById flat row', row && row.id === 1 && row.name === 'Alice' && !('fields' in row), row);

    const rows = await db.find('users', {});
    ok('wasm find returns flat rows', rows.length === 2 && rows[1].name === 'Bob', rows);
    ok('wasm filter match', (await db.find('users', { age: 25 })).length === 1);
    ok('wasm count', (await db.count('users')) === 2);

    await db.updateById('users', 1, { age: 31 });
    ok('wasm updateById applied', (await db.findById('users', 1)).age === 31, await db.findById('users', 1));

    await db.updateByIds('users', [[2, { age: 99 }]]);
    ok('wasm updateByIds applied', (await db.findById('users', 2)).age === 99, await db.findById('users', 2));

    ok('wasm findByIds', (await db.findByIds('users', [1, 2])).length === 2);

    await db.removeById('users', 1);
    ok('wasm removeById applied', (await db.count('users')) === 1, await db.count('users'));

    await db.removeByIds('users', [2]);
    ok('wasm removeByIds applied', (await db.count('users')) === 0, await db.count('users'));
    await db.stop();
  }

  /* ---------- non-auto pk: id resolution by pk value ---------- */
  {
    const db = new JSQL({ modules: false });
    await db.start();
    await db.createTable('config', { key: { type: 'string', primaryKey: true }, value: 'string' });
    const ids = await db.insert('config', [{ key: 'a', value: '1' }, { key: 'b', value: '2' }]);
    ok('wasm non-auto pk insert returns pk values', JSON.stringify(ids) === JSON.stringify(['a', 'b']), ids);

    const a = await db.findById('config', 'a');
    ok('wasm findById resolves string pk', a && a.value === '1' && !('fields' in a), a);
    ok('wasm findById pk miss returns null', (await db.findById('config', 'nope')) === null);

    await db.updateById('config', 'b', { value: '22' });
    ok('wasm updateById resolves string pk', (await db.findById('config', 'b')).value === '22', await db.findById('config', 'b'));

    await db.removeById('config', 'a');
    ok('wasm removeById resolves string pk', (await db.count('config')) === 1, await db.count('config'));

    await db.removeByIds('config', ['b']);
    ok('wasm removeByIds resolves string pk', (await db.count('config')) === 0, await db.count('config'));
    await db.stop();
  }

  /* ---------- shorthand schema ---------- */
  {
    const db = new JSQL({ modules: false });
    await db.start();
    await db.createTable('t2', { name: 'string unique', n: 'number', ok: 'boolean' });
    await db.insert('t2', { name: 'x', n: 1.5, ok: true });
    const r2 = (await db.find('t2', {}))[0];
    ok('wasm shorthand schema fields', r2.name === 'x' && r2.n === 1.5 && r2.ok === true, r2);

    await db.createTable('cfg', 'key string primary key, value string');
    const cfgIds = await db.insert('cfg', { key: 'a', value: '1' });
    ok('wasm full shorthand string schema', cfgIds[0] === 'a' && (await db.findById('cfg', 'a')).value === '1', cfgIds);
    await db.stop();
  }

  /* ---------- transactions ---------- */
  {
    const db = new JSQL({ modules: false });
    await db.start();
    await db.createTable('tx', { id: 'integer primary key auto_increment', name: 'string' });
    await db.insert('tx', { name: 'n1' });
    await db.beginTransaction();
    await db.insert('tx', { name: 'n2' });
    await db.rollback();
    ok('wasm rollback reverts insert', (await db.count('tx')) === 1, await db.count('tx'));
    await db.beginTransaction();
    await db.insert('tx', { name: 'n3' });
    await db.commit();
    ok('wasm commit keeps insert', (await db.count('tx')) === 2, await db.count('tx'));
    await db.stop();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(e => {
  console.error('[FATAL]', e.stack.split('\n').slice(0, 3).join('\n'));
  process.exit(1);
});