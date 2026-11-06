/*
 * Regression tests for issue #38.
 *   node test/issue-38.test.js
 *
 * #38 INTEGER / INT / BIGINT 列无法保存 > 2^53 的整数：
 *     · SQL 路径抛 ER_TRUNCATED_WRONG_VALUE (1292)
 *     · 编程式 API 静默截断成 53 位浮点（最危险）
 *
 * 修复后的约定：
 *     · BigInt / 十进制字符串 → 精确入库，安全范围内仍以 number 返回；
 *     · 超出 2^53 的值以 BigInt 保存，持久化格式是 8 字节有符号整数；
 *     · 调用方直接传「已经丢精度」的 unsafe number → 明确报 1292，不静默截断；
 *     · SQL 与 API 对越界值给出一致的 1292。
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const ROOT = path.join(__dirname, '..');

let passed = 0, failed = 0;
function ok(name, cond, extra) {
    if (cond) { passed++; console.log('[OK]', name); }
    else { failed++; console.log('[FAIL]', name, extra !== undefined ? JSON.stringify(extra, (k, v) => typeof v === 'bigint' ? v.toString() + 'n' : v) : ''); }
}

// 所有测试共用独立临时目录，结束后清理
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jsql-i38-'));
process.on('exit', () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) { } });

function tmpPath(name) { return path.join(TMP, name); }
function fresh(name, opts) {
    const p = tmpPath(name);
    try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) { }
    return p;
}

function codeOf(e) { return e && (e.code !== undefined ? e.code : (e.details && e.details.code)); }

async function makeDb() {
    const Database = require(path.join(ROOT, 'lib', 'database'));
    const db = new Database(':memory:');
    await db.createTable('big', {
        id: { type: 'integer', primaryKey: true, autoIncrement: true },
        v: { type: 'bigint' }
    });
    return db;
}

/* ---------- 编程式 API 路径 ---------- */
async function testApi() {
    const db = await makeDb();
    const t = db.big;

    // 1. BigInt 精确保存
    const r1 = t.insert({ v: 9223372036854775807n });
    ok('#38 API BigInt int64 max stored exactly', r1.v === 9223372036854775807n, r1);

    // 2. 十进制字符串精确保存（>2^53）
    const r2 = t.insert({ v: '9007199254740993' });
    ok('#38 API numeric string >2^53 stored exactly', r2.v === 9007199254740993n, r2);
    ok('#38 API numeric string is not rounded to 9007199254740992', r2.v !== 9007199254740992, r2.v);

    // 3. unsafe number 明确报错，不静默截断
    let threw = null;
    try { t.insert({ v: 9007199254740993 }); } catch (e) { threw = e; }
    ok('#38 API unsafe number throws 1292', threw && codeOf(threw) === 1292, threw && threw.message);
    ok('#38 API unsafe number does not insert a rounded row', t.count() === 2, t.count());

    // 4. 超出 int64 报 1292（持久化是 8 字节整数，不能回绕）
    threw = null;
    try { t.insert({ v: '9223372036854775808' }); } catch (e) { threw = e; }
    ok('#38 API string beyond int64 throws 1292', threw && codeOf(threw) === 1292, threw && threw.message);

    // 5. 安全范围内的 number 保持旧行为（number，不是 BigInt）
    const r3 = t.insert({ v: 42 });
    ok('#38 API safe number stays number', typeof r3.v === 'number' && r3.v === 42, typeof r3.v);

    // 6. 更新路径同样精确
    t.update({ id: r2.id }, { v: '9223372036854775806' });
    ok('#38 API update accepts decimal string exactly', t.findById(r2.id).v === 9223372036854775806n, t.findById(r2.id).v);

    // 7. 过滤条件用 BigInt 可以命中（索引/快路径不受影响）
    const hit = t.find({ v: 9223372036854775807n });
    ok('#38 API filter with BigInt matches', hit.length === 1 && hit[0].id === r1.id, hit);

    // 8. 非法值仍然报错
    threw = null;
    try { t.insert({ v: 1.5 }); } catch (e) { threw = e; }
    ok('#38 API float into bigint column throws 1292', threw && codeOf(threw) === 1292);
    threw = null;
    try { t.insert({ v: true }); } catch (e) { threw = e; }
    ok('#38 API boolean into bigint column throws 1292', threw && codeOf(threw) === 1292);

    // 9. 负数边界
    const r4 = t.insert({ v: -9223372036854775808n });
    ok('#38 API int64 min stored exactly', r4.v === -9223372036854775808n, r4);
}

