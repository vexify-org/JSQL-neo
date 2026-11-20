/* 回归测试：issue #118 #119 #125 #129 #130 #131 #132 #133 #134 #135 #136 */
const path = require('path');
const ROOT = path.join(__dirname, '..');
const { executeSQL, tokenize } = require(path.join(ROOT, 'lib', 'sql.js'));

let pass = 0, fail = 0;
function ok(name, cond, got) {
  if (cond) { pass++; console.log('[OK]   ' + name); }
  else { fail++; console.log('[FAIL] ' + name + ' -> ' + JSON.stringify(got)); }
}

const engine = {
  hasTable: () => true,
  truncate: async () => {},
  flush: async () => {},
  find: async () => [],
  getTableSchema: async () => ({}),
};
async function q(sql) {
  const r = await executeSQL(engine, sql, { safety: false });
  return r.rows[0][0];
}

(async () => {
  // #118: 0b 二进制整数字面量
  const toks = tokenize('0b1010');
  ok('#118 tokenize 0b1010 为单个 number token', toks[0].type === 'number' && toks[0].value === 10 && toks[1].type === 'eof', toks);
  ok('#118 SELECT 0b1010', await q('SELECT 0b1010') === 10);
  ok('#118 SELECT 0b1111', await q('SELECT 0b1111') === 15);
  ok('#118 SELECT 0b1010+0', await q('SELECT 0b1010+0') === 10);

  // #119: BINARY / CAST AS BINARY 让 LIKE / REGEXP 大小写敏感
  ok('#119 BINARY = 仍大小写敏感', await q("SELECT BINARY 'abc' = 'ABC'") === 0);
  ok('#119 BINARY LIKE 大小写敏感', await q("SELECT BINARY 'abc' LIKE 'ABC'") === 0);
  ok('#119 BINARY LIKE 反向', await q("SELECT BINARY 'ABC' LIKE 'abc'") === 0);
  ok('#119 BINARY REGEXP 大小写敏感', await q("SELECT BINARY 'a' REGEXP 'A'") === 0);
  ok('#119 CAST AS BINARY LIKE', await q("SELECT CAST('abc' AS BINARY) LIKE 'ABC'") === 0);
  ok('#119 普通 LIKE 仍不敏感', await q("SELECT 'abc' LIKE 'ABC'") === 1);

  // #125: PI()
  ok('#125 PI()', Math.abs(await q('SELECT PI()') - Math.PI) < 1e-12);

  // #129: TIMESTAMPDIFF 负差值向零截断
  ok('#129 YEAR 官方示例', await q("SELECT TIMESTAMPDIFF(YEAR,'2002-05-01','2001-01-01')") === -1);
  ok('#129 DAY', await q("SELECT TIMESTAMPDIFF(DAY,'2024-01-02 12:00:00','2024-01-01 00:00:00')") === -1);
  ok('#129 HOUR', await q("SELECT TIMESTAMPDIFF(HOUR,'2024-01-01 01:30:00','2024-01-01 00:00:00')") === -1);
  ok('#129 正差值不变', await q("SELECT TIMESTAMPDIFF(YEAR,'2001-01-01','2002-05-01')") === 1);

  // #130: MAKEDATE dayofyear<=0 返回 NULL
  ok('#130 MAKEDATE(y,0)', await q('SELECT MAKEDATE(2011,0)') === null);
  ok('#130 MAKEDATE(y,-1)', await q('SELECT MAKEDATE(2024,-1)') === null);

  // #131: MOD(bigint, 小数)
  ok('#131 MOD(bigint,0.5)', await q('SELECT MOD(9007199254740993,0.5)') === 0);
  ok('#131 MOD(bigint,2.5)', await q('SELECT MOD(9007199254740993,2.5)') === 0.5);

  // #132: NULLIF 跨类型等值
  ok('#132 NULLIF(1,1)', await q("SELECT NULLIF(1,'1')") === null);
  ok("#132 NULLIF('1',1)", await q("SELECT NULLIF('1',1)") === null);
  ok('#132 NULLIF(1,2) 不相等保留原值', await q('SELECT NULLIF(1,2)') === 1);

  // #133: STR_TO_DATE 非法日历日期
  ok('#133 2024-02-30', await q("SELECT STR_TO_DATE('2024-02-30','%Y-%m-%d')") === null);
  ok('#133 2024-13-01', await q("SELECT STR_TO_DATE('2024-13-01','%Y-%m-%d')") === null);
  ok('#133 13:00 PM', await q("SELECT STR_TO_DATE('13:00 PM','%h:%i %p')") === null);
  ok('#133 合法日期仍可解析', await q("SELECT STR_TO_DATE('2024-02-29','%Y-%m-%d')") === '2024-02-29');

  // #134: TRUNCATE/ROUND BigInt 第二参数
  ok('#134 TRUNCATE(bigint,-2)', await q('SELECT TRUNCATE(9007199254740993,-2)') === '9007199254740900');
  ok('#134 ROUND(bigint,-2)', await q('SELECT ROUND(9007199254740993,-2)') === '9007199254741000');
  ok('#134 TRUNCATE(number,-2)', await q('SELECT TRUNCATE(123456789,-2)') === 123456700);

  // #135: CONV 负数按 64 位补码
  ok('#135 CONV(-1,10,2)', await q('SELECT CONV(-1,10,2)') === '1'.repeat(64));
  ok('#135 CONV(-10,10,16)', await q('SELECT CONV(-10,10,16)') === 'FFFFFFFFFFFFFFF6');
  ok('#135 CONV(255,10,16)', await q('SELECT CONV(255,10,16)') === 'FF');

  // #136: TRIM 省略 remstr
  ok('#136 TRIM(LEADING FROM)', await q("SELECT TRIM(LEADING FROM '  x  ')") === 'x  ');
  ok('#136 TRIM(TRAILING FROM)', await q("SELECT TRIM(TRAILING FROM '  x  ')") === '  x');
  ok('#136 TRIM(BOTH FROM)', await q("SELECT TRIM(BOTH FROM '  x  ')") === 'x');
  ok('#136 TRIM(LEADING rem FROM) 仍正常', await q("SELECT TRIM(LEADING 'x' FROM 'xxxabcxxx')") === 'abcxxx');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
})().catch(e => { console.error(e); process.exitCode = 1; });
