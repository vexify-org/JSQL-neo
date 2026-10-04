/*
 * WAL 崩溃恢复回归测试（P1-1）
 *
 * 背景：6.3.3 及以前的 _recoverFromWAL() 只做 fs.unlinkSync 删除 WAL 文件，
 * 从不回放任何操作；且构造函数用 fs.existsSync(dataFile) 短路，
 * 新建库崩溃后连 WAL 都不会被读取。合起来的效果是：
 * 「WAL / 崩溃恢复」是虚假宣传 —— 实测开启 wal:true 后 kill -9 必然丢数据。
 *
 * 6.3.4 修复：
 *   1. WAL 改为 append-only JSONL + fsync
 *   2. insert/update/removeById 现在都写 WAL
 *   3. _recoverFromWAL 真正按 sequence 顺序回放
 *   4. 构造函数在「数据文件不存在但 WAL 存在」时也走恢复流程
 *   5. .jsql 二进制格式分支不再提前 return 跳过恢复
 *
 * 本测试用「不调用 save() 直接丢弃实例」模拟 kill -9。
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

function tmpFile(tag) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsql-wal-' + tag + '-'));
    return { dir, file: path.join(dir, 'db.jsql') };
}
const SCHEMA = { id: { type: 'integer', primaryKey: true }, v: { type: 'string' }, n: { type: 'integer' } };

(async () => {
    console.log('--- 1. 全新库崩溃：WAL 必须恢复出全部数据 ---');
    {
        const { dir, file } = tmpFile('new');
        const db = new Database(file, { wal: true, autoSave: false });
        await db.createTable('t', SCHEMA);
        await db.insert('t', { id: 1, v: 'important' });
        await db.insert('t', { id: 2, v: 'second' });
        await db.updateById('t', 1, { v: 'updated' });
        await db.insert('t', { id: 3, v: 'third' });
        await db.removeById('t', 3);
        // 模拟 kill -9：直接丢弃，不 save 不 stop
        const db2 = new Database(file, { wal: true });
        const rows = await db2.find('t', {});
        ok('崩溃后表仍存在', Object.keys(db2._tables).includes('t'));
        ok('崩溃后行数正确 (2)', rows.length === 2, rows.length);
        ok('崩溃后 update 已回放', rows.find(r => r.id === 1)?.v === 'updated', rows);
        ok('崩溃后第二行存在', rows.find(r => r.id === 2)?.v === 'second');
        ok('崩溃后 delete 已回放', !rows.find(r => r.id === 3));
        ok('回放后 WAL 已检查点', !fs.existsSync(file + '.wal'));
        fs.rmSync(dir, { recursive: true, force: true });
    }

    console.log('--- 2. 快照 + WAL 叠加：save 后的新写入也要恢复 ---');
    {
        const { dir, file } = tmpFile('mix');
        const db = new Database(file, { wal: true, autoSave: false });
        await db.createTable('t', SCHEMA);
        await db.insert('t', { id: 1, v: 'a' });
        await db.insert('t', { id: 2, v: 'b' });
        db.save();                       // 快照：2 行，WAL 应清空
        ok('save 后 WAL 被清空', !fs.existsSync(file + '.wal'));
        await db.insert('t', { id: 3, v: 'c-after-save' });   // 只进 WAL
        const db2 = new Database(file, { wal: true });
        const rows = await db2.find('t', {});
        ok('快照 2 行 + WAL 1 行 = 3 行', rows.length === 3, rows.length);
        ok('WAL 中的新行已恢复', rows.find(r => r.id === 3)?.v === 'c-after-save');
        fs.rmSync(dir, { recursive: true, force: true });
    }

    console.log('--- 3. 幂等：二次重开不得重复回放 ---');
    {
        const { dir, file } = tmpFile('idem');
        const db = new Database(file, { wal: true, autoSave: false });
        await db.createTable('t', SCHEMA);
        await db.insert('t', { id: 1, v: 'x' });
        await db.insert('t', { id: 2, v: 'y' });
        const db2 = new Database(file, { wal: true });
        const r2 = await db2.find('t', {});
        const db3 = new Database(file, { wal: true });
        const r3 = await db3.find('t', {});
        ok('首次恢复 2 行', r2.length === 2, r2.length);
        ok('二次重开仍 2 行（不重复回放）', r3.length === 2, r3.length);
        fs.rmSync(dir, { recursive: true, force: true });
    }

    console.log('--- 4. WAL 为 append-only JSONL，崩溃写半的尾行可容错 ---');
    {
        const { dir, file } = tmpFile('torn');
        const db = new Database(file, { wal: true, autoSave: false });
        await db.createTable('t', SCHEMA);
        await db.insert('t', { id: 1, v: 'ok' });
        // 模拟崩溃时最后一行只写了一半
        fs.appendFileSync(file + '.wal', '{"op":"insert","table":"t","ro');
        const db2 = new Database(file, { wal: true });
        const rows = await db2.find('t', {});
        ok('半截尾行被丢弃，完整记录仍恢复', rows.length === 1, rows.length);
        ok('数据内容正确', rows[0] && rows[0].v === 'ok', rows);
        fs.rmSync(dir, { recursive: true, force: true });
    }

    console.log('--- 5. deleteById / dropTable 也进 WAL ---');
    {
        const { dir, file } = tmpFile('del');
        const db = new Database(file, { wal: true, autoSave: false });
        await db.createTable('t', SCHEMA);
        await db.createTable('u', SCHEMA);
        await db.insert('t', { id: 1, v: 'a' });
        await db.insert('u', { id: 1, v: 'b' });
        await db.dropTable('u');
        const db2 = new Database(file, { wal: true });
        ok('被 drop 的表未复活', !db2._tables.u, Object.keys(db2._tables));
        ok('保留的表数据完整', (await db2.find('t', {})).length === 1);
        fs.rmSync(dir, { recursive: true, force: true });
    }

    console.log('--- 6. 未开启 wal 时不应产生 .wal 文件 ---');
    {
        const { dir, file } = tmpFile('off');
        const db = new Database(file, { wal: false, autoSave: false });
        await db.createTable('t', SCHEMA);
        await db.insert('t', { id: 1, v: 'a' });
        ok('未开启 wal 时无 .wal 文件', !fs.existsSync(file + '.wal'));
        fs.rmSync(dir, { recursive: true, force: true });
    }

    console.log('--- 6b. 兼容 6.3.3 的旧格式 WAL（单行 JSON 数组）---');
    {
        // 升级场景：用户本地残留旧版写出的数组格式 WAL，不得被静默丢弃
        const { dir, file } = tmpFile('oldfmt');
        fs.writeFileSync(file + '.wal', JSON.stringify([
            { op: 'createTable', table: 'legacy', schema: SCHEMA },
        ]));
        const db = new Database(file, { wal: true });
        ok('旧格式数组 WAL 能被回放', !!db._tables.legacy, Object.keys(db._tables));
        fs.rmSync(dir, { recursive: true, force: true });
    }

    console.log('--- 7. 回放后索引仍可用（B-Tree 重建）---');
    {
        const { dir, file } = tmpFile('idx');
        const db = new Database(file, { wal: true, autoSave: false });
        await db.createTable('t', SCHEMA);
        db.createTable && 0;
        for (let i = 1; i <= 30; i++) await db.insert('t', { id: i, v: 'v' + i, n: i });
        db._tables.t.createIndex('n');
        const db2 = new Database(file, { wal: true });
        const found = await db2.find('t', { n: 17 });
        ok('回放后按索引字段查询正确', found.length === 1 && found[0].id === 17, found);
        const cnt = await db2.find('t', { n: { $gte: 25 } });
        ok('回放后范围查询正确', cnt.length === 6, cnt.length);
        fs.rmSync(dir, { recursive: true, force: true });
    }

    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
