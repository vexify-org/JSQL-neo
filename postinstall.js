const { execSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { detectLibc, nativeTargetSuffix, nativeNapiVersion, supportsNativeNapi, MIN_NAPI_VERSION } = require('./lib/native_target');

const ROOT = __dirname;
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

// Server CLI binary (bin/jsql-neo-server)
const BIN_NAME = process.platform === 'win32' ? 'jsql-neo-server.exe' : 'jsql-neo-server';
const BP = path.join(ROOT, 'bin', BIN_NAME);

// Native N-API module (native/jsql-neo-native.node)
const NATIVE_PATH = path.join(ROOT, 'native', 'jsql-neo-native.node');

// GitHub 加速代理前缀（可选）。加速站的用法是把原始 URL 直接拼在后面：
//   https://<host>/https://github.com/owner/repo/releases/download/vX.Y.Z/asset
// 鉴权走 `Authorization: Bearer <token>` 请求头（Worker 从该头读取，不读 ?token=）。
// 前缀必须显式设置 JSQL_GHPROXY（逗号分隔多个，按序回退；'' 表示直连）；
// token 只能从环境变量 JSQL_GHPROXY_TOKEN 读取，代码内不再内置任何 token。
//
// 供应链安全（issue #25）：默认不配置任何第三方加速站，直连官方 github.com；
// 只有用户显式设置 JSQL_GHPROXY 时才走代理。已移除内置 de5.net 加速站与硬编码
// token，避免安装路径信任第三方端点 / token 泄露带来的投毒风险。
const DEFAULT_PROXIES = [];
const GHPROXY = process.env.JSQL_GHPROXY !== undefined
  ? process.env.JSQL_GHPROXY
  : '';
const GHPROXY_TOKEN = process.env.JSQL_GHPROXY_TOKEN || '';

// ── 原生二进制获取策略 ────────────────────────────────────────────────
// v6.5.25 起默认【强制从远端拉取最新版】：安装时总是从 GitHub Release 重新
// 下载与当前包版本匹配的原生模块，校验 SHA256 后覆盖本地同名文件（旧缓存、
// 手工编译产物都不会被直接信任）。下载失败时保留本地可用模块，最后才回退
// 源码编译 —— 即「远端优先 / 强制覆盖 / 失败降级」。
//
// 环境变量：
//   JSQL_NO_NATIVE_DOWNLOAD=1        完全关闭下载（旧 opt-in 行为，local → 源码编译）
//   JSQL_NATIVE_DOWNLOAD=0           同上（=0 语义）
//   JSQL_AUTO_DOWNLOAD_NATIVE=0      同上（=0 语义）
//   JSQL_NATIVE_FORCE_REFRESH=0      仍下载，但本地模块可用时跳过（旧「缓存优先」）
//   JSQL_NATIVE_TAG=vX.Y.Z|latest    指定远端 tag；默认 v<package.version>
//   JSQL_AUTO_DOWNLOAD_NATIVE=1 / JSQL_NATIVE_DOWNLOAD=1  仍然兼容（显式开）
//
// 供应链安全（issue #25）：不内置任何加速站/token，代理仍需显式 JSQL_GHPROXY，
// 且下载必须通过 SHA256SUMS 校验（除非用户显式 JSQL_ALLOW_UNVERIFIED_NATIVE=1）。
const DOWNLOAD_DISABLED = process.env.JSQL_NO_NATIVE_DOWNLOAD === '1'
  || process.env.JSQL_NATIVE_DOWNLOAD === '0'
  || process.env.JSQL_AUTO_DOWNLOAD_NATIVE === '0';
const FORCE_REFRESH = process.env.JSQL_NATIVE_FORCE_REFRESH !== '0';
const TAG = process.env.JSQL_NATIVE_TAG || `v${pkg.version}`;

// 原生模块体积上限（防代理/镜像返回超大文件打爆磁盘/内存）
const MAX_DOWNLOAD_BYTES = 64 * 1024 * 1024;
const CHECKSUM_ASSET = 'SHA256SUMS';

/** 加速站鉴权头：仅在显式配置了 token 且走代理时才携带（不发送任何内置 token） */
function proxyHeaders() {
  return GHPROXY_TOKEN ? { Authorization: 'Bearer ' + GHPROXY_TOKEN } : undefined;
}

/**
 * 生成候选下载地址列表（按优先级）：
 *   JSQL_GHPROXY 指定的代理 → 内置加速站 → 直连
 */
function proxyCandidates(raw) {
  const bases = String(GHPROXY || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .concat(DEFAULT_PROXIES)
    .concat('');
  const list = [];
  for (const base of bases) {
    const url = base ? (base.endsWith('/') ? base : base + '/') + raw : raw;
    if (list.some((x) => x.url === url)) continue;
    list.push({ url, viaProxy: !!base });
  }
  return list;
}

// 从 repository 字段提取 owner/repo，例如 vexify-org/JSQL-neo
const REPO = (pkg.repository && pkg.repository.url)
  ? pkg.repository.url.replace(/\.git$/, '').replace(/^.*github\.com\//i, '')
  : 'vexify-org/JSQL-neo';

function sameOrigin(a, b) {
  try { return new URL(a).origin === new URL(b).origin; } catch (_) { return false; }
}

/**
 * 解析 JSQL_NATIVE_TAG=latest：跟随 GitHub `/releases/latest` 的 302 跳转，
 * 从 Location 里取出真实 tag（vX.Y.Z）。失败返回 null —— 调用方回退到当前版本 tag。
 */
function resolveLatestTag() {
  return new Promise((resolve) => {
    const url = `https://github.com/${REPO}/releases/latest`;
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    let req;
    try {
      req = https.get(url, { headers: { 'User-Agent': 'jsql-neo-postinstall' } }, (res) => {
        const loc = res.headers.location || '';
        res.resume();
        const m = String(loc).match(/\/releases\/tag\/([^/?#]+)/);
        done(m ? decodeURIComponent(m[1]) : null);
      });
    } catch (_) {
      done(null);
      return;
    }
    req.on('error', () => done(null));
    req.setTimeout(8000, () => { try { req.destroy(); } catch (_) {} done(null); });
  });
}

/**
 * 取得本次要拉取的 release tag。
 * 默认 = v<package.version>（二进制必须与包版本匹配，避免 ABI/API 错配）；
 * 只有用户显式 JSQL_NATIVE_TAG=latest 时才去解析最新 release。
 */
async function releaseTag() {
  if (TAG.toLowerCase() !== 'latest') return TAG;
  const resolved = await resolveLatestTag();
  if (resolved) {
    console.log(`[jsql-neo] JSQL_NATIVE_TAG=latest resolved to ${resolved}`);
    return resolved;
  }
  console.warn(`[jsql-neo] cannot resolve latest release tag; using v${pkg.version}`);
  return `v${pkg.version}`;
}

function withUserAgent(headers) {
  return Object.assign({ 'User-Agent': 'jsql-neo-postinstall' }, headers || {});
}

function safeRedirect(next) {
  return /^https?:/i.test(String(next || ''));
}

function download(url, dest, headers, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) {
      reject(new Error(`too many redirects for ${url}`));
      return;
    }
    const mod = url.startsWith('https:') ? https : http;
    const req = mod.get(url, { headers: withUserAgent(headers) }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        const next = new URL(res.headers.location, url).toString();
        if (!safeRedirect(next)) {
          reject(new Error(`invalid redirect target for ${url}`));
          return;
        }
        download(next, dest, sameOrigin(next, url) ? headers : undefined, redirects + 1).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        return;
      }
      const declared = Number(res.headers['content-length']);
      if (Number.isFinite(declared) && declared > MAX_DOWNLOAD_BYTES) {
        res.resume();
        reject(new Error(`download too large: ${declared} bytes (limit ${MAX_DOWNLOAD_BYTES})`));
        return;
      }
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      const ws = fs.createWriteStream(dest);
      let received = 0;
      let settled = false;
      const fail = (err) => {
        if (settled) return;
        settled = true;
        try { ws.destroy(); } catch (_) { /* ignore */ }
        try { fs.unlinkSync(dest); } catch (_) { /* ignore */ }
        reject(err);
      };
      ws.on('error', fail);
      res.on('error', fail);
      res.on('data', (chunk) => {
        received += chunk.length;
        if (received > MAX_DOWNLOAD_BYTES) {
          fail(new Error(`download exceeded ${MAX_DOWNLOAD_BYTES} bytes`));
          res.destroy();
        }
      });
      res.pipe(ws);
      ws.on('finish', () => {
        if (settled) return;
        settled = true;
        resolve();
      });
    });
    req.on('error', reject);
    req.setTimeout(60000, () => {
      try { req.destroy(); } catch (_) { /* ignore */ }
      reject(new Error(`download timed out after 60s: ${url}`));
    });
  });
}

function fetchText(url, headers, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) {
      reject(new Error(`too many redirects for ${url}`));
      return;
    }
    const mod = url.startsWith('https:') ? https : http;
    const req = mod.get(url, { headers: withUserAgent(headers) }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        const next = new URL(res.headers.location, url).toString();
        if (!safeRedirect(next)) {
          reject(new Error(`invalid redirect target for ${url}`));
          return;
        }
        fetchText(next, sameOrigin(next, url) ? headers : undefined, redirects + 1).then(resolve, reject);
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
        if (received > 1024 * 1024) {
          res.destroy();
          reject(new Error('checksum manifest too large'));
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(20000, () => {
      try { req.destroy(); } catch (_) { /* ignore */ }
      reject(new Error(`request timed out after 20s: ${url}`));
    });
  });
}

