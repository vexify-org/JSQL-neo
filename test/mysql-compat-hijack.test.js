/*
 * require.cache 全局劫持回归测试（P0-1）
 *
 * 背景：旧版 enableMySQLCompat() 会遍历 node_modules，把 mysql2 的
 * require.cache 条目替换成内存兼容层。它靠 process.cwd() 猜路径，
 * mysql2 通常尚未加载，于是被静默替换 —— 真实 MySQL 连接悄悄改查内存库
 * 且不报错，表现为「本地跑通、上线全错」。
 *
 * 本测试锁定修复后的契约：
 *   1. 默认调用 enableMySQLCompat() 绝不改动 require.cache
 *   2. { global: true } 缺少环境变量确认时必须抛错
 *   3. injectMySQLCompat() 只改写传入对象的引用，不污染全局
 *   4. 兼容层仍可显式使用
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
    if (cond) { pass++; console.log('[OK]   ' + name); }
    else { fail++; console.log('[FAIL] ' + name + (extra !== undefined ? ' → ' + JSON.stringify(extra) : '')); }
}

// 造一个隔离的假 mysql2，用于验证劫持行为
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jsql-hijack-'));
const nm = path.join(tmp, 'node_modules', 'mysql2');
fs.mkdirSync(nm, { recursive: true });
fs.writeFileSync(path.join(nm, 'index.js'),
    'exports.createConnection = function(){ return { __real: true }; };\n' +
    'exports.createPool = function(){ return { __real: true }; };\n');
fs.writeFileSync(path.join(nm, 'package.json'),
    JSON.stringify({ name: 'mysql2', version: '3.0.0', main: 'index.js' }));

const jsql = require('../index.js');
const mysql2Path = path.join(nm, 'index.js');

try {
    console.log('--- 1. 默认调用不得劫持 require.cache ---');
    // 直接检查 index.js 源码不含无条件注入路径
    const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
    const fnBody = src.slice(src.indexOf('function enableMySQLCompat'));
    ok('enableMySQLCompat 内部对 global 做了显式判断',
        /opts\.global\s*!==\s*true/.test(fnBody));
    ok('危险路径需环境变量确认',
        /JSQL_NEO_ALLOW_GLOBAL_HIJACK/.test(fnBody));

    console.log('--- 2. 调用后 require.cache 不含被伪造的 mysql2 ---');
    jsql.enableMySQLCompat();
    const cached = require.cache[mysql2Path];
    ok('require.cache 中没有 mysql2 条目', cached === undefined,
        cached ? '仍被注入' : undefined);

    console.log('--- 3. { global: true } 无环境变量时抛错 ---');
    let threw = null;
    try { jsql.enableMySQLCompat({ global: true }); } catch (e) { threw = e; }
    ok('抛错并说明原因', threw && /require\.cache/.test(threw.message), threw && threw.message);
    ok('抛错后仍未注入', require.cache[mysql2Path] === undefined);

    console.log('--- 4. 显式注入只影响目标对象 ---');
    const target = {
        createConnection: () => ({ __fake: true }),
        Driver: { createPool: () => ({ __fake: true }) },
    };
    const before = target.createConnection;
    const touched = jsql.injectMySQLCompat(target);
    ok('injectMySQLCompat 返回 true', touched === true);
    ok('顶层 createConnection 已被替换', target.createConnection !== before);
    ok('嵌套 Driver.createPool 已被替换',
        typeof target.Driver.createPool === 'function' &&
        target.Driver.createPool !== before);
    ok('未触碰 require.cache', require.cache[mysql2Path] === undefined);

    console.log('--- 5. 兼容层仍可显式使用 ---');
    ok('导出 mysql2.createConnection', typeof jsql.mysql2.createConnection === 'function');
    ok('导出 mysql2.createPool', typeof jsql.mysql2.createPool === 'function');
    ok('导出 createConnection 快捷方式', typeof jsql.createConnection === 'function');
    ok('导出 injectMySQLCompat', typeof jsql.injectMySQLCompat === 'function');
    ok('enableMySQLCompat 默认调用返回兼容层',
        jsql.enableMySQLCompat() === jsql.mysql2);
} finally {
    fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
