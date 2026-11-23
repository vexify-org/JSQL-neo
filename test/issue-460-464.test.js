/**
 * Issue #460–#464 回归测试（公共 API / 真实 socket / 文档一致性断言）。
 *
 * #460 index.d.ts 的 Database 构造签名与运行时一致（filePath, options）。
 * #461 事务隔离级别默认 READ_COMMITTED（与 doc/api-reference.md 口径一致）。
 * #462 maxStatements 作为多语句条数上限兼开关；allowStacked 为等价显式放行。
 * #463 OP_COMPRESSED 仅支持 zlib（compressorId 2）解压；snappy/zstd 明确拒绝。
 * #464 countDocuments / serverStatus / getCmdLineOpts 在真实 Mongo socket 上回 ok:1。
 */
const path = require('path');
const fs = require('fs');
const net = require('net');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..');
const { Database, executeSQL, MongoServer } = require(path.join(ROOT, 'index.js'));
const { bsonDocument, bsonReadDocument } = require(path.join(ROOT, 'lib/mongo_server.js'));

let passed = 0, failed = 0;
function ok(name, cond, extra) {
  if (cond) { passed++; console.log('[OK]   ' + name); }
  else { failed++; console.log('[FAIL] ' + name + (extra !== undefined ? ' -> ' + JSON.stringify(extra).slice(0, 160) : '')); }
}

/* ---------- Mongo OP_MSG / OP_COMPRESSED 客户端（真实 socket） ---------- */
function mongoOpMsg(doc) {
  const p = bsonDocument(doc);
  const h = Buffer.alloc(16);
  h.writeInt32LE(16 + 4 + 1 + p.length, 0);
  h.writeInt32LE(1, 4);
  h.writeInt32LE(0, 8);
  h.writeInt32LE(2013, 12);
  return Buffer.concat([h, Buffer.alloc(4), Buffer.from([0]), p]);
}

function mongoCompressed(compressorId, innerBody) {
  const comp = zlib.deflateSync(innerBody);
  const h = Buffer.alloc(16);
  h.writeInt32LE(16 + 4 + 1 + 4 + comp.length, 0); // messageLength
  h.writeInt32LE(1, 4);                            // requestID
  h.writeInt32LE(0, 8);                            // responseTo
  h.writeInt32LE(2012, 12);                         // OP_COMPRESSED
  const origOp = Buffer.alloc(4);
  origOp.writeInt32LE(2013, 0);                     // originalOpcode = OP_MSG
  const uncompSize = Buffer.alloc(4);
  uncompSize.writeInt32LE(innerBody.length, 0);
  return Buffer.concat([h, origOp, Buffer.from([compressorId]), uncompSize, comp]);
}

