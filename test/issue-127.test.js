/* 回归测试：issue #127 live 新建大表也要挂行级 LRU（rowCache） */
const path = require('path');
const os = require('os');
const fs = require('fs');
const ROOT = path.join(__dirname, '..');
const Database = require(path.join(ROOT, 'lib', 'database'));

let pass = 0, fail = 0;
function ok(name, cond, got) {
  if (cond) { pass++; console.log('[OK]   ' + name); }
  else { fail++; console.log('[FAIL] ' + name + ' -> ' + JSON.stringify(got)); }
}

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsql-issue127-'));
  const db = new Database(dir, { mode: 'hybrid', flushInterval: 0 });
  await db.createTable('t', {
    id: { type: 'integer', primaryKey: true, autoIncrement: true },
    v: { type: 'integer' },
  });
  const rows = [];
  for (let i = 1; i <= 1500; i++) rows.push({ v: i });
  await db.insertMany('t', rows);
  await db.flush();

  const table = db._tables['t'];
  ok('#127 live 大表挂上 rowCache', !!table._rowCache);
  ok('#127 数据量正确', table.find().length === 1500);
  ok('#127 淘汰前可读', table.find({ v: 1234 })[0].v === 1234);

  const evicted = table._evictRows(Infinity);
  ok('#127 行级 LRU 可逐行淘汰', evicted === 1500, evicted);
  ok('#127 淘汰后回读正确', table.find({ v: 1234 })[0].v === 1234);

  await db.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
})().catch(e => { console.error(e); process.exitCode = 1; });
