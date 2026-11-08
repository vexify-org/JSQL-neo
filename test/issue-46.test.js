/*
 * Issue #46 — index.d.ts 声明了 applyParams / escapeValue / escapeId，
 * index.js 却没有导出，按类型调用会 TypeError。
 */
const path = require('path');

const ROOT = path.join(__dirname, '..');
const jsql = require(path.join(ROOT, 'index.js'));

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('[OK]  ', name); }
  else { fail++; console.log('[FAIL]', name, extra !== undefined ? '-> ' + JSON.stringify(extra).slice(0, 300) : ''); }
}

try {
  ok('#46 applyParams 是函数', typeof jsql.applyParams === 'function', typeof jsql.applyParams);
  ok('#46 escapeValue 是函数', typeof jsql.escapeValue === 'function', typeof jsql.escapeValue);
  ok('#46 escapeId 是函数', typeof jsql.escapeId === 'function', typeof jsql.escapeId);

  if (typeof jsql.applyParams === 'function') {
    ok('#46 applyParams 参数替换生效', jsql.applyParams('SELECT ?', [1]) === 'SELECT 1', jsql.applyParams('SELECT ?', [1]));
  }
  if (typeof jsql.escapeValue === 'function') {
    ok("#46 escapeValue 转义单引号", jsql.escapeValue("a'b") === "'a\\'b'", jsql.escapeValue("a'b"));
  }
  if (typeof jsql.escapeId === 'function') {
    ok('#46 escapeId 反引号包裹', jsql.escapeId('a`b') === '`a``b`', jsql.escapeId('a`b'));
  }

  // .d.ts 与 .js 的导出面必须一致（防止再漂移）
  const dts = require('fs').readFileSync(path.join(ROOT, 'index.d.ts'), 'utf8');
  for (const name of ['applyParams', 'escapeValue', 'escapeId']) {
    ok(`#46 index.d.ts 声明的 ${name} 已导出`, dts.includes(`export function ${name}`) && name in jsql);
  }
} catch (e) {
  fail++;
  console.log('[FAIL] unexpected exception:', e && e.stack || e);
}

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed\n`);
if (fail > 0) process.exit(1);
