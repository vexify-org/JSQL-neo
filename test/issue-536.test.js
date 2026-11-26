/*
 * #536 回归测试：restore/import 遇到非数组行集合必须报错，不得拆成逐字符垃圾行。
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Database } = require(path.join(__dirname, '..', 'index.js'));

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsql-536-'));
  const backup = path.join(dir, 'backup.json');

  const src = new Database(':memory:');
  await src.createTable('t1', { id: { type: 'integer', primaryKey: true } });
  await src.createTable('t2', { id: { type: 'integer', primaryKey: true } });
  await src.insert('t1', { id: 1 });
  await src.insert('t2', { id: 1 });
  src.backup(backup);
  await src.close();

  const data = JSON.parse(fs.readFileSync(backup, 'utf8'));
  data.t2 = 'corrupt-not-an-array';
  fs.writeFileSync(backup, JSON.stringify(data));

  const dst = new Database(':memory:');
  await dst.createTable('t1', { id: { type: 'integer', primaryKey: true } });
  await dst.createTable('t2', { id: { type: 'integer', primaryKey: true } });
  await dst.insert('t1', { id: 999 });
  await dst.insert('t2', { id: 999 });

  let err = null;
  try { dst.restore(backup); } catch (e) { err = e; }
  assert.ok(err, 'corrupt backup must be rejected');
  assert.deepStrictEqual(await dst.find('t1', {}), [{ id: 999 }]);
  assert.deepStrictEqual(await dst.find('t2', {}), [{ id: 999 }]);

  let err2 = null;
  try { dst.import({ t2: 'corrupt' }); } catch (e) { err2 = e; }
  assert.ok(err2, 'import must reject non-array rows');
  assert.deepStrictEqual(await dst.find('t2', {}), [{ id: 999 }]);

  await dst.close();
  fs.rmSync(dir, { recursive: true, force: true });
  console.log('5 passed, 0 failed');
})().catch((e) => { console.error('not ok - #536\n  ' + e.message); process.exit(1); });