function sha256File(file) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.allocUnsafe(1024 * 1024);
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, null);
      if (n <= 0) break;
      hash.update(buf.subarray(0, n));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

/** 从 SHA256SUMS 清单中取出指定资产的小写 sha256；找不到返回 null */
function expectedHashFromManifest(text, asset) {
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = line.trim().match(/^([a-fA-F0-9]{64})\s+\*?(.+)$/);
    if (!m) continue;
    if (path.basename(m[2].trim()) === asset) return m[1].toLowerCase();
  }
  return null;
}

/**
 * 获取原生模块的期望哈希：
 *   1) JSQL_NATIVE_SHA256 显式指定（最高优先级）
 *   2) 从 GitHub Release 的 SHA256SUMS 资产下载并解析
 * 拿不到就返回 null —— 调用方会拒绝加载未校验的二进制（fail closed）。
 */
async function fetchExpectedHash(asset, tag) {
  const explicit = process.env.JSQL_NATIVE_SHA256;
  if (explicit) {
    if (!/^[a-fA-F0-9]{64}$/.test(explicit.trim())) {
      throw new Error('JSQL_NATIVE_SHA256 must be a 64-character hex SHA-256 digest');
    }
    return explicit.trim().toLowerCase();
  }
  const raw = `https://github.com/${REPO}/releases/download/${tag}/${CHECKSUM_ASSET}`;
  for (const cand of proxyCandidates(raw)) {
    try {
      const text = await fetchText(cand.url, cand.viaProxy ? proxyHeaders() : undefined);
      const hash = expectedHashFromManifest(text, asset);
      if (hash) return hash;
    } catch (e) {
      // 清单不存在/代理失败时继续尝试下一个来源
    }
  }
  return null;
}

