const assert = require('assert');
const net = require('net');
const { createPgServer } = require('../lib/pg_server.js');

let passed = 0, failed = 0;
async function t(name, fn) {
  try { await fn(); passed++; console.log(`ok - ${name}`); }
  catch (e) { failed++; console.error(`not ok - ${name}\n  ${e && e.message}`); }
}

// ---------- 极简 PG v3 客户端（真实 socket 帧） ----------
function pgStartup(extra = {}) {
  const parts = [];
  for (const [k, v] of Object.entries({ user: 'postgres', database: 'app', ...extra })) {
    parts.push(Buffer.from(k + '\0' + v + '\0'));
  }
  parts.push(Buffer.from('\0'));
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
const cstr = s => Buffer.from(String(s) + '\0', 'utf8');
function parseMsg(name, sql, paramTypes = []) {
  const count = Buffer.alloc(2);
  count.writeInt16BE(paramTypes.length, 0);
  const oids = Buffer.concat(paramTypes.map(o => {
    const b = Buffer.alloc(4); b.writeInt32BE(o, 0); return b;
  }));
  return pgMsg(0x50, Buffer.concat([cstr(name), cstr(sql), count, oids]));
}
function describeMsg(kind, name) {
  return pgMsg(0x44, Buffer.concat([Buffer.from([kind]), cstr(name)]));
}
function queryMsg(sql) { return pgMsg(0x51, Buffer.from(sql + '\0', 'utf8')); }

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
    }
  };
}
async function pgConnect(port, extra) {
  const sock = net.connect(port, '127.0.0.1');
  await new Promise((r) => sock.on('connect', r));
  const rd = pgReader(sock);
  sock.write(pgStartup(extra));
  const auth = [];
  for (;;) { const p = await rd.read(1500); if (!p || p.type === 0x5a) break; auth.push(p); }
  return { sock, rd, auth };
}
async function pgDrain(rd, ms = 300) {
  const out = [];
  for (;;) { const p = await rd.read(ms); if (!p) break; out.push(p); }
  return out;
}

function pgParam(p) {
  const e = p.payload.indexOf(0);
  const vStart = e + 1;
  let vEnd = p.payload.indexOf(0, vStart);
  if (vEnd < 0) vEnd = p.payload.length;
  return { name: p.payload.toString('utf8', 0, e), value: p.payload.toString('utf8', vStart, vEnd) };
}
function pgErrorFields(p) {
  const b = p.payload, f = {}; let i = 0;
  while (i < b.length && b[i] !== 0) {
    const k = String.fromCharCode(b[i]); const e = b.indexOf(0, i + 1);
    f[k] = b.toString('utf8', i + 1, e); i = e + 1;
  }
  return f;
}
function parseT(p) {
  const b = p.payload; let off = 0;
  const n = b.readInt16BE(off); off += 2;
  const cols = [];
  for (let i = 0; i < n; i++) {
    const e = b.indexOf(0, off); const name = b.toString('utf8', off, e); off = e + 1;
    const tableOid = b.readInt32BE(off); off += 4;
    const attnum = b.readInt16BE(off); off += 2;
    const oid = b.readInt32BE(off); off += 4;
    const len = b.readInt16BE(off); off += 2;
    const typmod = b.readInt32BE(off); off += 4;
    const fmt = b.readInt16BE(off); off += 2;
    cols.push({ name, tableOid, attnum, oid, len, typmod, fmt });
  }
  return cols;
}
function parseD(p) {
  const b = p.payload; let off = 0;
  const n = b.readInt16BE(off); off += 2;
  const vals = [];
  for (let i = 0; i < n; i++) {
    const l = b.readInt32BE(off); off += 4;
    vals.push(l === -1 ? null : b.slice(off, off + l).toString('utf8'));
    off += Math.max(l, 0);
  }
  return vals;
}

async function withServer(fn) {
  const srv = createPgServer({ port: 0, host: '127.0.0.1', dataDir: ':memory:', noAuth: true });
  await new Promise((r) => srv.listen(r));
  try { await fn(srv); } finally { srv.close(); }
}

