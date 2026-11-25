const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { Database, WebUI } = require('../index.js');
const { importFromCSV } = require('../lib/migrate.js');

let passed = 0, failed = 0;
async function t(name, fn) {
  try { await fn(); passed++; console.log(`ok - ${name}`); }
  catch (e) { failed++; console.error(`not ok - ${name}\n  ${e && e.message}`); }
}

(async () => {
  // #357：RENAME COLUMN 后 CHECK 表达式必须跟着改列名，且仍然生效
  await t('#357 RENAME COLUMN 后 CHECK 继续生效', async () => {
    const db = new Database(':memory:');
    await db.query('CREATE TABLE t1 (a INT CHECK (a > 0))', { safety: false });
    await db.query('ALTER TABLE t1 RENAME COLUMN a TO b', { safety: false });
    const def = db._tables.t1._schema.b;
    assert.ok(def && def.checkSql === 'b > 0', `checkSql 应为 b > 0，实际 ${def && def.checkSql}`);
    assert.strictEqual(db._tables.t1._checkConstraints[0].field, 'b');
    await assert.rejects(
      () => db.query('INSERT INTO t1 (b) VALUES (-5)', { safety: false }),
      /Check constraint/);
    const ok = await db.query('INSERT INTO t1 (b) VALUES (5)', { safety: false });
    assert.strictEqual(ok.affectedRows, 1);
    await db.close();
  });

  // #358：RENAME TABLE 后索引登记表指向新表名，DROP INDEX 仍可反查
  await t('#358 RENAME TABLE 同步索引登记表', async () => {
    const db = new Database(':memory:');
    await db.query('CREATE TABLE t3 (id INT PRIMARY KEY, v INT)', { safety: false });
    await db.query('CREATE INDEX idx_v ON t3(v)', { safety: false });
    assert.strictEqual(db._indexRegistry.get('idx_v').table, 't3');
    await db.query('ALTER TABLE t3 RENAME TO t3n', { safety: false });
    assert.strictEqual(db._indexRegistry.get('idx_v').table, 't3n');
    await db.query('DROP INDEX idx_v', { safety: false });
    assert.strictEqual(db._indexRegistry.has('idx_v'), false);
    assert.deepStrictEqual(Object.keys(db._tables.t3n._indexes), []);
    await db.close();
  });

  // #359：MODIFY COLUMN 去掉 DEFAULT 后旧默认值不得残留
  await t('#359 MODIFY COLUMN 清除旧 DEFAULT', async () => {
    const db = new Database(':memory:');
    await db.query('CREATE TABLE t2 (id INT PRIMARY KEY, a INT DEFAULT 7)', { safety: false });
    await db.query('INSERT INTO t2 (id) VALUES (1)', { safety: false });
    assert.deepStrictEqual((await db.query('SELECT a FROM t2', { safety: false })).rows, [[7]]);
    await db.query('ALTER TABLE t2 MODIFY a INT', { safety: false });
    await db.query('INSERT INTO t2 (id) VALUES (2)', { safety: false });
    const rows = (await db.query('SELECT id, a FROM t2 ORDER BY id', { safety: false })).rows;
    assert.deepStrictEqual(rows[0], [1, 7]);
    assert.strictEqual(rows[1][0], 2);
    assert.ok(rows[1][1] == null, `第二行 a 应为空，实际 ${rows[1][1]}`);
    await db.close();
  });

  // #362：CSV 行宽与表头不一致必须给出 warnings，strictRows 直接中止
  await t('#362 CSV 行宽不一致产出 warnings', async () => {
    const db = new Database(':memory:');
    await db.query('CREATE TABLE c (id INT PRIMARY KEY, s TEXT)', { safety: false });
    const csv = 'id,s\n1,a\n2,b,extra\n3\n';
    const r = await importFromCSV(db, 'c', csv);
    assert.strictEqual(r.warnings.length, 2);
    assert.deepStrictEqual(r.warnings[0], { row: 3, kind: 'extra', count: 1, expected: 2, actual: 3 });
    assert.deepStrictEqual(r.warnings[1], { row: 4, kind: 'missing', count: 1, expected: 2, actual: 1 });
    await assert.rejects(() => importFromCSV(db, 'c', csv, { strictRows: true }), /expected 2 fields, got 3/);
    const clean = await importFromCSV(db, 'c', 'id,s\n9,z\n');
    assert.strictEqual(clean.warnings, undefined);
    await db.close();
  });

  // #365：WebUI /api/databases 的表数必须来自真实 schema
  await t('#365 listDatabases 表数不再用引号估算', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsql-ui-'));
    const seed = new Database(path.join(dir, 'one.json'));
    await seed.createTable('only', { id: { type: 'integer', primaryKey: true } });
    await seed.close();
    const ui = new WebUI({ dataDir: dir, noAuth: true });
    const list = ui.listDatabases();
    assert.deepStrictEqual(list, [{ name: 'one', tables: 1 }]);
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
