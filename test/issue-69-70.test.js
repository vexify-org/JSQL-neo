/* ---- issue #69 / #70 回归 ---- */
const path = require('path');
const fs = require('fs');
const os = require('os');
const ROOT = path.join(__dirname, '..');
const { Database, executeSQL } = require(path.join(ROOT, 'index.js'));

let pass = 0, fail = 0;
function ok(name, cond, got) {
  if (cond) { pass++; console.log('[OK]   ' + name); }
  else { fail++; console.log('[FAIL] ' + name + ' -> ' + JSON.stringify(got)); }
}
async function run(db, sql) { return executeSQL(db, sql, { safety: false }); }
async function cell(db, sql) { return (await run(db, sql)).rows[0][0]; }
async function throwsCode(fn, code) {
  try { await fn(); return false; }
  catch (e) { return code ? (e.code === code || e.code === 3819) : true; }
}

(async () => {
  // =========================================================
  // #69 字符串算术：MySQL 宽松转换（数值前缀）
  // =========================================================
  {
    const db = new Database(':memory:', { autoSave: false });
    const cases = [
      ["SELECT '5a' + 1", 6],
      ["SELECT '5a' + 0", 5],
      ["SELECT '12abc' + 0", 12],
      ["SELECT '5a' + '3'", 8],
      ["SELECT '5a' - 1", 4],
      ["SELECT '5a' * 2", 10],
      ["SELECT '6a' / 2", 3],
      ["SELECT '5a' % 2", 1],
      ["SELECT '3.5x' + 1", 4.5],
      ["SELECT '-2x' + 1", -1],
      ["SELECT 'abc' + 1", 1],
      ["SELECT 'a' + 'b'", 0],
      ["SELECT '' + 5", 5],
    ];
    for (const [sql, want] of cases) {
      const got = await cell(db, sql);
      ok('#69 ' + sql + ' = ' + want, got === want, got);
    }
    ok("#69 '5a' = 5 为真（数值比较）", (await cell(db, "SELECT '5a' = 5")) === 1, null);
    ok("#69 '5a' > 4 为真", (await cell(db, "SELECT '5a' > 4")) === 1, null);

    // 列数据：TEXT 列里的脏数字同样按数值前缀参与算术
    await run(db, 'CREATE TABLE t69 (id INT PRIMARY KEY, v TEXT)');
    await db.insert('t69', { id: 1, v: '5abc' });
    await db.insert('t69', { id: 2, v: '12x' });
    ok('#69 列值 v + 1', (await cell(db, 'SELECT v + 1 FROM t69 WHERE id = 1')) === 6, null);
    ok('#69 WHERE v + 0 = 12 命中', (await cell(db, 'SELECT COUNT(*) FROM t69 WHERE v + 0 = 12')) === 1, null);
    ok('#69 聚合 SUM(v + 0)', (await cell(db, 'SELECT SUM(v + 0) FROM t69')) === 17, null);

    // 保持既有语义：NULL 参与运算仍是 NULL
    ok('#69 NULL + 1 = NULL', (await cell(db, 'SELECT NULL + 1')) === null, null);
    // 精确整数 / BigInt 路径不受影响
    ok('#69 BigInt 加法仍精确', (await cell(db, 'SELECT 9007199254740993 + 1')) === 9007199254740994n ||
      String(await cell(db, 'SELECT 9007199254740993 + 1')) === '9007199254740994', null);
    // '!' 逻辑非（解析器此前会抛 Unexpected token '!'）
    ok('#69 !1 = 0', (await cell(db, 'SELECT !1')) === 0, null);
    ok('#69 !0 = 1', (await cell(db, 'SELECT !0')) === 1, null);
    ok('#69 != 未被破坏', (await cell(db, 'SELECT 1 != 2')) === 1, null);
    await db.close?.();
  }

  // =========================================================
  // #70 CHECK 约束：列级 / 表级 / 更新 / 批量 / 语法错误
  // =========================================================
  {
    const db = new Database(':memory:', { autoSave: false });

    // ---- 列级 ----
    await run(db, 'CREATE TABLE ck (id INT PRIMARY KEY, age INT CHECK (age >= 0))');
    ok('#70 列级 CHECK 合法插入', await throwsCode(async () => db.insert('ck', { id: 1, age: 10 }), null) === false, null);
    ok('#70 列级 CHECK 拒绝负值', await throwsCode(() => db.insert('ck', { id: 2, age: -1 }), 'ER_CHECK_CONSTRAINT'), null);
    ok('#70 列级 CHECK 拒绝 SQL 插入', await throwsCode(() => run(db, 'INSERT INTO ck (id, age) VALUES (3, -5)'), 'ER_CHECK_CONSTRAINT'), null);
    ok('#70 列级 CHECK 允许 NULL', await throwsCode(async () => db.insert('ck', { id: 4, age: null }), null) === false, null);

    // ---- UPDATE 两条路径都要校验 ----
    ok('#70 SQL UPDATE 违反 CHECK 报错', await throwsCode(() => run(db, 'UPDATE ck SET age = -1 WHERE id = 1'), 'ER_CHECK_CONSTRAINT'), null);
    ok('#70 updateById 违反 CHECK 报错', await throwsCode(() => db.updateById('ck', 1, { age: -1 }), 'ER_CHECK_CONSTRAINT'), null);
    ok('#70 合法 UPDATE 生效', (await run(db, 'UPDATE ck SET age = 20 WHERE id = 1')).affectedRows === 1, null);
    ok('#70 UPDATE 后值正确', (await cell(db, 'SELECT age FROM ck WHERE id = 1')) === 20, null);

    // ---- 批量插入 ----
    const many = await throwsCode(() => db.insert('ck', [{ id: 10, age: 1 }, { id: 11, age: -2 }]), 'ER_CHECK_CONSTRAINT');
    ok('#70 insertMany 违反 CHECK 报错', many, null);
    ok('#70 insertMany 失败行未写入', (await cell(db, 'SELECT COUNT(*) FROM ck WHERE id = 11')) === 0, null);

    // ---- 表级（跨列） ----
    await run(db, 'CREATE TABLE tk (x INT, y INT, CHECK (x > y))');
    ok('#70 表级跨列满足', await throwsCode(async () => db.insert('tk', { x: 10, y: 1 }), null) === false, null);
    ok('#70 表级跨列违反（插入）', await throwsCode(() => db.insert('tk', { x: 1, y: 10 }), 'ER_CHECK_CONSTRAINT'), null);
    ok('#70 表级跨列违反（只更新一列）', await throwsCode(() => db.updateById('tk', 1, { y: 99 }), 'ER_CHECK_CONSTRAINT'), null);
    ok('#70 表级跨列违反（SQL UPDATE）', await throwsCode(() => run(db, 'UPDATE tk SET y = 50 WHERE x = 10'), 'ER_CHECK_CONSTRAINT'), null);

    // ---- 具名约束 / 多条约束 / 复杂条件 ----
    await run(db, `CREATE TABLE ck2 (
      id INT PRIMARY KEY,
      a INT,
      b INT,
      CONSTRAINT ck_ab CHECK (a < b),
      CHECK (b < 100),
      CHECK (a >= 0 AND b >= 0)
    )`);
    ok('#70 多约束合法行', await throwsCode(async () => db.insert('ck2', { id: 1, a: 1, b: 2 }), null) === false, null);
    ok('#70 多约束 ck_ab 违反', await throwsCode(() => db.insert('ck2', { id: 2, a: 3, b: 2 }), 'ER_CHECK_CONSTRAINT'), null);
    ok('#70 多约束 b < 100 违反', await throwsCode(() => db.insert('ck2', { id: 3, a: 1, b: 200 }), 'ER_CHECK_CONSTRAINT'), null);
    ok('#70 AND 条件违反', await throwsCode(() => db.insert('ck2', { id: 4, a: -1, b: 2 }), 'ER_CHECK_CONSTRAINT'), null);
    ok('#70 任一列为 NULL 时条件为 UNKNOWN→通过', await throwsCode(async () => db.insert('ck2', { id: 5, a: null, b: 2 }), null) === false, null);

    // ---- 函数 / IN 条件也能编译执行 ----
    await run(db, "CREATE TABLE ck3 (id INT PRIMARY KEY, s TEXT CHECK (LENGTH(s) > 0 AND s NOT IN ('bad')))");
    ok('#70 函数条件合法', await throwsCode(async () => db.insert('ck3', { id: 1, s: 'ok' }), null) === false, null);
    ok('#70 函数条件违反（空串）', await throwsCode(() => db.insert('ck3', { id: 2, s: '' }), 'ER_CHECK_CONSTRAINT'), null);
    ok('#70 IN 条件违反', await throwsCode(() => db.insert('ck3', { id: 3, s: 'bad' }), 'ER_CHECK_CONSTRAINT'), null);

    // ---- 语法错误不能被静默吞掉 ----
    ok('#70 CHECK 语法错误在 CREATE 时报错', await throwsCode(() => run(db, 'CREATE TABLE bad1 (a INT CHECK (a >=))')), null);
    ok('#70 CHECK 缺少右括号报错', await throwsCode(() => run(db, 'CREATE TABLE bad2 (a INT CHECK (a > 0)')), null);

    // ---- 程序化 createTable（JS API）不受影响 ----
    await db.createTable('prog', { id: { type: 'integer', primaryKey: true }, n: { type: 'integer', check: (v) => v > 0 } });
    ok('#70 JS API def.check 仍生效', await throwsCode(() => db.insert('prog', { id: 1, n: -1 }), 'ER_CHECK_CONSTRAINT'), null);

    await db.close?.();
  }

  // =========================================================
  // #70 持久化：磁盘目录模式重开后 CHECK 仍生效
  // =========================================================
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsql-ck70-'));
    let db = new Database(dir, { mode: 'disk' });
    await run(db, 'CREATE TABLE p (id INT PRIMARY KEY, age INT CHECK (age >= 0), CHECK (age < 100))');
    await db.insert('p', { id: 1, age: 5 });
    await db.close();

    db = new Database(dir, { mode: 'disk' });
    ok('#70 重开后数据仍在', (await db.find('p', {}))[0].age === 5, null);
    ok('#70 重开后列级 CHECK 生效', await throwsCode(() => db.insert('p', { id: 2, age: -1 }), 'ER_CHECK_CONSTRAINT'), null);
    ok('#70 重开后表级 CHECK 生效', await throwsCode(() => db.insert('p', { id: 3, age: 200 }), 'ER_CHECK_CONSTRAINT'), null);
    ok('#70 重开后合法数据可插入', await throwsCode(async () => db.insert('p', { id: 4, age: 8 }), null) === false, null);
    await db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => { console.error('[FATAL]', e); process.exit(1); });
