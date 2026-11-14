/**
 * #86 / #99：ON DUPLICATE KEY UPDATE
 *   #86  赋值右侧含 VALUES() 的表达式（VALUES(a)+1）把列写成 NULL（数据损坏）
 *   #99  裸列名赋值（other = other）抛 1292（合法 upsert 崩溃）
 *
 * 共同根因：parseValueAtom() 把裸标识符解析成普通 JS 字符串，与真正的字符串
 * 字面量无法区分；同时冲突处理循环只在「顶层节点」识别 VALUES()/EXCLUDED，
 * 一旦嵌套进 binary 节点就求值失败（undefined + 1 → NULL）。
 *
 *   node test/upsert-values-and-bare-column.test.js
 */
const { executeSQL } = require('../lib/sql');
const Database = require('../lib/database');

let passed = 0, failed = 0;
function ok(name, cond, got) {
  if (cond) passed++;
  else { failed++; console.log('[FAIL]', name, got !== undefined ? '-> ' + JSON.stringify(got) : ''); }
}

(async () => {
  const db = new Database(':memory:');
  const q = async (s) => executeSQL(db, s, { safety: false });
  const one = async (s, col) => (await q(s)).rows[0][col || 0];

  await q('CREATE TABLE t (id INT PRIMARY KEY, a INT, b INT, cnt INT, other INT, s TEXT)');
  await q('INSERT INTO t (id,a,b,cnt,other) VALUES (1,10,3,5,7)');

  // ---------- #86：表达式中的 VALUES()
  await q('INSERT INTO t (id,a,b) VALUES (1,100,200) ON DUPLICATE KEY UPDATE a=VALUES(a)+1, b=VALUES(b)');
  let r = (await q('SELECT a,b FROM t WHERE id=1')).rows[0];
  ok('#86 VALUES(a)+1 → 101', r[0] === 101, r);
  ok('#86 纯 VALUES(b) → 200 不受影响', r[1] === 200, r);

  await q('INSERT INTO t (id,cnt) VALUES (1,10) ON DUPLICATE KEY UPDATE cnt=VALUES(cnt)+32');
  ok('#86 VALUES(cnt)+32 → 42', await one('SELECT cnt FROM t WHERE id=1') === 42);

  // ---------- #99：裸列名赋值（先固定 cnt=5、other=7，不依赖前面用例的中间状态）
  await q('INSERT INTO t (id,cnt,other) VALUES (1,5,7) ON DUPLICATE KEY UPDATE cnt=5, other=7');
  await q('INSERT INTO t (id,cnt,other) VALUES (1,5,7) ON DUPLICATE KEY UPDATE cnt=cnt+1, other=other');
  r = (await q('SELECT cnt,other FROM t WHERE id=1')).rows[0];
  ok('#99 cnt=cnt+1 用旧值 → 6', r[0] === 6, r);
  ok('#99 other=other 是 no-op → 7（不再抛 1292）', r[1] === 7, r);

  // 裸列名 + 字面量混合
  await q('INSERT INTO t (id,a,other) VALUES (1,0,0) ON DUPLICATE KEY UPDATE a=other');
  ok('裸列名作为取值来源 a=other', await one('SELECT a FROM t WHERE id=1') === 7);

  // 裸列名参与表达式（单层，与 #86 同一求值路径）
  await q('INSERT INTO t (id,other) VALUES (1,0) ON DUPLICATE KEY UPDATE a=other+1');
  ok('裸列名参与表达式 other+1', await one('SELECT a FROM t WHERE id=1') === 8);

  // ---------- 回归：字符串字面量不能被当成列名
  await q("INSERT INTO t (id,s) VALUES (1,'x') ON DUPLICATE KEY UPDATE s='literal'");
  ok('字符串字面量仍按字面量处理', await one('SELECT s FROM t WHERE id=1') === 'literal');
  await q("INSERT INTO t (id,s) VALUES (1,'x') ON DUPLICATE KEY UPDATE s=s");
  ok('字符串列上裸列名 no-op', await one('SELECT s FROM t WHERE id=1') === 'literal');

  // 纯 VALUES / 纯字面量（原有能力不得回归）
  await q('INSERT INTO t (id,a) VALUES (1,55) ON DUPLICATE KEY UPDATE a=VALUES(a)');
  ok('回归：纯 VALUES(col)', await one('SELECT a FROM t WHERE id=1') === 55);
  await q('INSERT INTO t (id,a) VALUES (1,1) ON DUPLICATE KEY UPDATE a=999');
  ok('回归：纯字面量', await one('SELECT a FROM t WHERE id=1') === 999);

  // ---------- PG 风格 ON CONFLICT ... EXCLUDED
  await q('INSERT INTO t (id,a) VALUES (1,1) ON CONFLICT (id) DO UPDATE SET a = EXCLUDED.a + 5');
  ok('PG EXCLUDED.a + 5 → 6', await one('SELECT a FROM t WHERE id=1') === 6);
  await q('INSERT INTO t (id,a) VALUES (1,20) ON CONFLICT (id) DO UPDATE SET a = EXCLUDED.a');
  ok('PG 纯 EXCLUDED.a', await one('SELECT a FROM t WHERE id=1') === 20);

  // ---------- 非冲突路径不受影响
  await q('INSERT INTO t (id,a) VALUES (2, 1) ON DUPLICATE KEY UPDATE a=VALUES(a)+1');
  ok('无冲突时正常插入', await one('SELECT a FROM t WHERE id=2') === 1);

  // ---------- 类型校验仍然生效（INT 列写字符串应报 1292）
  let threw = false;
  try { await q("INSERT INTO t (id,a) VALUES (1,1) ON DUPLICATE KEY UPDATE a='not a number'"); }
  catch (e) { threw = /1292|incorrect integer/.test(e.message); }
  ok('INT 列写入真字符串仍报 1292（类型校验未被削弱）', threw);

  console.log(`\nupsert: ${passed} passed, ${failed} failed`);
  db.stop();
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
