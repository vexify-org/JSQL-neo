'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

// #501 / #506: PLUGINS.md 文档修正
let passed = 0, failed = 0;
function ok(name, fn) {
  try { fn(); passed++; console.log('ok -', name); }
  catch (e) { failed++; console.log('not ok -', name, '\n  ', e.message); }
}
const md = fs.readFileSync(path.join(__dirname, '..', 'PLUGINS.md'), 'utf8');

ok('#506 beforeFlush/afterFlush 支持 Pure JS Database (N/W/D)', () => {
  const bf = md.split('\n').find(l => l.includes('`beforeFlush`'));
  const af = md.split('\n').find(l => l.includes('`afterFlush`'));
  assert.ok(bf && bf.includes('N/W/D'), `beforeFlush row: ${bf}`);
  assert.ok(af && af.includes('N/W/D'), `afterFlush row: ${af}`);
});

ok('#501 文档不再声称模块默认可 require', () => {
  assert.ok(!md.includes('模块文件可 `require` 本地依赖，但**不会被隔离**'),
    '旧的错误表述应被移除');
  assert.ok(md.includes('不提供 `require`'), '应说明默认沙箱不提供 require');
  assert.ok(md.includes('JSQL_ALLOW_UNSAFE_MODULES=1'), '应说明需设环境变量才放开');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
