/* 回归测试：issue #138-#156 */
const path = require('path');
const ROOT = path.join(__dirname, '..');
const { Database, executeSQL } = require(path.join(ROOT, 'index.js'));
const Cache = require(path.join(ROOT, 'lib', 'cache.js'));
const SqliteDb = require(path.join(ROOT, 'lib', 'sqlite_compat.js'));
const { createMongoServer } = require(path.join(ROOT, 'lib', 'mongo_server.js'));

let pass = 0, fail = 0;
function ok(name, cond, got) {
  if (cond) { pass++; console.log('[OK]   ' + name); }
  else { fail++; console.log('[FAIL] ' + name + ' -> ' + JSON.stringify(got)); }
}

async function main() {
  const stub = { hasTable: () => true, truncate: async () => {}, flush: async () => {}, find: async () => [], getTableSchema: async () => ({}) };
  const q = async (sql) => (await executeSQL(stub, sql, { safety: false })).rows[0][0];

  // ---------- SQL ----------
  ok('#140 %j 补零', await q("SELECT DATE_FORMAT('2024-03-05','%j')") === '065');
  ok('#140 %j 闰年', await q("SELECT DATE_FORMAT('2024-12-31','%j')") === '366');
  ok('#139 JSON_TYPE 大写', await q("SELECT JSON_TYPE('{\"a\":1}')") === 'OBJECT');
  ok('#139 JSON_DEPTH 扁平为 2', await q("SELECT JSON_DEPTH('{\"a\":1}')") === 2);
  ok('#148 INET_NTOA 负数 NULL', await q('SELECT INET_NTOA(-1)') === null);
  ok('#148 INET_NTOA 越界 NULL', await q('SELECT INET_NTOA(4294967296)') === null);
  ok('#148 INET_NTOA 合法', await q('SELECT INET_NTOA(2130706433)') === '127.0.0.1');
  ok('#149 ADDDATE(date,N)', await q("SELECT ADDDATE('2024-01-15',10)") === '2024-01-25');
  ok('#149 SUBDATE(date,N)', await q("SELECT SUBDATE('2024-01-15',10)") === '2024-01-05');
  ok('#141 STRCMP', await q("SELECT STRCMP('a','b')") === -1 && await q("SELECT STRCMP('a','a')") === 0);
  ok('#141 JSON_ARRAY_APPEND', JSON.stringify(await q("SELECT JSON_ARRAY_APPEND('{\"a\":[1]}','$.a',2)")) === '{"a":[1,2]}');
  ok('#141 JSON_ARRAY_INSERT', JSON.stringify(await q("SELECT JSON_ARRAY_INSERT('{\"a\":[1,3]}','$.a[1]',2)")) === '{"a":[1,2,3]}');
  ok('#142 中缀 MOD', await q('SELECT 5 MOD 2') === 1 && await q('SELECT 5 MOD 2 * 3') === 3);

  const db = new Database(':memory:');
  await executeSQL(db, 'CREATE TABLE t (id INT PRIMARY KEY, v TEXT, a INT, b INT)', { safety: false });
  await executeSQL(db, 'CREATE UNIQUE INDEX uv ON t(v)', { safety: false });
  await executeSQL(db, "INSERT INTO t (id,v) VALUES (1,'a')", { safety: false });
  let dup = null;
  try { await executeSQL(db, "INSERT INTO t (id,v) VALUES (2,'a')", { safety: false }); } catch (e) { dup = e; }
  // #305：唯一冲突统一用 MySQL 的 ER_DUP_ENTRY(1062) 模板，
  // 消息形态为 "Duplicate entry 'x' for key 'y'"（不再二次格式化）。
  ok('#138 唯一索引插入重复报错', !!dup && dup.code === 1062 && /Duplicate entry/.test(dup.message),
    dup && dup.message);
  await executeSQL(db, "INSERT INTO t (id,v) VALUES (2,'b')", { safety: false });
  let updErr = null;
  try { await executeSQL(db, "UPDATE t SET v='b' WHERE id=1", { safety: false }); } catch (e) { updErr = e; }
  ok('#138 唯一索引更新到重复报错', !!updErr && /Duplicate entry/.test(updErr.message), updErr && updErr.message);
  await executeSQL(db, 'CREATE UNIQUE INDEX uab ON t(a,b)', { safety: false });
  await executeSQL(db, 'INSERT INTO t (id,a,b) VALUES (3,1,1)', { safety: false });
  let cdup = null;
  try { await executeSQL(db, 'INSERT INTO t (id,a,b) VALUES (4,1,1)', { safety: false }); } catch (e) { cdup = e; }
  ok('#138 复合唯一索引重复报错', !!cdup);
  const db2 = new Database(':memory:');
  await executeSQL(db2, 'CREATE TABLE n (x INT)', { safety: false });
  await executeSQL(db2, 'INSERT INTO n VALUES (7),(3)', { safety: false });
  const bits = (await executeSQL(db2, 'SELECT BIT_AND(x) a, BIT_OR(x) o, BIT_XOR(x) x FROM n', { safety: false })).rows[0];
  ok('#141 BIT_AND/OR/XOR', bits[0] === 3 && bits[1] === 7 && bits[2] === 4, bits);

  // ---------- Redis ----------
  const c = new Cache();
  let err = null;
  try { c.incrby('x', 1.5); } catch (e) { err = e; }
  ok('#143 INCRBY 小数报错', !!err && /not an integer/.test(err.message));
  c.set('z', '3.5');
  err = null;
  try { c.incr('z'); } catch (e) { err = e; }
  ok('#143 INCR 小数值报错', !!err);
  c.set('big', '9223372036854775807');
  err = null;
  try { c.incrby('big', 1); } catch (e) { err = e; }
  ok('#143 溢出报错', !!err && /overflow/.test(err.message));
  ok('#143 正常整数递增', c.incr('n') === 1 && c.incrby('n', 5) === 6 && c.decrby('n', 2) === 4);
  c.set('e', 'v');
  err = null;
  try { c.expire('e', 1.5); } catch (e) { err = e; }
  ok('#144 EXPIRE 小数报错', !!err);
  const l = new Cache();
  l.rpush('l', 'a', 'b', 'c');
  ok('#145 LRANGE 双越界负索引', JSON.stringify(l.lrange('l', -100, -50)) === '[]');
  ok('#145 LRANGE 正常负索引', JSON.stringify(l.lrange('l', 0, -1)) === '["a","b","c"]');
  const k = new Cache();
  ['a1', 'aX1', 'a[1]', 'a3', 'ab'].forEach(x => k.set(x, 'v'));
  ok('#146 KEYS [abc]', JSON.stringify(k.keys('a[13]').sort()) === '["a1","a3"]');
  ok('#146 KEYS [!abc]', JSON.stringify(k.keys('a[!1]').sort()) === '["a3","ab"]');
  c.close();
  l.close();
  k.close();

  // ---------- SQLite ----------
  const sq = new SqliteDb(':memory:', { engine: 'native' });
  sq.exec('CREATE TABLE t (a INTEGER, b TEXT)');
  sq.exec("INSERT INTO t VALUES (1,'x')");
  ok('#147 pluck get', sq.prepare('SELECT a,b FROM t').pluck(true).get() === 1);
  ok('#147 raw get', JSON.stringify(sq.prepare('SELECT a,b FROM t').raw(true).get()) === '[1,"x"]');
  sq.close();

  // ---------- MongoDB ----------
  const srv = createMongoServer({ port: 0, noAuth: true, dataDir: ':memory:' });
  const d = (cmd, payload) => srv._dispatch(cmd, { ...payload, $db: 'test' });
  const engine = await srv._getEngine('test');
  await engine.createTable('u', {});
  await engine.createTable('o', {});
  await d('insert', { insert: 'u', documents: [
    { _id: 1, name: 'a', age: 20, tags: ['x', 'y'], addr: { city: 'NY' } },
    { _id: 2, name: 'b', age: 30, tags: ['y'], addr: { city: 'LA' } },
    { _id: 3, name: 'c', age: 20, tags: [], addr: { city: 'NY' } },
  ] });
  await d('insert', { insert: 'o', documents: [{ _id: 101, uid: 1 }, { _id: 102, uid: 1 }, { _id: 103, uid: 2 }] });
  const find = async (filter, extra = {}) => (await d('find', { find: 'u', filter, ...extra })).cursor.firstBatch;
  const agg = async (pipeline) => (await d('aggregate', { aggregate: 'u', pipeline })).cursor.firstBatch;
  const ids = (rows) => rows.map(r => r._id).sort();

  ok('#151 点路径 filter', JSON.stringify(ids(await find({ 'addr.city': 'NY' }))) === '[1,3]');
  ok('#151 点路径 sort', JSON.stringify((await agg([{ $sort: { 'addr.city': 1 } }])).map(r => r._id)) === '[2,1,3]');
  ok('#151 点路径 group', JSON.stringify(await agg([{ $group: { _id: '$addr.city', n: { $sum: 1 } } }])) === '[{"_id":"NY","n":2},{"_id":"LA","n":1}]');
  ok('#151 $set 点路径', await d('update', { update: 'u', updates: [{ q: { _id: 1 }, u: { $set: { 'addr.city': 'LA' } } }] }).then(() => find({ _id: 1 })).then(r => r[0].addr.city) === 'LA');
  ok('#151 $unset 点路径', await d('update', { update: 'u', updates: [{ q: { _id: 1 }, u: { $unset: { 'addr.city': '' } } }] }).then(() => find({ _id: 1 })).then(r => JSON.stringify(r[0].addr)) === '{}');
  ok('#155 $not $gt', JSON.stringify(ids(await find({ age: { $not: { $gt: 20 } } }))) === '[1,3]');
  ok('#155 $not $eq', JSON.stringify(ids(await find({ age: { $not: { $eq: 20 } } }))) === '[2]');
  ok('#152 projection include', JSON.stringify(await find({ _id: 1 }, { projection: { _id: 0, name: 1 } })) === '[{"name":"a"}]');
  ok('#152 projection exclude', !(await find({ _id: 1 }, { fields: { addr: 0 } }))[0].addr);
  ok('#156 $project 排除式', !(await agg([{ $project: { addr: 0 } }]))[0].addr);
  const expr = (await agg([{ $project: { name: 1, upper: { $toUpper: '$name' }, plus: { $add: ['$age', 1] } } }]))[0];
  ok('#156 $project 表达式', expr.upper === 'A' && expr.plus === 21, expr);
  ok('#154 $unwind 默认丢弃空数组', JSON.stringify(ids(await agg([{ $unwind: '$tags' }]))) === '[1,1,2]');
  ok('#154 $unwind preserve=true', JSON.stringify(ids(await agg([{ $unwind: { path: '$tags', preserveNullAndEmptyArrays: true } }]))) === '[1,1,2,3]');
  const lookup = (await agg([{ $match: { _id: 1 } }, { $lookup: { from: 'o', localField: '_id', foreignField: 'uid', as: 'orders' } }]))[0];
  ok('#153 $lookup', Array.isArray(lookup.orders) && lookup.orders.length === 2, lookup);
  await d('update', { update: 'u', updates: [{ q: { _id: 1 }, u: { $mul: { age: 2 } } }] });
  ok('#150 $mul', (await find({ _id: 1 }))[0].age === 40);
  await d('update', { update: 'u', updates: [{ q: { _id: 1 }, u: { $addToSet: { tags: 'q' } } }] });
  ok('#150 $addToSet', JSON.stringify((await find({ _id: 1 }))[0].tags) === '["x","y","q"]');
  await d('update', { update: 'u', updates: [{ q: { _id: 1 }, u: { $pull: { tags: 'y' } } }] });
  ok('#150 $pull', JSON.stringify((await find({ _id: 1 }))[0].tags) === '["x","q"]');
  const unknown = await d('update', { update: 'u', updates: [{ q: { _id: 1 }, u: { $bogus: { x: 1 } } }] });
  ok('#150 未知运算符报错', unknown.ok === 0 && /unknown modifier/.test(unknown.errmsg), unknown);
  srv.close();

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
}

main().catch(e => { console.error(e); process.exitCode = 1; });