function buildNativeFromSource() {
  const crate = path.join(ROOT, 'nativesrc', 'jsql-neo-native');
  if (!fs.existsSync(path.join(crate, 'Cargo.toml'))) return;
  console.log('[jsql-neo] building native module from source...');
  try {
    execSync('cargo build --release', { cwd: crate, stdio: 'inherit' });
    const rel = path.join(crate, 'target', 'release');
    const src = process.platform === 'win32'
      ? path.join(rel, 'jsql_neo_native.dll')
      : process.platform === 'darwin'
        ? path.join(rel, 'libjsql_neo_native.dylib')
        : path.join(rel, 'libjsql_neo_native.so');
    if (fs.existsSync(src)) {
      fs.mkdirSync(path.dirname(NATIVE_PATH), { recursive: true });
      fs.copyFileSync(src, NATIVE_PATH);
      fs.chmodSync(NATIVE_PATH, 0o755);
      console.log(`[jsql-neo] native module built: native/jsql-neo-native.node`);
    }
  } catch (e) {
    console.warn('[jsql-neo] native build failed:', e.message);
  }
}

// 尝试加载 native 模块；能成功 require 才算「可用」，否则视为不可用
function tryLoadNative() {
  if (!fs.existsSync(NATIVE_PATH)) return false;
  try {
    require(NATIVE_PATH);
    fs.chmodSync(NATIVE_PATH, 0o755);
    return true;
  } catch (e) {
    console.warn(`[jsql-neo] existing native module cannot be loaded (${e.code || e.message}), will re-acquire.`);
    try { fs.unlinkSync(NATIVE_PATH); } catch (_) { /* ignore */ }
    return false;
  }
}

