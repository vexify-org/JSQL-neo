/*
 * 无 schema 表（Mongo collection 以 {} 建表）的持久化回归测试。
 *
 * 复现（v6.5.32–v6.6.4）：
 *   buildEncoders(schema) 对空 schema 返回 0 个编码器 → 每行刷成 4 字节空桩
 *   → readTableSync 把首个 0 长行当块尾 → 重载后 0 行（数据全丢）。
 *
 * 修复：schema 为空时编码器改由行数据的字段并集生成；BSON Date 增加 TYPE.DATE
 * 一等编码（此前会落进 OBJ 分支存成 {}）。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const { Database, createMongoServer } = require(path.join(ROOT, 'index.js'));

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('[OK]  ', name); }
  else { fail++; console.log('[FAIL]', name, extra !== undefined ? '-> ' + JSON.stringify(extra, (k, v) => typeof v === 'bigint' ? v + 'n' : v).slice(0, 300) : ''); }
}

(async () => {
  // --- Layer 1: Database 级 —— schemaless 表 flush → 重启 → 数据完整 ---
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsql-persist-'));
    const db = new Database(dir, { mode: 'hybrid' }); // 与 multiserver 共享引擎一致
    await db.createTable('c', {});
    await db.insert('c', [
      { _id: 1, name: 'alice', nested: { k: 'v', deep: [1, 'x', null] } },
      { _id: 2, name: 'bob', when: new Date(1700000000123), buf: Buffer.from([1, 2, 3]), big: 9007199254740993n, tags: [{ n: 1 }, { n: 2 }] },
      { _id: 3 }, // 稀疏行：只有 _id
    ]);
    await db.stop(); // flush + 关闭

    const db2 = new Database(dir, { mode: 'hybrid' });
    const rows = await db2.find('c', {});
    const byId = {};
    for (const r of rows) byId[r._id] = r;

    ok('schemaless: 3 rows survive reload', rows.length === 3, rows.length);
    ok('schemaless: nested obj/array deep-equal',
      JSON.stringify(byId[1].nested) === JSON.stringify({ k: 'v', deep: [1, 'x', null] }), byId[1]);
    ok('schemaless: Date round-trips as Date with same ms',
      byId[2].when instanceof Date && byId[2].when.getTime() === 1700000000123, byId[2].when);
    ok('schemaless: Buffer round-trips',
      Buffer.isBuffer(byId[2].buf) && byId[2].buf.equals(Buffer.from([1, 2, 3])), byId[2].buf);
    ok('schemaless: >MAX_SAFE integer stays BigInt', typeof byId[2].big === 'bigint' && byId[2].big === 9007199254740993n, byId[2].big);
    ok('schemaless: array of objects round-trips',
      JSON.stringify(byId[2].tags) === JSON.stringify([{ n: 1 }, { n: 2 }]), byId[2].tags);
    ok('schemaless: sparse row keeps _id', byId[3] && byId[3]._id === 3, byId[3]);
    ok('schemaless: field missing in a row reloads as null (documented shortcut)', byId[3].name === null, byId[3].name);

    // 重载后再写入再重载 —— 修复后第二轮回写不得破坏数据
    await db2.insert('c', { _id: 4, extra: true });
    await db2.stop();
    const db3 = new Database(dir, { mode: 'hybrid' });
    const rows3 = await db3.find('c', {});
    ok('schemaless: second write→reload cycle keeps all rows', rows3.length === 4 && rows3.some(r => r._id === 4 && r.extra === true), rows3.length);
    await db3.stop();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }

  // --- Layer 2: Mongo 服务器级 e2e —— 用户实际场景 ---
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsql-mongo-'));
    const srv = createMongoServer({ port: 0, noAuth: true, dataDir: dir });
    await new Promise((res) => srv.listen(res));

    const ins = await srv._dispatch('insert', {
      insert: 'docs', $db: 'test',
      documents: [
        { _id: 'a1', x: 1, nested: { k: 'v' } },
        { _id: 'a2', x: 2, createdAt: new Date(1699999999999), list: [1, 2, { y: null }] },
      ],
    });
    ok('mongo e2e: insert ok', ins.ok === 1 && ins.n === 2, ins);

    await new Promise((res) => srv.close(res)); // close → engine.stop() → flush

    const srv2 = createMongoServer({ port: 0, noAuth: true, dataDir: dir });
    await new Promise((res) => srv2.listen(res));
    const found = await srv2._dispatch('find', { find: 'docs', filter: {}, $db: 'test' });
    const batch = found.cursor ? found.cursor.firstBatch : [];
    const byId = {};
    for (const r of batch) byId[r._id] = r;

    ok('mongo e2e: docs survive server restart', batch.length === 2, batch);
    ok('mongo e2e: nested field intact', byId.a1 && byId.a1.nested && byId.a1.nested.k === 'v', byId.a1);
    ok('mongo e2e: Date field survives restart',
      byId.a2 && byId.a2.createdAt instanceof Date && byId.a2.createdAt.getTime() === 1699999999999, byId.a2 && byId.a2.createdAt);
    ok('mongo e2e: mixed array survives restart',
      byId.a2 && JSON.stringify(byId.a2.list) === JSON.stringify([1, 2, { y: null }]), byId.a2 && byId.a2.list);

    // 重启后 _id 唯一性检查仍工作（重载行参与查重）
    const dup = await srv2._dispatch('insert', { insert: 'docs', $db: 'test', documents: [{ _id: 'a1', x: 9 }] });
    ok('mongo e2e: duplicate _id rejected after reload', dup.n === 0, dup);
    await new Promise((res) => srv2.close(res));
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }

  // --- Layer 3: 兼容旧版单文件库 —— dataDir 下已有同名文件时必须走 legacy 模式 ---
  {
    // 旧版直接 Database 用法（mode 缺省 = 单文件模式）落一个库文件；
    // 该模式下 stop() 不落盘，必须显式 save()。
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsql-legacy-'));
    const legacy = new Database(path.join(dir, 'test'), { autoSave: true });
    await legacy.createTable('legacy_t', { id: 'int', name: 'string' });
    await legacy.insert('legacy_t', { id: 1, name: 'old' });
    legacy.save();
    await legacy.stop();
    ok('legacy: single-file db written to disk', fs.statSync(path.join(dir, 'test')).isFile());

    // 回归点：_createEngine 用 fs.statSync 探测旧文件，但模块没有 require('fs') 时
    // ReferenceError 被空 catch 吞掉 → 恒走 hybrid → mkdirSync 对已存在文件抛 EEXIST，
    // 旧库彻底不可访问。修复后应走 legacy 模式并正常读到数据。
    const srv = createMongoServer({ port: 0, noAuth: true, dataDir: dir });
    await new Promise((res) => srv.listen(res));
    const found = await srv._dispatch('find', { find: 'legacy_t', filter: {}, $db: 'test' });
    const batch = found.cursor ? found.cursor.firstBatch : [];
    ok('legacy: mongo server reads legacy single-file db', batch.length === 1 && batch[0].name === 'old', batch);
    await new Promise((res) => srv.close(res));
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }

  console.log(fail === 0 ? `\nALL ${pass} TESTS PASSED` : `\n${fail} FAILURES (${pass} passed)`);
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => {
  console.error('FATAL:', e.message, e.stack);
  process.exit(1);
});