(async () => {
  // #352：Describe statement 对 SELECT 必须回 RowDescription，不能恒回 NoData
  await t('#352 Describe(statement) 对 SELECT 回 RowDescription', async () => {
    await withServer(async (srv) => {
      const c = await pgConnect(srv.address.port);
      c.sock.write(queryMsg('CREATE TABLE d1 (id INTEGER, name TEXT)'));
      await pgDrain(c.rd);
      c.sock.write(queryMsg("INSERT INTO d1 VALUES (1, 'a')"));
      await pgDrain(c.rd);
      c.sock.write(parseMsg('sx', 'SELECT id, name FROM d1', []));
      await pgDrain(c.rd);
      c.sock.write(describeMsg(0x53, 'sx'));   // Describe statement ('S')
      const frames = await pgDrain(c.rd);
      const tFrame = frames.find((f) => f.type === 0x54);
      assert.ok(tFrame, `未收到 RowDescription，帧序列: ${frames.map((f) => f.type)}`);
      const cols = parseT(tFrame);
      assert.strictEqual(cols.length, 2);
      assert.strictEqual(cols[0].name, 'id');
      assert.strictEqual(cols[0].oid, 23, `id OID 应为 int4=23，实际 ${cols[0].oid}`);
      assert.strictEqual(cols[1].name, 'name');
      assert.strictEqual(cols[1].oid, 25, `name OID 应为 text=25，实际 ${cols[1].oid}`);
      c.sock.destroy();
    });
  });

  // #371：RowDescription 的类型 OID / typlen 按 pg_type.h 口径通告
  await t('#371 类型 OID 与 typlen 通告正确', async () => {
    await withServer(async (srv) => {
      const c = await pgConnect(srv.address.port);
      c.sock.write(queryMsg('CREATE TABLE o1 (a SMALLINT, g TIMESTAMPTZ, i JSON, k BYTEA, l UUID, n REAL, m TEXT, o DOUBLE, p ARRAY)'));
      await pgDrain(c.rd);
      c.sock.write(queryMsg("INSERT INTO o1 VALUES (1, '2024-01-02 03:04:05+08', '{\"x\":1}', 'abc', 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', 1.5, 'txt', 2.5, '{1,2}')"));
      await pgDrain(c.rd);
      c.sock.write(queryMsg('SELECT a, g, i, k, l, n, m, o, p FROM o1'));
      const frames = await pgDrain(c.rd);
      const tFrame = frames.find((f) => f.type === 0x54);
      assert.ok(tFrame, '未收到 RowDescription');
      const cols = parseT(tFrame);
      const byName = Object.fromEntries(cols.map((x) => [x.name, x]));
      const expect = {
        a: { oid: 21, len: 2 },    // int2
        g: { oid: 1184, len: -1 }, // timestamptz
        i: { oid: 114, len: -1 },  // json
        k: { oid: 17, len: -1 },   // bytea
        l: { oid: 2950, len: -1 }, // uuid
        n: { oid: 700, len: 4 },   // float4
        m: { oid: 25, len: -1 },   // text
        o: { oid: 701, len: 8 },   // float8
        p: { oid: 1009, len: -1 }  // text[]
      };
      for (const [name, want] of Object.entries(expect)) {
        assert.ok(byName[name], `缺列 ${name}`);
        assert.strictEqual(byName[name].oid, want.oid, `${name} OID 应为 ${want.oid}，实际 ${byName[name].oid}`);
        assert.strictEqual(byName[name].len, want.len, `${name} typlen 应为 ${want.len}，实际 ${byName[name].len}`);
      }
      c.sock.destroy();
    });
  });

  // #375：SET 已知 GUC 广播 ParameterStatus；未知 GUC 回 42704
  await t('#375 SET 广播 ParameterStatus，未知 GUC 报 42704', async () => {
    await withServer(async (srv) => {
      const c = await pgConnect(srv.address.port);
      c.sock.write(queryMsg("SET client_encoding TO 'LATIN1'"));
      const f1 = await pgDrain(c.rd);
      const ps1 = f1.filter((f) => f.type === 0x53).map(pgParam);
      assert.ok(ps1.some((x) => x.name === 'client_encoding' && x.value === 'LATIN1'),
        `未广播 client_encoding=LATIN1，实际 ${JSON.stringify(ps1)}`);
      assert.ok(f1.some((f) => f.type === 0x43), 'SET 成功应有 CommandComplete');

      c.sock.write(queryMsg("SET search_path TO 'public'"));
      const f2 = await pgDrain(c.rd);
      const ps2 = f2.filter((f) => f.type === 0x53).map(pgParam);
      assert.ok(ps2.some((x) => x.name === 'search_path' && x.value === 'public'),
        `未广播 search_path=public，实际 ${JSON.stringify(ps2)}`);

      c.sock.write(queryMsg("SET bogus_unknown_guc TO 'x'"));
      const f3 = await pgDrain(c.rd);
      const err = f3.find((f) => f.type === 0x45);
      assert.ok(err, '未知 GUC 应回 ErrorResponse');
      const fields = pgErrorFields(err);
      assert.strictEqual(fields.C, '42704', `未知 GUC SQLSTATE 应为 42704，实际 ${fields.C}`);
      assert.ok(f3.some((f) => f.type === 0x5a), '错误后应有 ReadyForQuery');
      c.sock.destroy();
    });
  });

  // #376：启动包 application_name / search_path 认证后回填 ParameterStatus
  await t('#376 启动参数 application_name/search_path 认证后回填', async () => {
    await withServer(async (srv) => {
      const c = await pgConnect(srv.address.port, { application_name: 'probe-app', search_path: 'public' });
      const ps = c.auth.filter((f) => f.type === 0x53).map(pgParam);
      const app = ps.find((x) => x.name === 'application_name');
      const sp = ps.find((x) => x.name === 'search_path');
      assert.ok(app, `认证帧缺 application_name，实际 ${JSON.stringify(ps)}`);
      assert.strictEqual(app.value, 'probe-app');
      assert.ok(sp, `认证帧缺 search_path，实际 ${JSON.stringify(ps)}`);
      assert.strictEqual(sp.value, 'public');
      c.sock.destroy();
    });
  });

  // #386：bytea 文本结果按 hex 口径输出 `\x` + 小写十六进制
  await t('#386 bytea 文本输出为 \\x hex 转义', async () => {
    await withServer(async (srv) => {
      const c = await pgConnect(srv.address.port);
      c.sock.write(queryMsg('CREATE TABLE ba (payload BYTEA)'));
      await pgDrain(c.rd);
      c.sock.write(queryMsg("INSERT INTO ba VALUES ('abc')"));
      await pgDrain(c.rd);
      c.sock.write(queryMsg('SELECT payload FROM ba'));
      const frames = await pgDrain(c.rd);
      const dFrame = frames.find((f) => f.type === 0x44);
      assert.ok(dFrame, '未收到 DataRow');
      const vals = parseD(dFrame);
      assert.strictEqual(vals[0], '\\x616263', `bytea 值应为 \\x616263，实际 ${vals[0]}`);
      c.sock.destroy();
    });
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
