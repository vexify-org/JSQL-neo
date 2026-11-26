/* #567: OP_MSG checksumPresent 必须校验末尾 CRC-32C */
const assert = require('assert');
const { createMongoServer, bsonDocument, bsonReadDocument, crc32c } = require('../lib/mongo_server.js');

const srv = createMongoServer({ port: 0, dataDir: ':memory:' });

function buildMsg(withChecksum, checksumValue) {
  const body = bsonDocument({ ping: 1, $db: 'test' });
  const payload = Buffer.concat([Buffer.from([0x00]), body]);
  const head = Buffer.alloc(16);
  head.writeInt32LE(16 + 4 + payload.length + (withChecksum ? 4 : 0), 0);
  head.writeInt32LE(77, 4);
  head.writeInt32LE(0, 8);
  head.writeInt32LE(2013, 12);
  const fl = Buffer.alloc(4);
  fl.writeInt32LE(withChecksum ? 1 : 0, 0);
  let msg = Buffer.concat([head, fl, payload]);
  if (withChecksum) {
    const c = Buffer.alloc(4);
    c.writeUInt32LE(checksumValue === undefined ? crc32c(msg) : checksumValue >>> 0, 0);
    msg = Buffer.concat([msg, c]);
  }
  return msg;
}
async function send(msg) {
  const replies = [];
  await srv._handleMessage({ write: (b) => replies.push(b) }, msg);
  assert.strictEqual(replies.length, 1);
  return bsonReadDocument(replies[0], 21).value;
}

let passed = 0, failed = 0;
async function t(name, fn) {
  try { await fn(); passed++; console.log('ok - ' + name); }
  catch (e) { failed++; console.error('not ok - ' + name + '\n  ' + e.message); }
}

(async () => {
  try {
    await t('checksumPresent with garbage trailer returns protocol error', async () => {
      const r = await send(buildMsg(true, 0x11223344));
      assert.strictEqual(r.ok, 0);
      assert.ok(/checksum/i.test(r.errmsg || ''), 'expected checksum error, got ' + JSON.stringify(r));
    });
    await t('checksumPresent with correct CRC-32C is accepted', async () => {
      const r = await send(buildMsg(true));
      assert.strictEqual(r.ok, 1);
    });
    await t('messages without checksum remain accepted', async () => {
      const r = await send(buildMsg(false));
      assert.strictEqual(r.ok, 1);
    });
  } finally { srv.close(); }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
