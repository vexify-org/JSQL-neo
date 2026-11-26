/* #373: 服务端游标 —— EXECUTE 只回元数据，COM_STMT_FETCH 分批取行 */
const H = require('./issue-mysql-harness.js');
const { assert, query, prepare, stmtExecute, stmtCommand, drainUntilEof, rawConnect, startServer, runner } = H;
const R = runner();

(async () => {
  await R.t('#373 READ_ONLY 游标：EXECUTE 元数据 + FETCH 分批', async () => {
    const srv = await startServer();
    const c = await rawConnect(srv.address.port);
    await query(c.read, c.sock, 'CREATE TABLE t (id INT)');
    await query(c.read, c.sock, 'INSERT INTO t VALUES (1),(2),(3)');
    const st = await prepare(c.read, c.sock, 'SELECT * FROM t');
    const exec = await stmtExecute(c.read, c.sock, st.stmtId, [], 0x01); // CURSOR_TYPE_READ_ONLY
    const err = exec.find(p => p.tag === 0xff);
    assert.ok(!err, `EXECUTE 不应报错: ${err && err.raw.slice(9).toString()}`);
    const rowsInExec = exec.filter(p => p.raw[0] === 0x00 && p.raw.length > 2);
    assert.strictEqual(rowsInExec.length, 0, `游标 EXECUTE 不应回数据行，实际 ${rowsInExec.length} 行`);

    const num = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n, 0); return b; };
    let f = await stmtCommand(c.read, c.sock, 0x1c, st.stmtId, num(2));
    assert.ok(f, 'FETCH 应收到应答');
    assert.notStrictEqual(f.payload[0], 0xff, `FETCH 不应回 ERR 1105，实际 errno=${f.payload.readUInt16LE(1)}`);
    let batch = await drainUntilEof(c.read, f);
    let gotRows = batch.filter(p => p.payload[0] === 0x00 && p.payload.length > 2).length;
    assert.strictEqual(gotRows, 2, `首次 FETCH 应回 2 行，实际 ${gotRows}`);

    f = await stmtCommand(c.read, c.sock, 0x1c, st.stmtId, num(2));
    batch = await drainUntilEof(c.read, f);
    gotRows = batch.filter(p => p.payload[0] === 0x00 && p.payload.length > 2).length;
    assert.strictEqual(gotRows, 1, `第二次 FETCH 应回剩余 1 行，实际 ${gotRows}`);

    f = await stmtCommand(c.read, c.sock, 0x1c, st.stmtId, num(2));
    batch = await drainUntilEof(c.read, f);
    gotRows = batch.filter(p => p.payload[0] === 0x00 && p.payload.length > 2).length;
    assert.strictEqual(gotRows, 0, `耗尽后 FETCH 应回 0 行 + EOF，实际 ${gotRows}`);
    c.sock.end();
    await new Promise(r => srv.close(r));
  });
  R.done();
})().catch(e => { console.error(e); process.exit(1); });
