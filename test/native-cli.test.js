/* ---- CLI: jsql native status|refresh ---- */
/*
 * 把 postinstall 的 native 版本自检暴露到命令行后，必须验证：
 *   - 匹配 / 错配 / 未记录 三态的退出码（0/1，可直接当 CI 门禁）
 *   - 未知 action 要报错而不是静默成功
 *
 * 全程用临时目录 + JSQL_NATIVE_PATH，并且显式关掉 star 提示、
 * 把 ~/.jsqlmr 覆盖到临时路径 —— 绝不污染用户级配置。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'jsql-native-cli-'));
const NATIVE = path.join(TMP, 'native', 'jsql-neo-native.node');
const META = path.join(TMP, 'native', '.installed.json');
fs.mkdirSync(path.dirname(NATIVE), { recursive: true });
fs.writeFileSync(NATIVE, 'FAKE-NATIVE-FOR-CLI-TEST');

const version = require(path.join(ROOT, 'package.json')).version;

let pass = 0, fail = 0;
function ok(name, cond, got) {
  if (cond) { pass++; console.log('[OK]   ' + name); }
  else { fail++; console.log('[FAIL] ' + name + ' -> ' + JSON.stringify(got)); }
}
function run(action, extra) {
  const env = Object.assign({}, process.env, {
    JSQL_NO_STAR_NAG: '1',
    JSQL_MR_PATH: path.join(TMP, 'jsqlmr'),
    JSQL_NATIVE_PATH: NATIVE,
  });
  const args = [path.join(ROOT, 'bin', 'jsql'), 'native'];
  if (action) args.push(action);
  if (extra) args.push(...extra);
  return spawnSync(process.execPath, args, { encoding: 'utf8', env, timeout: 30000 });
}
function writeMeta(tag) {
  fs.writeFileSync(META, JSON.stringify({ tag, sha256: 'deadbeef', installedAt: new Date().toISOString() }, null, 2));
}

try {
  writeMeta(`v${version}`);
  let r = run('status');
  ok('匹配时 exit=0 且报 OK',
    r.status === 0 && /STATUS\s*:\s*OK/.test(r.stdout || ''),
    { code: r.status, out: r.stdout, err: r.stderr });

  writeMeta('v0.0.1');
  r = run('status');
  ok('版本错配时 exit=1 且报 MISMATCH',
    r.status === 1 && /MISMATCH/.test(r.stdout || ''),
    { code: r.status, out: r.stdout, err: r.stderr });

  fs.unlinkSync(META);
  r = run('status');
  ok('无元数据时 exit=1 且报 UNVERIFIED',
    r.status === 1 && /UNVERIFIED/.test(r.stdout || ''),
    { code: r.status, out: r.stdout, err: r.stderr });

  r = run(null);
  ok('不带 action 时默认走 status',
    r.status === 1 && /STATUS/.test(r.stdout || ''),
    { code: r.status, out: r.stdout, err: r.stderr });

  r = run('bogus');
  ok('未知 action 报 Usage 且 exit=1',
    r.status === 1 && /Unknown native action/.test((r.stdout || '') + (r.stderr || '')),
    { code: r.status, out: r.stdout, err: r.stderr });

  // --- verify：内容级校验（status 只看 tag，发现不了文件被替换/损坏）---
  const crypto = require('crypto');
  const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
  fs.writeFileSync(NATIVE, 'AAA');
  fs.writeFileSync(META, JSON.stringify({ tag: `v${version}`, sha256: sha('AAA') }));
  r = run('verify');
  ok('verify 校验和一致 → OK 且 exit=0',
    r.status === 0 && /VERIFY\s*:\s*OK/.test(r.stdout || ''),
    { code: r.status, out: r.stdout, err: r.stderr });

  fs.writeFileSync(NATIVE, 'BBB');   // 元数据不动，只换文件
  r = run('verify');
  ok('verify 文件被替换 → CORRUPT 且 exit=1',
    r.status === 1 && /CORRUPT/.test(r.stdout || ''),
    { code: r.status, out: r.stdout, err: r.stderr });

  r = run('verify', ['--json']);
  let j = null;
  try { j = JSON.parse(r.stdout); } catch (_) {}
  ok('verify --json 输出结构化结果',
    !!j && j.state === 'CORRUPT' && j.actualSha256 === sha('BBB') && j.present === true,
    { code: r.status, out: r.stdout });

  fs.writeFileSync(NATIVE, 'AAA');
  fs.writeFileSync(META, JSON.stringify({ tag: 'v0.0.1', sha256: sha('AAA') }));
  r = run('verify');
  ok('verify 内容对但 tag 错配 → MISMATCH 且 exit=1',
    r.status === 1 && /MISMATCH/.test(r.stdout || ''),
    { code: r.status, out: r.stdout, err: r.stderr });

  fs.unlinkSync(META);
  r = run('verify');
  ok('verify 无安装元数据 → UNVERIFIED 且 exit=1',
    r.status === 1 && /UNVERIFIED/.test(r.stdout || ''),
    { code: r.status, out: r.stdout, err: r.stderr });

  fs.unlinkSync(NATIVE);
  r = run('verify');
  ok('verify native 文件缺失 → MISSING 且 exit=1',
    r.status === 1 && /MISSING/.test(r.stdout || ''),
    { code: r.status, out: r.stdout, err: r.stderr });

  ok('没有污染用户级配置',
    !fs.existsSync(path.join(TMP, 'jsqlmr')), fs.readdirSync(TMP));
} finally {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
