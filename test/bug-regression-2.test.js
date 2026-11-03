// © Vexify 2026 All Rights Reserved.
/**
 * Bug 回归测试（第二批）—— 2026-11-01 修复的缺陷逐一固化。
 *
 *   N1  安全策略：破坏性 SQL / 堆叠 SQL 必须拦截
 *   C1  B-Tree 小阶数分裂：order=3 根节点出现重复分隔键、丢索引条目
 *   B1  LENGTH() 返回字符数（应为 UTF-8 字节数）
 *   B2  OCTET_LENGTH() 未实现（静默 NULL）
 *   B3  LEFT()/RIGHT() 负长度把负号当成「从尾部算」
 *   B4  LPAD()/RPAD() 越界（负数 slice、填充串超长、空填充串死循环）
 *   B5  POWER(2, NULL) = 1（应为 NULL）
 *   B6  CAST(-5 AS UNSIGNED) = -5（应为 18446744073709551611）
 *   H3  UPDATE SET col = (标量子查询) 一律写 NULL
 *   H4  BETWEEN 数值列 + 字符串边界退化成字典序比较
 *   H5  主键允许 NULL（丢身份，绕过唯一约束）
 *   M1  createError 的 %s 替换污染：参数里自带 %s 会被二次吃掉
 *
 *   node test/bug-regression-2.test.js
 */
const path = require('path');

const ROOT = path.join(__dirname, '..');
const { JSQL } = require(path.join(ROOT, 'index.js'));
const { executeSQL } = require(path.join(ROOT, 'lib/sql.js'));
const { createError } = require(path.join(ROOT, 'lib/errors.js'));
const BTree = require(path.join(ROOT, 'lib/btree.js'));

const OPTS = { safety: false };
let pass = 0, fail = 0;

