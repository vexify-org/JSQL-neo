/*
 * 非保留关键字当标识符测试。
 *
 * 问题：词法层的 KEYWORDS 表把一些「MySQL 里其实是非保留」的词也标成了 keyword，
 * 而 parseTableName / parseColumnRef 只认 ident，于是这些最普通的写法被拒：
 *     CREATE TABLE t (date DATE, text TEXT, count INT)
 *     SELECT date, count FROM t
 * 实测 64 个常见列名里有 31 个被拒，其中 date / text / count / engine /
 * first / after / unsigned / zerofill / spatial / ignore / start
 * 在 MySQL 里都不是保留字 —— 用户没有理由必须加反引号。
 *
 * 修法：不让词法层去区分（parseColumnDef 还依赖 type === 'keyword' 来认类型），
 * 改在「期望一个名字」的位置放行 NON_RESERVED_KEYWORDS 里的词。
 * 这与文件里 OVER / PARTITION 那条注释是同一个思路。
 *
 * 真正的保留字（TABLE / SELECT / KEY / ORDER / INDEX / GROUP / CASE ...）
 * 仍然要求反引号 —— 这些用例用来防止放行范围被不小心扩大。
 */
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

(async () => {
  const db = new Database(':memory:');
  const q = (sql) => executeSQL(db, sql, OPTS);
  const rows = async (sql) => (await q(sql)).rows;
  const okSql = async (sql) => { try { await q(sql); return true; } catch (_) { return false; } };

  console.log('\n--- 非保留关键字可以当列名 ---');
  const asColumn = ['first', 'after', 'date', 'time', 'datetime', 'timestamp', 'text',
    'engine', 'ignore', 'spatial', 'unsigned', 'zerofill', 'start', 'count',
    'number', 'value', 'type', 'state', 'level', 'source', 'data', 'total'];
  for (const n of asColumn) {
    ok(`列名 ${n}`, await okSql(`CREATE TABLE c_${n} (id INT PRIMARY KEY, ${n} TEXT)`));
  }

  console.log('\n--- 非保留关键字可以当表名 ---');
  for (const n of ['date', 'text', 'count', 'engine', 'first']) {
    ok(`表名 ${n}`, await okSql(`CREATE TABLE ${n} (id INT PRIMARY KEY)`));
  }

  console.log('\n--- 建表后能正常读写 ---');
  {
    await q('CREATE TABLE events (id INT PRIMARY KEY, date TEXT, text TEXT, count INT, engine TEXT)');
    await q("INSERT INTO events VALUES (1, '2026-01-01', 'hello', 3, 'innodb')");
    const r = await rows('SELECT id, date, text, count, engine FROM events');
    ok('按这些列名查询正常', JSON.stringify(r) === '[[1,"2026-01-01","hello",3,"innodb"]]', r);

    const w = await rows("SELECT id FROM events WHERE date = '2026-01-01' AND count = 3");
    ok('按这些列名过滤正常', JSON.stringify(w) === '[[1]]', w);

    await q('UPDATE events SET count = 4 WHERE id = 1');
    ok('按这些列名更新正常', (await rows('SELECT count FROM events'))[0][0] === 4);

    await q('CREATE INDEX idx_date ON events (date)');
    ok('按这些列名建索引正常', (await rows("SELECT id FROM events WHERE date = '2026-01-01'"))[0][0] === 1);
  }

  console.log('\n--- ALTER TABLE 上也适用 ---');
  {
    await q('CREATE TABLE a1 (id INT PRIMARY KEY)');
    await q('ALTER TABLE a1 ADD COLUMN date TEXT');
    await q('ALTER TABLE a1 ADD COLUMN count INT');
    ok('ADD COLUMN 用非保留关键字', (await q('SELECT * FROM a1')).columns.join(',') === 'id,date,count');

    await q('ALTER TABLE a1 RENAME COLUMN date TO time');
    ok('RENAME COLUMN 用非保留关键字', (await q('SELECT * FROM a1')).columns.join(',') === 'id,time,count');

    await q('ALTER TABLE a1 DROP COLUMN time');
    ok('DROP COLUMN 用非保留关键字', (await q('SELECT * FROM a1')).columns.join(',') === 'id,count');
  }

  console.log('\n--- 主键 / 唯一约束里也能用 ---');
  {
    await q('CREATE TABLE k1 (date TEXT PRIMARY KEY, count INT UNIQUE)');
    await q("INSERT INTO k1 VALUES ('a', 1)");
    let threw = false;
    try { await q("INSERT INTO k1 VALUES ('a', 2)"); } catch (_) { threw = true; }
    ok('非保留关键字作主键仍受约束', threw);
  }

  console.log('\n--- ORDER BY / GROUP BY / 别名 不受影响 ---');
  {
    await q('CREATE TABLE s1 (id INT PRIMARY KEY, count INT, date TEXT)');
    await q("INSERT INTO s1 VALUES (1,1,'a'),(2,2,'b'),(3,1,'c')");
    const ob = await rows('SELECT count FROM s1 ORDER BY count DESC, id');
    ok('ORDER BY 用这些列名', JSON.stringify(ob) === '[[2],[1],[1]]', ob);
    const gb = await rows('SELECT count, COUNT(*) AS n FROM s1 GROUP BY count ORDER BY count');
    ok('GROUP BY 用这些列名', JSON.stringify(gb) === '[[1,2],[2,1]]', gb);
    const al = await rows('SELECT count AS total FROM s1 WHERE id = 2');
    ok('AS 别名不受影响', JSON.stringify(al) === '[[2]]', al);
  }

  console.log('\n--- 函数名仍然优先当函数解析 ---');
  {
    const one = async (sql) => (await q(sql)).rows[0][0];
    ok('COUNT(*) 仍是聚合函数', await one('SELECT COUNT(*) FROM (SELECT 1 AS x) t') === 1);
    ok('MAX() 仍是函数', await one('SELECT MAX(x) FROM (SELECT 1 AS x UNION ALL SELECT 2) t') === 2);
    ok('MIN() 仍是函数', await one('SELECT MIN(x) FROM (SELECT 1 AS x UNION ALL SELECT 2) t') === 1);
    ok('SUM() 仍是函数', await one('SELECT SUM(x) FROM (SELECT 3 AS x) t') === 3);
    ok('DATE() 仍是函数', typeof await one("SELECT DATE('2026-01-01')") === 'string');
    ok('COUNT() 紧跟括号才是函数', await one('SELECT COUNT(*) FROM (SELECT 1 AS x) t') === 1);
    ok('裸 count 当列时不吞掉后面的 FROM', await okSql('SELECT count FROM (SELECT 1 AS count) t'));
  }

  console.log('\n--- 真保留字仍要求反引号（防止放行范围被扩大）---');
  const reserved = ['key', 'order', 'group', 'index', 'column', 'table',
    'case', 'when', 'then', 'else', 'end', 'select', 'from', 'where'];
  for (const n of reserved) {
    ok(`裸写 ${n} 作列名仍被拒`, !(await okSql(`CREATE TABLE r_${n} (${n} TEXT)`)));
  }
  ok('反引号包裹后可用', await okSql('CREATE TABLE r_ok (`key` TEXT, `order` INT)'));
  {
    await q('CREATE TABLE r_ok2 (`key` TEXT, `order` INT)');
    await q("INSERT INTO r_ok2 VALUES ('k', 1)");
    const r = await rows('SELECT `key`, `order` FROM r_ok2');
    ok('反引号包裹后可读写', JSON.stringify(r) === '[["k",1]]', r);
  }

  console.log('\n--- 带点号的限定名 ---');
  {
    await q('CREATE TABLE q1 (date TEXT)');
    await q("INSERT INTO q1 VALUES ('x')");
    const r = await rows('SELECT q1.date FROM q1');
    ok('表名.非保留关键字列名', JSON.stringify(r) === '[["x"]]', r);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('💥', e); process.exit(1); });
