/*
 * hybrid/disk 模式行级刷盘回归测试
 *
 * 背景：此前 hybrid 的刷盘单位是「整表」——任何一行变更都会把整张表
 * 重写一遍（write amplification），内存里也整表常驻。
 *
 * 现在：Table 按行记录脏标记（_dirtyUpserts/_dirtyDeletes），
 * Database._flushTableDelta() 只把变更行追加到表文件并更新主键索引，
 * 无主键表 / truncate / schema 变更 / 回滚仍走整表重写。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('../lib/database.js');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
    if (cond) { pass++; console.log('[OK]   ' + name); }
    else { fail++; console.log('[FAIL] ' + name + (extra !== undefined ? ' → ' + JSON.stringify(extra) : '')); }
}

function tmpDir(tag) {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'jsql-rowflush-' + tag + '-'));
}

const SCHEMA = {
    id: { type: 'integer', primaryKey: true },
    v: { type: 'string' },
    n: { type: 'integer' }
};

(async () => {
    console.log('--- 1. 单行更新只追加该行，不整表重写 ---');
    {
        const dir = tmpDir('delta');
        let db = new Database(dir, { mode: 'hybrid' });
        await db.createTable('t', SCHEMA);
        await db.insertMany('t', Array.from({ length: 300 }, (_, i) => ({ id: i + 1, v: 'v' + i, n: i })));
        await db.flush();

        const file = path.join(dir, 't.jsql');
        const before = fs.statSync(file).size;
        await db.updateById('t', 42, { n: 9999 });
        await db.flush();
        const after = fs.statSync(file).size;
        db.close();

        ok('增量写入远小于整表大小', after - before > 0 && after - before < before,
            { before, after });

        db = new Database(dir, { mode: 'hybrid' });
        const row = await db.findById('t', 42);
        ok('重开后更新已持久化', row && row.n === 9999, row);
        ok('行数不变', (await db.count('t')) === 300);
        db.close();
    }

    console.log('--- 2. 删除一行：重开不复活、不重复 ---');
    {
        const dir = tmpDir('delete');
        let db = new Database(dir, { mode: 'hybrid' });
        await db.createTable('t', SCHEMA);
        await db.insertMany('t', [{ id: 1, v: 'a', n: 1 }, { id: 2, v: 'b', n: 2 }, { id: 3, v: 'c', n: 3 }]);
        await db.flush();
        await db.removeById('t', 2);
        await db.flush();
        db.close();

        db = new Database(dir, { mode: 'hybrid' });
        const rows = await db.find('t', {});
        const ids = rows.map(r => r.id).sort();
        ok('删除的行不复活', (await db.findById('t', 2)) === null);
        ok('剩余行正确且无重复', JSON.stringify(ids) === JSON.stringify([1, 3]), ids);
        db.close();
    }

    console.log('--- 3. 主键更新后旧主键不残留 ---');
    {
        const dir = tmpDir('pkchange');
        let db = new Database(dir, { mode: 'hybrid' });
        await db.createTable('t', SCHEMA);
        await db.insertMany('t', [{ id: 1, v: 'a', n: 1 }, { id: 2, v: 'b', n: 2 }]);
        await db.flush();
        await db.updateById('t', 1, { id: 10 });
        await db.flush();
        db.close();

        db = new Database(dir, { mode: 'hybrid' });
        const oldRow = await db.findById('t', 1);
        const newRow = await db.findById('t', 10);
        ok('旧主键已不可见', oldRow === null, oldRow);
        ok('新主键可查到', newRow && newRow.v === 'a', newRow);
        ok('总行数仍为 2', (await db.count('t')) === 2);
        db.close();
    }

    console.log('--- 4. 无主键表回退整表重写，语义不变 ---');
    {
        const dir = tmpDir('nopk');
        let db = new Database(dir, { mode: 'hybrid' });
        await db.createTable('log', { v: { type: 'string' } });
        await db.insert('log', { v: 'a' });
        await db.insert('log', { v: 'b' });
        await db.flush();
        await db.removeWhere('log', { v: 'a' });
        await db.flush();
        db.close();

        db = new Database(dir, { mode: 'hybrid' });
        const rows = await db.find('log', {});
        ok('无主键表删除已持久化', rows.length === 1 && rows[0].v === 'b', rows);
        db.close();
    }

    console.log('--- 5. 反复更新触发压缩后数据仍正确 ---');
    {
        const dir = tmpDir('compact');
        let db = new Database(dir, { mode: 'hybrid' });
        await db.createTable('t', SCHEMA);
        await db.insertMany('t', [{ id: 1, n: 0 }, { id: 2, n: 0 }]);
        await db.flush();
        const file = path.join(dir, 't.jsql');
        const baseSize = fs.statSync(file).size;
        for (let i = 1; i <= 200; i++) {
            await db.updateById('t', 1, { n: i });
            await db.flush();
        }
        const grownSize = fs.statSync(file).size;
        db.close();

        db = new Database(dir, { mode: 'hybrid' });
        const row = await db.findById('t', 1);
        ok('压缩后最新值正确', row && row.n === 200, row);
        ok('压缩后行数正确', (await db.count('t')) === 2);
        ok('文件未无限膨胀', grownSize < baseSize * 60, { baseSize, grownSize });
        db.close();
    }

    console.log('--- 6. 删除后重新插入同主键 ---');
    {
        const dir = tmpDir('reinsert');
        let db = new Database(dir, { mode: 'hybrid' });
        await db.createTable('t', SCHEMA);
        await db.insert('t', { id: 1, v: 'old', n: 1 });
        await db.flush();
        await db.removeById('t', 1);
        await db.flush();
        await db.insert('t', { id: 1, v: 'new', n: 2 });
        await db.flush();
        db.close();

        db = new Database(dir, { mode: 'hybrid' });
        const row = await db.findById('t', 1);
        ok('重新插入的行是唯一一行', row && row.v === 'new' && (await db.count('t')) === 1, row);
        db.close();
    }

    console.log('--- 7. 重开后按行懒加载 + 逐行淘汰 ---');
    {
        const dir = tmpDir('lazy');
        let db = new Database(dir, { mode: 'hybrid' });
        await db.createTable('t', SCHEMA);
        // 400 行超过单个索引块的容量（335 项），同时覆盖索引分块读取
        await db.insertMany('t', Array.from({ length: 400 }, (_, i) => ({ id: i + 1, v: 'v' + i, n: i })));
        await db.flush();
        db.close();

        db = new Database(dir, { mode: 'hybrid' });
        const table = db._ensureTable('t');
        ok('重开后行数完整（索引跨块）', table._rows.length === 400 && (await db.count('t')) === 400,
            table._rows.length);
        ok('打开时不把整表读入内存', table._rowCache.size() === 0, table._rowCache.size());

        const row = await db.findById('t', 200);
        ok('按主键只加载命中的一行', row && row.n === 199 && table._rowCache.size() === 1,
            { row, cached: table._rowCache.size() });

        await db.updateById('t', 200, { n: 8888 });
        await db.flush();
        table._evictRows(Infinity);
        ok('淘汰后按需重读仍是新值',
            (await db.findById('t', 200)).n === 8888 && table._rowCache.size() === 1);

        table._evictRows(Infinity);
        ok('淘汰后行数不变', (await db.count('t')) === 400 && table._rowCache.size() === 0);
        db.close();
    }

    console.log(`\n${pass} passed, ${fail} failed`);
    if (fail > 0) process.exit(1);
})();
