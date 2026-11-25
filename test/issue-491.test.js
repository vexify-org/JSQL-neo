/* #491: TEXT 列必须通告 BLOB(0xfc) 类型码并置 BLOB_FLAG(0x0010) */
const H = require('./issue-mysql-harness.js');
const { assert, rawConnect, startServer, query, parseColDef, runner } = H;
const R = runner();

(async () => {
  await R.t('#491 TEXT 列类型码/BLOB 标志位', async () => {
    const srv = await startServer();
    const c = await rawConnect(srv.address.port);
    await query(c.read, c.sock, 'CREATE TABLE r3 (id INT, body TEXT)');
    await query(c.read, c.sock, "INSERT INTO r3 VALUES (1, 'hello')");
    const res = await query(c.read, c.sock, 'SELECT * FROM r3');
    const defs = res.filter(p => p.raw.length > 12 && p.raw[0] === 3 && p.raw[1] === 0x64).map(p => parseColDef(p.raw));
    assert.strictEqual(defs.length, 2, `应有 2 个列定义，实际=${defs.length}`);
    assert.strictEqual(defs[1].type, 0xfc, `body(TEXT) 类型码应为 0xfc，实际=0x${defs[1].type.toString(16)}`);
    assert.ok(defs[1].flags & 0x0010, `body(TEXT) 应置 BLOB_FLAG 0x0010，实际 flags=0x${defs[1].flags.toString(16)}`);
    c.sock.end();
    await new Promise(r => srv.close(r));
  });
  R.done();
})().catch(e => { console.error(e); process.exit(1); });
