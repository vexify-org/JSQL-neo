/* #424: COM_STMT_EXECUTE 必须支持 INT24(9)/YEAR(13)/NEWDATE(14) 定宽参数 */
const H = require('./issue-mysql-harness.js');
const { assert, prepare, stmtExecute, rawConnect, startServer, binaryRowBigInt, runner } = H;
const R = runner();

(async () => {
  await R.t('#424 YEAR(0x0d) 参数按 2 字节解码', async () => {
    const srv = await startServer();
    const c = await rawConnect(srv.address.port);
    const st = await prepare(c.read, c.sock, 'SELECT ? AS v');
    const r = await stmtExecute(c.read, c.sock, st.stmtId, [{ value: 2025, type: 0x0d }]);
    const err = r.find(p => p.tag === 0xff);
    assert.ok(!err, `YEAR 不应报错: ${err && err.raw.slice(9).toString()}`);
    assert.strictEqual(Number(binaryRowBigInt(r)), 2025, `YEAR 2025 应读回 2025（修复前为 7）`);
    c.sock.end();
    await new Promise(r => srv.close(r));
  });

  await R.t('#424 INT24(0x09) 参数按 3 字节解码', async () => {
    const srv = await startServer();
    const c = await rawConnect(srv.address.port);
    const st = await prepare(c.read, c.sock, 'SELECT ? AS v');
    const r = await stmtExecute(c.read, c.sock, st.stmtId, [{ value: 16777215, type: 0x09 }]);
    const err = r.find(p => p.tag === 0xff);
    assert.ok(!err, `INT24 不应报错: ${err && err.raw.slice(9).toString()}`);
    assert.strictEqual(Number(binaryRowBigInt(r)), 16777215, 'INT24 16777215 应原样读回');
    c.sock.end();
    await new Promise(r => srv.close(r));
  });

  await R.t('#424 NEWDATE(0x0e) 参数按 7 字节日期解码', async () => {
    const srv = await startServer();
    const c = await rawConnect(srv.address.port);
    const st = await prepare(c.read, c.sock, 'SELECT ? AS v');
    const r = await stmtExecute(c.read, c.sock, st.stmtId, [{ value: '2024-03-04 05:06:07', type: 0x0e }]);
    const err = r.find(p => p.tag === 0xff);
    assert.ok(!err, `NEWDATE 不应报错: ${err && err.raw.slice(9).toString()}`);
    const row = r[r.length - 2].raw;
    assert.ok(row.includes(Buffer.from('2024-03-04')), `NEWDATE 行应含 2024-03-04，实际=${row.toString('hex')}`);
    c.sock.end();
    await new Promise(r => srv.close(r));
  });
  R.done();
})().catch(e => { console.error(e); process.exit(1); });
