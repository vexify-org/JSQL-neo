/* #425: SSLRequest（无凭据 32 字节包）不得被当成登录成功 */
const H = require('./issue-mysql-harness.js');
const { assert, frame, connectRaw, startServer, runner } = H;
const R = runner();

(async () => {
  await R.t('#425 SSLRequest 回 ERR，不进入认证态', async () => {
    const srv = await startServer();
    const c = await connectRaw(srv.address.port);
    const body = Buffer.alloc(32);
    body.writeUInt32LE(0x0200 | 0x8000 | 0x0800, 0); // CLIENT_SSL
    body.writeUInt32LE(1024 * 1024, 4);
    body[8] = 0x2d;
    c.sock.write(frame(body, 1));
    const p = await c.read();
    assert.ok(p, '应收到 SSLRequest 应答');
    assert.strictEqual(p.payload[0], 0xff, `SSLRequest 必须回 ERR 包（修复前回 OK 0x00），实际=0x${p.payload[0].toString(16)}`);
    c.sock.end();
    await new Promise(r => srv.close(r));
  });
  R.done();
})().catch(e => { console.error(e); process.exit(1); });
