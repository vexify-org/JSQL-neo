/*
 * Issue #44 — 索引等值查找忽略类型归一：字符串查询值在数值列上静默返回空。
 *
 * 复现（v6.5.26）：
 *   db.find('u', { id: '5' })   -> []      （id 是 INT PRIMARY KEY，B-Tree）
 *   db.findByIds('u', ['5'])    -> []
 *   Mongo insert 的 _id 唯一性检查走同一套索引查找，也会被绕过。
 *
 * 修复：查询值先按列声明类型归一（'5' → 5），索引未命中再回落全表过滤。
 */
const path = require('path');

const ROOT = path.join(__dirname, '..');
const { Database, createMongoServer } = require(path.join(ROOT, 'index.js'));

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('[OK]  ', name); }
  else { fail++; console.log('[FAIL]', name, extra !== undefined ? '-> ' + JSON.stringify(extra).slice(0, 300) : ''); }
}

(async () => {
  try {
    const db = new Database(':memory:');
    await db.createTable('u', {
      id: 'INT PRIMARY KEY',
      name: 'TEXT',
      code: 'INT UNIQUE',
      score: 'FLOAT',
      active: 'BOOLEAN',
    });
    await db.insert('u', { id: 5, name: 'a', code: 100, score: 1.5, active: true });
    await db.insert('u', { id: 6, name: 'b', code: 200, score: 2.5, active: false });

    // --- B-Tree：UNIQUE 非主键列 ---
    const byCode = await db.find('u', { code: '100' });
    ok('#44 btree 唯一列：字符串查数值命中', byCode.length === 1 && byCode[0].id === 5, byCode);

    // --- B-Tree：主键列 + $in ---
    const byIn = await db.find('u', { id: { $in: ['5', '6'] } });
    ok('#44 btree 主键 $in：字符串列表命中', byIn.length === 2, byIn.length);

    // --- 主键 btree：findById / findByIds / updateById / removeById ---
    const byId = await db.findById('u', '5');
    ok('#44 findById("5") 命中数字主键', !!byId && byId.name === 'a', byId);

    const byIds = await db.findByIds('u', ['5', '6']);
    ok('#44 findByIds(["5","6"]) 命中', byIds.length === 2, byIds.length);

    ok('#44 updateById("6") 生效', (await db.updateById('u', '6', { name: 'bb' })) && (await db.findById('u', 6)).name === 'bb');

    // --- 其他声明类型的归一 ---
    const byFloat = await db.find('u', { score: '1.5' });
    ok('#44 float 列：字符串查数值命中', byFloat.length === 1 && byFloat[0].id === 5, byFloat);
    const byBool = await db.find('u', { active: 1 });
    ok('#44 boolean 列：1 命中 true', byBool.length === 1 && byBool[0].id === 5, byBool);
    const byText = await db.find('u', { name: 'a' });
    ok('#44 text 列：正常查询不受影响', byText.length === 1, byText.length);

    // --- hash 索引（旧版 _indexes）路径 ---
    await db.createTable('h', { v: 'INT', s: 'TEXT' });
    const ht = db._ensureTable('h');
    ht.createIndex('v');
    await db.insert('h', { v: 7, s: 'x' });
    const byHash = await db.find('h', { v: '7' });
    ok('#44 hash 索引：字符串查数值命中', byHash.length === 1 && byHash[0].v === 7, byHash);

    // --- Mongo _id 唯一性：索引不再被类型差异绕过 ---
    const srv = createMongoServer({ port: 0, noAuth: true, dataDir: ':memory:' });
    const engine = await srv._getEngine('test');
    await engine.createTable('c', { _id: { type: 'integer', unique: true }, v: { type: 'integer' } });
    const r1 = await srv._dispatch('insert', {
      insert: 'c',
      documents: [{ _id: 1, v: 10 }, { _id: '1', v: 99 }],
      $db: 'test',
    });
    const cols = await engine.find('c', {});
    ok('#44 Mongo _id 去重不被类型差异绕过',
      r1.ok === 1 && r1.n === 1 && cols.length === 1 && cols[0].v === 10,
      { r: r1, rows: cols });

    // --- 清理路径同样按类型归一 ---
    await db.removeById('u', '5');
    ok('#44 removeById("5") 删除数字主键行', (await db.find('u', { id: 5 })).length === 0);
  } catch (e) {
    fail++;
    console.log('[FAIL] unexpected exception:', e && e.stack || e);
  }

  console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed\n`);
  if (fail > 0) process.exit(1);
})();
