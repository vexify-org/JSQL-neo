/*
 * extra-coverage.test.js — JSQL-neo 边界情况全覆盖测试
 *
 * 运行：node test/extra-coverage.test.js
 *
 * 覆盖五大类边界情况：
 *   1. SQL 语义边界（NULL、除零、精度、Unicode、日期、BETWEEN）
 *   2. 聚合函数边界（COUNT/SUM/AVG、GROUP BY、HAVING、嵌套）
 *   3. 子查询和 JOIN（相关子查询、笛卡尔积、EXISTS、嵌套）
 *   4. DDL 和表操作（ALTER、TRUNCATE、RENAME、约束）
 *   5. 表达式和函数（CASE、COALESCE、字符串/数学函数、嵌套）
 */
import path from 'path';
import { fileURLToPath } from 'url';
import assert from 'assert';
import { createRequire } from 'module';

/*
 * 原先这里是 `import { test } from 'vitest'`。但 vitest 既不在 package.json 的
 * 依赖里、也没安装，而这个文件又不在 test:all 里 —— 结果是这 68 个用例
 * **从来没跑过一次**，纯摆设。死测试比没有测试更糟：它给人虚假的信心。
 *
 * 好在断言本来就全用 Node 内置的 assert，需要替换的只有 test 这一层。
 * 下面这个极简 runner 行为对齐 vitest：顺序执行、逐个报结果、
 * 有失败就以非零码退出。
 */
const _tests = [];
const test = (name, fn) => { _tests.push({ name, fn }); };

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(import.meta.url);
const ROOT = path.join(__dirname, '..');
const Database = require(path.join(ROOT, 'lib/database'));
const { executeSQL } = require(path.join(ROOT, 'lib/sql'));

const OPTS = { safety: false };

/** 创建内存数据库并返回查询辅助函数 */
function makeDb() {
  const db = new Database(':memory:', { autoSave: false });
  const q = (sql) => executeSQL(db, sql, OPTS);
  return { db, q };
}

/** 取第一行第一列 */
async function one(q, sql) {
  const r = await q(sql);
  return r.rows[0][0];
}

/** 取所有行 */
async function rows(q, sql) {
  const r = await q(sql);
  return r.rows;
}

// ────────────────────────────────────────────────────────────────
// 1. SQL 语义边界（10+ tests）
// ────────────────────────────────────────────────────────────────

test('NULL = NULL 返回 NULL（UNKNOWN，三值逻辑）', async () => {
  const { q } = makeDb();
  assert.strictEqual(await one(q, 'SELECT NULL = NULL'), null);
});

test('NULL != 1 返回 NULL（UNKNOWN）', async () => {
  const { q } = makeDb();
  assert.strictEqual(await one(q, 'SELECT NULL != 1'), null);
});

test('NULL IN (1,2) 返回 NULL（UNKNOWN）', async () => {
  const { q } = makeDb();
  assert.strictEqual(await one(q, 'SELECT NULL IN (1,2)'), null);
});

test('NULL NOT IN (1,2) 返回 NULL（UNKNOWN）', async () => {
  const { q } = makeDb();
  assert.strictEqual(await one(q, 'SELECT NULL NOT IN (1,2)'), null);
});

test('1 IN (1,NULL) 返回 TRUE（有一个元素匹配就成立）', async () => {
  const { q } = makeDb();
  // 等价于 `1=1 OR 1=NULL` —— TRUE OR UNKNOWN 还是 TRUE。
  // 列表里别的位置有没有 NULL 不影响；只有**没匹配上**时才是 UNKNOWN。
  // （原先这里断言的是 null，即「列表含 NULL 就 UNKNOWN」——那是个常见误解，
  //   MySQL / PostgreSQL 实测都返回 TRUE。）
  assert.strictEqual(await one(q, 'SELECT 1 IN (1,NULL)'), 1);
  assert.strictEqual(await one(q, 'SELECT 1 IN (NULL,1)'), 1);
  assert.strictEqual(await one(q, 'SELECT 99 IN (1,NULL)'), null);
});

test('3 NOT IN (1,2) 返回 1（正常匹配）', async () => {
  const { q } = makeDb();
  assert.strictEqual(await one(q, 'SELECT 3 NOT IN (1,2)'), 1);
});

