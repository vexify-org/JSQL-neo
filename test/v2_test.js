// jsql-neo v2.0.0 综合测试
const jsql = require('../index.js');
const db = new jsql.Database(':memory:');
let pass = 0, fail = 0;

function test(name, fn) {
  try { fn(); pass++; console.log('  PASS:', name); }
  catch(e) { fail++; console.log('  FAIL:', name, '-', e.message); }
}

console.log('=== jsql-neo v2.0.0 综合测试 ===\n');

// 1. B-Tree 自动索引
test('B-Tree auto-create on primaryKey', () => {
  db.createTable('users', { id: { type: 'integer', primaryKey: true, autoIncrement: true }, name: { type: 'string' }, email: { type: 'string', unique: true } });
  if (Object.keys(db.users._btrees).length !== 2) throw new Error('Expected 2 B-Trees');
});

// 2. 插入 & B-Tree 查询
test('Insert and findById', () => {
  db.users.insert({ name: 'Alice', email: 'a@test.com' });
  const r = db.users.findById(1);
  if (r.name !== 'Alice') throw new Error('Wrong name');
});

// 3. NOT NULL
test('NOT NULL constraint', () => {
  db.createTable('t1', { id: { type: 'integer', primaryKey: true, autoIncrement: true }, name: { type: 'string', required: true } });
  try { db.t1.insert({}); throw new Error('Should have thrown'); }
  catch(e) { if (e.code !== 1048) throw new Error('Wrong error code: ' + e.code); }
});

// 4. UNIQUE
test('UNIQUE constraint', () => {
  db.createTable('tu', { id: { type: 'integer', primaryKey: true, autoIncrement: true }, code: { type: 'string', unique: true } });
  db.tu.insert({ code: 'ABC' });
  try { db.tu.insert({ code: 'ABC' }); throw new Error('Should have thrown'); }
  catch(e) { if (e.code !== 1062) throw new Error('Wrong error code: ' + e.code); }
});

// 5. CHECK
test('CHECK constraint', () => {
  db.createTable('t2', { id: { type: 'integer', primaryKey: true, autoIncrement: true }, age: { type: 'integer', check: v => v >= 18 } });
  try { db.t2.insert({ age: 15 }); throw new Error('Should have thrown'); }
  catch(e) { if (e.code !== 3819) throw new Error('Wrong error code: ' + e.code); }
});

// 6. 日期类型
test('DATE type validation', () => {
  db.createTable('t3', { id: { type: 'integer', primaryKey: true, autoIncrement: true }, eventDate: { type: 'date' } });
  db.t3.insert({ eventDate: '2026-01-15' });
  try { db.t3.insert({ eventDate: 'bad' }); throw new Error('Should have thrown'); }
  catch(e) { if (e.code !== 1292) throw new Error('Wrong error code: ' + e.code); }
});

// 7. DATETIME type
test('DATETIME type validation', () => {
  db.createTable('t4', { id: { type: 'integer', primaryKey: true, autoIncrement: true }, ts: { type: 'datetime' } });
  db.t4.insert({ ts: '2026-01-15 12:30:00' });
  try { db.t4.insert({ ts: 'bad' }); throw new Error('Should have thrown'); }
  catch(e) { if (e.code !== 1292) throw new Error('Wrong error code: ' + e.code); }
});

// 8. 外键 CASCADE
test('Foreign key CASCADE delete', () => {
  db.createTable('posts', { id: { type: 'integer', primaryKey: true, autoIncrement: true }, title: { type: 'string' }, userId: { type: 'integer', foreignKey: { table: 'users', field: 'id', onDelete: 'cascade' } } });
  db.posts.insert({ title: 'P1', userId: 1 });
  db.posts.insert({ title: 'P2', userId: 1 });
  db.users.remove({ id: 1 });
  if (db.posts.count() !== 0) throw new Error('Expected 0 posts after cascade, got ' + db.posts.count());
});

// 9. 外键 SET NULL
test('Foreign key SET NULL', () => {
  db.users.insert({ name: 'Bob', email: 'b@test.com' });
  db.createTable('logs', { id: { type: 'integer', primaryKey: true, autoIncrement: true }, msg: { type: 'string' }, userId: { type: 'integer', foreignKey: { table: 'users', field: 'id', onDelete: 'set null' } } });
  db.logs.insert({ msg: 'Log1', userId: 2 });
  db.users.remove({ id: 2 });
  if (db.logs.findAll()[0].userId !== null) throw new Error('Expected null userId, got ' + db.logs.findAll()[0].userId);
});

