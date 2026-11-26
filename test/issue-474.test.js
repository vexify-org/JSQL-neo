/*
 * #474 回归测试：ALTER ADD COLUMN 后必须立即落快照，避免崩溃恢复时
 * WAL 回放的行携带旧 schema 里不存在的孤儿列。
 *   node test/issue-474.test.js
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
  await t('#474 DDL 后立即落快照：文件内容含新列定义', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsql-474-'));
    const file = path.join(dir, 't.json');
    const db = new Database(file, { autoSave: false, wal: true });
    await db.createTable('t', { a: { type: 'integer' } });
    await db.insert('t', { a: 0 });
    db.save();
    db._tables.t.addColumn('b', { type: 'string' });
    await db.insert('t', { a: 1, b: 'hello' });
    // 不调用 save()/close()，直接读磁盘快照
    const raw = fs.readFileSync(file, 'utf8');
    assert.ok(/"b"\s*:/.test(raw), `schema not persisted: ${raw.slice(0, 200)}`);
    await db.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await t('#474 重开后 schema 与 WAL 回放行都含新列', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsql-474-'));
    const file = path.join(dir, 't.json');
    const db = new Database(file, { autoSave: false, wal: true });
    await db.createTable('t', { a: { type: 'integer' } });
    await db.insert('t', { a: 0 });
    db.save();
    db._tables.t.addColumn('b', { type: 'string' });
    await db.insert('t', { a: 1, b: 'hello' });
    // 模拟 SIGKILL：不 save()/stop()，删锁后直接重开走 WAL 回放
    if (fs.existsSync(file + '.lock')) fs.unlinkSync(file + '.lock');

    const db2 = new Database(file, { autoSave: false, wal: true });
    await db2.start();
    const schema = await db2.getTableSchema('t');
    assert.ok(schema.b, 'new column in schema');
    const rows = await db2.find('t', {});
    assert.ok(rows.some(r => r.b === 'hello'), 'replayed row preserves column b');
    await db2.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
})();
