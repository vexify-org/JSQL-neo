'use strict';

const fs = require('fs');
const { execFileSync } = require('child_process');

const MIN_NAPI_VERSION = 6;

function detectLibc(platform = process.platform) {
  if (platform !== 'linux') return null;
  try {
    const report = process.report && typeof process.report.getReport === 'function'
      ? process.report.getReport()
      : null;
    if (report && report.header && report.header.glibcVersionRuntime) return 'gnu';
  } catch (_) { /* ignore */ }
  try {
    if (fs.existsSync('/etc/alpine-release')) return 'musl';
  } catch (_) { /* ignore */ }
  try {
    const out = execFileSync('ldd', ['--version'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (/musl/i.test(out)) return 'musl';
    if (/glibc|GNU libc/i.test(out)) return 'gnu';
  } catch (_) { /* ignore */ }
  return 'gnu';
}

function nativeTargetSuffix(platform = process.platform, arch = process.arch, libc = detectLibc(platform)) {
  const p = platform === 'win32' ? 'win32' : platform === 'darwin' ? 'darwin' : 'linux';
  const a = arch === 'x64' ? 'x64' : arch === 'arm64' ? 'arm64' : arch;
  if (p === 'linux') return `${p}-${a}-${libc === 'musl' ? 'musl' : 'gnu'}`;
  if (p === 'darwin') return `${p}-${a}`;
  return `${p}-${a}-msvc`;
}

function nativeNapiVersion() {
  const v = Number(process.versions && process.versions.napi);
  return Number.isFinite(v) ? v : 0;
}

function supportsNativeNapi() {
  return nativeNapiVersion() >= MIN_NAPI_VERSION;
}

module.exports = {
  MIN_NAPI_VERSION,
  detectLibc,
  nativeTargetSuffix,
  nativeNapiVersion,
  supportsNativeNapi,
};
