// #378: Parse 阶段必须校验 SQL，非法语句回 ErrorResponse 且不入库
const assert = require('assert');
const H = require('./issue-pg5-helper.js');
let passed = 0, failed = 0;
async function t(name, fn) {
  try { await fn(); passed++; console.log('ok - ' + name); }
  catch (e) { failed++; console.error('not ok - ' + name + '\n  ' + e.message); }
}
(async () => {
  await t('#378 Parse 非法 SQL 立即报错且不创建预处理语句', async () => {
    const h = await H.startServer();
    try {
      const c = await H.pgConnect(h.port);
      c.sock.write(H.parseMsg('bad', 'SELCT FROM WHERE )))', []));
      const first = await H.pgDrain(c.rd, 250);
      assert.strictEqual(first.filter((p) => p.type === 0x31).length, 0, 'no ParseComplete for invalid SQL');
      const err = first.find((p) => p.type === 0x45);
      assert.ok(err, 'expected ErrorResponse at Parse; frames=' + first.map((p) => p.type.toString(16)).join(','));
      assert.strictEqual(H.errorFields(err).C, '42601');
      c.sock.write(Buffer.concat([H.bindMsg('pb', 'bad', []), H.executeMsg('pb'), H.syncMsg()]));
      const second = await H.pgDrain(c.rd, 300);
      assert.strictEqual(second.filter((p) => p.type === 0x44).length, 0);
      const err2 = second.find((p) => p.type === 0x45);
      assert.ok(err2 && /bad/.test(H.errorFields(err2).M));
    } finally { h.close(); }
  });
  await t('#378 合法 SQL 仍回 ParseComplete', async () => {
    const h = await H.startServer();
    try {
      const c = await H.pgConnect(h.port);
      c.sock.write(H.parseMsg('ok', 'SELECT 1', []));
      const out = await H.pgDrain(c.rd, 250);
      assert.ok(out.some((p) => p.type === 0x31), 'valid Parse must return ParseComplete');
      assert.strictEqual(out.filter((p) => p.type === 0x45).length, 0);
    } finally { h.close(); }
  });
  console.log(`${passed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
})().catch((e) => { console.error(e); process.exitCode = 1; });
