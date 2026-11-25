/* ---- 回归：#312 / #313 / #315 / #316 / #320 ---- */
/*
 * #312 Mongo `$group` 的 `$push` / `$addToSet` 累加器静默无效：累加器对象落到
 *      取值链之外，输出文档缺整列。
 * #313 Redis `EXPIRE` 的 NX/XX/GT/LT 条件选项被静默忽略，无条件覆盖已有 TTL
 *      并恒返回 1。
 * #315 Mongo `listIndexes` 对不存在的集合伪造一条 `_id_` 唯一索引并回 ok:1，
 *      未按协议报 nsNotFound(26)。
 * #316 Mongo `find` 负 limit 被忽略，不按绝对值取单批，而是返回全部文档。
 * #320 `encryptKey` 长度不校验：1 字节密钥被空格补齐到 32、48 字节密钥被静默
 *      截断到 32，与文档承诺的 16/24/32 字节不符。
 */
const path = require('path');
const net = require('net');
const fs = require('fs');
const os = require('os');
const ROOT = path.join(__dirname, '..');
const { Database } = require(path.join(ROOT, 'index.js'));
const { createRedisServer } = require(path.join(ROOT, 'lib/redis_server.js'));
const { createMongoServer, bsonDocument, bsonReadDocument } = require(path.join(ROOT, 'lib/mongo_server.js'));

let pass = 0, fail = 0;
function ok(name, cond, got) {
    if (cond) { pass++; console.log('[OK]   ' + name); }
    else { fail++; console.log('[FAIL] ' + name + ' -> ' + JSON.stringify(got)); }
}

// ---------- Mongo 线协议客户端 ----------
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

// ---------- Redis RESP 客户端 ----------
function redisFrame(args) {
    const parts = args.map((a) => { const b = Buffer.from(String(a)); return '$' + b.length + '\r\n' + b + '\r\n'; });
    return Buffer.from('*' + args.length + '\r\n' + parts.join(''));
}

