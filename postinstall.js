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

// GitHub 加速代理前缀；把原始 github 链接直接拼在后面即可
const GHPROXY = 'https://gh-proxy.com/';
const TAG = `v${pkg.version}`;

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

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https:') ? https : http;
    const req = mod.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        download(res.headers.location, dest).then(resolve, reject);
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

async function ensureNativeNode() {
  if (fs.existsSync(NATIVE_PATH)) {
    fs.chmodSync(NATIVE_PATH, 0o755);
    console.log('[jsql-neo] native module ready: native/jsql-neo-native.node');
    return;
  }

  // 优先从 GitHub Release 通过 gh-proxy.com 加速下载预编译的 .node 二进制
  const asset = `jsql-neo-native.${nativeTargetSuffix()}.node`;
  const url = `${GHPROXY}https://github.com/${REPO}/releases/download/${TAG}/${asset}`;
  console.log(`[jsql-neo] downloading native module: ${url}`);
  try {
    await download(url, NATIVE_PATH);
    fs.chmodSync(NATIVE_PATH, 0o755);
    console.log('[jsql-neo] native module downloaded: native/jsql-neo-native.node');
    return;
  } catch (e) {
    console.warn('[jsql-neo] download failed, falling back to source build:', e.message);
  }

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