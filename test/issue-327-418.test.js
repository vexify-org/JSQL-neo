/*
 * Regression tests for #327 #357 #359 #418 #406.
 *
 * 口径：全部走公共 API（require('../index.js') 导出的 JSQL / Database），
 * 不直接断言私有类（#247 假绿前车之鉴）。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { JSQL, Database } = require('../index.js');
const { xql } = require('../lib/xql');

let passed = 0, failed = 0;
async function t(name, fn) {
  try { await fn(); passed++; console.log(`ok - ${name}`); }
  catch (e) { failed++; console.error(`not ok - ${name}\n  ${e && e.message}`); }
}

(async () => {
  // #327（P0）：公共导出的 JSQL 在 disk 模式下必须真正落盘，重开能读回表与行。
  // 此前 index.js 的 JSQL 挂的是纯内存 WASM 实现，path/mode 被静默丢弃。
  await t('#327 公共 JSQL disk 模式落盘并重开读回', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsql-327-'));
    const db1 = new JSQL({ path: dir, mode: 'disk' });
    await db1.start();
    await db1.createTable('p', { name: { type: 'string' } });
    await db1.insert('p', { name: 'x' });
    await db1.stop();

    const files = fs.readdirSync(dir);
    assert.ok(files.length > 0, `落盘目录应为非空，实际 ${JSON.stringify(files)}`);

    const db2 = new JSQL({ path: dir, mode: 'disk' });
    await db2.start();
    assert.deepStrictEqual(await db2.getTables(), ['p']);
    const rows = await db2.find('p', {});
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].name, 'x');
    await db2.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // #357：RENAME COLUMN 后列 DEFAULT 必须随列迁移，新行拿到默认值而非 NULL。
  await t('#357 RENAME COLUMN 后 DEFAULT 随列迁移', async () => {
    const db = new Database(':memory:');
    await db.query("CREATE TABLE u(id INT PRIMARY KEY, name TEXT DEFAULT 'anon')", { safety: false });
    await db.query("INSERT INTO u VALUES (1,'x')", { safety: false });
    await db.query('ALTER TABLE u RENAME COLUMN name TO username', { safety: false });
    await db.query('INSERT INTO u(id) VALUES (2)', { safety: false });
    const rows = (await db.query('SELECT id,username FROM u ORDER BY id', { safety: false })).rows;
    assert.deepStrictEqual(rows, [[1, 'x'], [2, 'anon']]);
    assert.deepStrictEqual(db._tables.u._defaults, { username: 'anon' });
    await db.close();
  });

  // #359：MODIFY COLUMN 去掉 CHECK 后旧约束登记必须清除，-5 可写入；
  // 对照：仍带 CHECK 的表插入 -5 必须被拒。
  await t('#359 MODIFY COLUMN 清除旧 CHECK 后 -5 可写入', async () => {
    const db = new Database(':memory:');
    await db.query('CREATE TABLE t(id INT PRIMARY KEY, age INT CHECK (age >= 0))', { safety: false });
    await db.query('INSERT INTO t VALUES (1,10)', { safety: false });
    await db.query('ALTER TABLE t MODIFY age TEXT', { safety: false });
    assert.deepStrictEqual(db._tables.t._checkConstraints.map(c => c.field), []);
    await db.query('INSERT INTO t(id,age) VALUES (2,-5)', { safety: false });
    const rows = (await db.query('SELECT id,age FROM t ORDER BY id', { safety: false })).rows;
    assert.strictEqual(rows.length, 2);
    assert.strictEqual(Number(rows[1][1]), -5);
    await db.close();

    const db2 = new Database(':memory:');
    await db2.query('CREATE TABLE g(id INT PRIMARY KEY, v INT CHECK (v >= 0))', { safety: false });
    await assert.rejects(
      () => db2.query('INSERT INTO g VALUES (2,-5)', { safety: false }),
      /Check constraint/);
    await db2.close();
  });

  // #418：updateByIds 必须同步主键/唯一索引，并拦截 NOT NULL 与唯一冲突。
  await t('#418 updateByIds 同步索引并拦截 NULL/唯一冲突', async () => {
    const db = new Database(':memory:');
    await db.createTable('t', {
      id: { type: 'integer', primaryKey: true },
      name: { type: 'string', required: true },
    });
    await db.insert('t', { id: 1, name: 'a' });
    await db.insert('t', { id: 2, name: 'b' });

    // 批量改主键：旧键必须摘出、新键必须入索引
    await db.updateByIds('t', [[1, { id: 10, name: 'a' }]]);
    const tbl = db._tables.t;
    assert.deepStrictEqual([...tbl._pkIndex], [[2, 1], [10, 0]]);
    assert.strictEqual((await db.findById('t', 10)).name, 'a');

    // required 列写 NULL 必须被拦截（NOT NULL 校验）
    await assert.rejects(
      () => db.updateByIds('t', [[2, { name: null }]]),
      /cannot be null|NULL/i);

    // 主键改成已存在的值必须被拦截（唯一冲突）
    await assert.rejects(
      () => db.updateByIds('t', [[10, { id: 2 }]]),
      /Duplicate entry|DUP_ENTRY|UNIQUE/i);
    await db.close();
  });

  // #406：同名集合重载并重建索引后，全局编译缓存不得复用旧索引闭包，范围查询不漏行。
  await t('#406 XQL 同名集合重载后范围查询不漏行', async () => {
    xql.clearCache();
    const mk = (hiFirst) => {
      const r = [];
      for (let i = 0; i < 10; i++) r.push({ age: 5 });
      if (hiFirst) r[0] = { age: 30 }; else r[9] = { age: 30 };
      return r;
    };
    xql.load('users', mk(false));
    xql.index('users', 'age', 'range');
    const A = xql('FROM users WHERE age > 18');
    assert.strictEqual(A.length, 1);
    assert.strictEqual(A[0].age, 30);

    // 同名重载为新集合（行序反转），重建索引；全局缓存必须按索引身份区分
    xql.load('users', mk(true));
    xql.index('users', 'age', 'range');
    const B = xql('FROM users WHERE age > 18');
    assert.strictEqual(B.length, 1);
    assert.strictEqual(B[0].age, 30);
    xql.clearCache();
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
