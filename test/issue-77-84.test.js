// 回归测试：Issue #77-#84
//   #77 WHERE on BIGINT 用字典序字符串比较导致错误结果
//   #78 UNION/INTERSECT/EXCEPT 遇 BIGINT 列 TypeError
//   #79 BEFORE DELETE trigger 在 removeById() 上不触发
//   #80 XOR 违反 SQL 三值逻辑（UNKNOWN 塌缩成 FALSE）
//   #81 NeDB-compat $pull 是 no-op（硬编码键 "k"）
//   #82 DATETIME 静默丢弃亚秒精度
//   #83 BOOLEAN 列与数字字符串字面量 '1' 比较返回空
//   #84 插件 priority 被忽略（钩子按注册顺序执行）
const { executeSQL } = require('../lib/sql');
const Database = require('../lib/database');
const { Datastore } = require('../lib/nedb_compat');
const dateTypes = require('../lib/date-types');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('[OK]  ', name); }
  else { fail++; console.log('[FAIL]', name, extra !== undefined ? ' -> ' + JSON.stringify(extra).slice(0, 300) : ''); }
}
const engine = (schema, rows) => ({
  hasTable: () => true,
  find: async () => rows,
  getTableSchema: async () => schema,
  truncate: async () => {}, flush: async () => {},
});

(async () => {
  // #77 BIGINT WHERE 比较
  {
    const r = await executeSQL(engine(
      { id: { type: 'integer', primaryKey: true }, big: { type: 'bigint' } },
      [{ id: 1, big: 50n }, { id: 2, big: 2000n }]
    ), 'SELECT id FROM t WHERE big > 1000', { safety: false });
    ok('#77 bigint > 1000 只返回 id=2', r.rows.map(x => x[0]).join(',') === '2', r.rows);
  }
  {
    const r = await executeSQL(engine(
      { id: { type: 'integer', primaryKey: true }, big: { type: 'bigint' } },
      [{ id: 1, big: 50n }, { id: 2, big: 2000n }]
    ), 'SELECT id FROM t WHERE big = 50', { safety: false });
    ok('#77 bigint = 50 数值相等', r.rows.map(x => x[0]).join(',') === '1', r.rows);
  }

  // #78 UNION / INTERSECT / EXCEPT on bigint
  {
    const r = await executeSQL(engine(
      { big: { type: 'bigint' } },
      [{ big: 50n }, { big: 2000n }]
    ), 'SELECT big FROM t UNION SELECT big FROM t', { safety: false });
    ok('#78 UNION bigint 不抛错且去重', Array.isArray(r.rows) && r.rows.length === 2, r.rows);
  }
  {
    const r = await executeSQL(engine(
      { big: { type: 'bigint' } },
      [{ big: 50n }]
    ), 'SELECT big FROM t INTERSECT SELECT big FROM t', { safety: false });
    ok('#78 INTERSECT bigint 不抛错', Array.isArray(r.rows) && r.rows.length === 1, r.rows);
  }
  {
    const r = await executeSQL(engine(
      { big: { type: 'bigint' } },
      [{ big: 50n }, { big: 2000n }]
    ), 'SELECT big FROM t EXCEPT SELECT big FROM t WHERE big = 50', { safety: false });
    ok('#78 EXCEPT bigint 不抛错', Array.isArray(r.rows), r.rows);
  }

  // #79 BEFORE DELETE on removeById
  {
    const db = new Database(':memory:');
    await db.createTable('t', { id: { type: 'integer', primaryKey: true } });
    let fired = 0;
    db.createTrigger('tr', { event: 'remove', table: 't', timing: 'before' }, () => { fired++; });
    await db.insert('t', { id: 1 });
    await db.removeById('t', 1);
    ok('#79 removeById 触发 before remove', fired === 1, { fired });
  }

  // #80 XOR 三值逻辑
  {
    const r = await executeSQL(engine(
      { id: { type: 'integer', primaryKey: true }, a: { type: 'integer' } },
      [{ id: 1, a: null }, { id: 2, a: 1 }, { id: 3, a: 2 }]
    ), 'SELECT id FROM t WHERE TRUE XOR (a = 1)', { safety: false });
    ok('#80 TRUE XOR (a=1) 只返回 id=3（UNKNOWN 不塌缩）', r.rows.map(x => x[0]).join(',') === '3', r.rows);
  }

  // #81 $pull
  {
    const ds = new Datastore({ inMemoryOnly: true });
    await ds.loadDatabase();
    const doc = await ds.insert({ tags: ['red', 'green', 'blue'] });
    await ds.update({ _id: doc._id }, { $pull: { tags: 'red' } });
    const after = await ds.findOne({ _id: doc._id });
    ok('#81 $pull 移除匹配元素', after.tags.join(',') === 'green,blue', after.tags);
  }
  {
    const ds = new Datastore({ inMemoryOnly: true });
    await ds.loadDatabase();
    const doc = await ds.insert({ items: [{ n: 1 }, { n: 2 }, { n: 3 }] });
    await ds.update({ _id: doc._id }, { $pull: { items: { n: 2 } } });
    const after = await ds.findOne({ _id: doc._id });
    ok('#81 $pull 对象数组按字段匹配', after.items.length === 2 && after.items[1].n === 3, after.items);
  }

  // #82 DATETIME 亚秒
  {
    const out = dateTypes.validateDateType('2024-01-15T10:30:00.500Z', 'datetime', 'f');
    ok('#82 保留 .500 亚秒', out === '2024-01-15 10:30:00.500', out);
  }
  {
    const out = dateTypes.validateDateType('2024-01-15T10:30:00Z', 'datetime', 'f');
    ok('#82 整秒不带 .000', out === '2024-01-15 10:30:00', out);
  }

  // #83 BOOLEAN vs '1'
  {
    const r = await executeSQL(engine(
      { id: { type: 'integer', primaryKey: true }, b: { type: 'boolean' } },
      [{ id: 1, b: true }, { id: 2, b: false }]
    ), "SELECT id FROM t WHERE b = '1'", { safety: false });
    ok('#83 b = \'1\' 返回 id=1', r.rows.map(x => x[0]).join(',') === '1', r.rows);
  }

  // #84 plugin priority
  {
    const db = new Database(':memory:');
    await db.createTable('t', { id: { type: 'integer', primaryKey: true } });
    const order = [];
    await db.use({ name: 'low', priority: 1, hooks: { beforeInsert: () => order.push('low') } });
    await db.use({ name: 'high', priority: 10, hooks: { beforeInsert: () => order.push('high') } });
    await db.insert('t', { id: 1 });
    ok('#84 高 priority 先执行', order.join(',') === 'high,low', order);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