function ok(name, cond, extra) {
  if (cond) { pass++; console.log('[OK]  ', name); }
  else { fail++; console.log('[FAIL]', name, extra !== undefined ? '-> ' + JSON.stringify(extra).slice(0, 200) : ''); }
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// B-Tree 结构不变量：内部节点 children = keys + 1、键严格递增
function validate(bt) {
  const errs = [];
  (function walk(node) {
    if (node.leaf) {
      if (node.children.length !== 0) errs.push('leaf has children');
    } else if (node.children.length !== node.keys.length + 1) {
      errs.push('internal children !== keys+1');
    }
    for (let i = 1; i < node.keys.length; i++) {
      if (node.keys[i] <= node.keys[i - 1]) errs.push('unsorted/duplicate key');
    }
    for (const c of node.children) walk(c);
  })(bt._root);
  return errs;
}

// 静默吞掉解析层对无 WHERE 的 UPDATE/DELETE 的 console.warn
const realWarn = console.warn;
console.warn = () => {};

(async () => {
  // ══════════════════════════════════════════════════════════
  // N1 — 安全策略
  // ══════════════════════════════════════════════════════════
  console.log('--- N1 安全策略：破坏性 / 堆叠 SQL ---');
  {
    const db = new JSQL(':memory:');
    await db.start();
    const q = (sql, opts) => executeSQL(db, sql, opts);
    await q('CREATE TABLE n1(a INT, b TEXT)', OPTS);
    await q("INSERT INTO n1 VALUES (1,'x'),(2,'y')", OPTS);
    const blocked = async (sql, opts) => {
      try { await q(sql, opts); return null; } catch (e) { return e.message; }
    };
    const m1 = await blocked('DROP TABLE n1');
    ok('DROP TABLE 被拦截', /blocked by security policy/.test(m1 || ''), m1);
    const m2 = await blocked('TRUNCATE TABLE n1');
    ok('TRUNCATE 被拦截', /blocked by security policy/.test(m2 || ''), m2);
    const m3 = await blocked('DELETE FROM n1');
    ok('DELETE 无 WHERE 被拦截', /DELETE without WHERE/.test(m3 || ''), m3);
    const m4 = await blocked('UPDATE n1 SET b=\'z\'');
    ok('UPDATE 无 WHERE 被拦截', /UPDATE without WHERE/.test(m4 || ''), m4);
    const m5 = await blocked('SELECT 1; DROP TABLE n1');
    ok('堆叠 SQL 被拦截', /stacked statements/.test(m5 || ''), m5);
    const m6 = await blocked('SELECT * FROM n1 -- comment');
    ok('注释注入被拦截', /comments are disabled/.test(m6 || ''), m6);
    ok('带 WHERE 的 DELETE 放行', (await blocked('DELETE FROM n1 WHERE a=1')) === null);
    ok('带 WHERE 的 UPDATE 放行', (await blocked("UPDATE n1 SET b='z' WHERE a=2")) === null);
    ok('普通 SELECT 放行', (await blocked('SELECT * FROM n1')) === null);
    ok('allowStacked 显式放行堆叠 SQL', (await blocked('SELECT 1; SELECT 2', { allowStacked: true })) === null);
    ok('allowComments 显式放行注释', (await blocked('SELECT 1 -- ok', { allowComments: true })) === null);
    // 表还在（DROP 没有真的执行）
    ok('被拦截的 DROP 未执行', (await q('SELECT * FROM n1', OPTS)).rows.length === 1);
    await db.stop();
  }

  // ══════════════════════════════════════════════════════════
  // C1 — B-Tree 小阶数分裂
  // ══════════════════════════════════════════════════════════
  console.log('--- C1 B-Tree order=3 分裂 ---');
  {
    const bt = new BTree(3);
    bt.insert(19, 0);
    bt.insert(7, 1);
    bt.insert(12, 2);
    ok('order=3 前三笔插入后无重复分隔键',
      new Set(bt._root.keys).size === bt._root.keys.length, bt._root.keys);
    ok('order=3 结构不变量（children=keys+1 / 严格递增）', validate(bt).length === 0, validate(bt));

    // 根因场景：key=6 的三个 rowIndex 必须全部可检索
    bt.insert(6, 28); bt.insert(6, 44); bt.insert(6, 54);
    bt.insert(25, 3); bt.insert(30, 4); bt.insert(31, 5);
    ok('search(6) 返回 [28,44,54]', eq(bt.search(6), [28, 44, 54]), bt.search(6));
    ok('size = 7（7 个不同的键）', bt.size === 7, bt.size);
    ok('entries 条数 = 7', bt.entries().length === 7, bt.entries().length);
    ok('order=3 分裂后仍无重复键', new Set(bt._root.keys).size === bt._root.keys.length, bt._root.keys);
    ok('order=3 增删混合后不丢条目', (() => {
      bt.remove(6, 44);
      return eq(bt.search(6), [28, 54]) && bt.size === 7;
    })(), bt.search(6));

    // 大规模 order=3：插入 → 校验 → 全删 → 必须彻底清空
    const big = new BTree(3);
    for (let i = 0; i < 200; i++) big.insert(i % 50, i);
    ok('order=3 批量插入后结构合法', validate(big).length === 0, validate(big).slice(0, 2));
    ok('order=3 批量插入 size=50', big.size === 50, big.size);
    let allOk = true;
    for (let k = 0; k < 50; k++) {
      const exp = [];
      for (let i = k; i < 200; i += 50) exp.push(i);
      if (!eq(big.search(k), exp)) { allOk = false; break; }
    }
    ok('order=3 每个键的 rowIndex 完整', allOk);
    for (let i = 0; i < 200; i++) big.remove(i % 50, i);
    ok('order=3 全部删除后 size=0 且 entries 为空',
      big.size === 0 && big.entries().length === 0, { size: big.size, n: big.entries().length });

    // order=4 回归不破坏（生产路径 order=64 的现有用例在 btree.test.js 里）
    const bt4 = new BTree(4);
    for (let i = 0; i < 100; i++) bt4.insert(i, i);
    ok('order=4 仍正常', validate(bt4).length === 0 && bt4.search(88)[0] === 88);
  }

  // ══════════════════════════════════════════════════════════
  // SQL 标量函数 / UPDATE / BETWEEN / PK 约束
  // ══════════════════════════════════════════════════════════
  const db = new JSQL(':memory:');
  await db.start();
  const q = (sql, opts) => executeSQL(db, sql, opts || OPTS);
  const one = async (sql) => (await q(sql)).rows[0][0];
  const fails = async (sql) => { try { await q(sql); return null; } catch (e) { return e.message; } };

  console.log('--- B1/B2 LENGTH / CHAR_LENGTH / OCTET_LENGTH ---');
  ok('LENGTH 是字节数（中文 3 字节 ×2）', (await one("SELECT LENGTH('中文')")) === 6, await one("SELECT LENGTH('中文')"));
  ok('LENGTH 是字节数（é = 2 字节）', (await one("SELECT LENGTH('héllo')")) === 6);
  ok('LENGTH 是字节数（emoji 4 字节 ×2）', (await one("SELECT LENGTH('🚀🌟')")) === 8);
  ok('CHAR_LENGTH 是字符数', (await one("SELECT CHAR_LENGTH('héllo')")) === 5);
  ok('CHARACTER_LENGTH 是字符数', (await one("SELECT CHARACTER_LENGTH('🚀🌟')")) === 4);
  ok('OCTET_LENGTH 已实现（= LENGTH）', (await one("SELECT OCTET_LENGTH('中文')")) === 6);
  ok('LENGTH(NULL) = NULL', (await one('SELECT LENGTH(NULL)')) === null);
  ok('OCTET_LENGTH(NULL) = NULL', (await one('SELECT OCTET_LENGTH(NULL)')) === null);

  console.log('--- B3 LEFT / RIGHT 负长度 ---');
  ok("LEFT('abc',-1) = ''", (await one("SELECT LEFT('abc', -1)")) === '');
  ok("RIGHT('abc',-1) = ''", (await one("SELECT RIGHT('abc', -1)")) === '');
  ok("LEFT('abc',0) = ''", (await one("SELECT LEFT('abc', 0)")) === '');
  ok("RIGHT('abc',0) = ''（slice(-0) 陷阱）", (await one("SELECT RIGHT('abc', 0)")) === '');
  ok("LEFT('abcdef',3) = 'abc'", (await one("SELECT LEFT('abcdef', 3)")) === 'abc');
  ok("RIGHT('abcdef',3) = 'def'", (await one("SELECT RIGHT('abcdef', 3)")) === 'def');
  ok('RIGHT 超出长度返回全串', (await one("SELECT RIGHT('ab', 99)")) === 'ab');

  console.log('--- B4 LPAD / RPAD 越界 ---');
  ok("LPAD('hi',-1,'x') = NULL", (await one("SELECT LPAD('hi', -1, 'x')")) === null);
  ok("RPAD('hi',-1,'x') = NULL", (await one("SELECT RPAD('hi', -1, 'x')")) === null);
  ok("LPAD('hi',5,'ab') = 'abahi'（填充串循环并截断）",
    (await one("SELECT LPAD('hi', 5, 'ab')")) === 'abahi', await one("SELECT LPAD('hi', 5, 'ab')"));
  ok("RPAD('hi',5,'ab') = 'hiaba'",
    (await one("SELECT RPAD('hi', 5, 'ab')")) === 'hiaba', await one("SELECT RPAD('hi', 5, 'ab')"));
  ok("LPAD('hi',4,'') = ''（旧实现死循环）", (await one("SELECT LPAD('hi', 4, '')")) === '');
  ok("RPAD('hi',4,'') = ''（旧实现死循环）", (await one("SELECT RPAD('hi', 4, '')")) === '');
  ok("LPAD('hi',1,'0') = 'h'（按长度截断）", (await one("SELECT LPAD('hi', 1, '0')")) === 'h');
  ok("LPAD('7',3,'0') = '007'", (await one("SELECT LPAD('7', 3, '0')")) === '007');

  console.log('--- B5 POWER / POW NULL 传播 ---');
  ok('POWER(2,NULL) = NULL', (await one('SELECT POWER(2, NULL)')) === null);
  ok('POW(2,NULL) = NULL', (await one('SELECT POW(2, NULL)')) === null);
  ok('POWER(NULL,2) = NULL', (await one('SELECT POWER(NULL, 2)')) === null);
  ok('POWER(2,10) = 1024', (await one('SELECT POWER(2, 10)')) === 1024);

  console.log('--- B6 CAST AS UNSIGNED ---');
  const castU = await one('SELECT CAST(-5 AS UNSIGNED)');
  ok('CAST(-5 AS UNSIGNED) = 18446744073709551611', String(castU) === '18446744073709551611', castU);
  ok('CAST(5 AS UNSIGNED) = 5', String(await one('SELECT CAST(5 AS UNSIGNED)')) === '5');
  ok("CAST('12abc' AS SIGNED) = 12（保持原语义）", (await one("SELECT CAST('12abc' AS SIGNED)")) === 12);
  ok("CAST(-5 AS SIGNED) = -5", (await one('SELECT CAST(-5 AS SIGNED)')) === -5);
  ok('CAST(-5 AS UNSIGNED) + 0 非负', Number(await one('SELECT CAST(-5 AS UNSIGNED) + 0')) >= 0);

  console.log('--- H3 UPDATE SET = 标量子查询 ---');
  {
    await q('CREATE TABLE h3a(id INT PRIMARY KEY, v INT, w TEXT)');
    await q('CREATE TABLE h3b(id INT PRIMARY KEY, v INT)');
    await q('INSERT INTO h3a VALUES (1, 1), (2, 2)');
    await q('INSERT INTO h3b VALUES (1, 42), (2, NULL)');
    await q('UPDATE h3a SET v = (SELECT b.v FROM h3b b WHERE b.id = 1)');
    ok('非相关子查询返回 42 写入（旧实现写 NULL）',
      eq((await q('SELECT v FROM h3a ORDER BY id')).rows, [[42], [42]]),
      (await q('SELECT v FROM h3a ORDER BY id')).rows);
    await q('UPDATE h3a SET v = (SELECT b.v FROM h3b b WHERE b.id = 99)');
    ok('子查询无匹配 → 写入 NULL',
      eq((await q('SELECT v FROM h3a ORDER BY id')).rows, [[null], [null]]));
    await q('UPDATE h3a SET v = (SELECT b.v FROM h3b b WHERE b.id = 2)');
    ok('子查询取到 NULL 值 → 写入 NULL',
      eq((await q('SELECT v FROM h3a ORDER BY id')).rows, [[null], [null]]));
    await q('UPDATE h3a SET v = (SELECT b.v FROM h3b b WHERE b.id = 1) + 1');
    ok('子查询参与表达式运算（42+1=43）',
      eq((await q('SELECT v FROM h3a ORDER BY id')).rows, [[43], [43]]),
      (await q('SELECT v FROM h3a ORDER BY id')).rows);
    await q('UPDATE h3a SET w = (SELECT b.v FROM h3b b WHERE b.id = 1)');    // 值确实写进去了（不是 NULL）。存储层对 UPDATE 不做列类型强转，
    // 数值 42 会原样留在 TEXT 列里 —— 与本 bug（一律写 NULL）无关，按字符串比较。
    ok('写入字符串列（旧实现写 NULL）',
      eq((await q('SELECT w FROM h3a ORDER BY id')).rows.map(r => String(r[0])), ['42', '42']),
      (await q('SELECT w FROM h3a ORDER BY id')).rows);

    // 相关子查询：外层列（s.id）必须在子查询里能解析到，否则 SUM 全为 NULL
    await q('CREATE TABLE h3c(id INT PRIMARY KEY, tot INT)');
    await q('INSERT INTO h3c VALUES (1, 0), (2, 0)');
    await q('CREATE TABLE h3d(id INT PRIMARY KEY, uid INT, amt INT)');
    await q('INSERT INTO h3d VALUES (1, 1, 10), (2, 1, 5), (3, 2, 7)');
    await q('UPDATE h3c SET tot = (SELECT SUM(amt) FROM h3d WHERE h3d.uid = h3c.id)');
    ok('相关子查询按外层行求值（10+5 / 7）',
      eq((await q('SELECT tot FROM h3c ORDER BY id')).rows, [[15], [7]]),
      (await q('SELECT tot FROM h3c ORDER BY id')).rows);
  }

  console.log('--- H4 BETWEEN 类型感知 ---');
  {
    await q('CREATE TABLE h4(v INT)');
    await q('INSERT INTO h4 VALUES (10), (5), (100)');
    ok("数值列 vs 字符串边界：10 BETWEEN '5' AND '90' = 1",
      eq((await q("SELECT v FROM h4 WHERE v BETWEEN '5' AND '90' ORDER BY v")).rows, [[5], [10]]),
      (await q("SELECT v FROM h4 WHERE v BETWEEN '5' AND '90' ORDER BY v")).rows);
    ok("10 BETWEEN '5' AND '9' = 0（确实超上界）",
      (await one("SELECT 10 BETWEEN '5' AND '9'")) === 0);
    ok("5 BETWEEN '10' AND '20' = 0",
      (await one("SELECT 5 BETWEEN '10' AND '20'")) === 0);
    ok('字符串日期边界仍按字典序', (await one("SELECT '2024-05-01' BETWEEN '2024-01-01' AND '2024-12-31'")) === 1);
    ok('NOT BETWEEN 取反正确', (await one("SELECT 10 NOT BETWEEN '5' AND '9'")) === 1);
    ok('含 NULL 边界 → NULL', (await one('SELECT 10 BETWEEN NULL AND 9')) === null);
  }

  console.log('--- H5 主键 NULL ---');
  {
    await q('CREATE TABLE h5t(code TEXT PRIMARY KEY, x INT)');
    const e1 = await fails('INSERT INTO h5t (code, x) VALUES (NULL, 1)');
    ok('TEXT 主键 INSERT NULL 被拒绝', /cannot be null/.test(e1 || ''), e1);
    ok('TEXT 主键正常值可插入', (await fails("INSERT INTO h5t VALUES ('a', 1)")) === null);
    const e2 = await fails('UPDATE h5t SET code = NULL WHERE x = 1');
    ok('TEXT 主键 UPDATE 成 NULL 被拒绝', /cannot be null/.test(e2 || ''), e2);

    await q('CREATE TABLE h5c(a INT, b INT, PRIMARY KEY(a, b))');
    const e3 = await fails('INSERT INTO h5c VALUES (1, NULL)');
    ok('复合主键任一部分 NULL 被拒绝', /cannot be null/.test(e3 || ''), e3);
    ok('复合主键完整值可插入', (await fails('INSERT INTO h5c VALUES (1, 2)')) === null);

    await q('CREATE TABLE h5u(id INT PRIMARY KEY AUTO_INCREMENT, x INT)');
    await q('INSERT INTO h5u (id, x) VALUES (1, 7)');
    const e4 = await fails('UPDATE h5u SET id = NULL WHERE x = 7');
    ok('自增主键 UPDATE 成 NULL 也被拒绝', /cannot be null/.test(e4 || ''), e4);
    ok('自增主键行仍能按 id 找到', eq((await q('SELECT x FROM h5u WHERE id = 1')).rows, [[7]]));
    ok('自增主键 INSERT NULL 仍可自动分配',
      (await fails('INSERT INTO h5u (id, x) VALUES (NULL, 9)')) === null);
  }

  console.log('--- M1 createError %s 替换 ---');
  {
    // 参数自身带 %s 时不能被下一轮替换吃掉
    const e = createError('ER_BAD_FIELD_ERROR', 'X%sY', 'Z');
    ok("参数含 %s 保持原样：'X%sY' in 'Z'",
      e.message === "Unknown column 'X%sY' in 'Z'", e.message);
    ok('%s 按模板顺序一对一消费',
      createError('ER_BAD_FIELD_ERROR', 'c1', 't1').message === "Unknown column 'c1' in 't1'");
    ok('参数里的 $& / $1 不被当作替换模式',
      createError('ER_BAD_FIELD_ERROR', '$&', '$1').message === "Unknown column '$&' in '$1'",
      createError('ER_BAD_FIELD_ERROR', '$&', '$1').message);
    ok('模板无 %s 时不丢参数（追加提示）',
      /No transaction in progress.*hint/.test(createError('ER_NO_TRANSACTION', 'hint').message),
      createError('ER_NO_TRANSACTION', 'hint').message);
    ok('错误码保留（1054）', createError('ER_BAD_FIELD_ERROR', 'a', 'b').code === 1054);
    ok('缺参数时保留剩余占位符',
      createError('ER_BAD_FIELD_ERROR', 'only').message === "Unknown column 'only' in '%s'");
  }

  await db.stop();

  console.warn = realWarn;
  console.log(`\n=== pass ${pass}  fail ${fail} ===`);
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => {
  console.warn = realWarn;
  console.error('FATAL', e);
  process.exit(1);
});
