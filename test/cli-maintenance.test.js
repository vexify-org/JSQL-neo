'use strict';
/* v6.5.25: `jsql update` / `jsql uninstall` helpers — offline unit tests. */

const fs = require('fs');
const os = require('os');
const path = require('path');

const updater = require('../lib/updater');
const uninstaller = require('../lib/uninstaller');

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log(`[OK] ${name}`); }
  else { fail++; console.log(`[FAIL] ${name}`); }
}

function fakeFetch(version) {
  return async () => JSON.stringify({ name: 'jsql-neo', version });
}

(async () => {
  // ── version comparison ─────────────────────────────────
  ok('compareVersions 6.5.24 < 6.5.25', updater.compareVersions('6.5.24', '6.5.25') === -1);
  ok('compareVersions v6.5.4 > 6.5.3', updater.compareVersions('v6.5.4', '6.5.3') === 1);
  ok('compareVersions equal', updater.compareVersions('6.5.24', 'v6.5.24') === 0);
  ok('prerelease is lower', updater.compareVersions('6.5.25-beta.1', '6.5.25') === -1);
  ok('isNewer true', updater.isNewer('6.5.25', '6.5.24'));
  ok('isNewer false', !updater.isNewer('6.5.24', '6.5.24'));

  // ── fetchLatestVersion (injected fetch) ────────────────
  const info = await updater.fetchLatestVersion({ fetchImpl: fakeFetch('9.9.9'), npmView: false });
  ok('fetchLatestVersion parses registry json', info.version === '9.9.9' && info.source === 'registry');

  let threw = false;
  try {
    await updater.fetchLatestVersion({ fetchImpl: async () => { throw new Error('offline'); }, npmView: false });
  } catch (e) { threw = true; }
  ok('fetchLatestVersion fails gracefully', threw);

  // ── runUpdate branches ─────────────────────────────────
  const upToDate = await updater.runUpdate({
    fetchImpl: fakeFetch(updater.currentVersion()), npmView: false, global: false,
  });
  ok('update: up-to-date', upToDate.ok && upToDate.action === 'up-to-date' && !upToDate.updateAvailable);

  const check = await updater.runUpdate({
    fetchImpl: fakeFetch('99.0.0'), npmView: false, global: false, checkOnly: true,
  });
  ok('update: check only', check.ok && check.action === 'checked' && check.updateAvailable);

  const local = await updater.runUpdate({
    fetchImpl: fakeFetch('99.0.0'), npmView: false, global: false,
  });
  ok('update: non-global gives instructions', local.action === 'instructions' && !!local.command);
  ok('update: never auto-installs locally', local.installed === false);

  const dry = await updater.runUpdate({
    fetchImpl: fakeFetch('99.0.0'), npmView: false, global: true, dryRun: true,
  });
  ok('update: global dry-run', dry.action === 'would-install' && /install -g/.test(dry.command));

  ok('formatResult renders versions', /当前版本/.test(updater.formatResult(upToDate)));

  // ── uninstall: path collection + safety ────────────────
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'jsql-uninstall-'));
  const oldHome = process.env.HOME;
  const oldMod = process.env.JSQL_MOD_CONFIG;
  const oldMr = process.env.JSQL_MR_PATH;
  const oldCache = process.env.JSQL_CACHE_DIR;
  try {
    process.env.HOME = tmpHome;
    delete process.env.JSQL_MOD_CONFIG;
    delete process.env.JSQL_MR_PATH;
    delete process.env.JSQL_CACHE_DIR;

    fs.mkdirSync(path.join(tmpHome, '.jsql', 'plugins'), { recursive: true });
    fs.writeFileSync(path.join(tmpHome, '.jsql', 'plugins', 'p.json'), '{}');
    fs.mkdirSync(path.join(tmpHome, '.config', 'jsql'), { recursive: true });
    fs.writeFileSync(path.join(tmpHome, '.config', 'jsql', 'mod.config'), '{}');
    fs.writeFileSync(path.join(tmpHome, '.jsqlmr'), '{}');

    const targets = uninstaller.collectTargets();
    ok('uninstall: collects user data paths', targets.length >= 3);
    ok('uninstall: keep-data collects nothing', uninstaller.collectTargets({ keepData: true }).length === 0);

    const inspected = uninstaller.inspectTargets();
    ok('uninstall: detects existing paths', inspected.filter(t => t.exists).length === 3);

    const dryRun = uninstaller.removeData({ dryRun: true });
    ok('uninstall: dry-run deletes nothing', fs.existsSync(path.join(tmpHome, '.jsql')) && dryRun.removed.length === 3);

    const removed = uninstaller.removeData();
    ok('uninstall: removes data', removed.removed.length === 3 && removed.failed.length === 0);
    ok('uninstall: .jsql gone', !fs.existsSync(path.join(tmpHome, '.jsql')));
    ok('uninstall: .jsqlmr gone', !fs.existsSync(path.join(tmpHome, '.jsqlmr')));
    ok('uninstall: home still exists', fs.existsSync(tmpHome));

    // malicious override must be refused
    process.env.JSQL_MR_PATH = path.join(uninstaller.packageDir(), 'README.md');
    const bad = uninstaller.removeData();
    ok('uninstall: refuses path inside package', bad.failed.length === 1 && fs.existsSync(path.join(uninstaller.packageDir(), 'README.md')));
  } finally {
    process.env.HOME = oldHome;
    if (oldMod === undefined) delete process.env.JSQL_MOD_CONFIG; else process.env.JSQL_MOD_CONFIG = oldMod;
    if (oldMr === undefined) delete process.env.JSQL_MR_PATH; else process.env.JSQL_MR_PATH = oldMr;
    if (oldCache === undefined) delete process.env.JSQL_CACHE_DIR; else process.env.JSQL_CACHE_DIR = oldCache;
    try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch (_) { /* ignore */ }
  }

  console.log(`\n=== pass ${pass}  fail ${fail} ===`);
  process.exit(fail ? 1 : 0);
})();
