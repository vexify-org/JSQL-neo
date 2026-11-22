/* ---- 回归：#284 / #285 / #291 / #292 (+ #290 位运算) ---- */
/*
 * #284 Mongo BSON 编码把所有整数都写成 Double(0x01)，从不写 Int32(0x10)。
 * #285 Mongo BSON Binary(0x05) 编码多写一个 subtype 字节，往返损坏错位。
 * #291 GROUP BY 键未做 SQL 类型归一：数字 1 与字符串 '1' 被拆成两个组。
 * #292 ORDER BY 混合 number/string 时退化为字典序，数值顺序排错。
 * #290 位非 `~` 按 32 位有符号整数取反，与 MySQL 的 64 位无符号语义不符。
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
                try { resolve({ raw: buf, doc: bsonReadDocument(buf.slice(21), 0).value }); }
                catch (e) { reject(e); }
                sock.end();
            }
        });
    });
}

(async () => {
    // ================= #284 BSON 整数类型 =================
    const enc = bsonDocument({ n: 30 });
    const hex = enc.toString('hex');
    // size(4) + type(1) + 'n'(2) + int32(4)
    ok("编码 {n:30} 用 Int32（type byte 0x10）", hex.includes('106e00'), hex);
    ok("Int32 只占 4 字节（文档总长 12）", enc.readInt32LE(0) === 12, enc.readInt32LE(0));

    const encF = bsonDocument({ n: 2.5 });
    ok("浮点仍用 Double（type byte 0x01）", encF.toString('hex').includes('016e00'), encF.toString('hex'));

    const encBig = bsonDocument({ n: 3000000000 });
    ok("超 int32 范围用 Int64（type byte 0x12）", encBig.toString('hex').includes('126e00'), encBig.toString('hex'));

    // 端到端：线上回包的 type byte
    const msrv = createMongoServer({ dataDir: ':memory:' });
    await new Promise((r) => msrv.listen(r));
    await mongoCall(msrv, { insert: 'it', documents: [{ n: 30 }], $db: 'test' });
    const r1 = await mongoCall(msrv, { find: 'it', filter: {}, $db: 'test' });
    const i1 = r1.raw.indexOf(Buffer.from('n\0'));
    const typeByte = r1.raw.slice(i1 - 1, i1).toString('hex');
    ok('线上回包 n 的 type byte = 10（int32）', typeByte === '10', typeByte);
    ok('回读值仍是 30', r1.doc.cursor.firstBatch[0].n === 30, r1.doc.cursor.firstBatch[0].n);

    // ================= #285 BSON Binary 往返 =================
    const orig = Buffer.from([1, 2, 3, 4]);
    const bEnc = bsonDocument({ data: orig });
    const bHex = bEnc.toString('hex');
    // size(4) + type(1) + 'data\0'(5) + len(4) + subtype(1) + data(4) + 结束符(1) = 20
    ok('Binary 编码长度正确（20 字节）', bEnc.readInt32LE(0) === 20, bEnc.readInt32LE(0));
    ok('Binary 只写 1 个 subtype 字节', /05646174610004000000 00 01020304/.test(bHex.replace(/ /g, ''))
        || bHex.includes('056461746100040000000001020304'), bHex);
    const bDec = bsonReadDocument(bEnc, 0).value;
    ok('Binary 往返逐字节相等', Buffer.from(bDec.data).equals(orig), Buffer.from(bDec.data));

    // 多字段文档：Binary 之后的字段不能解析失步
    const multi = bsonDocument({ data: orig, tail: 7 });
    const mDec = bsonReadDocument(multi, 0).value;
    ok('Binary 之后的字段仍能正确解析', mDec.tail === 7, mDec);
    ok('多字段文档里 Binary 数据完好', Buffer.from(mDec.data).equals(orig), Buffer.from(mDec.data));

    // 端到端往返
    await mongoCall(msrv, { insert: 'bin', documents: [{ _id: 'b', data: orig }], $db: 'test' });
    const r2 = await mongoCall(msrv, { find: 'bin', filter: {}, $db: 'test' });
    const got = Buffer.from(r2.doc.cursor.firstBatch[0].data);
    ok('服务端往返二进制数据完好', got.equals(orig), got);

    msrv.close();

    // ================= #291 GROUP BY 键归一 =================
    const db = new Database(':memory:', { autoSave: false });
    const q = async (sql) => (await executeSQL(db, sql, { safety: false })).rows;

    await q('CREATE TABLE m (k TEXT, v INT)');
    await q("INSERT INTO m VALUES ('1',10),(1,20),('2',30),(2,40)");
    const grouped = await q('SELECT k, COUNT(*), SUM(v) FROM m GROUP BY k ORDER BY k');
    ok("GROUP BY 把 '1' 与 1 合并成 1 组", grouped.length === 2, grouped);
    ok("GROUP BY '1' 组 COUNT=2, SUM=30",
        JSON.stringify(grouped[0]) === JSON.stringify(['1', 2, 30]), grouped);
    ok("GROUP BY '2' 组 COUNT=2, SUM=70",
        JSON.stringify(grouped[1]) === JSON.stringify(['2', 2, 70]), grouped);

    // 纯数值分组不回归
    await q('CREATE TABLE m2 (k INT, v INT)');
    await q('INSERT INTO m2 VALUES (1,10),(1,20),(2,30)');
    const g2 = await q('SELECT k, COUNT(*), SUM(v) FROM m2 GROUP BY k ORDER BY k');
    ok('纯数值 GROUP BY 不回归',
        JSON.stringify(g2) === JSON.stringify([[1, 2, 30], [2, 1, 30]]), g2);

    // ================= #292 ORDER BY 混合类型 =================
    await q('CREATE TABLE s (k TEXT)');
    await q("INSERT INTO s VALUES ('10'),(2),('1')");
    const ordered = await q('SELECT k FROM s ORDER BY k');
    const keys = ordered.map(r => r[0]);
    ok("ORDER BY 混合类型按数值排序：1, 2, 10",
        keys.length === 3 && Number(keys[0]) === 1 && Number(keys[1]) === 2 && Number(keys[2]) === 10, keys);

    // 纯字符串排序仍按字典序
    await q('CREATE TABLE s2 (k TEXT)');
    await q("INSERT INTO s2 VALUES ('b'),('a'),('c')");
    const o2 = await q('SELECT k FROM s2 ORDER BY k');
    ok('纯字符串 ORDER BY 仍按字典序',
        JSON.stringify(o2.map(r => r[0])) === JSON.stringify(['a', 'b', 'c']), o2);

    // 非数字字符串仍按字典序（不能被误当数值）
    await q('CREATE TABLE s3 (k TEXT)');
    await q("INSERT INTO s3 VALUES ('b'),('10'),('a')");
    const o3 = await q('SELECT k FROM s3 ORDER BY k');
    ok("非数字字符串仍按字典序（'10' < 'a' < 'b'）",
        JSON.stringify(o3.map(r => r[0])) === JSON.stringify(['10', 'a', 'b']), o3);

    // ================= #290 位运算 64 位无符号 =================
    const one = async (sql) => (await q(sql))[0][0];
    ok("~0 = 18446744073709551615（MySQL 64 位无符号）",
        String(await one('SELECT ~0')) === '18446744073709551615', null);
    ok("~5 = 18446744073709551610",
        String(await one('SELECT ~5')) === '18446744073709551610', null);
    ok('5 & ~1 = 4', await one('SELECT 5 & ~1') === 4, null);
    ok('12 & 10 = 8', await one('SELECT 12 & 10') === 8, null);
    ok('12 | 10 = 14', await one('SELECT 12 | 10') === 14, null);
    ok('12 ^ 10 = 6', await one('SELECT 12 ^ 10') === 6, null);
    ok('1 << 63 仍是精确 BigInt',
        String(await one('SELECT 1 << 63')) === '9223372036854775808', null);

    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail === 0 ? 0 : 1);
})().catch(e => {
    console.log('[FAIL] unexpected exception: ' + (e.stack || e).split('\n').slice(0, 4).join('\n'));
    process.exit(1);
});
