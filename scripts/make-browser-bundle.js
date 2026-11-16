#!/usr/bin/env node
/**
 * 把 lib/sql.js（连同它 require 的所有本地模块，递归）打包成浏览器可直接
 * import 的单个 ES module。
 *
 * 为什么需要：JSQL 的 WASM 构建（wasm/browser.mjs）只提供存储层 CRUD，
 * SQL 解析器在 lib/sql.js 里，而它是 CommonJS。浏览器无法直接 import，
 * 所以这里做一次极简的 CommonJS→ESM 包装。
 *
 * 依赖发现：从 lib/sql.js 出发，扫描所有 `require('./x')` / `require('../x')`
 * 相对路径，按依赖图递归内联（拓扑序，依赖先于使用者初始化），因此
 * `require('./errors')`、`require('./date-types')`、`require('./bigint_json')`、
 * `require('./btree')`、`require('./columnar_fast')` 等都会被一起打包。
 * 新增本地依赖无需改这个脚本。
 *
 * 用法：node scripts/make-browser-bundle.js [输出路径]
 *   默认输出 <repo>/../jsql-web-app/jsql-sql.browser.mjs
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const LIB = path.join(ROOT, 'lib');
const ENTRY = 'sql.js';
const OUT = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.resolve(ROOT, '..', 'jsql-web-app', 'jsql-sql.browser.mjs');

// ---- 浏览器环境的兼容补丁 (只作用于 lib/sql.js) ----
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

// ---- 依赖图 ----
const sourceCache = new Map();

function readModule(id) {
  if (!sourceCache.has(id)) {
    sourceCache.set(id, fs.readFileSync(path.join(LIB, id), 'utf8'));
  }
  return sourceCache.get(id);
}

/** 返回源码里出现的所有本地（相对路径）require 说明符。 */
function localRequires(src) {
  const specs = new Set();
  const re = /require\(\s*(['"])(\.{1,2}\/[^'"]*)\1\s*\)/g;
  let m;
  while ((m = re.exec(src)) !== null) specs.add(m[2]);
  return [...specs];
}

/** 把相对于 fromId 的说明符解析成 lib/ 下的实际文件名。 */
function resolveId(fromId, spec) {
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(fromId), spec));
  const candidates = /\.(js|json|mjs|cjs)$/.test(base)
    ? [base]
    : [base, `${base}.js`, `${base}.json`, `${base}/index.js`];
  for (const candidate of candidates) {
    if (fs.existsSync(path.join(LIB, candidate))) return candidate;
  }
  throw new Error(
    `[bundle] 无法解析依赖 "${spec}"（来自 lib/${fromId}）——` +
      `它不在 lib/ 目录里，浏览器 bundle 只能内联本地模块`
  );
}

/** 拓扑序：被依赖的模块先于依赖它的模块被定义。 */
function dependencyOrder(entry) {
  const order = [];
  const seen = new Set();
  (function visit(id) {
    if (seen.has(id)) return;
    seen.add(id);
    for (const spec of localRequires(readModule(id))) visit(resolveId(id, spec));
    order.push(id);
  })(entry);
  return order;
}

// ---- 代码生成 ----
function wrap(id, src) {
  return `
__mods['./${id}'] = (function () {
  const module = { exports: {} };
  const exports = module.exports;
  const require = (p) => __req('./${id}', p);
  (function (module, exports, require) {
${src}
  })(module, exports, require);
  return module.exports;
})();`;
}

function main() {
  const order = dependencyOrder(ENTRY);
  const bundled = order.map((id) => `./${id}`);

  const header = `/**
 * JSQL-NEO — 浏览器端 SQL 引擎 bundle（自动生成，请勿手改）
 * 生成命令：node scripts/make-browser-bundle.js
 * 源：${order.map((id) => `lib/${id}`).join(' + ')}
 */
const __mods = Object.create(null);

// 把 from 模块里的相对路径 p 归一化成 bundle 内的模块 id（如 './errors.js'）。
const __normalize = (from, p) => {
  const fromDir = from.slice(0, from.lastIndexOf('/') + 1);
  const out = [];
  for (const seg of (fromDir + p).split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') out.pop();
    else out.push(seg);
  }
  return './' + out.join('/');
};

const __req = (from, p) => {
  if (typeof p !== 'string' || p.charAt(0) !== '.') {
    throw new Error("Cannot find module '" + p + "'（浏览器 bundle 只内联了本地 lib/ 模块）");
  }
  const id = __normalize(from, p);
  for (const candidate of [id, id + '.js', id + '.json', id + '/index.js']) {
    if (candidate in __mods) return __mods[candidate];
  }
  throw new Error('Cannot find module ' + p + ' (required from ' + from + ')');
};
`;

  const body = order
    .map((id) => wrap(id, id === ENTRY ? patchSql(readModule(id)) : readModule(id)))
    .join('\n');

  const footer = `
const __sql = __mods['./${ENTRY}'];
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
  console.log(`[bundle] 内联模块 (${bundled.length}): ${bundled.join(' ')}`);
  console.log('[bundle] 导出: executeSQL / parseSQL / splitStatements / applyParams / tokenize');
}

main();
