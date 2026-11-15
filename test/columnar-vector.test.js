/* ---- 列存向量化路径：与行存结果必须逐字节一致 ---- */
/*
 * 覆盖 _columnarAggregate / _columnarGroupBy 两条快路径：
 *   - 无 WHERE / 有 WHERE（单条件、AND）
 *   - COUNT(*) / COUNT(col) / SUM / AVG / MIN / MAX
 *   - 单列 GROUP BY
 * 以及必须「退回通用路径」的情形：LIMIT、DISTINCT、ORDER BY、JOIN、
 * 非简单列引用、OR 条件。
 *
 * 判定标准：转换前后的结果（排序后）完全一致 —— 快路径只允许更快，
 * 不允许改变结果。
 */
const path = require('path');
const ROOT = path.join(__dirname, '..');
const { Database } = require(path.join(ROOT, 'index.js'));

let pass = 0, fail = 0;
function ok(name, cond, got) {
  if (cond) { pass++; console.log('[OK]   ' + name); }
  else { fail++; console.log('[FAIL] ' + name + ' -> ' + JSON.stringify(got)); }
}
const norm = (rows) => JSON.stringify(
  rows.map(r => r.map(v => (typeof v === 'number' ? Number(v.toFixed(6)) : v)))
      .sort((a, b) => JSON.stringify(a) < JSON.stringify(b) ? -1 : 1)
);

(async () => {
  const db = new Database(':memory:', { autoSave: false });
  await db.createTable('t', {
    id: { type: 'integer', primaryKey: true, autoIncrement: true },
    age: { type: 'integer' },
    score: { type: 'float' },
    name: { type: 'string' },
  });
  const rows = [];
  for (let i = 0; i < 5000; i++) {
    // 每 13 行留一个 NULL name：IS NULL / GROUP BY 遇到 NULL 分组键都要与行存一致
    rows.push({ age: 20 + (i % 50), score: (i % 1000) / 10, name: i % 13 === 0 ? null : 'n' + (i % 7) });
  }
  for (let i = 0; i < rows.length; i += 500) await db.insert('t', rows.slice(i, i + 500));

  const QUERIES = [
    // 无 WHERE
    'SELECT COUNT(*) AS c FROM t',
    'SELECT COUNT(score) AS c FROM t',
    'SELECT SUM(score) AS s FROM t',
    'SELECT AVG(score) AS a FROM t',
    'SELECT MIN(age) AS mn, MAX(age) AS mx FROM t',
    'SELECT SUM(age) AS s, COUNT(*) AS c FROM t',
    // 有 WHERE
    'SELECT COUNT(*) AS c FROM t WHERE age > 30',
    'SELECT SUM(score) AS s FROM t WHERE age > 30 AND score < 50',
    'SELECT AVG(age) AS a FROM t WHERE age >= 40',
    'SELECT MIN(score) AS mn FROM t WHERE age < 25',
    // GROUP BY
    'SELECT age, COUNT(*) AS c FROM t GROUP BY age',
    'SELECT age, SUM(score) AS s FROM t GROUP BY age',
    'SELECT age, AVG(score) AS a, MIN(score) AS mn, MAX(score) AS mx FROM t GROUP BY age',
    'SELECT name, COUNT(*) AS c FROM t GROUP BY name',
    'SELECT age, COUNT(*) AS c FROM t WHERE score > 50 GROUP BY age',
    // 多列 GROUP BY（含列顺序互换）
    'SELECT age, name, COUNT(*) AS c FROM t GROUP BY age, name',
    'SELECT name, age, SUM(score) AS s FROM t GROUP BY name, age',
    // OR 条件（AND/OR 混合）
    'SELECT COUNT(*) AS c FROM t WHERE age > 30 OR score > 90',
    'SELECT SUM(score) AS s FROM t WHERE age > 30 OR (score > 90 AND age > 20)',
    'SELECT age, COUNT(*) AS c FROM t WHERE age > 30 OR score > 90 GROUP BY age',
    // WHERE IN / NOT IN / BETWEEN / IS NULL
    'SELECT COUNT(*) AS c FROM t WHERE age IN (30, 40)',
    'SELECT COUNT(*) AS c FROM t WHERE age NOT IN (30, 40)',
    'SELECT SUM(score) AS s FROM t WHERE age BETWEEN 20 AND 30',
    'SELECT COUNT(*) AS c FROM t WHERE age NOT BETWEEN 20 AND 30',
    'SELECT COUNT(*) AS c FROM t WHERE name IS NULL',
    'SELECT COUNT(*) AS c FROM t WHERE name IS NOT NULL',
    // GROUP BY + ORDER BY / LIMIT / OFFSET
    'SELECT age, COUNT(*) AS c FROM t GROUP BY age ORDER BY age DESC',
    'SELECT age, COUNT(*) AS c FROM t GROUP BY age ORDER BY c DESC LIMIT 3',
    'SELECT age, COUNT(*) AS c FROM t GROUP BY age ORDER BY age LIMIT 4 OFFSET 2',
    // 应退回通用路径（结果仍必须一致）
    'SELECT COUNT(*) AS c FROM t LIMIT 0',
    'SELECT COUNT(DISTINCT age) AS c FROM t',
    'SELECT SUM(age + 1) AS s FROM t',
    'SELECT age, COUNT(*) AS c FROM t GROUP BY age ORDER BY age, c DESC',
  ];

  // ORDER BY + LIMIT：不仅结果集相同，**顺序**也必须一致（含同值行的相对
  // 顺序）。所以这一组基线用保序的 JSON.stringify，不走 norm 的排序。
  const ORDER_QUERIES = [
    'SELECT id FROM t ORDER BY age LIMIT 10',
    'SELECT id FROM t ORDER BY age DESC LIMIT 10',
    'SELECT id, age FROM t ORDER BY age LIMIT 10 OFFSET 5',
    'SELECT name FROM t ORDER BY name LIMIT 5',
    'SELECT * FROM t ORDER BY score DESC LIMIT 3',
    'SELECT id FROM t ORDER BY age LIMIT 10 OFFSET 4995',
  ];

  const before = {};
  for (const q of QUERIES) {
    try { before[q] = norm((await db.query(q)).rows); }
    catch (e) { before[q] = 'ERR ' + e.message; }
  }
  const beforeOrder = {};
  for (const q of ORDER_QUERIES) beforeOrder[q] = JSON.stringify((await db.query(q)).rows);

  db.convertToColumnar('t');

  for (const q of ORDER_QUERIES) {
    const got = JSON.stringify((await db.query(q)).rows);
    ok('顺序一致：' + q.slice(0, 56), got === beforeOrder[q],
      { got: got.slice(0, 48), exp: String(beforeOrder[q]).slice(0, 48) });
  }

  for (const q of QUERIES) {
    let got;
    try { got = norm((await db.query(q)).rows); }
    catch (e) { got = 'ERR ' + e.message; }
    ok('结果一致：' + q.slice(0, 62), got === before[q], { got: got.slice(0, 48), exp: String(before[q]).slice(0, 48) });
  }

  // 列名/别名也要一致
  const a1 = await db.query('SELECT SUM(score) AS total FROM t');
  ok('聚合别名保留', a1.columns[0] === 'total', a1.columns);
  const a2 = await db.query('SELECT COUNT(*) FROM t');
  ok('无别名时列名保持 FN() 形式', a2.columns[0] === 'COUNT()', a2.columns);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => {
  console.log('[FAIL] unexpected exception: ' + e.stack.split('\n').slice(0, 3).join('\n'));
  process.exit(1);
});
