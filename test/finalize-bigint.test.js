/* ---- finalizeResultBigInts：性能优化不能丢 BigInt 语义 ---- */
/*
 * 优化前 executeSQL 用通用 finalizeBigInts 对结果深递归；优化后改成针对
 * rows(二维) / raw(对象数组) 的紧凑循环，其余字段仍走通用实现。
 * 这里钉死「>2^53 的值在 rows 和 raw 里都必须是可序列化的字符串」，
 * 以及小整数仍是 number、结果整体可 JSON.stringify。
 */
const path = require('path');
const ROOT = path.join(__dirname, '..');
const { Database } = require(path.join(ROOT, 'index.js'));

let pass = 0, fail = 0;
function ok(name, cond, got) {
  if (cond) { pass++; console.log('[OK]   ' + name); }
  else { fail++; console.log('[FAIL] ' + name + ' -> ' + JSON.stringify(got, (k, v) => typeof v === 'bigint' ? v.toString() + 'n' : v)); }
}

(async () => {
  const db = new Database(':memory:', { autoSave: false });
  await db.createTable('t', { id: { type: 'integer', primaryKey: true, autoIncrement: true }, n: { type: 'integer' } });
  await db.insert('t', [{ n: 1 }, { n: 2 }, { n: 3 }]);

  const r = await db.query('SELECT 9007199254740993 AS big, 1 AS small');
  ok('rows 里 >2^53 的 BigInt 已转字符串',
    r.rows[0][0] === '9007199254740993' && typeof r.rows[0][0] === 'string', r.rows);
  ok('raw 里 >2^53 的 BigInt 已转字符串',
    r.raw[0].big === '9007199254740993' && typeof r.raw[0].big === 'string', r.raw);
  ok('小整数仍是 number（没被无差别转字符串）',
    r.rows[0][1] === 1 && r.raw[0].small === 1, r);
  ok('结果整体可 JSON.stringify（BigInt 会抛错）',
    (() => { try { JSON.stringify(r); return true; } catch (e) { return false; } })(), r);

  const huge = await db.query('SELECT 9223372036854775807 AS huge');
  ok('int64 最大值同样转字符串', huge.rows[0][0] === '9223372036854775807', huge.rows);

  // 多行：rows 每一行、raw 每个对象都要处理到，不能只处理第一行
  const many = await db.query('SELECT id, 9007199254740993 AS big FROM t');
  ok('多行 rows 全部转换',
    many.rows.length === 3 && many.rows.every((row) => row[1] === '9007199254740993'), many.rows);
  ok('多行 raw 全部转换',
    many.raw.length === 3 && many.raw.every((o) => o.big === '9007199254740993'), many.raw);
  ok('多行场景下 id 仍是 number',
    many.rows.every((row) => typeof row[0] === 'number'), many.rows);

  // 其余字段走通用实现：columns / 元数据不能被跳过
  const plain = await db.query('SELECT id FROM t WHERE id = 1');
  ok('columns 等其余字段保留',
    Array.isArray(plain.columns) && plain.columns[0] === 'id' && plain.rowCount === 1, plain);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => {
  console.log('[FAIL] unexpected exception: ' + e.message);
  process.exit(1);
});