test('NULL <=> NULL 返回 1（NULL 安全相等）', async () => {
  const { q } = makeDb();
  assert.strictEqual(await one(q, 'SELECT NULL <=> NULL'), 1);
});

test('1 <=> NULL 返回 0（NULL 安全相等，不匹配）', async () => {
  const { q } = makeDb();
  assert.strictEqual(await one(q, 'SELECT 1 <=> NULL'), 0);
});

test("空字符串 '' = '' 返回 1", async () => {
  const { q } = makeDb();
  assert.strictEqual(await one(q, "SELECT '' = ''"), 1);
});

test("空字符串 '' = NULL 返回 NULL（空串不是 NULL）", async () => {
  const { q } = makeDb();
  assert.strictEqual(await one(q, "SELECT '' = NULL"), null);
});

test('1/0 返回 NULL（除零不抛错）', async () => {
  const { q } = makeDb();
  assert.strictEqual(await one(q, 'SELECT 1/0'), null);
});

test('10/3 返回浮点数 3.333...', async () => {
  const { q } = makeDb();
  const v = await one(q, 'SELECT 10/3');
  assert.strictEqual(typeof v, 'number');
  assert.ok(Math.abs(v - 3.3333333333333335) < 1e-15);
});

test('0.1+0.2 暴露 JS 浮点精度问题（0.3000...04）', async () => {
  const { q } = makeDb();
  const v = await one(q, 'SELECT 0.1+0.2');
  assert.strictEqual(v, 0.1 + 0.2);
  assert.notStrictEqual(v, 0.3);
});

test('大整数超出 JS 安全范围会抛错或返回非精确值', async () => {
  const { q } = makeDb();
  let result, error = null;
  try {
    result = await one(q, 'SELECT 9999999999999999');
  } catch (e) {
    error = e;
  }
  // 引擎内部用 BigInt，序列化会抛错；若未抛错则值不应精确
  if (error) return;
  assert.notStrictEqual(result, 9999999999999999);
});

test('-0.0 归一为 0（负零消失）', async () => {
  const { q } = makeDb();
  const v = await one(q, 'SELECT -0.0');
  assert.ok(v === 0);
});

test('超长字符串 100000 字符正常处理', async () => {
  const { q } = makeDb();
  const long = 'x'.repeat(100000);
  assert.strictEqual(await one(q, `SELECT LENGTH('${long}')`), 100000);
});

test('Unicode é 正确处理（LENGTH=5, UPPER 含重音）', async () => {
  const { q } = makeDb();
  assert.strictEqual(await one(q, "SELECT LENGTH('héllo')"), 5);
  assert.strictEqual(await one(q, "SELECT UPPER('café')"), 'CAFÉ');
});

test('Emoji 按 UTF-16 单元计数（LENGTH=4）', async () => {
  const { q } = makeDb();
  assert.strictEqual(await one(q, "SELECT LENGTH('🚀🌟')"), 4);
});

test('Emoji UPPER 无变化', async () => {
  const { q } = makeDb();
  assert.strictEqual(await one(q, "SELECT UPPER('🚀')"), '🚀');
});

test("DATE('0000-00-00') 返回 NULL（无效日期）", async () => {
  const { q } = makeDb();
  assert.strictEqual(await one(q, "SELECT DATE('0000-00-00')"), null);
});

test("DATE('9999-12-31') 返回 '9999-12-31'", async () => {
  const { q } = makeDb();
  assert.strictEqual(await one(q, "SELECT DATE('9999-12-31')"), '9999-12-31');
});

test("DATE('2024-02-29') 闰年正确", async () => {
  const { q } = makeDb();
  assert.strictEqual(await one(q, "SELECT DATE('2024-02-29')"), '2024-02-29');
});

test("DATE('2026-02-29') 非法日期溢出修正为 '2026-03-01'", async () => {
  const { q } = makeDb();
  assert.strictEqual(await one(q, "SELECT DATE('2026-02-29')"), '2026-03-01');
});

test("YEAR('9999-12-31') 返回 9999", async () => {
  const { q } = makeDb();
  assert.strictEqual(await one(q, "SELECT YEAR('9999-12-31')"), 9999);
});

