/* ---- MySQL 进制 / 字符串 / IP / 位图工具函数 ---- */
/*
 * 差分探针发现十几个常用函数全部落到 applyScalarFunction 的 default
 * **静默返回 null** —— 调用方很容易把「没实现」误读成「值不存在」。
 * 本测试覆盖补齐后的语义与边界。
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
  const q = async (sql) => (await executeSQL(db, sql, { safety: false })).rows[0][0];

  // ---------- 进制 ----------
  ok("BIT_LENGTH('abc') = 24", await q("SELECT BIT_LENGTH('abc')") === 24, null);
  ok("BIT_LENGTH 中文按字节", await q("SELECT BIT_LENGTH('中文')") === 48, null);
  ok('BIN(10)', await q('SELECT BIN(10)') === '1010', null);
  ok('OCT(10)', await q('SELECT OCT(10)') === '12', null);
  ok('HEX(255)', await q('SELECT HEX(255)') === 'FF', null);
  ok("HEX('AB') 按字节", await q("SELECT HEX('AB')") === '4142', null);
  ok("UNHEX('4142')", await q("SELECT UNHEX('4142')") === 'AB', null);
  ok('HEX/UNHEX 往返', await q("SELECT UNHEX(HEX('hello'))") === 'hello', null);
  ok('UNHEX 奇数长度 → NULL', await q("SELECT UNHEX('ABC')") === null, null);
  ok('UNHEX 非十六进制 → NULL', await q("SELECT UNHEX('ZZ')") === null, null);
  ok("CONV('A',16,2) = 1010", await q("SELECT CONV('A', 16, 2)") === '1010', null);
  ok('CONV(1010,2,10) = 10', await q("SELECT CONV('1010', 2, 10)") === '10', null);
  ok('CONV(0) = 0', await q("SELECT CONV('0', 10, 2)") === '0', null);
  ok('CONV 非法数字 → NULL', await q("SELECT CONV('Z', 10, 2)") === null, null);
  ok('CONV 非法进制 → NULL', await q("SELECT CONV('1', 1, 2)") === null, null);

  // ---------- 字符串 ----------
  ok("QUOTE('abc')", await q("SELECT QUOTE('abc')") === "'abc'", null);
  ok('QUOTE NULL → NULL', await q('SELECT QUOTE(NULL)') === null, null);
  ok("FIND_IN_SET('b','a,b,c') = 2", await q("SELECT FIND_IN_SET('b', 'a,b,c')") === 2, null);
  ok('FIND_IN_SET 找不到 = 0', await q("SELECT FIND_IN_SET('z', 'a,b,c')") === 0, null);
  ok('FIND_IN_SET 是精确匹配（不是子串）', await q("SELECT FIND_IN_SET('a', 'ab,cd')") === 0, null);
  ok("INSERT('abcdef',2,3,'XY')", await q("SELECT INSERT('abcdef', 2, 3, 'XY')") === 'aXYef', null);
  ok('INSERT 位置越界返回原串', await q("SELECT INSERT('abc', 9, 1, 'X')") === 'abc', null);
  ok('FORMAT(1234.567,2)', await q('SELECT FORMAT(1234.567, 2)') === '1,234.57', null);
  ok('FORMAT 负数', await q('SELECT FORMAT(-1234567.5, 1)') === '-1,234,567.5', null);
  ok("CRC32('abc') 标准值", await q("SELECT CRC32('abc')") === 891568578, null);
  ok('CRC32 空串', await q("SELECT CRC32('')") === 0, null);

  // ---------- IP ----------
  ok("INET_ATON('127.0.0.1')", await q("SELECT INET_ATON('127.0.0.1')") === 2130706433, null);
  ok('INET_NTOA(2130706433)', await q('SELECT INET_NTOA(2130706433)') === '127.0.0.1', null);
  ok('INET_ATON/NTOA 往返', await q("SELECT INET_NTOA(INET_ATON('192.168.1.10'))") === '192.168.1.10', null);
  ok('INET_ATON 非法段 → NULL', await q("SELECT INET_ATON('999.1.1.1')") === null, null);

  // ---------- 位图 / 语音 ----------
  ok("MAKE_SET(5,'a','b','c') = a,c", await q("SELECT MAKE_SET(5, 'a', 'b', 'c')") === 'a,c', null);
  ok('MAKE_SET(0) 空串', await q("SELECT MAKE_SET(0, 'a', 'b')") === '', null);
  ok("EXPORT_SET(5,'Y','N',',',8)", await q("SELECT EXPORT_SET(5, 'Y', 'N', ',', 8)") === 'Y,N,Y,N,N,N,N,N', null);
  ok("SOUNDEX('Hello') = H400", await q("SELECT SOUNDEX('Hello')") === 'H400', null);
  ok('SOUNDEX 空串', await q("SELECT SOUNDEX('')") === '', null);
  ok('SOUNDEX(NULL) → NULL', await q('SELECT SOUNDEX(NULL)') === null, null);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => {
  console.log('[FAIL] unexpected exception: ' + e.stack.split('\n').slice(0, 3).join('\n'));
  process.exit(1);
});
