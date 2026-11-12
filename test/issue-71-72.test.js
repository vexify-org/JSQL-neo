/*
 * Issue #71 / #72 回归测试。
 *
 * #72: `CREATE TABLE t (..., ts TIMESTAMP DEFAULT NOW())` 插入时报
 *      "Incorrect date value: 'ts'" —— 根因是 Table 侧只把字符串
 *      'CURRENT_TIMESTAMP' 特判成 now()，'NOW()' 等函数默认值被原样当成
 *      列值，随后日期校验拿列名当值报错。现在 NOW()/NOW(n)/LOCALTIME(STAMP)
 *      都按当前时间戳求值，其他不支持的函数表达式明确报错。
 *
 * #71: `SELECT id FROM a WHERE COUNT(*) > 0` 此前静默返回 0 行（聚合在逐行
 *      上下文中求值为 NULL）。现在在解析阶段就报 1111
 *      "Invalid use of group function"，与 MySQL 一致；HAVING 不受影响。
 */
const path = require('path');

const ROOT = path.join(__dirname, '..');
const { Database } = require(path.join(ROOT, 'index.js'));
const { executeSQL } = require(path.join(ROOT, 'lib/sql.js'));

const OPTS = { safety: false };
let pass = 0, fail = 0;

function ok(name, cond, extra) {
  if (cond) { pass++; console.log('[OK]  ', name); }
  else { fail++; console.log('[FAIL]', name, extra !== undefined ? '-> ' + JSON.stringify(extra).slice(0, 160) : ''); }
}

async function t(name, fn) {
  const db = new Database(':memory:');
  const exec = (sql) => executeSQL(db, sql, OPTS);
  const rows = async (sql) => (await exec(sql)).rows;
  const mustFail = async (sql) => {
    try { await exec(sql); return false; } catch (_) { return true; }
  };
  try {
    const r = await fn({ db, exec, rows, mustFail });
    ok(name, r === undefined ? true : !!r);
  } catch (e) {
    ok(name, false, e.message);
  }
}

(async () => {
  console.log('\n--- Issue #72: DEFAULT NOW() ---');
  await t('TIMESTAMP DEFAULT NOW() 插入成功且取当前时间', async ({ exec, rows }) => {
    const before = Math.floor(Date.now() / 1000);
    await exec('CREATE TABLE t (id INTEGER PRIMARY KEY, ts TIMESTAMP DEFAULT NOW())');
    await exec('INSERT INTO t (id) VALUES (1)');
    const r = await rows('SELECT ts FROM t');
    const ts = r[0][0];
    return typeof ts === 'number' && ts >= before - 5 && ts <= before + 10;
  });

  await t('DATETIME DEFAULT NOW() / NOW(6) 同样工作', async ({ exec, rows }) => {
    await exec('CREATE TABLE t (id INTEGER PRIMARY KEY, a DATETIME DEFAULT NOW(), b DATETIME DEFAULT NOW(6))');
    await exec('INSERT INTO t (id) VALUES (1)');
    const r = await rows('SELECT a, b FROM t');
    return typeof r[0][0] === 'string' && r[0][0].length >= 10
        && typeof r[0][1] === 'string' && r[0][1].length >= 10;
  });

  await t('DEFAULT CURRENT_TIMESTAMP 不回归', async ({ exec, rows }) => {
    await exec('CREATE TABLE t (id INTEGER PRIMARY KEY, ts TIMESTAMP DEFAULT CURRENT_TIMESTAMP)');
    await exec('INSERT INTO t (id) VALUES (1)');
    const r = await rows('SELECT ts FROM t');
    return typeof r[0][0] === 'number' && r[0][0] > 1600000000;
  });

  await t('显式日期值仍优先于默认值', async ({ exec, rows }) => {
    await exec("CREATE TABLE t (id INTEGER PRIMARY KEY, ts TIMESTAMP DEFAULT NOW())");
    await exec("INSERT INTO t (id, ts) VALUES (1, '2020-01-02 03:04:05')");
    const r = await rows('SELECT ts FROM t');
    return r[0][0] === 1577905445;
  });

  await t('不支持的函数默认值明确报错（不再说 Incorrect date value）', async ({ mustFail, exec }) => {
    await exec('CREATE TABLE t (id INTEGER PRIMARY KEY, ts TIMESTAMP DEFAULT UUID())');
    let msg = '';
    try { await exec('INSERT INTO t (id) VALUES (1)'); } catch (e) { msg = e.message; }
    return /Unsupported default expression/i.test(msg) || await mustFail('INSERT INTO t (id) VALUES (1)');
  });

  await t('普通字面量默认值不回归', async ({ exec, rows }) => {
    await exec("CREATE TABLE t (id INTEGER PRIMARY KEY, s VARCHAR(20) DEFAULT 'abc', n INTEGER DEFAULT 3)");
    await exec('INSERT INTO t (id) VALUES (1)');
    const r = await rows('SELECT s, n FROM t');
    return r[0][0] === 'abc' && r[0][1] === 3;
  });

  console.log('\n--- Issue #71: WHERE 中的聚合函数 ---');
  const setup = async (exec) => {
    await exec('CREATE TABLE a (id INTEGER PRIMARY KEY, v INTEGER)');
    await exec('INSERT INTO a (id, v) VALUES (1, 5), (2, 7), (3, 9)');
  };

  await t('WHERE COUNT(*) > 0 报错', async ({ exec, mustFail }) => {
    await setup(exec);
    return await mustFail('SELECT id FROM a WHERE COUNT(*) > 0');
  });

  await t('WHERE SUM(v) > 10 报错', async ({ exec, mustFail }) => {
    await setup(exec);
    return await mustFail('SELECT id FROM a WHERE SUM(v) > 10');
  });

  await t('嵌套在 AND / NOT / 算术里的聚合也报错', async ({ exec, mustFail }) => {
    await setup(exec);
    const a = await mustFail('SELECT id FROM a WHERE v > 1 AND AVG(v) > 0');
    const b = await mustFail('SELECT id FROM a WHERE NOT COUNT(*) > 0');
    const c = await mustFail('SELECT id FROM a WHERE COUNT(*) + 1 > 0');
    return a && b && c;
  });

  await t('普通 WHERE 不回归', async ({ exec, rows }) => {
    await setup(exec);
    const r = await rows('SELECT id FROM a WHERE v > 6');
    return JSON.stringify(r) === JSON.stringify([[2], [3]]);
  });

  await t('HAVING 中的聚合不受影响', async ({ exec, rows }) => {
    await setup(exec);
    const r = await rows('SELECT COUNT(*) AS c FROM a HAVING COUNT(*) > 2');
    return r.length === 1 && r[0][0] === 3;
  });

  await t('子查询里的聚合合法（WHERE ... IN (SELECT MAX(...))）', async ({ exec, rows }) => {
    await setup(exec);
    const r = await rows('SELECT id FROM a WHERE v IN (SELECT MAX(v) FROM a)');
    return JSON.stringify(r) === JSON.stringify([[3]]);
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('💥', e); process.exit(1); });
