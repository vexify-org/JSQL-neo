/*
 * Issue #73 / #74 / #75 / #76 回归测试。
 *
 * #73: `GROUP BY <数字位置>` 被忽略，所有行塌成一组。
 *      解析器把数字变成 { type:'value' } 常量，执行层对每行求值得到同一个键。
 *      现在按 SELECT 列表 1-based 位置解析，越界明确报错。
 *
 * #74: `ORDER BY <越界位置>` 静默忽略（取到 undefined 列 → 键恒为 null）。
 *      现在越界必须报错；合法位置序号行为不变。
 *
 * #75: INSERT 会把 ISO-8601 DATETIME 字面量规范化成本地
 *      'YYYY-MM-DD HH:MM:SS'，但 WHERE 比较路径不做同样规范化，
 *      同一字面量查不回自己插入的行。现在比较侧用同一套规则。
 *
 * #76: JOIN 里未加表名前缀的歧义列名（两张表都有 id）被静默解析成右表的值。
 *      现在报 "column reference 'id' is ambiguous"；限定引用与单表查询不受影响。
 */
const path = require('path');

const ROOT = path.join(__dirname, '..');
const { Database } = require(path.join(ROOT, 'index.js'));
const { executeSQL } = require(path.join(ROOT, 'lib/sql.js'));

const OPTS = { safety: false };
let pass = 0, fail = 0;

function ok(name, cond, extra) {
  if (cond) { pass++; console.log('[OK]  ', name); }
  else { fail++; console.log('[FAIL]', name, extra !== undefined ? '-> ' + JSON.stringify(extra).slice(0, 200) : ''); }
}

async function t(name, fn) {
  const db = new Database(':memory:');
  const exec = (sql) => executeSQL(db, sql, OPTS);
  const rows = async (sql) => (await exec(sql)).rows;
  const mustFail = async (sql) => {
    try { await exec(sql); return false; } catch (_) { return true; }
  };
  const errOf = async (sql) => {
    try { await exec(sql); return ''; } catch (e) { return e.message || String(e); }
  };
  try {
    const r = await fn({ db, exec, rows, mustFail, errOf });
    ok(name, r === undefined ? true : !!r);
  } catch (e) {
    ok(name, false, e.message);
  }
}

const pad = (n) => String(n).padStart(2, '0');
/** 某 UTC 毫秒对应的本地 'YYYY-MM-DD HH:MM:SS'（与 validateDateTime 的落库格式一致） */
function localOf(ms) {
  const d = new Date(ms);
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' +
    pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
}

