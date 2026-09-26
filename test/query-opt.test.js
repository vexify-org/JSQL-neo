/*
 * Query / B-Tree / exists / prepare 回归
 *   node test/query-opt.test.js
 */
const Database = require('../lib/database');
const BTree = require('../lib/btree');

let passed = 0, failed = 0;
function ok(name, cond, extra) {
  if (cond) { passed++; }
  else { failed++; console.log('[FAIL]', name, extra !== undefined ? '-> ' + JSON.stringify(extra) : ''); }
}

{
  const bt = new BTree(8);
  for (let i = 0; i < 80; i++) bt.insert(i, i);
  ok('search hit', JSON.stringify(bt.search(42)) === '[42]');
  ok('search miss', bt.search(999).length === 0);
  ok('searchMany', JSON.stringify(bt.searchMany([1, 5, 999, 5]).sort((a, b) => a - b)) === '[1,5]');
  ok('prefix numeric-as-string', bt.prefix('7').length > 0);
  ok('gte/gt', bt.greaterThanEqual(78).length === 2 && bt.greaterThan(78).length === 1);
  ok('lte/lt', bt.lessThanEqual(1).length === 2 && bt.lessThan(1).length === 1);
}

{
  const bt = new BTree(8);
  ['alice', 'albert', 'bob', 'carol', 'art'].forEach((n, i) => bt.insert(n, i));
  const hits = bt.prefix('al').sort((a, b) => a - b);
  ok('string prefix al', JSON.stringify(hits) === '[0,1]');
  ok('string prefix z', bt.prefix('z').length === 0);
}

{
  const db = new Database(':memory:');
  db.createTable('users', {
    id: { type: 'integer', primaryKey: true, autoIncrement: true },
    name: { type: 'string', unique: true },
    age: { type: 'integer' }
  });
  db.users.insertMany([
    { name: 'alice', age: 20 },
    { name: 'albert', age: 30 },
    { name: 'bob', age: 40 },
    { name: 'carol', age: 50 }
  ]);

  ok('table.exists true', db.users.exists({ name: 'bob' }) === true);
  ok('table.exists false', db.users.exists({ name: 'zack' }) === false);
  ok('db.exists true', db.exists('users', { age: { $gte: 50 } }) === true);
  ok('db.exists false', db.exists('users', { age: { $gt: 90 } }) === false);
  ok('query.exists', db.users.where({ age: { $lt: 25 } }).exists() === true);

  const inRows = db.users.find({ name: { $in: ['alice', 'carol', 'nope'] } });
  ok('$in via btree', inRows.length === 2 && inRows.every(r => r.name === 'alice' || r.name === 'carol'));

  const likeRows = db.users.find({ name: { $like: 'al%' } });
  ok('$like prefix via btree', likeRows.length === 2 && likeRows.every(r => r.name.startsWith('al')));

  const rangeRows = db.users.find({ age: { $gte: 30, $lte: 40 } });
  ok('range via btree', rangeRows.length === 2);

  const one = db.users.findOne({ name: 'bob' });
  ok('findOne no full clone', one && one.name === 'bob' && one.age === 40);
}

(async () => {
  const db = new Database(':memory:');
  db.createTable('users', {
    id: { type: 'integer', primaryKey: true, autoIncrement: true },
    name: { type: 'string' },
    age: { type: 'integer' }
  });
  db.users.insertMany([
    { name: 'alice', age: 20 },
    { name: 'bob', age: 40 }
  ]);

  const stmt = db.prepare('SELECT name, age FROM users WHERE age > ? ORDER BY age ASC');
  const r = await stmt.all([25]);
  ok('prepare.all columns', r && Array.isArray(r.columns) && r.columns.includes('name'));
  ok('prepare.all rows', r && r.rows && r.rows.length === 1 && (r.rows[0][0] === 'bob' || r.rows[0].name === 'bob'), r && r.rows);

  const first = await stmt.get(10);
  ok('prepare.get', first && (first.name === 'alice' || first[0] === 'alice'), first);

  const empty = await db.prepare('SELECT name FROM users WHERE name = ?').get('nope');
  ok('prepare.get empty', empty === null);

  console.log(failed === 0 ? `\nALL ${passed} QUERY-OPT TESTS PASSED` : `\n${failed} FAILURES (${passed} passed)`);
  process.exit(failed === 0 ? 0 : 1);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
