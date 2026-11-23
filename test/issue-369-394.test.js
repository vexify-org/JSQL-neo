/*
 * Regression tests for #369 #389 #391 #393 #394（MySQL wire 协议）。
 * 真实 TCP socket + 真实协议帧驱动 createMysqlServer({ port: 0, noAuth: true })，
 * 不依赖 mysql2，也不直接断言内部函数。
 *   node test/issue-369-394.test.js
 */
const assert = require('assert');
const net = require('net');
const { createMysqlServer } = require('../lib/mysql_server.js');

let passed = 0, failed = 0;
async function t(name, fn) {
  try { await fn(); passed++; console.log(`ok - ${name}`); }
  catch (e) { failed++; console.error(`not ok - ${name}\n  ${e && e.message}`); }
}

// ---------- 极简 MySQL 协议客户端 ----------
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
  h.writeUIntLE(payload.length, 0, 3);
  h[3] = seq;
  return Buffer.concat([h, payload]);
}

// 带持久缓冲区的包读取器，应对一次 write 拼多个包的情况。
function makeReader(sock) {
  let buf = Buffer.alloc(0);
  let waiters = [];
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

async function rawConnect(port, loginOpts = {}) {
  const sock = net.connect(port, '127.0.0.1');
  await new Promise((res, rej) => { sock.once('connect', res); sock.once('error', rej); });
  const read = makeReader(sock);
  await read(); // handshake greeting
  let caps = CLIENT_PROTOCOL_41 | CLIENT_SECURE_CONNECTION | CLIENT_PLUGIN_AUTH |
    CLIENT_LONG_PASSWORD | CLIENT_TRANSACTIONS | CLIENT_MULTI_RESULTS | CLIENT_LONG_FLAG;
  if (loginOpts.db) caps |= CLIENT_CONNECT_WITH_DB;
  const body = Buffer.alloc(32);
  body.writeUInt32LE(caps, 0);
  body.writeUInt32LE(1024 * 1024, 4);
  body[8] = 0x2d;
  const parts = [body];
  parts.push(Buffer.from(loginOpts.user || 'root', 'utf8'), Buffer.from([0]));
  parts.push(Buffer.from([0])); // 空 auth response（lenenc 长度 0）
  if (loginOpts.db) parts.push(Buffer.from(loginOpts.db, 'utf8'), Buffer.from([0]));
  parts.push(Buffer.from('mysql_native_password'), Buffer.from([0]));
  sock.write(frame(Buffer.concat(parts), 1));
  const ack = await read();
  return { sock, read, ack };
}

async function drainResult(read, first = null) {
  const packets = [];
  let p = first || await read();
  const push = (pl) => packets.push({ seq: p.seq, tag: pl[0], raw: pl });
  let pl = p.payload;
  if (pl[0] === 0xff || pl[0] === 0x00) { push(pl); return packets; }
  let colCount = pl[0];
  if (colCount === 0xfc) colCount = pl.readUInt16LE(1);
  push(pl);
  for (let i = 0; i < colCount; i++) { p = await read(); push(p.payload); }
  if (colCount > 0) { p = await read(); push(p.payload); }
  for (;;) {
    p = await read(); pl = p.payload;
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
  const flags = unsigned ? 0x20 : 0;
  const head = Buffer.alloc(2); head.writeUInt16LE(type, 0); head[1] = flags;
  let body;
  switch (type) {
    case 0x01: body = Buffer.from([value & 0xff]); break;
    case 0x02: body = Buffer.alloc(2); body.writeUInt16LE(value & 0xffff); break;
    case 0x03: body = Buffer.alloc(4); body.writeUInt32LE(value >>> 0); break;
    case 0x08: body = Buffer.alloc(8); body.writeBigUInt64LE(BigInt(value)); break;
    case 0x05: body = Buffer.alloc(8); body.writeDoubleLE(value); break;
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

async function sendLongData(sock, stmtId, paramNo, chunk) {
  const head = Buffer.alloc(6);
  head.writeUInt32LE(stmtId, 0); head.writeUInt16LE(paramNo, 4);
  sock.write(frame(Buffer.concat([Buffer.from([0x18]), head, chunk]), 0));
}

async function stmtCommand(read, sock, cmd, stmtId) {
  const body = Buffer.alloc(4); body.writeUInt32LE(stmtId, 0);
  sock.write(frame(Buffer.concat([Buffer.from([cmd]), body]), 0));
  return read();
}

// 二进制结果行（单列 LONGLONG）：header 0x00 + nullBitmap 1 字节 + 8 字节
function binaryRowBigInt(packets) {
  const row = packets[packets.length - 2].raw;
  return row.readBigInt64LE(2);
}

// 文本结果行字段（lenenc 字符串）
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

// 列定义包：6 个 lenenc 字段 + 1 字节 fixedLen，其后 2 字节 charset
function colCharset(def) {
  let o = 0;
  const le = () => { const f = def[o++]; if (f < 0xfb) return f; const n = def.readUInt16LE(o); o += 2; return n; };
  for (let i = 0; i < 6; i++) { const l = le(); o += l; }
  o += 1;
  return def.readUInt16LE(o);
}

(async () => {
  // #369：COM_STMT_EXECUTE 必须按参数块 0x20 无符号标志解码，越界值不得变负
  await t('#369 预处理参数无符号标志（TINY/SHORT/LONG）按无符号解码', async () => {
    const srv = await startServer();
    const c = await rawConnect(srv.address.port);
    const cases = [
      [0x01, 200, 'TINY UNSIGNED'],
      [0x02, 60000, 'SHORT UNSIGNED'],
      [0x03, 3000000000, 'LONG UNSIGNED'],
    ];
    for (const [type, val, label] of cases) {
      const st = await prepare(c.read, c.sock, 'SELECT ? AS v');
      const r = await stmtExecute(c.read, c.sock, st.stmtId, [{ value: val, type, unsigned: true }]);
      const err = r.find(p => p.tag === 0xff);
      assert.ok(!err, `${label} 不应报错: ${err && err.raw.toString()}`);
      const got = Number(binaryRowBigInt(r));
      assert.strictEqual(got, val, `${label} sent=${val} 读回=${got}（修复前分别为 -56 / -5536 / -1294967296）`);
    }
    // 有符号路径不得回归：负数仍按 int8/int16/int32 解码
    const st2 = await prepare(c.read, c.sock, 'SELECT ? AS v');
    const r2 = await stmtExecute(c.read, c.sock, st2.stmtId, [{ value: -100, type: 0x02 }]);
    assert.strictEqual(Number(binaryRowBigInt(r2)), -100, '有符号 SHORT -100 必须读回 -100');
    c.sock.end();
    await new Promise(r => srv.close(r));
  });

  // #389：COM_STMT_SEND_LONG_DATA 分片必须累积并在 EXECUTE 时落库
  await t('#389 SEND_LONG_DATA 分片按序拼接进入预处理参数', async () => {
    const srv = await startServer();
    const c = await rawConnect(srv.address.port);
    await query(c.read, c.sock, 'CREATE TABLE t (id INT, txt TEXT)');
    const st = await prepare(c.read, c.sock, 'INSERT INTO t VALUES (?,?)');
    await sendLongData(c.sock, st.stmtId, 1, Buffer.from('CHUNK-A-'));
    await sendLongData(c.sock, st.stmtId, 1, Buffer.from('CHUNK-B'));
    const ins = await stmtExecute(c.read, c.sock, st.stmtId, [
      { value: 42, type: 0x03 },
      { value: '', type: 0xfd },
    ]);
    assert.ok(!ins.find(p => p.tag === 0xff), `INSERT 不应报错: ${ins.map(p => p.raw.toString('hex')).join(',')}`);
    const sel = await query(c.read, c.sock, 'SELECT id, txt FROM t');
    const row = sel[sel.length - 2].raw;
    const fields = textRowFields(row);
    assert.strictEqual(fields[0], '42', 'id 必须为 42');
    assert.strictEqual(fields[1], 'CHUNK-A-CHUNK-B', `txt 必须为两片长数据拼接值（修复前为空串），实际=${JSON.stringify(fields[1])}`);
    c.sock.end();
    await new Promise(r => srv.close(r));
  });

  // #391：COM_STMT_RESET 必须清空已绑定参数类型，旧 LONG 类型不得被下一次 EXECUTE 复用
  await t('#391 COM_STMT_RESET 清空参数绑定类型，重绑前 EXECUTE 报 1105', async () => {
    const srv = await startServer();
    const c = await rawConnect(srv.address.port);
    const st = await prepare(c.read, c.sock, 'SELECT ? AS v');
    const first = await stmtExecute(c.read, c.sock, st.stmtId, [{ value: 100, type: 0x03 }]);
    assert.ok(!first.find(p => p.tag === 0xff), '首次 EXECUTE 不应报错');
    const rst = await stmtCommand(c.read, c.sock, 0x1a, st.stmtId);
    assert.strictEqual(rst.payload[0], 0x00, 'RESET 必须回 OK 包');
    // new_params_bind_flag=0：类型块已被 RESET 清空，服务端必须报错而不是沿用旧 LONG 解码
    const r2 = await stmtExecute(c.read, c.sock, st.stmtId,
      [{ value: 'hello', type: 0xfd }], 0, { newBound: false });
    const err = r2.find(p => p.tag === 0xff);
    assert.ok(err, 'RESET 后未重绑类型的 EXECUTE 必须回 ERR 包（修复前回二进制垃圾行 1818585093）');
    assert.strictEqual(err.raw.readUInt16LE(1), 1105, `ERRNO 应为 1105，实际=${err.raw.readUInt16LE(1)}`);
    c.sock.end();
    await new Promise(r => srv.close(r));
  });

  // #393：SET NAMES latin1 必须切换会话字符集，列定义 charsetNr 与系统变量同步生效
  await t('#393 SET NAMES latin1 切换会话字符集（列定义 charsetNr=8，connection=latin1）', async () => {
    const srv = await startServer();
    const c = await rawConnect(srv.address.port);
    const set = await query(c.read, c.sock, 'SET NAMES latin1');
    assert.ok(!set.find(p => p.tag === 0xff), 'SET NAMES 不应报错');
    await query(c.read, c.sock, 'CREATE TABLE t (a VARCHAR(10))');
    const sel = await query(c.read, c.sock, 'SELECT a FROM t');
    const colDef = sel[1].raw;
    const charsetNr = colCharset(colDef);
    assert.strictEqual(charsetNr, 8, `列定义 charsetNr 应为 8 (latin1_swedish_ci)，实际=${charsetNr}（修复前恒为 45）`);
    const sv = await query(c.read, c.sock, "SHOW VARIABLES LIKE 'character_set_connection'");
    const svRow = sv[sv.length - 2].raw;
    const svFields = textRowFields(svRow);
    assert.strictEqual(svFields[1], 'latin1', `character_set_connection 应为 latin1，实际=${JSON.stringify(svFields[1])}（修复前为 utf8mb4）`);
    c.sock.end();
    await new Promise(r => srv.close(r));
  });

  // #394：握手登录不存在的数据库必须回 1049 Unknown database，不得隐式建库
  await t('#394 握手未知数据库回 ERR 1049，不再静默建库', async () => {
    const srv = await startServer();
    const c = await rawConnect(srv.address.port, { db: 'ghost_db_xyz' });
    const pl = c.ack.payload;
    assert.strictEqual(pl[0], 0xff, `握手应答必须是 ERR 包（0xff），实际 tag=0x${pl[0].toString(16)}（修复前为 OK 包 0x00）`);
    assert.strictEqual(pl.readUInt16LE(1), 1049, `errno 应为 1049，实际=${pl.readUInt16LE(1)}`);
    const msg = pl.slice(9).toString('utf8');
    assert.ok(/Unknown database 'ghost_db_xyz'/.test(msg), `错误消息应为 Unknown database，实际=${JSON.stringify(msg)}`);
    c.sock.end();
    await new Promise(r => srv.close(r));
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
