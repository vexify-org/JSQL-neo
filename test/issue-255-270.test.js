/* ---- 回归：#255 / #256 / #257 / #266 / #270 ---- */
/*
 * #255 Mongo insert 忽略 ordered 标志：ordered:true 遇重复键后仍继续插入后续文档。
 * #256 FROM_UNIXTIME(NULL) 返回 1970-01-01 00:00:00 而非 NULL（NULL 未传播）。
 * #257 UNIX_TIMESTAMP(NULL) 返回当前时间戳而非 NULL（无参分支被误用）。
 * #266 列类型 DECIMAL(p,s) 的标度在写入时完全不生效。
 * #270 向 INT 列写 1.9 直接抛 1292，MySQL 会四舍五入成 2。
 */
const path = require('path');
const net = require('net');
const ROOT = path.join(__dirname, '..');
const { Database, executeSQL } = require(path.join(ROOT, 'index.js'));
const { createMongoServer, bsonDocument, bsonReadDocument } = require(path.join(ROOT, 'lib/mongo_server.js'));

let pass = 0, fail = 0;
function ok(name, cond, got) {
    if (cond) { pass++; console.log('[OK]   ' + name); }
    else { fail++; console.log('[FAIL] ' + name + ' -> ' + JSON.stringify(got)); }
}

function mongoOpMsg(doc) {
    const p = bsonDocument(doc);
    const h = Buffer.alloc(16);
    h.writeInt32LE(16 + 4 + 1 + p.length, 0);
    h.writeInt32LE(1, 4); h.writeInt32LE(0, 8); h.writeInt32LE(2013, 12);
    return Buffer.concat([h, Buffer.alloc(4), Buffer.from([0]), p]);
}
function mongoCall(srv, doc) {
    return new Promise((resolve, reject) => {
        const sock = net.connect(srv._server.address().port, '127.0.0.1', () => sock.write(mongoOpMsg(doc)));
        const chunks = [];
        sock.on('error', reject);
        sock.on('data', (c) => {
            chunks.push(c);
            const buf = Buffer.concat(chunks);
            if (buf.length >= 16 && buf.length >= buf.readInt32LE(0)) {
                try { resolve(bsonReadDocument(buf.slice(21), 0).value); }
                catch (e) { reject(e); }
                sock.end();
            }
        });
    });
}

