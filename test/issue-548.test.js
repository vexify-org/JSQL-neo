/*
 * #548 回归测试：updateById 改写主键后 kill -9，WAL 回放不得放出旧主键幽灵行。
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { Database } = require(path.join(__dirname, '..', 'index.js'));

const base = process.env.JSQL_TEST_BASE || fs.mkdtempSync(path.join(os.tmpdir(), 'jsql-548-'));
const file = path.join(base, 'db.json');

async function childMain() {
  const db = new Database(file, { wal: true, autoSave: false, fileLock: false });
  await db.query('CREATE TABLE t(id INTEGER PRIMARY KEY, v STRING)');
  for (let i = 1; i <= 5; i++) await db.query(`INSERT INTO t VALUES (${i}, 'v${i}')`);
  await db.save();
  await db.updateById('t', 1, { id: 100 });
  console.log('READY');
  setInterval(() => {}, 1000);
}

function reopenDump() {
  const db = new Database(file, { wal: true, fileLock: false });
  const rows = db._tables.t ? db._tables.t._rows.map(r => [r.id, r.v]) : [];
  console.log('REOPEN ' + JSON.stringify(rows));
  db.close();
  process.exit(0);
}

function run(mode) {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, [__filename, mode], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, JSQL_TEST_BASE: base } });
    let out = '';
    c.stdout.on('data', d => { out += d; });
    c.stderr.on('data', d => { out += d; });
    c.on('exit', (code) => resolve({ code, out }));
  });
}

(async () => {
  if (process.argv[2] === 'child') { await childMain(); return; }
  if (process.argv[2] === 'reopen') { reopenDump(); return; }

  const holder = spawn(process.execPath, [__filename, 'child'], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, JSQL_TEST_BASE: base } });
  let ready = '';
  await new Promise((resolve) => {
    holder.stdout.on('data', d => {
      ready += d;
      if (ready.includes('READY')) setTimeout(resolve, 50);
    });
    holder.on('exit', resolve);
  });
  holder.kill('SIGKILL');
  await new Promise(resolve => holder.on('exit', resolve));

  const r = await run('reopen');
  const line = r.out.split('\n').find(l => l.startsWith('REOPEN '));
  assert.ok(line, 'reopen probe produced no output: ' + r.out);
  const rows = JSON.parse(line.slice(7));
  assert.ok(!rows.some(x => x[0] === 1), 'ghost row id=1 must not survive: ' + JSON.stringify(rows));
  assert.ok(rows.some(x => x[0] === 100 && x[1] === 'v1'), 'new row id=100 must survive: ' + JSON.stringify(rows));
  assert.strictEqual(rows.length, 5, 'expected exactly 5 rows, got ' + JSON.stringify(rows));

  fs.rmSync(base, { recursive: true, force: true });
  console.log('3 passed, 0 failed');
})().catch((e) => { console.error('not ok - #548\n  ' + e.message); process.exit(1); });
