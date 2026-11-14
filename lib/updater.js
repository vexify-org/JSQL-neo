'use strict';
/**
 * jsql update —— 检查并安装 jsql-neo 的新版本。
 *
 * 设计取舍：
 *   - 版本来源优先 npm registry（https://registry.npmjs.org/jsql-neo/latest），
 *     失败时退回 `npm view jsql-neo version`；两者都失败就优雅报错，不 crash。
 *   - 只有「全局安装」才自动执行 `npm install -g jsql-neo@latest`；
 *     本地依赖安装绝不自动改用户的 package.json，只打印清晰指令。
 *   - `--check` 只看不装；`--dry-run` 打印将要执行的命令；`--force` 即使已是最新也重装。
 *
 * 不引入任何第三方依赖（与项目其它部分保持一致）。
 */

const path = require('path');
const https = require('https');
const { execFileSync, spawnSync } = require('child_process');
const { isOffline } = require('./network-policy');

const PKG_NAME = 'jsql-neo';
const REGISTRY_LATEST = `https://registry.npmjs.org/${PKG_NAME}/latest`;
const FETCH_TIMEOUT_MS = 8000;
const MAX_BODY_BYTES = 512 * 1024;

function packageDir() {
  return path.resolve(__dirname, '..');
}

function currentVersion() {
  return require('../package.json').version;
}

// ─── 版本比较 ────────────────────────────────────────────────

/** 解析 semver（宽松）：v1.2.3 / 1.2 / 1.2.3-beta.1 → { nums, pre } */
function parseVersion(v) {
  let s = String(v == null ? '' : v).trim();
  if (s[0] === 'v' || s[0] === 'V') s = s.slice(1);
  const plus = s.indexOf('+');
  if (plus !== -1) s = s.slice(0, plus);
  const dash = s.indexOf('-');
  const core = dash === -1 ? s : s.slice(0, dash);
  const pre = dash === -1 ? '' : s.slice(dash + 1);
  const nums = core.split('.').map((n) => {
    const x = parseInt(n, 10);
    return Number.isFinite(x) ? x : 0;
  });
  return { nums, pre };
}

// #90：prerelease 标识符按 semver 规则比较：数字标识符按数值、字母按字典序、
// 数字 > 字母、长度长者大。此前用 A.pre > B.pre 字符串比较，'alpha.10' < 'alpha.9' 误判。
function comparePre(a, b) {
  if (a === b) return 0;
  if (!a) return 1;   // 无 prerelease > 有 prerelease
  if (!b) return -1;
  const A = a.split('.');
  const B = b.split('.');
  const len = Math.max(A.length, B.length);
  for (let i = 0; i < len; i++) {
    const x = A[i], y = B[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xn = /^\d+$/.test(x), yn = /^\d+$/.test(y);
    if (xn && yn) {
      const xi = parseInt(x, 10), yi = parseInt(y, 10);
      if (xi !== yi) return xi > yi ? 1 : -1;
    } else if (xn !== yn) {
      return xn ? 1 : -1;  // 数字标识符 > 字母标识符
    } else if (x !== y) {
      return x > y ? 1 : -1;
    }
  }
  return 0;
}

/** semver-ish 比较：a < b → -1，相等 → 0，a > b → 1（prerelease 视为更低）。
 *  #90：支持 4+ 段版本号（此前截断为 3 段，1.2.3.4 与 1.2.3 被误判相等）。 */
function compareVersions(a, b) {
  const A = parseVersion(a);
  const B = parseVersion(b);
  const len = Math.max(A.nums.length, B.nums.length);
  for (let i = 0; i < len; i++) {
    const x = A.nums[i] || 0, y = B.nums[i] || 0;
    if (x !== y) return x > y ? 1 : -1;
  }
  return comparePre(A.pre, B.pre);
}

function isNewer(latest, current) {
  return compareVersions(latest, current) > 0;
}

// ─── 网络 ───────────────────────────────────────────────────

/* NETWORK: 查询 npm registry 上的最新版本号
 * Why:     「有没有新版本」只存在于 registry，本地包里没有这个信息。
 * Trigger: 仅 `jsql update` / `jsql update --check` 显式调用。
 * Offline: JSQL_OFFLINE=1 → runUpdate 直接返回离线结果，不发请求。
 * Scope:   https://registry.npmjs.org/jsql-neo/latest（只读，无认证）。
 */
function httpGetText(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) {
      reject(new Error(`too many redirects for ${url}`));
      return;
    }
    let req;
    try {
      req = https.get(url, {
        headers: {
          'User-Agent': `jsql-neo/${currentVersion()} (+https://github.com/vexify-org/JSQL-neo)`,
          Accept: 'application/vnd.npm.install-v1+json, application/json;q=0.9, */*;q=0.1',
        },
      }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          const next = new URL(res.headers.location, url).toString();
          if (!/^https?:/i.test(next)) {
            reject(new Error(`invalid redirect target for ${url}`));
            return;
          }
          httpGetText(next, redirects + 1).then(resolve, reject);
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`HTTP ${res.statusCode} for ${url}`));
          return;
        }
        const chunks = [];
        let received = 0;
        res.on('data', (chunk) => {
          received += chunk.length;
          if (received > MAX_BODY_BYTES) {
            res.destroy();
            reject(new Error(`response too large for ${url}`));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        res.on('error', reject);
      });
    } catch (e) {
      reject(e);
      return;
    }
    req.on('error', reject);
    req.setTimeout(FETCH_TIMEOUT_MS, () => {
      try { req.destroy(); } catch (_) { /* ignore */ }
      reject(new Error(`request timed out after ${FETCH_TIMEOUT_MS}ms: ${url}`));
    });
  });
}

