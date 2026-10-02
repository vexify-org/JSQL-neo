#!/usr/bin/env node
/**
 * 把 lib/sql.js (+ lib/ast.js) 打包成浏览器可直接 import 的 ES module。
 *
 * 为什么需要：JSQL 的 WASM 构建（wasm/browser.mjs）只提供存储层 CRUD，
 * SQL 解析器在 lib/sql.js 里，而它是 CommonJS。浏览器无法直接 import，
 * 所以这里做一次极简的 CommonJS→ESM 包装。
 *
 * 用法：node scripts/make-browser-bundle.js [输出路径]
 *   默认输出 <repo>/../jsql-web-app/jsql-sql.browser.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const OUT = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.resolve(ROOT, '..', 'jsql-web-app', 'jsql-sql.browser.js');

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

// ---- 浏览器环境的兼容补丁 ----
function patchSql(src) {
  return src
    // Buffer 在浏览器不存在：先判存在再调，避免 ReferenceError
    .replace(
      'if (Buffer.isBuffer(value)) return "X\'" + value.toString(\'hex\') + "\'";',
      'if (typeof Buffer !== \'undefined\' && Buffer.isBuffer(value)) return "X\'" + value.toString(\'hex\') + "\'";'
    )
    // process.hrtime 同理，回退到 performance.now()
    .replace(
      'const t0 = process.hrtime.bigint();',
      'const t0 = (typeof process !== \'undefined\' && process.hrtime) ? process.hrtime.bigint() : BigInt(Math.round((typeof performance !== \'undefined\' ? performance.now() : Date.now()) * 1e6));'
    )
    .replace(
      'const durationMs = Number(process.hrtime.bigint() - t0) / 1e6;',
      'const __t1 = (typeof process !== \'undefined\' && process.hrtime) ? process.hrtime.bigint() : BigInt(Math.round((typeof performance !== \'undefined\' ? performance.now() : Date.now()) * 1e6));\n  const durationMs = Number(__t1 - t0) / 1e6;'
    );
}

function wrap(id, src, deps) {
  const depMap = deps.map((d) => `'${d}': __mods['${d}']`).join(', ');
  return `
__mods['${id}'] = (function () {
  const module = { exports: {} };
  const exports = module.exports;
  const require = (p) => ({ ${depMap} }[p] || (() => { throw new Error('Cannot find module ' + p); })());
  (function (module, exports, require) {
${src}
  })(module, exports, require);
  return module.exports;
})();`;
}

function main() {
  const astSrc = read('lib/ast.js');
  const sqlSrc = patchSql(read('lib/sql.js'));

  const header = `/**
 * JSQL-NEO — 浏览器端 SQL 引擎 bundle（自动生成，请勿手改）
 * 生成命令：node scripts/make-browser-bundle.js
 * 源：lib/sql.js + lib/ast.js
 */
const __mods = {};
`;

  const body = [
    wrap('./ast.js', astSrc, []),
    wrap('./sql.js', sqlSrc, ['./ast.js']),
  ].join('\n');

  const footer = `
const __sql = __mods['./sql.js'];
export const executeSQL = __sql.executeSQL;
export const parseSQL = __sql.parseSQL;
export const splitStatements = __sql.splitStatements;
export const applyParams = __sql.applyParams;
export const tokenize = __sql.tokenize;
export const __all = __sql;
export default __sql;
`;

  const out = header + body + footer;
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, out);
  console.log(`[bundle] 已生成 ${OUT}  (${(out.length / 1024).toFixed(1)} KB)`);
  console.log('[bundle] 导出: executeSQL / parseSQL / splitStatements / applyParams / tokenize');
}

main();
