/*
 * #407 回归测试：mysql_compat 结果字段类型推断（布尔/日期/首行 NULL 列）。
 *   node test/issue-407.test.js
 */
const assert = require('assert');
const path = require('path');
const mysql = require(path.join(__dirname, '..', 'lib', 'mysql_compat.js'));

let passed = 0, failed = 0;
async function t(name, fn) {
  try { await fn(); passed++; console.log(`ok - ${name}`); }
  catch (e) { failed++; console.error(`not ok - ${name}\n  ${e && e.message}`); }
}

(async () => {
  const conn = mysql.createConnection({});
  await conn.connect();

  await t('#407 SELECT TRUE 报 TINY(1) 而非 LONGLONG(8)', async () => {
    const [, fields] = await conn.query('SELECT TRUE AS b');
    assert.strictEqual(fields[0].type, 1);
  });

  await t('#407 NOW() 的 ISO 字符串报 DATETIME(12)', async () => {
    const [, fields] = await conn.query('SELECT NOW() AS dt');
    assert.strictEqual(fields[0].type, 12);
  });

  await t('#407 首行 NULL 的列按 schema/后续非空行推断', async () => {
    await conn.query('CREATE TABLE t (a INT, b INT)');
    await conn.query('INSERT INTO t VALUES (NULL, 5), (7, 8)');
    const [, fields] = await conn.query('SELECT a, b FROM t');
    assert.strictEqual(fields[0].type, 8, `a type=${fields[0].type}`);
    assert.strictEqual(fields[1].type, 8, `b type=${fields[1].type}`);
  });

  await conn.end();
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
})();
