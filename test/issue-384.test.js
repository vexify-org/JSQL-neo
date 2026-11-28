'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { Database } = require('../index.js');
const { ModuleManager } = require('../lib/mod.js');

const TMP = path.join(__dirname, '.tmp-mod384');

function writeMod(name, installBody) {
  const file = path.join(TMP, name + '.js');
  fs.writeFileSync(file, `module.exports = { name: '${name}', install() { ${installBody} } };\n`, 'utf8');
  return { name, enabled: true, path: file };
}

(async () => {
  fs.mkdirSync(TMP, { recursive: true });
  const a = writeMod('a', '');
  const b = writeMod('b', "throw new Error('boom-b');");
  const c = writeMod('c', '');

  const cfg = path.join(TMP, 'config.json');
  try { fs.unlinkSync(cfg); } catch (e) {}
  const mgr = new ModuleManager(cfg);
  mgr._modules = [a, b, c];

  const db = new Database(':memory:');
  mgr.applyTo(db);
  const names = db._plugins.map(p => p.name);
  assert(names.includes('a'), '模块 a 应被应用');
  assert(names.includes('c'), '模块 c 应被应用（b 抛错不应中断后续）');
  assert(!names.includes('b'), '模块 b 安装失败不应出现在插件列表');
  await db.stop();

  fs.rmSync(TMP, { recursive: true, force: true });
  console.log('issue-384: PASS');
})().catch(e => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
  console.error('issue-384: FAIL', e.message);
  process.exit(1);
});
