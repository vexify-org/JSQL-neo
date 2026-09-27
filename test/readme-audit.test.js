/**
 * README 一致性回归测试
 *
 * 背景：README 里承诺的语法与实际解析器长期脱节。曾出现过 40 条文档示例
 * 跑不通（占 16%），以及 GROUP_CONCAT 能解析但静默返回 null 这类
 * 「不报错但结果错」的问题。本测试把 README 当成契约来校验：
 *   1. 所有 ```sql 代码块里的语句都必须能解析
 *   2. 新增语法必须真的能执行出正确结果（而不只是解析通过）
 *   3. 顶层导出的工厂函数不得出现 undefined
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { parseSQL, splitStatements } = require('../lib/sql.js');
const { executeSQL } = require('../lib/sql.js');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('[OK]   ' + name); }
  else { fail++; console.log('[FAIL] ' + name + (extra !== undefined ? ' → ' + JSON.stringify(extra) : '')); }
}

const README = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8').split(/\r?\n/);

function extractSqlBlocks() {
  const blocks = [];
  let inBlock = false, lang = '', start = 0, buf = [];
  README.forEach((line, i) => {
    const m = /^```([a-zA-Z]*)\s*$/.exec(line);
    if (!inBlock && m) { inBlock = true; lang = m[1]; start = i + 1; buf = []; return; }
    if (inBlock && /^```\s*$/.test(line)) {
      inBlock = false;
      if (lang === 'sql') blocks.push({ start: start + 1, text: buf.join('\n') });
      return;
    }
    if (inBlock) buf.push(line);
  });
  return blocks;
}

const isGrammar = (t) => /[\[\]{}]/.test(t) || /\|/.test(t) ||
  /\bselect_list\b|\btable_reference\b|\bcolumn_list\b/.test(t);

const OPTS = { safety: false };

async function main() {
  console.log('--- README 中所有 SQL 示例都必须可解析 ---');
  {
    const blocks = extractSqlBlocks();
    const failures = [];
    let total = 0;
    for (const b of blocks) {
      if (isGrammar(b.text)) continue;
      let stmts;
      try { stmts = splitStatements(b.text); } catch (e) { continue; }
      for (const s of stmts) {
        if (!s || /^[-#]/.test(s)) continue;
        if (!/^\(?\s*(select|with|insert|update|delete|create|drop|alter|truncate|show|describe|desc|use|set|begin|commit|rollback|explain|pragma|replace|savepoint|release|start)\b/i.test(s)) continue;
        total++;
        try { parseSQL(s); } catch (e) { failures.push({ line: b.start, sql: s.slice(0, 90), err: e.message }); }
      }
    }
    ok(`README SQL 语句全部可解析（共 ${total} 条）`, failures.length === 0, failures.slice(0, 5));
  }

  console.log('\n--- 新增语法必须能执行出正确结果（不只是解析通过）---');
  {
    const emp = [
      { id: 1, dept: 'eng', name: 'a', sal: 100, flag: 1 },
      { id: 2, dept: 'eng', name: 'b', sal: 200, flag: 0 },
      { id: 3, dept: 'ops', name: 'c', sal: 300, flag: 1 },
      { id: 4, dept: 'ops', name: 'd', sal: 400, flag: 3 },
    ];
    const engine = {
      hasTable: () => true, truncate: async () => {}, flush: async () => {},
      find: async () => emp.map(r => ({ ...r })),
      getTableSchema: async () => ({
        id: { type: 'integer', primaryKey: true }, dept: { type: 'string' },
        name: { type: 'string' }, sal: { type: 'integer' }, flag: { type: 'integer' },
      }),
    };
    const rowsOf = async (sql) => {
      const r = await executeSQL(engine, sql, OPTS);
      return (Array.isArray(r) ? r[0] : r).rows;
    };

    // 位运算与取模：词法层曾不产出这些 token，parseTerm 的 % 分支是死代码
    ok('取模 %', JSON.stringify(await rowsOf('SELECT 10 % 3 AS r')) === '[[1]]');
    ok('左移 <<', JSON.stringify(await rowsOf('SELECT 1 << 8 AS r')) === '[[256]]');
    ok('按位与 &', JSON.stringify(await rowsOf('SELECT 255 & 15 AS r')) === '[[15]]');
    ok('按位取反 ~', JSON.stringify(await rowsOf('SELECT ~0 AS r')) === '[[-1]]');
    ok('WHERE 中位运算过滤',
      JSON.stringify(await rowsOf('SELECT name FROM emp WHERE flag & 1 = 1')) === '[["a"],["c"],["d"]]');

    // 函数实参曾不接受比较运算符，IF 系列全挂
    ok("IF(1 > 0, 'yes', 'no')",
      JSON.stringify(await rowsOf("SELECT IF(1 > 0, 'yes', 'no') AS r")) === '[["yes"]]');
    ok('SUM(IF(...)) 按条件求和',
      JSON.stringify(await rowsOf('SELECT SUM(IF(sal > 150, sal, 0)) AS r FROM emp')) === '[[900]]');

    // DISTINCT 聚合
    ok('COUNT(DISTINCT col)',
      JSON.stringify(await rowsOf('SELECT COUNT(DISTINCT dept) AS r FROM emp')) === '[[2]]');
    ok('COUNT(DISTINCT a, b) 多列',
      JSON.stringify(await rowsOf('SELECT COUNT(DISTINCT dept, sal) AS r FROM emp')) === '[[4]]');

    // GROUP_CONCAT：曾能解析但静默返回 null
    ok('GROUP_CONCAT 默认分隔符',
      JSON.stringify(await rowsOf('SELECT GROUP_CONCAT(name) AS g FROM emp')) === '[["a,b,c,d"]]');
    ok('GROUP_CONCAT ORDER BY 生效（曾静默不排序）',
      JSON.stringify(await rowsOf('SELECT GROUP_CONCAT(name ORDER BY sal DESC) AS g FROM emp')) === '[["d,c,b,a"]]');
    ok('GROUP_CONCAT 自定义分隔符',
      JSON.stringify(await rowsOf('SELECT GROUP_CONCAT(name, "|") AS g FROM emp')) === '[["a|b|c|d"]]');

    // 日期：INTERVAL / EXTRACT
    ok('DATE_ADD + INTERVAL',
      JSON.stringify(await rowsOf("SELECT DATE_ADD('2026-08-12', INTERVAL 1 DAY) AS r")) === '[["2026-08-13"]]');
    ok('DATE_ADD 保留时间部分',
      JSON.stringify(await rowsOf("SELECT DATE_ADD('2026-08-12 10:00:00', INTERVAL 2 HOUR) AS r")) === '[["2026-08-12 12:00:00"]]');
    ok('INTERVAL 负数',
      JSON.stringify(await rowsOf("SELECT DATE_ADD('2026-08-12', INTERVAL -1 DAY) AS r")) === '[["2026-08-11"]]');
    ok('DATE_SUB', JSON.stringify(await rowsOf("SELECT DATE_SUB('2026-08-12', INTERVAL 1 WEEK) AS r")) === '[["2026-08-05"]]');
    ok('EXTRACT(YEAR FROM ...)',
      JSON.stringify(await rowsOf("SELECT EXTRACT(YEAR FROM '2026-08-12') AS r")) === '[[2026]]');

    // 字符串：标准 FROM / FOR 形式
    ok('SUBSTR(s FROM n FOR m)',
      JSON.stringify(await rowsOf("SELECT SUBSTR('abcdef' FROM 2 FOR 3) AS r")) === '[["bcd"]]');
    ok("TRIM('x' FROM s)", JSON.stringify(await rowsOf("SELECT TRIM('x' FROM 'xxhixx') AS r")) === '[["hi"]]');
    ok("TRIM(LEADING 'x' FROM s)", JSON.stringify(await rowsOf("SELECT TRIM(LEADING 'x' FROM 'xxhi') AS r")) === '[["hi"]]');

    // WITH ROLLUP 必须能在 HAVING 之前解析（曾放错位置导致带 HAVING 就报错）
    ok('GROUP BY ... WITH ROLLUP HAVING',
      JSON.stringify(await rowsOf('SELECT dept, COUNT(*) AS cnt FROM emp GROUP BY dept WITH ROLLUP HAVING cnt >= 1'))
        === '[["eng",2],["ops",2],[null,4]]');

    // FROM 子查询缺少别名时自动补（README 示例本身就没写别名）
    ok('FROM (SELECT ...) 无别名',
      JSON.stringify(await rowsOf('SELECT name FROM (SELECT name, sal FROM emp WHERE sal > 150)')) === '[["b"],["c"],["d"]]');
  }

  console.log('\n--- DDL / 解析器节点覆盖 ---');
  {
    ok('CREATE INDEX 可解析', parseSQL('CREATE INDEX i ON t (a)').type === 'createIndex');
    ok('CREATE UNIQUE INDEX 可解析', parseSQL('CREATE UNIQUE INDEX i ON t (a)').unique === true);
    ok('DROP INDEX 可解析', parseSQL('DROP INDEX i ON t').type === 'dropIndex');
    ok('FULL OUTER JOIN 可解析',
      parseSQL('SELECT * FROM a FULL OUTER JOIN b ON a.id = b.id').from.joins[0].type === 'full');
    ok('CAST 带长度可解析', parseSQL('SELECT CAST(a AS VARCHAR(10)) FROM t').columns[0].scalar.type === 'cast');
    ok('FETCH FIRST 可解析', parseSQL('SELECT * FROM t FETCH FIRST 7 ROWS ONLY').limit === 7);
    ok('ILIKE 可解析', parseSQL("SELECT * FROM t WHERE a ILIKE 'x'").where.ci === true);
    ok('DELETE ... LIMIT 可解析', parseSQL('DELETE FROM t WHERE a = 1 LIMIT 5').limit === 5);
    ok('ON CONFLICT DO UPDATE 可解析',
      parseSQL('INSERT INTO t (a) VALUES (1) ON CONFLICT (a) DO UPDATE SET a = 2').onConflict.action === 'update');
    ok('DEFAULT CURRENT_TIMESTAMP 可解析', (() => {
      const st = parseSQL('CREATE TABLE t (id INT PRIMARY KEY, c DATETIME DEFAULT CURRENT_TIMESTAMP)');
      return st.schema.c.default === 'CURRENT_TIMESTAMP';
    })());
  }

  console.log('\n--- 顶层工厂导出不得为 undefined ---');
  {
    const jsql = require('../index.js');
    for (const n of ['createMysqlServer', 'createPgServer', 'createRedisServer',
      'createMongoServer', 'createMultiServer', 'createTUI']) {
      ok(`导出 ${n}`, typeof jsql[n] === 'function');
    }
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(1); });
