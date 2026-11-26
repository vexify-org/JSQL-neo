/* #426: 二进制结果集结尾 EOF 必须回显 status（IN_TRANS 等） */
const H = require('./issue-mysql-harness.js');
const { assert, query, prepare, stmtExecute, rawConnect, startServer, runner } = H;
const R = runner();

(async () => {
  await R.t('#426 二进制结尾 EOF 回显 IN_TRANS 状态位', async () => {
    const srv = await startServer();
    const c = await rawConnect(srv.address.port);
    await query(c.read, c.sock, 'BEGIN');
    const st = await prepare(c.read, c.sock, 'SELECT 1 AS v');
    const r = await stmtExecute(c.read, c.sock, st.stmtId, []);
    const eofs = r.filter(p => p.raw[0] === 0xfe && p.raw.length < 9);
    assert.strictEqual(eofs.length, 2, `应有 2 个 EOF，实际=${eofs.length}`);
    assert.strictEqual(eofs[0].raw.readUInt16LE(3), 0x0003, `列定义 EOF status 应为 0x0003`);
    assert.strictEqual(eofs[1].raw.readUInt16LE(3), 0x0003, `结尾 EOF status 应为 0x0003（修复前为 0x0002）`);
    await query(c.read, c.sock, 'ROLLBACK');
    c.sock.end();
    await new Promise(r => srv.close(r));
  });
  R.done();
})().catch(e => { console.error(e); process.exit(1); });
