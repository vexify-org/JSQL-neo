#!/usr/bin/env node
'use strict';
/**
 * 发版元数据门禁 —— 纯本地静态检查，不访问任何网络。
 *
 * 为什么存在：6.6.0/6.6.1、6.6.3/6.6.4 都发生过「release commit 只 bump
 * 版本标记、没写 CHANGELOG 章节」，每次都靠下一次发版时人工补记。
 * bump 与 CHANGELOG 之间没有任何依赖，所以漏了不会报错。
 *
 * 现在把「当前版本必须在 CHANGELOG 里有对应章节」变成硬检查，接进
 * npm test / test:all 和 publish.yml 的发布前一步：漏写就发不了版。
 *
 * 可用 checkReleaseMetadata(root) 指定任意目录（测试用临时副本）。
 */
const fs = require('fs');
const path = require('path');

function read(root, file) {
  try { return fs.readFileSync(path.join(root, file), 'utf8'); }
  catch (e) { return null; }
}
function esc(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function checkReleaseMetadata(root) {
  const checks = [];
  const warnings = [];
  const add = (name, ok, detail) => checks.push({ name, ok: !!ok, detail: detail || '' });

  let version = null;
  const pkgRaw = read(root, 'package.json');
  if (pkgRaw === null) {
    add('package.json 可读', false, '文件不存在');
    return { ok: false, checks, warnings, version };
  }
  try { version = JSON.parse(pkgRaw).version; }
  catch (e) {
    add('package.json 可解析', false, e.message);
    return { ok: false, checks, warnings, version };
  }

  const verRe = /^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.]+)?$/;
  add('package.json 版本号格式合法', verRe.test(version), version);

  const readme = read(root, 'README.md');
  const banner = readme && readme.match(/^> \*\*v(\d+\.\d+\.\d+(?:-[a-zA-Z0-9.]+)?)\*\*/m);
  add('README 顶部版本横幅与 package.json 一致',
    banner && banner[1] === version,
    banner ? 'README=' + banner[1] + ' package=' + version : '未找到横幅');

  // 预发布版本不能把横幅标成 stable —— 那是明确的虚标。
  if (banner) {
    const line = (readme.match(/^> \*\*v[^*]+\*\*[^\n]*/m) || [''])[0];
    const isPre = /-(?:alpha|beta|rc|fix)\./.test(version);
    add('预发布版本未标注为 stable', !(isPre && /—\s*stable release/.test(line)),
      line.slice(0, 80));
  }

  const index = read(root, 'index.js');
  const im = index && index.match(/JSQL-NEO v(\d+\.\d+\.\d+(?:-[a-zA-Z0-9.]+)?)/);
  add('index.js 头部版本注释与 package.json 一致',
    im && im[1] === version,
    im ? 'index.js=' + im[1] + ' package=' + version : '未找到头注释');

  const changelog = read(root, 'CHANGELOG.md');
  if (changelog === null) {
    add('CHANGELOG.md 可读', false, '文件不存在');
  } else {
    const section = new RegExp('^## \\[' + esc(version) + '\\](?:\\s|$)', 'm');
    add('CHANGELOG 含 [' + version + '] 章节', section.test(changelog),
      section.test(changelog) ? '' : '缺少 ## [' + version + '] — 发版前必须转正');

    // 软提示：开发中往 [Unreleased] 累积内容是正常做法，不该让 npm test 变红；
    // 但发版时若还留着内容，说明有改动没归类，值得提醒。
    const lines = changelog.split(/\r?\n/);
    const ui = lines.findIndex(l => /^## \[Unreleased\]/.test(l));
    if (ui >= 0) {
      const body = [];
      for (let j = ui + 1; j < lines.length && !/^## \[/.test(lines[j]); j++) {
        if (lines[j].trim()) body.push(lines[j].trim());
      }
      if (body.length) warnings.push('[Unreleased] 还有 ' + body.length + ' 行未转正内容');
    } else {
      warnings.push('CHANGELOG 缺少 [Unreleased] 段');
    }
  }

  return { ok: checks.every(c => c.ok), checks, warnings, version };
}

module.exports = { checkReleaseMetadata };

if (require.main === module) {
  // LOCAL-ONLY: 只读本仓库文件，无任何网络访问。
  const { ok, checks, warnings, version } = checkReleaseMetadata(path.join(__dirname, '..'));
  console.log('release metadata check — v' + version);
  for (const c of checks) {
    console.log('  ' + (c.ok ? '[OK]   ' : '[FAIL] ') + c.name + (c.detail ? ' → ' + c.detail : ''));
  }
  for (const w of warnings) console.log('  [WARN] ' + w);
  console.log(ok ? '  PASS' : '  FAIL');
  process.exit(ok ? 0 : 1);
}