// 10. JOIN 字符串表名
test('JOIN with string table name', () => {
  db.users.insert({ name: 'Charlie', email: 'c@test.com' });
  db.posts.insert({ title: 'CP1', userId: 3 });
  const r = db.posts.where({}).join('users', 'userId', 'id', 'author').get();
  if (r.length !== 1 || r[0].author_name !== 'Charlie') throw new Error('JOIN failed: ' + JSON.stringify(r));
});

// 11. LEFT JOIN (valid data only, FK prevents unmatched)
test('LEFT JOIN with string', () => {
  db.users.insert({ name: 'Dave', email: 'd@test.com' });
  db.posts.insert({ title: 'DP1', userId: 4 });
  const r = db.posts.where({}).leftJoin('users', 'userId', 'id', 'author').get();
  // CP1 (userId=3) + DP1 (userId=4) = 2 rows
  if (r.length !== 2) throw new Error('Expected 2 rows, got ' + r.length);
  if (r[0].author_name !== 'Charlie' && r[1].author_name !== 'Charlie') throw new Error('Charlie not found');
  if (r[0].author_name !== 'Dave' && r[1].author_name !== 'Dave') throw new Error('Dave not found');
});

// 12. 哈希 JOIN
test('Hash JOIN optimization', () => {
  for (let i = 0; i < 200; i++) db.users.insert({ name: 'U' + i, email: 'u' + i + '@test.com' });
  for (let i = 0; i < 200; i++) db.posts.insert({ title: 'P' + i, userId: 3 });
  // posts: CP1 + DP1 + 200 new = 202, all matching users
  const r = db.posts.where({}).useHashJoin().join('users', 'userId', 'id', 'author').get();
  if (r.length !== 202) throw new Error('Hash JOIN count mismatch: expected 202, got ' + r.length);
});

// 13. 事务隔离 REPEATABLE_READ
test('REPEATABLE_READ isolation', () => {
  db.t1.insert({ name: 'Base' });
  const before = db.t1.count();
  db.begin('REPEATABLE_READ');
  db.t1.insert({ name: 'Tx' });
  if (db.t1.count() !== before + 1) throw new Error('Expected ' + (before + 1) + ' in tx, got ' + db.t1.count());
  db.rollback();
  if (db.t1.count() !== before) throw new Error('Expected ' + before + ' after rollback, got ' + db.t1.count());
});

// 14. 事务隔离 READ_COMMITTED
test('READ_COMMITTED isolation', () => {
  const before = db.t1.count();
  db.begin();
  db.t1.insert({ name: 'Tx2' });
  db.commit();
  if (db.t1.count() !== before + 1) throw new Error('Expected ' + (before + 1) + ' after commit, got ' + db.t1.count());
});

// 15. 事务错误处理 (numeric error codes)
test('Transaction error handling', () => {
  db.begin();
  try { db.begin(); throw new Error('Should have thrown'); }
  catch(e) {
    if (e.code !== 1568) throw new Error('Wrong error code for double begin: ' + e.code);
    // clean up the first transaction
    db.rollback();
  }
  try { db.commit(); throw new Error('Should have thrown'); }
  catch(e) {
    if (e.code !== 1569) throw new Error('Wrong error code for commit without begin: ' + e.code);
  }
});

// 16. JSQL_Error
test('JSQL_Error class', () => {
  const e = new jsql.JSQL_Error('ERR_TEST', 'test msg', { detail: 'extra' });
  if (e.code !== 'ERR_TEST' || e.message !== 'test msg') throw new Error('Error props wrong');
  const json = e.toJSON();
  if (json.code !== 'ERR_TEST') throw new Error('toJSON wrong');
});

// 17. EXPLAIN
test('EXPLAIN with B-Tree', () => {
  const plan = db.users.where({ id: 3 }).explain().get();
  if (!plan.hasBTree || plan.indexUsed !== 'id') throw new Error('B-Tree not detected: ' + JSON.stringify(plan));
});

// 18. DISTINCT
test('DISTINCT', () => {
  db.createTable('t5', { id: { type: 'integer', primaryKey: true, autoIncrement: true }, val: { type: 'integer' } });
  db.t5.insert({ val: 1 }); db.t5.insert({ val: 2 }); db.t5.insert({ val: 1 });
  const r = db.t5.where({}).select('val').distinct('val').get();
  if (r.length !== 2) throw new Error('DISTINCT count wrong: ' + r.length);
});

