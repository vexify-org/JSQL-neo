/* #497: SELECT * FROM mysql.user 必须返回虚拟元数据结果，而不是 1146 */
const H = require('./issue-mysql-harness.js');
const { assert, rawConnect, startServer, query, textRowFields, runner } = H;
const R = runner();

(async () => {
  await R.t('#497 mysql.user 虚拟表可查询', async () => {
    const srv = await startServer();
    const c = await rawConnect(srv.address.port);
    const res = await query(c.read, c.sock, 'SELECT * FROM mysql.user');
    const err = res.find(p => p.tag === 0xff);
    assert.ok(!err, `mysql.user 不应报 1146，实际 errno=${err && err.raw.readUInt16LE(1)} msg=${err && err.raw.slice(9).toString()}`);
    const cols = res.filter(p => p.raw.length > 12 && p.raw[0] === 3 && p.raw[1] === 0x64).map(p => parseName(p.raw));
    assert.deepStrictEqual(cols, ['User', 'Host', 'authentication_string'], `列应为 User/Host/authentication_string，实际=${JSON.stringify(cols)}`);
    const rows = res.filter(p => p.raw[0] !== 0xfe && p.raw[0] !== 0xff && p.raw[0] !== 3 && p.raw.length > 0 && p.raw[1] === 0x64);
    c.sock.end();
    await new Promise(r => srv.close(r));
  });
  R.done();
})().catch(e => { console.error(e); process.exit(1); });

function parseName(def) {
  let o = 0;
  const le = () => { const f = def[o++]; if (f < 0xfb) return f; const n = def.readUInt16LE(o); o += 2; return n; };
  for (let i = 0; i < 4; i++) { const l = le(); if (l !== null) o += l; }
  const l = le();
  const s = def.slice(o, o + l).toString('utf8');
  return s;
}