(async () => {
    const db = new Database(':memory:', { autoSave: false });
    const q = async (sql) => (await executeSQL(db, sql, { safety: false })).rows;
    const one = async (sql) => (await q(sql))[0][0];

    // ================= #255 Mongo ordered =================
    {
        const srv = createMongoServer({ dataDir: ':memory:' });
        await new Promise((r) => srv.listen(r));
        await mongoCall(srv, { insert: 'od', documents: [{ _id: 'a', v: 1 }], $db: 'test' });
        const rep = await mongoCall(srv, {
            insert: 'od', ordered: true,
            documents: [{ _id: 'b', v: 2 }, { _id: 'a', v: 9 }, { _id: 'c', v: 3 }],
            $db: 'test',
        });
        const all = await mongoCall(srv, { find: 'od', filter: {}, $db: 'test' });
        const ids = (all.cursor.firstBatch || []).map(x => x._id);
        ok('ordered:true 冲突后不再插入后续文档', ids.length === 2 && !ids.includes('c'), ids);
        ok('ordered:true 回复 n 只统计实际写入数', rep.n === 1, rep.n);
        ok('ordered:true 仍报告 writeErrors', rep.writeErrors && rep.writeErrors.length === 1, rep.writeErrors);

        // ordered:false 应继续逐条尝试
        await mongoCall(srv, { insert: 'od2', documents: [{ _id: 'x', v: 1 }], $db: 'test' });
        const rep2 = await mongoCall(srv, {
            insert: 'od2', ordered: false,
            documents: [{ _id: 'x', v: 2 }, { _id: 'y', v: 3 }],
            $db: 'test',
        });
        const all2 = await mongoCall(srv, { find: 'od2', filter: {}, $db: 'test' });
        const ids2 = (all2.cursor.firstBatch || []).map(x => x._id);
        ok('ordered:false 冲突后仍继续插入后续文档',
            ids2.includes('x') && ids2.includes('y'), ids2);
        // 本批 2 条：'x' 重复失败、'y' 成功 → n = 1
        ok('ordered:false 回复 n 统计本批成功数', rep2.n === 1, rep2.n);
        ok('ordered:false 仍报告 writeErrors',
            rep2.writeErrors && rep2.writeErrors.length === 1, rep2.writeErrors);
        srv.close();
    }

    // ================= #256 FROM_UNIXTIME NULL =================
    ok('FROM_UNIXTIME(NULL) = NULL', await one('SELECT FROM_UNIXTIME(NULL)') === null, null);
    ok('FROM_UNIXTIME(NULL) IS NULL 为真',
        await one('SELECT FROM_UNIXTIME(NULL) IS NULL') === 1, null);
    ok('FROM_UNIXTIME(0) 仍是 1970-01-01 00:00:00（不回归）',
        await one('SELECT FROM_UNIXTIME(0)') === '1970-01-01 00:00:00', null);
    ok('FROM_UNIXTIME(NULL, "%Y") 也是 NULL',
        await one("SELECT FROM_UNIXTIME(NULL, '%Y')") === null, null);

    // ================= #257 UNIX_TIMESTAMP NULL =================
    ok('UNIX_TIMESTAMP(NULL) = NULL', await one('SELECT UNIX_TIMESTAMP(NULL)') === null, null);
    ok('UNIX_TIMESTAMP(NULL) IS NULL 为真',
        await one('SELECT UNIX_TIMESTAMP(NULL) IS NULL') === 1, null);
    const nowTs = await one('SELECT UNIX_TIMESTAMP()');
    ok('UNIX_TIMESTAMP() 无参仍返回当前时间戳',
        typeof nowTs === 'number' && Math.abs(nowTs - Math.floor(Date.now() / 1000)) < 5, nowTs);
    ok("UNIX_TIMESTAMP('1970-01-01 00:00:00') = 0（不回归）",
        await one("SELECT UNIX_TIMESTAMP('1970-01-01 00:00:00')") === 0, null);

    // ================= #266 DECIMAL 标度 =================
    await q('CREATE TABLE dc (id INT PRIMARY KEY, d DECIMAL(10,2))');
    await q('INSERT INTO dc VALUES (1, 1.005)');
    await q('INSERT INTO dc VALUES (2, 123.456)');
    await q('INSERT INTO dc VALUES (3, 2.675)');
    const dcRows = await q('SELECT id, d FROM dc ORDER BY id');
    ok('DECIMAL(10,2) 把 1.005 舍入成 1.01', dcRows[0][1] === 1.01, dcRows[0]);
    ok('DECIMAL(10,2) 把 123.456 舍入成 123.46', dcRows[1][1] === 123.46, dcRows[1]);
    ok('DECIMAL(10,2) 把 2.675 舍入成 2.68（半远离零，无浮点误差）', dcRows[2][1] === 2.68, dcRows[2]);
    const mul = await q('SELECT d * 100 FROM dc ORDER BY id');
    ok('DECIMAL 乘法无浮点误差（101 / 12346 / 268）',
        JSON.stringify(mul.map(r => r[0])) === JSON.stringify([101, 12346, 268]), mul);
    // 不回归：普通 number 列不受影响
    await q('CREATE TABLE nf (id INT PRIMARY KEY, n FLOAT)');
    await q('INSERT INTO nf VALUES (1, 1.005)');
    ok('FLOAT 列不受 DECIMAL 标度影响',
        (await q('SELECT n FROM nf'))[0][0] === 1.005, await q('SELECT n FROM nf'));

    // ================= #270 向 INT 列写小数 =================
    await q('CREATE TABLE n (id INT PRIMARY KEY, i INT)');
    await q('INSERT INTO n VALUES (1, 1.9)');
    await q('INSERT INTO n VALUES (2, 1.4)');
    await q('INSERT INTO n VALUES (3, -1.5)');
    const intRows = await q('SELECT id, i FROM n ORDER BY id');
    ok('向 INT 列写 1.9 舍入成 2', intRows[0][1] === 2, intRows[0]);
    ok('向 INT 列写 1.4 舍入成 1', intRows[1][1] === 1, intRows[1]);
    ok('向 INT 列写 -1.5 舍入成 -2（半远离零）', intRows[2][1] === -2, intRows[2]);
    // 不回归：整数值与字符串整数字面量
    await q('INSERT INTO n VALUES (4, 7)');
    await q("INSERT INTO n VALUES (5, '8')");
    ok('整数值不回归', (await q('SELECT i FROM n WHERE id=4'))[0][0] === 7, null);
    ok('整数字符串不回归', (await q('SELECT i FROM n WHERE id=5'))[0][0] === 8, null);
    // 不回归：非数字字符串仍报错
    let strErr = null;
    try { await q("INSERT INTO n VALUES (6, 'abc')"); } catch (e) { strErr = e; }
    ok('非数字字符串写 INT 列仍报 1292', !!strErr, strErr && strErr.message);

    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail === 0 ? 0 : 1);
})().catch(e => {
    console.log('[FAIL] unexpected exception: ' + (e.stack || e).split('\n').slice(0, 4).join('\n'));
    process.exit(1);
});
