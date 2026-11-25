// #370: COPY TO STDOUT / FROM STDIN 子协议帧（H/d/c 与 G/d/c）
const assert = require('assert');
const H = require('./issue-pg5-helper.js');
let passed = 0, failed = 0;
async function t(name, fn) {
  try { await fn(); passed++; console.log('ok - ' + name); }
  catch (e) { failed++; console.error('not ok - ' + name + '\n  ' + e.message); }
}
(async () => {
  await t('#370 COPY TO STDOUT 发 H/d/c 与 CommandComplete', async () => {
    const h = await H.startServer();
    try {
      const c = await H.pgConnect(h.port);
      c.sock.write(H.queryMsg('CREATE TABLE c1 (id INTEGER, name TEXT)')); await H.pgDrain(c.rd);
      c.sock.write(H.queryMsg("INSERT INTO c1 VALUES (1, 'a')")); await H.pgDrain(c.rd);
      c.sock.write(H.queryMsg('COPY c1 TO STDOUT'));
      const out = await H.pgDrain(c.rd, 300);
      assert.ok(out.some((p) => p.type === 0x48), 'expected CopyOutResponse(H); frames=' + out.map((p) => p.type.toString(16)).join(','));
      const data = out.filter((p) => p.type === 0x64).map((p) => p.payload.toString('utf8')).join('');
      assert.ok(data.includes('1\ta'), 'expected row payload, got ' + JSON.stringify(data));
      assert.ok(out.some((p) => p.type === 0x63), 'expected CopyDone(c)');
      assert.ok(H.commandTags(out).some((tag) => /^COPY/.test(tag)), 'expected COPY tag');
    } finally { h.close(); }
  });
  await t('#370 COPY FROM STDIN 发 G 并接收 d/c', async () => {
    const h = await H.startServer();
    try {
      const c = await H.pgConnect(h.port);
      c.sock.write(H.queryMsg('CREATE TABLE c2 (id INTEGER, name TEXT)')); await H.pgDrain(c.rd);
      c.sock.write(H.queryMsg('COPY c2 FROM STDIN'));
      const first = await H.pgDrain(c.rd, 200);
      assert.ok(first.some((p) => p.type === 0x47), 'expected CopyInResponse(G); frames=' + first.map((p) => p.type.toString(16)).join(','));
      c.sock.write(Buffer.concat([H.copyDataMsg('2\tb\n'), H.copyDoneMsg()]));
      const out = await H.pgDrain(c.rd, 300);
      assert.ok(H.commandTags(out).some((tag) => /^COPY/.test(tag)), 'expected COPY tag after CopyDone');
      c.sock.write(H.queryMsg('SELECT id, name FROM c2'));
      const rows = (await H.pgDrain(c.rd, 300)).filter((p) => p.type === 0x44).map(H.textValues);
      assert.deepStrictEqual(rows, [['2', 'b']]);
    } finally { h.close(); }
  });
  console.log(`${passed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
})().catch((e) => { console.error(e); process.exitCode = 1; });
