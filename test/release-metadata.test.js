/* ---- 发版元数据门禁：必须能拦住「漏写 CHANGELOG」等脱节 ---- */
/*
 * 背景：6.6.0/6.6.1、6.6.3/6.6.4 都发生过 release commit 只 bump 版本标记、
 * 没写 CHANGELOG 章节，却照样打 tag 发版。门禁把这件事变成硬失败。
 *
 * 全部用临时目录构造反例，绝不改仓库里的真实文件。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const { checkReleaseMetadata } = require(path.join(ROOT, 'scripts', 'check-release-metadata.js'));

let pass = 0, fail = 0;
function ok(name, cond, got) {
  if (cond) { pass++; console.log('[OK]   ' + name); }
  else { fail++; console.log('[FAIL] ' + name + ' -> ' + JSON.stringify(got)); }
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jsql-release-meta-'));
const SRC = ['package.json', 'README.md', 'index.js', 'CHANGELOG.md'];
function fixture(dir, mutate) {
  const root = path.join(TMP, dir);
  fs.mkdirSync(root, { recursive: true });
  const contents = {};
  for (const f of SRC) contents[f] = fs.readFileSync(path.join(ROOT, f), 'utf8');
  mutate(contents);
  for (const f of SRC) fs.writeFileSync(path.join(root, f), contents[f]);
  return root;
}
const has = (r, name) => r.checks.find(c => c.name === name);
// 反例必须随版本 bump 自动跟进：硬编码版本号会让 bump 后替换失配，
// 反例没构造出来却「通过」，测试自己变成假绿（6.6.5 → 6.6.6 时踩过）。
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
function replaceOrThrow(contents, file, from, to) {
  if (!contents[file].includes(from)) {
    throw new Error('反例构造失败：' + file + ' 里找不到 ' + JSON.stringify(from) + '（当前版本 ' + VERSION + '）');
  }
  contents[file] = contents[file].replace(from, to);
}

try {
  // 真实仓库当前应通过
  const real = checkReleaseMetadata(ROOT);
  ok('真实仓库通过门禁', real.ok === true, real.checks.filter(c => !c.ok));
  ok('门禁检查了 CHANGELOG 章节', !!has(real, 'CHANGELOG 含 [' + real.version + '] 章节'), real.checks.map(c => c.name));

  // 反例 1：release commit 漏写 CHANGELOG 章节（这正是历史上反复出现的）
  const missing = fixture('missing-section', (c) => {
    const v = JSON.parse(c['package.json']).version;
    const re = new RegExp('^## \\[' + v.replace(/\./g, '\\.') + '\\][^\\n]*\\n', 'm');
    if (!re.test(c['CHANGELOG.md'])) throw new Error('反例构造失败：CHANGELOG 缺章节');
    c['CHANGELOG.md'] = c['CHANGELOG.md'].replace(re, '');
  });
  const r1 = checkReleaseMetadata(missing);
  ok('漏写 CHANGELOG 章节 → FAIL', r1.ok === false, r1.checks.filter(c => !c.ok));
  ok('失败原因明确指向缺失章节',
    r1.checks.some(c => !c.ok && /缺少 ## \[/.test(c.detail)), r1.checks.filter(c => !c.ok));

  // 反例 2：README 横幅没跟着 bump
  const banner = fixture('bad-banner', (c) => replaceOrThrow(c, 'README.md', '**v' + VERSION + '**', '**v0.0.1**'));
  const r2 = checkReleaseMetadata(banner);
  ok('README 横幅不一致 → FAIL', r2.ok === false, r2.checks.filter(c => !c.ok));

  // 反例 3：index.js 头注释没跟着 bump
  const idx = fixture('bad-index', (c) => replaceOrThrow(c, 'index.js', 'JSQL-NEO v' + VERSION, 'JSQL-NEO v0.0.1'));
  const r3 = checkReleaseMetadata(idx);
  ok('index.js 头注释不一致 → FAIL', r3.ok === false, r3.checks.filter(c => !c.ok));

  // 反例 4：版本号格式非法
  const badVer = fixture('bad-version', (c) => replaceOrThrow(c, 'package.json', '"version": "' + VERSION + '"', '"version": "6.6"'));
  const r4 = checkReleaseMetadata(badVer);
  ok('非法版本号 → FAIL', r4.ok === false, r4.checks.filter(c => !c.ok));

  // 开发中往 Unreleased 累积内容不应让门禁变红（只给软提示）
  const wip = fixture('wip-unreleased', (c) => {
    c['CHANGELOG.md'] = c['CHANGELOG.md'].replace('## [Unreleased]\n', '## [Unreleased]\n\n### Added\n\n- 开发中\n');
  });
  const r5 = checkReleaseMetadata(wip);
  ok('开发中 Unreleased 有内容仍通过', r5.ok === true, r5.checks.filter(c => !c.ok));
  ok('但给出未转正内容的 WARN', r5.warnings.some(w => /未转正/.test(w)), r5.warnings);

  // 门禁本身不联网：执行期间不应有子进程网络调用
  const cp = require('child_process');
  const orig = { efs: cp.execFileSync, ef: cp.execFile, sp: cp.spawn };
  const calls = [];
  cp.execFileSync = function (...a) { calls.push(a[0]); return orig.efs.apply(this, a); };
  cp.execFile = function (...a) { calls.push(a[0]); return orig.ef.apply(this, a); };
  cp.spawn = function (...a) { calls.push(a[0]); return orig.sp.apply(this, a); };
  checkReleaseMetadata(ROOT);
  cp.execFileSync = orig.efs; cp.execFile = orig.ef; cp.spawn = orig.sp;
  ok('门禁是纯本地检查，零子进程调用', calls.length === 0, calls);
} finally {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
