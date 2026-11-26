/* #432: BSON 字符串非法 UTF-8 必须报错，不能静默替换成 U+FFFD */
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

t('decode invalid UTF-8 string throws instead of U+FFFD replacement', () => {
  const bad = Buffer.from([0x80, 0xff, 0x41]);
  const payload = Buffer.concat([i32(bad.length + 1), bad, Buffer.from([0])]);
  const body = doc(elem(0x02, 's', payload));
  assert.throws(() => bsonReadDocument(body, 0), /UTF-8|utf8|invalid/i);
});

t('encode lone surrogate / invalid UTF-8 string throws', () => {
  assert.throws(() => bsonDocument({ s: '\ud800' }), /UTF-8|utf8|invalid|surrogate/i);
});

t('valid UTF-8 still round-trips', () => {
  const buf = bsonDocument({ s: 'héllo-你好' });
  const d = bsonReadDocument(buf, 0).value;
  assert.strictEqual(d.s, 'héllo-你好');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
