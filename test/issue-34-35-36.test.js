/*
 * Regression tests for issue #34 / #35 / #36.
 *   node test/issue-34-35-36.test.js
 *
 * #34 TUI: multi-byte UTF-8 input advances read cursor by char count, not byte count.
 * #35 Native/WASM binding: negative limit/offset/id cast to usize/u64 without validation.
 * #36 WASM insert_buf: explicit primary key inside reserved auto-increment range
 *      shadows another row and the returned id list is wrong.
 */
const path = require('path');
const ROOT = path.join(__dirname, '..');

let passed = 0, failed = 0;
function ok(name, cond, extra) {
  if (cond) { passed++; console.log('[OK]', name); }
  else { failed++; console.log('[FAIL]', name, extra !== undefined ? JSON.stringify(extra) : ''); }
}

/* ---------- #34: TUI multi-byte UTF-8 ---------- */
function testTui() {
  const { TUIShell } = require(path.join(ROOT, 'lib', 'tui'));
  const realWrite = process.stdout.write;
  process.stdout.write = () => true;
  const feed = (t, s) => t._onKeys(Buffer.from(s, 'utf8'));
  const cases = [
    ['中', '中'], ['你', '你'], ['a中b', 'a中b'], ['😀', '😀'],
    ['中文测试', '中文测试'], ['SELECT "名字" FROM t WHERE name="张三"', 'SELECT "名字" FROM t WHERE name="张三"'],
  ];
  for (const [input, expected] of cases) {
    const t = new TUIShell({ db: ':memory:' });
    feed(t, input);
    ok(`#34 TUI "input" -> single char, not split`, t.line === expected && t.line.length === expected.length, { input, line: t.line });
  }
  const t = new TUIShell({ db: ':memory:' });
  feed(t, 'a中b');
  ok('#34 TUI cursor advances by char count, line intact', t.cursor === 3 && t.line === 'a中b', { cursor: t.cursor, line: t.line });
  process.stdout.write = realWrite;
}

/* ---------- #35: negative limit/offset/id ---------- */
async function testWasmNeg() {
  const { JSQL } = require(path.join(ROOT, 'lib', 'wasm_client'));
  const db = new JSQL({ modules: false });
  await db.start();
  await db.createTable('users', { id: 'integer primary key auto_increment', name: 'string' });
  await db.insert('users', [{ name: 'a' }, { name: 'b' }]);
  for (const [label, fn, re] of [
    ['wasm find limit -1', () => db.find('users', {}, { limit: -1 }), /non-negative/],
    ['wasm find offset -5', () => db.find('users', {}, { offset: -5 }), /non-negative/],
    ['wasm findById -1', () => db.findById('users', -1), /non-negative/],
    ['wasm updateById -2', () => db.updateById('users', -2, { name: 'x' }), /non-negative/],
    ['wasm removeById -3', () => db.removeById('users', -3), /non-negative/],
  ]) {
    let threw = false;
    try { await fn(); } catch (e) { threw = re.test(e.message); }
    ok(`#35 ${label} throws`, threw);
  }
  // valid ops still work
  ok('#35 wasm valid find works', (await db.find('users', {}, { limit: 10, offset: 0 })).length === 2);
  ok('#35 wasm valid findById works', (await db.findById('users', 1)).id === 1);
  await db.stop();
}

async function testNativeNeg() {
  const { JSQL } = require(path.join(ROOT, 'lib', 'native_client'));
  const db = new JSQL({ modules: false });
  await db.start();
  await db.createTable('users', { id: 'integer primary key auto_increment', name: 'string' });
  await db.insert('users', [{ name: 'a' }, { name: 'b' }]);
  for (const [label, fn, re] of [
    ['native find limit -1', () => db.find('users', {}, { limit: -1 }), /non-negative/],
    ['native find offset -5', () => db.find('users', {}, { offset: -5 }), /non-negative/],
    ['native findById -1', () => db.findById('users', -1), /non-negative/],
    ['native updateById -2', () => db.updateById('users', -2, { name: 'x' }), /non-negative/],
    ['native removeById -3', () => db.removeById('users', -3), /non-negative/],
    ['native findByIds [-1,2]', () => db.findByIds('users', [-1, 2]), /non-negative/],
  ]) {
    let threw = false;
    try { await fn(); } catch (e) { threw = re.test(e.message); }
    ok(`#35 ${label} throws`, threw);
  }
  ok('#35 native valid find works', (await db.find('users', {}, { limit: 10, offset: 0 })).length === 2);
  await db.stop();
}

