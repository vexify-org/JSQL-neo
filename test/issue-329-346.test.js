/*
 * Regression tests for #328 #329 #339 #343 #346.
 */
const net = require('net');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const { Database, createMongoServer } = require(path.join(ROOT, 'index.js'));
const { bsonDocument, bsonReadDocument } = require(path.join(ROOT, 'lib', 'mongo_server.js'));
const SqliteCompat = require(path.join(ROOT, 'lib', 'sqlite_compat.js'));

let passed = 0, failed = 0;
function ok(name, cond, extra) {
  if (cond) { passed++; console.log('[OK]', name); }
  else { failed++; console.log('[FAIL]', name, extra !== undefined ? '→ ' + JSON.stringify(extra) : ''); }
}

function opMsg(doc) {
  const p = bsonDocument(doc), h = Buffer.alloc(16);
  h.writeInt32LE(21 + p.length, 0); h.writeInt32LE(1, 4); h.writeInt32LE(0, 8); h.writeInt32LE(2013, 12);
  return Buffer.concat([h, Buffer.alloc(4), Buffer.from([0]), p]);
}

(async () => {
  // #343 NTILE：前 len % n 桶各多一行，n > len 时按 1..len 顺序派桶
  {
    const db = new Database(':memory:');
    const rows = async (sql) => (await db.query(sql, { safety: false })).rows;
    await rows('CREATE TABLE nt (id INT PRIMARY KEY)');
    for (let i = 1; i <= 5; i++) await db.insert('nt', { id: i });
    ok('#343 NTILE(10) 5 行不跳号',
      JSON.stringify(await rows('SELECT NTILE(10) OVER (ORDER BY id) b FROM nt ORDER BY id')) === '[[1],[2],[3],[4],[5]]',
      await rows('SELECT NTILE(10) OVER (ORDER BY id) b FROM nt ORDER BY id'));
    ok('#343 NTILE(2) 5 行 = 1,1,1,2,2',
      JSON.stringify(await rows('SELECT NTILE(2) OVER (ORDER BY id) b FROM nt ORDER BY id')) === '[[1],[1],[1],[2],[2]]');
    await db.insert('nt', { id: 6 }); await db.insert('nt', { id: 7 });
    ok('#343 NTILE(3) 7 行 = 1,1,1,2,2,3,3',
      JSON.stringify(await rows('SELECT NTILE(3) OVER (ORDER BY id) b FROM nt ORDER BY id')) === '[[1],[1],[1],[2],[2],[3],[3]]');
    await db.close();
  }

  // #346 反引号标识符内的 `` 是转义单反引号
  {
    const db = new Database(':memory:');
    const q = async (sql) => { try { return (await db.query(sql, { safety: false })); } catch (e) { return { err: e.message }; } };
    const r1 = await q('SELECT 1 AS `a``b`');
    ok('#346 列别名含转义反引号', !r1.err && r1.columns[0] === 'a`b', r1.err || r1.columns);
    const r2 = await q('CREATE TABLE `t``x` (id INT)');
    ok('#346 建表名含转义反引号', !r2.err, r2.err);
    await db.close();
  }

  // #329 sqlite 兼容层：空串 / 纯空白 / 只有分号 一律 no-op
  {
    const db = new SqliteCompat(':memory:');
    for (const sql of ['', '   ', '\n\t ', ';']) {
      let got, err;
      try { got = db.prepare(sql).all(); } catch (e) { err = e.message; }
      ok(`#329 prepare(${JSON.stringify(sql)}) => []`, !err && Array.isArray(got) && got.length === 0, err || got);
    }
    db.close();
  }

  // #328 聚合管道 $addFields / $set
  {
    const srv = createMongoServer({ dataDir: ':memory:' });
    await new Promise((r) => srv.listen(r));
    const port = srv._server.address().port;
    const call = (doc) => new Promise((res) => {
      const s = net.connect(port, '127.0.0.1', () => s.write(opMsg(doc)));
      const c = [];
      s.on('data', (d) => {
        c.push(d);
        const b = Buffer.concat(c);
        if (b.length >= 16 && b.length >= b.readInt32LE(0)) { res(bsonReadDocument(b.slice(21), 0).value); s.end(); }
      });
    });
    // #459：游标绑定创建连接，find/getMore 必须走同一条 socket
    const callOn = (sock, doc) => new Promise((res) => {
      const c = [];
      const onData = (d) => {
        c.push(d);
        const b = Buffer.concat(c);
        if (b.length >= 16 && b.length >= b.readInt32LE(0)) {
          sock.removeListener('data', onData);
          res(bsonReadDocument(b.slice(21), 0).value);
        }
      };
      sock.on('data', onData);
      sock.write(opMsg(doc));
    });
    await call({ insert: 'af', documents: [{ n: 1 }, { n: 2 }], $db: 'test' });
    const add = await call({ aggregate: 'af', pipeline: [{ $addFields: { z: 5 } }], cursor: {}, $db: 'test' });
    ok('#328 $addFields 保留原字段并新增字段',
      add.ok === 1 && JSON.stringify(add.cursor.firstBatch) === '[{"n":1,"z":5},{"n":2,"z":5}]', add);
    const set = await call({ aggregate: 'af', pipeline: [{ $set: { y: { $multiply: ['$n', 10] } } }], cursor: {}, $db: 'test' });
    ok('#328 $set 作为别名求值表达式',
      set.ok === 1 && JSON.stringify(set.cursor.firstBatch) === '[{"n":1,"y":10},{"n":2,"y":20}]', set);
    const bogus = await call({ aggregate: 'af', pipeline: [{ $bogus: {} }], cursor: {}, $db: 'test' });
    ok('#328 未知 stage 仍报 40324', bogus.ok === 0 && bogus.code === 40324, bogus);

    // #339 getMore 支持扩展 JSON 的 $numberLong 游标 id（find/getMore 同一连接）
    const sock = net.connect(port, '127.0.0.1');
    await callOn(sock, { insert: 'cur', documents: [{ n: 1 }, { n: 2 }, { n: 3 }], $db: 'test' });
    const find = await callOn(sock, { find: 'cur', batchSize: 2, $db: 'test' });
    const rawId = find.cursor.id;
    const id = rawId && typeof rawId === 'object' ? (rawId.$long ?? rawId.$numberLong) : rawId;
    const more = await callOn(sock, { getMore: { $numberLong: String(id) }, collection: 'cur', batchSize: 2, $db: 'test' });
    ok('#339 getMore 接受 $numberLong 形态游标 id',
      more.ok === 1 && more.cursor && more.cursor.nextBatch.length === 1, more);
    sock.end();
    srv.close();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
