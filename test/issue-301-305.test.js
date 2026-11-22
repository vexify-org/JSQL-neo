/* ---- 回归：#301 / #302 / #303 / #304 / #305 ---- */
/*
 * #301 HttpJSQL._request 主请求无超时，服务端挂起则 Promise 永久 pending。
 * #302 NeDB 兼容层缺 removeIndex / getIndexes，调用即 TypeError。
 * #303 插件钩子返回的修改后 data 被丢弃，与 PLUGINS.md 承诺不符。
 * #304 Cache.expire 接受负数秒并返回 1，Redis 对负 TTL 报 invalid expire time。
 * #305 更新路径上的唯一冲突错误消息被二次格式化。
 */
const path = require('path');
const net = require('net');
const ROOT = path.join(__dirname, '..');
const { Database, executeSQL } = require(path.join(ROOT, 'index.js'));
const Cache = require(path.join(ROOT, 'lib/cache.js'));
const { JSQL: HttpJSQL } = require(path.join(ROOT, 'lib/client.js'));
const { Datastore } = require(path.join(ROOT, 'lib/nedb_compat.js'));

let pass = 0, fail = 0;
function ok(name, cond, got) {
    if (cond) { pass++; console.log('[OK]   ' + name); }
    else { fail++; console.log('[FAIL] ' + name + ' -> ' + JSON.stringify(got)); }
}

