'use strict';
/**
 * CLI 启动时的 star 提示。
 *
 * 行为：
 *   1. 已确认 star 过 → 什么都不说
 *   2. 距上次提示不足 N 天 → 什么都不说
 *   3. 否则打印一行提示，并在配置里记下时间
 *
 * star 检测：若环境里有 GitHub token（GITHUB_TOKEN / GH_TOKEN），
 * 就问 GitHub「这个用户 star 过没有」。查到了就记住，以后彻底闭嘴 ——
 * 用户已经 star 过了，再提就是噪音。
 *
 * 配置文件：~/.jsqlmr（JSON）。可用 JSQL_MR_PATH 覆盖。
 *
 * 全程不影响命令本身：任何异常都吞掉，绝不因为提示语让 CLI 起不来。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = 'vexify-org/JSQL-neo';
const URL = `https://github.com/${REPO}`;
const NAG_INTERVAL_DAYS = 30;

const AUTH_BASE = process.env.JSQL_AUTH_BASE || 'https://auth.vexify.top';
const AUTH_START = AUTH_BASE + '/start.php';
const AUTH_RESULT = AUTH_BASE + '/result.php';

/**
 * 发起 OAuth 浏览器流并在后台轮询结果。
 *
 * 绝不阻塞命令：开完浏览器就返回，轮询用 unref 过的定时器跑。
 * 拿到结果写进 ~/.jsqlmr（starred: true/false）。
 * 进程提前退出就放弃这一次，下次启动会再提示（30 天节流管频率）。
 */
// result.php 的合法终态：done / denied / error。
// 只有终态才写配置——"started" 这一类中间态写进去只会污染 ~/.jsqlmr。
const TERMINAL_STATES = new Set(['done', 'denied', 'error']);

// 把 result.php 的响应收敛成规范状态。老服务端会把 started 也报成 done，
// 缺少 starred 字段 —— 一律当未完成处理，让调用方继续等。
function parseAuthResult(j) {
  if (!j || typeof j !== 'object') return null;
  const st = j.state;
  if (!TERMINAL_STATES.has(st)) return null;
  const r = j.result || {};
  if (st === 'done') {
    if (typeof r.starred !== 'boolean') return null;
    return { status: r.starred ? 'starred' : 'not-starred', login: r.login, repo: r.repo };
  }
  return { status: st, error: r.error || (st === 'denied' ? 'authorization denied' : 'authorization failed') };
}

function startOauthCheck() {
  const crypto = require('crypto');
  const nonce = crypto.randomBytes(24).toString('base64url');
  const url = AUTH_START + '?nonce=' + nonce;

  // 开浏览器：三平台各一个命令；失败就只打印链接让人手动点
  const cmd = process.platform === 'win32' ? 'start'
            : process.platform === 'darwin' ? 'open' : 'xdg-open';
  try {
    require('child_process').spawn(cmd, [url], {
      detached: true, stdio: 'ignore', shell: process.platform === 'win32',
    }).unref();
  } catch (e) {
    console.log('  Open this to confirm your star: ' + url);
  }

  // 后台轮询，最多约 90 秒
  let tries = 0;
  const t = setInterval(() => {
    if (++tries > 45) { clearInterval(t); return; }
    const { execFile } = require('child_process');
    execFile('curl', ['-sS', '-m', '5', AUTH_RESULT + '?nonce=' + nonce],
      { timeout: 6000, encoding: 'utf8' }, (err, stdout) => {
        if (err) return;
        let j = null;
        try { j = JSON.parse(stdout); } catch (e) { return; }
        const res = parseAuthResult(j);
        if (!res) return;   // pending / started / 格式不符 —— 继续等
        clearInterval(t);
        const cfg = readConfig();
        cfg.oauthCheckedAt = Date.now();
        cfg.login = res.login || undefined;
        cfg.starred = res.status === 'starred';
        if (cfg.starred) cfg.starredAt = Date.now();
        writeConfig(cfg);
      });
  }, 2000);
  t.unref();
  return url;
}

