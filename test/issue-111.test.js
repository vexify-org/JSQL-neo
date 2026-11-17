/* ---- Issue #111：字符串函数必须按 Unicode code point 语义 ---- */
/*
 * JS 的 String#length / slice / substr / split('') / indexOf 都是 UTF-16 code unit
 * 语义，会把增补平面字符（emoji 🚀 U+1F680、生僻汉字 𡋾 U+212FE）劈成孤立代理项。
 * MySQL 按字符（code point）计数/定位/截取。这里钉死相关函数的正确行为，
 * 并确认 LENGTH() 仍按 UTF-8 字节计（4 字节，不能被顺手改坏）。
 *
 *   node test/issue-111.test.js
 */
const path = require('path');
const ROOT = path.join(__dirname, '..');
const { Database, executeSQL } = require(path.join(ROOT, 'index.js'));

let pass = 0, fail = 0;
function ok(name, cond, got) {
  if (cond) { pass++; console.log('[OK]   ' + name); }
  else { fail++; console.log('[FAIL] ' + name + ' -> ' + JSON.stringify(got)); }
}
// 是否包含孤立（未配对）代理项
function hasLoneSurrogate(s) {
  if (typeof s !== 'string') return false;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xD800 && c <= 0xDBFF) {
      const n = s.charCodeAt(i + 1);
      if (!(n >= 0xDC00 && n <= 0xDFFF)) return true;
      i++;
    } else if (c >= 0xDC00 && c <= 0xDFFF) {
      return true;
    }
  }
  return false;
}