test('BETWEEN 包含边界（5 BETWEEN 1 AND 5 → 1）', async () => {
  const { q } = makeDb();
  assert.strictEqual(await one(q, 'SELECT 5 BETWEEN 1 AND 5'), 1);
});

test('BETWEEN NULL 返回 NULL（UNKNOWN）', async () => {
  const { q } = makeDb();
  assert.strictEqual(await one(q, 'SELECT NULL BETWEEN 1 AND 5'), null);
});

test('NOT BETWEEN NULL 返回 NULL（UNKNOWN）', async () => {
  const { q } = makeDb();
  assert.strictEqual(await one(q, 'SELECT NULL NOT BETWEEN 1 AND 5'), null);
});

// ────────────────────────────────────────────────────────────────
// 2. 聚合函数边界（8+ tests）
// ────────────────────────────────────────────────────────────────

test('COUNT(*) 计所有行（含 NULL）', async () => {
  const { q } = makeDb();
  await q('CREATE TABLE t (id INT PRIMARY KEY, v INT)');
  await q('INSERT INTO t VALUES (1,10),(2,NULL),(3,30)');
  assert.strictEqual(await one(q, 'SELECT COUNT(*) FROM t'), 3);
});

test('COUNT(col) 跳过 NULL', async () => {
  const { q } = makeDb();
  await q('CREATE TABLE t (id INT PRIMARY KEY, v INT)');
  await q('INSERT INTO t VALUES (1,10),(2,NULL),(3,30)');
  assert.strictEqual(await one(q, 'SELECT COUNT(v) FROM t'), 2);
});

test('COUNT(DISTINCT col) 去重且跳过 NULL', async () => {
  const { q } = makeDb();
  await q('CREATE TABLE t (id INT PRIMARY KEY, s STRING)');
  await q("INSERT INTO t VALUES (1,'a'),(2,'a'),(3,NULL),(4,'b')");
  assert.strictEqual(await one(q, 'SELECT COUNT(DISTINCT s) FROM t'), 2);
});

test('SUM 跳过 NULL（不全为 NULL 时）', async () => {
  const { q } = makeDb();
  await q('CREATE TABLE t (id INT PRIMARY KEY, v INT)');
  await q('INSERT INTO t VALUES (1,10),(2,NULL),(3,30)');
  assert.strictEqual(await one(q, 'SELECT SUM(v) FROM t'), 40);
});

test('SUM 全 NULL 返回 NULL', async () => {
  const { q } = makeDb();
  await q('CREATE TABLE t (id INT PRIMARY KEY, v INT)');
  await q('INSERT INTO t VALUES (1,NULL),(2,NULL)');
  assert.strictEqual(await one(q, 'SELECT SUM(v) FROM t'), null);
});

test('AVG 跳过 NULL（分母不含 NULL）', async () => {
  const { q } = makeDb();
  await q('CREATE TABLE t (id INT PRIMARY KEY, v INT)');
  await q('INSERT INTO t VALUES (1,10),(2,NULL),(3,30)');
  assert.strictEqual(await one(q, 'SELECT AVG(v) FROM t'), 20);
});

test('GROUP BY 多列正确分组', async () => {
  const { q } = makeDb();
  await q('CREATE TABLE t (id INT PRIMARY KEY, g INT, s STRING)');
  await q("INSERT INTO t VALUES (1,1,'a'),(2,1,'a'),(3,2,'a'),(4,2,'b')");
  const r = await rows(q, 'SELECT g, s, COUNT(*) AS cnt FROM t GROUP BY g, s ORDER BY g, s');
  assert.strictEqual(r.length, 3);
  assert.deepStrictEqual(r[0], [1, 'a', 2]);
  assert.deepStrictEqual(r[1], [2, 'a', 1]);
  assert.deepStrictEqual(r[2], [2, 'b', 1]);
});

test('HAVING 无 GROUP BY 时对整表聚合结果过滤', async () => {
  const { q } = makeDb();
  await q('CREATE TABLE t (id INT PRIMARY KEY, v INT)');
  await q('INSERT INTO t VALUES (1,10),(2,20),(3,30)');
  assert.strictEqual(await one(q, 'SELECT COUNT(*) FROM t HAVING COUNT(*) > 1'), 3);
});