/**
 * 查询 npm 上的最新版本号。
 * @param {{ fetchImpl?: Function, npmView?: boolean }} [opts] 测试可注入
 * @returns {Promise<{version: string, source: string}>}
 */
async function fetchLatestVersion(opts = {}) {
  const fetchImpl = opts.fetchImpl || httpGetText;
  const errors = [];

  // 1) registry HTTP（快，且不需要 npm 进程）
  try {
    const body = await fetchImpl(REGISTRY_LATEST);
    const data = JSON.parse(body);
    if (data && typeof data.version === 'string' && data.version.trim()) {
      return { version: data.version.trim(), source: 'registry' };
    }
    throw new Error('registry response has no version field');
  } catch (e) {
    errors.push(`registry: ${e.message}`);
  }

  // 2) npm CLI 兜底（有些环境走私有 registry 配置，curl 直连反而不通）
  if (opts.npmView !== false) {
    try {
      const out = execFileSync(npmCommand(), ['view', PKG_NAME, 'version'], {
        encoding: 'utf8',
        timeout: 15000,
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim();
      // `npm view` 在旧版本里可能输出多行/带引号
      const m = out.match(/\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/);
      if (m) return { version: m[0], source: 'npm-view' };
      throw new Error(`unexpected npm view output: ${out.slice(0, 120)}`);
    } catch (e) {
      errors.push(`npm view: ${e.message}`);
    }
  }

  const err = new Error(`could not determine the latest version (${errors.join('; ')})`);
  err.causes = errors;
  throw err;
}

// ─── 安装形态判断 ───────────────────────────────────────────

function npmCommand() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

function isInside(child, parent) {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
}

/** 收集可能的全局 node_modules 根目录 */
function globalRoots() {
  const roots = [];
  try {
    const out = execFileSync(npmCommand(), ['root', '-g'], {
      encoding: 'utf8',
      timeout: 15000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (out) roots.push(out);
  } catch (_) { /* npm 不可用就靠下面的启发式 */ }

  if (process.env.npm_config_prefix) {
    roots.push(path.join(process.env.npm_config_prefix, 'lib', 'node_modules'));
    if (process.platform === 'win32') {
      roots.push(path.join(process.env.npm_config_prefix, 'node_modules'));
    }
  }
  if (process.platform === 'win32' && process.env.APPDATA) {
    roots.push(path.join(process.env.APPDATA, 'npm', 'node_modules'));
  }
  return Array.from(new Set(roots.filter(Boolean)));
}

/**
 * 判断当前这份 jsql-neo 是否来自全局安装。
 * @param {string} [dir] 包目录，默认是 lib/.. 
 */
function isGlobalInstall(dir) {
  const pkgDir = path.resolve(dir || packageDir());
  return globalRoots().some((root) => isInside(pkgDir, root));
}

/** 当前包是否位于某个项目的 node_modules 下（本地依赖安装） */
function isLocalDependency(dir) {
  const pkgDir = path.resolve(dir || packageDir());
  return path.basename(path.dirname(pkgDir)) === 'node_modules';
}

// ─── 更新流程 ───────────────────────────────────────────────

function installCommand(version) {
  return `${npmCommand()} install -g ${PKG_NAME}@${version}`;
}

/**
 * 执行更新检查 / 安装。
 * @param {{checkOnly?: boolean, force?: boolean, dryRun?: boolean}} [opts]
 */
async function runUpdate(opts = {}) {
  const current = currentVersion();
  if (isOffline()) {
    return {
      ok: false, current, latest: null,
      error: '离线模式（JSQL_OFFLINE=1）：jsql update 需要访问 npm registry',
      hints: ['取消 JSQL_OFFLINE 后重试；或手动执行 npm install -g jsql-neo@latest'],
    };
  }
  let latestInfo;
  try {
    latestInfo = await fetchLatestVersion({ fetchImpl: opts.fetchImpl, npmView: opts.npmView });
  } catch (e) {
    return {
      ok: false,
      current,
      latest: null,
      error: e.message,
      hints: [
        '检查网络/registry 配置，或手动执行: ' + installCommand('latest'),
      ],
    };
  }

  const latest = latestInfo.version;
  const updateAvailable = isNewer(latest, current);
  const global = typeof opts.global === 'boolean' ? opts.global : isGlobalInstall();
  const localDep = typeof opts.localDependency === 'boolean' ? opts.localDependency : isLocalDependency();
  const result = {
    ok: true,
    current,
    latest,
    latestSource: latestInfo.source,
    updateAvailable,
    installType: global ? 'global' : (localDep ? 'local-dependency' : 'unknown'),
    action: 'none',
    command: null,
    installed: false,
    warnings: [],
  };

  if (!updateAvailable && !opts.force) {
    result.action = opts.checkOnly ? 'checked' : 'up-to-date';
    return result;
  }

  if (opts.checkOnly) {
    result.action = 'checked';
    result.command = global ? installCommand(latest) : installCommand(latest);
    return result;
  }

  if (opts.dryRun) {
    result.action = 'would-install';
    result.command = installCommand(latest);
    return result;
  }

  // 非全局安装：不自动改动用户项目依赖，只给清晰指令
  if (!global) {
    result.action = 'instructions';
    result.command = installCommand(latest);
    result.localHint = `npm install ${PKG_NAME}@${latest}`;
    result.warnings.push(
      'jsql-neo 不是全局安装（当前位于项目 node_modules 或开发目录），未自动安装。'
    );
    return result;
  }

  const args = ['install', '-g', `${PKG_NAME}@${latest}`];
  const r = spawnSync(npmCommand(), args, {
    stdio: 'inherit',
    timeout: 10 * 60 * 1000,
  });
  result.command = `${npmCommand()} ${args.join(' ')}`;
  if (r.error) {
    result.ok = false;
    result.error = r.error.message;
    result.action = 'install-failed';
    result.warnings.push('可尝试手动执行并检查权限: ' + result.command);
    return result;
  }
  if (r.status !== 0) {
    result.ok = false;
    result.error = `npm install exited with code ${r.status}`;
    result.action = 'install-failed';
    result.warnings.push(
      '如果是权限问题，尝试: sudo ' + result.command,
    );
    return result;
  }

  result.installed = true;
  result.action = 'installed';
  result.after = latest;
  return result;
}

/** 把 runUpdate 的结果渲染成人读文本 */
function formatResult(r) {
  const lines = [];
  if (!r.ok) {
    lines.push(`更新失败: ${r.error}`);
    for (const h of r.hints || []) lines.push(`  ${h}`);
    return lines.join('\n');
  }
  lines.push(`当前版本: ${r.current}`);
  lines.push(`最新版本: ${r.latest}${r.latestSource === 'npm-view' ? ' (via npm view)' : ''}`);

  if (r.action === 'up-to-date') {
    lines.push('已是最新版本。');
  } else if (r.action === 'checked') {
    lines.push(r.updateAvailable ? '有新版本可用。' : '已是最新版本。');
    if (r.updateAvailable) lines.push(`运行 \`jsql update\` 安装，或手动执行: ${r.command}`);
  } else if (r.action === 'would-install') {
    lines.push(`将执行: ${r.command}`);
    lines.push('（--dry-run，未做任何修改）');
  } else if (r.action === 'installed') {
    lines.push(`已更新到 ${r.latest}。重新打开终端后 \`jsql version\` 生效。`);
  } else if (r.action === 'instructions') {
    lines.push('检测到非全局安装，未自动更新（避免改动你的项目依赖）。');
    lines.push(`全局安装: ${r.command}`);
    if (r.localHint) lines.push(`项目内升级: ${r.localHint}`);
  } else if (r.action === 'install-failed') {
    lines.push(`安装失败: ${r.error}`);
  }
  for (const w of r.warnings || []) lines.push(`注意: ${w}`);
  return lines.join('\n');
}

module.exports = {
  PKG_NAME,
  REGISTRY_LATEST,
  parseVersion,
  compareVersions,
  isNewer,
  currentVersion,
  fetchLatestVersion,
  isGlobalInstall,
  isLocalDependency,
  globalRoots,
  runUpdate,
  formatResult,
  installCommand,
};
