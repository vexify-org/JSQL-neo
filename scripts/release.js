#!/usr/bin/env node
'use strict';
/**
 * 发版准备：bump 版本标记 + 把 [Unreleased] 转正成本版本章节 + 自检。
 *
 *   node scripts/release.js 6.7.0-beta.1          # 预发布
 *   node scripts/release.js 6.7.0                 # 正式版
 *   node scripts/release.js 6.7.0-beta.2 --date 2026-11-16
 *
 * 只改文件，**不会** commit / tag / push —— 那些是外部动作，由人确认后执行。
 *
 * 为什么要有它：6.6.0/6.6.1、6.6.3/6.6.4 都发生过「bump 了版本却漏写
 * CHANGELOG 章节」，每次靠下一版人工补。现在把四处改动绑成一次原子操作，
 * 漏一处就整体失败（先校验、后写入）。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const VER_RE = /^\d+\.\d+\.\d+(?:-(?:alpha|beta|rc)\.\d+)?$/;

function read(f) { return fs.readFileSync(path.join(ROOT, f), 'utf8'); }
function write(f, s) { fs.writeFileSync(path.join(ROOT, f), s); }

function fail(msg) {
  console.error('  ✗ ' + msg);
  process.exit(1);
}

function main() {
  const args = process.argv.slice(2);
  const version = args.find(a => !a.startsWith('--'));
  const dateIdx = args.indexOf('--date');
  const date = dateIdx >= 0 ? args[dateIdx + 1] : new Date().toISOString().slice(0, 10);

  if (!version) fail('用法: node scripts/release.js <version> [--date YYYY-MM-DD]');
  if (!VER_RE.test(version)) fail('版本号格式非法: ' + version + '（示例 6.7.0 / 6.7.0-beta.1）');

  const pkg = JSON.parse(read('package.json'));
  const current = pkg.version;
  if (version === current) fail('新版本与当前版本相同: ' + current);

  // ---------- 先全部校验，任何一项不满足都不写文件 ----------
  const index = read('index.js');
  const readme = read('README.md');
  const changelog = read('CHANGELOG.md');
  const eol = changelog.includes('\r\n') ? '\r\n' : '\n';

  if (!index.includes('JSQL-NEO v' + current)) fail('index.js 里找不到当前版本 JSQL-NEO v' + current);
  if (!readme.includes('**v' + current + '**')) fail('README 里找不到当前版本横幅 **v' + current + '**');
  if (changelog.includes('## [' + version + ']')) fail('CHANGELOG 已有 [' + version + '] 章节');

  const lines = changelog.split(eol);
  const ui = lines.findIndex(l => /^## \[Unreleased\]/.test(l));
  if (ui < 0) fail('CHANGELOG 缺少 [Unreleased] 段');
  let next = lines.length;
  for (let i = ui + 1; i < lines.length; i++) {
    if (/^## \[/.test(lines[i])) { next = i; break; }
  }
  const body = lines.slice(ui + 1, next);
  const trimmed = body.slice();
  while (trimmed.length && !trimmed[0].trim()) trimmed.shift();
  while (trimmed.length && !trimmed[trimmed.length - 1].trim()) trimmed.pop();
  if (!trimmed.length) fail('[Unreleased] 是空的 —— 没有可发布的内容，先写 CHANGELOG');

  // ---------- 写入 ----------
  write('package.json', read('package.json').replace(/^(\s*)"version": "[^"]+"/m, '$1"version": "' + version + '"'));
  write('index.js', index.split('JSQL-NEO v' + current).join('JSQL-NEO v' + version));

  // 横幅的 release 字样跟着版本走：预发布不能写 stable（那是虚标）。
  const pre = /-(alpha|beta|rc)\./.exec(version);
  const releaseWord = pre ? pre[1] + ' release' : 'stable release';
  let newReadme = readme.split('**v' + current + '**').join('**v' + version + '**');
  newReadme = newReadme.replace(
    /^(> \*\*v[^*]+\*\* — )(stable|alpha|beta|rc) release/m,
    '$1' + releaseWord
  );
  write('README.md', newReadme);

  const replacement = ['## [Unreleased]', '', '## [' + version + '] — ' + date, '', ...trimmed, ''];
  lines.splice(ui, next - ui, ...replacement);
  write('CHANGELOG.md', lines.join(eol));

  console.log('  ✓ package.json / index.js / README  → ' + version);
  console.log('  ✓ CHANGELOG：' + trimmed.length + ' 行内容转正为 [' + version + ']');
  console.log('  ✓ [Unreleased] 已重置为空');
  console.log('');
  console.log('  下一步（确认无误后执行）：');
  console.log('    git add -A && git commit -m "chore(release): v' + version + '"');
  console.log('    git tag -a v' + version + ' -m "v' + version + '"');
  console.log('    git push origin HEAD:main && git push origin v' + version);
}

main();