function configPath() {
  return process.env.JSQL_MR_PATH || path.join(os.homedir(), '.jsqlmr');
}

function readConfig() {
  try {
    const raw = fs.readFileSync(configPath(), 'utf8');
    const c = JSON.parse(raw);
    return (c && typeof c === 'object') ? c : {};
  } catch (e) {
    return {};                      // 不存在 / 坏了 / 没权限，都当新用户
  }
}

function writeConfig(cfg) {
  try {
    fs.writeFileSync(configPath(), JSON.stringify(cfg, null, 2) + '\n');
  } catch (e) {
    /* 写不了就算了，不该因此报错 */
  }
}

/** 同步问一下 GitHub：这个身份 star 过没有。查不到就返回 null（三态）。 */
/**
 * 找一个可用的 GitHub 凭据。
 * 1. GITHUB_TOKEN / GH_TOKEN 环境变量
 * 2. 官方 gh CLI（`gh auth token`）—— 多数开发机上它已经登录过了，
 *    不该要求用户为了看一句提示语再去配环境变量
 * 3. 都没有 → null
 */
function findToken() {
  const env = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (env) return env;
  try {
    const { execFileSync } = require('child_process');
    const t = execFileSync('gh', ['auth', 'token'], {
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2500,
      encoding: 'utf8',
    }).trim();
    if (t) return t;
  } catch (e) {
    // 没装 gh / 没登录 / 太慢 —— 都当作没有
  }
  return null;
}

/**
 * 尽力而为地问一次「这个身份 star 过没有」。查不到返回 null（三态）。
 *
 * 只在「真的准备显示提示语时」才发这个网络请求；已标记 starred 或被
 * 30 天节流挡掉时一次请求都不会发。
 *
 * @returns {boolean|null} true=star 过  false=没 star  null=无法确认
 */
function checkStarred() {
  const token = findToken();
  if (!token) return null;          // 没有可用凭据 → 无法确认
  // 用同步 API：CLI 启动阶段还没有 event loop 可用
  try {
    const { execFileSync } = require('child_process');
    const out = execFileSync('curl', [
      '-sS', '-m', '4',
      '-H', `Authorization: Bearer ${token}`,
      '-H', 'Accept: application/vnd.github+json',
      '-H', 'X-GitHub-Api-Version: 2022-11-28',
      `https://api.github.com/user/starred/${REPO}`,
    ], { stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }).toString();
    if (out.trim() === '') return true;     // 200 + 空数组 = 列了但没有这个仓库
    const j = JSON.parse(out);
    // GitHub 出错时返回的是 {"message":"Bad credentials"} 之类，不是数组。
    // 那说明 token 无效/过期 —— 属于「无法确认」，不能当成「没 star」，
    // 否则会永远提示下去。
    if (j && !Array.isArray(j) && typeof j.message === 'string') return null;
    return Array.isArray(j) && j.length > 0;
  } catch (e) {
    return null;                  // 网络不通 / 401 / 没装 curl → 不确定
  }
}

/**
 * @param {object} [opts]
 * @param {NodeJS.WritableStream} [opts.out] 输出流（默认 stdout）
 * @param {boolean} [opts.force] 忽略节流，强制提示一次
 * @returns {boolean} 是否真的打印了
 */
/**
 * 在 stdout 上印一行 star 提示。
 *
 * 规则（用户明确要求）：
 *   1. **不强制** —— 只印文字，绝不自动弹浏览器。要确认请用户自己跑 `jsql star`。
 *   2. **除 `version` 外的每个命令都印**，没有 30 天节流这类「只提醒一次」的设计。
 *   3. `~/.jsqlmr` 记录是否 star 过 —— `starred: true` 是唯一的闭嘴开关
 *      （另外 `JSQL_NO_STAR_NAG=1` 可临时静音）。
 *
 * @returns {boolean} 是否真的印了
 */
