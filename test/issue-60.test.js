/*
 * Issue #60 — 集合运算不校验等列数（静默截断）+ 括号化集合查询被拒。
 *
 * 1) UNION / INTERSECT / EXCEPT 两侧列数不一致时必须显式报错（MySQL 1222），
 *    而不是按左分支静默丢弃右侧多出的列。
 * 2) 集合运算的操作数允许括号化：(SELECT ...) UNION (SELECT ...)。
 *    括号内自带的 ORDER BY / LIMIT / OFFSET 只作用于该操作数；
 *    括号外的尾部子句作用于整个组合查询。
 */
const path = require('path');
const ROOT = path.join(__dirname, '..');
const { Database } = require(path.join(ROOT, 'index.js'));
const { executeSQL } = require(path.join(ROOT, 'lib', 'sql.js'));

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('[OK]  ', name); }
  else { fail++; console.log('[FAIL]', name, extra !== undefined ? '-> ' + JSON.stringify(extra).slice(0, 400) : ''); }
}
const j = (rows) => JSON.stringify(rows);

async function expectErr(q, sql, needle) {
  try {
    await q(sql);
    return { ok: false, reason: 'no error thrown' };
  } catch (e) {
    const msg = String(e && e.message);
    return { ok: msg.includes(needle), reason: msg, code: e && e.code };
  }
}

(async () => {
  const db = new Database(':memory:');
  const q = (sql) => executeSQL(db, sql, { safety: false });

  await q('CREATE TABLE t (id INT PRIMARY KEY, v INT, s TEXT)');
  await q("INSERT INTO t VALUES (1, 10, 'a'), (2, 20, 'b')");

  // ---- 列数校验 ----
  const wsp = 'The used SELECT statements have a different number of columns';
  let e = await expectErr(q, 'SELECT id FROM t UNION SELECT id, s FROM t', wsp);
  ok('#60 UNION 列数不同报错', e.ok, e.reason);

  e = await expectErr(q, 'SELECT id FROM t UNION ALL SELECT id, s FROM t', wsp);
  ok('#60 UNION ALL 列数不同报错', e.ok, e.reason);

  e = await expectErr(q, 'SELECT id FROM t INTERSECT SELECT id, s FROM t', wsp);
  ok('#60 INTERSECT 列数不同报错', e.ok, e.reason);

  e = await expectErr(q, 'SELECT id FROM t EXCEPT SELECT id, s FROM t', wsp);
  ok('#60 EXCEPT 列数不同报错', e.ok, e.reason);

  let r = await q('SELECT id FROM t UNION SELECT v FROM t');
  ok('#60 等列数 UNION 正常', j(r.rows) === j([[1], [2], [10], [20]]), r.rows);

  r = await q('SELECT id FROM t UNION SELECT id FROM t');
  ok('#60 同列数单列 UNION 正常', j(r.rows) === j([[1], [2]]), r.rows);

  // ---- 括号化操作数 ----
  r = await q('(SELECT id FROM t) UNION (SELECT id FROM t)');
  ok('#60 (SELECT) UNION (SELECT) 可解析', j(r.rows) === j([[1], [2]]), r.rows);

  r = await q('(SELECT id FROM t WHERE id = 1) UNION ALL (SELECT id FROM t WHERE id = 2)');
  ok('#60 括号化 UNION ALL', j(r.rows) === j([[1], [2]]), r.rows);

  r = await q('SELECT id FROM t UNION (SELECT id FROM t)');
  ok('#60 右侧括号化操作数', j(r.rows) === j([[1], [2]]), r.rows);

  r = await q('(SELECT id FROM t) INTERSECT (SELECT id FROM t WHERE id = 2)');
  ok('#60 括号化 INTERSECT', j(r.rows) === j([[2]]), r.rows);

  r = await q('(SELECT id FROM t) EXCEPT (SELECT id FROM t WHERE id = 1)');
  ok('#60 括号化 EXCEPT', j(r.rows) === j([[2]]), r.rows);

  // 括号外尾部 ORDER BY / LIMIT 作用于整体
  r = await q('(SELECT id FROM t) UNION (SELECT id FROM t) ORDER BY id DESC LIMIT 1');
  ok('#60 括号化组合 + 尾部 ORDER BY/LIMIT', j(r.rows) === j([[2]]), r.rows);

  // 括号内 ORDER BY / LIMIT 只作用于该操作数
  r = await q('(SELECT id FROM t ORDER BY id DESC LIMIT 1) UNION (SELECT id FROM t ORDER BY id ASC LIMIT 1)');
  ok('#60 括号内 LIMIT 局部生效', j(r.rows) === j([[2], [1]]), r.rows);

  r = await q('(SELECT id FROM t ORDER BY id DESC LIMIT 1) UNION ALL (SELECT id FROM t LIMIT 1)');
  ok('#60 UNION ALL 保留括号内局部 LIMIT', j(r.rows) === j([[2], [1]]), r.rows);

  // 括号化操作数也参与列数校验
  e = await expectErr(q, '(SELECT id FROM t) UNION (SELECT id, s FROM t)', wsp);
  ok('#60 括号化操作数列数不同报错', e.ok, e.reason);

  console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed\n`);
  if (fail > 0) process.exit(1);
})();
