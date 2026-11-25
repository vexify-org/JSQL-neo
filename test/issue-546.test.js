/*
 * #546 回归测试：restore() 批量替换必须落到行级 WAL，kill -9 后回放能重建导入行。
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { Database } = require(path.join(__dirname, '..', 'index.js'));

const base = process.env.JSQL_TEST_BASE || fs.mkdtempSync(path.join(os.tmpdir(), 'jsql-546-'));
const file = path.join(base, 'db.json');
const backup = path.join(base, 'backup.json');

async function childMain() {
  const db = new Database(file, { wal: true, autoSave: false, fileLock: false });
  await db.query('CREATE TABLE t(id INTEGER PRIMARY KEY, v STRING)');
  for (let i = 1; i <= 5; i++) await db.query(`INSERT INTO t VALUES (${i}, 'base${i}')`);
  await db.save();
  fs.writeFileSync(backup, JSON.stringify({ t: [{ id: 100, v: 'restored' }] }));
  db.restore(backup);
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
  assert.deepStrictEqual(rows, [[100, 'restored']], 'restored rows must survive WAL replay: ' + JSON.stringify(rows));

  fs.rmSync(base, { recursive: true, force: true });
  console.log('1 passed, 0 failed');
})().catch((e) => { console.error('not ok - #546\n  ' + e.message); process.exit(1); });
