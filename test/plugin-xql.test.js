/*
 * xql 插件测试：把 JSQL 表加载成 XQL 集合，写入自动失效重建。
 *
 * 验证点：
 *   1. 标准 SQL 与管道式语法都能查询 JSQL 表
 *   2. 索引（hash / range）在查询前生效且结果不变
 *   3. 插入 / 更新 / 删除后缓存失效，查询反映最新数据
 *   4. 便捷 API（load / refresh / tables / collection / clear / index）
 *   5. 未加载且 autoLoad=false 时报错
 *   6. native 引擎（可用时）同样工作
 */
const path = require('path');
const ROOT = path.join(__dirname, '..');
const { Database } = require(path.join(ROOT, 'index.js'));
const plugins = require(path.join(ROOT, 'lib/plugins'));
const xqlPlugin = plugins.xql;

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('[OK]  ', name); }
  else { fail++; console.log('[FAIL]', name, extra !== undefined ? '-> ' + JSON.stringify(extra).slice(0, 140) : ''); }
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const USER_SCHEMA = {
  id: { type: 'integer' },
  name: { type: 'string' },
  age: { type: 'integer' },
  score: { type: 'integer' },
};

async function makeDb(Engine, opts) {
  const db = new Engine(':memory:', { modules: false });
  await db.start();
  db.use(xqlPlugin(opts || {}));
  await db.createTable('users', USER_SCHEMA);
  await db.insert('users', [
    { id: 1, name: 'ann', age: 25, score: 90 },
    { id: 2, name: 'bob', age: 17, score: 70 },
    { id: 3, name: 'cat', age: 34, score: 55 },
    { id: 4, name: 'dan', age: 17, score: null },
  ]);
  return db;
}

async function testEngine(Engine, label) {
  console.log(`\n===== ${label} =====`);

  const db = await makeDb(Engine);

  console.log('\n--- 查询（标准 SQL）---');
  const rows = await db.xql('SELECT name FROM users WHERE age > 18 ORDER BY name');
  ok('age > 18 排序返回', eq(rows, [{ name: 'ann' }, { name: 'cat' }]), rows);

  console.log('\n--- 查询（管道式）---');
  const pipe = await db.xql('FROM users |> WHERE age > 18 |> SELECT name |> ORDER BY name');
  ok('管道式与标准 SQL 等价', eq(pipe, rows), pipe);

  console.log('\n--- 索引 ---');
  db.xqlIndex('users', 'id');
  db.xqlIndex('users', 'score', 'range');
  const coll = db.xqlCollection('users');
  ok('集合已建 id hash 索引', !!(coll && coll._indexes.has('id')));
  ok('集合已建 score range 索引', !!(coll && coll._indexes.has('score')));
  const eqById = await db.xql('SELECT id FROM users WHERE id = 2');
  ok('hash 索引点查', eq(eqById, [{ id: 2 }]), eqById);
  const rng = await db.xql('SELECT id FROM users WHERE score >= 70 ORDER BY id');
  ok('range 索引范围查', eq(rng, [{ id: 1 }, { id: 2 }]), rng);
  ok('index 记录在 tables 里', db.xqlTables().includes('users'));

  console.log('\n--- 写入失效 ---');
  await db.insert('users', [{ id: 5, name: 'eve', age: 40, score: 88 }]);
  const afterIns = await db.xql('SELECT name FROM users WHERE id = 5');
  ok('插入后立即可见（缓存重建）', eq(afterIns, [{ name: 'eve' }]), afterIns);

  await db.updateById('users', 2, { age: 99 });
  const afterUpd = await db.xql('SELECT name FROM users WHERE age > 98');
  ok('更新后立即可见', eq(afterUpd, [{ name: 'bob' }]), afterUpd);

  await db.removeById('users', 1);
  const afterDel = await db.xql('SELECT name FROM users WHERE id = 1');
  ok('删除后不可见', eq(afterDel, []), afterDel);

  console.log('\n--- 便捷 API ---');
  const t = await db.xqlLoad('users');
  ok('load 返回集合', t && t.size === 4, t && t.size);
  const r = await db.xqlRefresh('users');
  ok('refresh 重建', r && r.size === 4);
  ok('tables() 有 users', db.xqlTables().includes('users'));
  ok('collection() 取到', db.xqlCollection('users') === r);
  db.xqlClear('users');
  ok('clear 后 collection 为空', db.xqlCollection('users') === null);
  ok('clear 后 tables 为空', !db.xqlTables().includes('users'));
  const auto = await db.xql('SELECT name FROM users WHERE age > 18 ORDER BY name');
  ok('clear 后再查自动重载', eq(auto, [{ name: 'bob' }, { name: 'cat' }, { name: 'eve' }]), auto);

  await db.stop();
}

