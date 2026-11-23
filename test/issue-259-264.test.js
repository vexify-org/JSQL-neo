/* ---- 回归：#259 / #260 / #262 / #263 / #264 ---- */
/*
 * #259 目录模式（hybrid/disk）显式开启 wal:true 后，WAL 已追加落盘，
 *      但重开库从不回放 WAL：崩溃时尚未刷入 .jsql 的提交全部丢失。
 * #260 encryptKey 在目录模式被静默忽略：.jsql 数据块仅 gzip、可直接解压回明文，
 *      meta.json 也是明文。
 * #262 目录模式 .jsql 表文件损坏后被 _ensureTable 静默吞掉：表从查询中消失，
 *      但 meta.json 仍把它列为幽灵表，无任何损坏告警。
 * #263 WAL 追加失败被空 catch 静默吞掉：主流程照常返回成功、无 error 事件。
 * #264 sqlite 兼容层 db.exec() 多语句被安全策略拦截。
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const zlib = require('zlib');
const ROOT = path.join(__dirname, '..');
const Database = require(path.join(ROOT, 'lib/database.js'));
const SqliteCompat = require(path.join(ROOT, 'lib/sqlite_compat.js'));

let pass = 0, fail = 0;
function ok(name, cond, got) {
    if (cond) { pass++; console.log('[OK]   ' + name); }
    else { fail++; console.log('[FAIL] ' + name + ' -> ' + JSON.stringify(got)); }
}

function tmpdir(prefix) {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

(async () => {
    // ================= #259 目录模式 WAL 回放 =================
    {
        const dir = tmpdir('jsql-waldir-');
        const db = new Database(dir, { mode: 'disk', wal: true, flushInterval: 1e9 });
        await db.createTable('t', { id: { type: 'integer', primaryKey: true }, v: { type: 'string' } });
        await db.insert('t', { id: 1, v: 'hello-wal' });
        const wal = dir + '.wal';
        ok('目录模式 WAL 文件已落盘', fs.existsSync(wal), wal);
        // 不 flush/close —— 模拟后台刷盘前进程崩溃。
        // #449：目录模式现在持有目录级文件锁，进程崩溃后由 OS 释放锁；
        // 同进程内重开前需显式释放首个实例持有的锁，模拟崩溃后的锁清理。
        db._releaseLock();
        const db2 = new Database(dir, { mode: 'disk', wal: true, flushInterval: 1e9 });
        ok('重开后 WAL 被回放（replayed > 0）',
            db2._walReplaySummary && db2._walReplaySummary.replayed > 0, db2._walReplaySummary);
        const rows = await db2.find('t', {});
        ok('崩溃前已提交的插入被恢复',
            rows.length === 1 && rows[0].v === 'hello-wal', rows);
        db2.close();
    }

    // hybrid 模式同样要能回放
    {
        const dir = tmpdir('jsql-walhyb-');
        const db = new Database(dir, { mode: 'hybrid', wal: true, flushInterval: 1e9 });
        await db.createTable('h', { id: { type: 'integer', primaryKey: true }, v: { type: 'string' } });
        await db.insert('h', { id: 1, v: 'hyb' });
        db._releaseLock();
        const db2 = new Database(dir, { mode: 'hybrid', wal: true, flushInterval: 1e9 });
        const rows = await db2.find('h', {});
        ok('hybrid 模式 WAL 回放同样生效',
            rows.length === 1 && rows[0].v === 'hyb', rows);
        db2.close();
    }

    // ================= #260 目录模式加密 =================
    {
        const SECRET = 'TOP-SECRET-PLAINTEXT-777';
        const dir = tmpdir('jsql-encdir-');
        const KEY = '0123456789abcdef';   // 16 字节
        const db = new Database(dir, { mode: 'disk', encryptKey: KEY, flushInterval: 0 });
        await db.createTable('secret', { id: { type: 'integer', primaryKey: true }, note: { type: 'string' } });
        await db.insert('secret', { id: 1, note: SECRET });
        await db.flush();
        db.close();

        // 直接扫描 .jsql 数据块、gunzip 后搜明文（不使用任何密钥）
        const buf = fs.readFileSync(path.join(dir, 'secret.jsql'));
        let decoded = '';
        for (let bid = 1; bid * 4096 < buf.length; bid++) {
            const blk = buf.subarray(bid * 4096, bid * 4096 + 4096);
            const compLen = blk.readUInt32LE(44);
            if (!compLen) continue;
            try { decoded += zlib.gunzipSync(blk.subarray(64, 64 + compLen)).toString('utf8'); } catch (e) { /* 密文解不开 */ }
        }
        ok('目录模式 .jsql 不含可直接解压的明文', !decoded.includes(SECRET), decoded.slice(0, 40));
        ok('meta.json 也是密文（不含字段名）',
            !fs.readFileSync(path.join(dir, 'meta.json'), 'utf8').includes('note'), null);

        // 同密钥重开能正确解密读回
        const db2 = new Database(dir, { mode: 'disk', encryptKey: KEY, flushInterval: 0 });
        const rows = await db2.find('secret', {});
        ok('同密钥重开能解密读回原值',
            rows.length === 1 && rows[0].note === SECRET, rows);
        db2.close();
    }

    // ================= #262 表文件损坏显式报错 =================
    {
        const dir = tmpdir('jsql-torn-');
        const db = new Database(dir, { mode: 'hybrid' });
        await db.createTable('t', { id: { type: 'integer', primaryKey: true }, v: { type: 'string' } });
        await db.insertMany('t', [{ id: 1, v: 'a' }, { id: 2, v: 'b' }]);
        await db.flush();
        db.close();
        // 模拟崩溃半写：破坏表文件头部 magic
        const file = path.join(dir, 't.jsql');
        const buf = fs.readFileSync(file);
        buf.write('XXXX', 0, 'utf8');
        fs.writeFileSync(file, buf);

        const errs = [];
        const db2 = new Database(dir, { mode: 'hybrid' });
        db2.on('error', (e) => errs.push(e.message));
        ok('损坏表不再被 getTables 列为存在（无幽灵表）',
            !db2.getTables().includes('t'), db2.getTables());
        ok('hasTable 对损坏表返回 false', db2.hasTable('t') === false, db2.hasTable('t'));
        ok('损坏表被记录到 getCorruptTables', Object.keys(db2.getCorruptTables()).includes('t'), null);
        let qErr = null;
        try { await db2.count('t'); } catch (e) { qErr = e; }
        ok('查询损坏表报 ER_TABLE_CORRUPT（不再是含糊的缺表）',
            qErr && qErr.code === 'ER_TABLE_CORRUPT', qErr && qErr.code);
        ok('损坏时有 error 事件可见', errs.length > 0, errs);
        db2.close();
    }

    // ================= #263 WAL 落盘失败不静默 =================
    {
        const dir = tmpdir('jsql-walerr-');
        const file = path.join(dir, 'db.json');
        const db = new Database(file, { wal: true, autoSave: false });
        const errs = [];
        db.on('error', (e) => errs.push(e.message));
        await db.createTable('t', { id: { type: 'integer', primaryKey: true }, v: { type: 'string' } });
        // 让 WAL 路径指向一个目录 → openSync(...,'a') 必然失败
        const walAsDir = path.join(dir, 'wal-as-dir');
        fs.mkdirSync(walAsDir, { recursive: true });
        db._walPath = walAsDir;
        await db.insert('t', { id: 1, v: 'x' });
        ok('WAL 落盘失败时发出 error 事件', errs.length > 0, errs);
        ok('WAL 落盘失败被记入 _walError', !!db._walError, null);
        db.close();
    }

    // ================= #264 sqlite exec 多语句 =================
    {
        const db = new SqliteCompat(':memory:');
        db.exec('CREATE TABLE u (x INTEGER)');
        let multiErr = null;
        try { db.exec('INSERT INTO u VALUES (1); INSERT INTO u VALUES (2);'); }
        catch (e) { multiErr = e; }
        ok('sqlite db.exec() 支持多语句', !multiErr, multiErr && multiErr.message);
        const cnt = db.prepare('SELECT COUNT(*) AS c FROM u').get();
        ok('多语句 exec 全部生效（count = 2）', cnt && cnt.c === 2, cnt);
        // prepare 单语句路径不受影响（实际执行时仍拦截堆叠语句）
        let prepErr = null;
        try { db.prepare('SELECT 1; SELECT 2').all(); } catch (e) { prepErr = e; }
        ok('prepare().all() 单语句路径仍拦截堆叠语句', !!prepErr, prepErr && prepErr.message);
        db.close();
    }

    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail === 0 ? 0 : 1);
})().catch(e => {
    console.log('[FAIL] unexpected exception: ' + (e.stack || e).split('\n').slice(0, 4).join('\n'));
    process.exit(1);
});
