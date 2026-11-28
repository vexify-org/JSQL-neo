'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

// #502: PLUGINS.md 统一引擎 API 示例里的 findById/updateById/removeById
// 都是 async，示例必须 await，否则拿到 Promise、字段全 undefined。
const doc = fs.readFileSync(path.join(__dirname, '..', 'PLUGINS.md'), 'utf8');
const block = doc.match(/```js[\s\S]*?await db\.start\(\)[\s\S]*?```/);
assert(block, '应能找到统一引擎 API 代码块');
const code = block[0];

assert(/await db\.findById\(/.test(code), 'findById 示例必须 await');
assert(/await db\.updateById\(/.test(code), 'updateById 示例必须 await');
assert(/await db\.removeById\(/.test(code), 'removeById 示例必须 await');
assert(!/或 await（WASM）/.test(code), '不应保留误导性的「或 await（WASM）」注释');

console.log('issue-502: PASS');