test('聚合嵌套：SELECT COUNT(*) FROM (SELECT ...) t', async () => {
  const { q } = makeDb();
  await q('CREATE TABLE t (id INT PRIMARY KEY, g INT)');
  await q('INSERT INTO t VALUES (1,1),(2,1),(3,2),(4,2),(5,NULL)');
  assert.strictEqual(
    await one(q, 'SELECT COUNT(*) FROM (SELECT DISTINCT g FROM t) x'),
    3
  );
});

test('混合聚合和非聚合列（GROUP BY 覆盖非聚合列）', async () => {
  const { q } = makeDb();
  await q('CREATE TABLE t (id INT PRIMARY KEY, g INT, v INT)');
  await q('INSERT INTO t VALUES (1,1,10),(2,1,20),(3,2,30)');
  const r = await rows(q, 'SELECT g, v, COUNT(*) AS cnt FROM t GROUP BY g, v ORDER BY g, v');
  assert.strictEqual(r.length, 3);
  assert.deepStrictEqual(r[0], [1, 10, 1]);
});

// ────────────────────────────────────────────────────────────────
// 3. 子查询和 JOIN（8+ tests）
// ────────────────────────────────────────────────────────────────

test('相关子查询：每行独立求值', async () => {
  const { q } = makeDb();
  await q('CREATE TABLE t (id INT PRIMARY KEY, g INT, v INT)');
  await q('INSERT INTO t VALUES (1,1,100),(2,1,5),(3,2,50),(4,2,200)');
  // g=1 的 AVG=52.5，g=2 的 AVG=125
  // g=1: 100>52.5 ✓, 5>52.5 ✗; g=2: 50>125 ✗, 200>125 ✓ → 共 2 行
  const r = await rows(q, 'SELECT COUNT(*) FROM t a WHERE v > (SELECT AVG(v) FROM t b WHERE b.g = a.g)');
  assert.strictEqual(r[0][0], 2);
});

test('子查询返回多列', async () => {
  const { q } = makeDb();
  await q('CREATE TABLE t (id INT PRIMARY KEY, g INT, v INT)');
  await q('INSERT INTO t VALUES (1,1,10),(2,2,20),(3,3,30)');
  const r = await rows(q, 'SELECT * FROM (SELECT g, v FROM t WHERE v >= 20) x ORDER BY g');
  assert.strictEqual(r.length, 2);
  assert.deepStrictEqual(r[0], [2, 20]);
});

test('JOIN 无 ON 条件产生笛卡尔积', async () => {
  const { q } = makeDb();
  await q('CREATE TABLE a (id INT PRIMARY KEY)');
  await q('CREATE TABLE b (id INT PRIMARY KEY)');
  await q('INSERT INTO a VALUES (1),(2)');
  await q('INSERT INTO b VALUES (1),(2),(3)');
  assert.strictEqual(await one(q, 'SELECT COUNT(*) FROM a JOIN b'), 6);
});

test('逗号连接产生笛卡尔积', async () => {
  const { q } = makeDb();
  await q('CREATE TABLE a (id INT PRIMARY KEY)');
  await q('CREATE TABLE b (id INT PRIMARY KEY)');
  await q('INSERT INTO a VALUES (1),(2)');
  await q('INSERT INTO b VALUES (1),(2),(3)');
  assert.strictEqual(await one(q, 'SELECT COUNT(*) FROM a, b'), 6);
});

test('LEFT JOIN 右表无匹配时填 NULL', async () => {
  const { q } = makeDb();
  await q('CREATE TABLE a (id INT PRIMARY KEY, name STRING)');
  await q('CREATE TABLE b (id INT PRIMARY KEY, a_id INT, val STRING)');
  await q("INSERT INTO a VALUES (1,'x'),(2,'y'),(3,'z')");
  await q("INSERT INTO b VALUES (10,2,'matched')");
  const r = await rows(q, 'SELECT a.id, a.name, b.val FROM a LEFT JOIN b ON a.id = b.a_id ORDER BY a.id');
  assert.strictEqual(r.length, 3);
  assert.deepStrictEqual(r[0], [1, 'x', null]);
  assert.deepStrictEqual(r[2], [3, 'z', null]);
});

