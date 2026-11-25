/* #490: UNIQUE 列必须置 UNIQUE_KEY(0x0004) 列标志位 */
const H = require('./issue-mysql-harness.js');
const { assert, rawConnect, startServer, query, parseColDef, runner } = H;
const R = runner();

(async () => {
  await R.t('#490 UNIQUE 列标志位 0x0004', async () => {
    const srv = await startServer();
    const c = await rawConnect(srv.address.port);
    await query(c.read, c.sock, 'CREATE TABLE r2 (id INT PRIMARY KEY, u VARCHAR(10) UNIQUE)');
    await query(c.read, c.sock, "INSERT INTO r2 VALUES (1, 'abc')");
    const res = await query(c.read, c.sock, 'SELECT * FROM r2');
    const defs = res.filter(p => p.raw.length > 12 && p.raw[0] === 3 && p.raw[1] === 0x64).map(p => parseColDef(p.raw));
    assert.strictEqual(defs.length, 2, `应有 2 个列定义，实际=${defs.length}`);
    assert.ok(defs[1].flags & 0x0004, `u(UNIQUE) 应置 UNIQUE_KEY 0x0004，实际 flags=0x${defs[1].flags.toString(16)}`);
    c.sock.end();
    await new Promise(r => srv.close(r));
  });
  R.done();
})().catch(e => { console.error(e); process.exit(1); });