/* ---------- SQL 路径 ---------- */
async function testSql() {
    const db = await makeDb();

    // INSERT 十进制字面量（>2^53）不再报 1292
    const ins = await db.query('INSERT INTO big (v) VALUES (9007199254740993), (9223372036854775807)');
    ok('#38 SQL insert >2^53 literals succeed', ins.ok === true && ins.affectedRows === 2, ins);

    // SELECT 输出为精确十进制字符串（BigInt 无法 JSON 序列化，输出层转字符串）
    const sel = await db.query('SELECT v FROM big ORDER BY v');
    ok('#38 SQL select keeps exact digits', sel.rows[0][0] === '9007199254740993', sel.rows);
    ok('#38 SQL select int64 max exact', sel.rows[1][0] === '9223372036854775807', sel.rows);

    // 底层行仍是 BigInt（不是字符串），与 API 一致
    const raw = db.big.find({});
    ok('#38 SQL insert stores BigInt in row', raw[0].v === 9007199254740993n, raw[0].v);

    // WHERE = 字面量：下推过滤不能把 BigInt 转成 number
    const eq = await db.query('SELECT v FROM big WHERE v = 9007199254740993');
    ok('#38 SQL WHERE = large literal matches', eq.rows.length === 1 && eq.rows[0][0] === '9007199254740993', eq.rows);

    // WHERE = 参数（参数内联成字符串，仍需精确比较）
    const eqp = await db.query('SELECT v FROM big WHERE v = ?', [9007199254740993n]);
    ok('#38 SQL WHERE = BigInt param matches', eqp.rows.length === 1 && eqp.rows[0][0] === '9007199254740993', eqp.rows);

    // 算术保持精度
    const plus = await db.query('SELECT v + 1 AS x FROM big WHERE v = 9007199254740993');
    ok('#38 SQL v + 1 exact', plus.rows[0][0] === '9007199254740994', plus.rows);

    // 16 进制字面量同样精确（0x20000000000001 = 9007199254740993）
    await db.query('DELETE FROM big WHERE id > 0');
    const hex = await db.query("INSERT INTO big (v) VALUES (0x20000000000001)");
    ok('#38 SQL hex literal insert succeeds', hex.ok === true, hex);
    const hexSel = await db.query('SELECT v FROM big');
    ok('#38 SQL hex literal keeps precision', hexSel.rows[0][0] === '9007199254740993', hexSel.rows);
    const hexQ = await db.query("INSERT INTO big (v) VALUES (X'7FFFFFFFFFFFFFFF')");
    ok("#38 SQL X'' literal insert succeeds", hexQ.ok === true, hexQ);

    // 越界：SQL 与 API 都报 1292
    let sqlErr = null;
    try { await db.query('INSERT INTO big (v) VALUES (9223372036854775808)'); } catch (e) { sqlErr = e; }
    ok('#38 SQL beyond int64 throws 1292', sqlErr && codeOf(sqlErr) === 1292, sqlErr && sqlErr.message);

    // SQL 与 API 对 unsafe number 的错误码一致
    let apiErr = null;
    try { db.big.insert({ v: 9223372036854775807 }); } catch (e) { apiErr = e; }
    ok('#38 SQL and API error codes agree (1292)',
        sqlErr && apiErr && codeOf(sqlErr) === codeOf(apiErr) && codeOf(apiErr) === 1292,
        { sql: codeOf(sqlErr), api: codeOf(apiErr) });

    // 小数/非整数字符串仍拒绝
    let e2 = null;
    try { await db.query("INSERT INTO big (v) VALUES ('1.5')"); } catch (e) { e2 = e; }
    ok('#38 SQL non-integer string rejected', e2 && codeOf(e2) === 1292);
}

