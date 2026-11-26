/*
 * #537 回归测试：server stop/status 不能只凭 PID 数字误杀复用 PID 的无关进程。
 *   node test/issue-537.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const ctl = require(path.join(__dirname, '..', 'bin', 'jsql-server-control.js'));

let passed = 0, failed = 0;
async function t(name, fn) {
  try { await fn(); passed++; console.log(`ok - ${name}`); }
  catch (e) { failed++; console.error(`not ok - ${name}\n  ${e && e.message}`); }
}
function alive(pid) { try { process.kill(pid, 0); return true; } catch (_) { return false; } }
function makeDummy() {
  const p = spawn('sleep', ['300'], { stdio: 'ignore' });
  p.unref();
  return p;
}
function cleanup(pid) {
  try { fs.unlinkSync(ctl.PID_FILE); } catch (_) {}
  if (alive(pid)) { try { process.kill(pid, 'SIGKILL'); } catch (_) {} }
}

(async () => {
  await t('#537 裸 PID 文件（旧格式/无法校验身份）→ status 不报 running', async () => {
    const dummy = makeDummy();
    try {
      fs.mkdirSync(ctl.STATE_DIR, { recursive: true });
      fs.writeFileSync(ctl.PID_FILE, String(dummy.pid), 'utf8');
      const st = await ctl.serverControl.status({});
      assert.ok(!/is running/.test(st), `status says running: ${st}`);
    } finally { cleanup(dummy.pid); }
  });

  await t('#537 token 不匹配的 PID 文件 → stop 不 SIGTERM 无关进程', async () => {
    const dummy = makeDummy();
    try {
      fs.mkdirSync(ctl.STATE_DIR, { recursive: true });
      fs.writeFileSync(ctl.PID_FILE, JSON.stringify({ pid: dummy.pid, token: 'wrong-token' }), 'utf8');
      const msg = await ctl.serverControl.stop({});
      assert.ok(!/stopped/.test(msg), `stop claims success: ${msg}`);
      await new Promise(r => setTimeout(r, 100));
      assert.ok(alive(dummy.pid), 'unrelated process must survive');
    } finally { cleanup(dummy.pid); }
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
})();