/**
 * 把已经校验过的临时文件安装到 NATIVE_PATH：
 * 先备份现有模块（若存在），再原子替换。返回备份路径供失败回滚。
 */
function installDownloadedModule(tmp) {
  fs.mkdirSync(path.dirname(NATIVE_PATH), { recursive: true });
  const backup = `${NATIVE_PATH}.previous`;
  let hadBackup = false;
  if (fs.existsSync(NATIVE_PATH)) {
    try {
      fs.copyFileSync(NATIVE_PATH, backup);
      hadBackup = true;
    } catch (_) { /* 备份失败不阻塞覆盖，但会失去回滚能力 */ }
  }
  try {
    fs.renameSync(tmp, NATIVE_PATH);
  } catch (e) {
    // Windows 上 rename 覆盖已存在文件会 EEXIST/EPERM
    if (e.code === 'EEXIST' || e.code === 'EPERM' || e.code === 'EACCES') {
      try { fs.unlinkSync(NATIVE_PATH); } catch (_) { /* ignore */ }
      fs.renameSync(tmp, NATIVE_PATH);
    } else {
      throw e;
    }
  }
  fs.chmodSync(NATIVE_PATH, 0o755);
  return { backup: hadBackup ? backup : null };
}

/**
 * 强制从远端拉取原生模块（默认路径）。
 * 关键点：不因本地已有同名文件而跳过 —— 每次都重新下载、校验、覆盖安装。
 *
 * @param {{ tag?: string }} [opts]
 * @returns {Promise<boolean>} 是否成功安装并加载
 */
async function downloadAndVerify(opts = {}) {
  if (!supportsNativeNapi()) {
    console.warn(
      `[jsql-neo] Node ${process.versions.node} provides N-API ${nativeNapiVersion() || 'unknown'}, ` +
      `but the native module requires N-API >= ${MIN_NAPI_VERSION}; skipping native download.`
    );
    return false;
  }
  const tag = opts.tag || await releaseTag();
  const libc = detectLibc();
  const asset = process.env.JSQL_NATIVE_ASSET || `jsql-neo-native.${nativeTargetSuffix(process.platform, process.arch, libc)}.node`;
  const raw = `https://github.com/${REPO}/releases/download/${tag}/${asset}`;

  let expected = null;
  try {
    expected = await fetchExpectedHash(asset, tag);
  } catch (e) {
    console.warn('[jsql-neo] failed to resolve native checksum:', e.message);
  }

  const allowUnverified = process.env.JSQL_ALLOW_UNVERIFIED_NATIVE === '1';
  if (!expected && !allowUnverified) {
    if (libc === 'musl') {
      console.warn(
        `[jsql-neo] musl libc detected but release ${tag} has no native asset for ${asset}; ` +
        'falling back to the WASM/JS engine. Set JSQL_NATIVE_ASSET to a compatible musl build if available.'
      );
    } else {
      // fail closed：拿不到 SHA256SUMS 就不下载，绝不 require 未经校验的二进制
      console.warn(
        `[jsql-neo] no SHA256SUMS available for release ${tag}; refusing to download an unverified native module.\n` +
        '[jsql-neo] set JSQL_NATIVE_SHA256=<64-hex> to pin a checksum, or JSQL_ALLOW_UNVERIFIED_NATIVE=1 to override (unsafe).'
      );
    }
    return false;
  }
  if (!expected) {
    console.warn('[jsql-neo] WARNING: JSQL_ALLOW_UNVERIFIED_NATIVE=1 — native module integrity is NOT verified.');
  }

  // 依次尝试：环境变量指定的代理 → 内置加速站 → 直连
  for (const cand of proxyCandidates(raw)) {
    console.log(`[jsql-neo] fetching native module (${tag}): ${cand.url}`);
    const tmp = `${NATIVE_PATH}.${process.pid}.download`;
    try {
      // 加速站鉴权走 Authorization 头，直连时不带
      await download(cand.url, tmp, cand.viaProxy ? proxyHeaders() : undefined);
      if (expected) {
        const actual = sha256File(tmp);
        if (actual !== expected) {
          console.warn(`[jsql-neo] checksum mismatch (expected ${expected}, got ${actual}); trying next source.`);
          continue;
        }
        console.log('[jsql-neo] checksum verified:', actual);
      }

      // 强制覆盖：即便本地已有同名文件也替换（旧模块先备份，加载失败可回滚）
      const installed = installDownloadedModule(tmp);
      if (tryLoadNative()) {
        if (installed.backup) {
          try { fs.unlinkSync(installed.backup); } catch (_) { /* ignore */ }
        }
        console.log(`[jsql-neo] native module updated: native/jsql-neo-native.node (${tag})`);
        return true;
      }
      // 新模块无法加载 → 回滚到之前的可用模块
      if (installed.backup) {
        try {
          fs.renameSync(installed.backup, NATIVE_PATH);
          console.warn('[jsql-neo] rolled back to the previous native module.');
        } catch (_) { /* ignore */ }
      }
      console.warn('[jsql-neo] downloaded module cannot be loaded; trying next source.');
    } catch (e) {
      console.warn('[jsql-neo] download failed:', e.message);
    } finally {
      try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (_) { /* ignore */ }
    }
  }
  return false;
}