/* ---------- 持久化（.jsql / JSON / dir 模式） ---------- */
async function testPersistence() {
    const Database = require(path.join(ROOT, 'lib', 'database'));

    // .jsql 单文件（I64 编码）
    {
        const p = fresh('big.jsql');
        let db = new Database(p);
        await db.createTable('big', {
            id: { type: 'integer', primaryKey: true, autoIncrement: true },
            v: { type: 'bigint' }
        });
        db.big.insert({ v: 9223372036854775807n });
        db.big.insert({ v: -9223372036854775808n });
        db.save();

        db = new Database(p);
        const rows = db.big.find({}).sort((a, b) => (a.v < b.v ? -1 : 1));
        ok('#38 .jsql persistence keeps int64 min/max',
            rows.length === 2 && rows[0].v === -9223372036854775808n && rows[1].v === 9223372036854775807n, rows);
    }

    // 单文件 JSON（bigint_json 标记往返）
    {
        const p = fresh('big.json');
        let db = new Database(p);
        await db.createTable('big', {
            id: { type: 'integer', primaryKey: true, autoIncrement: true },
            v: { type: 'bigint' }
        });
        db.big.insert({ v: '9007199254740993' });
        db.save();

        db = new Database(p);
        ok('#38 JSON persistence keeps >2^53 exactly', db.big.find({})[0].v === 9007199254740993n, db.big.find({}));
    }

    // dir 模式（disk）逐表 .jsql
    {
        const dir = fresh('big-dir');
        fs.mkdirSync(dir, { recursive: true });
        let db = new Database(dir, { mode: 'disk' });
        await db.createTable('big', {
            id: { type: 'integer', primaryKey: true, autoIncrement: true },
            v: { type: 'bigint' }
        });
        db.big.insert({ v: 9007199254740993n });
        db.save();

        db = new Database(dir, { mode: 'disk' });
        ok('#38 dir-mode persistence keeps >2^53 exactly', db.big.find({})[0].v === 9007199254740993n, db.big.find({}));
    }
}

/* ---------- BigInt 与事务 / 统计 / 备份 ---------- */
async function testBigIntJsonPaths() {
    const Database = require(path.join(ROOT, 'lib', 'database'));

    // REPEATABLE_READ 事务快照（内部 JSON 深拷贝）不能因 BigInt 抛错
    {
        const db = await makeDb();
        db.big.insert({ v: 9007199254740993n });
        db.begin('REPEATABLE_READ');
        db.big.insert({ v: 9223372036854775807n });
        db.rollback();
        const rows = db.big.find({});
        ok('#38 tx snapshot/rollback with BigInt works', rows.length === 1 && rows[0].v === 9007199254740993n, rows);
    }

    // stats() 里的 JSON.stringify 不能因 BigInt 抛错
    {
        const db = await makeDb();
        db.big.insert({ v: 9007199254740993n });
        let threw = null, st = null;
        try { st = db.stats(); } catch (e) { threw = e; }
        ok('#38 stats() tolerates BigInt rows', !threw && st && st.tableStats && st.tableStats.big && st.tableStats.big.rowCount === 1 && st.tableStats.big.sizeEstimate > 0,
            threw ? threw.message : st && st.tableStats);
    }

    // backup/restore 往返
    {
        const db = await makeDb();
        db.big.insert({ v: '9007199254740993' });
        const bak = tmpPath('backup.json');
        db.backup(bak);
        db.big.remove({});
        db.restore(bak);
        ok('#38 backup/restore keeps >2^53 exactly', db.big.find({})[0].v === 9007199254740993n, db.big.find({}));
    }
}

