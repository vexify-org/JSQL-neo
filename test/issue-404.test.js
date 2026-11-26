/* #404: BSON Timestamp(0x11)/MinKey(0xFF)/MaxKey(0x7F) 解码编码 */
const assert = require('assert');
const { bsonDocument, bsonReadDocument } = require('../lib/mongo_server.js');

const i32 = (n) => { const b = Buffer.alloc(4); b.writeInt32LE(n, 0); return b; };
const cstr = (s) => Buffer.concat([Buffer.from(s, 'utf8'), Buffer.from([0])]);
const elem = (t, name, val) => Buffer.concat([Buffer.from([t]), cstr(name), val]);
function doc(...els) {
  const body = Buffer.concat([...els, Buffer.from([0])]);
  return Buffer.concat([i32(body.length + 4), body]);
}

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log('ok - ' + name); }
  catch (e) { failed++; console.error('not ok - ' + name + '\n  ' + e.message); }
}

t('decode 0x11 Timestamp into {$timestamp:{t,i}} (no precision loss)', () => {
  const ts = Buffer.alloc(8);
  ts.writeUInt32LE(1, 0);           // increment
  ts.writeUInt32LE(1700000000, 4);  // timestamp seconds
  const body = doc(elem(0x11, 'ts', ts), elem(0x10, 'after', i32(7)));
  const d = bsonReadDocument(body, 0).value;
  assert.deepStrictEqual(d.ts, { $timestamp: { t: 1700000000, i: 1 } });
  assert.strictEqual(d.after, 7);
});

t('decode 0xFF/0x7F MinKey/MaxKey keeps following fields', () => {
  const body = doc(
    elem(0xFF, 'min', Buffer.alloc(0)),
    elem(0x7F, 'max', Buffer.alloc(0)),
    elem(0x10, 'after', i32(7)),
  );
  const d = bsonReadDocument(body, 0).value;
  assert.deepStrictEqual(d.min, { $minKey: 1 });
  assert.deepStrictEqual(d.max, { $maxKey: 1 });
  assert.strictEqual(d.after, 7);
});

t('encode $timestamp/$minKey/$maxKey markers emit correct type bytes', () => {
  const buf = bsonDocument({
    ts: { $timestamp: { t: 1700000000, i: 1 } },
    mk: { $minKey: 1 },
    mx: { $maxKey: 1 },
  });
  const hex = buf.toString('hex');
  assert.ok(hex.includes('11'), 'expected 0x11 in ' + hex);
  assert.ok(hex.includes('ff'), 'expected 0xFF in ' + hex);
  assert.ok(hex.includes('7f'), 'expected 0x7F in ' + hex);
  const d = bsonReadDocument(buf, 0).value;
  assert.deepStrictEqual(d.ts, { $timestamp: { t: 1700000000, i: 1 } });
  assert.deepStrictEqual(d.mk, { $minKey: 1 });
  assert.deepStrictEqual(d.mx, { $maxKey: 1 });
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