/* ---------- #36: WASM insert_buf explicit pk ---------- */
function encStr(s) { const b = Buffer.from(s, 'utf8'); return [Buffer.from([b.length]), b]; }
function encodeBatch(rows, fieldNames) {
  const parts = [];
  parts.push(Buffer.from([fieldNames.length]));
  for (const f of fieldNames) parts.push(...encStr(f));
  const rc = Buffer.alloc(4); rc.writeUInt32LE(rows.length, 0); parts.push(rc);
  for (const row of rows) for (const f of fieldNames) {
    const v = row[f];
    if (v === null || v === undefined) parts.push(Buffer.from([0]));
    else if (typeof v === 'number') {
      if (Number.isInteger(v) && v >= -2147483648 && v <= 2147483647) { const b = Buffer.alloc(5); b.writeUInt8(5, 0); b.writeInt32LE(v, 1); parts.push(b); }
      else if (Number.isInteger(v)) { const b = Buffer.alloc(9); b.writeUInt8(1, 0); b.writeBigInt64LE(BigInt(v), 1); parts.push(b); }
      else { const b = Buffer.alloc(9); b.writeUInt8(2, 0); b.writeDoubleLE(v, 1); parts.push(b); }
    } else if (typeof v === 'string') { const s = Buffer.from(v, 'utf8'); const b = Buffer.alloc(5); b.writeUInt8(3, 0); b.writeUInt32LE(s.length, 1); parts.push(b, s); }
    else if (typeof v === 'boolean') parts.push(Buffer.from([4, v ? 1 : 0]));
    else { const s = Buffer.from(JSON.stringify(v), 'utf8'); const b = Buffer.alloc(5); b.writeUInt8(3, 0); b.writeUInt32LE(s.length, 1); parts.push(b, s); }
  }
  return Buffer.concat(parts);
}

function testWasmInsertBuf() {
  const wasm = require(path.join(ROOT, 'wasm', 'jsql_neo_wasm.js'));
  const schema = JSON.stringify({ id: { type: 'integer', primaryKey: true, autoIncrement: true }, name: { type: 'string' } });
  // explicit pk inside reserved range: row0 id=2, row1 auto
  wasm.jsql_reset();
  wasm.jsql_create_table('t', schema);
  const ids = JSON.parse(wasm.jsql_insert_buf('t', encodeBatch([{ id: 2, name: 'a' }, { id: null, name: 'b' }], ['id', 'name'])));
  ok('#36 returned ids are actually assigned', JSON.stringify(ids) === JSON.stringify([2, 3]), ids);
  const rows = JSON.parse(wasm.jsql_find('t', '{}', 100, 0));
  ok('#36 explicit pk row not shadowed', rows.some(r => r.id === 2 && r.fields.name === 'a'), rows);
  ok('#36 auto row got next free id', rows.some(r => r.id === 3 && r.fields.name === 'b'), rows);
  const byId2 = JSON.parse(wasm.jsql_find_by_id('t', 2n));
  ok('#36 findById(2) resolves explicit-pk row', byId2 && byId2.fields.name === 'a', byId2);
  // duplicate explicit pk errors
  wasm.jsql_reset();
  wasm.jsql_create_table('t', schema);
  JSON.parse(wasm.jsql_insert_buf('t', encodeBatch([{ id: 5, name: 'x' }], ['id', 'name'])));
  const dup = JSON.parse(wasm.jsql_insert_buf('t', encodeBatch([{ id: 5, name: 'y' }], ['id', 'name'])));
  ok('#36 duplicate explicit pk errors', dup && dup.error && /DUP_ENTRY/i.test(dup.error), dup);
  // mixed batch: no duplicate ids
  wasm.jsql_reset();
  wasm.jsql_create_table('t', schema);
  const r4 = JSON.parse(wasm.jsql_insert_buf('t', encodeBatch([{ id: null, name: 'a' }, { id: 2, name: 'b' }, { id: null, name: 'c' }], ['id', 'name'])));
  ok('#36 mixed batch no duplicate ids', new Set(r4).size === r4.length, r4);
  ok('#36 mixed batch explicit pk kept', JSON.parse(wasm.jsql_find('t', '{}', 100, 0)).some(r => r.id === 2 && r.fields.name === 'b'));
}

(async () => {
  testTui();
  await testWasmNeg();
  try { await testNativeNeg(); }
  catch (e) { console.log('  (native module unavailable, skipped):', e.message.split('\n')[0]); }
  testWasmInsertBuf();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('[FATAL]', e.stack.split('\n').slice(0, 3).join('\n')); process.exit(1); });
