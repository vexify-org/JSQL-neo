/* ---- 回归：#243 / #245 / #246 / #288 / #289 ---- */
/*
 * #243 CAST(... AS SIGNED/UNSIGNED) 丢失 >2^53 的精度，且不识别科学计数法。
 * #245 UNIQUE 索引按字节区分大小写，而等值比较不区分 —— 'a' 与 'A' 能共存。
 * #246 父表 RENAME 后，子表外键校验与 ON DELETE CASCADE 全部静默失效。
 * #288 SUBSTRING(str, 负偏移越界) 无长度参数时返回整串/尾部片段，应为空串。
 * #289 INSERT(str,pos,len,newstr) 按 UTF-16 code unit 切分，emoji 被劈开。
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
    const q = async (sql) => (await executeSQL(db, sql, { safety: false })).rows;
    const one = async (sql) => (await q(sql))[0][0];

    // ================= #243 CAST 精度 =================
    ok("CAST('9223372036854775808' AS SIGNED) 钳到 BIGINT 上界",
        String(await one("SELECT CAST('9223372036854775808' AS SIGNED)")) === '9223372036854775807', null);
    ok("CAST('18446744073709551615' AS UNSIGNED) 精确",
        String(await one("SELECT CAST('18446744073709551615' AS UNSIGNED)")) === '18446744073709551615', null);
    ok("CAST('999999999999999999999999' AS SIGNED) 钳到上界",
        String(await one("SELECT CAST('999999999999999999999999' AS SIGNED)")) === '9223372036854775807', null);
    ok("CAST('1e3' AS SIGNED) = 1000（识别科学计数法）",
        await one("SELECT CAST('1e3' AS SIGNED)") === 1000, null);
    ok("CAST('1.5e2' AS SIGNED) = 150",
        await one("SELECT CAST('1.5e2' AS SIGNED)") === 150, null);
    ok("CAST('12abc' AS SIGNED) = 12（取数字前缀）",
        await one("SELECT CAST('12abc' AS SIGNED)") === 12, null);
    ok("CAST('abc' AS SIGNED) = 0",
        await one("SELECT CAST('abc' AS SIGNED)") === 0, null);
    ok("CAST('1.5' AS SIGNED) = 2（四舍五入半远离零）",
        await one("SELECT CAST('1.5' AS SIGNED)") === 2, null);
    ok("CAST('-1.5' AS SIGNED) = -2",
        await one("SELECT CAST('-1.5' AS SIGNED)") === -2, null);
    ok("CAST(-5 AS UNSIGNED) 按 2^64 回绕",
        String(await one("SELECT CAST(-5 AS UNSIGNED)")) === '18446744073709551611', null);
    ok("CAST('3.9' AS INT) = 4（类型仍是 number）",
        await one("SELECT CAST('3.9' AS INT)") === 4, null);
    ok("CAST(NULL AS SIGNED) = NULL",
        await one("SELECT CAST(NULL AS SIGNED)") === null, null);

    // ================= #245 UNIQUE 大小写口径 =================
    await q('CREATE TABLE u (id INT PRIMARY KEY, e VARCHAR(10) UNIQUE)');
    await q("INSERT INTO u VALUES (1,'a')");
    ok("WHERE e='A' 命中小写行（等值比较不区分大小写）",
        JSON.stringify(await q("SELECT id,e FROM u WHERE e='A'")) === '[[1,"a"]]', null);
    let dupErr = null;
    try { await q("INSERT INTO u VALUES (2,'A')"); } catch (e) { dupErr = e; }
    ok("INSERT 'A' 在已有 'a' 时报 1062（唯一约束同口径）", !!dupErr, dupErr && dupErr.message);
    ok("报错是 Duplicate entry",
        dupErr && /Duplicate entry/i.test(dupErr.message), dupErr && dupErr.message);
    ok("WHERE e='a' 只命中 1 行（约束与查询不再互相拆台）",
        JSON.stringify(await q("SELECT id,e FROM u WHERE e='a'")) === '[[1,"a"]]', null);

    // UPDATE 成大小写变体：MySQL 语义 —— 唯一索引里折叠后是同一个键，
    // 但冲突方就是本行自身，所以允许（唯一约束不与自己冲突）。
    let updErr = null;
    try { await q("UPDATE u SET e='A' WHERE id=1"); } catch (e) { updErr = e; }
    ok("UPDATE 成自身的大小写变体不报冲突（MySQL 语义）", !updErr, updErr && updErr.message);
    ok("UPDATE 后值变成 'A'",
        JSON.stringify(await q('SELECT id,e FROM u')) === '[[1,"A"]]', null);

    // 但 UPDATE 成别的行已占用的键必须报错
    await q('CREATE TABLE u5 (id INT PRIMARY KEY, e VARCHAR(10) UNIQUE)');
    await q("INSERT INTO u5 VALUES (1,'a')");
    await q("INSERT INTO u5 VALUES (2,'b')");
    let updErr2 = null;
    try { await q("UPDATE u5 SET e='A' WHERE id=2"); } catch (e) { updErr2 = e; }
    ok("UPDATE 成其它行已占用的键报 1062", !!updErr2, updErr2 && updErr2.message);

    // 批量插入路径同样按折叠口径
    await q('CREATE TABLE u2 (id INT PRIMARY KEY, e VARCHAR(10) UNIQUE)');
    let bulkErr = null;
    try { await db._tables.u2.insertMany([{ id: 1, e: 'x' }, { id: 2, e: 'X' }]); }
    catch (e) { bulkErr = e; }
    ok("insertMany 里 'x' / 'X' 被判为重复", !!bulkErr, bulkErr && bulkErr.message);

    // 复合 UNIQUE 也按折叠口径
    await q('CREATE TABLE u3 (id INT PRIMARY KEY, a VARCHAR(10), b VARCHAR(10), UNIQUE(a,b))');
    await q("INSERT INTO u3 VALUES (1,'ab','c')");
    let compErr = null;
    try { await q("INSERT INTO u3 VALUES (2,'AB','c')"); } catch (e) { compErr = e; }
    ok("复合 UNIQUE 里 'ab'/'AB' 判为重复", !!compErr, compErr && compErr.message);

    // 数值列的唯一约束不受影响（折叠键 == 原值）
    await q('CREATE TABLE u4 (id INT PRIMARY KEY, n INT UNIQUE)');
    await q('INSERT INTO u4 VALUES (1, 10)');
    let numErr = null;
    try { await q('INSERT INTO u4 VALUES (2, 10)'); } catch (e) { numErr = e; }
    ok("数值列 UNIQUE 仍报 1062", !!numErr, numErr && numErr.message);
    let numOk = null;
    try { await q('INSERT INTO u4 VALUES (2, 11)'); numOk = true; } catch (e) { numOk = false; }
    ok("数值列 UNIQUE 不冲突值可插入', ", numOk === true, numOk);

    // ================= #246 RENAME 后外键 =================
    await q('CREATE TABLE p (id INT PRIMARY KEY)');
    await q('CREATE TABLE c (id INT PRIMARY KEY, pid INT REFERENCES p(id) ON DELETE CASCADE)');
    await q('INSERT INTO p VALUES (1)');
    await q('INSERT INTO c VALUES (10,1)');
    await q('ALTER TABLE p RENAME TO p2');
    ok("改名后子表外键引用指向新表名",
        db._tables.c._foreignKeys[0].table === 'p2', db._tables.c._foreignKeys);
    let fkErr = null;
    try { await q('INSERT INTO c VALUES (11, 999)'); } catch (e) { fkErr = e; }
    ok("改名后写坏引用被拒绝（外键校验未失效）", !!fkErr, fkErr && fkErr.message);
    ok("报错是 foreign key constraint fails",
        fkErr && /foreign key/i.test(fkErr.message), fkErr && fkErr.message);
    await db.delete('p2', { id: 1 });
    ok("改名后删除父行仍级联删子行",
        JSON.stringify(await q('SELECT * FROM c')) === '[]', null);

    // ================= #288 SUBSTRING 负偏移越界 =================
    ok("SUBSTRING('abc', -10) = ''（越界负偏移）",
        await one("SELECT SUBSTRING('abc', -10)") === '', null);
    ok("SUBSTRING('abcdef', -10) = ''",
        await one("SELECT SUBSTRING('abcdef', -10)") === '', null);
    ok("SUBSTRING('abcdef', -2) = 'ef'（合法负偏移不回归）",
        await one("SELECT SUBSTRING('abcdef', -2)") === 'ef', null);
    ok("SUBSTRING('Sakila', -3) = 'ila'",
        await one("SELECT SUBSTRING('Sakila', -3)") === 'ila', null);
    ok("SUBSTRING('abc', 2) = 'bc'（正常不回归）",
        await one("SELECT SUBSTRING('abc', 2)") === 'bc', null);
    ok("SUBSTRING('abc', 1, 2) = 'ab'",
        await one("SELECT SUBSTRING('abc', 1, 2)") === 'ab', null);
    ok("SUBSTR 同样钳制",
        await one("SELECT SUBSTR('abc', -10)") === '', null);
    ok("MID 同样钳制",
        await one("SELECT MID('abc', -10)") === '', null);

    // ================= #289 INSERT emoji =================
    const ins = await one("SELECT INSERT('ab🚀cd', 3, 1, 'X')");
    ok("INSERT('ab🚀cd',3,1,'X') = 'abXcd'（不劈开 emoji）",
        ins === 'abXcd', ins);
    ok("结果无孤立代理项", !/[\uD800-\uDFFF]/.test(String(ins).replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, '')), ins);
    ok("INSERT('Quadratic',3,4,'What') = 'QuWhattic'（ASCII 不回归）",
        await one("SELECT INSERT('Quadratic', 3, 4, 'What')") === 'QuWhattic', null);
    ok("INSERT('abcdef',2,3,'XY') = 'aXYef'",
        await one("SELECT INSERT('abcdef', 2, 3, 'XY')") === 'aXYef', null);
    // pos=0 / 越界：MySQL 返回原串
    ok("INSERT('abc',0,2,'X') = 'abc'（MySQL：pos 不在范围内返回原串）",
        await one("SELECT INSERT('abc', 0, 2, 'X')") === 'abc', null);
    ok("INSERT('abc',-1,2,'X') = 'abc'",
        await one("SELECT INSERT('abc', -1, 2, 'X')") === 'abc', null);
    ok("INSERT('abc',9,2,'X') = 'abc'（越界返回原串）",
        await one("SELECT INSERT('abc', 9, 2, 'X')") === 'abc', null);
    ok("INSERT('abc',1,0,'X') = 'Xabc'（len=0 纯插入）",
        await one("SELECT INSERT('abc', 1, 0, 'X')") === 'Xabc', null);
    ok("INSERT(NULL,...) = NULL",
        await one("SELECT INSERT(NULL, 1, 1, 'X')") === null, null);

    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail === 0 ? 0 : 1);
})().catch(e => {
    console.log('[FAIL] unexpected exception: ' + (e.stack || e).split('\n').slice(0, 4).join('\n'));
    process.exit(1);
});
