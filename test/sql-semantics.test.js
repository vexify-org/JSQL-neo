/*
 * SQL 语义修正测试（IN 的三值逻辑 / 窗口默认帧 / JSON 路径操作符 / 补齐的标量函数）。
 *
 * 这一批全是「不报错、结果错」——静默失败最难发现，靠拿标准答案逐条对照才挖出来。
 *
 *   1. IN 列表里含 NULL 时整体失效：`v IN (10, NULL)` 连 v=10 的行都匹配不上。
 *      正确语义是 `v=10 OR v=NULL` —— 有一个元素匹配就是 TRUE，
 *      列表里别的位置有没有 NULL 都不影响；只有**没匹配上**时才变 UNKNOWN。
 *   2. 窗口函数默认帧算错：`SUM(x) OVER (ORDER BY id)` 返回分区总和而不是累计值。
 *      SQL 标准：有 ORDER BY 且未指定帧 → RANGE UNBOUNDED PRECEDING TO CURRENT ROW。
 *   3. `d->>'$.name'`（文档里给的示例）永远返回 null —— 求值层把 '$' 开头的
 *      JSONPath 当成字面键名去取了。纯键名写法 `d->>'name'` 一直是对的。
 *   4. ASCII / CHAR / SPACE / FIELD / ELT / JSON_ARRAY_LENGTH 根本没实现，
 *      调用时静默返回 null。
 */
const path = require('path');

const ROOT = path.join(__dirname, '..');
const { Database } = require(path.join(ROOT, 'index.js'));
const { executeSQL } = require(path.join(ROOT, 'lib/sql.js'));

const OPTS = { safety: false };
let pass = 0, fail = 0;

