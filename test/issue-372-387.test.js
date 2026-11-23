const assert = require('assert');
const net = require('net');
const { EventEmitter } = require('events');
const path = require('path');
const { createMysqlServer, MysqlConnection } = require('../lib/mysql_server.js');
const { Database } = require('../index.js');
const { createPgServer } = require('../lib/pg_server.js');
const Cache = require('../lib/cache.js');

let passed = 0, failed = 0;
async function t(name, fn) {
  try { await fn(); passed++; console.log(`ok - ${name}`); }
  catch (e) { failed++; console.error(`not ok - ${name}\n  ${e && e.message}`); }
}

// ---------- 极简 PG v3 客户端 ----------
function pgStartup(user = 'postgres', database = 'app') {
  const parts = [Buffer.from(`user\0${user}\0`), Buffer.from(`database\0${database}\0`), Buffer.from('\0')];
  const body = Buffer.concat([Buffer.alloc(8), ...parts]);
  body.writeInt32BE(196608, 4);
  body.writeInt32BE(body.length, 0);
  return body;
}
function pgMsg(type, payload) {
  const head = Buffer.alloc(5);
  head[0] = type;
  head.writeInt32BE(4 + payload.length, 1);
  return Buffer.concat([head, payload]);
}
function pgReader(sock) {
  let buf = Buffer.alloc(0); const waiters = [];
  sock.on('data', (c) => { buf = Buffer.concat([buf, c]); pump(); });
  function pump() {
    while (waiters.length && buf.length >= 5) {
      const len = buf.readInt32BE(1);
      if (buf.length < 1 + len) break;
      waiters.shift()({ type: buf[0], payload: buf.slice(5, 1 + len) });
      buf = buf.slice(1 + len);
    }
  }
  return {
    read(ms = 300) {
      return new Promise((res) => {
        let done = false;
        const w = (p) => { if (!done) { done = true; clearTimeout(tm); res(p); } };
        const tm = setTimeout(() => { const i = waiters.indexOf(w); if (i >= 0) waiters.splice(i, 1); w(null); }, ms);
        waiters.push(w); pump();
      });
    },
  };
}
async function pgConnect(port) {
  const sock = net.connect(port, '127.0.0.1');
  await new Promise((r) => sock.on('connect', r));
  const rd = pgReader(sock);
  sock.write(pgStartup());
  for (;;) { const p = await rd.read(1500); if (!p || p.type === 0x5a) break; }
  return { sock, rd };
}
async function pgDrain(rd, ms = 300) {
  const out = [];
  for (;;) { const p = await rd.read(ms); if (!p) break; out.push(p); }
  return out;
}
function pgErrorFields(p) {
  const b = p.payload, f = {}; let i = 0;
  while (i < b.length && b[i] !== 0) {
    const k = String.fromCharCode(b[i]); const e = b.indexOf(0, i + 1);
    f[k] = b.toString('utf8', i + 1, e); i = e + 1;
  }
  return f;
}

// ---------- 极简 MySQL 客户端（只走 fake socket 发 COM_QUERY） ----------
async function mysqlStatusAfter(server, sql, engine) {
  engine = engine || new Database(':memory:');
  server._route = async (stmt, stmtSql) => ({ engine, sql: stmtSql });
  const chunks = [];
  const fake = new EventEmitter();
  fake.write = (b) => { chunks.push(Buffer.from(b)); return true; };
  fake.destroy = () => {};
  fake.writable = true;
  fake.remoteAddress = '127.0.0.1';
  const conn = new MysqlConnection(fake, server);
  conn.authenticated = true;
  conn.currentDb = 'default';
  conn.user = 'root';
  conn._handleQuery(sql);
  return new Promise((res) => setTimeout(() => {
    // 每个包 = 3 字节头 + payload；OK 包 payload: 00 / lenenc affected / lenenc insertId / status(2)
    const packets = chunks.map((b) => b.slice(4));
    const ok = packets.filter((p) => p[0] === 0x00).pop();
    assert.ok(ok, `没有收到 OK 包: ${chunks.length} 包 ${chunks.map((b) => b.toString('hex')).join(',')}`);
    let off = 1;
    for (let i = 0; i < 2; i++) { // 跳过 affectedRows / insertId 两个 lenenc
      if (ok[off] < 0xfb) off += 1 + ok[off];
      else off += 1;
    }
    res(ok.readUInt16LE(off));
  }, 120));
}