// 19. 慢查询日志
test('Slow query log', () => {
  db.setSlowQueryThreshold(1);
  db._logSlowQuery('TEST', 50, 100);
  db._logSlowQuery('TEST2', 200, 500);
  if (db.getSlowQueries().length !== 2) throw new Error('Slow query count wrong: ' + db.getSlowQueries().length);
  db.clearSlowQueries();
  if (db.getSlowQueries().length !== 0) throw new Error('Clear failed');
  db.setSlowQueryThreshold(100);
});

// 20. stats
test('stats()', () => {
  const s = db.stats();
  if (s.totalBTrees === 0) throw new Error('No B-Trees in stats');
  if (!s.isolationLevel) throw new Error('No isolation in stats');
});

// 21. B-Tree range query
test('B-Tree range query', () => {
  db.createTable('t6', { id: { type: 'integer', primaryKey: true, autoIncrement: true }, score: { type: 'integer' } });
  db.t6.createBTreeIndex('score');
  for (let i = 0; i < 100; i++) db.t6.insert({ score: i });
  const r = db.t6.where({ score: { '$gte': 50, '$lte': 59 } }).get();
  if (r.length !== 10) throw new Error('Range query count wrong: ' + r.length);
});

// 22. Length validation
test('String length validation', () => {
  db.createTable('t7', { id: { type: 'integer', primaryKey: true, autoIncrement: true }, code: { type: 'string', length: 5 } });
  db.t7.insert({ code: 'abc' });
  try { db.t7.insert({ code: 'abcdef' }); throw new Error('Should have thrown'); }
  catch(e) { if (e.code !== 1406) throw new Error('Wrong error: ' + e.code); }
});

// 23. ALTER TABLE
test('ALTER TABLE addColumn', () => {
  db.t7.addColumn('status', { type: 'string', default: 'active' });
  if (db.t7.findAll()[0].status !== 'active') throw new Error('Default not applied');
});

// 24. toSQL
test('toSQL', () => {
  const sql = db.users.where({ age: { '$gte': 18 } }).orderBy('name').limit(10).toSQL();
  if (!sql.includes('SELECT') || !sql.includes('LIMIT 10')) throw new Error('toSQL wrong: ' + sql);
});

// 25. Query optimizer hints
test('Query optimizer hints', () => {
  const q = db.posts.where({}).useHashJoin().join('users', 'userId', 'id');
  if (!q._optimizerHints.useHashJoin) throw new Error('useHashJoin not set');
  const q2 = db.posts.where({}).useNestedLoop().join('users', 'userId', 'id');
  if (q2._optimizerHints.useHashJoin !== false) throw new Error('useNestedLoop not set');
});

// 26. ErrorCodes export
test('ErrorCodes export', () => {
  if (Object.keys(jsql.ErrorCodes).length < 20) throw new Error('Too few error codes: ' + Object.keys(jsql.ErrorCodes).length);
});

// 27. BTree module export
test('BTree module export', () => {
  const tree = new jsql.BTree(4);
  tree.insert(10, 0);
  if (tree.search(10).length !== 1) throw new Error('BTree search failed');
});

// 28. Isolation level set/get
test('Isolation level API', () => {
  db.setIsolationLevel('REPEATABLE_READ');
  if (db.getIsolationLevel() !== 'REPEATABLE_READ') throw new Error('setIsolationLevel failed: got ' + db.getIsolationLevel());
  db.setIsolationLevel('READ_COMMITTED');
  if (db.getIsolationLevel() !== 'READ_COMMITTED') throw new Error('reset failed: got ' + db.getIsolationLevel());
  try { db.setIsolationLevel('SERIALIZABLE'); throw new Error('Should have thrown'); }
  catch(e) { if (e.code !== 1235) throw new Error('Wrong error: ' + e.code); }
});

// 29. WAL mode (memory mode skips WAL)
test('WAL disabled in memory mode', () => {
  if (db._walEnabled) throw new Error('WAL should be disabled in memory mode');
});

// 30. File lock disabled in memory mode
test('File lock disabled in memory mode', () => {
  if (db._fileLockEnabled) throw new Error('File lock should be disabled in memory mode');
});

console.log('\n=== ' + pass + '/' + (pass+fail) + ' 测试通过 ===');
if (fail > 0) process.exit(1);