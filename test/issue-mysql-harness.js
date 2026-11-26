/*
 * MySQL 协议裸帧测试工具（mysql 组 issue 回归测试共用）。
 * 仅使用 net + 断言脚本，不依赖 mysql2。
 */
const assert = require('assert');
const net = require('net');
const { createMysqlServer } = require('../lib/mysql_server.js');

const CLIENT_PROTOCOL_41 = 0x0200;
const CLIENT_SECURE_CONNECTION = 0x8000;
const CLIENT_PLUGIN_AUTH = 0x80000;
const CLIENT_CONNECT_WITH_DB = 0x08;
const CLIENT_MULTI_RESULTS = 0x20000;
const CLIENT_LONG_FLAG = 0x04;
const CLIENT_LONG_PASSWORD = 0x01;
const CLIENT_TRANSACTIONS = 0x2000;

function frame(payload, seq) {
  const h = Buffer.alloc(4);
  h.writeUIntLE(Math.min(payload.length, 0xffffff), 0, 3);
  h[3] = seq;
  return Buffer.concat([h, payload]);
}

function makeReader(sock) {
  let buf = Buffer.alloc(0);
  const waiters = [];
  const pump = () => {
    while (waiters.length && buf.length >= 4) {
      const len = buf.readUIntLE(0, 3);
      if (buf.length < 4 + len) break;
      const p = { seq: buf[3], payload: buf.slice(4, 4 + len) };
      buf = buf.slice(4 + len);
      waiters.shift().resolve(p);
    }
  };
  sock.on('data', c => { buf = Buffer.concat([buf, c]); pump(); });
  sock.on('close', () => { while (waiters.length) waiters.shift().resolve(null); });
  return () => new Promise((resolve) => {
    const timer = setTimeout(() => {
      const i = waiters.indexOf(w);
      if (i >= 0) waiters.splice(i, 1);
      resolve(null);
    }, 2000);
    const w = { resolve: v => { clearTimeout(timer); resolve(v); } };
    waiters.push(w);
    pump();
  });
}

async function startServer(opts = {}) {
  const srv = createMysqlServer(Object.assign({ port: 0, host: '127.0.0.1', dataDir: ':memory:', noAuth: true }, opts));
  await new Promise(r => srv.listen(r));
  return srv;
}

async function connectRaw(port) {
  const sock = net.connect(port, '127.0.0.1');
  await new Promise((res, rej) => { sock.once('connect', res); sock.once('error', rej); });
  const read = makeReader(sock);
  const greeting = await read();
  return { sock, read, greeting };
}

function greetingConnectionId(greeting) {
  const pl = greeting.payload;
  const nul = pl.indexOf(0, 1);
  return pl.readUInt32LE(nul + 1);
}

async function login(c, loginOpts = {}) {
  let caps = CLIENT_PROTOCOL_41 | CLIENT_SECURE_CONNECTION | CLIENT_PLUGIN_AUTH |
    CLIENT_LONG_PASSWORD | CLIENT_TRANSACTIONS | CLIENT_MULTI_RESULTS | CLIENT_LONG_FLAG;
  if (loginOpts.db) caps |= CLIENT_CONNECT_WITH_DB;
  const body = Buffer.alloc(32);
  body.writeUInt32LE(caps, 0);
  body.writeUInt32LE(1024 * 1024, 4);
  body[8] = 0x2d;
  const parts = [body];
  parts.push(Buffer.from(loginOpts.user || 'root', 'utf8'), Buffer.from([0]));
  parts.push(Buffer.from([0]));
  if (loginOpts.db) parts.push(Buffer.from(loginOpts.db, 'utf8'), Buffer.from([0]));
  parts.push(Buffer.from('mysql_native_password'), Buffer.from([0]));
  c.sock.write(frame(Buffer.concat(parts), 1));
  return await c.read();
}

async function rawConnect(port, loginOpts = {}) {
  const c = await connectRaw(port);
  c.ack = await login(c, loginOpts);
  return c;
}

async function drainResult(read, first = null) {
  const packets = [];
  let p = first || await read();
  if (!p) return packets;
  const push = (pl) => packets.push({ seq: p.seq, tag: pl[0], raw: pl });
  let pl = p.payload;
  if (pl[0] === 0xff || pl[0] === 0x00) { push(pl); return packets; }
  let colCount = pl[0];
  if (colCount === 0xfc) colCount = pl.readUInt16LE(1);
  push(pl);
  for (let i = 0; i < colCount; i++) { p = await read(); if (!p) break; push(p.payload); }
  if (colCount > 0) { p = await read(); if (!p) return packets; push(p.payload); }
  for (;;) {
    p = await read(); if (!p) break; pl = p.payload;
    push(pl);
    if (pl[0] === 0xfe && pl.length < 9) break;
    if (pl[0] === 0xff) break;
  }
  return packets;
}

async function query(read, sock, sql) {
  sock.write(frame(Buffer.concat([Buffer.from([0x03]), Buffer.from(sql, 'utf8')]), 0));
  return drainResult(read);
}

async function command(read, sock, cmd, body = Buffer.alloc(0)) {
  sock.write(frame(Buffer.concat([Buffer.from([cmd]), body]), 0));
  return read();
}

async function prepare(read, sock, sql) {
  sock.write(frame(Buffer.concat([Buffer.from([0x16]), Buffer.from(sql, 'utf8')]), 0));
  const p = await read();
  const pl = p.payload;
  const stmtId = pl.readUInt32LE(1);
  const numCols = pl.readUInt16LE(5);
  const numParams = pl.readUInt16LE(7);
  const meta = { stmtId, numCols, numParams };
  for (let i = 0; i < numParams; i++) await read();
  if (numParams > 0) await read();
  for (let i = 0; i < numCols; i++) await read();
  if (numCols > 0) await read();
  return meta;
}

