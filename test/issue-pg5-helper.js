// pg 协议 issue 修复组（#556 等）共用的极简 PG v3 客户端
const net = require('net');
const { createPgServer } = require('../lib/pg_server.js');

function pgStartup(user = 'postgres', database = 'app', extra = {}) {
  const parts = [];
  for (const [k, v] of Object.entries({ user, database, ...extra })) parts.push(Buffer.from(k + '\0' + v + '\0'));
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
const cstr = (s) => Buffer.from(String(s) + '\0', 'utf8');
const i16 = (v) => { const b = Buffer.alloc(2); b.writeInt16BE(v, 0); return b; };
const i32 = (v) => { const b = Buffer.alloc(4); b.writeInt32BE(v, 0); return b; };

function queryMsg(sql) { return pgMsg(0x51, Buffer.from(String(sql) + '\0', 'utf8')); }
function parseMsg(name, sql, paramTypes = []) {
  return pgMsg(0x50, Buffer.concat([cstr(name), cstr(sql), i16(paramTypes.length), ...paramTypes.map(i32)]));
}
function bindMsg(portal, stmt, values = [], opts = {}) {
  const inFormats = opts.inFormats || [];
  const outFormats = opts.outFormats || [];
  const parts = [cstr(portal), cstr(stmt), i16(inFormats.length), ...inFormats.map(i16), i16(values.length)];
  for (const v of values) {
    if (v === null || v === undefined) { parts.push(i32(-1)); continue; }
    const b = Buffer.isBuffer(v) ? v : Buffer.from(String(v), 'utf8');
    parts.push(i32(b.length), b);
  }
  parts.push(i16(outFormats.length), ...outFormats.map(i16));
  return pgMsg(0x42, Buffer.concat(parts));
}
function executeMsg(portal, maxRows = 0) { return pgMsg(0x45, Buffer.concat([cstr(portal), i32(maxRows)])); }
function syncMsg() { return pgMsg(0x53, Buffer.alloc(0)); }
function closeMsg(kind, name) { return pgMsg(0x43, Buffer.concat([Buffer.from([kind]), cstr(name)])); }
function describeMsg(kind, name) { return pgMsg(0x44, Buffer.concat([Buffer.from([kind]), cstr(name)])); }
function copyDataMsg(text) { return pgMsg(0x64, Buffer.from(String(text), 'utf8')); }
function copyDoneMsg() { return pgMsg(0x63, Buffer.alloc(0)); }
function copyFailMsg(text) { return pgMsg(0x66, Buffer.concat([Buffer.from(String(text) + '\0', 'utf8')])); }

function pgReader(sock) {
  let buf = Buffer.alloc(0); const waiters = [];
  sock.on('data', (c) => { buf = Buffer.concat([buf, c]); pump(); });
  sock.on('close', () => { while (waiters.length) waiters.shift()(null); });
  function pump() {
    while (waiters.length && buf.length >= 5) {
      const len = buf.readInt32BE(1);
      if (buf.length < 1 + len) break;
      waiters.shift()({ type: buf[0], payload: buf.slice(5, 1 + len) });
      buf = buf.slice(1 + len);
    }
  }
  return {
    read(ms = 150) {
      return new Promise((res) => {
        let done = false;
        const w = (p) => { if (!done) { done = true; clearTimeout(tm); res(p); } };
        const tm = setTimeout(() => { const i = waiters.indexOf(w); if (i >= 0) waiters.splice(i, 1); w(null); }, ms);
        waiters.push(w); pump();
      });
    }
  };
}
async function pgConnect(port, opts = {}) {
  const sock = net.connect(port, '127.0.0.1');
  await new Promise((r, j) => { sock.once('connect', r); sock.once('error', j); });
  const rd = pgReader(sock);
  sock.write(pgStartup(opts.user || 'postgres', opts.database || 'app', opts.params || {}));
  const auth = [];
  for (;;) { const p = await rd.read(1500); if (!p || p.type === 0x5a) break; auth.push(p); }
  return { sock, rd, auth };
}
async function pgDrain(rd, ms = 120) {
  const out = [];
  for (;;) { const p = await rd.read(ms); if (!p) break; out.push(p); }
  return out;
}
function errorFields(p) {
  const b = p.payload, f = {}; let i = 0;
  while (i < b.length && b[i] !== 0) {
    const k = String.fromCharCode(b[i]); const e = b.indexOf(0, i + 1);
    if (e < 0) break;
    f[k] = b.toString('utf8', i + 1, e); i = e + 1;
  }
  return f;
}
function commandTags(out) {
  return out.filter((p) => p.type === 0x43).map((p) => p.payload.slice(0, -1).toString('utf8'));
}
function textValues(dataRow) {
  const b = dataRow.payload; let off = 0;
  const n = b.readInt16BE(off); off += 2;
  const vals = [];
  for (let i = 0; i < n; i++) {
    const len = b.readInt32BE(off); off += 4;
    vals.push(len === -1 ? null : b.toString('utf8', off, off + len));
    off += Math.max(len, 0);
  }
  return vals;
}
async function startServer(opts = {}) {
  const srv = createPgServer({ port: 0, host: '127.0.0.1', dataDir: ':memory:', noAuth: true, ...opts });
  await new Promise((r) => srv.listen(r));
  return {
    srv,
    port: srv.address.port,
    close() { srv.close(); }
  };
}
function sendCancelRequest(port, pid, secret) {
  return new Promise((resolve) => {
    const sock = net.connect(port, '127.0.0.1', () => {
      const b = Buffer.alloc(16);
      b.writeInt32BE(16, 0); b.writeInt32BE(80877102, 4);
      b.writeInt32BE(pid, 8); b.writeInt32BE(secret >>> 0, 12);
      sock.write(b);
    });
    // 服务端处理完 CancelRequest 会关闭连接，以 close 为准避免竞态
    sock.once('close', resolve);
    sock.once('error', resolve);
  });
}

module.exports = {
  pgStartup, pgMsg, cstr, i16, i32, queryMsg, parseMsg, bindMsg, executeMsg, syncMsg,
  closeMsg, describeMsg, copyDataMsg, copyDoneMsg, copyFailMsg, pgReader, pgConnect,
  pgDrain, errorFields, commandTags, textValues, startServer, sendCancelRequest
};