function ok(name, cond, extra) {
  if (cond) { pass++; console.log('[OK]  ', name); }
  else { fail++; console.log('[FAIL]', name, extra !== undefined ? '-> ' + JSON.stringify(extra).slice(0, 150) : ''); }
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

(async () => {
  const db = new Database(':memory:');
  const q = (sql) => executeSQL(db, sql, OPTS);
  const rows = async (sql) => (await q(sql)).rows;
  const one = async (sql) => (await q(sql)).rows[0][0];

  await q('CREATE TABLE t (id INT PRIMARY KEY, g TEXT, v INT, s TEXT)');
  await q(`INSERT INTO t VALUES
    (1,'a',10,'x'),(2,'a',20,'y'),(3,'b',10,NULL),(4,'b',30,'x'),(5,NULL,20,'y'),(6,NULL,NULL,'z')`);

  console.log('\n--- IN 的三值逻辑 ---');
  ok('v IN (10) 正常匹配', eq(await rows('SELECT COUNT(*) FROM t WHERE v IN (10)'), [[2]]));
  ok('v IN (10, NULL) 仍能匹配 v=10（关键用例）',
    eq(await rows('SELECT COUNT(*) FROM t WHERE v IN (10, NULL)'), [[2]]),
    await rows('SELECT COUNT(*) FROM t WHERE v IN (10, NULL)'));
  ok('NULL 在列表开头也一样', eq(await rows('SELECT COUNT(*) FROM t WHERE v IN (NULL, 10)'), [[2]]));
  ok('多个非 NULL 元素', eq(await rows('SELECT COUNT(*) FROM t WHERE v IN (10,20,30)'), [[5]]));
  ok('v IN (NULL) 恒为空集', eq(await rows('SELECT COUNT(*) FROM t WHERE v IN (NULL)'), [[0]]));
  ok('v NOT IN (10)', eq(await rows('SELECT COUNT(*) FROM t WHERE v NOT IN (10)'), [[3]]));
  ok('v NOT IN (10, NULL) 恒为空集（UNKNOWN 取反仍是 UNKNOWN）',
    eq(await rows('SELECT COUNT(*) FROM t WHERE v NOT IN (10, NULL)'), [[0]]));
  ok('与等价的 OR 写法结果一致',
    eq(await rows('SELECT COUNT(*) FROM t WHERE v = 10 OR v = NULL'),
      await rows('SELECT COUNT(*) FROM t WHERE v IN (10, NULL)')));
  ok('字符串 IN 含 NULL', eq(await rows("SELECT COUNT(*) FROM t WHERE s IN ('x', NULL)"), [[2]]));
  ok('字面量 "null" 不会被 NULL 误匹配',
    eq(await rows("SELECT COUNT(*) FROM t WHERE s IN ('null')"), [[0]]));
  ok('子查询 IN（结果含 NULL）',
    eq(await rows('SELECT COUNT(*) FROM t WHERE v IN (SELECT v FROM t WHERE v = 10 OR v IS NULL)'), [[2]]));
  ok('NOT IN 子查询含 NULL → 空集',
    eq(await rows('SELECT COUNT(*) FROM t WHERE v NOT IN (SELECT v FROM t WHERE v = 10 OR v IS NULL)'), [[0]]));

  console.log('\n--- 窗口函数默认帧 ---');
  await q('CREATE TABLE e (id INT PRIMARY KEY, dept TEXT, sal INT)');
  await q(`INSERT INTO e VALUES (1,'a',100),(2,'a',200),(3,'a',200),(4,'b',50),(5,'b',300)`);
  ok('SUM OVER (ORDER BY) 是累计值（关键用例）',
    eq(await rows('SELECT id, SUM(sal) OVER (PARTITION BY dept ORDER BY id) s FROM e ORDER BY id'),
      [[1,100],[2,300],[3,500],[4,50],[5,350]]),
    await rows('SELECT id, SUM(sal) OVER (PARTITION BY dept ORDER BY id) s FROM e ORDER BY id'));
  ok('无 ORDER BY 时是整分区总和',
    eq(await rows('SELECT id, SUM(sal) OVER (PARTITION BY dept) s FROM e ORDER BY id'),
      [[1,500],[2,500],[3,500],[4,350],[5,350]]));
  ok('无分区无排序 = 全表总和',
    eq(await rows('SELECT id, SUM(sal) OVER () s FROM e ORDER BY id'),
      [[1,850],[2,850],[3,850],[4,850],[5,850]]));
  ok('COUNT OVER (ORDER BY) 累计',
    eq(await rows('SELECT id, COUNT(*) OVER (ORDER BY id) c FROM e ORDER BY id'),
      [[1,1],[2,2],[3,3],[4,4],[5,5]]));
  ok('AVG OVER (ORDER BY) 累计',
    eq(await rows("SELECT id, AVG(sal) OVER (PARTITION BY dept ORDER BY id) a FROM e WHERE dept='a' ORDER BY id"),
      [[1,100],[2,150],[3,166.66666666666666]]));
  ok('默认帧按 RANGE 语义：同值 peer 一并纳入',
    eq(await rows("SELECT id, SUM(sal) OVER (PARTITION BY dept ORDER BY sal) s FROM e WHERE dept='a' ORDER BY id"),
      [[1,100],[2,500],[3,500]]));
  ok('显式 ROWS 帧不受 peer 影响',
    eq(await rows("SELECT id, SUM(sal) OVER (PARTITION BY dept ORDER BY sal ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) s FROM e WHERE dept='a' ORDER BY id"),
      [[1,100],[2,300],[3,500]]));
  ok('ROW_NUMBER 不受默认帧影响',
    eq(await rows('SELECT id, ROW_NUMBER() OVER (PARTITION BY dept ORDER BY sal DESC, id) r FROM e ORDER BY id'),
      [[1,3],[2,1],[3,2],[4,2],[5,1]]));

  console.log('\n--- JSON 路径操作符 ---');
  await q('CREATE TABLE j (id INT PRIMARY KEY, d TEXT)');
  await q(`INSERT INTO j VALUES (1,'{"name":"ann","n":5,"addr":{"city":"SH"},"arr":[10,20]}')`);
  ok("d->>'$.name'（文档里的写法）", await one("SELECT d->>'$.name' FROM j") === 'ann');
  ok("d->'$.name'", await one("SELECT d->'$.name' FROM j") === 'ann');
  ok("d->>'$.n' 数字转文本", await one("SELECT d->>'$.n' FROM j") === '5');
  ok("d->'$.n' 保留数字类型", await one("SELECT d->'$.n' FROM j") === 5);
  ok("d->>'$.addr.city' 嵌套", await one("SELECT d->>'$.addr.city' FROM j") === 'SH');
  ok("d->'$.addr' 返回对象", eq(await one("SELECT d->'$.addr' FROM j"), { city: 'SH' }));
  ok("d->>'$.arr[1]' 数组下标", await one("SELECT d->>'$.arr[1]' FROM j") === '20');
  ok("d->>'$.nope' 不存在 → null", await one("SELECT d->>'$.nope' FROM j") === null);
  ok("纯键名写法不受影响 d->>'name'", await one("SELECT d->>'name' FROM j") === 'ann');
  ok("链式 d->'addr'->>'city'", await one("SELECT d->'addr'->>'city' FROM j") === 'SH');
  ok('JSON_EXTRACT 未受影响',
    await one("SELECT JSON_EXTRACT(d,'$.addr.city') FROM j") === 'SH');
  ok("JSON_EXTRACT '$' 取根", eq(await one("SELECT JSON_EXTRACT('{\"a\":1}','$')"), { a: 1 }));

  console.log('\n--- 补齐的标量函数 ---');
  ok("ASCII('A')", await one("SELECT ASCII('A')") === 65);
  ok("ASCII('abc')", await one("SELECT ASCII('abc')") === 97);
  ok("ASCII('') 为 0", await one("SELECT ASCII('')") === 0);
  ok('ASCII(NULL) 为 NULL', await one('SELECT ASCII(NULL)') === null);
  ok('CHAR(65)', await one('SELECT CHAR(65)') === 'A');
  ok('CHAR 多参数', await one('SELECT CHAR(72,105)') === 'Hi');
  ok('SPACE(3)', await one('SELECT LENGTH(SPACE(3))') === 3);
  ok('SPACE(0)', await one('SELECT LENGTH(SPACE(0))') === 0);
  ok("FIELD 命中", await one("SELECT FIELD('b','a','b','c')") === 2);
  ok('FIELD 未命中为 0', await one("SELECT FIELD('z','a','b')") === 0);
  ok('FIELD(NULL) 为 NULL', await one("SELECT FIELD(NULL,'a')") === null);
  ok('ELT 命中', await one("SELECT ELT(2,'a','b','c')") === 'b');
  ok('ELT 越界为 NULL', await one("SELECT ELT(9,'a','b')") === null);
  ok('ELT(0) 为 NULL', await one("SELECT ELT(0,'a','b')") === null);
  ok('JSON_ARRAY_LENGTH', await one("SELECT JSON_ARRAY_LENGTH('[1,2,3]')") === 3);
  ok('JSON_ARRAY_LENGTH 非数组 → NULL',
    await one("SELECT JSON_ARRAY_LENGTH('{\"a\":1}')") === null);
  ok('JSON_ARRAY_LENGTH 空数组', await one("SELECT JSON_ARRAY_LENGTH('[]')") === 0);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('💥', e); process.exit(1); });