(async () => {
  console.log('\n--- Issue #73: GROUP BY <位置序号> ---');
  const seedAB = async (exec) => {
    await exec('CREATE TABLE t (a INTEGER, b TEXT)');
    await exec("INSERT INTO t (a, b) VALUES (1, 'x'), (1, 'y'), (2, 'z')");
  };

  await t('GROUP BY 1 按第 1 个输出列分组', async ({ exec, rows }) => {
    await seedAB(exec);
    const r = await rows('SELECT a, COUNT(*) FROM t GROUP BY 1 ORDER BY 1');
    return JSON.stringify(r) === JSON.stringify([[1, 2], [2, 1]]);
  });

  await t('GROUP BY 2 按第 2 个输出列分组', async ({ exec, rows }) => {
    await seedAB(exec);
    const r = await rows('SELECT b, COUNT(*) AS c FROM t GROUP BY b ORDER BY 1');
    const r2 = await rows('SELECT COUNT(*) AS c, b FROM t GROUP BY 2 ORDER BY 2');
    return r.length === 3 && r.every(x => x[1] === 1)
        && JSON.stringify(r2.map(x => x[1])) === JSON.stringify(r.map(x => x[0]));
  });

  await t('GROUP BY 位置指向聚合列时明确报错', async ({ exec, errOf }) => {
    await seedAB(exec);
    return /refers to an aggregate/i.test(await errOf('SELECT COUNT(*) AS c FROM t GROUP BY 1'));
  });

  await t('GROUP BY 1 指向表达式列（别名）同样生效', async ({ exec, rows }) => {
    await seedAB(exec);
    const r = await rows('SELECT a % 2 AS p, COUNT(*) FROM t GROUP BY 1 ORDER BY 1');
    return JSON.stringify(r) === JSON.stringify([[0, 1], [1, 2]]);
  });

  await t('GROUP BY 超出输出列数必须报错', async ({ exec, errOf }) => {
    await seedAB(exec);
    return /GROUP BY column index 99 is out of range/i.test(await errOf('SELECT a FROM t GROUP BY 99'));
  });

  await t('GROUP BY 99 / 0 报错且信息可读', async ({ exec, errOf }) => {
    await seedAB(exec);
    const a = await errOf('SELECT a, COUNT(*) FROM t GROUP BY 99');
    const b = await errOf('SELECT a, COUNT(*) FROM t GROUP BY 0');
    return /GROUP BY column index 99 is out of range/i.test(a)
        && /GROUP BY column index 0 is out of range/i.test(b);
  });

  await t('GROUP BY 列名不回归', async ({ exec, rows }) => {
    await seedAB(exec);
    const r = await rows('SELECT a, COUNT(*) FROM t GROUP BY a ORDER BY a');
    return JSON.stringify(r) === JSON.stringify([[1, 2], [2, 1]]);
  });

  console.log('\n--- Issue #74: ORDER BY <越界位置序号> ---');
  await t('ORDER BY 2（只有 1 列）必须报错', async ({ exec, errOf }) => {
    await seedAB(exec);
    return /ORDER BY column index 2 is out of range/i.test(await errOf('SELECT a FROM t ORDER BY 2'));
  });

  await t('GROUP BY 路径里的越界 ORDER BY 同样报错', async ({ exec, errOf }) => {
    await seedAB(exec);
    return /ORDER BY column index 3 is out of range/i.test(
      await errOf('SELECT a, COUNT(*) FROM t GROUP BY 1 ORDER BY 3')
    );
  });

  await t('合法位置序号排序不受影响', async ({ exec, rows }) => {
    await seedAB(exec);
    const r1 = await rows('SELECT a, b FROM t ORDER BY 1 DESC');
    const r2 = await rows('SELECT a, b FROM t ORDER BY 2 DESC');
    return r1[0][0] === 2
        && JSON.stringify(r2.map(x => x[1])) === JSON.stringify(['z', 'y', 'x']);
  });

  await t('ORDER BY 列名 / 表达式不回归', async ({ exec, rows }) => {
    await seedAB(exec);
    const r1 = await rows('SELECT a FROM t ORDER BY a DESC');
    const r2 = await rows('SELECT a, UPPER(b) AS u FROM t ORDER BY u DESC');
    return r1[0][0] === 2 && r2[0][1] === 'Z';
  });

  console.log('\n--- Issue #75: DATETIME ISO-8601 字面量可查回 ---');
  const seedDT = async (exec) => {
    await exec('CREATE TABLE dt (id INTEGER PRIMARY KEY, d DATETIME, s TEXT)');
    await exec("INSERT INTO dt (id, d, s) VALUES (1, '2024-01-15T10:30:00Z', '2024-01-15T10:30:00Z')");
  };

  await t('带 Z 的字面量 insert 后能按同一字面量查回', async ({ exec, rows }) => {
    await seedDT(exec);
    const expected = localOf(Date.UTC(2024, 0, 15, 10, 30, 0));
    const all = await rows('SELECT d FROM dt');
    const hit = await rows("SELECT d FROM dt WHERE d = '2024-01-15T10:30:00Z'");
    return all[0][0] === expected && JSON.stringify(hit) === JSON.stringify([[expected]]);
  });

  await t('无时区标记的 T 分隔字面量能往返（insert → where）', async ({ exec, rows }) => {
    await exec('CREATE TABLE dt2 (id INTEGER PRIMARY KEY, d DATETIME)');
    await exec("INSERT INTO dt2 (id, d) VALUES (1, '2024-01-15T10:30:00')");
    const all = await rows('SELECT d FROM dt2');
    const hit = await rows("SELECT d FROM dt2 WHERE d = '2024-01-15T10:30:00'");
    return all[0][0] === '2024-01-15 10:30:00'
        && JSON.stringify(hit) === JSON.stringify([['2024-01-15 10:30:00']]);
  });

  await t('±HH:MM 偏移字面量同样规范化', async ({ exec, rows }) => {
    await exec('CREATE TABLE dt3 (id INTEGER PRIMARY KEY, d DATETIME)');
    // 2024-01-15T10:30:00+08:00 == 2024-01-15T02:30:00Z
    await exec("INSERT INTO dt3 (id, d) VALUES (1, '2024-01-15T10:30:00+08:00')");
    const stored = localOf(Date.UTC(2024, 0, 15, 2, 30, 0));
    const hit = await rows("SELECT d FROM dt3 WHERE d = '2024-01-15T10:30:00+08:00'");
    const hitZ = await rows("SELECT d FROM dt3 WHERE d = '2024-01-15T02:30:00Z'");
    return JSON.stringify(hit) === JSON.stringify([[stored]])
        && JSON.stringify(hitZ) === JSON.stringify([[stored]]);
  });

  await t('IN 列表里的 ISO 字面量同样生效', async ({ exec, rows }) => {
    await seedDT(exec);
    const expected = localOf(Date.UTC(2024, 0, 15, 10, 30, 0));
    const hit = await rows("SELECT d FROM dt WHERE d IN ('2024-01-15T10:30:00Z')");
    const miss = await rows("SELECT d FROM dt WHERE d IN ('2023-01-01T00:00:00Z')");
    return JSON.stringify(hit) === JSON.stringify([[expected]]) && miss.length === 0;
  });

  await t('TEXT 列仍按原始字符串比较（不被规范化）', async ({ exec, rows }) => {
    await seedDT(exec);
    const hit = await rows("SELECT s FROM dt WHERE s = '2024-01-15T10:30:00Z'");
    const miss = await rows("SELECT s FROM dt WHERE s = '2024-01-15 18:30:00'");
    return JSON.stringify(hit) === JSON.stringify([['2024-01-15T10:30:00Z']]) && miss.length === 0;
  });

  await t('非法日期字面量不抛错、只是不匹配', async ({ exec, rows }) => {
    await seedDT(exec);
    const r = await rows("SELECT d FROM dt WHERE d = 'not-a-date'");
    return r.length === 0;
  });

  console.log('\n--- Issue #76: JOIN 歧义列名 ---');
  const seedJoin = async (exec) => {
    await exec('CREATE TABLE u (id INTEGER PRIMARY KEY, name TEXT)');
    await exec('CREATE TABLE o (id INTEGER PRIMARY KEY, u_id INTEGER, amt INTEGER)');
    await exec("INSERT INTO u (id, name) VALUES (1, 'a'), (2, 'b')");
    await exec('INSERT INTO o (id, u_id, amt) VALUES (10, 1, 5), (11, 2, 7)');
  };

  await t('SELECT 裸 id + ORDER BY 裸 id 报歧义', async ({ exec, errOf }) => {
    await seedJoin(exec);
    return /column reference 'id' is ambiguous/i.test(
      await errOf('SELECT id FROM u JOIN o ON o.u_id = u.id ORDER BY id')
    );
  });

  await t('WHERE 中的裸歧义列也报错（不能静默返回空集）', async ({ exec, errOf }) => {
    await seedJoin(exec);
    return /column reference 'id' is ambiguous/i.test(
      await errOf('SELECT u.id FROM u JOIN o ON o.u_id = u.id WHERE id = 10')
    );
  });

  await t('GROUP BY / ORDER BY 里的裸歧义列也报错', async ({ exec, errOf }) => {
    await seedJoin(exec);
    const a = await errOf('SELECT COUNT(*) FROM u JOIN o ON o.u_id = u.id GROUP BY id');
    const b = await errOf('SELECT COUNT(*) FROM u JOIN o ON o.u_id = u.id ORDER BY id');
    return /column reference 'id' is ambiguous/i.test(a)
        && /column reference 'id' is ambiguous/i.test(b);
  });

  await t('已加表名前缀的查询不受影响', async ({ exec, rows }) => {
    await seedJoin(exec);
    const r = await rows('SELECT u.id, o.id AS oid, u.name FROM u JOIN o ON o.u_id = u.id ORDER BY o.id');
    return JSON.stringify(r) === JSON.stringify([[1, 10, 'a'], [2, 11, 'b']]);
  });

  await t('非歧义裸列 + 单表查询不受影响', async ({ exec, rows }) => {
    await seedJoin(exec);
    const r1 = await rows('SELECT amt FROM u JOIN o ON o.u_id = u.id ORDER BY amt');
    const r2 = await rows('SELECT id FROM u ORDER BY id DESC');
    const r3 = await rows('SELECT * FROM u JOIN o ON o.u_id = u.id');
    return JSON.stringify(r1) === JSON.stringify([[5], [7]])
        && JSON.stringify(r2) === JSON.stringify([[2], [1]])
        && r3.length === 2 && r3[0].length === 5;
  });

  await t('自连接用别名时裸列仍按别名区分（不误报）', async ({ exec, rows }) => {
    await exec('CREATE TABLE emp (id INTEGER PRIMARY KEY, mgr_id INTEGER, name TEXT)');
    await exec("INSERT INTO emp (id, mgr_id, name) VALUES (1, NULL, 'boss'), (2, 1, 'alice')");
    const r = await rows('SELECT e.name AS en, m.name AS mn FROM emp e LEFT JOIN emp m ON e.mgr_id = m.id ORDER BY e.id');
    return r.length === 2 && r[0][0] === 'boss' && r[1][1] === 'boss';
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('💥', e); process.exit(1); });
