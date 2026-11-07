/* ---- result.raw：对象形式必须与 columns / rows 指向同一份结果 ---- */
/*
 * 原始契约的证据在 lib/prepared.js 的 get()：raw 缺失时它会用
 * columns + rows[0] 现场拼出等价对象。也就是说 raw 本该是
 * 「columns × rows 的 zip」，而不是投影前的源行。
 *
 * 此前 executeSelect 各分支直接把源行塞进 raw（rows: mapped, raw: rows），
 * 于是聚合 / 计算列 / 无 FROM 查询里 raw 变成 undefined、{_virtual:true}，
 * 或是缺了计算列的源行对象，GROUP BY 还会泄露内部 _group。见 issue #43。
 *
 * 修复在 buildResultEnvelope（统一出口）重建 raw。这里把六种场景钉死，
 * 并额外断言「键集合恰好等于 columns」——防止内部字段再漏出来。
 */
const path = require('path');
const ROOT = path.join(__dirname, '..');
const { Database } = require(path.join(ROOT, 'index.js'));

let pass = 0, fail = 0;
function ok(name, cond, got) {
  if (cond) { pass++; console.log('[OK]   ' + name); }
  else { fail++; console.log('[FAIL] ' + name + ' -> ' + JSON.stringify(got)); }
}

(async () => {
  const db = new Database(':memory:');
  await db.createTable('users', {
    id: 'integer primary key auto_increment',
    name: 'string', age: 'integer', city: 'string',
  });
  await db.insert('users', [
    { name: 'Alice', age: 30, city: 'NY' },
    { name: 'Bob', age: 25, city: 'LA' },
    { name: 'Carol', age: 40, city: 'NY' },
  ]);

  // 每个用例同时验三件事：raw 的值、与 rows 等长、键集合恰好是 columns
  async function check(label, sql, expected) {
    const r = await db.query(sql);
    const got = r.raw;
    ok(label + ' · raw 内容', JSON.stringify(got) === JSON.stringify(expected), got);
    ok(label + ' · raw 与 rows 等长',
      Array.isArray(got) && got.length === r.rows.length,
      { rawLen: got && got.length, rowsLen: r.rows.length });
    const keysMatch = Array.isArray(got) && got.every((obj) => {
      if (!obj || typeof obj !== 'object') return false;
      const keys = Object.keys(obj).sort();
      const cols = (r.columns || []).slice().sort();
      return JSON.stringify(keys) === JSON.stringify(cols);
    });
    ok(label + ' · 键集合恰好等于 columns', keysMatch,
      { raw: got && got[0] && Object.keys(got[0]), columns: r.columns });
  }

  await check('纯聚合',
    'SELECT COUNT(*) AS c, SUM(age) AS s FROM users',
    [{ c: 3, s: 95 }]);
  await check('GROUP BY 聚合',
    'SELECT city, COUNT(*) c FROM users GROUP BY city ORDER BY city',
    [{ city: 'LA', c: 1 }, { city: 'NY', c: 2 }]);
  await check('无 FROM 表达式',
    'SELECT 1/0 AS z', [{ z: null }]);
  await check('标量子查询',
    'SELECT (SELECT MAX(age) FROM users) AS m', [{ m: 40 }]);
  await check('CASE 计算列',
    "SELECT name, CASE WHEN age>35 THEN 'senior' END AS tier FROM users WHERE name='Bob'",
    [{ name: 'Bob', tier: null }]);
  await check('算术计算列',
    "SELECT name, age*2 AS dbl FROM users WHERE name='Bob'",
    [{ name: 'Bob', dbl: 50 }]);
  await check('普通 SELECT *',
    "SELECT * FROM users WHERE name='Bob'",
    [{ id: 2, name: 'Bob', age: 25, city: 'LA' }]);

  // 内部字段不能漏进公开结果（issue #43 里 _group 泄露）
  const g = await db.query('SELECT city, COUNT(*) c FROM users GROUP BY city');
  ok('GROUP BY raw 不泄露 _group',
    Array.isArray(g.raw) && g.raw.every((o) => !Object.keys(o).some((k) => k.startsWith('_'))),
    g.raw);

  // prepared.get() 的原始 fallback 与 raw 必须等价
  const p = db.prepare('SELECT COUNT(*) AS c FROM users');
  const one = await p.get();
  const q = await db.query('SELECT COUNT(*) AS c FROM users');
  ok('prepare().get() 与 raw[0] 一致',
    JSON.stringify(one) === JSON.stringify(q.raw[0]),
    { get: one, raw0: q.raw[0] });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.log('[FAIL] unexpected exception: ' + e.message);
  process.exit(1);
});
