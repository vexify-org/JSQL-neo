/* #408: 大包处理 —— 超限回 1153、入站分片重组、出站 16MB 切分 */
const H = require('./issue-mysql-harness.js');
const { assert, frame, rawConnect, query, startServer, runner } = H;
const { MysqlConnection, createMysqlServer } = require('../lib/mysql_server.js');
const { EventEmitter } = require('events');
const R = runner();

function fakeConn(maxPacketSize = 32 * 1024 * 1024) {
  const srv = createMysqlServer({ dataDir: ':memory:', noAuth: true, maxPacketSize });
  const chunks = [];
  const fake = new EventEmitter();
  fake.write = (b) => { chunks.push(Buffer.from(b)); return true; };
  fake.destroy = () => {};
  fake.writable = true;
  fake.remoteAddress = '127.0.0.1';
  const conn = new MysqlConnection(fake, srv);
  return { srv, conn, chunks };
}

(async () => {
  await R.t('#408 超限包先回 ERR 1153，不直接断连', async () => {
    const srv = await startServer();
    const c = await rawConnect(srv.address.port);
    const big = 'x'.repeat(1.1 * 1024 * 1024 | 0);
    c.sock.write(frameFor(Buffer.concat([Buffer.from([0x03]), Buffer.from("SELECT '" + big + "'")])));
    const p = await c.read();
    assert.ok(p, '超大包应收到 ERR 包，而不是连接被重置（修复前无应答）');
    assert.strictEqual(p.payload[0], 0xff, '应为 ERR 包');
    assert.strictEqual(p.payload.readUInt16LE(1), 1153, `errno 应为 1153，实际=${p.payload.readUInt16LE(1)}`);
    c.sock.end();
    await new Promise(r => srv.close(r));
  });

  await R.t('#408 入站 0xffffff 分片重组为一个命令包', async () => {
    const { conn } = fakeConn();
    conn.authenticated = true;
    let captured = null;
    conn._handlePacket = (payload, seq) => { captured = { payload, seq }; };
    const f1 = Buffer.alloc(0xffffff, 0x78);
    const f2 = Buffer.from('12345');
    conn._onData(frame(f1, 0));
    conn._onData(frame(f2, 1));
    assert.ok(captured, '分片收齐后应交由 _handlePacket');
    assert.strictEqual(captured.payload.length, 0xffffff + 5, '应重组为完整载荷');
    assert.strictEqual(captured.payload.slice(-5).toString('utf8'), '12345');
    assert.strictEqual(captured.seq, 1, '应答序号应基于最后一片');
  });

  await R.t('#408 出站 16MB+ 缓冲按 0xffffff 切分组包', async () => {
    const { conn, chunks } = fakeConn();
    chunks.length = 0; // 排除构造时的握手包
    conn.sequence = 0;
    conn._send(Buffer.alloc(0xffffff + 10, 0x61));
    const buf = Buffer.concat(chunks);
    const lens = [], seqs = [];
    let o = 0;
    while (o + 4 <= buf.length) {
      lens.push(buf.readUIntLE(o, 3)); seqs.push(buf[o + 3]);
      o += 4 + lens[lens.length - 1];
    }
    assert.deepStrictEqual(lens, [0xffffff, 10], `分片长度应为 [0xffffff,10]，实际=${JSON.stringify(lens)}`);
    assert.deepStrictEqual(seqs, [0, 1], '序号应递增');
  });

  await R.t('#408 大结果集行包出站切分（端到端）', async () => {
    const srv = await startServer({ maxPacketSize: 32 * 1024 * 1024 });
    const c = await rawConnect(srv.address.port);
    await query(c.read, c.sock, 'CREATE TABLE bigv (v TEXT)');
    const big = 'y'.repeat(17 * 1024 * 1024);
    const payload = Buffer.concat([Buffer.from([0x03]), Buffer.from("INSERT INTO bigv VALUES ('" + big + "')")]);
    let off = 0, seq = 0;
    while (off < payload.length) {
      const part = payload.slice(off, off + 0xffffff);
      c.sock.write(frame(part, seq++));
      off += part.length;
    }
    const ins = await c.read();
    assert.strictEqual(ins.payload[0], 0x00, '大包 INSERT 应成功（入站分片重组）');
    const res = await query(c.read, c.sock, 'SELECT v FROM bigv');
    assert.ok(res.some(p => p.raw.length === 0xffffff), '大行应被切成 0xffffff 长度的片包');
    c.sock.end();
    await new Promise(r => srv.close(r));
  });
  R.done();
})().catch(e => { console.error(e); process.exit(1); });

function frameFor(payload, seq = 0) {
  const h = Buffer.alloc(4);
  h.writeUIntLE(payload.length, 0, 3);
  h[3] = seq;
  return Buffer.concat([h, payload]);
}
