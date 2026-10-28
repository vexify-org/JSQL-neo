/*
 * Bug 回归测试：此前发现的 5 个缺陷，逐一固化，防止回退。
 *
 *   1. 布尔求值器整体失效：TRUE AND TRUE → 0、NULL AND TRUE → 0、NULL OR FALSE → 0。
 *      正确三值逻辑：1 / NULL / NULL。根因是 resolveOperand 没有 and/or/xor/not 分支，
 *      落到 default 返回 undefined → 数值化成 0。
 *   2. CREATE TABLE d(a INT, a INT) 不拒绝重复列名（对象键覆盖静默丢列）。
 *   3. JSONB 列能塞进 {bad json 这种非法 JSON（两引擎：Database _validateDataTypes + wasm insert）。
 *   4. ORDER BY 不存在的列静默忽略（解析产物是裸字符串，_validateColumnRefs 的 walk 检不到）。
 *   5. SELECT 超大整数抛 "Do not know how to serialize a BigInt"（输出前应转字符串）。
 */
const path = require('path');

const ROOT = path.join(__dirname, '..');
const { JSQL } = require(path.join(ROOT, 'index.js'));
const { executeSQL } = require(path.join(ROOT, 'lib/sql.js'));

const OPTS = { safety: false };
let pass = 0, fail = 0;

function ok(name, cond, extra) {
  if (cond) { pass++; console.log('[OK]  ', name); }
  else { fail++; console.log('[FAIL]', name, extra !== undefined ? '-> ' + JSON.stringify(extra).slice(0, 150) : ''); }
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

(async () => {
  const db = new JSQL(':memory:');
  await db.start();
  const q = (sql) => executeSQL(db, sql, OPTS);
  const rows = async (sql) => (await q(sql)).rows;
  const one = async (sql) => (await q(sql)).rows[0][0];
  const fails = async (sql) => { try { await q(sql); return null; } catch (e) { return e.message; } };

  // ── 1. 三值布尔逻辑 ────────────────────────────────────────────
  console.log('--- 1. 布尔三值逻辑 ---');
  ok('TRUE AND TRUE = 1', (await one('SELECT TRUE AND TRUE')) === 1);
  ok('TRUE AND FALSE = 0', (await one('SELECT TRUE AND FALSE')) === 0);
  ok('NULL AND TRUE = NULL', (await one('SELECT NULL AND TRUE')) === null);
  ok('NULL AND FALSE = 0', (await one('SELECT NULL AND FALSE')) === 0);
  ok('NULL OR FALSE = NULL', (await one('SELECT NULL OR FALSE')) === null);
  ok('NULL OR TRUE = 1', (await one('SELECT NULL OR TRUE')) === 1);
  ok('FALSE OR FALSE = 0', (await one('SELECT FALSE OR FALSE')) === 0);
  ok('NOT TRUE = 0', (await one('SELECT NOT TRUE')) === 0);
  ok('NOT NULL = NULL', (await one('SELECT NOT NULL')) === null);
  ok('1 AND 0 = 0', (await one('SELECT 1 AND 0')) === 0);
  ok('1 XOR 0 = 1', (await one('SELECT 1 XOR 0')) === 1);
  ok('TRUE OR NULL = 1', (await one('SELECT TRUE OR NULL')) === 1);

  // ── 2. CREATE TABLE 重复列名 ───────────────────────────────────
  console.log('--- 2. 重复列名 ---');
  ok('d(a INT, a INT) 报错', /Duplicate column/i.test(await fails('CREATE TABLE r1(a INT, a INT)')));
  ok('d(x,y,x) 报错', /Duplicate column/i.test(await fails('CREATE TABLE r2(x INT, y INT, x INT)')));
  ok('正常列不报错', (await fails('CREATE TABLE r3(a INT, b TEXT)')) === null);
  ok('id PRIMARY KEY + id 重复报错', /Duplicate column/i.test(await fails('CREATE TABLE r4(id INT PRIMARY KEY, id INT)')));

  // ── 3. JSONB 非法 JSON ─────────────────────────────────────────
  console.log('--- 3. JSONB 校验 ---');
  await q('CREATE TABLE rj(c JSONB)');
  ok('{bad json 拒绝', /Truncated incorrect object value/.test(await fails(`INSERT INTO rj VALUES ('{bad json')`)));
  ok('[1,2 拒绝', /Truncated incorrect object value/.test(await fails(`INSERT INTO rj VALUES ('[1,2')`)));
  ok('合法 {"a":1} 通过', (await fails(`INSERT INTO rj VALUES ('{"a":1}')`)) === null);
  await q('CREATE TABLE rj2(c JSON)');
  ok('JSON 列 nope 拒绝', /Truncated incorrect object value/.test(await fails(`INSERT INTO rj2 VALUES ('nope')`)));

  // ── 4. ORDER BY 不存在列 ───────────────────────────────────────
  console.log('--- 4. ORDER BY 校验 ---');
  await q('CREATE TABLE ro (id INT PRIMARY KEY, v INT, s TEXT)');
  await q('INSERT INTO ro VALUES (1,2,\'x\'),(2,1,\'y\')');
  ok('ORDER BY nonexistent_col 报错', /no such column: nonexistent_col/.test(await fails('SELECT id FROM ro ORDER BY nonexistent_col')));
  ok('WHERE 不存在列报错', /no such column: nosuch/.test(await fails('SELECT id FROM ro WHERE nosuch > 1')));
  ok('ORDER BY 真列 v 正常', eq(await rows('SELECT id FROM ro ORDER BY v'), [[2], [1]]));
  ok('ORDER BY 位置序号 1 正常', eq(await rows('SELECT id FROM ro ORDER BY 1'), [[1], [2]]));
  ok('ORDER BY 输出别名 vv 正常', eq(await rows('SELECT v AS vv FROM ro ORDER BY vv'), [[1], [2]]));

  // ── 5. 超大整数序列化 ──────────────────────────────────────────
  console.log('--- 5. 超大整数 ---');
  const big = await one('SELECT 1000000000000000000000');
  ok('超大整数可序列化（字符串）', typeof big === 'string' && big === '1000000000000000000000');
  ok('超界精确值 9007199254740993', (await one('SELECT 9007199254740993')) === '9007199254740993');
  const bigRows = await rows('SELECT 1000000000000000000000');
  ok('JSON.stringify 不炸', (() => { try { JSON.stringify(bigRows); return true; } catch (e) { return false; } })());

  await db.stop();
  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