function mongoCall(srv, pkt) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(srv._server.address().port, '127.0.0.1', () => sock.write(pkt));
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
  /* ================= #460 d.ts Database 构造签名 ================= */
  console.log('\n--- #460 Database 构造签名与运行时一致 ---');
  {
    let ctorOk = true, ctorErr = null;
    let db = null;
    try {
      db = new Database(':memory:');
      // 按 d.ts 声明的 (filePath, options) 两参形式构造，不应抛裸 TypeError
      const db2 = new Database(':memory:', { mode: 'memory', isolationLevel: 'READ_COMMITTED', autoSave: false });
      await db2.stop();
    } catch (e) { ctorOk = false; ctorErr = e.message; }
    ok('公共 API 按 (filePath, options) 构造 Database 不崩', ctorOk, ctorErr);
    if (db) await db.stop();
  }
  {
    const dts = fs.readFileSync(path.join(ROOT, 'index.d.ts'), 'utf8');
    ok('d.ts 声明 constructor(filePath?: string, options?: DatabaseOptions)',
      /constructor\(filePath\?: string, options\?: DatabaseOptions\)/.test(dts));
    const block = (dts.match(/interface DatabaseOptions\s*\{([\s\S]*?)\n\}/) || [])[1] || '';
    ok('DatabaseOptions 不再含错位字段 dataDir/persist/inMemoryOnly',
      !/dataDir|inMemoryOnly/.test(block) && !/^\s*persist\??:/m.test(block), block.trim());
  }

  /* ================= #461 隔离级别默认 READ_COMMITTED ================= */
  console.log('\n--- #461 默认隔离级别 READ_COMMITTED ---');
  {
    const db = new Database(':memory:');
    ok('getIsolationLevel() 默认 READ_COMMITTED', db.getIsolationLevel() === 'READ_COMMITTED', db.getIsolationLevel());
    ok('stats().isolationLevel 默认 READ_COMMITTED', db.stats().isolationLevel === 'READ_COMMITTED', db.stats().isolationLevel);
    db.begin();
    ok('begin() 后事务级别 READ_COMMITTED', db.getIsolationLevel() === 'READ_COMMITTED', db.getIsolationLevel());
    db.rollback();
    await db.stop();
  }
  {
    const doc = fs.readFileSync(path.join(ROOT, 'doc', 'api-reference.md'), 'utf8');
    ok('api-reference.md 文档口径为默认 READ_COMMITTED', /默认 READ_COMMITTED/.test(doc));
  }

  /* ================= #462 多语句门禁 ================= */
  console.log('\n--- #462 maxStatements / allowStacked 门禁 ---');
  {
    const db = new Database(':memory:');
    const run = (sql, opts) => executeSQL(db, sql, opts);

    let blockedDefault = false;
    try { await run('SELECT 1; SELECT 2'); } catch (e) { blockedDefault = /statements/.test(e.message); }
    ok('默认（未传门禁）两条语句被拦截', blockedDefault);

    let viaMax = false;
    try { await run('SELECT 1; SELECT 2', { maxStatements: 5 }); viaMax = true; } catch (e) { viaMax = false; }
    ok('{ maxStatements: 5 } 放行两条语句', viaMax);

    let overLimit = false;
    try { await run('SELECT 1; SELECT 2; SELECT 3', { maxStatements: 2 }); } catch (e) { overLimit = /too many statements/.test(e.message); }
    ok('{ maxStatements: 2 } 拦截三条语句', overLimit);

    let viaStacked = false;
    try { await run('SELECT 1; SELECT 2', { allowStacked: true }); viaStacked = true; } catch (e) { viaStacked = false; }
    ok('{ allowStacked: true } 放行两条语句（兼容旧门禁）', viaStacked);

    await db.stop();
  }
  {
    const doc = fs.readFileSync(path.join(ROOT, 'doc', 'api-reference.md'), 'utf8');
    ok('api-reference.md 同时记载 maxStatements 与 allowStacked 门禁',
      doc.includes('maxStatements') && doc.includes('allowStacked'));
  }

  /* ================= #463 OP_COMPRESSED 口径 ================= */
  console.log('\n--- #463 OP_COMPRESSED 仅支持 zlib ---');
  const srv = new MongoServer({ dataDir: ':memory:', port: 0 });
  await new Promise((r) => srv.listen(r));
  try {
    const helloBody = mongoOpMsg({ hello: 1, $db: 'admin' }).slice(16);

    const zlibReply = await mongoCall(srv, mongoCompressed(2, helloBody));
    ok('zlib（compressorId 2）压缩 hello 解压后正常分发 ok:1',
      zlibReply.ok === 1 && zlibReply.isWritablePrimary === true, zlibReply);

    const snappyReply = await mongoCall(srv, mongoCompressed(1, helloBody));
    ok('snappy（compressorId 1）回 compression not supported',
      snappyReply.ok === 0 && /compression not supported/.test(snappyReply.errmsg || ''), snappyReply);
  } finally {
    srv.close();
  }
  {
    const doc = fs.readFileSync(path.join(ROOT, 'doc', 'mongodb.md'), 'utf8');
    ok('mongodb.md 标注仅 zlib（compressorId 2）支持', /compressorId 2/.test(doc) && /zlib/.test(doc));
    ok('mongodb.md 不再宣称 snappy/zlib 双压缩均支持', !/snappy\/zlib 压缩载荷/.test(doc));
  }

  /* ================= #464 文档命令表命令可用 ================= */
  console.log('\n--- #464 countDocuments / serverStatus / getCmdLineOpts ---');
  const srv2 = new MongoServer({ dataDir: ':memory:', port: 0 });
  await new Promise((r) => srv2.listen(r));
  try {
    await mongoCall(srv2, mongoOpMsg({
      insert: 'c',
      documents: [{ _id: 1, v: 'a' }, { _id: 2, v: 'b' }],
      $db: 't',
    }));

    const cd = await mongoCall(srv2, mongoOpMsg({ countDocuments: 'c', filter: {}, $db: 't' }));
    ok('countDocuments 回 ok:1 且计数正确', cd.ok === 1 && cd.n === 2, cd);

    const cdFilter = await mongoCall(srv2, mongoOpMsg({ countDocuments: 'c', filter: { v: 'a' }, $db: 't' }));
    ok('countDocuments 带 filter 计数正确', cdFilter.ok === 1 && cdFilter.n === 1, cdFilter);

    const ss = await mongoCall(srv2, mongoOpMsg({ serverStatus: 1, $db: 'admin' }));
    ok('serverStatus 回 ok:1 且带 uptime/localTime',
      ss.ok === 1 && typeof ss.uptime === 'number' && ss.localTime != null, ss);

    const opts = await mongoCall(srv2, mongoOpMsg({ getCmdLineOpts: 1, $db: 'admin' }));
    ok('getCmdLineOpts 回 ok:1 且带 argv/parsed',
      opts.ok === 1 && Array.isArray(opts.argv) && opts.parsed && typeof opts.parsed === 'object', opts);
  } finally {
    srv2.close();
  }
  {
    const doc = fs.readFileSync(path.join(ROOT, 'doc', 'mongodb.md'), 'utf8');
    ok('mongodb.md 命令表仍列出 countDocuments/serverStatus/getCmdLineOpts',
      doc.includes('countDocuments') && doc.includes('serverStatus') && doc.includes('getCmdLineOpts'));
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
