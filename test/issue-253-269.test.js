/* ---- 回归：#253 / #254 / #261 / #268 / #269 ---- */
/*
 * #253 mysql_compat 多语句只返回最后一个结果集，前面的结果集被静默丢弃。
 * #254 PG Describe/Close 的语句名解析 off-by-one：'s1' 被读成 's'、
 *      单字符名读成空串。
 * #261 列存快路径的 WHERE 比较符不做 NULL 三值逻辑，与行存通用路径结果不一致。
 * #268 AUTO_INCREMENT 列显式插入 0 被当作字面值保留，MySQL 会分配下一个序列值。
 * #269 INSERT IGNORE 遇到 CHECK 违反时整条语句抛 3819，MySQL 应降级为 warning。
 */
const path = require('path');
const ROOT = path.join(__dirname, '..');
const { Database, executeSQL } = require(path.join(ROOT, 'index.js'));
const { PgConnection } = require(path.join(ROOT, 'lib/pg_server.js'));

let pass = 0, fail = 0;
function ok(name, cond, got) {
    if (cond) { pass++; console.log('[OK]   ' + name); }
    else { fail++; console.log('[FAIL] ' + name + ' -> ' + JSON.stringify(got)); }
}

(async () => {
    const db = new Database(':memory:', { autoSave: false });
    const q = async (sql) => (await executeSQL(db, sql, { safety: false })).rows;
    const one = async (sql) => (await q(sql))[0][0];

    // ================= #261 列存 WHERE 的 NULL 三值逻辑 =================
    await q('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT, n INT)');
    await q("INSERT INTO t (id,v,n) VALUES (1,'a',10),(2,NULL,20),(3,'b',30)");
    const rowPath = {
        c1: (await q("SELECT COUNT(*) AS c FROM t WHERE v <> 'a'"))[0][0],
        c2: (await q('SELECT COUNT(*) AS c FROM t WHERE v = NULL'))[0][0],
        c3: (await q('SELECT COUNT(*) AS c FROM t WHERE v IS NULL'))[0][0],
        s1: (await q("SELECT SUM(n) AS s FROM t WHERE v <> 'a'"))[0][0],
    };
    db.convertToColumnar('t');
    const colPath = {
        c1: (await q("SELECT COUNT(*) AS c FROM t WHERE v <> 'a'"))[0][0],
        c2: (await q('SELECT COUNT(*) AS c FROM t WHERE v = NULL'))[0][0],
        c3: (await q('SELECT COUNT(*) AS c FROM t WHERE v IS NULL'))[0][0],
        s1: (await q("SELECT SUM(n) AS s FROM t WHERE v <> 'a'"))[0][0],
    };
    ok("列存 v <> 'a' 计数与行存一致（NULL 行不命中）",
        colPath.c1 === rowPath.c1, { row: rowPath.c1, col: colPath.c1 });
    ok('列存 v = NULL 计数与行存一致（恒为 0）',
        colPath.c2 === rowPath.c2, { row: rowPath.c2, col: colPath.c2 });
    ok('列存 v IS NULL 计数与行存一致',
        colPath.c3 === rowPath.c3, { row: rowPath.c3, col: colPath.c3 });
    ok('列存 SUM 与行存一致（无浮点/3VL 偏差）',
        colPath.s1 === rowPath.s1, { row: rowPath.s1, col: colPath.s1 });
    // 列存转换后写入 → 缓存失效，仍与行存一致
    await q("INSERT INTO t (id,v,n) VALUES (4,NULL,40)");
    ok('列存写入后缓存失效，NULL 计数仍与行存一致',
        (await q('SELECT COUNT(*) AS c FROM t WHERE v = NULL'))[0][0] === 0, null);

    // ================= #254 PG Describe/Close 名称解析 =================
    {
        const conn = Object.create(PgConnection.prototype);
        const body = Buffer.concat([Buffer.from('S'), Buffer.from('s1\0', 'utf8')]);
        const name = body.toString('utf8', 1, conn._cstringLen(body, 1));
        ok("PG Describe 解析出的语句名是 's1'（不是 's'）", name === 's1', name);
        const body1 = Buffer.concat([Buffer.from('S'), Buffer.from('s\0', 'utf8')]);
        const name1 = body1.toString('utf8', 1, conn._cstringLen(body1, 1));
        ok("PG Describe 单字符名 's' 解析正确（不是空串）", name1 === 's', name1);
    }

    // ================= #268 AUTO_INCREMENT 显式插 0 =================
    await q('CREATE TABLE au (id INT PRIMARY KEY AUTO_INCREMENT, v INT)');
    await q('INSERT INTO au (id, v) VALUES (0, 1)');
    await q('INSERT INTO au (id, v) VALUES (NULL, 2)');
    await q('INSERT INTO au (v) VALUES (3)');
    const auRows = await q('SELECT id, v FROM au ORDER BY id');
    ok('AUTO_INCREMENT 列插 0 → 分配序列值 1（不出现 id=0）',
        auRows[0][0] === 1, auRows[0]);
    ok('AUTO_INCREMENT 列插 NULL → 分配序列值 2',
        auRows[1][0] === 2, auRows[1]);
    ok('AUTO_INCREMENT 列不提供 → 分配序列值 3',
        auRows[2][0] === 3, auRows[2]);
    ok('AUTO_INCREMENT 序列无 id=0 的行',
        !auRows.some(r => r[0] === 0), auRows);
    // 批量路径
    await q('CREATE TABLE au2 (id INT PRIMARY KEY AUTO_INCREMENT, v INT)');
    await q('INSERT INTO au2 (id,v) VALUES (0,1),(NULL,2),(0,3)');
    const au2Rows = await q('SELECT id FROM au2 ORDER BY id');
    ok('批量插入里多个 0 也各自分配序列值',
        JSON.stringify(au2Rows.map(r => r[0])) === '[1,2,3]', au2Rows);
    // 不回归：显式非零 id 仍保留
    await q('CREATE TABLE au3 (id INT PRIMARY KEY AUTO_INCREMENT, v INT)');
    await q('INSERT INTO au3 (id,v) VALUES (10,1)');
    ok('显式非零 AUTO_INCREMENT 值仍保留',
        (await q('SELECT id FROM au3'))[0][0] === 10, null);

    // ================= #269 INSERT IGNORE =================
    await q('CREATE TABLE ig (id INT PRIMARY KEY, a INT CHECK (a > 0))');
    let r = await executeSQL(db, 'INSERT IGNORE INTO ig VALUES (1, -5)', { safety: false });
    ok('INSERT IGNORE 遇 CHECK 违反不报错',
        r && r.ok === true, r && r.ok);
    ok('INSERT IGNORE 违反 CHECK 的行被跳过',
        (await q('SELECT * FROM ig')).length === 0, await q('SELECT * FROM ig'));
    ok('INSERT IGNORE 返回 warnings', r.warnings && r.warnings.length === 1, r.warnings);

    r = await executeSQL(db, 'INSERT IGNORE INTO ig VALUES (1, -5), (3, 5)', { safety: false });
    ok('INSERT IGNORE 混合批次：坏行跳过、好行插入',
        JSON.stringify(await q('SELECT * FROM ig')) === '[[3,5]]', await q('SELECT * FROM ig'));
    ok('INSERT IGNORE 混合批次返回 1 条 warning',
        r.warnings && r.warnings.length === 1, r.warnings);

    // 不回归：普通 INSERT 遇 CHECK 违反仍抛错
    let igErr = null;
    try { await q('INSERT INTO ig VALUES (9, -1)'); } catch (e) { igErr = e; }
    ok('普通 INSERT 遇 CHECK 违反仍抛 3819',
        igErr && igErr.code === 3819, igErr && igErr.code);

    // ================= #253 mysql_compat 多语句结果集 =================
    {
        const { createConnection } = require(path.join(ROOT, 'index.js'));
        const conn = createConnection({ multipleStatements: true });
        await conn.connect();
        const res = await conn.query('SELECT 1 AS x; SELECT 2 AS y');
        ok('mysql_compat 多语句返回数组（不是混合对象）', Array.isArray(res), typeof res);
        ok('mysql_compat 多语句返回 2 个结果集', Array.isArray(res) && res.length === 2, res && res.length);
        const first = res && res[0] && (res[0].rows || res[0][0]);
        const second = res && res[1] && (res[1].rows || res[1][0]);
        ok('第一个结果集 {x:1} 未丢失',
            JSON.stringify(first) === JSON.stringify([{ x: 1 }]), first);
        ok('第二个结果集 {y:2} 正确',
            JSON.stringify(second) === JSON.stringify([{ y: 2 }]), second);
        await conn.end();
    }

    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail === 0 ? 0 : 1);
})().catch(e => {
    console.log('[FAIL] unexpected exception: ' + (e.stack || e).split('\n').slice(0, 4).join('\n'));
    process.exit(1);
});