test('子查询在 SELECT 列表（标量子查询）', async () => {
  const { q } = makeDb();
  await q('CREATE TABLE t (id INT PRIMARY KEY, v INT)');
  await q('INSERT INTO t VALUES (1,10),(2,20),(3,30)');
  assert.strictEqual(await one(q, 'SELECT MAX(v) FROM t'), 30);
  const r = await one(q, 'SELECT (SELECT MAX(v) FROM t) FROM t LIMIT 1');
  assert.strictEqual(r, 30);
});

test('嵌套子查询 3 层', async () => {
  const { q } = makeDb();
  await q('CREATE TABLE t (id INT PRIMARY KEY, g INT)');
  await q('INSERT INTO t VALUES (1,1),(2,1),(3,2),(4,3)');
  assert.strictEqual(
    await one(q, 'SELECT COUNT(*) FROM (SELECT g FROM (SELECT DISTINCT g FROM t) a) b'),
    3
  );
});

test('IN 子查询', async () => {
  const { q } = makeDb();
  await q('CREATE TABLE t (id INT PRIMARY KEY, g INT, v INT)');
  await q('INSERT INTO t VALUES (1,1,10),(2,1,20),(3,2,30)');
  assert.strictEqual(
    await one(q, 'SELECT COUNT(*) FROM t WHERE g IN (SELECT DISTINCT g FROM t WHERE g IS NOT NULL)'),
    3
  );
});

test('IN 子查询含 NULL：匹配上的行仍应返回', async () => {
  const { q } = makeDb();
  await q('CREATE TABLE t (id INT PRIMARY KEY, g INT)');
  await q('INSERT INTO t VALUES (1,1),(2,NULL)');
  // 子查询结果是 {1, NULL}。g=1 那行匹配得上（1 IN (1,NULL) 为 TRUE），
  // 只有 g=NULL 那行是 UNKNOWN 被过滤 —— 所以是 1 行，不是 0 行。
  // （原先断言 0 行，把 bug 当成了预期。）
  assert.strictEqual(
    await one(q, 'SELECT COUNT(*) FROM t WHERE g IN (SELECT g FROM t)'),
    1
  );
  // 反过来：NOT IN 的列表含 NULL 时恒为 UNKNOWN，一行都不返回
  assert.strictEqual(
    await one(q, 'SELECT COUNT(*) FROM t WHERE g NOT IN (SELECT g FROM t)'),
    0
  );
});

test('EXISTS 子查询', async () => {
  const { q } = makeDb();
  await q('CREATE TABLE t (id INT PRIMARY KEY, g INT)');
  await q('INSERT INTO t VALUES (1,1),(2,2),(3,1)');
  assert.strictEqual(
    await one(q, 'SELECT COUNT(*) FROM t WHERE EXISTS (SELECT 1 FROM t WHERE t.g = g)'),
    3
  );
});

test('NOT EXISTS 子查询', async () => {
  const { q } = makeDb();
  await q('CREATE TABLE t (id INT PRIMARY KEY, g INT)');
  await q('INSERT INTO t VALUES (1,1),(2,2),(3,1)');
  // g=2 没有其他行同组，NOT EXISTS 为真
  assert.strictEqual(
    await one(q, 'SELECT COUNT(*) FROM t a WHERE NOT EXISTS (SELECT 1 FROM t b WHERE b.g = a.g AND b.id != a.id)'),
    1
  );
});

// ────────────────────────────────────────────────────────────────
// 4. DDL 和表操作（6+ tests）
// ────────────────────────────────────────────────────────────────

test('CREATE TABLE 带 DEFAULT 值对新行生效', async () => {
  const { q } = makeDb();
  await q("CREATE TABLE t (id INT PRIMARY KEY, n STRING, extra STRING DEFAULT 'x')");
  await q("INSERT INTO t (id, n) VALUES (1,'a')");
  const r = await rows(q, 'SELECT extra FROM t');
  assert.strictEqual(r[0][0], 'x');
});

test('ALTER TABLE ADD COLUMN 带 DEFAULT 子句（DEFAULT 对新行不生效，已知限制）', async () => {
  const { q } = makeDb();
  await q('CREATE TABLE t (id INT PRIMARY KEY, n STRING)');
  await q("INSERT INTO t VALUES (1,'a')");
  await q("ALTER TABLE t ADD COLUMN extra STRING DEFAULT 'x'");
  await q("INSERT INTO t (id, n) VALUES (2,'b')");
  const r = await rows(q, 'SELECT id, n, extra FROM t ORDER BY id');
  // 已知限制：ALTER TABLE ADD COLUMN 的 DEFAULT 不应用到新行
  assert.ok(r[1][2] == null); // null 或 undefined（序列化差异）
});

