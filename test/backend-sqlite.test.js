/*
 * SqliteJSQL — SQLite 可选底层（方案 A）测试
 *
 *   node test/backend-sqlite.test.js
 *
 * 覆盖：
 *   B1 :memory: — createTable / insert / findById / find / updateById / count / exists / removeById
 *   B2 :memory: — query() 的 SELECT/WHERE/ORDER BY 结果形状（rows 元组 + raw 对象）
 *   B3 :memory: — prepare() / addColumn / getTables / getTableSchema / hasTable
 *   B4 :memory: — 事务 beginTx/rollbackTx、beginTransaction/commit
 *   B5 文件模式 — 落盘后 stop() → 重开同一文件，数据仍在（持久化验证）
 *   B6 原版 JSQL（WASM）跑同一组断言 —— 确认默认引擎零回归
 *
 * 零外部依赖，只用 Node 内置模块与本仓库 lib。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const { SqliteJSQL } = require(path.join(ROOT, 'lib', 'sqlite_client'));
const { JSQL } = require(path.join(ROOT, 'lib', 'wasm_client'));

let pass = 0;
let fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('[OK]', name); }
  else { fail++; console.log('[FAIL]', name, extra !== undefined ? JSON.stringify(extra) : ''); }
}
function eq(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

const USERS_SCHEMA = {
  id: { type: 'integer', primaryKey: true, autoIncrement: true },
  name: { type: 'string', required: true },
  age: { type: 'integer' },
};

/** 两个底层引擎共用的 CRUD 断言，保证 API 面一致 */
async function crudSuite(label, db) {
  await db.createTable('users', USERS_SCHEMA);

  const ids = await db.insert('users', { name: 'Alice', age: 30 });
  ok(`${label}: insert 返回主键数组`, Array.isArray(ids) && ids.length === 1 && Number(ids[0]) === 1, ids);

  const many = await db.insert('users', [{ name: 'Bob', age: 25 }, { name: 'Cara', age: 41 }]);
  ok(`${label}: 批量 insert 返回 2 个 id`, Array.isArray(many) && many.length === 2, many);

  const alice = await db.findById('users', 1);
  ok(`${label}: findById 命中`, !!alice && alice.name === 'Alice' && alice.age === 30, alice);
  ok(`${label}: findById 未命中返回 null`, (await db.findById('users', 999)) === null);

  const grown = await db.find('users', { age: { $gte: 30 } }, { limit: 10 });
  ok(`${label}: find 过滤 + 排序无关的计数`, Array.isArray(grown) && grown.length === 2, grown);
  const all = await db.find('users', {}, { limit: 10 });
  ok(`${label}: find 全量`, all.length === 3 && eq(all.map(r => r.age).sort((a, b) => a - b), [25, 30, 41]), all.map(r => r.age));
  const limited = await db.find('users', {}, { limit: 1 });
  ok(`${label}: find limit 生效`, limited.length === 1, limited);

  ok(`${label}: count`, (await db.count('users')) === 3, await db.count('users'));
  ok(`${label}: exists 命中`, (await db.exists('users', { name: 'Bob' })) === true);
  ok(`${label}: exists 未命中`, (await db.exists('users', { name: 'Nobody' })) === false);

  await db.updateById('users', 1, { age: 31 });
  const updated = await db.findById('users', 1);
  ok(`${label}: updateById 生效`, updated.age === 31, updated);

  await db.removeById('users', 2);
  ok(`${label}: removeById 生效`, (await db.count('users')) === 2, await db.count('users'));
  ok(`${label}: 删除后 findById 返回 null`, (await db.findById('users', 2)) === null);

  const q = await db.query('SELECT name, age FROM users WHERE age >= ? ORDER BY age DESC', [30]);
  ok(`${label}: query 返回 columns/rows/raw`, Array.isArray(q.columns) && eq(q.columns, ['name', 'age']), q.columns);
  ok(`${label}: query rows 为元组`, Array.isArray(q.rows) && q.rows.length === 2
    && eq(q.rows[0], ['Cara', 41]) && eq(q.rows[1], ['Alice', 31]), q.rows);
  ok(`${label}: query raw 为对象`, Array.isArray(q.raw) && q.raw[0].name === 'Cara' && q.raw[1].age === 31, q.raw);
  ok(`${label}: query rowCount`, q.rowCount === 2, q.rowCount);

  await db.stop();
}