/* ---------- 回归：普通类型不受影响 ---------- */
async function testNoRegression() {
    const Database = require(path.join(ROOT, 'lib', 'database'));
    const db = new Database(':memory:');
    await db.createTable('t', {
        id: { type: 'integer', primaryKey: true, autoIncrement: true },
        n: { type: 'integer' },
        f: { type: 'float' },
        s: { type: 'string' }
    });
    db.t.insert({ n: 42, f: 1.5, s: 'hello' });
    db.t.insert({ n: '43', f: '2.5', s: 7 });
    const rows = db.t.find({});
    ok('#38 regression integer/float/string coercion intact',
        rows.length === 2 && rows[0].n === 42 && rows[1].n === 43 && rows[1].f === 2.5 && rows[1].s === '7', rows);
    ok('#38 regression integer still rejects 1.5', (() => {
        try { db.t.insert({ n: 1.5 }); return false; } catch (e) { return codeOf(e) === 1292; }
    })());
}

/* ---------- Rust 绑定层（wasm/native）与 JS 引擎一致 ---------- */
async function testRustBindings() {
    async function roundTrip(label, Client, opts) {
        let db;
        try {
            db = new Client(opts);
            await db.start();
        } catch (e) {
            console.log(`[SKIP] #38 ${label} binding unavailable:`, e && e.message);
            return;
        }
        try {
            await db.createTable('big', {
                id: { type: 'integer', primaryKey: true, autoIncrement: true },
                v: { type: 'bigint' }
            });
            await db.insert('big', { v: 9223372036854775807n });
            await db.insert('big', { v: -9223372036854775808n });
            await db.insert('big', { v: '9007199254740993' });

            const rows = await db.find('big', {});
            ok(`#38 ${label} insert BigInt/string roundtrip`,
                rows.length === 3 && rows[0].v === 9223372036854775807n &&
                rows[1].v === -9223372036854775808n && rows[2].v === 9007199254740993n, rows);

            const hit = await db.find('big', { v: 9223372036854775807n });
            ok(`#38 ${label} filter by BigInt`, hit.length === 1 && hit[0].v === 9223372036854775807n, hit);

            const hitStr = await db.find('big', { v: '9007199254740993' });
            ok(`#38 ${label} filter by large integer string`,
                hitStr.length === 1 && hitStr[0].v === 9007199254740993n, hitStr);

            await db.updateById('big', rows[0].id, { v: 9007199254740993n });
            const updated = await db.findById('big', rows[0].id);
            ok(`#38 ${label} update by BigInt`, updated && updated.v === 9007199254740993n, updated);

            let err = null;
            try { await db.insert('big', { v: 9223372036854775808n }); } catch (e) { err = e; }
            ok(`#38 ${label} beyond int64 throws 1292`, err && codeOf(err) === 1292, err && err.message);
        } finally {
            try { await db.stop(); } catch (_) { }
        }
    }

    const { JSQL: WasmClient } = require(path.join(ROOT, 'lib', 'wasm_client'));
    await roundTrip('wasm', WasmClient, { modules: false });

    const native = require(path.join(ROOT, 'lib', 'native_client'));
    if (native._nativeAvailable) {
        await roundTrip('native', native.JSQL, { modules: false, path: null });
    } else {
        console.log('[SKIP] #38 native binding unavailable (stub mode)');
    }
}

(async () => {
    try {
        await testApi();
        await testSql();
        await testPersistence();
        await testBigIntJsonPaths();
        await testNoRegression();
        await testRustBindings();
    } catch (e) {
        failed++;
        console.log('[FAIL] unexpected exception:', e && e.stack || e);
    }
    console.log(`\n${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
})();
