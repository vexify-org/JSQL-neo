'use strict';
/**
 * jsql uninstall —— 清理 jsql-neo 的用户级数据（可选卸载全局包）。
 *
 * 红线：
 *   - 只允许删除用户 home 目录下、且属于 jsql 的固定路径；
 *   - 拒绝删除 home 本身、文件系统根、当前工作目录、包目录（仓库）及其祖先/子目录；
 *   - 绝不静默删除：非 TTY 且没有 --yes 时直接拒绝；TTY 下要求交互确认。
 *
 * 覆盖的数据位置（与代码里的实际路径保持一致）：
 *   ~/.jsql/                 插件注册表安装目录（lib/database.js / src/cli/plugin.js）
 *   ~/.config/jsql/          模块配置 mod.config（lib/mod.js）
 *   ~/.jsqlmr                star 提示状态（lib/star-nag.js）
 *   ~/.cache/jsql/           可能的缓存（存在才删）
 * 支持 JSQL_PLUGIN_DIR / JSQL_MOD_CONFIG / JSQL_MR_PATH / JSQL_CACHE_DIR 覆盖。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { execFileSync, spawnSync } = require('child_process');

const PKG_NAME = 'jsql-neo';

function packageDir() {
  return path.resolve(__dirname, '..');
}

function npmCommand() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

function isInside(child, parent) {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * 列出所有清理目标。
 * @param {{keepData?: boolean}} [opts]
 * @returns {Array<{path: string, kind: 'dir'|'file', label: string}>}
 */
function collectTargets(opts = {}) {
  if (opts.keepData) return [];
  const home = os.homedir();
  const targets = [];
  const add = (p, kind, label) => {
    if (!p) return;
    const resolved = path.resolve(p);
    if (targets.some((t) => t.path === resolved)) return;
    targets.push({ path: resolved, kind, label });
  };

  add(process.env.JSQL_PLUGIN_DIR || path.join(home, '.jsql'), 'dir', '插件/用户数据 (~/.jsql)');

  if (process.env.JSQL_MOD_CONFIG) {
    add(process.env.JSQL_MOD_CONFIG, 'file', '模块配置 (JSQL_MOD_CONFIG)');
  } else {
    add(path.join(home, '.config', 'jsql'), 'dir', '模块配置 (~/.config/jsql)');
  }

  add(process.env.JSQL_MR_PATH || path.join(home, '.jsqlmr'), 'file', 'star 状态 (~/.jsqlmr)');
  add(process.env.JSQL_CACHE_DIR || path.join(home, '.cache', 'jsql'), 'dir', '缓存 (~/.cache/jsql)');

  return targets;
}

/**
 * 安全校验：任何目标都必须落在 home 下、且不能碰到仓库/工作目录。
 * @throws {Error} 校验不通过
 */
function assertSafeTarget(target) {
  const resolved = path.resolve(target.path || target);
  const home = path.resolve(os.homedir());
  const pkg = packageDir();
  const cwd = path.resolve(process.cwd());
  const root = path.parse(resolved).root;

  if (resolved === root) {
    throw new Error(`refusing to remove filesystem root: ${resolved}`);
  }
  if (resolved === home) {
    throw new Error(`refusing to remove home directory: ${resolved}`);
  }
  if (!isInside(resolved, home)) {
    throw new Error(`refusing to remove path outside home (${home}): ${resolved}`);
  }
  if (isInside(pkg, resolved) || isInside(resolved, pkg)) {
    throw new Error(`refusing to remove path overlapping the jsql-neo package: ${resolved}`);
  }
  // 目标不能是当前工作目录的祖先（否则会连工作目录一起删掉）
  if (isInside(cwd, resolved)) {
    throw new Error(`refusing to remove an ancestor of the current working directory: ${resolved}`);
  }
  // 目标必须是 jsql 命名的目录/文件，杜绝误删
  const base = path.basename(resolved).toLowerCase();
  const looksLikeJsql = base === '.jsqlmr' || base.startsWith('jsql') || base === '.jsql';
  const parentIsConfig = path.basename(path.dirname(resolved)) === '.config'
    || path.basename(path.dirname(resolved)) === '.cache';
  if (!looksLikeJsql && !parentIsConfig) {
    throw new Error(`refusing to remove unexpected path: ${resolved}`);
  }
  return resolved;
}

/**
 * 检查目标是否存在，并给出可删除列表（不实际删除）。
 * @param {{keepData?: boolean}} [opts]
 */
function inspectTargets(opts = {}) {
  return collectTargets(opts).map((t) => {
    let exists = false;
    let isSymlink = false;
    try {
      const st = fs.lstatSync(t.path);
      exists = true;
      isSymlink = st.isSymbolicLink();
    } catch (_) { /* 不存在 */ }
    return { ...t, exists, isSymlink };
  });
}

/**
 * 删除数据目标。
 * @param {{keepData?: boolean, dryRun?: boolean}} [opts]
 * @returns {{removed: string[], skipped: string[], failed: Array<{path: string, error: string}>}}
 */
function removeData(opts = {}) {
  const result = { removed: [], skipped: [], failed: [] };
  const targets = inspectTargets(opts);
  for (const t of targets) {
    if (!t.exists) {
      result.skipped.push(t.path);
      continue;
    }
    let safe;
    try {
      safe = assertSafeTarget(t);
    } catch (e) {
      result.failed.push({ path: t.path, error: e.message });
      continue;
    }
    if (opts.dryRun) {
      result.removed.push(safe);
      continue;
    }
    try {
      // 符号链接只删链接本身，绝不跟随
      if (t.isSymlink) fs.unlinkSync(safe);
      else fs.rmSync(safe, { recursive: true, force: true });
      result.removed.push(safe);
    } catch (e) {
      result.failed.push({ path: safe, error: e.message });
    }
  }
  return result;
}

/** 卸载全局 npm 包；失败时返回错误信息而不是抛异常 */
function uninstallGlobal(dryRun) {
  const args = ['uninstall', '-g', PKG_NAME];
  const command = `${npmCommand()} ${args.join(' ')}`;
  if (dryRun) return { ok: true, dryRun: true, command, error: null };

  const r = spawnSync(npmCommand(), args, {
    stdio: 'inherit',
    timeout: 5 * 60 * 1000,
  });
  if (r.error) return { ok: false, command, error: r.error.message };
  if (r.status !== 0) return { ok: false, command, error: `npm uninstall exited with code ${r.status}` };
  return { ok: true, command, error: null };
}

/** 全局安装是否还存在（用 npm root -g 判断） */
function isGloballyInstalled() {
  try {
    const root = execFileSync(npmCommand(), ['root', '-g'], {
      encoding: 'utf8',
      timeout: 15000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (!root) return false;
    return fs.existsSync(path.join(root, PKG_NAME, 'package.json'));
  } catch (_) {
    return false;
  }
}

/** 交互确认；非 TTY 返回 false（调用方应要求 --yes） */
function confirm(question) {
  return new Promise((resolve) => {
    if (!process.stdin.isTTY) {
      resolve(false);
      return;
    }
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(/^y(es)?$/i.test(String(answer || '').trim()));
    });
  });
}

module.exports = {
  PKG_NAME,
  collectTargets,
  assertSafeTarget,
  inspectTargets,
  removeData,
  uninstallGlobal,
  isGloballyInstalled,
  confirm,
  packageDir,
  isInside,
};
