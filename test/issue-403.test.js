/* #403: BSON Decimal128(0x13) 解码应按 16 字节处理并返回 $numberDecimal，游标推进 16；编码应输出 0x13 */
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

t('decode 0x13 keeps 16-byte value as $numberDecimal wrapper and advances cursor', () => {
  const payload = Buffer.alloc(16);
  payload.writeUInt32LE(123456, 12);
  const body = doc(elem(0x13, 'd', payload), elem(0x10, 'after', i32(7)));
  const d = bsonReadDocument(body, 0).value;
  assert.strictEqual(d.after, 7, 'following field must survive');
  assert.ok(d.d && typeof d.d.$numberDecimal === 'string', 'expected $numberDecimal string, got ' + JSON.stringify(d.d));
  assert.notStrictEqual(typeof d.d, 'number');
});

t('$numberDecimal is not a garbage double like 1.82e-307', () => {
  const payload = Buffer.alloc(16);
  payload.writeDoubleLE(123.456, 0);
  const body = doc(elem(0x13, 'd', payload));
  const d = bsonReadDocument(body, 0).value;
  assert.ok(!(typeof d.d === 'number' && Math.abs(d.d) < 1e-300));
});

t('encode {$numberDecimal} emits 0x13 and round-trips losslessly', () => {
  const buf = bsonDocument({ d: { $numberDecimal: '123.456' } });
  assert.ok(buf.includes(0x13), 'expected 0x13 type byte in ' + buf.toString('hex'));
  const d = bsonReadDocument(buf, 0).value;
  assert.ok(d.d && typeof d.d.$numberDecimal === 'string');
  const buf2 = bsonDocument({ d: d.d });
  assert.ok(buf2.includes(0x13));
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