async function suiteSqliteFeatures() {
  const db = new SqliteJSQL();
  await db.start();

  // B3：prepare / addColumn / 元数据
  await db.createTable('t', { id: { type: 'integer', primaryKey: true, autoIncrement: true }, v: { type: 'string' } });
  await db.insert('t', [{ v: 'a' }, { v: 'b' }]);
  const stmt = db.prepare('SELECT v FROM t WHERE id = ?');
  const row = stmt.get(1);
  ok('B3: prepare().get 可用', !!row && row.v === 'a', row);
  ok('B3: prepare().all 可用', db.prepare('SELECT v FROM t ORDER BY id').all().length === 2);
  ok('B3: hasTable', db.hasTable('t') === true);
  ok('B3: getTables 含 t', db.getTables().includes('t'), db.getTables());
  const schema = await db.getTableSchema('t');
  ok('B3: getTableSchema 返回列定义', !!schema && !!schema.id && schema.id.primaryKey === true, schema);

  await db.addColumn('t', 'extra', 'string default hello');
  const afterAlter = await db.findById('t', 1);
  ok('B3: addColumn 后仍可读', !!afterAlter && afterAlter.v === 'a', afterAlter);

  // find 的 orderBy（SqliteJSQL 扩展能力；原版 JSQL 忽略 orderBy）
  const ordered = await db.find('t', {}, { limit: 10, orderBy: [{ column: 'id', dir: 'desc' }] });
  ok('B3: find 支持 orderBy', eq(ordered.map(r => r.id), [2, 1]), ordered.map(r => r.id));

  // JSON 列往返
  await db.createTable('j', { id: { type: 'integer', primaryKey: true, autoIncrement: true }, meta: { type: 'json' } });
  await db.insert('j', { meta: { a: 1, b: [1, 2] } });
  const jrow = await db.findById('j', 1);
  ok('B3: JSON 列写入后读回为对象', !!jrow && typeof jrow.meta === 'object' && jrow.meta.a === 1, jrow);

  // B4：事务
  const txId = await db.beginTx();
  ok('B4: beginTx 返回 txId', typeof txId === 'string' && txId.length > 0, txId);
  await db.insert('t', { v: 'in-tx' });
  ok('B4: 事务内可见新行', (await db.count('t')) === 3, await db.count('t'));
  await db.rollbackTx(txId);
  ok('B4: rollbackTx 回滚生效', (await db.count('t')) === 2, await db.count('t'));

  await db.beginTransaction();
  await db.insert('t', { v: 'committed' });
  await db.commit();
  ok('B4: beginTransaction/commit 生效', (await db.count('t')) === 3, await db.count('t'));

  // 软删除（DROP TABLE 被安全策略拦截时的降级路径）
  const dropRes = await db.dropTable('j');
  ok('B3: dropTable 返回 ok', !!dropRes && dropRes.ok === true, dropRes);
  ok('B3: dropTable 后 hasTable 为 false', db.hasTable('j') === false);
  ok('B3: dropTable 后 count 抛错或为 0', await (async () => {
    try { return (await db.count('j')) === 0; } catch (_) { return true; }
  })());

  await db.stop();
}

async function suiteFilePersistence() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsql-sqlite-'));
  const file = path.join(dir, 'data.db');
  try {
    const db = new SqliteJSQL({ file });
    await db.start();
    await db.createTable('notes', {
      id: { type: 'integer', primaryKey: true, autoIncrement: true },
      title: { type: 'string' },
    });
    await db.insert('notes', [{ title: 'first' }, { title: 'second' }]);
    ok('B5: 文件模式写入', (await db.count('notes')) === 2, await db.count('notes'));
    await db.stop();
    ok('B5: stop 后文件已落盘', fs.existsSync(file) && fs.statSync(file).size > 0, fs.existsSync(file));

    const db2 = new SqliteJSQL({ file });
    await db2.start();
    ok('B5: 重开后表名仍在', db2.getTables().includes('notes'), db2.getTables());
    ok('B5: 重开后行数一致', (await db2.count('notes')) === 2, await db2.count('notes'));
    const first = await db2.findById('notes', 1);
    ok('B5: 重开后数据内容一致', !!first && first.title === 'first', first);
    const schema = await db2.getTableSchema('notes');
    ok('B5: 重开后 schema 一致', !!schema && schema.id.primaryKey === true, schema);
    await db2.stop();
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* ignore */ }
  }
}

(async () => {
  console.log('== SqliteJSQL (:memory:) ==');
  await crudSuite('sqlite/memory', new SqliteJSQL());

  console.log('\n== SqliteJSQL 特性（prepare/DDL/事务）==');
  await suiteSqliteFeatures();

  console.log('\n== SqliteJSQL 文件持久化 ==');
  await suiteFilePersistence();

  console.log('\n== 原版 JSQL（WASM）回归：同一组 CRUD 断言 ==');
  const wasm = new JSQL({ modules: false });
  await wasm.start();
  await crudSuite('jsql/wasm', wasm);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => {
  console.log('[FAIL] unexpected exception: ' + (e && e.stack || e));
  process.exit(1);
});
