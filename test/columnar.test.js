/* ---- 一键转换列存：正确性回归 ---- */
/*
 * 列存是「行存的派生缓存」：_rows 仍是权威数据，任何写入都会让列存失效
 * （回到行存读取路径）。所以这里重点钉两件事：
 *   1. 转换后所有查询结果与行存完全一致（含 SELECT *、聚合、WHERE、ORDER BY）；
 *   2. 转换后写入不会读到旧值（失效逻辑真的生效）。
 */
const path = require('path');
const ROOT = path.join(__dirname, '..');
const { Database } = require(path.join(ROOT, 'index.js'));

let pass = 0, fail = 0;
function ok(name, cond, got) {
  if (cond) { pass++; console.log('[OK]   ' + name); }
  else { fail++; console.log('[FAIL] ' + name + ' -> ' + JSON.stringify(got)); }
}

(async () => {
  const db = new Database(':memory:', { autoSave: false });
  await db.createTable('t', {
    id: { type: 'integer', primaryKey: true, autoIncrement: true },
    name: { type: 'string' },
    age: { type: 'integer' },
  });
  const rows = [];
  for (let i = 0; i < 2000; i++) rows.push({ name: 'n' + i, age: 20 + (i % 50) });
  for (let i = 0; i < rows.length; i += 200) await db.insert('t', rows.slice(i, i + 200));

  const snapshot = async () => ({
    all: (await db.query('SELECT id, name, age FROM t')).rows,
    one: (await db.query('SELECT id FROM t LIMIT 3')).rows,
    star: (await db.query('SELECT * FROM t LIMIT 5')).rows,
    agg: (await db.query('SELECT COUNT(*) AS c, SUM(age) AS s FROM t')).rows,
    where: (await db.query('SELECT id FROM t WHERE age > 60 ORDER BY id DESC LIMIT 4')).rows,
    grp: (await db.query('SELECT age, COUNT(*) AS c FROM t GROUP BY age ORDER BY age LIMIT 3')).rows,
    dis: (await db.query('SELECT DISTINCT age FROM t ORDER BY age LIMIT 3')).rows,
  });

  const before = await snapshot();
  const st = db.convertToColumnar('t');
  ok('转换返回列数', st && st.engine === 'columnar' && st.rows === 2000 && st.columns === 3, st);
  ok('isColumnar() 为真', db._tables.t.isColumnar() === true, null);

  const after = await snapshot();
  for (const key of Object.keys(before)) {
    ok('转换后结果一致：' + key, JSON.stringify(before[key]) === JSON.stringify(after[key]),
      { before: before[key] && before[key].length, after: after[key] && after[key].length });
  }

  // ---------- 写入必须让列存失效，不能读到旧值 ----------
  await db.insert('t', { name: 'new', age: 99 });
  ok('插入后列存失效', db._tables.t.isColumnar() === false, null);
  const cnt = await db.query('SELECT COUNT(*) AS c FROM t');
  ok('插入后行数正确（未读旧快照）', cnt.rows[0][0] === 2001, cnt.rows);

  db.convertToColumnar('t');
  await db.update('t', { id: 1 }, { age: 123 });
  ok('更新后列存失效', db._tables.t.isColumnar() === false, null);
  const up = await db.query('SELECT age FROM t WHERE id = 1');
  ok('更新后读到新值', up.rows[0][0] === 123, up.rows);

  db.convertToColumnar('t');
  await db.delete('t', { id: 2 });
  ok('删除后列存失效', db._tables.t.isColumnar() === false, null);
  ok('删除后行数正确',
    (await db.query('SELECT COUNT(*) AS c FROM t')).rows[0][0] === 2000, null);

  // ---------- 转回行存 ----------
  db.convertToColumnar('t');
  const back = db.convertToRow('t');
  ok('toRow 报告原状态', back && back.engine === 'row' && back.wasColumnar === true, back);
  ok('转回后不再列存', db._tables.t.isColumnar() === false, null);
  ok('转回后查询仍正确',
    (await db.query('SELECT COUNT(*) AS c FROM t')).rows[0][0] === 2000, null);

  // ---------- 未转列存时行为不变 ----------
  const plain = new Database(':memory:', { autoSave: false });
  await plain.createTable('t', { id: { type: 'integer', primaryKey: true, autoIncrement: true }, v: { type: 'integer' } });
  await plain.insert('t', [{ v: 1 }, { v: 2 }]);
  ok('普通表 isColumnar() 为假', plain._tables.t.isColumnar() === false, null);
  ok('普通表查询正常', (await plain.query('SELECT v FROM t')).rows.length === 2, null);
  ok('对不存在的表转换会报错', (() => {
    try { plain.convertToColumnar('nope'); return false; } catch (e) { return /exist|no such/i.test(e.message); }
  })(), null);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => {
  console.log('[FAIL] unexpected exception: ' + e.stack.split('\n').slice(0, 3).join('\n'));
  process.exit(1);
});
