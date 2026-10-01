#!/usr/bin/env node
/**
 * 计算整个项目文件夹的确定性 sha256 校验和。
 *
 * 之所以需要「确定性」：文件遍历顺序、换行符、绝对路径在不同机器上都不一样，
 * 直接 tar 再 sha256 会得到各不相同的摘要。这里的规则是：
 *   1. 只统计常规文件（跳过目录 / 符号链接 / socket 等）
 *   2. 相对路径统一用 POSIX 分隔符（/），并按字节序排序
 *   3. 每个文件贡献一行：`<内容 sha256>  路径\n`
 *   4. 最终摘要 = sha256(整个清单文本)
 *
 * 排除项（否则摘要会随环境漂移）：
 *   - node_modules / .git / .workbuddy / target / coverage 等依赖与构建产物
 *   - native/*.node、bin/*.exe：平台相关二进制，由 postinstall 重新拉取
 *   - *.log、tmp-*、*.tmp 等临时文件
 *
 * 用法：
 *   node scripts/folder-checksum.js                 # 打印摘要
 *   node scripts/folder-checksum.js --out m.txt     # 顺便把清单写到文件
 *   node scripts/folder-checksum.js --verify <hex>  # 校验摘要是否匹配
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');

// 目录名（任意层级命中即跳过）
const EXCLUDE_DIRS = new Set([
  'node_modules', '.git', '.workbuddy', 'target', 'coverage',
  'tmp', 'Temp', 'dist', 'build', '.trae-html-share-packages',
  '.cache', 'logs',
]);

// 后缀排除
const EXCLUDE_EXTS = new Set([
  '.node', '.exe', '.dll', '.so', '.dylib', '.log',
  '.sqlite', '.sqlite-journal', '.bin', '.orig', '.rej',
]);

// 文件名前缀排除
const EXCLUDE_PREFIXES = ['tmp-', '.tmp-'];

function isExcluded(name, isDir) {
  if (isDir && EXCLUDE_DIRS.has(name)) return true;
  if (!isDir) {
    if (EXCLUDE_EXTS.has(path.extname(name).toLowerCase())) return true;
    for (const p of EXCLUDE_PREFIXES) if (name.startsWith(p)) return true;
  }
  return false;
}

function walk(dir, relBase, out) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
  for (const ent of entries) {
    if (isExcluded(ent.name, ent.isDirectory())) continue;
    const abs = path.join(dir, ent.name);
    const rel = relBase ? relBase + '/' + ent.name : ent.name;
    if (ent.isDirectory()) walk(abs, rel, out);
    else if (ent.isFile()) out.push(rel);
  }
}

function computeChecksum(root) {
  const files = [];
  walk(root, '', files);
  files.sort();                                   // 字节序排序，保证顺序无关
  const lines = [];
  for (const rel of files) {
    const abs = path.join(root, rel);
    let buf;
    try { buf = fs.readFileSync(abs); } catch (e) { continue; }
    lines.push(crypto.createHash('sha256').update(buf).digest('hex') + '  ' + rel);
  }
  const manifest = lines.join('\n') + '\n';
  const digest = crypto.createHash('sha256').update(manifest, 'utf8').digest('hex');
  return { digest, manifest, count: files.length };
}

function main() {
  const args = process.argv.slice(2);
  const outIdx = args.indexOf('--out');
  const verifyIdx = args.indexOf('--verify');
  const rootIdx = args.indexOf('--root');

  const root = rootIdx !== -1 && args[rootIdx + 1]
    ? path.resolve(args[rootIdx + 1])
    : ROOT;

  const { digest, manifest, count } = computeChecksum(root);

  if (outIdx !== -1 && args[outIdx + 1]) {
    fs.writeFileSync(path.resolve(args[outIdx + 1]), manifest);
  }

  if (verifyIdx !== -1 && args[verifyIdx + 1]) {
    const expected = String(args[verifyIdx + 1]).trim().toLowerCase();
    const ok = expected === digest;
    process.stdout.write((ok ? 'OK   ' : 'FAIL ') + digest + '\n');
    process.exit(ok ? 0 : 1);
  }

  process.stdout.write('root:  ' + root + '\n');
  process.stdout.write('files: ' + count + '\n');
  process.stdout.write('sha256: ' + digest + '\n');
}

module.exports = { computeChecksum };

if (require.main === module) main();
