/*
 * #482 CSV 未闭合引号：EOF 收口时静默合并字段，必须报可定位的格式错误。
 *   node test/issue-482.test.js
 */
const assert = require('assert');
const migrate = require('../lib/migrate');

let passed = 0, failed = 0;
async function t(name, fn) {
  try { await fn(); passed++; console.log(`ok - ${name}`); }
  catch (e) { failed++; console.error(`not ok - ${name}\n  ${e && e.message}`); }
}

(async () => {
  await t('#482 未闭合引号在 EOF 应抛错（含行号/位置）', async () => {
    let err = null;
    try { migrate.parseCSV('a,b\n1,"unterminated,2\n'); }
    catch (e) { err = e; }
    assert.ok(err, '应抛出未闭合引号错误');
    assert(/unterminated|unclosed|未闭合/i.test(err.message), err.message);
    assert(/line|row|position|at/i.test(err.message), err.message);
  });

  await t('#482 strict 模式下未闭合引号中止', async () => {
    assert.throws(() => migrate.parseCSV('a,b\n1,"oops', { strict: true }), /unterminated|unclosed|未闭合/i);
  });

  await t('#482 正常引号字段与引号内换行不受影响', async () => {
    assert.deepStrictEqual(migrate.parseCSV('a,b\n1,"x,y"\n'), [['a', 'b'], ['1', 'x,y']]);
    assert.deepStrictEqual(migrate.parseCSV('a,b\n1,"line1\nline2"\n'), [['a', 'b'], ['1', 'line1\nline2']]);
    assert.deepStrictEqual(migrate.parseCSV('a,b\n1,"say ""hi"""\n'), [['a', 'b'], ['1', 'say "hi"']]);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
