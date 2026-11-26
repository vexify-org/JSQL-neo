/*
 * #422 回归测试：单元格截断按显示宽度而非 UTF-16 码元数。
 *   node test/issue-422.test.js
 */
const assert = require('assert');
const path = require('path');
const { renderTable, wswidth } = require(path.join(__dirname, '..', 'lib', 'tui.js'));

let passed = 0, failed = 0;
async function t(name, fn) {
  try { await fn(); passed++; console.log(`ok - ${name}`); }
  catch (e) { failed++; console.error(`not ok - ${name}\n  ${e && e.message}`); }
}

(async () => {
  await t('#422 CJK 单元格被按显示宽度截断且补省略号', async () => {
    const out = renderTable(['a', 'b'], [['x', '北京海淀区中关村大街一段']], 20);
    const lines = out.split('\n');
    const dataLine = lines[3];
    assert.ok(dataLine.includes('…'), 'expected ellipsis on truncated cell');
    assert.ok(wswidth(dataLine) <= 20, `data width=${wswidth(dataLine)}`);
  });

  await t('#422 截断不把代理对切成半个字符', async () => {
    const out = renderTable(['a', 'b'], [['x', '😀😀😀😀😀😀😀😀']], 12);
    const dataLine = out.split('\n')[3];
    assert.ok(wswidth(dataLine) <= 12, `data width=${wswidth(dataLine)}`);
    assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(dataLine), 'lone high surrogate');
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
})();
