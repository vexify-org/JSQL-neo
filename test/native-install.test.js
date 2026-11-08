/* ---- postinstall：native 覆盖安装 + 版本状态自检的回归 ---- */
/*
 * 背景（两个真实故障）：
 *
 * 1. Windows 上 installDownloadedModule 的 EPERM fallback 会 unlinkSync(旧.node)
 *    并把失败 catch 掉，第二次 rename 必然再失败 —— 下载成功、校验通过，
 *    却静默留着旧二进制。issue-38 的 bigint 用例因此一直挂。
 * 2. 失败时只打一句 "keeping the existing local native module"，用户无从察觉
 *    版本可能错配。新增 --status 就是要让这件事可查。
 *
 * 全部用临时目录 + JSQL_NATIVE_PATH，绝不碰仓库里真实的 .node。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jsql-native-test-'));
const NATIVE = path.join(TMP, 'native', 'jsql-neo-native.node');
const META = path.join(TMP, 'native', '.installed.json');
fs.mkdirSync(path.dirname(NATIVE), { recursive: true });

// 必须在 require 之前设置：NATIVE_PATH 是模块加载时算出来的常量
process.env.JSQL_NATIVE_PATH = NATIVE;
const PI = require(path.join(__dirname, '..', 'postinstall.js'));

let pass = 0, fail = 0;
function ok(name, cond, got) {
  if (cond) { pass++; console.log('[OK]   ' + name); }
  else { fail++; console.log('[FAIL] ' + name + ' -> ' + JSON.stringify(got)); }
}

// 调用 nativeStatus 时把输出收起来，别污染测试日志
function status() {
  const orig = console.log;
  const lines = [];
  console.log = (...a) => lines.push(a.join(' '));
  let code;
  try { code = PI.nativeStatus(); }
  finally { console.log = orig; }
  return { code, text: lines.join('\n') };
}

try {
  // --- 1) 目标 .node 已存在时必须能覆盖（EPERM 修复的核心） ---
  fs.writeFileSync(NATIVE, 'OLD-NATIVE');
  const tmp = path.join(TMP, 'incoming.download');
  fs.writeFileSync(tmp, 'NEW-NATIVE');
  let installed;
  try { installed = PI.installDownloadedModule(tmp); }
  catch (e) { installed = { error: e.message }; }
  ok('目标已存在时覆盖成功',
    fs.readFileSync(NATIVE, 'utf8') === 'NEW-NATIVE', installed);
  ok('覆盖前为旧模块创建了回滚备份',
    !!(installed && installed.backup) && fs.existsSync(installed.backup), installed);

  // --- 2) 没有 .installed.json 时必须报 UNVERIFIED，不能假装 OK ---
  if (fs.existsSync(META)) fs.unlinkSync(META);
  let r = status();
  ok('无安装元数据 → UNVERIFIED 且 exit=1',
    r.code === 1 && /UNVERIFIED/.test(r.text), r);

  // --- 3) 元数据与包版本一致 → OK ---
  fs.writeFileSync(META, JSON.stringify({
    tag: `v${require('../package.json').version}`,
    sha256: 'deadbeef',
    installedAt: new Date().toISOString(),
  }, null, 2));
  r = status();
  ok('元数据匹配包版本 → OK 且 exit=0',
    r.code === 0 && /STATUS\s*:\s*OK/.test(r.text), r);

  // --- 4) 版本错配 → MISMATCH，且指路刷新命令 ---
  const meta = JSON.parse(fs.readFileSync(META, 'utf8'));
  meta.tag = 'v0.0.1';
  fs.writeFileSync(META, JSON.stringify(meta));
  r = status();
  ok('元数据版本错配 → MISMATCH 且 exit=1',
    r.code === 1 && /MISMATCH/.test(r.text), r);
  ok('MISMATCH 时提示刷新命令',
    /node postinstall\.js/.test(r.text), r.text);

  // --- 5) native 文件缺失时不能报 OK ---
  fs.unlinkSync(NATIVE);
  r = status();
  ok('native 文件缺失 → 不报 OK',
    r.code === 1 && /MISSING/.test(r.text), r);
} finally {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
  delete process.env.JSQL_NATIVE_PATH;
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