function nag(opts = {}) {
  const out = opts.out || process.stdout;
  const cfg = readConfig();

  // 已确认 star 过 → 永久闭嘴。jsqlmr 就是干这个的。
  if (!opts.force && cfg.starred) return false;

  // 有凭据就先查一下，省得对已经 star 的人反复啰嗦（查不到就当没查，照印）
  const starred = checkStarred();
  if (starred) {
    cfg.starred = true;
    cfg.starredAt = Date.now();
    writeConfig(cfg);
    return false;
  }

  out.write(`\n  If JSQL-NEO saved you time, a star helps others find it: ${URL}\n`);
  out.write(`  如果帮到了你，点个 star；运行 \`jsql star\` 确认 · JSQL_NO_STAR_NAG=1 关闭提示\n\n`);

  // 只记录「有没有 star」，不再写 lastNagAt —— 没有节流，写它没有意义。
  return true;
}

/** 供 `jsql star` 之类的命令用：手动确认 / 取消 */
function setStarred(v) {
  const cfg = readConfig();
  cfg.starred = !!v;
  if (v) cfg.starredAt = Date.now();
  writeConfig(cfg);
  return cfg.starred;
}

/**
 * 同步阻塞轮询授权结果，直到拿到 done / expired 或超时。
 *
 * `jsql star` 用：startOauthCheck 的定时器是 unref 的（不能拖住别的命令），
 * 所以 star 命令必须自己前台等，否则授权完成后 CLI 早已退出，结果没人接。
 *
 * @param {string} startUrl startOauthCheck 返回的 URL（含 nonce）
 * @param {number} [timeoutMs] 最长等待时间，默认 180 秒
 * @returns {object|null} result 对象（含 login/starred/repo），超时或失败返回 null
 */
/**
 * 前台等待授权结果（`jsql star` 用）。
 *
 * 返回规范化后的结果对象：
 *   { status: 'starred', login, repo }        已 star
 *   { status: 'not-starred', login, repo }    授权完成但没 star
 *   { status: 'denied', error }               用户在 GitHub 拒绝授权
 *   { status: 'error', error }                回调失败（code 过期/复用等）
 *   { status: 'expired' }                     链接超龄被清理
 *   null                                     超时（timeoutMs 内没有终态）
 *
 * 老服务端会把 "started" 这类中间态也报成 done 且不带 starred 字段 ——
 * parseAuthResult 一律判为未完成，继续轮询直到超时，而不是打印一段
 * login/repo 全为 undefined 的假失败信息。
 */
function waitForResult(startUrl, timeoutMs = 180000) {
  const { execFileSync } = require('child_process');
  // 注意：本模块顶部有 const URL = 'https://github.com/...' 会遮蔽全局 URL 类，
  // 必须显式从 url 模块取，否则 new URL(...) 抛 TypeError
  const { URL: NodeURL } = require('url');
  let nonce = '';
  try {
    nonce = new NodeURL(startUrl).searchParams.get('nonce') || '';
  } catch (e) {
    return null;
  }
  if (!nonce) return null;

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const out = execFileSync('curl', ['-sS', '-m', '5', AUTH_RESULT + '?nonce=' + nonce],
        { stdio: ['ignore', 'pipe', 'ignore'], timeout: 8000, encoding: 'utf8' });
      let j = null;
      try { j = JSON.parse(out); } catch (e) { j = null; }
      const res = parseAuthResult(j);
      if (res) return res;
      if (j && j.state === 'expired') return { status: 'expired' };
    } catch (e) {
      // 网络抖动 / 超时 —— 继续等
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2000);
  }
  return null;
}

module.exports = { nag, checkStarred, startOauthCheck, waitForResult, parseAuthResult, readConfig, setStarred, configPath, REPO, URL };
