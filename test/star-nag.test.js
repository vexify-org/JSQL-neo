/**
 * jsql star 授权流回归测试
 *
 * 背景：线上 result.php 曾把「state 文件存在」一律当成授权完成，
 * 而 start.php 一开始就会写入 {"state":"started"}。于是 CLI 第二轮轮询
 * 就拿到 started 当 done，打印出：
 *     Authorization finished, but undefined has not starred undefined yet.
 *     Star it at https://github.com/undefined then run `jsql star` again.
 * 真相是授权根本没走完。
 *
 * 覆盖：
 *   1. parseAuthResult 对各形态响应的归一化（中间态不得当成完成）
 *   2. CLI 对 starred / not-starred / denied / error 的输出
 *   3. 慢用户场景：先 pending 再完成，CLI 必须继续等而不是误判
 *   4. waitForResult 的超时与 expired 收敛
 *
 * 注意：AUTH_RESULT 是 lib/star-nag 在 require 时从 JSQL_AUTH_BASE 读的，
 * 所以必须先把 env 设好再 require（waitForResult 又用同步 curl，
 * 本进程内的 server 会被饿死，所以 CLI 相关用例一律起子进程）。
 */
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');

const PORT = Number(process.env.JSQL_STAR_TEST_PORT) || 34711;
process.env.JSQL_AUTH_BASE = `http://127.0.0.1:${PORT}`;

const sn = require('../lib/star-nag');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('[OK]   ' + name); }
  else { fail++; console.log('[FAIL] ' + name + (extra !== undefined ? ' → ' + JSON.stringify(extra) : '')); }
}

/** 当前 result.php 要返回的内容；pollsLeft <= 0 时切到 after */
let scenario = { state: 'pending' };
let pollsLeft = 0;
let after = null;

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  if (new URL(req.url, 'http://127.0.0.1').pathname === '/result.php') {
    if (pollsLeft > 0 && --pollsLeft === 0 && after) scenario = after;
    res.end(JSON.stringify(scenario));
    return;
  }
  res.end('{}');
});

