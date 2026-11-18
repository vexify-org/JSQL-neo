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

  // ---------- 位移运算符（Issue #109）----------
  // MySQL：移位量只取整数部分（trunc），操作数按 64 位无符号整数处理，
  // 结果超过 2^53 时保留精确值（以字符串输出，与 #38 的大整数约定一致）。
  ok('#109 1 << 1.9 = 2', await q('SELECT 1 << 1.9') === 2, null);
  ok('#109 1 << 1.5 = 2', await q('SELECT 1 << 1.5') === 2, null);
  ok('#109 1 << 2.9 = 4', await q('SELECT 1 << 2.9') === 4, null);
  ok('#109 8 >> 1.9 = 4', await q('SELECT 8 >> 1.9') === 4, null);
  ok('#109 7 >> 1.5 = 3', await q('SELECT 7 >> 1.5') === 3, null);
  ok('#109 1 << 0.9 = 1', await q('SELECT 1 << 0.9') === 1, null);
  ok('#109 1 << 0 = 1', await q('SELECT 1 << 0') === 1, null);
  ok('#109 1 << 8 = 256（普通值仍是 number）', await q('SELECT 1 << 8') === 256, null);
  ok('#109 1 << 31 = 2147483648（不按 32 位截断）', await q('SELECT 1 << 31') === 2147483648, null);
  ok('#109 1 << 63 精确', String(await q('SELECT 1 << 63')) === '9223372036854775808', null);
  ok('#109 1 << 62 精确', String(await q('SELECT 1 << 62')) === '4611686018427387904', null);
  ok('#109 1 << 64 按 64 位回绕为 0', await q('SELECT 1 << 64') === 0, null);
  ok('#109 8 >> 64 = 0', await q('SELECT 8 >> 64') === 0, null);
  ok('#109 负移位量 → 0', await q('SELECT 1 << -1') === 0, null);
  ok('#109 18446744073709551615 >> 1 精确',
    String(await q('SELECT 18446744073709551615 >> 1')) === '9223372036854775807', null);
  ok('#109 负数按无符号 64 位解释（-1 << 1）',
    String(await q('SELECT -1 << 1')) === '18446744073709551614', null);
  ok('#109 负数右移按无符号（-8 >> 1）',
    String(await q('SELECT -8 >> 1')) === '9223372036854775804', null);
  ok('#109 小数操作数四舍五入（1.9 << 1 = 4）', await q('SELECT 1.9 << 1') === 4, null);
  ok('#109 移位结果可继续参与运算（1 << 4 + 1）', await q('SELECT (1 << 4) + 1') === 17, null);

  // ---------- UNHEX / HEX 字节往返（Issue #108）----------
  ok("#108 HEX(UNHEX('DEADBEEF')) 往返", await q("SELECT HEX(UNHEX('DEADBEEF'))") === 'DEADBEEF', null);
  ok("#108 LENGTH(UNHEX('DEADBEEF')) = 4", await q("SELECT LENGTH(UNHEX('DEADBEEF'))") === 4, null);
  ok("#108 BIT_LENGTH(UNHEX('DEADBEEF')) = 32", await q("SELECT BIT_LENGTH(UNHEX('DEADBEEF'))") === 32, null);
  ok("#108 HEX(UNHEX('80')) 不被 UTF-8 放大", await q("SELECT HEX(UNHEX('80'))") === '80', null);
  ok("#108 HEX(UNHEX('FF'))", await q("SELECT HEX(UNHEX('FF'))") === 'FF', null);
  ok("#108 LENGTH(UNHEX('80')) = 1", await q("SELECT LENGTH(UNHEX('80'))") === 1, null);
  ok("#108 含 0x00 的二进制串", await q("SELECT HEX(UNHEX('00FF00'))") === '00FF00', null);
  ok("#108 空串往返", await q("SELECT HEX(UNHEX(''))") === '', null);
  {
    const allBytes = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0')).join('').toUpperCase();
    ok('#108 0x00-0xFF 全字节 HEX 往返恒等',
      await q(`SELECT HEX(UNHEX('${allBytes}'))`) === allBytes, null);
    ok('#108 全字节 LENGTH = 256', await q(`SELECT LENGTH(UNHEX('${allBytes}'))`) === 256, null);
    ok('#108 全字节 BIT_LENGTH = 2048', await q(`SELECT BIT_LENGTH(UNHEX('${allBytes}'))`) === 2048, null);
    ok('#108 全字节 CHAR_LENGTH = 256', await q(`SELECT CHAR_LENGTH(UNHEX('${allBytes}'))`) === 256, null);
  }
  ok('#108 二进制串与文本可比较', await q("SELECT UNHEX('4142') = 'AB'") === 1, null);
  ok('#108 二进制串可 CONCAT', await q("SELECT CONCAT(UNHEX('4142'), 'c')") === 'ABc', null);
  ok('#108 对 HEX 结果再取长度', await q("SELECT LENGTH(HEX(UNHEX('DEADBEEF')))") === 8, null);
  ok('#108 文本 HEX 仍按 UTF-8 字节', await q("SELECT HEX('中文')") === 'E4B8ADE69687', null);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => {
  console.log('[FAIL] unexpected exception: ' + e.stack.split('\n').slice(0, 3).join('\n'));
  process.exit(1);
});