(async () => {
    // ================= #305 唯一冲突错误消息 =================
    const db = new Database(':memory:', { autoSave: false });
    const q = async (sql) => (await executeSQL(db, sql, { safety: false })).rows;
    await q('CREATE TABLE us (id INT PRIMARY KEY, e VARCHAR(10) UNIQUE)');
    await q("INSERT INTO us VALUES (1,'a'),(2,'b')");

    let sqlErr = null;
    try { await q("UPDATE us SET e='b' WHERE id=1"); } catch (e) { sqlErr = e; }
    ok('SQL UPDATE 唯一冲突报错', !!sqlErr, sqlErr && sqlErr.message);
    ok("错误消息是 'Duplicate entry \\'b\\' for key \\'e\\''（无二次格式化）",
        sqlErr && sqlErr.message === "Duplicate entry 'b' for key 'e'", sqlErr && sqlErr.message);
    ok('错误消息不含字面 %s', sqlErr && !/%s/.test(sqlErr.message), sqlErr && sqlErr.message);
    ok('错误消息不含嵌套的 Duplicate entry',
        sqlErr && (sqlErr.message.match(/Duplicate entry/g) || []).length === 1, sqlErr && sqlErr.message);

    let apiErr = null;
    try { await db.updateById('us', 1, { e: 'b' }); } catch (e) { apiErr = e; }
    ok('API updateById 唯一冲突报错', !!apiErr, apiErr && apiErr.message);
    ok("API 错误消息同样是 'Duplicate entry \\'b\\' for key \\'e\\''",
        apiErr && apiErr.message === "Duplicate entry 'b' for key 'e'", apiErr && apiErr.message);
    ok('冲突后数据未被破坏',
        JSON.stringify(await q('SELECT * FROM us')) === '[[1,"a"],[2,"b"]]', null);

    // INSERT 路径消息形态：同样不得二次格式化、不得残留 %s
    let insErr = null;
    try { await q("INSERT INTO us VALUES (3,'b')"); } catch (e) { insErr = e; }
    ok('INSERT 路径唯一冲突报错', !!insErr, insErr && insErr.message);
    ok('INSERT 路径错误消息不含字面 %s', insErr && !/%s/.test(insErr.message), insErr && insErr.message);
    ok('INSERT 路径错误消息不含嵌套的 Duplicate entry',
        insErr && (insErr.message.match(/Duplicate entry/g) || []).length === 1, insErr && insErr.message);

    // ================= #304 Cache.expire 负数 =================
    const cache = new Cache();
    cache.set('k', 'v');
    let negErr = null;
    try { cache.expire('k', -5); } catch (e) { negErr = e; }
    ok('Cache.expire 负数报 invalid expire time',
        negErr && /invalid expire time/i.test(negErr.message), negErr && negErr.message);
    ok('负数 expire 后键仍有效（未被静默立即失效）', cache.get('k') === 'v', cache.get('k'));
    ok('负数 expire 不改变 TTL', cache.ttl('k') === -1, cache.ttl('k'));
    ok('Cache.expire 正数仍返回 1', cache.expire('k', 100) === 1, null);
    ok('Cache.expire 正数后 TTL 生效', cache.ttl('k') > 0, cache.ttl('k'));
    let fracErr = null;
    try { cache.expire('k', 1.5); } catch (e) { fracErr = e; }
    ok('Cache.expire 小数仍报 not an integer',
        fracErr && /not an integer/i.test(fracErr.message), fracErr && fracErr.message);
    cache.close();

    // ================= #302 NeDB removeIndex / getIndexes =================
    const ndb = new Datastore();
    await ndb.loadDatabase();
    await ndb.ensureIndex({ fieldName: 'email' });
    ok('NeDB getIndexes 是函数', typeof ndb.getIndexes === 'function', typeof ndb.getIndexes);
    ok('NeDB removeIndex 是函数', typeof ndb.removeIndex === 'function', typeof ndb.removeIndex);
    const idxList = await ndb.getIndexes();
    ok('getIndexes 返回已登记的索引', Array.isArray(idxList) && idxList.length === 1, idxList);
    ok('getIndexes 含 fieldName', idxList[0] && idxList[0].fieldName === 'email', idxList);
    const removed = await ndb.removeIndex('email');
    ok('removeIndex 返回移除数量', removed === 1, removed);
    const after = await ndb.getIndexes();
    ok('removeIndex 后索引列表为空', after.length === 0, after);

    // callback 风格
    await ndb.ensureIndex({ fieldName: 'a' });
    await ndb.ensureIndex({ fieldName: 'b', unique: true });
    let cbIdx = null;
    await new Promise((res) => ndb.getIndexes((e, list) => { cbIdx = list; res(); }));
    ok('getIndexes 支持 callback 签名', cbIdx && cbIdx.length === 2, cbIdx);
    let cbRemoved = null;
    await new Promise((res) => ndb.removeIndex('a', (e, n) => { cbRemoved = n; res(); }));
    ok('removeIndex 支持 callback 签名', cbRemoved === 1, cbRemoved);

    // ================= #303 插件钩子写回 =================
    const db2 = new Database(':memory:', { autoSave: false });
    await db2.createTable('t', { id: { type: 'integer', primaryKey: true }, name: { type: 'string' } });
    db2.use({
        name: 'tagger',
        hooks: {
            beforeInsert(table, arr) { return arr.map(r => ({ ...r, via: 'hook' })); },
        },
    });
    await db2.insert('t', { name: 'a' });
    const rows = await db2.find('t', {});
    ok("beforeInsert 返回的修改后 data 生效（via='hook' 落库）",
        rows.length === 1 && rows[0].via === 'hook', rows);

    // 标量参数写回：beforeUpdate 返回改写后的 data
    await db2.insert('t', { id: 2, name: 'b' });
    db2.use({
        name: 'updater',
        hooks: {
            beforeUpdate(table, id, data) { return { ...data, name: 'patched' }; },
        },
    });
    await db2.updateById('t', 2, { name: 'x' });
    const after2 = await db2.find('t', {});
    ok('beforeUpdate 返回的修改后 data 生效',
        after2.some(r => r.id === 2 && r.name === 'patched'), after2);

    // 返回 false 仍然中止
    const db3 = new Database(':memory:', { autoSave: false });
    await db3.createTable('t3', { id: { type: 'integer', primaryKey: true }, name: { type: 'string' } });
    db3.use({
        name: 'veto',
        hooks: { beforeInsert() { return false; } },
    });
    await db3.insert('t3', { name: 'a' });
    const rows3 = await db3.find('t3', {});
    ok('beforeInsert 返回 false 仍中止写入', rows3.length === 0, rows3);

    // 返回 undefined 不影响数据
    const db4 = new Database(':memory:', { autoSave: false });
    await db4.createTable('t4', { id: { type: 'integer', primaryKey: true }, name: { type: 'string' } });
    db4.use({ name: 'noop', hooks: { beforeInsert(table, arr) { return undefined; } } });
    await db4.insert('t4', { name: 'a' });
    const rows4 = await db4.find('t4', {});
    ok('beforeInsert 返回 undefined 不影响写入',
        rows4.length === 1 && rows4[0].name === 'a', rows4);

    // ================= #301 HttpJSQL 超时 =================
    const srv = net.createServer(() => { /* 故意不写任何响应 */ });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const port = srv.address().port;
    const client = new HttpJSQL({ port, host: '127.0.0.1', timeoutMs: 300 });
    let settled = false;
    let rejectMsg = null;
    client.find('t', { a: 1 })
        .then(() => { rejectMsg = null; })
        .catch(e => { rejectMsg = e.message; })
        .finally(() => { settled = true; });
    await new Promise((r) => setTimeout(r, 900));
    ok('服务端挂起时请求超时并 reject（不再永久 pending）', settled, settled);
    ok('超时错误消息含「超时」字样',
        rejectMsg && /超时|timeout/i.test(rejectMsg), rejectMsg);
    srv.close();

    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail === 0 ? 0 : 1);
})().catch(e => {
    console.log('[FAIL] unexpected exception: ' + (e.stack || e).split('\n').slice(0, 4).join('\n'));
    process.exit(1);
});