test('ALTER TABLE DROP COLUMN', async () => {
  const { q } = makeDb();
  await q('CREATE TABLE t (id INT PRIMARY KEY, a STRING, b STRING)');
  await q("INSERT INTO t VALUES (1,'x','y')");
  await q('ALTER TABLE t DROP COLUMN b');
  const r = await rows(q, 'SELECT * FROM t');
  assert.deepStrictEqual(r[0], [1, 'x']);
});

test('CREATE TABLE 带各种约束（PK、UNIQUE、NOT NULL、DEFAULT）', async () => {
  const { q } = makeDb();
  await q("CREATE TABLE cons (id INT PRIMARY KEY, u STRING UNIQUE, nn INT NOT NULL, d INT DEFAULT 99)");
  // 合法插入
  await q("INSERT INTO cons (id, u, nn) VALUES (1, 'a', 1)");
  // DEFAULT 生效
  const r = await rows(q, 'SELECT d FROM cons WHERE id=1');
  assert.strictEqual(r[0][0], 99);
  // 违反 PK
  await assert.rejects(() => q("INSERT INTO cons (id, u, nn) VALUES (1, 'c', 3)"));
  // 违反 UNIQUE
  await assert.rejects(() => q("INSERT INTO cons (id, u, nn) VALUES (2, 'a', 4)"));
  // 违反 NOT NULL
  await assert.rejects(() => q("INSERT INTO cons (id, u, nn) VALUES (3, 'b', NULL)"));
});

test('TRUNCATE 后自增重置', async () => {
  const { q } = makeDb();
  await q('CREATE TABLE t (id INT PRIMARY KEY AUTO_INCREMENT, n STRING)');
  await q("INSERT INTO t (n) VALUES ('a'),('b'),('c')");
  await q('TRUNCATE TABLE t');
  assert.strictEqual(await one(q, 'SELECT COUNT(*) FROM t'), 0);
  await q("INSERT INTO t (n) VALUES ('z')");
  const r = await rows(q, 'SELECT id FROM t');
  assert.strictEqual(r[0][0], 1); // 自增重置
});

test('RENAME TABLE 后旧名不可用', async () => {
  const { q } = makeDb();
  await q('CREATE TABLE old (id INT PRIMARY KEY)');
  await q('ALTER TABLE old RENAME TO new');
  await q('INSERT INTO new VALUES (1)');
  assert.strictEqual(await one(q, 'SELECT COUNT(*) FROM new'), 1);
  await assert.rejects(() => q('SELECT COUNT(*) FROM old'));
});

test('创建重复表名报错', async () => {
  const { q } = makeDb();
  await q('CREATE TABLE dup (id INT PRIMARY KEY)');
  await assert.rejects(() => q('CREATE TABLE dup (id INT PRIMARY KEY)'));
});

// ────────────────────────────────────────────────────────────────
// 5. 表达式和函数（6+ tests）
// ────────────────────────────────────────────────────────────────

test('CASE WHEN 搜索形式', async () => {
  const { q } = makeDb();
  assert.strictEqual(
    await one(q, "SELECT CASE WHEN 1=1 THEN 'yes' ELSE 'no' END"),
    'yes'
  );
});

test('CASE 简单形式', async () => {
  const { q } = makeDb();
  assert.strictEqual(
    await one(q, "SELECT CASE 2 WHEN 1 THEN 'a' WHEN 2 THEN 'b' ELSE 'c' END"),
    'b'
  );
});

test('CASE 无匹配且无 ELSE 返回 NULL', async () => {
  const { q } = makeDb();
  assert.strictEqual(
    await one(q, "SELECT CASE WHEN 0=1 THEN 'yes' END"),
    null
  );
});

test('CASE 条件为 NULL 时走 ELSE', async () => {
  const { q } = makeDb();
  assert.strictEqual(
    await one(q, "SELECT CASE NULL WHEN 1 THEN 'a' ELSE 'b' END"),
    'b'
  );
});