(async () => {
  // #372：BEGIN/COMMIT 必须正确置/清 SERVER_STATUS_IN_TRANS
  await t('#372 MySQL BEGIN/COMMIT 状态位 IN_TRANS', async () => {
    const srv = createMysqlServer({ dataDir: ':memory:', noAuth: true, safety: false });
    const engine = new Database(':memory:');
    const inside = await mysqlStatusAfter(srv, 'BEGIN', engine);
    assert.strictEqual(inside & 0x0001, 0x0001, `BEGIN 后 status=${inside.toString(16)} 缺 IN_TRANS`);
    const committed = await mysqlStatusAfter(srv, 'COMMIT', engine);
    assert.strictEqual(committed & 0x0001, 0, `COMMIT 后 status=${committed.toString(16)} 仍有 IN_TRANS`);
    await new Promise((r) => srv.close(r));
  });

  // #377：ErrorResponse 必须带 P（位置）字段
  await t('#377 ErrorResponse 携带 P 位置字段', async () => {
    const srv = createPgServer({ port: 0, host: '127.0.0.1', dataDir: ':memory:', noAuth: true });
    await new Promise((r) => srv.listen(r));
    const c = await pgConnect(srv.address.port);
    c.sock.write(pgMsg(0x51, Buffer.from('SELEC 1\0', 'utf8')));
    const frames = await pgDrain(c.rd);
    const err = frames.find((f) => f.type === 0x45);
    assert.ok(err, '未收到 ErrorResponse');
    const f = pgErrorFields(err);
    assert.strictEqual(f.C, '42601');
    assert.strictEqual(f.P, '1');
    c.sock.destroy();
    await new Promise((r) => srv.close(r));
  });

  // #381：扩展协议错误后不得提前发 Z，Sync 只发一帧
  await t('#381 扩展协议错误不提前发 ReadyForQuery', async () => {
    const srv = createPgServer({ port: 0, host: '127.0.0.1', dataDir: ':memory:', noAuth: true });
    await new Promise((r) => srv.listen(r));
    const c = await pgConnect(srv.address.port);
    const bind = Buffer.concat([Buffer.from('\0no-such-stmt\0', 'utf8'), Buffer.from([0, 0, 0, 0, 0])]);
    c.sock.write(pgMsg(0x42, bind));
    const pre = await pgDrain(c.rd);
    assert.ok(pre.some((f) => f.type === 0x45), 'Bind 错误应回 ErrorResponse');
    assert.ok(!pre.some((f) => f.type === 0x5a), `Sync 前不应有 Z，实际 ${pre.map((f) => f.type)}`);
    c.sock.write(pgMsg(0x53, Buffer.alloc(0)));
    const post = await pgDrain(c.rd);
    assert.strictEqual(post.filter((f) => f.type === 0x5a).length, 1);
    c.sock.destroy();
    await new Promise((r) => srv.close(r));
  });

  // #387：仅空白/分号/注释的查询回 EmptyQueryResponse
  await t('#387 纯空白/分号回 EmptyQueryResponse', async () => {
    const srv = createPgServer({ port: 0, host: '127.0.0.1', dataDir: ':memory:', noAuth: true });
    await new Promise((r) => srv.listen(r));
    const c = await pgConnect(srv.address.port);
    for (const sql of ['', ' ; ', '\t\n;', '-- hi\n;', '/* c */ ;']) {
      c.sock.write(pgMsg(0x51, Buffer.from(sql + '\0', 'utf8')));
      const frames = await pgDrain(c.rd);
      assert.deepStrictEqual(frames.map((f) => f.type), [0x49, 0x5a], `query ${JSON.stringify(sql)} 帧序列错误`);
    }
    c.sock.destroy();
    await new Promise((r) => srv.close(r));
  });

  // #382：SET 清除既有 TTL
  await t('#382 SET 清除已有 TTL', async () => {
    const cache = new Cache();
    cache.set('k', 'v');
    assert.strictEqual(cache.expire('k', 1), 1);
    assert.ok(cache.ttl('k') > 0);
    cache.set('k', 'v2');
    assert.strictEqual(cache.ttl('k'), -1, 'SET 后 ttl 应为 -1（无过期）');
    assert.strictEqual(cache.get('k'), 'v2');
    cache.set('gone', 'x');
    cache.expire('gone', 1);
    await new Promise((r) => setTimeout(r, 1100));
    assert.strictEqual(cache.get('gone'), null);
    cache.set('gone', 'revived');
    await new Promise((r) => setTimeout(r, 300));
    assert.strictEqual(cache.get('gone'), 'revived', 'SET 不得继承旧 TTL');
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
