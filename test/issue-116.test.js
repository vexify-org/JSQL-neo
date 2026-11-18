/* ---- Issue #116：LOCATE(substr, str, pos) 必须尊重第 3 个参数 pos ---- */
/*
 * MySQL 8.0 语义（LOCATE(substr, str, pos)）：
 *   - 从位置 pos 开始（**含** pos）向右找 substr；
 *   - 返回 substr 首次出现的**绝对** 1-based 字符位置（不是相对偏移）；
 *   - 找不到返回 0；任一参数为 NULL 返回 NULL；
 *   - pos < 1 按 1 处理。
 *
 * 此前 `applyScalarFunction` 的 LOCATE 分支只把 args[0]/args[1] 交给
 * codePointIndexOf(needle, haystack)，args[2] 从未被读取 —— 三参形式
 * 静默退化成两参形式，返回一个"看起来合理"但错误的位置。
 *
 * 参考值：
 *   LOCATE('b','abcabc',1) = 2      LOCATE('bar','foobarbar',5) = 7
 *   LOCATE('b','abcabc',3) = 5      LOCATE('b','abcabc',6)     = 0
 *
 *   node test/issue-116.test.js
 */
const path = require('path');
const ROOT = path.join(__dirname, '..');
const { Database, executeSQL } = require(path.join(ROOT, 'index.js'));

let pass = 0, fail = 0;
function ok(name, cond, got) {
  if (cond) { pass++; console.log('[OK]   ' + name); }
  else { fail++; console.log('[FAIL] ' + name + ' -> ' + JSON.stringify(got)); }
}

(async () => {
  const db = new Database(':memory:', { autoSave: false });
  const q = async (sql) => {
    const r = await executeSQL(db, sql, { safety: false });
    return r.rows[0][0];
  };

  // ---------- issue 的差分表：pos 必须生效 ----------
  ok("LOCATE('b','abcabc') = 2", await q("SELECT LOCATE('b','abcabc')") === 2, await q("SELECT LOCATE('b','abcabc')"));
  ok("LOCATE('b','abcabc',1) = 2", await q("SELECT LOCATE('b','abcabc',1)") === 2, await q("SELECT LOCATE('b','abcabc',1)"));
  ok("LOCATE('b','abcabc',3) = 5", await q("SELECT LOCATE('b','abcabc',3)") === 5, await q("SELECT LOCATE('b','abcabc',3)"));
  ok("LOCATE('b','abcabc',5) = 5", await q("SELECT LOCATE('b','abcabc',5)") === 5, await q("SELECT LOCATE('b','abcabc',5)"));
  ok("LOCATE('b','abcabc',6) = 0", await q("SELECT LOCATE('b','abcabc',6)") === 0, await q("SELECT LOCATE('b','abcabc',6)"));
  ok("LOCATE('bar','foobarbar',5) = 7", await q("SELECT LOCATE('bar','foobarbar',5)") === 7, await q("SELECT LOCATE('bar','foobarbar',5)"));

  // 返回的是绝对位置，不是相对偏移（若实现成相对偏移这里会得到 2/10）
  ok("LOCATE('bar','foobarbar',4) = 4", await q("SELECT LOCATE('bar','foobarbar',4)") === 4, await q("SELECT LOCATE('bar','foobarbar',4)"));
  ok("LOCATE('bar','foobarbar',7) = 7", await q("SELECT LOCATE('bar','foobarbar',7)") === 7, await q("SELECT LOCATE('bar','foobarbar',7)"));
  ok("LOCATE('bar','foobarbar',8) = 0（剩 'ar' 不够长）", await q("SELECT LOCATE('bar','foobarbar',8)") === 0, await q("SELECT LOCATE('bar','foobarbar',8)"));

  // ---------- 边界 ----------
  ok("LOCATE('b','abcabc',0) = 2（pos<1 按 1）", await q("SELECT LOCATE('b','abcabc',0)") === 2, await q("SELECT LOCATE('b','abcabc',0)"));
  ok("LOCATE('b','abcabc',-5) = 2（pos<1 按 1）", await q("SELECT LOCATE('b','abcabc',-5)") === 2, await q("SELECT LOCATE('b','abcabc',-5)"));
  ok("LOCATE('b','abcabc',7) = 0（pos>len）", await q("SELECT LOCATE('b','abcabc',7)") === 0, await q("SELECT LOCATE('b','abcabc',7)"));
  ok("LOCATE('b','abcabc',99) = 0", await q("SELECT LOCATE('b','abcabc',99)") === 0, await q("SELECT LOCATE('b','abcabc',99)"));
  ok("LOCATE('b','abcabc',3.9) = 5（pos 取整）", await q("SELECT LOCATE('b','abcabc',3.9)") === 5, await q("SELECT LOCATE('b','abcabc',3.9)"));

  // 空子串：两参形式仍为 1（行为不变）；三参形式为 pos（MySQL 同）
  ok("LOCATE('','abc') = 1", await q("SELECT LOCATE('','abc')") === 1, await q("SELECT LOCATE('','abc')"));
  ok("LOCATE('','abc',3) = 3", await q("SELECT LOCATE('','abc',3)") === 3, await q("SELECT LOCATE('','abc',3)"));

  // ---------- NULL 传播 ----------
  ok("LOCATE(NULL,'abc',2) IS NULL", await q("SELECT LOCATE(NULL,'abc',2)") === null, await q("SELECT LOCATE(NULL,'abc',2)"));
  ok("LOCATE('b',NULL,2) IS NULL", await q("SELECT LOCATE('b',NULL,2)") === null, await q("SELECT LOCATE('b',NULL,2)"));
  ok("LOCATE('b','abcabc',NULL) IS NULL", await q("SELECT LOCATE('b','abcabc',NULL)") === null, await q("SELECT LOCATE('b','abcabc',NULL)"));

  // ---------- Unicode：pos 与返回值都按 code point 计（Issue #111 语义）----------
  // 'a🚀b🚀' = a 🚀 b 🚀   字符位置：1 2 3 4
  ok("LOCATE('b','a🚀b🚀',1) = 3", await q("SELECT LOCATE('b','a🚀b🚀',1)") === 3, await q("SELECT LOCATE('b','a🚀b🚀',1)"));
  ok("LOCATE('🚀','a🚀b🚀',2) = 2", await q("SELECT LOCATE('🚀','a🚀b🚀',2)") === 2, await q("SELECT LOCATE('🚀','a🚀b🚀',2)"));
  ok("LOCATE('🚀','a🚀b🚀',3) = 4", await q("SELECT LOCATE('🚀','a🚀b🚀',3)") === 4, await q("SELECT LOCATE('🚀','a🚀b🚀',3)"));
  ok("LOCATE('🚀','a🚀b🚀',5) = 0", await q("SELECT LOCATE('🚀','a🚀b🚀',5)") === 0, await q("SELECT LOCATE('🚀','a🚀b🚀',5)"));

  // ---------- 两参形式与 INSTR 不受影响 ----------
  ok("LOCATE('bar','foobarbar') = 4", await q("SELECT LOCATE('bar','foobarbar')") === 4, await q("SELECT LOCATE('bar','foobarbar')"));
  ok("INSTR('abcabc','b') = 2", await q("SELECT INSTR('abcabc','b')") === 2, await q("SELECT INSTR('abcabc','b')"));
  ok("INSTR('foobarbar','bar') = 4", await q("SELECT INSTR('foobarbar','bar')") === 4, await q("SELECT INSTR('foobarbar','bar')"));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => {
  console.log('[FAIL] unexpected exception: ' + e.stack.split('\n').slice(0, 3).join('\n'));
  process.exit(1);
});
