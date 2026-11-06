/*
 * Regression tests for issue #39.
 *   node test/issue-39.test.js
 *
 * #39 BETWEEN with string literal bounds used to fall back to lexicographic
 *     comparison for numeric columns, so `age BETWEEN '9' AND '100'` returned
 *     no rows (silently). The between branch now reuses the same
 *     "number vs numeric-string" detection as the compare branch:
 *
 *       numeric  when the column value is numeric (and both bounds parse as numbers)
 *                or the column value is a numeric string and either bound is a number
 *       string   otherwise (pure string columns keep lexicographic order, e.g. dates)
 */
const path = require('path');
const ROOT = path.join(__dirname, '..');
const Database = require(path.join(ROOT, 'lib', 'database'));
const { executeSQL } = require(path.join(ROOT, 'lib', 'sql'));

let passed = 0, failed = 0;
function ok(name, cond, extra) {
  if (cond) { passed++; console.log('[OK]', name); }
  else { failed++; console.log('[FAIL]', name, extra !== undefined ? JSON.stringify(extra) : ''); }
}

async function query(db, sql, params) {
  const r = await db.query(sql, params);
  return r.rows.map(row => row[0]);
}

function eq(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

async function testNumericColumn() {
  const db = new Database(':memory:');
  await db.query('CREATE TABLE u (id INTEGER PRIMARY KEY AUTO_INCREMENT, age INTEGER)');
  await db.query('INSERT INTO u (age) VALUES (9),(25),(30),(100)');

  // 正文里的复现用例：字典序旧实现返回 []
  ok('#39 age BETWEEN \'9\' AND \'100\'',
    eq(await query(db, "SELECT age FROM u WHERE age BETWEEN '9' AND '100' ORDER BY age"), [9, 25, 30, 100]),
    await query(db, "SELECT age FROM u WHERE age BETWEEN '9' AND '100' ORDER BY age"));

  // 纯数值边界的既有行为不能变
  ok('#39 age BETWEEN 9 AND 100 (numeric literals)',
    eq(await query(db, 'SELECT age FROM u WHERE age BETWEEN 9 AND 100 ORDER BY age'), [9, 25, 30, 100]));

  // 混合：一边数值字面量、一边数值字符串
  ok('#39 age BETWEEN 9 AND \'100\'',
    eq(await query(db, "SELECT age FROM u WHERE age BETWEEN 9 AND '100' ORDER BY age"), [9, 25, 30, 100]));
  ok('#39 age BETWEEN \'9\' AND 100',
    eq(await query(db, "SELECT age FROM u WHERE age BETWEEN '9' AND 100 ORDER BY age"), [9, 25, 30, 100]));

  // 边界位数不同：字典序下 '9' <= '10'..'99' 会错
  ok('#39 age BETWEEN \'10\' AND \'99\'',
    eq(await query(db, "SELECT age FROM u WHERE age BETWEEN '10' AND '99' ORDER BY age"), [25, 30]));

  // 前后空格 + 前导零
  ok('#39 age BETWEEN \' 9 \' AND \' 100 \' (whitespace)',
    eq(await query(db, "SELECT age FROM u WHERE age BETWEEN ' 9 ' AND ' 100 ' ORDER BY age"), [9, 25, 30, 100]));
  ok('#39 age BETWEEN \'009\' AND \'0100\' (leading zeros)',
    eq(await query(db, "SELECT age FROM u WHERE age BETWEEN '009' AND '0100' ORDER BY age"), [9, 25, 30, 100]));

  // 参数化查询：节点可能是 param，值仍是字符串
  ok('#39 age BETWEEN ? AND ? with string params',
    eq(await query(db, 'SELECT age FROM u WHERE age BETWEEN ? AND ? ORDER BY age', ['9', '100']), [9, 25, 30, 100]));

  // 三值逻辑：NULL 不参与，越界行被 NOT BETWEEN 选中
  await db.query('INSERT INTO u (age) VALUES (NULL),(5)');
  ok('#39 NOT BETWEEN \'9\' AND \'100\' keeps out-of-range only',
    eq(await query(db, "SELECT age FROM u WHERE age NOT BETWEEN '9' AND '100' ORDER BY age"), [5]));
  ok('#39 NULL age never matches BETWEEN',
    eq(await query(db, "SELECT age FROM u WHERE age BETWEEN '0' AND '1000' ORDER BY age"), [5, 9, 25, 30, 100]));

  // 标量上下文（SELECT 列表）里的 BETWEEN 也要走同一套判定
  const rows = await db.query("SELECT age, age BETWEEN '9' AND '100' AS f FROM u WHERE age IS NOT NULL ORDER BY age");
  ok('#39 BETWEEN in select list yields 1/0',
    eq(rows.rows.map(r => r[1]), [0, 1, 1, 1, 1]), rows.rows);
}

async function testDecimalAndNegative() {
  const db = new Database(':memory:');
  await db.query('CREATE TABLE p (id INTEGER PRIMARY KEY AUTO_INCREMENT, price REAL)');
  await db.query('INSERT INTO p (price) VALUES (0.01),(0.5),(9999.99),(10000),(0),(0.005)');

  ok('#39 price BETWEEN \'0.01\' AND \'9999.99\'',
    eq(await query(db, "SELECT price FROM p WHERE price BETWEEN '0.01' AND '9999.99' ORDER BY price"), [0.01, 0.5, 9999.99]),
    await query(db, "SELECT price FROM p WHERE price BETWEEN '0.01' AND '9999.99' ORDER BY price"));
  ok('#39 price BETWEEN \'0\' AND \'10000\' includes both ends',
    eq(await query(db, "SELECT price FROM p WHERE price BETWEEN '0' AND '10000' ORDER BY price"), [0, 0.005, 0.01, 0.5, 9999.99, 10000]));

  await db.query('CREATE TABLE n (id INTEGER PRIMARY KEY AUTO_INCREMENT, v INTEGER)');
  await db.query('INSERT INTO n (v) VALUES (-10),(-5),(0),(5),(10)');
  ok('#39 negative bounds overlap lexicographic trap',
    eq(await query(db, "SELECT v FROM n WHERE v BETWEEN '-10' AND '-5' ORDER BY v"), [-10, -5]));
  ok('#39 negative to positive string bounds',
    eq(await query(db, "SELECT v FROM n WHERE v BETWEEN '-5' AND '5' ORDER BY v"), [-5, 0, 5]));
  ok('#39 scientific notation bounds',
    eq(await query(db, "SELECT v FROM n WHERE v BETWEEN '1e0' AND '1e1' ORDER BY v"), [5, 10]));
}

async function testStringColumnsKeepLexicographic() {
  const db = new Database(':memory:');
  await db.query('CREATE TABLE s (id INTEGER PRIMARY KEY AUTO_INCREMENT, name TEXT, d TEXT)');
  await db.query("INSERT INTO s (name,d) VALUES ('apple','2023-12-31'),('banana','2024-01-02'),('cherry','2024-12-31'),('10a','2025-01-01')");

  // 纯字符串边界：仍是字典序（'10a' < '9' 之类的数值比较不能误伤）
  ok('#39 text BETWEEN \'a\' AND \'b\' stays lexicographic',
    eq(await query(db, "SELECT name FROM s WHERE name BETWEEN 'a' AND 'b' ORDER BY name"), ['apple']),
    await query(db, "SELECT name FROM s WHERE name BETWEEN 'a' AND 'b' ORDER BY name"));
  ok('#39 text BETWEEN \'9\' AND \'100\' stays lexicographic (empty)',
    eq(await query(db, "SELECT name FROM s WHERE name BETWEEN '9' AND '100' ORDER BY name"), []));
  ok('#39 text BETWEEN \'1\' AND \'2\' stays lexicographic',
    eq(await query(db, "SELECT name FROM s WHERE name BETWEEN '1' AND '2' ORDER BY name"), ['10a']));

  // 日期字符串（含 '-' 不能当数字）
  ok('#39 date strings BETWEEN keep lexicographic',
    eq(await query(db, "SELECT d FROM s WHERE d BETWEEN '2024-01-01' AND '2024-12-31' ORDER BY d"), ['2024-01-02', '2024-12-31']));

  // 文本列存数字 + 数值边界：与 compare 的 mixedNum（>= AND <=）保持一致
  await db.query('CREATE TABLE nums (id INTEGER PRIMARY KEY AUTO_INCREMENT, v TEXT)');
  await db.query("INSERT INTO nums (v) VALUES ('9'),('25'),('100'),('1000'),('abc'),('2024-01-02')");
  const viaBetween = await query(db, 'SELECT v FROM nums WHERE v BETWEEN 9 AND 100 ORDER BY v');
  const viaCompare = await query(db, 'SELECT v FROM nums WHERE v >= 9 AND v <= 100 ORDER BY v');
  ok('#39 text-numeric column with numeric bounds matches >= AND <=', eq(viaBetween, viaCompare), { viaBetween, viaCompare });
  ok('#39 text-numeric BETWEEN 9 AND 100 picks numeric values',
    eq(viaBetween.sort(), ['100', '25', '9']), viaBetween);
}

async function testConsistencyWithCompare() {
  // BETWEEN x AND y 必须与 (>= x AND <= y) 等价；这是 #39 的核心不变式
  const db = new Database(':memory:');
  await db.query('CREATE TABLE c (id INTEGER PRIMARY KEY AUTO_INCREMENT, v INTEGER)');
  await db.query('INSERT INTO c (v) VALUES (-100),(-9),(0),(9),(10),(25),(99),(100),(1000),(NULL)');

  const bounds = [['-9', '-100'], ['9', '100'], ['10', '99'], ['0', '9'], ['-100', '1000'], [9, '100'], ['9', 100], [9, 100]];
  for (const [lo, hi] of bounds) {
    const lit = (x) => typeof x === 'number' ? String(x) : `'${x}'`;
    const b = await query(db, `SELECT v FROM c WHERE v BETWEEN ${lit(lo)} AND ${lit(hi)} ORDER BY v`);
    const cmp = await query(db, `SELECT v FROM c WHERE v >= ${lit(lo)} AND v <= ${lit(hi)} ORDER BY v`);
    ok(`#39 BETWEEN ${lit(lo)} AND ${lit(hi)} === range compare`, eq(b, cmp), { b, cmp });
  }
}

async function testDirectExecuteSQL() {
  // 走 executeSQL（wasm_client / 纯引擎路径），确保不是只有 Database 包装层正确
  const db = new Database(':memory:');
  await db.query('CREATE TABLE u (id INTEGER PRIMARY KEY AUTO_INCREMENT, age INTEGER)');
  await db.query('INSERT INTO u (age) VALUES (9),(25),(30),(100)');
  const r = await executeSQL(db, "SELECT age FROM u WHERE age BETWEEN '9' AND '100' ORDER BY age");
  ok('#39 executeSQL path also numeric', eq(r.rows.map(x => x[0]), [9, 25, 30, 100]));
}

(async () => {
  await testNumericColumn();
  await testDecimalAndNegative();
  await testStringColumnsKeepLexicographic();
  await testConsistencyWithCompare();
  await testDirectExecuteSQL();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('[FATAL]', e.stack.split('\n').slice(0, 4).join('\n')); process.exit(1); });
