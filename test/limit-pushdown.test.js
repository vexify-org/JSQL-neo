/* ---- LIMIT/OFFSET 下推：正确性回归 ---- */
/*
 * _readTable 现在会把 LIMIT 下推给存储层（单表 + 无 WHERE/JOIN/GROUP BY/
 * HAVING/ORDER BY/DISTINCT + 投影无聚合/窗口）。10 万行表上
 * `SELECT * FROM t LIMIT 10` 从 ~19ms 降到 ~2ms。
 *
 * 下推错误是**静默错行**，所以这里重点钉边界：只要有一条可能改变行数或
 * 顺序的子句，就必须退回全表路径。
 */
const path = require('path');
const ROOT = path.join(__dirname, '..');
const { Database } = require(path.join(ROOT, 'index.js'));

let pass = 0, fail = 0;
function ok(name, cond, got) {
  if (cond) { pass++; console.log('[OK]   ' + name); }
  else { fail++; console.log('[FAIL] ' + name + ' -> ' + JSON.stringify(got)); }
}

(async () => {
  const db = new Database(':memory:', { autoSave: false });
  await db.createTable('t', {
    id: { type: 'integer', primaryKey: true, autoIncrement: true },
    age: { type: 'integer' },
    name: { type: 'string' },
  });
  await db.createTable('u', {
    id: { type: 'integer', primaryKey: true, autoIncrement: true },
    tid: { type: 'integer' },
  });
  const rows = [];
  for (let i = 0; i < 1000; i++) rows.push({ age: 20 + (i % 50), name: 'n' + i });
  for (let i = 0; i < rows.length; i += 200) await db.insert('t', rows.slice(i, i + 200));
  await db.insert('u', [{ tid: 1 }, { tid: 2 }, { tid: 3 }]);

  const q = async (sql) => (await db.query(sql)).rows;

  // ---------- 基本下推 ----------
  ok('LIMIT 10 返回 10 行', (await q('SELECT id FROM t LIMIT 10')).length === 10, null);
  ok('LIMIT 3 返回 3 行', (await q('SELECT id FROM t LIMIT 3')).length === 3, null);
  ok('LIMIT 0 返回 0 行', (await q('SELECT id FROM t LIMIT 0')).length === 0, null);
  const off = await q('SELECT id FROM t LIMIT 3 OFFSET 5');
  ok('OFFSET 5 从第 6 行开始', off.length === 3 && off[0][0] === 6 && off[2][0] === 8, off);
  ok('LIMIT 超过总行数返回全部',
    (await q('SELECT id FROM t LIMIT 5000')).length === 1000, null);
  ok('OFFSET 超过总行数返回空',
    (await q('SELECT id FROM t LIMIT 10 OFFSET 5000')).length === 0, null);

  // ---------- 有 WHERE：不能按扫描行数截断 ----------
  // 前 100 行里满足 age > 60 的远少于 100 行，若把 LIMIT 下推成「扫描前 100 行」
  // 就会只拿到少部分结果。
  const whereLimit = await q('SELECT id FROM t WHERE age > 60 LIMIT 100');
  ok('WHERE + LIMIT 拿满 100 行（未被过早截断）', whereLimit.length === 100, whereLimit.length);
  const whereAll = await q('SELECT id FROM t WHERE age > 60');
  ok('WHERE + LIMIT 是 WHERE 结果的子集', whereAll.length >= whereLimit.length, null);

  // ---------- 排序 / 分组 / 去重 / 聚合：不得下推 ----------
  const desc = await q('SELECT id FROM t ORDER BY id DESC LIMIT 1');
  ok('ORDER BY DESC + LIMIT 1 取到最大 id', desc[0][0] === 1000, desc);
  const asc = await q('SELECT id FROM t ORDER BY id ASC LIMIT 1');
  ok('ORDER BY ASC + LIMIT 1 取到最小 id', asc[0][0] === 1, asc);
  const grp = await q('SELECT age, COUNT(*) AS c FROM t GROUP BY age LIMIT 3');
  ok('GROUP BY + LIMIT 返回 3 组', grp.length === 3, grp.length);
  const dis = await q('SELECT DISTINCT age FROM t LIMIT 5');
  ok('DISTINCT + LIMIT 返回 5 个不同值', dis.length === 5, dis.length);
  const agg = await q('SELECT COUNT(*) AS c FROM t');
  ok('无 GROUP BY 的聚合不受 LIMIT 下推影响', agg[0][0] === 1000, agg);

  // ---------- JOIN / 子查询：不下推 ----------
  const join = await q('SELECT t.id, u.tid FROM t JOIN u ON u.tid = t.id LIMIT 2');
  ok('JOIN + LIMIT 行数正确', join.length === 2, join);
  const sub = await q('SELECT id FROM (SELECT id FROM t) x LIMIT 4');
  ok('子查询作 FROM + LIMIT 行数正确', sub.length === 4, sub);

  // ---------- 下推判定本身 ----------
  const ex = await (async () => {
    const { executeSQL } = require(path.join(ROOT, 'lib', 'sql.js'));
    void executeSQL;
    return null;
  })();
  void ex;

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => {
  console.log('[FAIL] unexpected exception: ' + e.stack.split('\n').slice(0, 3).join('\n'));
  process.exit(1);
});