function runCli(mrPath) {
  return new Promise((resolve) => {
    const bin = path.join(__dirname, '..', 'bin', 'jsql');
    const child = spawn(process.execPath, [bin, 'star'], {
      env: { ...process.env, JSQL_AUTH_BASE: `http://127.0.0.1:${PORT}`, JSQL_MR_PATH: mrPath, JSQL_NO_STAR_NAG: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { out += c; });
    const t = setTimeout(() => { try { child.kill(); } catch (e) {} resolve(out + '\n[TIMEOUT]'); }, 40000);
    child.on('exit', () => { clearTimeout(t); resolve(out); });
  });
}

async function main() {
  /* ---------- 1. parseAuthResult ---------- */
  console.log('--- parseAuthResult：中间态不得当成完成 ---');
  {
    const P = sn.parseAuthResult;
    ok('done + starred=true → starred', P({ state: 'done', result: { starred: true, login: 'u', repo: 'o/r' } }).status === 'starred');
    ok('done + starred=false → not-starred', P({ state: 'done', result: { starred: false, login: 'u', repo: 'o/r' } }).status === 'not-starred');
    ok('started 被误报成 done → 未完成', P({ state: 'done', result: { state: 'started', at: 1 } }) === null);
    ok('pending → 未完成', P({ state: 'pending' }) === null);
    ok('缺 result 的 done → 未完成', P({ state: 'done' }) === null);
    ok('denied → 带原因', P({ state: 'denied', result: { error: 'access_denied' } }).status === 'denied');
    ok('error → 带原因', P({ state: 'error', result: { error: 'The code passed is incorrect or expired.' } }).error === 'The code passed is incorrect or expired.');
    ok('空响应 → 未完成', P(null) === null && P({}) === null);
    ok('未知状态 → 未完成', P({ state: 'weird' }) === null);
    ok('expired 不在终态集（由 waitForResult 单独处理）', P({ state: 'expired' }) === null);
  }

  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
  const mrDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsqlmr-'));

  /* ---------- 2. CLI 各终态输出 ---------- */
  console.log('\n--- 假 result.php 驱动真实 CLI ---');
  const cases = [
    ['done + starred', { state: 'done', result: { starred: true, login: 'octocat', repo: 'vexify-org/JSQL-neo' } },
      'Confirmed: octocat has starred vexify-org/JSQL-neo. Thanks!'],
    ['done + 未 star', { state: 'done', result: { starred: false, login: 'octocat', repo: 'vexify-org/JSQL-neo' } },
      'Authorization finished, but octocat has not starred vexify-org/JSQL-neo yet.'],
    ['denied', { state: 'denied', result: { error: 'access_denied' } },
      'Authorization was declined: access_denied'],
    ['error（code 过期/复用）', { state: 'error', result: { error: 'The code passed is incorrect or expired.' } },
      'Authorization failed: The code passed is incorrect or expired.'],
  ];
  for (const [name, resp, expect] of cases) {
    scenario = resp; pollsLeft = 0; after = null;
    const out = await runCli(path.join(mrDir, name.replace(/[^a-z0-9]+/gi, '-')));
    ok(`CLI 输出正确：${name}`, out.includes(expect), out.trim().slice(0, 200));
    ok(`CLI 不再出现 undefined：${name}`, !/undefined/.test(out), out.trim().slice(0, 200));
  }

  /* ---------- 3. 慢用户 ---------- */
  console.log('\n--- 慢用户：先 pending 再完成，CLI 必须继续等而不是误判 ---');
  {
    scenario = { state: 'pending' };
    pollsLeft = 2;
    after = { state: 'done', result: { starred: true, login: 'octocat', repo: 'vexify-org/JSQL-neo' } };
    const out = await runCli(path.join(mrDir, 'slow'));
    ok('等完 pending 后正确确认', out.includes('Confirmed: octocat has starred vexify-org/JSQL-neo. Thanks!'), out.trim().slice(0, 200));
    ok('全程没有误判成完成', !/Authorization finished/.test(out), out.trim().slice(0, 200));
    ok('全程没有 undefined', !/undefined/.test(out), out.trim().slice(0, 200));
  }

  /* ---------- 4. waitForResult ---------- */
  console.log('\n--- waitForResult：中间态与超时 ---');
  {
    // waitForResult 用同步 curl，会阻塞本进程事件循环 —— server 必须留在父进程，
    // 轮询放到子进程里跑，否则 parent 的 server 被饿死，curl 全部 -m 超时。
    const url = `http://127.0.0.1:${PORT}/start.php?nonce=abcdefghijklmnopqrst`;
    const poll = (resp, timeoutMs) => new Promise((resolve) => {
      scenario = resp; pollsLeft = 0; after = null;
      const code = [
        `const sn = require(${JSON.stringify(path.join(__dirname, '..', 'lib', 'star-nag'))});`,
        `const t = Date.now();`,
        `const r = sn.waitForResult(process.env.TEST_URL, ${timeoutMs});`,
        `process.stdout.write(JSON.stringify({ r, ms: Date.now() - t }));`,
      ].join('\n');
      const c = spawn(process.execPath, ['-e', code],
        { env: { ...process.env, TEST_URL: url }, stdio: ['ignore', 'pipe', 'ignore'] });
      let out = '';
      c.stdout.on('data', (d) => { out += d; });
      c.on('exit', () => { try { resolve(JSON.parse(out)); } catch (e) { resolve({ r: null, ms: -1 }); } });
    });

    for (const [name, resp] of [
      ['pending', { state: 'pending' }],
      ['老服务端误报 started 为 done', { state: 'done', result: { state: 'started', at: 1 } }],
    ]) {
      const { r, ms } = await poll(resp, 3000);
      ok(`waitForResult(${name}) 超时返回 null`, r === null, r);
      ok(`确实等满了 3 秒`, ms >= 2800, ms);
    }
    {
      const { r, ms } = await poll({ state: 'expired' }, 5000);
      ok('waitForResult(expired) 立即收敛', !!r && r.status === 'expired', r);
      ok('expired 没有拖到超时', ms >= 0 && ms < 2500, ms);
    }
  }

  server.close();
  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
