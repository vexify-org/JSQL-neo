/* ---- issue #105 + JSON 包含/搜索的语义回归 ---- */
/*
 * #105：JSON_CONTAINS 用字符串 includes 实现（candidate 不解析、path 被忽略），
 * JSON_SEARCH 用 toLowerCase + includes（大小写不敏感、不支持 LIKE 通配符）。
 *
 * 顺带钉死两个差分发现的 bug：
 *   - jsonContainsValue 用 String() 宽松比较，字符串 "2" 能命中数字 2
 *   - JSON_SEARCH 不认 % / _ 通配符
 * 参考语义：MySQL 8.0 JSON_CONTAINS / JSON_SEARCH（大小写敏感、LIKE 模式）。
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
  const q = async (sql) => {
    const r = await executeSQL(db, sql, { safety: false });
    return r.rows[0][0];
  };

  // ---------- #105 JSON_CONTAINS ----------
  ok('#105 字符串候选命中数组元素',
    await q("SELECT JSON_CONTAINS('[1,2,3]', '2')") === 1, null);
  ok('#105 第三个 path 参数生效',
    await q("SELECT JSON_CONTAINS('{\"a\":1}', '1', '$.a')") === 1, null);
  ok('#105 嵌套 path',
    await q("SELECT JSON_CONTAINS('{\"a\":{\"b\":1}}', '1', '$.a.b')") === 1, null);
  ok('数值字面量候选仍命中',
    await q("SELECT JSON_CONTAINS('[1,2,3]', 2)") === 1, null);
  ok('path 不存在返回 0',
    await q("SELECT JSON_CONTAINS('{\"a\":1}', '1', '$.b')") === 0, null);
  ok('对象包含（子集）',
    await q("SELECT JSON_CONTAINS('{\"a\":1,\"b\":2}', '{\"a\":1}')") === 1, null);
  ok('对象值不匹配返回 0',
    await q("SELECT JSON_CONTAINS('{\"a\":1}', '{\"a\":2}')") === 0, null);
  ok('数组子集命中',
    await q("SELECT JSON_CONTAINS('[1,2,3]', '[2,3]')") === 1, null);
  ok('数组不含该元素返回 0',
    await q("SELECT JSON_CONTAINS('[1,2,3]', '9')") === 0, null);

  // ---------- 类型敏感（差分发现） ----------
  ok('字符串 "2" 不应命中数字 2',
    await q("SELECT JSON_CONTAINS('[1,2,3]', '\"2\"')") === 0, null);
  ok('字符串元素只被字符串候选命中',
    await q("SELECT JSON_CONTAINS('[\"2\"]', '\"2\"')") === 1, null);
  ok('数字 2 不应命中字符串元素',
    await q("SELECT JSON_CONTAINS('[\"2\"]', '2')") === 0, null);

  // ---------- JSON path 解析器（差分发现） ----------
  ok('JSON_EXTRACT 支持纯数组索引 $[1]',
    await q("SELECT JSON_EXTRACT('[1,2,3]', '$[1]')") === 2, null);
  ok('JSON_CONTAINS 的 path 值是合法 JSON null',
    await q("SELECT JSON_CONTAINS('{\"a\":null}', 'null', '$.a')") === 1, null);
  ok('JSON_CONTAINS 支持数组索引 path',
    await q("SELECT JSON_CONTAINS('{\"a\":[1,2]}', '2', '$.a[1]')") === 1, null);
  ok('JSON_EXTRACT 找不到路径仍返回 NULL',
    await q("SELECT JSON_EXTRACT('{\"a\":1}', '$.b')") === null, null);

  // ---------- #105 JSON_SEARCH 大小写敏感 ----------
  ok('#105 JSON_SEARCH 大小写不同返回 NULL',
    await q("SELECT JSON_SEARCH('[\"Hello\"]', 'one', 'hello')") === null, null);
  ok('JSON_SEARCH 大小写相同命中',
    await q("SELECT JSON_SEARCH('[\"Hello\"]', 'one', 'Hello')") === '$[0]', null);

  // ---------- LIKE 通配符（差分发现） ----------
  ok('JSON_SEARCH 支持 % 通配符',
    await q("SELECT JSON_SEARCH('[\"hello world\"]', 'one', 'hello%')") === '$[0]', null);
  ok('JSON_SEARCH 支持 _ 通配符',
    await q("SELECT JSON_SEARCH('[\"Hello\"]', 'one', 'H_llo')") === '$[0]', null);
  ok('JSON_SEARCH 的 % 不是字面量',
    await q("SELECT JSON_SEARCH('[\"hello%world\"]', 'one', 'hello%')") === '$[0]', null);
  const all = await q("SELECT JSON_SEARCH('{\"a\":\"x\",\"b\":\"x\"}', 'all', 'x')");
  ok('all 模式拿到两个路径', Array.isArray(all) && all.length === 2, all);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => {
  console.log('[FAIL] unexpected exception: ' + e.stack.split('\n').slice(0, 3).join('\n'));
  process.exit(1);
});
