/* #554: TINYINT/SMALLINT 列定义必须通告 TINY(0x01)/SHORT(0x02) 类型码 */
const H = require('./issue-mysql-harness.js');
const { assert, rawConnect, startServer, query, prepare, stmtExecute, parseColDef, runner } = H;
const R = runner();

(async () => {
  await R.t('#554 TINYINT/SMALLINT/INT/BIGINT 列类型码', async () => {
    const srv = await startServer();
    const c = await rawConnect(srv.address.port);
    await query(c.read, c.sock, 'CREATE TABLE it (a TINYINT, b SMALLINT, c INT, d BIGINT)');
    await query(c.read, c.sock, 'INSERT INTO it VALUES (7, 300, 9, 9000000000)');
    const res = await query(c.read, c.sock, 'SELECT a, b, c, d FROM it');
    const defs = res.filter(p => p.raw.length > 12 && p.raw[0] === 3 && p.raw[1] === 0x64).map(p => parseColDef(p.raw));
    assert.strictEqual(defs.length, 4, `应解析到 4 个列定义，实际=${defs.length}`);
    assert.strictEqual(defs[0].type, 0x01, `a(TINYINT) 应为 0x01，实际=0x${defs[0].type.toString(16)}`);
    assert.strictEqual(defs[1].type, 0x02, `b(SMALLINT) 应为 0x02，实际=0x${defs[1].type.toString(16)}`);
    assert.strictEqual(defs[2].type, 0x03, `c(INT) 应为 0x03，实际=0x${defs[2].type.toString(16)}`);
    assert.strictEqual(defs[3].type, 0x08, `d(BIGINT) 应为 0x08，实际=0x${defs[3].type.toString(16)}`);
    // 二进制结果集必须按新类型码的宽度编码，TINYINT 7 不能被布尔化成 1
    const st = await prepare(c.read, c.sock, 'SELECT a, b, c, d FROM it');
    const r = await stmtExecute(c.read, c.sock, st.stmtId, []);
    const row = r[r.length - 2].raw;
    assert.strictEqual(row[2], 7, 'TINYINT 7 应按 1 字节写入');
    assert.strictEqual(row.readInt16LE(3), 300, 'SMALLINT 300 应按 2 字节写入');
    c.sock.end();
    await new Promise(r => srv.close(r));
  });
  R.done();
})().catch(e => { console.error(e); process.exit(1); });
