/*
 * v6.5.14 回归测试：把本版修掉的高危 / 中危缺陷逐条固化。
 *
 *   C1  B-Tree 混合插入/删除丢失索引条目
 *   H1  PostgreSQL 未配置认证时的 trust 绕过
 *   H2  NeDB $regex 字符串模式匹配一切
 *   H3  UPDATE 标量子查询写成 NULL（含限定符相关子查询）
 *   H4  BETWEEN 按字典序而非数值比较
 *   H5  主键允许 NULL
 *   H6  索引列 = null 漏行
 *   M1  错误消息 %s 串位
 *   M2  返回行浅拷贝导致内部数据被调用方污染
 *   M3  migrate.normalizeSchema 丢失显式 length
 *   M4  READ_COMMITTED 下 ROLLBACK 不撤销行
 *   M5  XOR 破坏三值逻辑
 *   M6  REGEXP BINARY 失效
 *   M9  插件钩子未按 priority 排序
 *   M10 XQL 编译器 NULL 传播
 *   M11 Mongo 结果泄漏内部字段
 *
 *   node test/v6.5.14-regression.test.js
 */
const path = require('path');

const ROOT = path.join(__dirname, '..');
const { Database } = require(path.join(ROOT, 'index.js'));
const { executeSQL } = require(path.join(ROOT, 'lib/sql.js'));
const BTree = require(path.join(ROOT, 'lib/btree'));
const { PgServer } = require(path.join(ROOT, 'lib/pg_server'));
const { Datastore } = require(path.join(ROOT, 'lib/nedb_compat'));
const { MongoServer } = require(path.join(ROOT, 'lib/mongo_server'));
const { createError } = require(path.join(ROOT, 'lib/errors'));
const { normalizeSchema } = require(path.join(ROOT, 'lib/migrate'));
const { registerHook, runHooks, createHookRegistry } = require(path.join(ROOT, 'lib/plugin'));
const { parse: xqlParse } = require(path.join(ROOT, 'lib/xql/src/parser'));
const { compileQuery } = require(path.join(ROOT, 'lib/xql/src/compiler'));

const OPTS = { safety: false };
let pass = 0, fail = 0;