async function main() {
    // ================= #320 encryptKey 长度校验 =================
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsql-key-'));
    const badKeys = ['x', '0123456789abcdef0123456789abcdef0123456789abcdef', 'short'];
    for (const k of badKeys) {
        let threw = null;
        try {
            const d = new Database(path.join(tmpDir, `db-${k.length}.json`), { encryptKey: k, autoSave: false });
            d.close();
        } catch (e) { threw = e; }
        ok(`encryptKey 长度 ${Buffer.byteLength(k)} 字节被拒绝`, !!threw, threw && threw.message);
        ok(`encryptKey 长度 ${Buffer.byteLength(k)} 字节报 ER_INVALID_KEY`,
            threw && threw.code === 'ER_INVALID_KEY', threw && threw.code);
    }
    // 合法长度必须照常工作
    for (const len of [16, 24, 32]) {
        let db = null, threw = null;
        try {
            db = new Database(path.join(tmpDir, `good-${len}.json`), { encryptKey: 'k'.repeat(len), autoSave: false });
        } catch (e) { threw = e; }
        ok(`encryptKey 长度 ${len} 字节被接受`, !threw, threw && threw.message);
        if (db) db.close();
    }
    // 多字节 UTF-8 按字节计数（不是字符数）
    let utf8Threw = null;
    try {
        const d = new Database(path.join(tmpDir, 'utf8.json'), { encryptKey: '中'.repeat(8), autoSave: false });
        d.close();
    } catch (e) { utf8Threw = e; }
    ok('encryptKey 按字节计数（8 个中文字 = 24 字节）被接受', !utf8Threw, utf8Threw && utf8Threw.message);

    // ================= #313 Redis EXPIRE 条件选项 =================
    const rsrv = createRedisServer({ port: 0, dataDir: null });
    await new Promise((r) => rsrv.listen(r));
    const rsock = net.connect(rsrv.server.address().port, '127.0.0.1');
    await new Promise((r) => rsock.on('connect', r));
    const rchunks = [];
    rsock.on('data', (c) => rchunks.push(c));
    const rsend = async (args) => {
        rchunks.length = 0;
        rsock.write(redisFrame(args));
        await new Promise((r) => setTimeout(r, 100));
        return Buffer.concat(rchunks).toString('utf8');
    };

    await rsend(['SET', 'e', 'x']);
    ok('SET 返回 +OK', (await rsend(['SET', 'e', 'x'])) === '+OK\r\n', null);

    // TTL 是秒级倒计时：EXPIRE 与 TTL 两条命令之间隔着 rsend 的 100ms sleep，
    // 慢 runner 上会跨秒边界（100 → 99）。用 ±2 的区间断言防抖。
    const ttlCloseTo = (reply, n) => {
        const m = /^:(-?\d+)\r\n$/.exec(reply);
        return m !== null && Number(m[1]) >= n - 2 && Number(m[1]) <= n;
    };

    // XX：键无 TTL 时应返回 0 且不设置
    ok('EXPIRE e 100 XX（无 TTL）返回 0', (await rsend(['EXPIRE', 'e', '100', 'XX'])) === ':0\r\n', null);
    ok('EXPIRE e 100 XX 后 TTL 仍为 -1', (await rsend(['TTL', 'e'])) === ':-1\r\n', null);

    // NX：键无 TTL 时应成功
    ok('EXPIRE e 100 NX（无 TTL）返回 1', (await rsend(['EXPIRE', 'e', '100', 'NX'])) === ':1\r\n', null);
    ok('EXPIRE e 100 NX 后 TTL = 100', ttlCloseTo(await rsend(['TTL', 'e']), 100), null);

    // NX：键已有 TTL 时应返回 0
    ok('EXPIRE e 200 NX（已有 TTL）返回 0', (await rsend(['EXPIRE', 'e', '200', 'NX'])) === ':0\r\n', null);
    ok('EXPIRE e 200 NX 后 TTL 未变', ttlCloseTo(await rsend(['TTL', 'e']), 100), null);

    // XX：键已有 TTL 时应成功
    ok('EXPIRE e 300 XX（已有 TTL）返回 1', (await rsend(['EXPIRE', 'e', '300', 'XX'])) === ':1\r\n', null);
    ok('EXPIRE e 300 XX 后 TTL = 300', ttlCloseTo(await rsend(['TTL', 'e']), 300), null);

    // GT：新 TTL 不大于现有 → 返回 0
    ok('EXPIRE e 100 GT（新 TTL 更小）返回 0', (await rsend(['EXPIRE', 'e', '100', 'GT'])) === ':0\r\n', null);
    ok('EXPIRE e 100 GT 后 TTL 未变', ttlCloseTo(await rsend(['TTL', 'e']), 300), null);

    // GT：新 TTL 大于现有 → 返回 1
    ok('EXPIRE e 400 GT（新 TTL 更大）返回 1', (await rsend(['EXPIRE', 'e', '400', 'GT'])) === ':1\r\n', null);
    ok('EXPIRE e 400 GT 后 TTL = 400', (await rsend(['TTL', 'e'])) === ':400\r\n', null);

    // LT：新 TTL 不小于现有 → 返回 0
    ok('EXPIRE e 400 LT（相等）返回 0', (await rsend(['EXPIRE', 'e', '400', 'LT'])) === ':0\r\n', null);
    ok('EXPIRE e 100 LT（新 TTL 更小）返回 1', (await rsend(['EXPIRE', 'e', '100', 'LT'])) === ':1\r\n', null);

    // 无条件 EXPIRE 仍照常工作
    ok('EXPIRE e 100（无条件）返回 1', (await rsend(['EXPIRE', 'e', '100'])) === ':1\r\n', null);

    // 未知选项必须报语法错误，不能静默忽略
    const badOpt = await rsend(['EXPIRE', 'e', '100', 'ZZ']);
    ok('EXPIRE 未知选项报 ERR syntax error', badOpt.startsWith('-ERR syntax error'), badOpt);

    // 多个条件选项冲突
    const twoOpt = await rsend(['EXPIRE', 'e', '100', 'NX', 'XX']);
    ok('EXPIRE 同时给 NX/XX 报 ERR syntax error', twoOpt.startsWith('-ERR syntax error'), twoOpt);

    rsock.destroy();
    rsrv.stop();

    // ================= Mongo 相关（#312 / #315 / #316）=================
    const msrv = createMongoServer({ dataDir: ':memory:' });
    await new Promise((r) => msrv.listen(r));

    // #315：listIndexes 对不存在的集合必须报 nsNotFound
    const missing = await mongoCall(msrv, { listIndexes: 'nope_coll', $db: 'test' });
    ok('listIndexes 不存在的集合 ok = 0', missing.ok === 0, missing);
    ok('listIndexes 不存在的集合 code = 26（nsNotFound）', missing.code === 26, missing);
    ok('listIndexes 不存在的集合不含 _id_ 索引',
        !missing.cursor || !(missing.cursor.firstBatch || []).length, missing);

    // 存在的集合应正常返回 _id_ 索引
    await mongoCall(msrv, { insert: 'nl', documents: [{ n: 1 }, { n: 2 }, { n: 3 }], $db: 'test' });
    const existing = await mongoCall(msrv, { listIndexes: 'nl', $db: 'test' });
    ok('listIndexes 已存在的集合 ok = 1', existing.ok === 1, existing);
    ok('listIndexes 已存在的集合返回 _id_ 索引',
        (existing.cursor.firstBatch || []).some(i => i.name === '_id_'), existing);

    // #316：负 limit 按绝对值取单批
    const negLimit = await mongoCall(msrv, { find: 'nl', filter: {}, limit: -2, $db: 'test' });
    ok('find limit=-2 只返回 2 条', (negLimit.cursor.firstBatch || []).length === 2, negLimit);
    const negLimit3 = await mongoCall(msrv, { find: 'nl', filter: {}, limit: -3, $db: 'test' });
    ok('find limit=-3 返回 3 条', (negLimit3.cursor.firstBatch || []).length === 3, negLimit3);
    const posLimit = await mongoCall(msrv, { find: 'nl', filter: {}, limit: 1, $db: 'test' });
    ok('find limit=1 返回 1 条（不回归）', (posLimit.cursor.firstBatch || []).length === 1, posLimit);
    const noLimit = await mongoCall(msrv, { find: 'nl', filter: {}, $db: 'test' });
    ok('find 无 limit 返回全部（不回归）', (noLimit.cursor.firstBatch || []).length === 3, noLimit);

    // #312：$group 的 $push / $addToSet
    await mongoCall(msrv, { insert: 'gp', documents: [{ g: 'x', t: 1 }, { g: 'x', t: 2 }, { g: 'y', t: 5 }], $db: 'test' });
    const push = await mongoCall(msrv, {
        aggregate: 'gp', pipeline: [{ $group: { _id: '$g', vals: { $push: '$t' } } }], $db: 'test'
    });
    const pushRows = push.cursor.firstBatch || [];
    const pushX = pushRows.find(r => r._id === 'x');
    const pushY = pushRows.find(r => r._id === 'y');
    ok('$push 输出文档含 vals 字段', pushX && pushX.vals !== undefined, pushRows);
    ok('$push x 组 = [1,2]', Array.isArray(pushX && pushX.vals) && pushX.vals.length === 2
        && pushX.vals[0] === 1 && pushX.vals[1] === 2, pushX);
    ok('$push y 组 = [5]', Array.isArray(pushY && pushY.vals) && pushY.vals.length === 1
        && pushY.vals[0] === 5, pushY);

    const addToSet = await mongoCall(msrv, {
        aggregate: 'gp', pipeline: [{ $group: { _id: '$g', vals: { $addToSet: '$t' } } }], $db: 'test'
    });
    const atsRows = addToSet.cursor.firstBatch || [];
    const atsX = atsRows.find(r => r._id === 'x');
    ok('$addToSet 输出文档含 vals 字段', atsX && atsX.vals !== undefined, atsRows);
    ok('$addToSet x 组 = [1,2]', Array.isArray(atsX && atsX.vals) && atsX.vals.length === 2, atsX);

    // 去重：同一组内插入重复值
    await mongoCall(msrv, { insert: 'gp2', documents: [{ g: 'x', t: 1 }, { g: 'x', t: 1 }, { g: 'x', t: 2 }], $db: 'test' });
    const ats2 = await mongoCall(msrv, {
        aggregate: 'gp2', pipeline: [{ $group: { _id: '$g', vals: { $addToSet: '$t' } } }], $db: 'test'
    });
    const ats2X = (ats2.cursor.firstBatch || []).find(r => r._id === 'x');
    ok('$addToSet 去重后只剩 2 个元素',
        Array.isArray(ats2X && ats2X.vals) && ats2X.vals.length === 2, ats2X);

    // $push 保留全部元素（含重复）
    const push2 = await mongoCall(msrv, {
        aggregate: 'gp2', pipeline: [{ $group: { _id: '$g', vals: { $push: '$t' } } }], $db: 'test'
    });
    const push2X = (push2.cursor.firstBatch || []).find(r => r._id === 'x');
    ok('$push 保留重复元素（3 个）',
        Array.isArray(push2X && push2X.vals) && push2X.vals.length === 3, push2X);

    // 已有累加器不回归
    const sum = await mongoCall(msrv, {
        aggregate: 'gp', pipeline: [{ $group: { _id: '$g', total: { $sum: '$t' } } }], $db: 'test'
    });
    const sumX = (sum.cursor.firstBatch || []).find(r => r._id === 'x');
    ok('$sum 不回归：x 组 = 3', sumX && sumX.total === 3, sumX);

    msrv.close();

    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail === 0 ? 0 : 1);
}

main().catch(e => {
    console.log('[FAIL] unexpected exception: ' + (e.stack || e).split('\n').slice(0, 4).join('\n'));
    process.exit(1);
});
