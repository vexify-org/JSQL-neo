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
        if (!j || j.state !== 'done' || !j.result) return;
        clearInterval(t);
        const cfg = readConfig();
        cfg.oauthCheckedAt = Date.now();
        cfg.login = j.result.login || undefined;
        cfg.starred = !!j.result.starred;
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
function nag(opts = {}) {
  const out = opts.out || process.stdout;
  const cfg = readConfig();

  if (!opts.force && cfg.starred) return false;

  const last = Number(cfg.lastNagAt) || 0;
  if (!opts.force && last && Date.now() - last < NAG_INTERVAL_DAYS * 86400000) {
    // 顺便有机会补记 star 状态（不打印）
    const s = checkStarred();
    if (s) { cfg.starred = true; writeConfig(cfg); }
    return false;
  }

  // 有 token 就先查，省得对已经 star 的人重复啰嗦
  const starred = checkStarred();
  if (starred) {
    cfg.starred = true;
    cfg.starredAt = Date.now();
    writeConfig(cfg);
    return false;                 // 已 star，闭嘴
  }

  out.write(`\n  If JSQL-NEO saved you time, a star helps others find it: ${URL}\n`);
  out.write(`  Run \`jsql star\` to confirm and stop seeing this (or set JSQL_NO_STAR_NAG=1 to hide)\n\n`);
  startOauthCheck();

  cfg.lastNagAt = Date.now();
  writeConfig(cfg);

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

module.exports = { nag, checkStarred, startOauthCheck, readConfig, setStarred, configPath, REPO, URL };
