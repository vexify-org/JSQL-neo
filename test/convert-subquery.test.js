/* ---- CONVERT / BINARY / GROUP_CONCAT / HAVING / IN 子查询的 NULL 语义 ---- */
/*
 * 这一轮差分探针（16 条）只错 2 条，都是 `CONVERT(expr, type)` 没被解析
 * （报 no such column: SIGNED）—— 功能缺失，不是静默错值。补上后连同
 * 同批验证过、但此前没有回归覆盖的边界一起钉住。
 */
const path = require('path');
const ROOT = path.join(__dirname, '..');
const { Database, executeSQL } = require(path.join(ROOT, 'index.js'));

let pass = 0, fail = 0;
function ok(name, cond, got) {
  if (cond) { pass++; console.log('[OK]   ' + name); }
  else { fail++; console.log('[FAIL] ' + name + ' -> ' + JSON.stringify(got)); }
}

(async () => {
  const db = new Database(':memory:', { autoSave: false });
  await db.createTable('t', {
    id: { type: 'integer', primaryKey: true, autoIncrement: true },
    g: { type: 'string' }, v: { type: 'integer' },
  });
  await db.insert('t', [{ g: 'a', v: 1 }, { g: 'a', v: 2 }, { g: 'b', v: 3 }]);
  await db.createTable('s', {
    id: { type: 'integer', primaryKey: true, autoIncrement: true }, v: { type: 'integer' },
  });
  await db.insert('s', [{ v: 1 }, { v: null }]);
  await db.createTable('empty', {
    id: { type: 'integer', primaryKey: true, autoIncrement: true }, v: { type: 'integer' },
  });

  const q = async (sql) => (await executeSQL(db, sql, { safety: false })).rows[0][0];

  // ---------- CONVERT(expr, type)：与 CAST 语义一致 ----------
  ok("CONVERT('12abc', SIGNED) = 12", await q("SELECT CONVERT('12abc', SIGNED)") === 12, null);
  ok('CONVERT(42, CHAR) = "42"', await q('SELECT CONVERT(42, CHAR)') === '42', null);
  ok('CONVERT(1.9, SIGNED) = 2（四舍五入）', await q('SELECT CONVERT(1.9, SIGNED)') === 2, null);
  ok('CONVERT(12.9, INTEGER) = 13', await q('SELECT CONVERT(12.9, INTEGER)') === 13, null);
  ok("CONVERT('3.14159', DECIMAL(10,2)) = 3.14",
    await q("SELECT CONVERT('3.14159', DECIMAL(10,2))") === 3.14, null);
  ok('CONVERT(NULL, SIGNED) = NULL', await q('SELECT CONVERT(NULL, SIGNED)') === null, null);
  ok('CONVERT(-5, UNSIGNED) 按 2^64 回绕',
    String(await q('SELECT CONVERT(-5, UNSIGNED)')) === '18446744073709551611', null);
  ok('CONVERT 与 CAST 结果一致',
    await q('SELECT CONVERT(12.9, SIGNED)') === await q('SELECT CAST(12.9 AS SIGNED)'), null);

  // ---------- BINARY：大小写敏感 ----------
  ok("BINARY g = 'A' 不命中小写 'a'",
    await q("SELECT COUNT(*) AS c FROM t WHERE BINARY g = 'A'") === 0, null);
  ok("默认 collation 下 g = 'A' 命中 'a'（CI）",
    await q("SELECT COUNT(*) AS c FROM t WHERE g = 'A'") === 2, null);

  // ---------- GROUP_CONCAT ----------
  ok('GROUP_CONCAT 默认逗号', await q('SELECT GROUP_CONCAT(v) AS x FROM t') === '1,2,3', null);
  ok("GROUP_CONCAT SEPARATOR '|'",
    await q("SELECT GROUP_CONCAT(v SEPARATOR '|') AS x FROM t") === '1|2|3', null);
  ok('GROUP_CONCAT ORDER BY DESC',
    await q('SELECT GROUP_CONCAT(v ORDER BY v DESC) AS x FROM t') === '3,2,1', null);
  ok('GROUP_CONCAT DISTINCT', await q('SELECT GROUP_CONCAT(DISTINCT g) AS x FROM t') === 'a,b', null);

  // ---------- HAVING：表达式与别名等价 ----------
  const h1 = JSON.stringify((await executeSQL(db, 'SELECT g, SUM(v) AS s FROM t GROUP BY g HAVING SUM(v) > 2', { safety: false })).rows);
  const h2 = JSON.stringify((await executeSQL(db, 'SELECT g, SUM(v) AS s FROM t GROUP BY g HAVING s > 2', { safety: false })).rows);
  ok('HAVING 聚合表达式', h1 === '[["a",3],["b",3]]', h1);
  ok('HAVING 用别名与表达式结果一致', h1 === h2, { h1, h2 });

  // ---------- IN / NOT IN 子查询的三值逻辑 ----------
  ok('IN 子查询命中', await q('SELECT COUNT(*) AS c FROM t WHERE v IN (SELECT v FROM s)') === 1, null);
  // 关键：子查询含 NULL 时，NOT IN 对任何行都不成立（结果集为空）
  ok('NOT IN 含 NULL → 0 行（三值逻辑）',
    await q('SELECT COUNT(*) AS c FROM t WHERE v NOT IN (SELECT v FROM s)') === 0, null);
  ok('IN 空子查询 → 0 行',
    await q('SELECT COUNT(*) AS c FROM t WHERE v IN (SELECT v FROM empty)') === 0, null);
  ok('NOT IN 空子查询 → 全部行',
    await q('SELECT COUNT(*) AS c FROM t WHERE v NOT IN (SELECT v FROM empty)') === 3, null);

  // ---------- EXISTS / NOT EXISTS ----------
  ok('EXISTS 相关子查询',
    await q('SELECT COUNT(*) AS c FROM t WHERE EXISTS (SELECT 1 FROM s WHERE s.v = t.v)') === 1, null);
  ok('NOT EXISTS 相关子查询',
    await q('SELECT COUNT(*) AS c FROM t WHERE NOT EXISTS (SELECT 1 FROM s WHERE s.v = t.v)') === 2, null);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => {
  console.log('[FAIL] unexpected exception: ' + e.stack.split('\n').slice(0, 3).join('\n'));
  process.exit(1);
});