async function testAutoLoadOff() {
  console.log('\n===== autoLoad=false =====');
  const db = new Database(':memory:', { modules: false });
  await db.start();
  db.use(xqlPlugin({ autoLoad: false }));
  await db.createTable('users', USER_SCHEMA);
  await db.insert('users', [{ id: 1, name: 'ann', age: 25, score: 90 }]);
  let threw = false;
  try { await db.xql('SELECT name FROM users'); } catch (e) { threw = /未加载/.test(e.message); }
  ok('autoLoad=false 未加载报错', threw);
  await db.xqlLoad('users');
  const r = await db.xql('SELECT name FROM users');
  ok('显式 load 后可查', eq(r, [{ name: 'ann' }]), r);
  await db.stop();
}

async function testTableName() {
  console.log('\n===== 显式数据源 opts.table =====');
  const db = new Database(':memory:', { modules: false });
  await db.start();
  db.use(xqlPlugin());
  await db.createTable('users', USER_SCHEMA);
  await db.insert('users', [{ id: 1, name: 'ann', age: 25, score: 90 }]);
  const r = await db.xql('SELECT name FROM users WHERE age > 18', { table: 'users' });
  ok('opts.table 指定源', eq(r, [{ name: 'ann' }]), r);
  await db.stop();
}

async function testInstalledPluginAutoLoad() {
  console.log('\n===== 注册表插件自动加载（entry 仓库相对路径 + 根级文件）=====');
  const os = require('os');
  const fs = require('fs');
  const home = os.homedir();
  const name = '_xqltest_registry';
  const dir = path.join(home, '.jsql', 'plugins', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.js'),
    "module.exports = { name: '" + name + "', install(engine) { engine.__xqltest = true; } };\n");
  fs.writeFileSync(path.join(dir, 'manifest.json'),
    JSON.stringify({ name, version: '1.0.0', entry: 'plugins/' + name + '/index.js', files: [] }));
  try {
    const db = new Database(':memory:', { modules: true });
    await db.start();
    ok('仓库相对 entry + 根级 index.js 能自动加载', db.__xqltest === true);
    await db.stop();
  } finally {
    try { fs.rmSync(path.join(home, '.jsql', 'plugins', name), { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

(async () => {
  await testEngine(Database, 'Database (Pure JS)');
  await testAutoLoadOff();
  await testTableName();
  await testInstalledPluginAutoLoad();

  // native 引擎（Linux 上可用；Android 等平台无二进制时跳过）
  try {
    const Native = require(path.join(ROOT, 'lib/native_client')).JSQL;
    if (typeof Native === 'function') {
      await testEngine(Native, 'NativeJSQL (Rust)');
    } else {
      console.log('\n[native] JSQL export not a constructor, skip');
    }
  } catch (e) {
    console.log('\n[native] 不可用，跳过:', e.message.slice(0, 80));
  }

  console.log(`\n=== pass ${pass}  fail ${fail} ===`);
  process.exit(fail ? 1 : 0);
})();
