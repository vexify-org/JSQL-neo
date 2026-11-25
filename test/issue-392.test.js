/* #392: COM_PROCESS_KILL(0x0d) 必须按 connection_id 终止会话并回 OK */
const H = require('./issue-mysql-harness.js');
const { assert, frame, rawConnect, connectRaw, greetingConnectionId, startServer, runner } = H;
const R = runner();

(async () => {
  await R.t('#392 KILL 目标连接 → OK 且目标断开', async () => {
    const srv = await startServer();
    const c1 = await rawConnect(srv.address.port);
    const c2 = await connectRaw(srv.address.port);
    await H.login(c2);
    const targetId = greetingConnectionId(c2.greeting);
    assert.ok(targetId > 0, '目标连接 id 应大于 0');
    const body = Buffer.alloc(4); body.writeUInt32LE(targetId, 0);
    c1.sock.write(frame(Buffer.concat([Buffer.from([0x0d]), body]), 0));
    const p = await c1.read();
    assert.ok(p, 'KILL 应收到应答');
    assert.strictEqual(p.payload[0], 0x00, `KILL 应回 OK 包（修复前回 ERR 1105），实际=0x${p.payload[0].toString(16)}`);
    const gone = await c2.read(1000);
    assert.strictEqual(gone, null, '目标连接应被终止');
    c1.sock.end();
    await new Promise(r => srv.close(r));
  });
  R.done();
})().catch(e => { console.error(e); process.exit(1); });
