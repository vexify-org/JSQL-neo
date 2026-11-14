/* ---- 网络访问策略：启动路径零出网 + JSQL_OFFLINE 统一开关 ---- */
/*
 * 背景：CLI 启动路径曾会同步 curl api.github.com（只为少印一行 star 提示），
 * 让每条 jsql 命令都可能偷偷出网并阻塞最多 ~9.5 秒。本测试把「启动不联网」
 * 钉死，并验证 JSQL_OFFLINE=1 能拦住所有显式联网入口。
 *
 * 全程用临时目录：JSQL_MR_PATH 指向临时路径，绝不碰真实的 ~/.jsqlmr。
 */
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jsql-netpolicy-'));
process.env.JSQL_MR_PATH = path.join(TMP, 'jsqlmr');   // 必须在 require 之前

const { isOffline, offlineError } = require(path.join(ROOT, 'lib', 'network-policy'));
const sn = require(path.join(ROOT, 'lib', 'star-nag'));
const updater = require(path.join(ROOT, 'lib', 'updater'));
const plugin = require(path.join(ROOT, 'src', 'cli', 'plugin'));

let pass = 0, fail = 0;
function ok(name, cond, got) {
  if (cond) { pass++; console.log('[OK]   ' + name); }
  else { fail++; console.log('[FAIL] ' + name + ' -> ' + JSON.stringify(got)); }
}

// 记录所有子进程调用（curl / gh / npm），用来证明「没有出网」
const cp = require('child_process');
const realExecFileSync = cp.execFileSync;
const realExecFile = cp.execFile;
const realSpawn = cp.spawn;
const calls = [];
cp.execFileSync = function (cmd, ...rest) { calls.push('execFileSync:' + cmd); return realExecFileSync.call(this, cmd, ...rest); };
cp.execFile = function (cmd, ...rest) { calls.push('execFile:' + cmd); return realExecFile.call(this, cmd, ...rest); };
cp.spawn = function (cmd, ...rest) { calls.push('spawn:' + cmd); return realSpawn.call(this, cmd, ...rest); };

function resetCalls() { calls.length = 0; }

(async () => {
  // ---------- 环境变量解析 ----------
  const saved = process.env.JSQL_OFFLINE;
  delete process.env.JSQL_OFFLINE;
  ok('默认不离线', isOffline() === false, process.env.JSQL_OFFLINE);
  for (const v of ['1', 'true', 'yes', 'on', 'TRUE']) {
    process.env.JSQL_OFFLINE = v;
    ok('JSQL_OFFLINE=' + v + ' → 离线', isOffline() === true, v);
  }
  for (const v of ['0', 'false', '', 'no']) {
    process.env.JSQL_OFFLINE = v;
    ok('JSQL_OFFLINE=' + JSON.stringify(v) + ' → 不离线', isOffline() === false, v);
  }
  process.env.JSQL_OFFLINE = '1';
  const oe = offlineError('jsql update', '需要访问 npm registry');
  ok('offlineError 带 code=JSQL_OFFLINE', oe && oe.code === 'JSQL_OFFLINE', oe && oe.code);
  ok('offlineError 文案含功能名与原因', /jsql update/.test(oe.message) && /npm registry/.test(oe.message), oe && oe.message);

  // ---------- 启动路径零出网 ----------
  process.env.JSQL_OFFLINE = '';
  delete process.env.JSQL_OFFLINE;
  process.env.GITHUB_TOKEN = 'fake-token-should-never-be-used';
  const out = [];
  resetCalls();
  const printed = sn.nag({ out: { write: (s) => out.push(s) } });
  ok('nag() 正常打印提示', printed === true && out.join('').includes('star helps others find it'), out.join(''));
  ok('nag() 不发起任何子进程网络调用', calls.length === 0, calls);
  ok('nag() 不写 lastNagAt', (() => {
    try { const c = sn.readConfig(); return c.lastNagAt === undefined; } catch (e) { return true; }
  })(), null);
  delete process.env.GITHUB_TOKEN;

  // 已标记 starred 时应彻底沉默，且同样不出网
  sn.setStarred(true);
  const out2 = [];
  resetCalls();
  const printed2 = sn.nag({ out: { write: (s) => out2.push(s) } });
  ok('已 starred 时不打印', printed2 === false && out2.length === 0, out2.join(''));
  ok('已 starred 时不出网', calls.length === 0, calls);
  sn.setStarred(false);

  // ---------- 离线时各联网入口都被拦住 ----------
  process.env.JSQL_OFFLINE = '1';
  resetCalls();
  ok('checkStarred() 离线返回 null', sn.checkStarred() === null, null);
  ok('checkStarred() 离线不出网', calls.length === 0, calls);
  resetCalls();
  let threw = null;
  try { sn.startOauthCheck(); } catch (e) { threw = e; }
  ok('startOauthCheck() 离线抛 JSQL_OFFLINE', threw && threw.code === 'JSQL_OFFLINE', threw && threw.code);
  ok('startOauthCheck() 离线不开浏览器', calls.length === 0, calls);
  resetCalls();
  ok('waitForResult() 离线返回 null', sn.waitForResult('https://auth.vexify.top/start?nonce=x') === null, null);
  ok('waitForResult() 离线不轮询', calls.length === 0, calls);

  resetCalls();
  const up = await updater.runUpdate({ checkOnly: true });
  ok('jsql update 离线返回 ok=false', up && up.ok === false, up);
  ok('jsql update 离线给出可读原因', up && /JSQL_OFFLINE|离线/.test(up.error || ''), up && up.error);
  ok('jsql update 离线不出网', calls.length === 0, calls);

  resetCalls();
  let perr = null;
  try { await plugin.listPlugins({}); } catch (e) { perr = e; }
  ok('jsql plugin list 离线抛 JSQL_OFFLINE', perr && perr.code === 'JSQL_OFFLINE', perr && perr.code);
  ok('jsql plugin list 离线不出网', calls.length === 0, calls);

  // ---------- 恢复 ----------
  process.env.JSQL_OFFLINE = saved === undefined ? '' : saved;
  if (saved === undefined) delete process.env.JSQL_OFFLINE;
  cp.execFileSync = realExecFileSync;
  cp.execFile = realExecFile;
  cp.spawn = realSpawn;
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => {
  console.log('[FAIL] unexpected exception: ' + e.stack.split('\n').slice(0, 3).join('\n'));
  process.exit(1);
});