test('COALESCE / NULLIF / IFNULL', async () => {
  const { q } = makeDb();
  assert.strictEqual(await one(q, 'SELECT COALESCE(NULL, NULL, 3)'), 3);
  assert.strictEqual(await one(q, 'SELECT NULLIF(1, 1)'), null);
  assert.strictEqual(await one(q, 'SELECT NULLIF(1, 2)'), 1);
  assert.strictEqual(await one(q, 'SELECT IFNULL(NULL, 9)'), 9);
});

test('字符串函数：LENGTH / UPPER / LOWER / TRIM / CONCAT / SUBSTR', async () => {
  const { q } = makeDb();
  assert.strictEqual(await one(q, "SELECT LENGTH('hello')"), 5);
  assert.strictEqual(await one(q, "SELECT UPPER('hi')"), 'HI');
  assert.strictEqual(await one(q, "SELECT LOWER('HI')"), 'hi');
  assert.strictEqual(await one(q, "SELECT TRIM('  x  ')"), 'x');
  assert.strictEqual(await one(q, "SELECT CONCAT('a', 'b', 'c')"), 'abc');
  assert.strictEqual(await one(q, "SELECT SUBSTR('hello', 2, 3)"), 'ell');
});

test('数学函数：ABS / CEIL / FLOOR / ROUND / POWER / SQRT', async () => {
  const { q } = makeDb();
  assert.strictEqual(await one(q, 'SELECT ABS(-5)'), 5);
  assert.strictEqual(await one(q, 'SELECT CEIL(2.1)'), 3);
  assert.strictEqual(await one(q, 'SELECT FLOOR(2.9)'), 2);
  assert.strictEqual(await one(q, 'SELECT ROUND(2.5)'), 3);
  assert.strictEqual(await one(q, 'SELECT ROUND(-2.5)'), -3); // 半远离零
  assert.strictEqual(await one(q, 'SELECT POWER(2, 3)'), 8);
  assert.strictEqual(await one(q, 'SELECT SQRT(16)'), 4);
});

test('SQRT 负数返回 NaN', async () => {
  const { q } = makeDb();
  const v = await one(q, 'SELECT SQRT(-1)');
  assert.ok(Number.isNaN(v));
});

test('REPLACE 函数', async () => {
  const { q } = makeDb();
  assert.strictEqual(await one(q, "SELECT REPLACE('hello', 'l', 'r')"), 'herro');
});

test('嵌套函数调用', async () => {
  const { q } = makeDb();
  assert.strictEqual(await one(q, "SELECT UPPER(TRIM('  hi  '))"), 'HI');
  assert.strictEqual(await one(q, "SELECT LENGTH(CONCAT('a', 'b', 'c'))"), 3);
});

test('ABS 无参数返回 NULL', async () => {
  const { q } = makeDb();
  assert.strictEqual(await one(q, 'SELECT ABS()'), null);
});

test('LENGTH 多参数只取第一个', async () => {
  const { q } = makeDb();
  assert.strictEqual(await one(q, "SELECT LENGTH('ab', 'cd')"), 2);
});

test('IF 函数三值行为（NULL / 0 / 空串均为假）', async () => {
  const { q } = makeDb();
  assert.strictEqual(await one(q, "SELECT IF(NULL, 'a', 'b')"), 'b');
  assert.strictEqual(await one(q, "SELECT IF(0, 'a', 'b')"), 'b');
  assert.strictEqual(await one(q, "SELECT IF('', 'a', 'b')"), 'b');
  assert.strictEqual(await one(q, "SELECT IF(1, 'a', 'b')"), 'a');
});

// ---- runner：顺序执行全部用例，按 vitest 的习惯输出与退出码 ----
;(async () => {
  let pass = 0, fail = 0;
  const failures = [];
  for (const t of _tests) {
    try {
      await t.fn();
      pass++;
      console.log('[OK]  ', t.name);
    } catch (e) {
      fail++;
      failures.push(t.name);
      const msg = e && e.message ? e.message : String(e);
      console.log('[FAIL]', t.name, '->', msg.slice(0, 130));
    }
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  if (failures.length) {
    console.log('\n失败用例：');
    for (const n of failures) console.log('  - ' + n);
  }
  process.exit(fail === 0 ? 0 : 1);
})();
