/* #555: 空查询 ERR 1065 的 SQLSTATE 必须是 42000（不是 HY000） */
const H = require('./issue-mysql-harness.js');
const { assert, frame, rawConnect, startServer, runner } = H;
const R = runner();

(async () => {
  await R.t('#555 空 COM_QUERY 回 1065/42000', async () => {
    const srv = await startServer();
    const c = await rawConnect(srv.address.port);
    c.sock.write(frame(Buffer.from([0x03]), 0));
    const p = await c.read();
    assert.ok(p, '应收到错误包');
    const pl = p.payload;
    assert.strictEqual(pl[0], 0xff, `应为 ERR 包，实际 tag=0x${pl[0].toString(16)}`);
    assert.strictEqual(pl.readUInt16LE(1), 1065, 'errno 应为 1065');
    assert.strictEqual(pl.slice(4, 9).toString('utf8'), '42000', 'SQLSTATE 应为 42000');
    assert.strictEqual(pl.slice(9).toString('utf8'), 'Query was empty');
    c.sock.end();
    await new Promise(r => srv.close(r));
  });
  R.done();
})().catch(e => { console.error(e); process.exit(1); });
