/*
 * Regression tests for #258 #293 #298 #299 #300.
 *   node test/issue-258-300.test.js
 */
const path = require('path');
const os = require('os');
const fs = require('fs');
const ROOT = path.join(__dirname, '..');
const { Database, executeSQL } = require(path.join(ROOT, 'index.js'));
let passed = 0, failed = 0;
function ok(name, cond, extra) {
  if (cond) { passed++; console.log('[OK]', name); }
  else { failed++; console.log('[FAIL]', name, extra !== undefined ? '→ ' + JSON.stringify(extra) : ''); }
}
const q = (db, sql) => executeSQL(db, sql, { safety: false });

(async () => {
  // #258
  {
    const db = new Database(':memory:');
    await q(db, 'CREATE TABLE t (id INT)');
    await q(db, 'INSERT INTO t VALUES (1),(2)');
    let code = null;
    try { await q(db, 'SELECT (SELECT id FROM t) AS x'); } catch (e) { code = e.code; }
    ok('#258 scalar subquery with multiple rows -> 1242', code === 1242, code);
    db.stop();
  }
  // #293
  {
    const db = new Database(':memory:');
    await q(db, 'CREATE TABLE t (g TEXT, v INT)');
    await q(db, "INSERT INTO t VALUES ('a',1),('a',2),('b',3)");
    const arr = (await q(db, 'SELECT g, JSON_ARRAYAGG(v) AS j FROM t GROUP BY g ORDER BY g')).rows;
    ok('#293 JSON_ARRAYAGG aggregates whole group', JSON.stringify(arr) === JSON.stringify([['a', [1, 2]], ['b', [3]]]), arr);
    const obj = (await q(db, "SELECT JSON_OBJECTAGG(g, v) AS o FROM t")).rows;
    ok('#293 JSON_OBJECTAGG builds object', obj.length === 1 && JSON.stringify(obj[0][0]) === JSON.stringify({ a: 2, b: 3 }), obj);
    db.stop();
  }
  // #298 / #299
  {
    const tui = require(path.join(ROOT, 'lib', 'tui.js'));
    ok('#298 emoji width counted as 2', tui.wswidth('😀') === 2 && tui.wswidth('abc😀') === 5, [tui.wswidth('😀'), tui.wswidth('abc😀')]);
    const shell = Object.create(tui.TUIShell.prototype);
    ok('#299 escaped quote keeps statement balanced', shell._statementComplete("SELECT 'a\\'b';") === true, shell._statementComplete("SELECT 'a\\'b';"));
  }
  // #300 history file has no pid
  {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'jsql-home-'));
    const oldHome = process.env.HOME;
    const oldProfile = process.env.USERPROFILE;
    process.env.HOME = home;
    // tui.js 用 os.homedir() 定位历史文件：POSIX 读 $HOME，Windows 读
    // %USERPROFILE% —— 只设 HOME 的话，Windows 上历史写进真实用户目录，
    // 临时目录 readdirSync 为空（CI 三平台全挂）。两个都设、都还原。
    if (oldProfile !== undefined) process.env.USERPROFILE = home;
    const tuiPath = path.join(ROOT, 'lib', 'tui.js');
    delete require.cache[require.resolve(tuiPath)];
    const tui = require(tuiPath);
    const shell = Object.create(tui.TUIShell.prototype);
    shell.history = ['SELECT 1;'];
    shell._saveHistory();
    const files = fs.readdirSync(home);
    ok('#300 history file is session-independent', files.includes('.jsql-history'), files);
    process.env.HOME = oldHome;
    if (oldProfile !== undefined) process.env.USERPROFILE = oldProfile;
    delete require.cache[require.resolve(tuiPath)];
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
