/* ---- issue #63~#68 回归 ---- */
const path = require('path');
const ROOT = path.join(__dirname, '..');
const { Database, executeSQL } = require(path.join(ROOT, 'index.js'));

let pass = 0, fail = 0;
function ok(name, cond, got) {
  if (cond) { pass++; console.log('[OK]   ' + name); }
  else { fail++; console.log('[FAIL] ' + name + ' -> ' + JSON.stringify(got)); }
}
const isNull = (v) => v === null || v === undefined;

(async () => {
  const db = new Database(':memory:', { autoSave: false });
  const q = async (sql) => (await executeSQL(db, sql, { safety: false })).rows[0][0];

  // ---------- #63 POSITION(substr IN str) ----------
  ok('#63 POSITION 命中', await q("SELECT POSITION('b' IN 'abc')") === 2, await q("SELECT POSITION('b' IN 'abc')"));
  ok('#63 POSITION 未命中返回 0', await q("SELECT POSITION('z' IN 'abc')") === 0, await q("SELECT POSITION('z' IN 'abc')"));
  ok('#63 与 LOCATE 等价', await q("SELECT LOCATE('b','abc')") === await q("SELECT POSITION('b' IN 'abc')"), null);
  ok('#63 支持列引用', await q("SELECT POSITION('b' IN CONCAT('a','bc'))") === 2, null);

  // ---------- #64 日期类型拒绝非法数字 ----------
  const dt = require(path.join(ROOT, 'lib', 'date-types.js'));
  for (const v of [NaN, Infinity, -Infinity, 1e20]) {
    let threw = false;
    try { dt.validateDateType(v, 'date', 'd'); } catch (e) { threw = /Incorrect date value/.test(e.message); }
    ok('#64 date 拒绝 ' + String(v), threw, null);
    let threw2 = false;
    try { dt.validateDateType(v, 'datetime', 'd'); } catch (e) { threw2 = /Incorrect date value/.test(e.message); }
    ok('#64 datetime 拒绝 ' + String(v), threw2, null);
  }
  ok('#64 合法时间戳仍可用', dt.validateDateType(0, 'date', 'd') === '1970-01-01', dt.validateDateType(0, 'date', 'd'));

  // ---------- #65 数值域错误返回 NULL ----------
  for (const sql of ['SELECT SQRT(-1)', 'SELECT POWER(-2,0.5)', 'SELECT SQRT(-1) + 5', 'SELECT LOG(-5)', 'SELECT ACOS(2)']) {
    const v = await q(sql);
    ok('#65 ' + sql + ' → NULL', isNull(v), v);
  }
  ok('#65 SQRT(4) 仍为 2', await q('SELECT SQRT(4)') === 2, null);
  ok('#65 POWER(2,3) 仍为 8', await q('SELECT POWER(2,3)') === 8, null);

  // ---------- #66 / #67 Redis RESP 序列化 ----------
  const { createRedisServer } = require(path.join(ROOT, 'lib', 'redis_server.js'));
  const srv = createRedisServer({ port: 0 });
  function send(cmd, args) {
    const out = [];
    srv._handle({ write: (s) => out.push(s) }, cmd, args);
    return out.join('');
  }
  send('SET', ['a', '1']);
  const mget = send('MGET', ['a', 'missing']);
  ok('#66 MGET 缺失键为 nil bulk', mget.includes('$-1\r\n') && !mget.includes('$4\r\nnull'), mget);
  ok('#66 MGET 存在的键仍正常', mget.includes('$1\r\n1\r\n'), mget);

  send('ZADD', ['z', '10.5', 'm']);
  const zscore = send('ZSCORE', ['z', 'm']);
  ok('#67 ZSCORE 小数分数为 bulk string', zscore === '$4\r\n10.5\r\n', zscore);
  const zincr = send('ZINCRBY', ['z', '0.5', 'm']);
  // 10.5 + 0.5 = 11，"11" 是 2 字节，所以是 $2 而不是 $3
  ok('#67 ZINCRBY 分数为 bulk string', /^\$2\r\n11\r\n$/.test(zincr) || /^\$\d+\r\n11\.0+\r\n$/.test(zincr), zincr);
  send('ZADD', ['zi', '10', 'm']);
  const zint = send('ZSCORE', ['zi', 'm']);
  ok('#67 整数分数也是 bulk（不是 :10）', zint === '$2\r\n10\r\n', zint);
  ok('#67 _send 非整数 number 不产出非法 integer reply',
    (() => { const o = []; srv._send({ write: (s) => o.push(s) }, 10.5); return o[0] === '$4\r\n10.5\r\n'; })(), null);
  ok('#67 _send 整数仍是 integer reply',
    (() => { const o = []; srv._send({ write: (s) => o.push(s) }, 3); return o[0] === ':3\r\n'; })(), null);

  // ---------- #68 XQL ORDER BY 非投影列 ----------
  const { xql } = require(path.join(ROOT, 'lib', 'plugins'));
  const db2 = new Database(':memory:', { autoSave: false });
  await db2.createTable('users', {
    id: { type: 'integer', primaryKey: true, autoIncrement: true },
    name: { type: 'string' }, age: { type: 'integer' },
  });
  await db2.insert('users', [{ name: 'alice', age: 30 }, { name: 'bob', age: 25 }, { name: 'carol', age: 30 }]);
  db2.use(xql());
  const both = await db2.xql('FROM users |> ORDER BY age DESC |> SELECT name, age');
  const nameOnly = await db2.xql('FROM users |> ORDER BY age DESC |> SELECT name');
  ok('#68 投影含排序列时结果正确', both.map(r => r.name).join(',') === 'alice,carol,bob', both.map(r => r.name));
  ok('#68 排序列不在投影里也生效', nameOnly.map(r => r.name).join(',') === 'alice,carol,bob', nameOnly.map(r => r.name));
  const asc = await db2.xql('FROM users |> ORDER BY age ASC |> SELECT name');
  ok('#68 升序同样生效', asc[0].name === 'bob', asc.map(r => r.name));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => {
  console.log('[FAIL] unexpected exception: ' + e.stack.split('\n').slice(0, 3).join('\n'));
  process.exit(1);
});
