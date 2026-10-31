/* ---- 分词器：字符串字面量快路径的语义回归 ---- */
/*
 * 背景：字符串字面量此前逐字符 `str += sql[j]` 拼接 —— V8 每加一个字符就建
 * 一个 ConsString 节点，1MB 字面量就是上百万个节点、几十 MB 垃圾。
 * 现在改成「先扫到结束、无转义时一次性 slice」。
 *
 * 快路径必须与慢路径**逐字节等价**，所以这里把各种转义/引号组合都钉死。
 */
const path = require('path');
const ROOT = path.join(__dirname, '..');
const { tokenize } = require(path.join(ROOT, 'lib', 'sql.js'));

let pass = 0, fail = 0;
function ok(name, cond, got) {
  if (cond) { pass++; console.log('[OK]   ' + name); }
  else { fail++; console.log('[FAIL] ' + name + ' -> ' + JSON.stringify(got)); }
}
const strs = (sql) => tokenize(sql).filter(t => t.type === 'string').map(t => t.value);
const BS = String.fromCharCode(92);
const Q = String.fromCharCode(39);

const cases = [
  ['普通字符串', "SELECT " + Q + "hello" + Q, ['hello']],
  ['空字符串', "SELECT " + Q + Q, ['']],
  ['转义单引号', "SELECT " + Q + "a" + BS + Q + "b" + Q, ['a' + Q + 'b']],
  ['SQL 双写引号', "SELECT " + Q + "O" + Q + Q + "Brien" + Q, ["O" + Q + "Brien"]],
  ['制表符转义', "SELECT " + Q + "a" + BS + "tb" + Q, ['a\tb']],
  ['换行转义', "SELECT " + Q + "a" + BS + "nb" + Q, ['a\nb']],
  ['反斜杠转义', "SELECT " + Q + "a" + BS + BS + "b" + Q, ['a' + BS + 'b']],
  ['LIKE 通配符保留', "SELECT " + Q + "a" + BS + "%b" + Q, ['a' + BS + '%b']],
  ['未知转义去反斜杠', "SELECT " + Q + "a" + BS + "qb" + Q, ['aqb']],
  ['双引号字符串', 'SELECT "dq"', ['dq']],
  ['字面量含换行', "SELECT " + Q + "a\nb" + Q, ['a\nb']],
  ['字面量含逗号括号', "SELECT " + Q + "a,b(c)" + Q, ['a,b(c)']],
  ['多个字面量', "SELECT " + Q + "a" + Q + ", " + Q + "b" + Q, ['a', 'b']],
];

for (const [name, sql, want] of cases) {
  let got = null, err = null;
  try { got = strs(sql); } catch (e) { err = e; }
  ok(name, !err && JSON.stringify(got) === JSON.stringify(want), got || ('抛错: ' + err.message));
}

// 未闭合必须仍然报错（快路径不能把它吞掉）
let threw = false;
try { tokenize("SELECT " + Q + "unterminated"); } catch (e) { threw = true; }
ok('未闭合字符串正确报错', threw, threw ? '' : '没有报错');

// 大字面量：快路径后不该再产生海量中间字符串
{
  const big = 'x'.repeat(512 * 1024);
  const sql = "SELECT " + Q + big + Q;
  const t0 = Date.now();
  const got = strs(sql);
  ok('512KB 字面量正确切出', got.length === 1 && got[0].length === big.length, got.length + '/' + (got[0] || '').length);
  ok('512KB 字面量耗时 < 200ms', Date.now() - t0 < 200, (Date.now() - t0) + 'ms');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
