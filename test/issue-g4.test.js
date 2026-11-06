/*
 * 回归测试：SUB-G4 修复的三个 issue。
 *
 *  #37 query.js: 缓存命中返回内部数组引用，调用方修改污染缓存
 *  #26 MySQL 不兼容：= 把字符串与数字按字符串比较（0 = '' 应得 1）
 *  #21 WHERE 拒绝裸布尔谓词（WHERE 1 / WHERE col / WHERE NULL）
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
  const one = async (sql) => (await q(sql)).rows[0][0];

  /* ============ #26: MySQL 数字/字符串等值强转 ============ */
  console.log('\n--- #26: MySQL = 数字/字符串强转 ---');
  ok("0 = '' -> 1", await one("SELECT 0 = ''") === 1, await one("SELECT 0 = ''"));
  ok("'a' = 0 -> 1", await one("SELECT 'a' = 0") === 1, await one("SELECT 'a' = 0"));
  ok("'5' = 5 -> 1", await one("SELECT '5' = 5") === 1, await one("SELECT '5' = 5"));
  ok("'0' = 0 -> 1", await one("SELECT '0' = 0") === 1);
  ok("'' = 0 -> 1", await one("SELECT '' = 0") === 1);
  ok("5 = '5' -> 1", await one("SELECT 5 = '5'") === 1);
  ok("'5' != 6 -> 1", await one("SELECT '5' != 6") === 1);
  // 两侧都是字符串仍按字符串比较（不误伤日期/字典序）
  ok("'9' < '10' -> 0（字符串比较）", await one("SELECT '9' < '10'") === 0);

  /* ============ #21: WHERE 裸布尔谓词 ============ */
  console.log('\n--- #21: WHERE 裸布尔谓词 ---');
  await q("CREATE TABLE t (id integer primary key auto_increment, b boolean, n integer)");
  await q("INSERT INTO t (b, n) VALUES (true, 1), (false, 2), (true, 3)");
  const ids = async (sql) => (await q(sql)).rows.map(r => r[0]);
  ok("WHERE 1 -> 全部行", JSON.stringify(await ids("SELECT id FROM t WHERE 1 ORDER BY id")) === JSON.stringify([1, 2, 3]));
  ok("WHERE 0 -> 无行", JSON.stringify(await ids("SELECT id FROM t WHERE 0")) === JSON.stringify([]));
  ok("WHERE TRUE -> 全部行", JSON.stringify(await ids("SELECT id FROM t WHERE TRUE ORDER BY id")) === JSON.stringify([1, 2, 3]));
  ok("WHERE FALSE -> 无行", JSON.stringify(await ids("SELECT id FROM t WHERE FALSE")) === JSON.stringify([]));
  ok("WHERE b -> 真值行 [1,3]", JSON.stringify(await ids("SELECT id FROM t WHERE b ORDER BY id")) === JSON.stringify([1, 3]));
  ok("WHERE NOT b -> [2]", JSON.stringify(await ids("SELECT id FROM t WHERE NOT b")) === JSON.stringify([2]));
  ok("WHERE NULL -> 无行", JSON.stringify(await ids("SELECT id FROM t WHERE NULL")) === JSON.stringify([]));
  ok("WHERE NULL AND b = 1 -> 无行", JSON.stringify(await ids("SELECT id FROM t WHERE NULL AND b = 1")) === JSON.stringify([]));
  ok("WHERE 1 AND b -> [1,3]", JSON.stringify(await ids("SELECT id FROM t WHERE 1 AND b ORDER BY id")) === JSON.stringify([1, 3]));
  ok("WHERE n OR 0 -> 全部行", JSON.stringify(await ids("SELECT id FROM t WHERE n OR 0 ORDER BY id")) === JSON.stringify([1, 2, 3]));

  /* ============ #37: 缓存返回拷贝 ============ */
  console.log('\n--- #37: 缓存命中不暴露内部数组 ---');
  await q("CREATE TABLE u (id integer primary key auto_increment, name varchar(50))");
  await q("INSERT INTO u (name) VALUES ('a'), ('b')");
  const table = db._ensureTable('u');

  // 缓存已热后修改返回值：不得污染缓存
  const qb1 = table.where({}).cache(60000);
  const rows1 = qb1.get();
  rows1[0].name = 'MUT1';
  const rows2 = qb1.get();
  ok("修改后再次 get：未泄漏", rows2[0].name === 'a' && !rows2.some(r => r.name === 'MUT1'), rows2);

  // 首次调用（缓存未命中）修改返回值：同样不得污染缓存
  const qb2 = table.where({}).cache(60000);
  const rA = qb2.get();
  rA[0].name = 'MUT2';
  const rB = qb2.get();
  ok("首次调用后再次 get：未泄漏", rB[0].name === 'a' && !rB.some(r => r.name === 'MUT2'), rB);

  // 两次 get 返回独立引用（数组与行对象都不同）
  const qb3 = table.where({}).cache(60000);
  const c1 = qb3.get(), c2 = qb3.get();
  ok("两次 get 返回不同数组引用", c1 !== c2);
  ok("两次 get 返回不同行对象引用", c1[0] !== c2[0]);

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
