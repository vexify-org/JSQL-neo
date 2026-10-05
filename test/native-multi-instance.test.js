/*
 * native 多实例回归测试（P0-2）
 *
 * 背景：6.3.3 及以前 native 层是 `thread_local! static ENGINE`，
 * 整个进程只有一个 HybridEngine。于是：
 *   new Database(dirA) → new Database(dirB)
 * 会把 dirA 的所有表 clear() 掉（HybridEngine::open 无条件 clear），
 * 同进程无法持有两个独立数据库 —— 对自称「嵌入式数据库」是硬伤。
 *
 * 6.3.4 改为句柄注册表：jsqlInstanceNew() 分配句柄，
 * 所有操作走 jsqlXxxH(handle, ...)；旧的 jsqlXxx() 走保留的默认实例 0。
 *
 * 若加载的是旧版预编译二进制（无 jsqlInstanceNew），整套多实例断言跳过，
 * 但向后兼容路径仍需验证。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const native = require('../native/jsql-neo-native.node');
const { JSQL } = require('../lib/native_client.js');

let pass = 0, fail = 0, skip = 0;
function ok(name, cond, extra) {
    if (cond) { pass++; console.log('[OK]   ' + name); }
    else { fail++; console.log('[FAIL] ' + name + (extra !== undefined ? ' → ' + JSON.stringify(extra) : '')); }
}
function skipTest(name, why) { skip++; console.log('[SKIP] ' + name + ' — ' + why); }

const tmp = (tag) => fs.mkdtempSync(path.join(os.tmpdir(), 'jsql-native-' + tag + '-'));
const SCHEMA = { id: { type: 'integer', primaryKey: true }, tag: { type: 'string' } };
const hasHandles = typeof native.jsqlInstanceNew === 'function';

(async () => {
    console.log('--- 1. native 二进制能力探测 ---');
    console.log('    句柄版 API: ' + (hasHandles ? '可用' : '不可用（旧版二进制）'));
    ok('二进制可加载', !!native);
    ok('旧版无句柄 API 仍存在（向后兼容）', typeof native.jsqlOpen === 'function');

    if (hasHandles) {
        console.log('--- 2. 两个独立引擎实例互不干扰（核心回归）---');
        const dA = tmp('A'), dB = tmp('B');
        const SC = JSON.stringify(SCHEMA);
        const hA = native.jsqlInstanceNew();
        native.jsqlOpenH(hA, dA, 'hybrid');
        native.jsqlCreateTableH(hA, 't', SC);
        native.jsqlInsertH(hA, 't', JSON.stringify([{ tag: 'A1' }]));
        native.jsqlInsertH(hA, 't', JSON.stringify([{ tag: 'A2' }]));

        // 关键：此时再开第二个库，旧版会把 A 的表全部清空
        const hB = native.jsqlInstanceNew();
        native.jsqlOpenH(hB, dB, 'hybrid');
        native.jsqlCreateTableH(hB, 't', SC);
        native.jsqlInsertH(hB, 't', JSON.stringify([{ tag: 'B1' }]));

        ok('两个句柄不同', hA !== hB, { hA, hB });
        ok('A 的数据未被 B 的 open() 清空', parseInt(native.jsqlCountH(hA, 't'), 10) === 2,
            native.jsqlCountH(hA, 't'));
        ok('B 的数据独立', parseInt(native.jsqlCountH(hB, 't'), 10) === 1,
            native.jsqlCountH(hB, 't'));
        const aRows = JSON.parse(native.jsqlFindH(hA, 't', '', 10, 0)).map(r => r.fields.tag);
        const bRows = JSON.parse(native.jsqlFindH(hB, 't', '', 10, 0)).map(r => r.fields.tag);
        ok('A 数据内容正确', JSON.stringify(aRows) === '["A1","A2"]', aRows);
        ok('B 数据内容正确', JSON.stringify(bRows) === '["B1"]', bRows);

        console.log('--- 3. 实例计数与销毁 ---');
        ok('显式实例数为 2', native.jsqlInstanceCount() === 2, native.jsqlInstanceCount());
        native.jsqlCloseH(hA); native.jsqlCloseH(hB);
        JSON.parse(native.jsqlInstanceFree(hA));
        JSON.parse(native.jsqlInstanceFree(hB));
        ok('free 后实例归零', native.jsqlInstanceCount() === 0, native.jsqlInstanceCount());
        ok('访问已销毁实例返回错误而非崩溃',
            /no such database instance/.test(native.jsqlCountH(hA, 't')),
            native.jsqlCountH(hA, 't'));
        fs.rmSync(dA, { recursive: true, force: true });
        fs.rmSync(dB, { recursive: true, force: true });
    } else {
        skipTest('多实例句柄测试', '旧版预编译二进制无 jsqlInstanceNew');
    }

    console.log('--- 4. 默认实例向后兼容（无句柄 API）---');
    {
        const dD = tmp('D');
        const r = JSON.parse(native.jsqlOpen(dD, 'hybrid'));
        ok('jsqlOpen 走默认实例可用', r.ok === true, r);
        native.jsqlCreateTable('t', JSON.stringify(SCHEMA));
        native.jsqlInsert('t', JSON.stringify([{ tag: 'legacy' }]));
        ok('jsqlCount 默认实例可读', native.jsqlCount('t') === '1', native.jsqlCount('t'));
        const rows = JSON.parse(native.jsqlFind('t', '', 10, 0)).map(r => r.fields.tag);
        ok('默认实例数据正确', JSON.stringify(rows) === '["legacy"]', rows);
        native.jsqlClose();
        fs.rmSync(dD, { recursive: true, force: true });
    }

    console.log('--- 5. JS 层：两个 NativeJSQL 并存 ---');
    {
        const dA = tmp('jsA'), dB = tmp('jsB');
        const A = new JSQL({ path: dA, mode: 'hybrid' });
        const B = new JSQL({ path: dB, mode: 'hybrid' });
        await A.start();
        await B.start();
        if (!hasHandles) {
            // 旧版二进制没有句柄 API，两个 JS 实例会落到同一个默认实例上，
            // 此时建同名表必然冲突 —— 只能验证「回退到单实例」这个事实本身。
            ok('旧版二进制下回退单实例（_handle 为 null）', A._handle === null && B._handle === null);
            skipTest('JS 层多实例并存测试', '旧版预编译二进制无 jsqlInstanceNew，两实例共享默认实例');
            await A.stop();
            await B.stop();
        } else {
        ok('JS 层已启用多实例', A._multiInstance === true);
        ok('两实例句柄不同', A._handle !== B._handle, { a: A._handle, b: B._handle });
        await A.createTable('t', SCHEMA);
        await A.insert('t', { tag: 'A1' });
        await A.insert('t', { tag: 'A2' });
        await B.createTable('t', SCHEMA);
        await B.insert('t', { tag: 'B1' });

        const ca = await A.count('t'), cb = await B.count('t');
        ok('A 保留自己的 2 行', ca === 2, ca);
        ok('B 有自己的 1 行', cb === 1, cb);
        const ra = (await A.find('t', {})).map(r => r.tag);
        ok('A 数据内容正确', JSON.stringify(ra) === '["A1","A2"]', ra);

        await B.createTable('only_b', { id: { type: 'integer', primaryKey: true } });
        let aSeesB = true;
        try { await A.find('only_b', {}); aSeesB = false; } catch (e) { aSeesB = true; }
        ok('A 看不到 B 独有的表', aSeesB);

        await A.stop();
        await B.stop();
        ok('stop 释放句柄', A._handle === null && B._handle === null);
        }   // else: hasHandles
        fs.rmSync(dA, { recursive: true, force: true });
        fs.rmSync(dB, { recursive: true, force: true });
    }

    console.log(`\n${pass} passed, ${fail} failed${skip ? ', ' + skip + ' skipped' : ''}`);
    process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