function encodeParam(value, type, unsigned = false) {
  const head = Buffer.alloc(2); head.writeUInt16LE(type, 0); head[1] = unsigned ? 0x20 : 0;
  let body;
  switch (type) {
    case 0x01: body = Buffer.from([value & 0xff]); break;
    case 0x02: body = Buffer.alloc(2); body.writeUInt16LE(value & 0xffff); break;
    case 0x03: body = Buffer.alloc(4); body.writeUInt32LE(value >>> 0); break;
    case 0x08: body = Buffer.alloc(8); body.writeBigUInt64LE(BigInt(value)); break;
    case 0x05: body = Buffer.alloc(8); body.writeDoubleLE(value); break;
    case 0x09: body = Buffer.alloc(3); body.writeUIntLE(value, 0, 3); break;
    case 0x0d: body = Buffer.alloc(2); body.writeUInt16LE(value & 0xffff); break;
    case 0x0e: {
      const m = String(value).match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}):(\d{2}))?/);
      body = Buffer.alloc(7);
      if (m) {
        body.writeUInt16LE(parseInt(m[1], 10), 0);
        body[2] = parseInt(m[2], 10); body[3] = parseInt(m[3], 10);
        body[4] = m[4] ? parseInt(m[4], 10) : 0;
        body[5] = m[5] ? parseInt(m[5], 10) : 0;
        body[6] = m[6] ? parseInt(m[6], 10) : 0;
      }
      break;
    }
    default: { const s = Buffer.from(String(value), 'utf8'); body = Buffer.concat([Buffer.from([s.length]), s]); }
  }
  return { head, body, isNull: value === null || value === undefined };
}

async function stmtExecute(read, sock, stmtId, params = [], flags = 0, opts = {}) {
  const n = params.length;
  const nullBitmap = Buffer.alloc(Math.ceil(n / 8));
  const head = Buffer.alloc(9);
  head.writeUInt32LE(stmtId, 0); head[4] = flags; head.writeUInt32LE(1, 5);
  const bodies = [];
  const heads = [];
  params.forEach((prm, i) => {
    const e = encodeParam(prm.value, prm.type, prm.unsigned);
    if (e.isNull) nullBitmap[Math.floor(i / 8)] |= (1 << (i % 8));
    heads.push(e.head);
    bodies.push(e.isNull ? Buffer.alloc(0) : e.body);
  });
  const sendTypes = opts.newBound !== false && n > 0;
  const newBound = n > 0 ? Buffer.from([sendTypes ? 0x01 : 0x00]) : Buffer.alloc(0);
  const typeBlock = sendTypes ? Buffer.concat(heads) : Buffer.alloc(0);
  const payload = Buffer.concat([Buffer.from([0x17]), head, nullBitmap, newBound, typeBlock, ...bodies]);
  sock.write(frame(payload, 0));
  return drainResult(read);
}

async function stmtCommand(read, sock, cmd, stmtId, extra = Buffer.alloc(0)) {
  const body = Buffer.concat([Buffer.from([cmd]), (() => { const b = Buffer.alloc(4); b.writeUInt32LE(stmtId, 0); return b; })(), extra]);
  sock.write(frame(body, 0));
  return read();
}

async function drainUntilEof(read, first = null) {
  const out = [];
  if (first) out.push(first);
  for (;;) {
    if (first && first.payload[0] === 0xfe && first.payload.length < 9) break;
    const p = await read();
    if (!p) break;
    out.push(p);
    if (p.payload[0] === 0xfe && p.payload.length < 9) break;
    if (p.payload[0] === 0xff) break;
  }
  return out;
}

function parseColDef(def) {
  let o = 0;
  const le = () => {
    const f = def[o++];
    if (f < 0xfb) return f;
    if (f === 0xfc) { const v = def.readUInt16LE(o); o += 2; return v; }
    if (f === 0xfd) { const v = def.readUIntLE(o, 3); o += 3; return v; }
    if (f === 0xfe) { const v = Number(def.readBigUInt64LE(o)); o += 8; return v; }
    return null;
  };
  for (let i = 0; i < 6; i++) { const len = le(); if (len !== null) o += len; }
  o += 1; // fixed-length field size (0x0c)
  const charset = def.readUInt16LE(o); o += 2;
  const length = def.readUInt32LE(o); o += 4;
  const type = def[o++];
  const flags = def.readUInt16LE(o);
  return { charset, length, type, flags };
}

function textRowFields(row) {
  const fields = [];
  let o = 0;
  while (o < row.length) {
    const l = row[o++];
    fields.push(row.slice(o, o + l).toString('utf8'));
    o += l;
  }
  return fields;
}

function binaryRowBigInt(packets) {
  const row = packets[packets.length - 2].raw;
  return row.readBigInt64LE(2);
}

function runner() {
  let passed = 0, failed = 0;
  return {
    async t(name, fn) {
      try { await fn(); passed++; console.log(`ok - ${name}`); }
      catch (e) { failed++; console.error(`not ok - ${name}\n  ${(e && e.stack) || e}`); }
    },
    done() { console.log(`\n${passed} passed, ${failed} failed`); process.exit(failed ? 1 : 0); },
  };
}

module.exports = {
  assert, frame, makeReader, startServer, connectRaw, rawConnect, login,
  greetingConnectionId, drainResult, drainUntilEof, query, command, prepare,
  stmtExecute, stmtCommand, encodeParam, parseColDef, textRowFields,
  binaryRowBigInt, runner,
};
