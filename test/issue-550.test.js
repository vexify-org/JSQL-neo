/*
 * #550 回归测试：残留 .lock 内的 PID 已死亡时应回收锁，而非等 30 秒超时。
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Database } = require(path.join(__dirname, '..', 'index.js'));

let passed = 0, failed = 0;
async function t(name, fn) {
  try { await fn(); passed++; console.log(`ok - ${name}`); }
  catch (e) { failed++; console.error(`not ok - ${name}\n  ${e && e.message}`); }
}

(async () => {
  await t('#550 死 PID 的新鲜锁文件应被接管', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsql-550-'));
    const file = path.join(dir, 'db.json');
    const lock = file + '.lock';
    // 不存在的 PID（远超系统上限），且 mtime 是刚刚写入的（<30s）
    fs.writeFileSync(lock, '2147483647');
    assert.ok(Date.now() - fs.statSync(lock).mtimeMs < 30000);

    let db = null;
    try {
      db = new Database(file, { wal: false, fileLock: true });
      assert.ok(db, 'reopen should succeed');
      assert.strictEqual(fs.readFileSync(lock, 'utf8'), String(process.pid));
    } finally {
      if (db) db.close();
    }
    assert.ok(!fs.existsSync(lock), 'lock released on close');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await t('#550 活着的持锁进程仍应拒绝重开', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsql-550-alive-'));
    const file = path.join(dir, 'db.json');
    const lock = file + '.lock';
    fs.writeFileSync(lock, String(process.pid)); // 本进程存活
    let err = null;
    try { const db = new Database(file, { wal: false, fileLock: true }); db.close(); }
    catch (e) { err = e; }
    assert.ok(err, 'expected lock timeout for live holder');
    assert.strictEqual(err.code, 1205);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
