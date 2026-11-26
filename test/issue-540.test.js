/*
 * #540 回归测试：restore() 应还原备份的完整表集合（建缺失表、清理多余表）。
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Database } = require(path.join(__dirname, '..', 'index.js'));

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsql-540-'));
  const backup = path.join(dir, 'backup.json');

  const src = new Database(':memory:');
  await src.createTable('t1', { id: { type: 'integer', primaryKey: true }, v: { type: 'string' } });
  await src.insert('t1', { id: 1, v: 'a' });
  src.backup(backup);
  await src.close();

  const dst = new Database(':memory:');
  await dst.createTable('t2', { id: { type: 'integer', primaryKey: true } });
  await dst.insert('t2', { id: 7 });
  dst.restore(backup);

  assert.ok(dst._tables.t1, 'backup-only table t1 must be created');
  assert.deepStrictEqual(await dst.find('t1', {}), [{ id: 1, v: 'a' }]);
  assert.ok(!dst._tables.t2, 'target-only table t2 must be removed');
  await dst.close();
  fs.rmSync(dir, { recursive: true, force: true });
  console.log('4 passed, 0 failed');
})().catch((e) => { console.error('not ok - #540\n  ' + e.message); process.exit(1); });
