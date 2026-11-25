/*
 * #547 回归测试：.jsql 单文件无主键表必须写入快照并能重开读出。
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Database } = require(path.join(__dirname, '..', 'index.js'));

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsql-547-'));
  const file = path.join(dir, 'db.jsql');

  let db = new Database(file, { wal: false, fileLock: false });
  await db.createTable('log', { v: { type: 'string' } });
  await db.insertMany('log', [{ v: 'a' }, { v: 'b' }, { v: 'c' }]);
  db.save();
  db.close();

  db = new Database(file, { wal: false, fileLock: false });
  const rows = await db.find('log', {});
  assert.strictEqual(rows.length, 3, 'no-PK table rows must survive reopen: ' + JSON.stringify(rows));
  assert.deepStrictEqual(rows.map(r => r.v), ['a', 'b', 'c']);
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
  console.log('2 passed, 0 failed');
})().catch((e) => { console.error('not ok - #547\n  ' + e.message); process.exit(1); });