(async () => {
  const db = new Database(':memory:', { autoSave: false });
  const q = async (sql) => {
    const r = await executeSQL(db, sql, { safety: false });
    return r.rows[0][0];
  };

  // ---------- CHAR_LENGTH / CHARACTER_LENGTH ----------
  ok("CHAR_LENGTH('🚀') = 1", await q("SELECT CHAR_LENGTH('🚀')") === 1, await q("SELECT CHAR_LENGTH('🚀')"));
  ok("CHAR_LENGTH('a🚀b') = 3", await q("SELECT CHAR_LENGTH('a🚀b')") === 3, await q("SELECT CHAR_LENGTH('a🚀b')"));
  ok("CHARACTER_LENGTH('a🚀b') = 3",
    await q("SELECT CHARACTER_LENGTH('a🚀b')") === 3, await q("SELECT CHARACTER_LENGTH('a🚀b')"));
  ok("CHAR_LENGTH('𡋾') = 1", await q("SELECT CHAR_LENGTH('𡋾')") === 1, await q("SELECT CHAR_LENGTH('𡋾')"));

  // ---------- LENGTH 保持字节语义 ----------
  ok("LENGTH('🚀') = 4（字节，不应改变）", await q("SELECT LENGTH('🚀')") === 4, await q("SELECT LENGTH('🚀')"));
  ok("LENGTH('a🚀b') = 6", await q("SELECT LENGTH('a🚀b')") === 6, await q("SELECT LENGTH('a🚀b')"));

  // ---------- LEFT / RIGHT ----------
  const left1 = await q("SELECT LEFT('🚀ab',1)");
  ok("LEFT('🚀ab',1) = '🚀'", left1 === '🚀', left1);
  ok("LEFT('🚀ab',1) 无孤立代理项", !hasLoneSurrogate(left1), left1);

  const right1 = await q("SELECT RIGHT('ab🚀',1)");
  ok("RIGHT('ab🚀',1) = '🚀'", right1 === '🚀', right1);
  ok("RIGHT('ab🚀',1) 无孤立代理项", !hasLoneSurrogate(right1), right1);

  ok("LEFT('𡋾xy',1) = '𡋾'", await q("SELECT LEFT('𡋾xy',1)") === '𡋾', await q("SELECT LEFT('𡋾xy',1)"));
  ok("RIGHT('xy𡋾',1) = '𡋾'", await q("SELECT RIGHT('xy𡋾',1)") === '𡋾', await q("SELECT RIGHT('xy𡋾',1)"));
  ok("LEFT('abcdef',3) = 'abc'（ASCII 不受影响）", await q("SELECT LEFT('abcdef',3)") === 'abc', null);
  ok("RIGHT('abcdef',3) = 'def'", await q("SELECT RIGHT('abcdef',3)") === 'def', null);

  // ---------- SUBSTRING / SUBSTR ----------
  const sub1 = await q("SELECT SUBSTRING('🚀ab',1,1)");
  ok("SUBSTRING('🚀ab',1,1) = '🚀'", sub1 === '🚀', sub1);
  ok("SUBSTRING 结果无孤立代理项", !hasLoneSurrogate(sub1), sub1);
  ok("SUBSTR('a🚀b',2,1) = '🚀'", await q("SELECT SUBSTR('a🚀b',2,1)") === '🚀', await q("SELECT SUBSTR('a🚀b',2,1)"));
  ok("SUBSTRING('a🚀b',2) = '🚀b'", await q("SELECT SUBSTRING('a🚀b',2)") === '🚀b', await q("SELECT SUBSTRING('a🚀b',2)"));
  ok("SUBSTRING('abcdef',2,3) = 'bcd'", await q("SELECT SUBSTRING('abcdef',2,3)") === 'bcd', null);
  ok("SUBSTRING('abcdef',-2) = 'ef'", await q("SELECT SUBSTRING('abcdef',-2)") === 'ef', null);

  // ---------- REVERSE ----------
  const rev = await q("SELECT REVERSE('a🚀b')");
  ok("REVERSE('a🚀b') = 'b🚀a'", rev === 'b🚀a', rev);
  ok("REVERSE 结果无孤立代理项", !hasLoneSurrogate(rev), rev);
  ok("REVERSE('a𡋾b') = 'b𡋾a'", await q("SELECT REVERSE('a𡋾b')") === 'b𡋾a', await q("SELECT REVERSE('a𡋾b')"));

  // ---------- LOCATE / INSTR ----------
  ok("LOCATE('b','🚀ab') = 3", await q("SELECT LOCATE('b','🚀ab')") === 3, await q("SELECT LOCATE('b','🚀ab')"));
  ok("INSTR('🚀ab','b') = 3", await q("SELECT INSTR('🚀ab','b')") === 3, await q("SELECT INSTR('🚀ab','b')"));
  ok("LOCATE('🚀','a🚀b') = 2", await q("SELECT LOCATE('🚀','a🚀b')") === 2, await q("SELECT LOCATE('🚀','a🚀b')"));
  ok("LOCATE('b','𡋾ab') = 3", await q("SELECT LOCATE('b','𡋾ab')") === 3, await q("SELECT LOCATE('b','𡋾ab')"));
  ok("LOCATE 未命中返回 0", await q("SELECT LOCATE('z','abc')") === 0, await q("SELECT LOCATE('z','abc')"));
  ok("INSTR('abc','') = 1", await q("SELECT INSTR('abc','')") === 1, null);

  // ---------- LPAD / RPAD ----------
  const lp = await q("SELECT LPAD('🚀',3,'x')");
  ok("LPAD('🚀',3,'x') = 'xx🚀'", lp === 'xx🚀', lp);
  ok("LPAD 结果无孤立代理项", !hasLoneSurrogate(lp), lp);
  ok("RPAD('🚀',3,'x') = '🚀xx'", await q("SELECT RPAD('🚀',3,'x')") === '🚀xx', await q("SELECT RPAD('🚀',3,'x')"));
  // 截断路径也按字符
  ok("LPAD('🚀abc',2,'x') = '🚀a'", await q("SELECT LPAD('🚀abc',2,'x')") === '🚀a', await q("SELECT LPAD('🚀abc',2,'x')"));
  ok("RPAD('🚀abc',2,'x') = '🚀a'", await q("SELECT RPAD('🚀abc',2,'x')") === '🚀a', await q("SELECT RPAD('🚀abc',2,'x')"));
  // ASCII 行为不变
  ok("LPAD('hi',5,'ab') = 'abahi'", await q("SELECT LPAD('hi',5,'ab')") === 'abahi', null);
  ok("RPAD('hi',5,'ab') = 'hiaba'", await q("SELECT RPAD('hi',5,'ab')") === 'hiaba', null);

  // ---------- 多字节但 BMP 内（不涉及代理对）行为不变 ----------
  ok("CHAR_LENGTH('héllo') = 5", await q("SELECT CHAR_LENGTH('héllo')") === 5, await q("SELECT CHAR_LENGTH('héllo')"));
  ok("LENGTH('héllo') = 6", await q("SELECT LENGTH('héllo')") === 6, await q("SELECT LENGTH('héllo')"));
  ok("REVERSE('héllo') = 'olléh'", await q("SELECT REVERSE('héllo')") === 'olléh', await q("SELECT REVERSE('héllo')"));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => {
  console.log('[FAIL] unexpected exception: ' + e.stack.split('\n').slice(0, 3).join('\n'));
  process.exit(1);
});
