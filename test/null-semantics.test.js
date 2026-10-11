/*
 * 标量函数的 NULL 语义测试（COALESCE / GREATEST / LEAST / CONCAT / CONCAT_WS）。
 *
 * 这一批全是「静默算错」——不抛异常、不影响其他测试，只有拿标准答案逐条对照才暴露。
 *
 * 三处偏差：
 *   1. COALESCE 全部取不到值时返回 undefined。而 undefined 在结果行里会
 *      让整个键消失（JSON.stringify 直接丢掉），等于这一列凭空不见。
 *      IFNULL 返回的是 null，两者不一致。
 *   2. GREATEST / LEAST 直接拿 JS 的 > / < 比较，而 JS 里 null 会强转成 0 ——
 *      GREATEST(NULL,1) 得 1、LEAST(NULL,1) 得 null，这一对函数自相矛盾。
 *   3. CONCAT 把 NULL 当成空串。而本引擎其余所有标量函数（UPPER / LENGTH /
 *      TRIM / ABS / SUBSTRING / REPLACE ...）遇到 NULL 一律返回 NULL，
 *      CONCAT 是唯一的例外；MySQL 也是返回 NULL。
 *      把 NULL 当空串会拼出一个「看起来正常」的错值：
 *      CONCAT(first,' ',last) 里 last 为 NULL 时得到 "John " 而不是 NULL，
 *      缺失的字段就此被掩盖。
 *   4. CONCAT_WS 的分隔符为 NULL 时会悄悄退回逗号（MySQL 返回 NULL）。
 *      CONCAT_WS 本身跳过 NULL 参数是对的，这个行为要保住。
 */
const path = require('path');

const ROOT = path.join(__dirname, '..');
const { Database } = require(path.join(ROOT, 'index.js'));
const { executeSQL } = require(path.join(ROOT, 'lib/sql.js'));

const OPTS = { safety: false };
let pass = 0, fail = 0;

function ok(name, cond, extra) {
  if (cond) { pass++; console.log('[OK]  ', name); }
  else { fail++; console.log('[FAIL]', name, extra !== undefined ? '-> ' + JSON.stringify(extra).slice(0, 140) : ''); }
}

