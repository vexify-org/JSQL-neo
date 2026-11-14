/** #92 applyParams 混用 ?N 与 ? 时绑定错位 / 误报参数过多 */
const { executeSQL } = require('../lib/sql');
const Database = require('../lib/database');
(async () => {
  const db = new Database(':memory:'); const q = (s, v) => executeSQL(db, s, { params: v, safety: false });
  let p = 0, f = 0; const ok = (n, c, g) => { if (c) p++; else { f++; console.log('[FAIL]', n, '->', JSON.stringify(g)); } };
  const eq = async (name, sql, params, want) => {
    try { const r = (await q(sql, params)).rows; ok(name, JSON.stringify(r) === JSON.stringify(want), r); }
    catch (e) { ok(name + ' (异常: ' + e.message + ')', false); }
  };
  const throws = async (name, sql, params) => {
    try { await q(sql, params); ok(name + ' 应抛错', false); } catch (e) { ok(name, /Too many|Not enough/.test(e.message), e.message); }
  };
  await q('CREATE TABLE t (id INT PRIMARY KEY, a INT, b INT)');
  await q('INSERT INTO t VALUES (1,10,20),(2,30,40)');
  // 纯匿名（回归）
  await eq('纯匿名 ? ?,?', 'SELECT a FROM t WHERE a=? AND b=?', [10, 20], [[10]]);
  // 编号在前
  await eq('#92 ?2 在前、? 在后', 'SELECT a FROM t WHERE b=?2 AND a=?', [10, 20], [[10]]);
  // 编号在后
  await eq('#92 ? 在前、?2 在后', 'SELECT a FROM t WHERE a=? AND b=?2', [10, 20], [[10]]);
  // 编号引入顺序颠倒且值不同 → 能区分
  await eq('#92 顺序敏感校验', 'SELECT a FROM t WHERE b=?2 AND a=?', [20, 10], []);
  // 反向：编号重复引用
  await eq('#92 编号重复引用', 'SELECT a FROM t WHERE a=?1 AND b=?1', [10], []);
  await eq('#92 ?1 与 ?2', 'SELECT a FROM t WHERE a=?1 AND b=?2', [10, 20], [[10]]);
  // PG $N 与 ? 混用
  await eq('#92 $2 在前、? 在后', 'SELECT a FROM t WHERE b=$2 AND a=?', [10, 20], [[10]]);
  // 真正参数过多仍报错
  await throws('#92 参数过多仍报错', 'SELECT a FROM t WHERE a=?', [10, 20]);
  await throws('#92 参数不足仍报错', 'SELECT a FROM t WHERE a=? AND b=?', [10]);
  // ?? 标识符转义不回归
  await eq('?? 标识符', 'SELECT ?? FROM t WHERE a=?', ['a', 30], [[30]]);
  console.log(`\napply-params: ${p} passed, ${f} failed`); db.stop(); process.exit(f ? 1 : 0);
})();
