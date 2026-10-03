/*
 * Query / B-Tree / exists / prepare 回归
 *   node test/query-opt.test.js
 */
const Database = require('../lib/database');
const BTree = require('../lib/btree');
const { executeSQL } = require('../lib/sql');
const { now } = require('../lib/date-types');

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

  {
    const pdb = new Database(':memory:');
    pdb.use('timestamps', { createdField: 'created_at', updatedField: 'updated_at' });
    pdb.createTable('notes', { id: { type: 'integer', primaryKey: true, autoIncrement: true }, title: { type: 'string' } });
    const schema = pdb.getTableSchema('notes');
    ok('use opts timestamps fields', !!(schema && schema.created_at && schema.updated_at), schema);
    pdb.insert('notes', { title: 'hello' });
    const row = pdb.notes.findOne({ title: 'hello' });
    ok('timestamps stamped', !!(row && row.created_at && row.updated_at), row);

    let afterInsertHits = 0;
    pdb.on('afterInsert', () => { afterInsertHits++; });
    pdb.insert('notes', { title: 'one' });
    ok('single-row afterInsert', afterInsertHits === 1, afterInsertHits);
    pdb.insert('notes', [{ title: 'a' }, { title: 'b' }]);
    ok('batch afterInsert', afterInsertHits === 2, afterInsertHits);
  }

  /* ============ BUG 修复: now() 时区 / 监控定时器 / insertMany 归一 & 不污染 ============ */
  {
    // BUG-1: now() 必须与 validateDate/DateTime 一致使用本地时区（此前用 toISOString=UTC）
    const savedTZ = process.env.TZ;
    process.env.TZ = 'Asia/Shanghai';
    try {
      const d = new Date();
      const p2 = n => String(n).padStart(2, '0');
      const localDate = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
      const localTime = `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
      ok('BUG-1 now("date") 本地时区', now('date') === localDate, { got: now('date'), want: localDate });
      ok('BUG-1 now("time") 本地时区', now('time') === localTime, { got: now('time'), want: localTime });
      ok('BUG-1 now() 本地时区', now() === `${localDate} ${localTime}`, { got: now(), want: `${localDate} ${localTime}` });
    } finally {
      if (savedTZ === undefined) delete process.env.TZ; else process.env.TZ = savedTZ;
    }

    // BUG-5: 内存监控定时器必须被 stop()/close() 清理
    const mdb = new Database(':memory:', { autoSave: false });
    await mdb.createTable('m', { id: 'integer' });
    mdb._startMonitor();
    ok('BUG-5 monitor 已启动', !!mdb._monitorTimer);
    await mdb.stop();
    ok('BUG-5 stop() 清理 monitorTimer', mdb._monitorTimer === null);
    mdb._startMonitor();
    mdb.close();
    ok('BUG-5 close() 清理 monitorTimer', mdb._monitorTimer === null);

    // BUG-6 / BUG-8: insertMany 在副本上归一，且不污染调用方对象
    const tdb = new Database(':memory:', { autoSave: false });
    await tdb.createTable('t', {
      id: { type: 'integer', primaryKey: true, autoIncrement: true },
      d: 'date', st: { type: 'string', default: 'x' }, age: 'integer'
    });
    const srcDate = new Date('2024-01-15T00:00:00Z');
    const caller = [{ d: srcDate, age: '25' }];
    const before = JSON.stringify(caller[0]);
    const ret = tdb.t.insertMany(caller);
    ok('BUG-6 insertMany 不污染调用方对象', JSON.stringify(caller[0]) === before, caller[0]);
    ok('BUG-6 insertMany 返回归一后的新数组', Array.isArray(ret) && ret !== caller && ret[0].st === 'x' && ret[0].id === 1, ret);
    const stored = tdb.t.find({})[0];
    ok('BUG-8 insertMany 归一年龄为 number', typeof stored.age === 'number' && stored.age === 25, stored.age);
    const p2 = n => String(n).padStart(2, '0');
    const wantDate = `${srcDate.getFullYear()}-${p2(srcDate.getMonth() + 1)}-${p2(srcDate.getDate())}`;
    ok('BUG-8 insertMany 归一日期为本地字符串', stored.d === wantDate, { got: stored.d, want: wantDate });

    // BUG-4: information_schema 过滤条件必须透传 ctx（@@会话变量）
    const idb = new Database(':memory:', { autoSave: false });
    await idb.createTable('ifx', { id: 'integer' });
    const ir = await executeSQL(idb, 'SELECT TABLE_NAME FROM information_schema.tables WHERE TABLE_NAME = @@tn', { session: { sysvars: { tn: 'ifx' } } });
    ok('BUG-4 information_schema WHERE 透传 ctx', ir.rows.length === 1 && ir.rows[0][0] === 'ifx', ir.rows);
  }

  console.log(failed === 0 ? `\nALL ${passed} QUERY-OPT TESTS PASSED` : `\n${failed} FAILURES (${passed} passed)`);
  process.exit(failed === 0 ? 0 : 1);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