(async () => {
  const db = new Database(':memory:');
  const q = (sql) => executeSQL(db, sql, OPTS);
  /** 取第一行第一列，并如实区分 null / undefined —— 这正是本组的重点 */
  const one = async (sql) => {
    const r = await q(sql);
    return r.rows[0][0];
  };
  const isNull = async (sql) => (await one(sql)) === null;

  console.log('\n--- COALESCE ---');
  ok('COALESCE(NULL, NULL) 是 null 而不是 undefined', await isNull('SELECT COALESCE(NULL, NULL)'),
    await one('SELECT COALESCE(NULL, NULL)'));
  ok('COALESCE 返回 null 时结果行里键仍在（不被 JSON 丢掉）',
    JSON.stringify((await q('SELECT COALESCE(NULL, NULL) AS c')).rows) === '[[null]]',
    (await q('SELECT COALESCE(NULL, NULL) AS c')).rows);
  ok('COALESCE(NULL, 1)', await one('SELECT COALESCE(NULL, 1)') === 1);
  ok('COALESCE(1, NULL)', await one('SELECT COALESCE(1, NULL)') === 1);
  ok('COALESCE 取第一个非 NULL', await one('SELECT COALESCE(NULL, NULL, 3, 4)') === 3);
  ok('COALESCE 与 IFNULL 对全 NULL 的处理一致',
    (await isNull('SELECT COALESCE(NULL, NULL)')) && (await isNull('SELECT IFNULL(NULL, NULL)')));
  ok('COALESCE 传 0 不会跳过（0 不是 NULL）', await one('SELECT COALESCE(0, 9)') === 0);
  ok('COALESCE 传空串不会跳过', await one("SELECT COALESCE('', 'x')") === '');
  // 引擎按 MySQL 语义把布尔字面量归一成 0/1，而不是 JS 的 false/true
  ok('COALESCE 传 FALSE 不会跳过（返回 0，不是 NULL）', await one('SELECT COALESCE(FALSE, 9)') === 0);

  console.log('\n--- GREATEST / LEAST ---');
  ok('GREATEST(NULL, 1) 返回 NULL', await isNull('SELECT GREATEST(NULL, 1)'));
  ok('LEAST(NULL, 1) 返回 NULL', await isNull('SELECT LEAST(NULL, 1)'));
  ok('两者对 NULL 的处理一致（此前 GREATEST 得 1、LEAST 得 null）',
    (await isNull('SELECT GREATEST(NULL, 1)')) === (await isNull('SELECT LEAST(NULL, 1)')));
  ok('GREATEST(NULL, NULL)', await isNull('SELECT GREATEST(NULL, NULL)'));
  ok('LEAST(NULL, NULL)', await isNull('SELECT LEAST(NULL, NULL)'));
  ok('GREATEST 正常取最大', await one('SELECT GREATEST(3, 1, 2)') === 3);
  ok('LEAST 正常取最小', await one('SELECT LEAST(3, 1, 2)') === 1);
  ok('GREATEST 单参数', await one('SELECT GREATEST(5)') === 5);
  ok('LEAST 单参数', await one('SELECT LEAST(5)') === 5);
  ok('GREATEST 带负数', await one('SELECT GREATEST(-5, -10)') === -5);
  ok('LEAST 带负数', await one('SELECT LEAST(-5, -10)') === -10);
  ok('GREATEST 不把 0 当 NULL', await one('SELECT GREATEST(0, -1)') === 0);

  console.log('\n--- CONCAT ---');
  ok('CONCAT 遇到 NULL 返回 NULL', await isNull("SELECT CONCAT('a', NULL, 'b')"));
  ok('NULL 在首位也返回 NULL', await isNull("SELECT CONCAT(NULL, 'a')"));
  ok('NULL 在末位也返回 NULL', await isNull("SELECT CONCAT('a', NULL)"));
  ok('全 NULL 返回 NULL', await isNull('SELECT CONCAT(NULL, NULL)'));
  ok('正常拼接不受影响', await one("SELECT CONCAT('a', 'b', 'c')") === 'abc');
  ok('数字会转成字符串', await one("SELECT CONCAT('n=', 42)") === 'n=42');
  ok('空串不是 NULL', await one("SELECT CONCAT('a', '', 'b')") === 'ab');
  ok('0 不是 NULL', await one("SELECT CONCAT('a', 0)") === 'a0');
  ok('CONCAT 与其余标量函数的 NULL 行为一致',
    (await isNull("SELECT CONCAT('a', NULL)")) && (await isNull('SELECT UPPER(NULL)')));

  console.log('\n--- CONCAT_WS ---');
  ok('CONCAT_WS 跳过 NULL 参数（与 CONCAT 相反）',
    await one("SELECT CONCAT_WS('-', 'a', NULL, 'b')") === 'a-b');
  ok('CONCAT_WS 全 NULL 参数给空串',
    await one("SELECT CONCAT_WS('-', NULL, NULL)") === '');
  ok('CONCAT_WS 分隔符为 NULL → 返回 NULL（此前悄悄退回逗号）',
    await isNull("SELECT CONCAT_WS(NULL, 'a', 'b')"));
  ok('CONCAT_WS 正常分隔', await one("SELECT CONCAT_WS(',', 'a', 'b', 'c')") === 'a,b,c');
  ok('CONCAT_WS 单参数即原值', await one("SELECT CONCAT_WS('-', 'a')") === 'a');
  ok('CONCAT_WS 空串分隔符', await one("SELECT CONCAT_WS('', 'a', 'b')") === 'ab');

  console.log('\n--- 与其余标量函数的一致性（回归护栏）---');
  const nullPropagating = [
    'UPPER(NULL)', 'LOWER(NULL)', 'LENGTH(NULL)', 'TRIM(NULL)', 'ABS(NULL)',
    'ROUND(NULL, 1)', 'SUBSTRING(NULL, 1, 1)', "REPLACE(NULL, 'a', 'b')",
    "INSTR(NULL, 'a')", 'SQRT(NULL)', 'CONCAT(NULL)',
  ];
  for (const expr of nullPropagating) {
    ok(`${expr} 传播 NULL`, await isNull(`SELECT ${expr}`));
  }

  console.log('\n--- 表数据上验证 ---');
  {
    await q('CREATE TABLE people (id INT PRIMARY KEY, first TEXT, last TEXT)');
    await q("INSERT INTO people VALUES (1,'John','Doe'),(2,'Jane',NULL)");
    const rows = (await q('SELECT id, CONCAT(first, " ", last) AS full_name FROM people ORDER BY id')).rows;
    ok('拼接缺字段的行得到 NULL 而不是 "Jane "',
      JSON.stringify(rows) === '[[1,"John Doe"],[2,null]]', rows);

    const co = (await q("SELECT COALESCE(last, first) AS v FROM people ORDER BY id")).rows;
    ok('COALESCE 在表数据上正常兜底', JSON.stringify(co) === '[["Doe"],["Jane"]]', co);

    const mx = (await q('SELECT GREATEST(id, 1) AS g, LEAST(id, 1) AS l FROM people ORDER BY id')).rows;
    ok('GREATEST / LEAST 在表数据上正常', JSON.stringify(mx) === '[[1,1],[2,1]]', mx);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('💥', e); process.exit(1); });
