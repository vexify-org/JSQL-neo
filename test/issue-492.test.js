/* #492: COM_STATISTICS 必须回统计字符串包，而不是 OK 包 */
const H = require('./issue-mysql-harness.js');
const { assert, command, rawConnect, startServer, runner } = H;
const R = runner();

(async () => {
  await R.t('#492 COM_STATISTICS 回字符串统计包', async () => {
    const srv = await startServer();
    const c = await rawConnect(srv.address.port);
    const p = await command(c.read, c.sock, 0x09);
    assert.ok(p, '应收到 COM_STATISTICS 应答');
    assert.ok(p.payload[0] !== 0x00 && p.payload[0] !== 0xff, `首字节不应是 OK/ERR 包标记（修复前为 0x00），实际=0x${p.payload[0].toString(16)}`);
    const stats = p.payload.toString('utf8');
    assert.ok(/Uptime:/.test(stats) && /Questions:/.test(stats), `载荷应为统计字符串，实际=${JSON.stringify(stats)}`);
    c.sock.end();
    await new Promise(r => srv.close(r));
  });
  R.done();
})().catch(e => { console.error(e); process.exit(1); });
