// #374: 二进制结果编码 numeric/date/timestamp/uuid/bytea 必须按 PG 二进制格式
const assert = require('assert');
const H = require('./issue-pg5-helper.js');
let passed = 0, failed = 0;
async function t(name, fn) {
  try { await fn(); passed++; console.log('ok - ' + name); }
  catch (e) { failed++; console.error('not ok - ' + name + '\n  ' + e.message); }
}
function columnsOf(dataRow) {
  const b = dataRow.payload; let off = 0;
  const n = b.readInt16BE(off); off += 2;
  const cols = [];
  for (let i = 0; i < n; i++) {
    const len = b.readInt32BE(off); off += 4;
    cols.push(b.slice(off, off + len)); off += Math.max(len, 0);
  }
  return cols;
}
(async () => {
  await t('#374 binary DataRow 按类型编码', async () => {
    const h = await H.startServer();
    try {
      const c = await H.pgConnect(h.port);
      c.sock.write(H.queryMsg('CREATE TABLE z (a NUMERIC, d DATE, t TIMESTAMP, g BOOLEAN, k UUID, b BYTEA)'));
      await H.pgDrain(c.rd);
      c.sock.write(H.queryMsg("INSERT INTO z VALUES (4.5, '2024-01-02', '2024-01-02 03:04:05', TRUE, 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', '\\xDEADBEEF')"));
      await H.pgDrain(c.rd);
      c.sock.write(Buffer.concat([
        H.parseMsg('sb', 'SELECT a, d, t, g, k, b FROM z', []),
        H.bindMsg('pb', 'sb', [], { outFormats: [1] }),
        H.executeMsg('pb'), H.syncMsg()
      ]));
      const out = await H.pgDrain(c.rd, 400);
      const d = out.find((p) => p.type === 0x44);
      assert.ok(d, 'expected DataRow; frames=' + out.map((p) => p.type.toString(16)).join(','));
      const cols = columnsOf(d);
      assert.strictEqual(cols.length, 6);

      // numeric 4.5: ndigits=2 weight=0 sign=0 dscale=1 digits=[4,5000]
      assert.strictEqual(cols[0].length, 12, 'numeric binary length');
      assert.strictEqual(cols[0].readInt16BE(0), 2);
      assert.strictEqual(cols[0].readInt16BE(6), 1);
      assert.strictEqual(cols[0].readInt16BE(8), 4);
      assert.strictEqual(cols[0].readInt16BE(10), 5000);

      const days = Math.floor((Date.UTC(2024, 0, 2) - Date.UTC(2000, 0, 1)) / 86400000);
      assert.strictEqual(cols[1].length, 4, 'date should be int32');
      assert.strictEqual(cols[1].readInt32BE(0), days);

      const micros = BigInt(Math.floor((Date.UTC(2024, 0, 2, 3, 4, 5) - Date.UTC(2000, 0, 1)) / 1000)) * 1000000n;
      assert.strictEqual(cols[2].length, 8, 'timestamp should be int64');
      assert.strictEqual(cols[2].readBigInt64BE(0), micros);

      assert.strictEqual(cols[3].length, 1);
      assert.strictEqual(cols[3][0], 1);
      assert.strictEqual(cols[4].toString('hex'), 'a0eebc999c0b4ef8bb6d6bb9bd380a11');
      assert.strictEqual(cols[5].toString('hex'), 'deadbeef');
    } finally { h.close(); }
  });
  console.log(`${passed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
})().catch((e) => { console.error(e); process.exitCode = 1; });
