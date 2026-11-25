/* #397: BSON RegExp(0x0B) 解码应读 pattern/flags 并继续解析后续字段；编码应输出 0x0B */
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

t('decode 0x0B RegExp yields $regex/$options and keeps following field', () => {
  const body = doc(
    elem(0x0B, 're', Buffer.concat([cstr('^a'), cstr('i')])),
    elem(0x10, 'after', i32(7)),
  );
  const d = bsonReadDocument(body, 0).value;
  assert.deepStrictEqual(d.re, { $regex: '^a', $options: 'i' });
  assert.strictEqual(d.after, 7);
});

t('encode JS RegExp uses 0x0B type byte', () => {
  const buf = bsonDocument({ reg: /^a/i });
  assert.ok(buf.includes(0x0B), 'expected 0x0B type byte in ' + buf.toString('hex'));
  const d = bsonReadDocument(buf, 0).value;
  assert.deepStrictEqual(d.reg, { $regex: '^a', $options: 'i' });
});

t('encode {$regex,$options} marker uses 0x0B type byte', () => {
  const buf = bsonDocument({ reg: { $regex: 'x', $options: 'm' } });
  assert.ok(buf.includes(0x0B));
  const d = bsonReadDocument(buf, 0).value;
  assert.deepStrictEqual(d.reg, { $regex: 'x', $options: 'm' });
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
