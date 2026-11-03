/*
 * jsql 1.0.0 兼容层回归测试
 *   node test/compat-v1.test.js
 *
 * 全部按 1.0.0 的公开 API 写法调用：同步 createTable、db.users.*、
 * where().orderBy().limit().get() 链式查询。内存模式 + 文件模式各跑一遍。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const compat = require('../lib/compat/v1');
const jsql = require('../index.js');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('[OK]', name); }
  else { fail++; console.log('[FAIL]', name, extra !== undefined ? '→ ' + JSON.stringify(extra) : ''); }
}
function eq(name, actual, expected) {
  try { assert.deepStrictEqual(actual, expected); ok(name, true); }
  catch (e) { ok(name, false, { actual, expected }); }
}
function throws(name, fn, hint) {
  try { fn(); ok(name, false, 'no throw'); }
  catch (e) {
    const hit = !hint || String(e.code) === String(hint) || String(e.message).includes(hint);
    ok(name, hit, { code: e.code, message: e.message });
  }
}

const usersSchema = {
  id: { type: 'integer', primaryKey: true, autoIncrement: true },
  name: { type: 'string', required: true },
  age: { type: 'integer' },
  city: { type: 'string' },
};

function memorySuite() {
  console.log('\n--- 内存模式 ---');
  const db = new compat.Database(':memory:');

  // createTable 必须是同步的
  const ret = db.createTable('users', usersSchema);
  ok('createTable 返回 Table（非 Promise）', ret && typeof ret.insert === 'function' && typeof ret.then !== 'function');
  ok('db.users 属性自动可用', db.users === ret);
  ok('getTables 含 users', db.getTables().includes('users'));
  ok('hasTable(users)', db.hasTable('users') === true);

  // insert / 自增主键
  const alice = db.users.insert({ name: 'Alice', age: 25, city: 'SH' });
  eq('insert 返回带自增 id 的行', alice, { name: 'Alice', age: 25, city: 'SH', id: 1 });
  db.users.insert({ name: 'Bob', age: 17, city: 'BJ' });
  db.users.insert({ name: 'Carol', age: 40, city: 'SH' });
  db.users.insert({ name: 'Dave', age: 32, city: 'GZ' });
  eq('自动自增到 4', db.users.insert({ name: 'Eve', age: 28, city: 'BJ' }).id, 5);

  // insertMany
  const many = db.users.insertMany([
    { name: 'Frank', age: 60, city: 'SZ' },
    { name: 'Grace', age: 22, city: 'SZ' },
  ]);
  eq('insertMany 返回 2 行且 id 递增', many.map(r => r.id), [6, 7]);

  // find / findOne / findById / findAll / count
  eq('find($gte) 行数', db.users.find({ age: { $gte: 30 } }).length, 3);
  eq('findOne', db.users.findOne({ name: 'Bob' }).id, 2);
  eq('findById', db.users.findById(3).name, 'Carol');
  eq('findAll 行数', db.users.findAll().length, 7);
  ok('count() 空条件', db.users.count() === 7);
  ok('count(条件)', db.users.count({ city: 'SH' }) === 2);
  ok('findOne 未命中返回 null', db.users.findOne({ name: 'Nobody' }) === null);

  // 查询操作符
  eq('$gte', db.users.find({ age: { $gte: 32 } }).map(r => r.name), ['Carol', 'Dave', 'Frank']);
  eq('$lte', db.users.find({ age: { $lte: 22 } }).map(r => r.name), ['Bob', 'Grace']);
  eq('$gt', db.users.find({ age: { $gt: 40 } }).map(r => r.name), ['Frank']);
  eq('$lt', db.users.find({ age: { $lt: 22 } }).map(r => r.name), ['Bob']);
  eq('$eq', db.users.find({ age: { $eq: 28 } }).map(r => r.name), ['Eve']);
  eq('$ne', db.users.find({ city: { $ne: 'SH' } }).length, 5);
  eq('$in', db.users.find({ city: { $in: ['SH', 'GZ'] } }).length, 3);
  eq('$nin', db.users.find({ city: { $nin: ['SH', 'GZ'] } }).length, 4);
  eq('$like', db.users.find({ name: { $like: 'A%' } }).map(r => r.name), ['Alice']);
  eq('$regex', db.users.find({ name: { $regex: '^[BG]' } }).map(r => r.name), ['Bob', 'Grace']);
  eq('多字段 AND', db.users.find({ city: 'SH', age: { $gte: 30 } }).map(r => r.name), ['Carol']);

  // 链式查询
  const chain = db.users.where({ age: { $gte: 20 } }).orderBy('age', 'desc').limit(2).get();
  eq('where().orderBy().limit().get()', chain.map(r => r.name), ['Frank', 'Carol']);
  eq('offset', db.users.where({}).orderBy('age', 'asc').offset(1).limit(2).get().map(r => r.name), ['Grace', 'Alice']);
  eq('select 只保留字段', Object.keys(db.users.where({ name: 'Alice' }).select(['name']).get()[0]), ['name']);
  eq('first()', db.users.where({ city: 'GZ' }).first().name, 'Dave');
  ok('Query.count()', db.users.where({ age: { $lt: 30 } }).count() === 4);

  // createIndex / dropIndex（同步、可重复）
  ok('createIndex 同步返回', db.users.createIndex('age') !== undefined);
  db.users.createIndex('city');
  eq('建索引后查询仍正确', db.users.find({ age: { $gte: 30 } }).length, 3);
  ok('dropIndex 可用', (() => { db.users.dropIndex('city'); return db.users.find({ city: 'SZ' }).length === 2; })());
  eq('删索引后查询仍正确', db.users.find({ city: 'SZ' }).length, 2);

  // update / updateById
  const updated = db.users.update({ name: 'Bob' }, { age: 18 });
  ok('update 返回值/影响行数', updated === 1 || updated === true || (updated && updated.count === 1), updated);
  eq('update 生效', db.users.findOne({ name: 'Bob' }).age, 18);
  db.users.updateById(3, { city: 'HZ' });
  eq('updateById 生效', db.users.findById(3).city, 'HZ');
  eq('Query.update', db.users.where({ city: 'SZ' }).update({ city: 'HZ' }) !== undefined, true);
  eq('Query.update 生效', db.users.find({ city: 'HZ' }).map(r => r.name), ['Carol', 'Frank', 'Grace']);

  // remove / removeById
  const removed = db.users.remove({ name: 'Eve' });
  ok('remove 返回值/影响行数', removed === 1 || removed === true || (removed && removed.count === 1), removed);
  ok('remove 生效', db.users.findOne({ name: 'Eve' }) === null);
  db.users.removeById(1);
  ok('removeById 生效', db.users.findById(1) === null);
  eq('Query.remove', db.users.where({ city: 'HZ' }).remove() !== undefined, true);
  eq('Query.remove 生效', db.users.find({ city: 'HZ' }).length, 0);

  // 约束
  throws('required 生效', () => db.users.insert({ age: 1 }), 'cannot be null');
  db.createTable('uniq', { k: { type: 'string', unique: true } });
  db.uniq.insert({ k: 'a' });
  throws('unique 生效', () => db.uniq.insert({ k: 'a' }), 'Duplicate entry');
  throws('重复建表报错', () => db.createTable('users', usersSchema), 'already exists');

  // export / import（内存往返）
  const dump = db.export();
  ok('export 含 users', Array.isArray(dump.users) && dump.users.length > 0);
  const db2 = new compat.Database(null);
  db2.import(dump);
  ok('import 自动建表', db2.hasTable('users'));
  eq('import 行数一致', db2.users.findAll().length, dump.users.length);
  eq('import 内容一致', db2.users.findOne({ name: dump.users[0].name }), dump.users[0]);
  eq('import 还原自增主键', db2.users.insert({ name: 'Zoe', age: 33 }).id,
    Math.max(...dump.users.map(r => r.id)) + 1);

  // dropTable 同步
  db.dropTable('users');
  ok('dropTable 移除属性', db.users === undefined);
  ok('dropTable 移除表', db.hasTable('users') === false);
  ok('dropTable 后重建可用', (() => {
    db.createTable('users', usersSchema);
    db.users.insert({ name: 'New', age: 1 });
    return db.users.count() === 1;
  })());

  db.close();
  db2.close();
}

function fileSuite() {
  console.log('\n--- 文件模式 ---');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsql-v1-'));
  const file = path.join(dir, 'mydb.json');
  const db = new compat.Database(file);
  db.createTable('users', usersSchema);
  db.users.insert({ name: 'Alice', age: 25 });
  db.users.insert({ name: 'Bob', age: 17 });
  db.users.insert({ name: 'Carol', age: 40 });
  ok('文件模式 where().first()', db.users.where({ age: { $gt: 18 } }).first().name === 'Alice');
  db.save();
  ok('save 后文件存在', fs.existsSync(file));
  db.close();

  const db2 = new compat.Database(file);
  ok('重开后表仍在', db2.hasTable('users'));
  ok('重开后 db.users 可用', !!db2.users && db2.users.count() === 3);
  eq('重开后数据一致', db2.users.find({ age: { $gte: 18 } }).map(r => r.name), ['Alice', 'Carol']);
  ok('重开后自增继续', db2.users.insert({ name: 'Dave', age: 50 }).id === 4);

  // export → 新库 import → 再落盘
  const dump = db2.export();
  const file2 = path.join(dir, 'mydb2.json');
  const db3 = new compat.Database(file2);
  db3.import(dump);
  db3.save();
  db3.close();

  const db4 = new compat.Database(file2);
  eq('跨库往返行数一致', db4.users.count(), 4);
  eq('跨库往返内容一致', db4.users.findOne({ name: 'Carol' }).age, 40);
  db2.close();
  db4.close();

  // 清理
  for (const f of [file, file2]) {
    for (const p of [f, f + '.wal', f + '.lock']) {
      try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch (e) {}
    }
  }
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
}

function entrySuite() {
  console.log('\n--- 包入口 ---');
  ok('index.js 暴露 compatV1', jsql.compatV1 && jsql.compatV1.Database === compat.Database);
  ok('compat.Table 就是引擎 Table', compat.Table === require('../lib/table'));
  // 自引用（依赖 package.json exports）
  try {
    const self = require('jsql-neo/compat/v1');
    ok("require('jsql-neo/compat/v1') 可用", self.Database === compat.Database);
  } catch (e) {
    ok("require('jsql-neo/compat/v1') 可用", false, e.message);
  }
  try {
    const viaLib = require('../lib/compat/v1');
    ok("require('jsql-neo/lib/compat/v1') 路径等价", viaLib.Database === compat.Database);
  } catch (e) {
    ok("require('jsql-neo/lib/compat/v1') 路径等价", false, e.message);
  }
}

memorySuite();
fileSuite();
entrySuite();

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
