/*
 * Regression tests for #334 #340 #345.
 */
const path = require('path');
const ROOT = path.join(__dirname, '..');
const { Database } = require(path.join(ROOT, 'index.js'));

let passed = 0, failed = 0;
function ok(name, cond, extra) {
  if (cond) { passed++; console.log('[OK]', name); }
  else { failed++; console.log('[FAIL]', name, extra !== undefined ? '→ ' + JSON.stringify(extra) : ''); }
}

(async () => {
  const db = new Database(':memory:');
  const q = async (sql) => { try { return await db.query(sql, { safety: false }); } catch (e) { return { err: e.message }; } };

  // #340 未闭合块注释必须显式报错
  {
    const r = await q('SELECT 1 /* 没有结束');
    ok('#340 未闭合块注释报错', !!r.err && /Unterminated block comment/.test(r.err), r.err);
    const ok2 = await q('SELECT 1 /* 正常 */');
    ok('#340 正常块注释不受影响', !ok2.err && JSON.stringify(ok2.rows) === '[[1]]', ok2.err || ok2.rows);
  }

  // #345 纯注释语句与纯空白一致：空结果、不抛错
  {
    for (const sql of ['/* x */', '-- y', '# z', '   ']) {
      const r = await q(sql);
      const rows = Array.isArray(r) ? [] : r.rows;
      ok(`#345 ${JSON.stringify(sql)} 返回空结果且不抛错`,
        !r.err && (rows === undefined || (Array.isArray(rows) && rows.length === 0)), r.err || r);
    }
  }

  // #334 count(table, filter)
  {
    await q('CREATE TABLE c (id INT PRIMARY KEY, v INT)');
    for (const row of [{ id: 1, v: 1 }, { id: 2, v: 1 }, { id: 3, v: 2 }]) await db.insert('c', row);
    ok('#334 count 全表', (await db.count('c')) === 3, await db.count('c'));
    ok('#334 count 带过滤条件', (await db.count('c', { v: 1 })) === 2, await db.count('c', { v: 1 }));
    ok('#334 count 空过滤等价全表', (await db.count('c', {})) === 3, await db.count('c', {}));
    ok('#334 count 无匹配为 0', (await db.count('c', { v: 99 })) === 0, await db.count('c', { v: 99 }));
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  await db.close();
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
