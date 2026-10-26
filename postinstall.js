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

// GitHub 加速代理前缀；加速站的用法是把原始 URL 直接拼在后面：
//   https://<host>/https://github.com/owner/repo/releases/download/vX.Y.Z/asset
// 鉴权走 `Authorization: Bearer <token>` 请求头（Worker 从该头读取，不读 ?token=）。
// 前缀可用 JSQL_GHPROXY 覆盖（逗号分隔多个，按序回退；'' 表示直连兜底）；
// token 可用 JSQL_GHPROXY_TOKEN 覆盖。
// 加速站候选（按优先级）：自建站优先，公共站回退，最后直连兜底。
const DEFAULT_PROXIES = [
  'https://gh-proxyjsql-neoworkerapi.vexify.de5.net/',
  'https://gh-proxy.com/',
];
// 内置 token：让所有安装者都自动走自建加速站，无需配置环境变量。
// 加速站自身已限制只能代理 /releases/download/ 等文件下载路径，故该值公开无风险。
const DEFAULT_GHPROXY_TOKEN =
  'NkUbD165V_1iPvEeGRcAfNEv4cqv5WRLn1NfjgBzIMpo9gq5CBH10Rl5ZPmt7RGCh3kyaZU4Nc6pLhHHbvzc9w';
const GHPROXY = process.env.JSQL_GHPROXY !== undefined
  ? process.env.JSQL_GHPROXY
  : DEFAULT_PROXIES[0];
const GHPROXY_TOKEN = process.env.JSQL_GHPROXY_TOKEN || DEFAULT_GHPROXY_TOKEN;
const TAG = `v${pkg.version}`;

// 原生模块体积上限（防代理/镜像返回超大文件打爆磁盘/内存）
const MAX_DOWNLOAD_BYTES = 64 * 1024 * 1024;
const CHECKSUM_ASSET = 'SHA256SUMS';

/** 加速站鉴权头 */
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
    const req = mod.get(url, { headers: headers || {} }, (res) => {
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
  });
}

function fetchText(url, headers, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) {
      reject(new Error(`too many redirects for ${url}`));
      return;
    }
    const mod = url.startsWith('https:') ? https : http;
    const req = mod.get(url, { headers: headers || {} }, (res) => {
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
async function fetchExpectedHash(asset) {
  const explicit = process.env.JSQL_NATIVE_SHA256;
  if (explicit) {
    if (!/^[a-fA-F0-9]{64}$/.test(explicit.trim())) {
      throw new Error('JSQL_NATIVE_SHA256 must be a 64-character hex SHA-256 digest');
    }
    return explicit.trim().toLowerCase();
  }
  const raw = `https://github.com/${REPO}/releases/download/${TAG}/${CHECKSUM_ASSET}`;
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

async function downloadAndVerify() {
  if (!supportsNativeNapi()) {
    console.warn(
      `[jsql-neo] Node ${process.versions.node} provides N-API ${nativeNapiVersion() || 'unknown'}, ` +
      `but the native module requires N-API >= ${MIN_NAPI_VERSION}; skipping native download.`
    );
    return false;
  }
  const libc = detectLibc();
  const asset = process.env.JSQL_NATIVE_ASSET || `jsql-neo-native.${nativeTargetSuffix(process.platform, process.arch, libc)}.node`;
  const raw = `https://github.com/${REPO}/releases/download/${TAG}/${asset}`;

  let expected = null;
  try {
    expected = await fetchExpectedHash(asset);
  } catch (e) {
    console.warn('[jsql-neo] failed to resolve native checksum:', e.message);
  }

  const allowUnverified = process.env.JSQL_ALLOW_UNVERIFIED_NATIVE === '1';
  if (!expected && !allowUnverified) {
    if (libc === 'musl') {
      console.warn(
        `[jsql-neo] musl libc detected but this release has no native asset for ${asset}; ` +
        'falling back to the WASM/JS engine. Set JSQL_NATIVE_ASSET to a compatible musl build if available.'
      );
    } else {
      // fail closed：拿不到 SHA256SUMS 就不下载，绝不 require 未经校验的二进制
      console.warn(
        '[jsql-neo] no SHA256SUMS available for this release; refusing to download an unverified native module.\n' +
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
    console.log(`[jsql-neo] downloading native module: ${cand.url}`);
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
      fs.mkdirSync(path.dirname(NATIVE_PATH), { recursive: true });
      fs.renameSync(tmp, NATIVE_PATH);
      fs.chmodSync(NATIVE_PATH, 0o755);
      if (tryLoadNative()) {
        console.log('[jsql-neo] native module downloaded: native/jsql-neo-native.node');
        return true;
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

async function ensureNativeNode() {
  // 已存在且能加载 → 直接用；否则删掉并从 gh-proxy.com 下载，找不到才回退源码编译
  if (tryLoadNative()) {
    console.log('[jsql-neo] native module ready: native/jsql-neo-native.node');
    return;
  }
  if (!supportsNativeNapi()) {
    console.warn(
      `[jsql-neo] Node ${process.versions.node} provides N-API ${nativeNapiVersion() || 'unknown'}, ` +
      `but the native module requires N-API >= ${MIN_NAPI_VERSION}; using the WASM/JS engine.`
    );
    return;
  }
  if (await downloadAndVerify()) return;
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

main();