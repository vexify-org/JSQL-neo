/**
 * #90 版本比较：预发布号按字符串比较、4 段版本号被截断
 *
 *   node test/updater-semver.test.js
 */
const { compareVersions, isNewer, parseVersion } = require('../lib/updater');

let p = 0, f = 0;
const ok = (n, c, g) => { if (c) p++; else { f++; console.log('[FAIL]', n, '->', JSON.stringify(g)); } };

// ---------- 预发布号按数值比较（semver §11）
ok('#90 alpha.10 > alpha.9', compareVersions('1.0.0-alpha.10', '1.0.0-alpha.9') === 1,
  compareVersions('1.0.0-alpha.10', '1.0.0-alpha.9'));
ok('#90 isNewer(alpha.10, alpha.9) === true', isNewer('1.0.0-alpha.10', '1.0.0-alpha.9') === true);
ok('#90 alpha.9 < alpha.10', compareVersions('1.0.0-alpha.9', '1.0.0-alpha.10') === -1);
ok('#90 beta.2 > beta.10 为 false', isNewer('1.0.0-beta.2', '1.0.0-beta.10') === false);
ok('#90 rc.1 > beta.9', compareVersions('1.0.0-rc.1', '1.0.0-beta.9') === 1);
ok('#90 alpha < alpha.1（短的低）', compareVersions('1.0.0-alpha', '1.0.0-alpha.1') === -1);
ok('#90 数字标识符低于字母', compareVersions('1.0.0-1', '1.0.0-alpha') === -1);

// ---------- 正式版仍然高于预发布
ok('#90 1.0.0 > 1.0.0-rc.1', compareVersions('1.0.0', '1.0.0-rc.1') === 1);
ok('#90 1.0.0-rc.1 < 1.0.0', compareVersions('1.0.0-rc.1', '1.0.0') === -1);
ok('#90 两个正式版相等', compareVersions('1.2.3', '1.2.3') === 0);

// ---------- 4 段版本号不再被截断
ok('#90 compareVersions(1.2.3.4, 1.2.3) === 1', compareVersions('1.2.3.4', '1.2.3') === 1,
  compareVersions('1.2.3.4', '1.2.3'));
ok('#90 compareVersions(1.2.3, 1.2.3.4) === -1', compareVersions('1.2.3', '1.2.3.4') === -1);
ok('#90 isNewer(1.2.3.4, 1.2.3) === true', isNewer('1.2.3.4', '1.2.3') === true);
ok('#90 isNewer(1.2.3, 1.2.3.4) === false', isNewer('1.2.3', '1.2.3.4') === false);
ok('#90 1.2.3.4 < 1.2.4', compareVersions('1.2.3.4', '1.2.4') === -1);

// ---------- 宽松解析与常见写法回归
ok('#90 忽略 v 前缀', compareVersions('v1.2.3', '1.2.3') === 0);
ok('#90 忽略 build metadata', compareVersions('1.2.3+build.9', '1.2.3') === 0);
ok('#90 缺段补 0', compareVersions('1.2', '1.2.0') === 0);
ok('#90 主版本更高', compareVersions('2.0.0', '1.99.99') === 1);
ok('#90 次版本更高', compareVersions('1.10.0', '1.9.0') === 1);
ok('#90 6.6.2 > 6.6.1', isNewer('6.6.2', '6.6.1') === true);
ok('#90 nums 不丢段', parseVersion('1.2.3.4').nums.length === 4, parseVersion('1.2.3.4').nums);

console.log(`\nupdater-semver: ${p} passed, ${f} failed`);
process.exit(f ? 1 : 0);
