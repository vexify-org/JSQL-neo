/*
 * #421 回归测试：renderTable(maxWidth) 必须把所有超宽列压进宽度预算。
 *   node test/issue-421.test.js
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
  await t('#421 三列全超宽时边框与数据行都 ≤ maxWidth', async () => {
    const headers = ['城市', '街道', '备注'];
    const rows = [[
      '北京市海淀区中关村大街',
      '朝阳门外大街一段102号',
      '这是一段很长的备注文本用来撑宽',
    ]];
    const out = renderTable(headers, rows, 30);
    const widths = out.split('\n').map(wswidth);
    assert.ok(widths.every(w => w <= 30), `line widths = ${JSON.stringify(widths)}`);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
})();
