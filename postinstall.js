const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');

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

// 与 .github/workflows/build-native.yml 中发布的资产命名保持一致
function nativeTargetSuffix(platform = process.platform, arch = process.arch) {
  const p = platform === 'win32' ? 'win32' : platform === 'darwin' ? 'darwin' : 'linux';
  const a = arch === 'x64' ? 'x64' : arch === 'arm64' ? 'arm64' : arch;
  if (p === 'linux') return `${p}-${a}-gnu`;
  if (p === 'darwin') return `${p}-${a}`;
  return `${p}-${a}-msvc`;
}

function download(url, dest, headers) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https:') ? https : http;
    const req = mod.get(url, { headers: headers || {} }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        download(res.headers.location, dest, headers).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        return;
      }
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      const ws = fs.createWriteStream(dest);
      ws.on('error', reject);
      res.pipe(ws);
      res.on('end', () => ws.end(() => resolve()));
    });
    req.on('error', reject);
  });
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
  const asset = `jsql-neo-native.${nativeTargetSuffix()}.node`;
  const raw = `https://github.com/${REPO}/releases/download/${TAG}/${asset}`;
  // 依次尝试：环境变量指定的代理 → 内置加速站 → 直连
  for (const cand of proxyCandidates(raw)) {
    console.log(`[jsql-neo] downloading native module: ${cand.url}`);
    try {
      // 加速站鉴权走 Authorization 头，直连时不带
      await download(cand.url, NATIVE_PATH, cand.viaProxy ? proxyHeaders() : undefined);
      if (tryLoadNative()) {
        console.log('[jsql-neo] native module downloaded: native/jsql-neo-native.node');
        return true;
      }
      console.warn('[jsql-neo] downloaded module cannot be loaded; trying next source.');
    } catch (e) {
      console.warn('[jsql-neo] download failed:', e.message);
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