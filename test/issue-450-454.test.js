/*
 * 回归测试：#450 #451 #452 #453 #454
 *
 * 口径：全部走公共 API（require('../index.js') 导出的 Database / migrate），
 * 真实目录库 / 真实重启，不直接断言私有类内部字段。
 *
 *  #450 [P2] Table.restore() 永远匹配不到软删除行（恢复过滤先跳过 _deleted 行）。
 *  #451 [P2] 复合 CREATE UNIQUE INDEX (a,b) 不写回 schema，重启后唯一组丢失。
 *  #452 [P2] 目录模式事务内 CREATE TABLE 回滚后，表连同未提交行复活。
 *  #453 [P2] meta.json 直接 writeFileSync，撕裂后静默清空注册表、表文件成孤儿。
 *  #454 [P2] CSV/JSON 导入不按目标 schema 过滤未知列，幽灵字段被持久化。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const ROOT = path.join(__dirname, '..');
const { Database } = require(path.join(ROOT, 'index.js'));
const migrate = require(path.join(ROOT, 'lib/migrate.js'));

let passed = 0, failed = 0;

async function t(name, fn) {
  try { await fn(); passed++; console.log(`ok - ${name}`); }
  catch (e) { failed++; console.error(`not ok - ${name}\n  ${e && e.message}`); }
}

function tmpDir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'jsql-450-454-' + tag + '-'));
}

(async () => {
  // #450：软删除行可以被 restore 恢复，恢复后重新出现在普通查询结果中。
  await t('#450 restore 能匹配并恢复软删除行', async () => {
    const db = new Database(':memory:');
    try {
      await db.createTable('t', {
        id: { type: 'integer', primaryKey: true },
        email: { type: 'string' },
        _softDelete: true
      });
      await db.insert('t', { id: 1, email: 'a@x.com' });

      db.t.removeSoft({ id: 1 });
      // 恢复前：软删除行不出现在普通查询结果中
      assert.deepEqual(await db.find('t', {}), []);

      const restored = db.t.restore({ id: 1 });
      assert.strictEqual(restored, 1);

      const rows = await db.find('t', {});
      assert.strictEqual(rows.length, 1);
      assert.strictEqual(rows[0].id, 1);
      assert.strictEqual(rows[0].email, 'a@x.com');
    } finally {
      db.close();
    }
  });

  // #451：复合唯一索引随 schema 落盘，重开后重复组合键仍被拒绝。
  await t('#451 复合唯一索引重启后仍生效', async () => {
    const dir = tmpDir('451');
    const file = path.join(dir, 'db.jsql');
    let db = new Database(file);
    await db.query('CREATE TABLE t (a INT, b INT)');
    await db.query('CREATE UNIQUE INDEX idx_ab ON t (a, b)');
    await db.insert('t', { a: 1, b: 1 });
    db.save();
    db.close();

    // 重开库
    db = new Database(file);
    try {
      // 不重复的组合键可以正常写入
      await db.insert('t', { a: 2, b: 2 });
      let dupErr = null;
      try {
        await db.insert('t', { a: 1, b: 1 });
      } catch (e) {
        dupErr = e;
      }
      assert(dupErr, '重开后重复组合键应被拒绝');
      assert.strictEqual(dupErr.code, 1062); // ER_DUP_ENTRY
    } finally {
      db.close();
    }
  });

  // #452：目录模式事务内建表回滚后，meta 登记与 .jsql 文件都不残留，重开不复活。
  await t('#452 目录 DDL 回滚后被回滚的表不复活', async () => {
    const dir = tmpDir('452');
    let db = new Database(dir, { mode: 'disk', flushInterval: 0 });
    await db.createTable('parent', { id: { type: 'integer', primaryKey: true }, v: { type: 'string' } });
    await db.insert('parent', { id: 1, v: 'seed' });
    await db.flush();

    await db.beginTx();
    await db.createTable('ghost', { id: { type: 'integer', primaryKey: true }, v: { type: 'string' } });
    await db.insert('ghost', { id: 1, v: 'uncommitted' });
    await db.flush();
    await db.rollbackTx();

    // 回滚后内存与 meta 都不应残留 ghost
    assert.deepEqual(db.getTables().slice().sort(), ['parent']);
    assert.strictEqual(db.hasTable('ghost'), false);
    db.close();

    // 重开目录库：ghost 不得复活，已提交的 parent 不受影响
    db = new Database(dir, { mode: 'disk', flushInterval: 0 });
    try {
      assert.strictEqual(db.hasTable('ghost'), false);
      assert.deepEqual(db.getTables().slice().sort(), ['parent']);
      const parentRows = await db.find('parent', {});
      assert.strictEqual(parentRows.length, 1);
      assert.strictEqual(parentRows[0].v, 'seed');
    } finally {
      db.close();
    }
  });

  // #453：meta.json 撕裂/损坏后不静默清空注册表，从 .jsql 文件重建登记，表仍可查询。
  await t('#453 meta 损坏后从表文件重建登记，不致表失联', async () => {
    const dir = tmpDir('453');
    const db0 = new Database(dir, { mode: 'disk', flushInterval: 0 });
    await db0.createTable('t', { id: { type: 'integer', primaryKey: true }, v: { type: 'string' } });
    await db0.insert('t', { id: 1, v: 'hello' });
    await db0.flush();
    db0.close();

    // 模拟半写撕裂：把 meta.json 截断到一半
    const metaPath = path.join(dir, 'meta.json');
    const raw = fs.readFileSync(metaPath, 'utf8');
    fs.writeFileSync(metaPath, raw.slice(0, Math.floor(raw.length / 2)));

    const db = new Database(dir, { mode: 'disk', flushInterval: 0 });
    const errors = [];
    db.on('error', e => errors.push(e));
    await new Promise(r => setImmediate(r));

    try {
      assert.strictEqual(db.hasTable('t'), true);
      const rows = await db.find('t', {});
      assert.strictEqual(rows.length, 1);
      assert.strictEqual(rows[0].v, 'hello');
      // 排障记录可见：损坏原因 + 重建出的表
      const corrupt = db.getMetaCorruption();
      assert(corrupt, '应记录 meta 损坏兜底恢复记录');
      assert.deepEqual(corrupt.restored, ['t']);
      // 损坏原件已备份，不是直接丢弃
      const backups = fs.readdirSync(dir).filter(f => f.startsWith('meta.json.corrupt-'));
      assert(backups.length >= 1, '损坏 meta 应备份为 meta.json.corrupt-<ts>');
    } finally {
      db.close();
    }

    // 正常路径行为不变：完好 meta 不报损坏
    const dir2 = tmpDir('453-ok');
    const db2 = new Database(dir2, { mode: 'disk', flushInterval: 0 });
    try {
      await db2.createTable('x', { id: { type: 'integer', primaryKey: true } });
      assert.strictEqual(db2.getMetaCorruption(), null);
    } finally {
      db2.close();
    }
  });

  // #454：CSV / JSON 导入只保留目标 schema 内的列，未知列不写进存储行。
  await t('#454 导入按目标 schema 过滤未知列', async () => {
    // CSV 路径：目标表只有 id/name，CSV 多带一列 ghost
    const db = new Database(':memory:');
    try {
      await db.createTable('d', { id: { type: 'integer' }, name: { type: 'string' } });
      const csvRes = await migrate.importFromCSV(db, 'd', 'id,name,ghost\n1,alice,xyz\n');
      const csvRows = await db.find('d', {});
      assert.strictEqual(csvRows.length, 1);
      assert.deepEqual(Object.keys(csvRows[0]).sort(), ['id', 'name']);
      assert(csvRes.warnings && csvRes.warnings.some(w => w.kind === 'unknownColumn'));
    } finally {
      db.close();
    }

    // JSON 路径：行内携带 schema 中不存在的 extra 字段
    const db2 = new Database(':memory:');
    try {
      const jsonRes = await migrate.importFromJSON(db2, {
        g: {
          schema: { id: 'integer', name: 'string' },
          rows: [{ id: 1, name: 'a', extra: 'ghost' }]
        }
      });
      const jsonRows = await db2.find('g', {});
      assert.strictEqual(jsonRows.length, 1);
      assert.deepEqual(Object.keys(jsonRows[0]).sort(), ['id', 'name']);
      assert(jsonRes.warnings && jsonRes.warnings.some(w => w.kind === 'unknownColumn'));
    } finally {
      db2.close();
    }
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