function ok(name, cond, extra) {
  if (cond) { pass++; console.log('[OK]  ', name); }
  else { fail++; console.log('[FAIL]', name, extra !== undefined ? '-> ' + JSON.stringify(extra).slice(0, 160) : ''); }
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function makeDb() { return new Database(':memory:'); }

(async () => {
  // ── C1. B-Tree 混合插入/删除 ────────────────────────────────
  console.log('\n--- C1. B-Tree 混合插入/删除 ---');
  {
    const t = new BTree(4, false);
    for (let i = 1; i <= 64; i++) t.insert(i, i);
    ok('插入 64 条后 size=64', t.size === 64, t.size);
    for (let i = 2; i <= 64; i += 2) t.remove(i, i);
    ok('删除 32 条后 size=32', t.size === 32, t.size);
    const missing = [];
    for (let i = 1; i <= 64; i += 2) if (!t.search(i).includes(i)) missing.push(i);
    ok('剩余奇数键全部可搜到', missing.length === 0, missing);
    for (let i = 2; i <= 64; i += 2) t.insert(i, i);
    ok('重新插入后 size=64', t.size === 64, t.size);
    const missing2 = [];
    for (let i = 1; i <= 64; i++) if (!t.search(i).includes(i)) missing2.push(i);
    ok('全部键可搜到（无条目丢失）', missing2.length === 0, missing2);
    // 重复键 + 多行号：删其中一行不应误删整键
    const m = new BTree(4, false);
    m.insert(7, 1); m.insert(7, 2); m.insert(7, 3);
    m.remove(7, 2);
    ok('同键多行只删指定行', eq(m.search(7).slice().sort(), [1, 3]), m.search(7));
    ok('同键多行 size 仍为 1（size 记不同键数）', m.size === 1, m.size);
  }

  const db = makeDb();
  await db.start();
  const q = (sql) => executeSQL(db, sql, OPTS);
  const one = async (sql) => (await q(sql)).rows[0][0];
  const fails = async (sql) => { try { await q(sql); return null; } catch (e) { return e.message; } };

  // ── H1. PG 认证默认拒绝 ─────────────────────────────────────
  console.log('\n--- H1. PostgreSQL 认证 ---');
  {
    const srvDefault = new PgServer({});
    ok('未配置认证时返回 undefined（拒绝连接）', srvDefault._userPassword('anyone') === undefined);
    const srvNoAuth = new PgServer({ noAuth: true });
    ok('显式 noAuth 才返回空密码（trust）', srvNoAuth._userPassword('anyone') === '');
    const srvAuth = new PgServer({ auth: { alice: { password: 'pw' } } });
    ok('配置的用户返回真实密码', srvAuth._userPassword('alice') === 'pw');
    ok('未配置的用户返回 undefined', srvAuth._userPassword('bob') === undefined);
    const srvOpt = new PgServer({ user: 'root', password: 'secret' });
    ok('options.user 匹配返回密码', srvOpt._userPassword('root') === 'secret');
    ok('options.user 不匹配拒绝', srvOpt._userPassword('other') === undefined);
  }

  // ── H2. NeDB $regex ─────────────────────────────────────────
  console.log('\n--- H2. NeDB $regex ---');
  {
    const ndb = new Database(':memory:');
    await ndb.start();
    const ds = new Datastore({ database: ndb });
    await ds.loadDatabase();
    await ds.insert([{ n: 'abc' }, { n: 'abcd' }, { n: 'zzz' }, { n: 42 }]);
    const hit = await ds.find({ n: { $regex: 'abc' } }).exec();
    ok('字符串模式只匹配命中文档', hit.length === 2 && hit.every(d => /abc/.test(String(d.n))), hit);
    const exact = await ds.find({ n: { $regex: '^abc$' } }).exec();
    ok('锚定模式精确匹配', exact.length === 1 && exact[0].n === 'abc', exact);
    const invalid = await ds.find({ n: { $regex: '(' } }).exec();
    ok('非法模式返回空而不是全匹配', invalid.length === 0, invalid);
    const re = await ds.find({ n: { $regex: /^abc/ } }).exec();
    ok('RegExp 对象仍可用', re.length === 2, re.map(d => d.n));
    await ndb.stop();
  }

  // ── H3. UPDATE 标量子查询 ───────────────────────────────────
  console.log('\n--- H3. UPDATE 标量子查询 ---');
  await q('CREATE TABLE a3(id INT PRIMARY KEY, v INT)');
  await q('CREATE TABLE b3(id INT PRIMARY KEY, w INT)');
  await q('INSERT INTO a3 VALUES (1,0),(2,0),(3,0)');
  await q('INSERT INTO b3 VALUES (1,10),(2,20)');
  await q('UPDATE a3 SET v = (SELECT w FROM b3 WHERE b3.id = a3.id)');
  ok('相关标量子查询按行写入（限定符）',
    eq((await q('SELECT id, v FROM a3')).rows, [[1, 10], [2, 20], [3, null]]),
    (await q('SELECT id, v FROM a3')).rows);
  ok('非相关标量子查询可用',
    (await q('UPDATE a3 SET v = (SELECT MAX(w) FROM b3)'), (await q('SELECT id, v FROM a3')).rows.every(r => r[1] === 20)));
  ok('SELECT 投影里的相关子查询一致',
    eq((await q('SELECT a3.id, (SELECT w FROM b3 WHERE b3.id = a3.id) AS w FROM a3')).rows,
      [[1, 10], [2, 20], [3, null]]));
  ok('EXISTS 相关子查询仍正确',
    eq((await q('SELECT a3.id FROM a3 WHERE EXISTS (SELECT 1 FROM b3 WHERE b3.id = a3.id)')).rows, [[1], [2]]));

  // ── H4. BETWEEN 数值比较 ────────────────────────────────────
  console.log('\n--- H4. BETWEEN ---');
  ok('10 BETWEEN 2 AND 20 = 1', (await one('SELECT 10 BETWEEN 2 AND 20')) === 1);
  ok('5 BETWEEN 10 AND 20 = 0', (await one('SELECT 5 BETWEEN 10 AND 20')) === 0);
  ok('"10" BETWEEN 2 AND 20 仍按数值', (await one("SELECT '10' BETWEEN 2 AND 20")) === 1);
  ok('字符串 BETWEEN 保持字典序', (await one("SELECT 'b' BETWEEN 'a' AND 'c'")) === 1);

  // ── H5. 主键 NOT NULL ───────────────────────────────────────
  console.log('\n--- H5. 主键 NULL ---');
  await db.createTable('pk5', {
    k: { type: 'integer', primaryKey: true },
    v: { type: 'integer' },
  });
  {
    const msg = await (async () => { try { await db.insert('pk5', { k: null, v: 1 }); return null; } catch (e) { return e.message; } })();
    ok('非自增主键插入 NULL 报错', /cannot be null/i.test(msg || ''), msg);
    await db.insert('pk5', { k: 1, v: 1 });
    const upd = await (async () => { try { await db.updateById('pk5', 1, { k: null }); return null; } catch (e) { return e.message; } })();
    ok('更新主键为 NULL 报错', /cannot be null/i.test(upd || ''), upd);
  }
  {
    let accepted = false;
    try { await q('CREATE TABLE pk5b(k INT PRIMARY KEY, v INT)'); await q('INSERT INTO pk5b VALUES (NULL, 1)'); accepted = true; } catch (_) { /* 预期抛错 */ }
    ok('INT PRIMARY KEY 自增语义仍允许 NULL（自动取号）', accepted);
  }

  // ── H6. 索引列 = null ──────────────────────────────────────
  console.log('\n--- H6. 索引列 null ---');
  await q('CREATE TABLE n6(id INT PRIMARY KEY, c INT)');
  await q('INSERT INTO n6 VALUES (1,NULL),(2,5),(3,NULL)');
  await q('CREATE INDEX ixc ON n6(c)');
  ok('索引列 find({c:null}) 不漏行', eq((await db.find('n6', { c: null })).map(r => r.id), [1, 3]),
    await db.find('n6', { c: null }));
  ok('索引列 find({c:5}) 正常', eq((await db.find('n6', { c: 5 })).map(r => r.id), [2]));
  ok('$in 含 null 时回退全表', eq((await db.find('n6', { c: { $in: [5, null] } })).map(r => r.id), [1, 2, 3]),
    await db.find('n6', { c: { $in: [5, null] } }));

  // ── M1. 错误消息 %s ────────────────────────────────────────
  console.log('\n--- M1. 错误消息 %s ---');
  {
    const e1 = createError('ER_DUP_ENTRY', 'x%s', 'k');
    ok('参数里的 %s 不被二次替换', e1.message === "Duplicate entry 'x%s' for key 'k'", e1.message);
    const e2 = createError('ER_DUP_ENTRY', 'only-one');
    ok('参数不足时裸 %s 被清空', e2.message === "Duplicate entry 'only-one' for key ''", e2.message);
  }

  // ── M2. 深拷贝 ────────────────────────────────────────────
  console.log('\n--- M2. 行深拷贝 ---');
  await db.createTable('m2', {
    id: { type: 'integer', primaryKey: true, autoIncrement: true },
    meta: { type: 'json' },
  });
  await db.insert('m2', { meta: { a: [1, 2] } });
  {
    const r1 = await db.findById('m2', 1);
    r1.meta.a.push(99);
    const r2 = await db.findById('m2', 1);
    ok('修改返回值不污染内部行', eq(r2.meta, { a: [1, 2] }), r2.meta);
    const list = await db.find('m2', {});
    list[0].meta.a.push(100);
    const again = await db.find('m2', {});
    ok('find() 同样返回深拷贝', eq(again[0].meta, { a: [1, 2] }), again[0].meta);
  }

  // ── M3. migrate 保留 length ────────────────────────────────
  console.log('\n--- M3. migrate length ---');
  {
    const s1 = normalizeSchema({ name: { type: 'string', length: 32 } });
    ok('显式 length 保留', s1.name.length === 32, s1.name);
    const s2 = normalizeSchema({ name: { type: 'string', maxLength: 64 } });
    ok('maxLength 回填为 length', s2.name.length === 64 && s2.name.maxLength === undefined, s2.name);
    const s3 = normalizeSchema({ name: { type: 'string', length: 16, maxLength: 99 } });
    ok('显式 length 优先于 maxLength', s3.name.length === 16, s3.name);
    const s4 = normalizeSchema({ n: 'int' });
    ok('字符串简写仍归一化', s4.n.type === 'integer', s4.n);
  }

  // ── M4. READ_COMMITTED 回滚 ─────────────────────────────────
  console.log('\n--- M4. READ_COMMITTED 回滚 ---');
  {
    const tx = makeDb();
    await tx.start();
    await tx.createTable('m4', {
      id: { type: 'integer', primaryKey: true, autoIncrement: true },
      v: { type: 'integer' },
    });
    await tx.insert('m4', { v: 1 });
    tx.begin('READ_COMMITTED');
    await tx.insert('m4', { v: 2 });
    tx.rollback();
    ok('ROLLBACK 撤销已插入行', eq((await tx.find('m4', {})).map(r => r.v), [1]), await tx.find('m4', {}));
    tx.begin('READ_COMMITTED');
    await tx.insert('m4', { v: 3 });
    tx.commit();
    ok('COMMIT 保留行', eq((await tx.find('m4', {})).map(r => r.v).sort(), [1, 3]));
    await tx.stop();
  }

  // ── M5. XOR 三值逻辑 ───────────────────────────────────────
  console.log('\n--- M5. XOR ---');
  ok('TRUE XOR FALSE = 1', (await one('SELECT TRUE XOR FALSE')) === 1);
  ok('TRUE XOR TRUE = 0', (await one('SELECT TRUE XOR TRUE')) === 0);
  ok('NULL XOR TRUE = NULL', (await one('SELECT NULL XOR TRUE')) === null);
  ok('NULL XOR FALSE = NULL', (await one('SELECT NULL XOR FALSE')) === null);
  ok('NULL XOR NULL = NULL', (await one('SELECT NULL XOR NULL')) === null);

  // ── M6. REGEXP BINARY ──────────────────────────────────────
  console.log('\n--- M6. REGEXP BINARY ---');
  await q('CREATE TABLE r6(id INT PRIMARY KEY, s TEXT)');
  await q("INSERT INTO r6 VALUES (1,'abc'),(2,'ABC')");
  ok('默认 REGEXP 大小写不敏感', eq((await q("SELECT id FROM r6 WHERE s REGEXP 'abc'")).rows.map(r => r[0]).sort(), [1, 2]));
  ok('REGEXP BINARY 大小写敏感', eq((await q("SELECT id FROM r6 WHERE s REGEXP BINARY 'abc'")).rows, [[1]]));
  ok('RLIKE BINARY 同样生效', eq((await q("SELECT id FROM r6 WHERE s RLIKE BINARY 'abc'")).rows, [[1]]));
  ok('非法正则安全返回不匹配', eq((await q("SELECT id FROM r6 WHERE s REGEXP BINARY '('")).rows, []));

  // ── M9. 插件钩子优先级 ─────────────────────────────────────
  console.log('\n--- M9. 钩子优先级 ---');
  {
    const engine = { _hooks: createHookRegistry() };
    const order = [];
    registerHook(engine, 'beforeQuery', () => { order.push('low'); return true; }, 0);
    registerHook(engine, 'beforeQuery', () => { order.push('high'); return true; }, 10);
    registerHook(engine, 'beforeQuery', () => { order.push('mid'); return true; }, 5);
    await runHooks(engine, 'beforeQuery', []);
    ok('按 priority 降序执行', eq(order, ['high', 'mid', 'low']), order);

    const order2 = [];
    const e2 = { _hooks: createHookRegistry() };
    registerHook(e2, 'beforeQuery', () => { order2.push('a'); return true; }, 3);
    registerHook(e2, 'beforeQuery', () => { order2.push('b'); return true; }, 3);
    await runHooks(e2, 'beforeQuery', []);
    ok('同 priority 保持注册顺序', eq(order2, ['a', 'b']), order2);
  }

  // ── M10. XQL NULL 传播 ────────────────────────────────────
  console.log('\n--- M10. XQL NULL ---');
  {
    const rows = [{ id: 1, a: null }, { id: 2, a: 5 }, { id: 3, a: 3 }];
    const run = (sql) => compileQuery(xqlParse(sql), {})(rows);
    ok('a = 5 命中', eq(run('SELECT id FROM t WHERE a = 5'), [{ id: 2 }]));
    ok('a = NULL 不命中任何行', eq(run('SELECT id FROM t WHERE a = NULL'), []));
    ok('a != NULL 不命中任何行', eq(run('SELECT id FROM t WHERE a != NULL'), []));
    ok('BETWEEN 正常', eq(run('SELECT id FROM t WHERE a BETWEEN 2 AND 4'), [{ id: 3 }]));
    ok('IN (5, NULL) 只命中 5', eq(run('SELECT id FROM t WHERE a IN (5, NULL)'), [{ id: 2 }]));
    ok('NOT IN 含 NULL 不命中（三值逻辑）', eq(run('SELECT id FROM t WHERE a NOT IN (5, NULL)'), []));
  }

  // ── M11. Mongo 内部字段 ───────────────────────────────────
  console.log('\n--- M11. Mongo _publicDoc ---');
  {
    const ms = new MongoServer({});
    ok('剥离 _deleted/_rid/_score', eq(ms._publicDoc({ _id: 1, x: 2, _rid: 9, _deleted: false, _score: 3 }), { _id: 1, x: 2 }),
      ms._publicDoc({ _id: 1, x: 2, _rid: 9, _deleted: false, _score: 3 }));
    ok('干净文档原样返回', eq(ms._publicDoc({ _id: 2, y: 3 }), { _id: 2, y: 3 }));
  }

  await db.stop();

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exitCode = 1;
})().catch((e) => {
  console.error('FATAL', e);
  process.exitCode = 1;
});
