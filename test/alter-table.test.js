/*
 * ALTER TABLE 补全测试（RENAME TO / RENAME COLUMN / DROP INDEX）。
 *
 * 这三条此前各自以不同方式「看起来成功」：
 *   - ALTER ... RENAME TO t2   → 返回 ok:true，但表名根本没变
 *   - ALTER ... RENAME COLUMN  → 解析期就报 "Expected table name, got 'COLUMN'"
 *   - ALTER ... DROP INDEX idx → 返回 ok:true，索引还在
 *   - ALTER ... ADD FOREIGN KEY→ 返回 ok:true，什么都没加
 * 执行器里这三类 op 落在同一个 `default: break`，也就是静默无操作 ——
 * 比报错更糟，调用方会以为改成功了。
 *
 * 现在：能做的真做，做不到的明确报错（外键在这个引擎里没实现）。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const { Database } = require(path.join(ROOT, 'index.js'));
const { executeSQL } = require(path.join(ROOT, 'lib/sql.js'));

const OPTS = { safety: false };
let pass = 0, fail = 0;

function ok(name, cond, extra) {
  if (cond) { pass++; console.log('[OK]  ', name); }
  else { fail++; console.log('[FAIL]', name, extra !== undefined ? '-> ' + JSON.stringify(extra).slice(0, 140) : ''); }
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

async function t(name, fn) {
  const db = new Database(':memory:');
  const exec = (sql) => executeSQL(db, sql, OPTS);
  const rows = async (sql) => (await exec(sql)).rows;
  const mustFail = async (sql) => {
    try { await exec(sql); return false; } catch (_) { return true; }
  };
  try {
    const r = await fn({ db, exec, rows, mustFail });
    ok(name, r === undefined ? true : !!r);
  } catch (e) {
    ok(name, false, e.message);
  }
}

(async () => {
  console.log('\n--- RENAME TO ---');
  await t('改名真的生效，数据不丢', async ({ db, exec, rows }) => {
    await exec('CREATE TABLE t (id INT PRIMARY KEY, v TEXT)');
    await exec("INSERT INTO t VALUES (1,'x')");
    await exec('ALTER TABLE t RENAME TO t2');
    const tables = (await db.getTables()).slice().sort();
    return eq(tables, ['t2']) && eq(await rows('SELECT id, v FROM t2'), [[1, 'x']]);
  });

  await t('旧表名不再可用，新名字可取属性', async ({ db, exec, rows, mustFail }) => {
    await exec('CREATE TABLE t (id INT PRIMARY KEY)');
    await exec('ALTER TABLE t RENAME TO t2');
    const oldGone = await mustFail('SELECT * FROM t');
    return oldGone && !!db.t2 && db.t === undefined && rows('SELECT * FROM t2') !== null;
  });

  await t('RENAME AS 也支持', async ({ db, exec }) => {
    await exec('CREATE TABLE t (id INT PRIMARY KEY)');
    await exec('ALTER TABLE t RENAME AS t3');
    return eq((await db.getTables()).slice().sort(), ['t3']);
  });

  await t('改成已存在的表名 → 报错', async ({ db, exec, mustFail }) => {
    await exec('CREATE TABLE a (id INT PRIMARY KEY)');
    await exec('CREATE TABLE b (id INT PRIMARY KEY)');
    const bad = await mustFail('ALTER TABLE a RENAME TO b');
    return bad && eq((await db.getTables()).slice().sort(), ['a', 'b']);
  });

  await t('改名不存在的表 → 报错', async ({ exec, mustFail }) => {
    return mustFail('ALTER TABLE nope RENAME TO x');
  });

  await t('改成同名 = 无事发生，不算错', async ({ db, exec }) => {
    await exec('CREATE TABLE t (id INT PRIMARY KEY)');
    await exec('ALTER TABLE t RENAME TO t');
    return eq((await db.getTables()).slice().sort(), ['t']);
  });

  // renameTable 后来被改成 async（它要 await _runHooks）。执行器这边一度
  // 忘了 await —— 冲突时报错变成未处理的 Promise 拒绝：SQL 照常返回 ok:true，
  // 调用方以为改名成功，随后进程被 rejection 打崩。
  await t('改名冲突：报错且不产生未处理的 Promise 拒绝', async ({ db, exec, mustFail }) => {
    let unhandled = null;
    const onUnhandled = (e) => { unhandled = e; };
    process.on('unhandledRejection', onUnhandled);
    try {
      await exec('CREATE TABLE a (id INT PRIMARY KEY)');
      await exec('CREATE TABLE b (id INT PRIMARY KEY)');
      const bad = await mustFail('ALTER TABLE a RENAME TO b');
      // 让微任务队列跑完，未处理的 rejection 会在此暴露
      await new Promise(r => setImmediate(r));
      return bad && unhandled === null && eq((await db.getTables()).slice().sort(), ['a', 'b']);
    } finally {
      process.removeListener('unhandledRejection', onUnhandled);
    }
  });

  await t('改名后主键/自增/唯一约束仍然生效', async ({ exec, rows, mustFail }) => {
    await exec('CREATE TABLE t (id INTEGER PRIMARY KEY AUTOINCREMENT, e TEXT UNIQUE)');
    await exec("INSERT INTO t (e) VALUES ('a')");
    await exec('ALTER TABLE t RENAME TO t2');
    await exec("INSERT INTO t2 (e) VALUES ('b')");
    const dupPk = await mustFail('INSERT INTO t2 (id, e) VALUES (1, \'c\')');
    const dupUniq = await mustFail("INSERT INTO t2 (e) VALUES ('a')");
    const all = await rows('SELECT id, e FROM t2 ORDER BY id');
    return eq(all, [[1, 'a'], [2, 'b']]) && dupPk && dupUniq;
  });

  console.log('\n--- RENAME COLUMN ---');
  await t('改列名真的生效，数据不丢', async ({ exec, rows }) => {
    await exec('CREATE TABLE t (id INT PRIMARY KEY, a TEXT)');
    await exec("INSERT INTO t VALUES (1,'x')");
    await exec('ALTER TABLE t RENAME COLUMN a TO name');
    return eq(await rows('SELECT id, name FROM t'), [[1, 'x']]);
  });

  await t('列的先后顺序保持不变', async ({ exec }) => {
    await exec('CREATE TABLE t (id INT PRIMARY KEY, a TEXT, b TEXT, c TEXT)');
    await exec('ALTER TABLE t RENAME COLUMN b TO b2');
    // 直接改 schema 的键会把这一列挪到末尾，SELECT * 的列序就变了
    return eq((await exec('SELECT * FROM t')).columns, ['id', 'a', 'b2', 'c']);
  });

  await t('列级约束（NOT NULL / UNIQUE / 主键）跟着走', async ({ exec, mustFail, rows }) => {
    await exec('CREATE TABLE t (id INT PRIMARY KEY, code TEXT NOT NULL UNIQUE)');
    await exec("INSERT INTO t VALUES (1,'a')");
    await exec('ALTER TABLE t RENAME COLUMN code TO code2');
    const nullBad = await mustFail('INSERT INTO t (id, code2) VALUES (2, NULL)');
    const dupBad = await mustFail("INSERT INTO t (id, code2) VALUES (3, 'a')");
    await exec("INSERT INTO t VALUES (4, 'b')");
    return nullBad && dupBad && eq(await rows('SELECT id, code2 FROM t ORDER BY id'), [[1, 'a'], [4, 'b']]);
  });

  await t('改列名后自增字段仍认得出来', async ({ exec, rows }) => {
    await exec('CREATE TABLE t (id INTEGER PRIMARY KEY AUTOINCREMENT, v TEXT)');
    await exec('ALTER TABLE t RENAME COLUMN id TO sid');
    await exec("INSERT INTO t (v) VALUES ('a'), ('b')");
    return eq(await rows('SELECT sid, v FROM t ORDER BY sid'), [[1, 'a'], [2, 'b']]);
  });

  await t('改列名会同步列上的索引', async ({ exec, rows }) => {
    await exec('CREATE TABLE t (id INT PRIMARY KEY, a TEXT)');
    await exec('ALTER TABLE t RENAME COLUMN a TO b');
    await exec("INSERT INTO t VALUES (1,'x')");
    // 表对象上的索引是以旧列名建的，改名后按新列名查必须仍然走得到数据
    return eq(await rows('SELECT id FROM t WHERE b = \'x\''), [[1]]);
  });

  await t('列不存在 → 报错', async ({ exec, mustFail }) => {
    await exec('CREATE TABLE t (id INT PRIMARY KEY)');
    return mustFail('ALTER TABLE t RENAME COLUMN zzz TO yyy');
  });

  await t('改成已存在的列名 → 报错', async ({ exec, mustFail, rows }) => {
    await exec('CREATE TABLE t (id INT PRIMARY KEY, a TEXT, b TEXT)');
    await exec("INSERT INTO t VALUES (1,'x','y')");
    const bad = await mustFail('ALTER TABLE t RENAME COLUMN b TO a');
    return bad && eq(await rows('SELECT id, a, b FROM t'), [[1, 'x', 'y']]);
  });

  await t('RENAME COLUMN 缺 TO → 报错', async ({ exec, mustFail }) => {
    await exec('CREATE TABLE t (id INT PRIMARY KEY, a TEXT)');
    return mustFail('ALTER TABLE t RENAME COLUMN a b');
  });

  await t('改成同名列 = 无事发生', async ({ exec, rows }) => {
    await exec('CREATE TABLE t (id INT PRIMARY KEY, a TEXT)');
    await exec("INSERT INTO t VALUES (1,'x')");
    await exec('ALTER TABLE t RENAME COLUMN a TO a');
    return eq(await rows('SELECT a FROM t'), [['x']]);
  });

  console.log('\n--- DROP INDEX / DROP KEY ---');
  await t('DROP INDEX 真的删掉索引', async ({ db, exec }) => {
    await exec('CREATE TABLE t (id INT PRIMARY KEY, a TEXT)');
    await exec('CREATE INDEX idx_a ON t (a)');
    const before = Object.keys(db.t._indexes).length + Object.keys(db.t._btrees).length;
    await exec('ALTER TABLE t DROP INDEX idx_a');
    const after = Object.keys(db.t._indexes).length + Object.keys(db.t._btrees).length;
    return before > 0 && after < before;
  });

  await t('DROP KEY 是同一件事的另一种写法', async ({ db, exec }) => {
    await exec('CREATE TABLE t (id INT PRIMARY KEY, a TEXT)');
    // 记下建索引前的状态：主键会在 _btrees 里留一个 id 索引，那是该留的
    const baseline = Object.keys(db.t._indexes).length + Object.keys(db.t._btrees).length;
    await exec('CREATE INDEX idx_a ON t (a)');
    const withIndex = Object.keys(db.t._indexes).length + Object.keys(db.t._btrees).length;
    await exec('ALTER TABLE t DROP KEY idx_a');
    const after = Object.keys(db.t._indexes).length + Object.keys(db.t._btrees).length;
    return withIndex > baseline && after === baseline;
  });

  await t('删索引不影响数据', async ({ exec, rows }) => {
    await exec('CREATE TABLE t (id INT PRIMARY KEY, a TEXT)');
    await exec("INSERT INTO t VALUES (1,'x')");
    await exec('CREATE INDEX idx_a ON t (a)');
    await exec('ALTER TABLE t DROP INDEX idx_a');
    return eq(await rows('SELECT id, a FROM t'), [[1, 'x']]);
  });

  await t('删不存在的索引 → 报错', async ({ exec, mustFail }) => {
    await exec('CREATE TABLE t (id INT PRIMARY KEY, a TEXT)');
    return mustFail('ALTER TABLE t DROP INDEX nope');
  });

  console.log('\n--- 明确报错而不是静默无操作 ---');
  await t('ADD FOREIGN KEY → 明确报不支持', async ({ exec }) => {
    await exec('CREATE TABLE t (id INT PRIMARY KEY, a TEXT)');
    try {
      await exec('ALTER TABLE t ADD CONSTRAINT fk FOREIGN KEY (a) REFERENCES p(id)');
      return false;
    } catch (e) { return /not supported/i.test(e.message) && /foreign key/i.test(e.message); }
  });

  await t('DROP FOREIGN KEY → 明确报不支持', async ({ exec }) => {
    await exec('CREATE TABLE t (id INT PRIMARY KEY, a TEXT)');
    try {
      await exec('ALTER TABLE t DROP FOREIGN KEY fk');
      return false;
    } catch (e) { return /not supported/i.test(e.message) && /foreign key/i.test(e.message); }
  });

  await t('RENAME INDEX → 明确报不支持并给出替代做法', async ({ exec }) => {
    await exec('CREATE TABLE t (id INT PRIMARY KEY, a TEXT)');
    try {
      await exec('ALTER TABLE t RENAME INDEX i TO j');
      return false;
    } catch (e) { return /not supported/i.test(e.message) && /DROP INDEX/i.test(e.message); }
  });

  console.log('\n--- 多操作与组合 ---');
  await t('一条语句里多个操作按序执行', async ({ db, exec, rows }) => {
    await exec('CREATE TABLE t (id INT PRIMARY KEY, a TEXT)');
    await exec("INSERT INTO t VALUES (1,'x')");
    await exec('ALTER TABLE t ADD COLUMN b TEXT, RENAME COLUMN a TO a2');
    const cols = (await exec('SELECT * FROM t')).columns;
    const r = await rows('SELECT id, a2, b FROM t');
    return eq(r, [[1, 'x', null]]) && cols.includes('a2') && cols.includes('b');
  });

  await t('改名后的表可以继续 DDL / DML', async ({ db, exec, rows }) => {
    await exec('CREATE TABLE t (id INT PRIMARY KEY, v TEXT)');
    await exec('ALTER TABLE t RENAME TO t2');
    await exec('ALTER TABLE t2 RENAME COLUMN v TO val');
    await exec("INSERT INTO t2 VALUES (1,'a')");
    await exec('CREATE INDEX ix ON t2 (val)');
    await exec('DELETE FROM t2 WHERE val = \'zzz\'');
    return eq(await rows('SELECT id, val FROM t2'), [[1, 'a']]);
  });

  console.log('\n--- 持久化 ---');
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsql-alter-'));
    const file = path.join(dir, 'db.jsql');
    try {
      const db = new Database(file, { wal: true, autoSave: false });
      const exec = (sql) => executeSQL(db, sql, OPTS);
      await exec('CREATE TABLE t (id INT PRIMARY KEY, a TEXT)');
      await exec("INSERT INTO t VALUES (1,'x')");
      await exec('ALTER TABLE t RENAME TO t2');
      await exec('ALTER TABLE t2 RENAME COLUMN a TO name');
      await db.save();

      const db2 = new Database(file, { wal: true });
      const exec2 = (sql) => executeSQL(db2, sql, OPTS);
      const tables = (await db2.getTables()).slice().sort();
      const cols = (await exec2('SELECT * FROM t2')).columns;
      const r = (await exec2('SELECT id, name FROM t2')).rows;
      ok('重开后表名与列名都保住', eq(tables, ['t2']) && eq(cols, ['id', 'name']) && eq(r, [[1, 'x']]),
        { tables, cols, r });
    } catch (e) {
      ok('重开后表名与列名都保住', false, e.message);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  console.log('\n--- 目录模式（改名的物理文件也要跟着挪）---');
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsql-alterdir-'));
    try {
      const db = new Database(dir, { mode: 'disk', autoSave: false });
      const exec = (sql) => executeSQL(db, sql, OPTS);
      await exec('CREATE TABLE t (id INT PRIMARY KEY, a TEXT)');
      await exec("INSERT INTO t VALUES (1,'x')");
      await exec('ALTER TABLE t RENAME TO t2');
      const files = fs.readdirSync(dir).filter(f => f.endsWith('.jsql'));
      const tables = (await db.getTables()).slice().sort();
      ok('目录模式改名后表列表正确', eq(tables, ['t2']), tables);
      ok('物理文件名跟着改了', files.some(f => f.includes('t2')) && !files.some(f => /(^|[^2])t\.jsql$/.test(f)), files);
    } catch (e) {
      ok('目录模式改名', false, e.message);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('💥', e); process.exit(1); });
