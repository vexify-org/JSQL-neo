/* ---- 回归：#248 / #249 / #250 / #251 / #252 ---- */
/*
 * #248 批量 INSERT ... ON DUPLICATE KEY UPDATE 同一键多行时，每行都按
 *      「语句执行前的旧值」求值，累加结果错误。
 * #249 UPDATE t SET col = DEFAULT 被当成列引用求值，实际写入 NULL。
 * #250 db.updateById() 绕过 NOT NULL 约束，把 NULL 写进 NOT NULL 列。
 * #251 JS 建表 API 的 check: 'a > 0' 字符串约束被静默忽略。
 * #252 ALTER TABLE ADD COLUMN ... NOT NULL（无 DEFAULT）给存量行填 NULL。
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

    // ================= #248 ON DUPLICATE 批量累加 =================
    await q('CREATE TABLE up (id INT PRIMARY KEY, n INT)');
    await q('INSERT INTO up VALUES (1,0)');
    await q('INSERT INTO up VALUES (1,1) ON DUPLICATE KEY UPDATE n = n + VALUES(n)');
    ok('单行 upsert：n = 0 + 1 = 1',
        JSON.stringify(await q('SELECT * FROM up')) === '[[1,1]]', await q('SELECT * FROM up'));

    await q('INSERT INTO up VALUES (1,2),(1,3) ON DUPLICATE KEY UPDATE n = n + VALUES(n)');
    ok('批量 upsert 同键多行按行顺序累加：1 + 2 + 3 = 6',
        JSON.stringify(await q('SELECT * FROM up')) === '[[1,6]]', await q('SELECT * FROM up'));

    // 三行同键
    await q('CREATE TABLE up3 (id INT PRIMARY KEY, n INT)');
    await q('INSERT INTO up3 VALUES (1,0)');
    await q('INSERT INTO up3 VALUES (1,1),(1,2),(1,3) ON DUPLICATE KEY UPDATE n = n + VALUES(n)');
    ok('三行同键批量 upsert = 6',
        JSON.stringify(await q('SELECT * FROM up3')) === '[[1,6]]', await q('SELECT * FROM up3'));

    // 不回归：普通多行插入
    await q('CREATE TABLE plain (id INT PRIMARY KEY, n INT)');
    await q('INSERT INTO plain VALUES (1,1),(2,2),(3,3)');
    ok('普通多行 INSERT 不回归',
        JSON.stringify(await q('SELECT * FROM plain')) === '[[1,1],[2,2],[3,3]]', null);

    // ================= #249 SET col = DEFAULT =================
    await q('CREATE TABLE df (id INT PRIMARY KEY, n INT DEFAULT 7)');
    await q('INSERT INTO df VALUES (1, 1)');
    const r = await executeSQL(db, 'UPDATE df SET n = DEFAULT WHERE id = 1', { safety: false });
    ok('UPDATE SET DEFAULT 影响 1 行', r.affectedRows === 1, r.affectedRows);
    ok('UPDATE SET n = DEFAULT 把 n 重置为列默认值 7',
        JSON.stringify(await q('SELECT * FROM df')) === '[[1,7]]', await q('SELECT * FROM df'));

    // 无显式默认值 → 按类型的隐式默认值
    await q('CREATE TABLE df2 (id INT PRIMARY KEY, m INT)');
    await q('INSERT INTO df2 VALUES (1, 5)');
    await q('UPDATE df2 SET m = DEFAULT WHERE id = 1');
    ok('无 DEFAULT 时用隐式默认值 0',
        JSON.stringify(await q('SELECT * FROM df2')) === '[[1,0]]', await q('SELECT * FROM df2'));

    await q('CREATE TABLE df3 (id INT PRIMARY KEY, s VARCHAR(10))');
    await q("INSERT INTO df3 VALUES (1, 'x')");
    await q('UPDATE df3 SET s = DEFAULT WHERE id = 1');
    ok('字符串列的隐式默认值为空串',
        JSON.stringify(await q('SELECT * FROM df3')) === '[[1,""]]', await q('SELECT * FROM df3'));

    // 不回归：普通 SET
    await q('UPDATE df SET n = 3 WHERE id = 1');
    ok('普通 SET 不回归',
        JSON.stringify(await q('SELECT * FROM df')) === '[[1,3]]', await q('SELECT * FROM df'));

    // ================= #250 updateById NOT NULL =================
    await q('CREATE TABLE nt (id INT PRIMARY KEY, s VARCHAR(5) NOT NULL)');
    await q("INSERT INTO nt VALUES (1, 'x')");
    let updErr = null;
    try { await db.updateById('nt', 1, { s: null }); } catch (e) { updErr = e; }
    ok('db.updateById 写 NULL 进 NOT NULL 列报错', !!updErr, updErr && updErr.message);
    ok('报错是 Column cannot be null',
        updErr && /cannot be null/i.test(updErr.message), updErr && updErr.message);
    ok('失败后数据未被破坏',
        JSON.stringify(await q('SELECT * FROM nt')) === '[[1,"x"]]', await q('SELECT * FROM nt'));

    // db.update 同样报错（两条路径口径一致）
    let updErr2 = null;
    try { await db.update('nt', { id: 1 }, { s: null }); } catch (e) { updErr2 = e; }
    ok('db.update 同样报错（两条 API 路径一致）', !!updErr2, updErr2 && updErr2.message);

    // 合法更新仍成功
    await db.updateById('nt', 1, { s: 'y' });
    ok('合法 updateById 仍成功',
        JSON.stringify(await q('SELECT * FROM nt')) === '[[1,"y"]]', await q('SELECT * FROM nt'));

    // ================= #251 字符串 CHECK 约束 =================
    await db.createTable('ck', {
        id: { type: 'integer', primaryKey: true },
        a: { type: 'integer', check: 'a > 0' },
    });
    let ckErr = null;
    try { await q('INSERT INTO ck VALUES (1, -5)'); } catch (e) { ckErr = e; }
    ok('SQL INSERT 违反字符串 CHECK 报错', !!ckErr, ckErr && ckErr.message);
    ok('报错是 Check constraint violated',
        ckErr && /Check constraint/i.test(ckErr.message), ckErr && ckErr.message);

    let ckErr2 = null;
    try { await db.insert('ck', { id: 2, a: -7 }); } catch (e) { ckErr2 = e; }
    ok('API insert 违反字符串 CHECK 同样报错', !!ckErr2, ckErr2 && ckErr2.message);

    let ckOk = null;
    try { await q('INSERT INTO ck VALUES (3, 5)'); ckOk = true; } catch (e) { ckOk = false; }
    ok('满足 CHECK 的插入成功', ckOk === true, ckOk);

    // 不回归：函数形态的 CHECK
    await db.createTable('ck2', {
        id: { type: 'integer', primaryKey: true },
        a: { type: 'integer', check: (v) => v > 0 },
    });
    let fnErr = null;
    try { await db.insert('ck2', { id: 1, a: -1 }); } catch (e) { fnErr = e; }
    ok('函数形态 CHECK 不回归', !!fnErr, fnErr && fnErr.message);

    // ================= #252 ADD COLUMN NOT NULL =================
    await q('CREATE TABLE ac (id INT PRIMARY KEY)');
    await q('INSERT INTO ac VALUES (1),(2)');
    await q('ALTER TABLE ac ADD COLUMN s VARCHAR(5) NOT NULL');
    ok('ADD COLUMN VARCHAR NOT NULL 存量行填空串',
        JSON.stringify(await q('SELECT * FROM ac')) === '[[1,""],[2,""]]', await q('SELECT * FROM ac'));
    await q('ALTER TABLE ac ADD COLUMN n INT NOT NULL');
    ok('ADD COLUMN INT NOT NULL 存量行填 0',
        JSON.stringify(await q('SELECT * FROM ac')) === '[[1,"",0],[2,"",0]]', await q('SELECT * FROM ac'));

    // 不回归：可空列仍填 NULL
    await q('CREATE TABLE ac2 (id INT PRIMARY KEY)');
    await q('INSERT INTO ac2 VALUES (1)');
    await q('ALTER TABLE ac2 ADD COLUMN x INT');
    ok('可空列仍填 NULL（不回归）',
        JSON.stringify(await q('SELECT * FROM ac2')) === '[[1,null]]', await q('SELECT * FROM ac2'));

    // 不回归：带 DEFAULT 的列按 DEFAULT 回填
    await q('CREATE TABLE ac3 (id INT PRIMARY KEY)');
    await q('INSERT INTO ac3 VALUES (1)');
    await q('ALTER TABLE ac3 ADD COLUMN d INT DEFAULT 42');
    ok('带 DEFAULT 的列按 DEFAULT 回填',
        JSON.stringify(await q('SELECT * FROM ac3')) === '[[1,42]]', await q('SELECT * FROM ac3'));

    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail === 0 ? 0 : 1);
})().catch(e => {
    console.log('[FAIL] unexpected exception: ' + (e.stack || e).split('\n').slice(0, 4).join('\n'));
    process.exit(1);
});
