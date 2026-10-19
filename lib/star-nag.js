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
function checkStarred() {
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (!token) return null;          // 没 token，无法确认
  // 用同步 API：CLI 启动阶段还没有 event loop 可用
  try {
    const { execFileSync } = require('child_process');
    const out = execFileSync('curl', [
      '-sS', '-m', '3',
      '-H', `Authorization: Bearer ${token}`,
      '-H', 'Accept: application/vnd.github+json',
      '-H', 'X-GitHub-Api-Version: 2022-11-28',
      `https://api.github.com/user/starred/${REPO}`,
    ], { stdio: ['ignore', 'pipe', 'ignore'] }).toString();
    if (out.trim() === '') return true;     // 200 + 空数组 = 列了但没有这个仓库
    const j = JSON.parse(out);
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
  out.write(`  (set JSQL_NO_STAR_NAG=1 to hide, or star it and it'll stop asking)\n\n`);

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

module.exports = { nag, checkStarred, readConfig, setStarred, configPath, REPO, URL };