/**
 * 确保原生模块可用。
 *
 * 默认行为（v6.5.25+）：总是从远端 release 强制拉取并覆盖本地模块；
 * 失败时按「本地已有模块 → 源码编译 → WASM/JS」逐级降级，绝不让安装失败。
 */
async function ensureNativeNode() {
  if (!supportsNativeNapi()) {
    console.warn(
      `[jsql-neo] Node ${process.versions.node} provides N-API ${nativeNapiVersion() || 'unknown'}, ` +
      `but the native module requires N-API >= ${MIN_NAPI_VERSION}; using the WASM/JS engine.`
    );
    return;
  }

  if (DOWNLOAD_DISABLED) {
    console.warn('[jsql-neo] native download disabled by env (JSQL_NO_NATIVE_DOWNLOAD=1 / JSQL_NATIVE_DOWNLOAD=0); using local module or source build.');
    if (tryLoadNative()) {
      console.log('[jsql-neo] native module ready: native/jsql-neo-native.node');
      return;
    }
    buildNativeFromSource();
    return;
  }

  const localReady = tryLoadNative();
  if (localReady && !FORCE_REFRESH) {
    console.log('[jsql-neo] native module ready (JSQL_NATIVE_FORCE_REFRESH=0, remote refresh skipped): native/jsql-neo-native.node');
    return;
  }

  console.log(localReady
    ? '[jsql-neo] local native module found; forcing refresh from remote release (set JSQL_NATIVE_FORCE_REFRESH=0 to keep the local copy)'
    : '[jsql-neo] fetching native module from remote release...');

  if (await downloadAndVerify()) return;

  // 拉取失败：本地可用就继续用本地 —— 网络问题不该把已经能跑的安装搞坏
  if (tryLoadNative()) {
    console.warn('[jsql-neo] remote refresh failed; keeping the existing local native module.');
    return;
  }
  console.warn('[jsql-neo] could not fetch a verified native module; falling back to source build / WASM.');
  buildNativeFromSource();
}

function ensureServerBinary() {
  if (fs.existsSync(BP)) {
    fs.chmodSync(BP, 0o755);
    console.log(`[jsql-neo] binary ready: ${BP}`);
    return;
  }

  // Build from source
  const serverDir = path.join(ROOT, '..', 'jsql-neo-server');
  if (fs.existsSync(path.join(serverDir, 'Cargo.toml'))) {
    console.log('[jsql-neo] building Rust server from source...');
    try {
      execSync('cargo build --release', { cwd: serverDir, stdio: 'inherit' });
      const src = path.join(serverDir, 'target', 'release', BIN_NAME);
      if (fs.existsSync(src)) {
        fs.mkdirSync(path.join(ROOT, 'bin'), { recursive: true });
        fs.copyFileSync(src, BP);
        fs.chmodSync(BP, 0o755);
        console.log(`[jsql-neo] binary built: ${BP}`);
        return;
      }
    } catch (e) {
      console.warn('[jsql-neo] cargo build failed:', e.message);
    }
  }

  console.warn(`[jsql-neo] server binary not found at ${BP}`);
  console.warn('[jsql-neo] install Rust from https://rustup.rs and run: npm run build');
}

async function main() {
  await ensureNativeNode();
  ensureServerBinary();
}

// 仅当直接执行时才运行（build:native / 测试可 require 本文件复用构建逻辑）
if (require.main === module) {
  main();
}

module.exports = {
  buildNativeFromSource,
  downloadAndVerify,
  ensureNativeNode,
  releaseTag,
  resolveLatestTag,
  installDownloadedModule,
};