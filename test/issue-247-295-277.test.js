/*
 * Regression tests for #247 #295 #277.
 */
const path = require('path');
const os = require('os');
const fs = require('fs');
const ROOT = path.join(__dirname, '..');
const { Database } = require(path.join(ROOT, 'index.js'));
const pg = require(path.join(ROOT, 'lib', 'pg_server.js'));
let passed = 0, failed = 0;
function ok(name, cond, extra) {
  if (cond) { passed++; console.log('[OK]', name); }
  else { failed++; console.log('[FAIL]', name, extra !== undefined ? '→ ' + JSON.stringify(extra) : ''); }
}

(async () => {
  // #247 WASM/JS 回退在 disk 模式下必须真正落盘
  {
    const native = require(path.join(ROOT, 'lib', 'native_client.js'));
    if (native._DiskFallbackJSQL) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsql-247-'));
      const file = path.join(dir, 'db.jsql');
      const db1 = new native._DiskFallbackJSQL({ path: file, mode: 'disk' });
      await db1.start();
      await db1.createTable('users', { id: 'INTEGER PRIMARY KEY', name: 'TEXT' });
      await db1.insert('users', { id: 1, name: 'alice' });
      await db1.stop();
      const db2 = new native._DiskFallbackJSQL({ path: file, mode: 'disk' });
      await db2.start();
      const rows = await db2.find('users', {});
      ok('#247 disk fallback persists across restart', rows.length === 1 && rows[0].name === 'alice', rows);
      await db2.stop();
    } else {
      console.log('[SKIP] #247 native module present');
    }
  }
  // #295 默认文件锁阻止同路径双实例
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsql-295-'));
    const file = path.join(dir, 'lock.jsql');
    const db1 = new Database(file);
    let code = null;
    try { const db2 = new Database(file); db2.stop(); } catch (e) { code = e.code; }
    ok('#295 second instance on same path is rejected', code === 1205 || code === 'ER_LOCK_WAIT_TIMEOUT', code);
    await db1.stop();
    const db3 = new Database(file);
    ok('#295 lock released after stop', !!db3);
    await db3.stop();
  }
  // #277 Bind 结果格式码 → RowDescription/DataRow 使用二进制
  {
    const desc = pg.buildRowDescription(['n'], ['integer'], [1]);
    ok('#277 RowDescription format code = 1', desc.readInt16BE(desc.length - 2) === 1, desc.toString('hex'));
    const row = pg.buildDataRow([5], ['integer'], [1]);
    const payload = row.slice(5);
    ok('#277 binary int4 DataRow', payload.readInt16BE(0) === 1 && payload.readInt32BE(2) === 4 && payload.readInt32BE(6) === 5, payload.toString('hex'));
    const textRow = pg.buildDataRow([5], ['integer'], [0]);
    ok('#277 text DataRow unchanged', textRow.slice(11).toString() === '5', textRow.toString('hex'));
    const fmts = pg.PgConnection.prototype._columnFormats.call({}, 3, [1]);
    ok('#277 single format applies to all columns', JSON.stringify(fmts) === '[1,1,1]', fmts);
    const perCol = pg.PgConnection.prototype._columnFormats.call({}, 3, [0, 1]);
    ok('#277 per-column format codes', JSON.stringify(perCol) === '[0,1,0]', perCol);
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
