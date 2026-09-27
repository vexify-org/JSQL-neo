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

  console.log('\n--- 方言特性：DIV / XOR / && / || / <=> / :: / -> ->> / LIKE ESCAPE ---');
  {
    const data = [
      { id: 1, n: 10, flag: 1, s: '100%', nm: 'Alice', meta: '{"name":"Alice","addr":{"city":"SH"},"tags":["x","y"]}' },
      { id: 2, n: 20, flag: 0, s: '1000', nm: 'Bob', meta: '{"name":"Bob","addr":{"city":"BJ"},"tags":[]}' },
      { id: 3, n: 30, flag: 1, s: '100', nm: 'Cara', meta: null },
    ];
    const engine = {
      hasTable: () => true, truncate: async () => {}, flush: async () => {},
      find: async () => data.map(r => ({ ...r })),
      getTableSchema: async () => ({
        id: { type: 'integer', primaryKey: true }, n: { type: 'integer' }, flag: { type: 'integer' },
        s: { type: 'string' }, nm: { type: 'string' }, meta: { type: 'json' },
      }),
    };
    const rowsOf = async (sql) => {
      const r = await executeSQL(engine, sql, OPTS);
      return (Array.isArray(r) ? r[0] : r).rows;
    };

    ok('DIV 整数除法', JSON.stringify(await rowsOf('SELECT 7 DIV 2 AS r')) === '[[3]]');
    ok('DIV 负数向零取整', JSON.stringify(await rowsOf('SELECT -7 DIV 2 AS r')) === '[[-3]]');
    ok("'5'::INT 类型转换", JSON.stringify(await rowsOf("SELECT '5'::INT AS r")) === '[[5]]');
    ok('XOR 逻辑异或（WHERE）',
      JSON.stringify(await rowsOf('SELECT id FROM tbl WHERE flag = 1 XOR n = 20')) === '[[1],[2],[3]]');
    ok('&& 是 AND 别名',
      JSON.stringify(await rowsOf('SELECT id FROM tbl WHERE flag = 1 && n > 10')) === '[[3]]');
    ok('|| 是 OR 别名',
      JSON.stringify(await rowsOf('SELECT id FROM tbl WHERE flag = 0 || n > 20')) === '[[2],[3]]');
    ok('<=> 非空相等', JSON.stringify(await rowsOf('SELECT id FROM tbl WHERE n <=> 20')) === '[[2]]');
    ok('<=> NULL 安全（NULL<=>NULL 为真）',
      JSON.stringify(await rowsOf('SELECT id FROM tbl WHERE meta <=> NULL')) === '[[3]]');
    ok("->>'name'", JSON.stringify(await rowsOf("SELECT meta->>'name' AS x FROM tbl WHERE id = 1")) === '[["Alice"]]');
    ok("->'addr'->>'city' 链式",
      JSON.stringify(await rowsOf("SELECT meta->'addr'->>'city' AS x FROM tbl WHERE id = 1")) === '[["SH"]]');
    ok("->'tags'->>0 数组下标",
      JSON.stringify(await rowsOf("SELECT meta->'tags'->>0 AS x FROM tbl WHERE id = 1")) === '[["x"]]');
    // PG JSON 包含 / 路径操作符
    ok("meta @> '{...}' 包含",
      JSON.stringify(await rowsOf(`SELECT id FROM tbl WHERE meta @> '{"addr":{"city":"SH"}}'`)) === '[[1]]');
    ok("'{...}' <@ meta 被包含",
      JSON.stringify(await rowsOf(`SELECT id FROM tbl WHERE '{"name":"Bob"}' <@ meta`)) === '[[2]]');
    ok("meta#>'{addr,city}' 路径",
      JSON.stringify(await rowsOf("SELECT meta#>'{addr,city}' AS x FROM tbl WHERE id = 1")) === '[["SH"]]');
    ok("meta#>>'{addr,city}' 路径文本",
      JSON.stringify(await rowsOf("SELECT meta#>>'{addr,city}' AS x FROM tbl WHERE id = 1")) === '[["SH"]]');
    ok("meta#>'{tags,0}' 路径含下标",
      JSON.stringify(await rowsOf("SELECT meta#>'{tags,0}' AS x FROM tbl WHERE id = 1")) === '[["x"]]');
    // JSON 键存在 ? / ?| / ?&
    ok("meta ? 'name'", JSON.stringify(await rowsOf("SELECT id FROM tbl WHERE meta ? 'name'")) === '[[1],[2]]');
    ok("meta ? 'nope'（不存在）",
      JSON.stringify(await rowsOf("SELECT id FROM tbl WHERE meta ? 'nope'")) === '[]');
    ok("meta ?| '{name,nope}'（任一）",
      JSON.stringify(await rowsOf("SELECT id FROM tbl WHERE meta ?| '{name,nope}'")) === '[[1],[2]]');
    ok("meta ?& '{name,addr}'（全部）",
      JSON.stringify(await rowsOf("SELECT id FROM tbl WHERE meta ?& '{name,addr}'")) === '[[1],[2]]');
    ok("meta ?& '{name,nope}'（缺一个）",
      JSON.stringify(await rowsOf("SELECT id FROM tbl WHERE meta ?& '{name,nope}'")) === '[]');
    // PG 正则：~ 敏感 / ~* 不敏感 / !~ 取反
    ok("nm ~ '^A' 大小写敏感", JSON.stringify(await rowsOf("SELECT id FROM tbl WHERE nm ~ '^A'")) === '[[1]]');
    ok("nm ~* '^a' 不敏感", JSON.stringify(await rowsOf("SELECT id FROM tbl WHERE nm ~* '^a'")) === '[[1]]');
    ok("nm !~ '^A' 取反", JSON.stringify(await rowsOf("SELECT id FROM tbl WHERE nm !~ '^A'")) === '[[2],[3]]');
    ok('REGEXP 仍可用', JSON.stringify(await rowsOf("SELECT id FROM tbl WHERE nm REGEXP '^A'")) === '[[1]]');
    ok("LIKE ... ESCAPE '!' 匹配字面量 %",
      JSON.stringify(await rowsOf("SELECT id FROM tbl WHERE s LIKE '100!%' ESCAPE '!'")) === '[[1]]');
    ok('LIKE 反斜杠转义匹配字面量 %',
      JSON.stringify(await rowsOf("SELECT id FROM tbl WHERE s LIKE '100\\%'")) === '[[1]]');
    ok('LIKE 普通 % 仍为通配',
      JSON.stringify(await rowsOf("SELECT id FROM tbl WHERE s LIKE '100%'")) === '[[1],[2],[3]]');

    // 参数绑定：位置 ? / 命名 :name / 编号 $1（README「Params」一节）
    const rowsOfP = async (sql, params) => {
      const r = await executeSQL(engine, sql, params, OPTS);
      return (Array.isArray(r) ? r[0] : r).rows;
    };
    ok('位置参数 ?', JSON.stringify(await rowsOfP('SELECT id FROM tbl WHERE id = ?', [1])) === '[[1]]');
    ok('命名参数 :id', JSON.stringify(await rowsOfP('SELECT id FROM tbl WHERE id = :id', { id: 2 })) === '[[2]]');
    ok('命名参数多占位', JSON.stringify(await rowsOfP('SELECT id FROM tbl WHERE id = :a OR id = :b', { a: 1, b: 3 })) === '[[1],[3]]');
    ok('编号参数 $1', JSON.stringify(await rowsOfP('SELECT id FROM tbl WHERE id = $1', [3])) === '[[3]]');
    ok('编号参数 $2/$1', JSON.stringify(await rowsOfP('SELECT id FROM tbl WHERE id = $2 OR id = $1', [1, 2])) === '[[1],[2]]');
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
    ok('SERIAL 折叠为整型+自增', (() => {
      const st = parseSQL('CREATE TABLE t (id SERIAL PRIMARY KEY, n TEXT)');
      return st.schema.id.type === 'integer' && st.schema.id.autoIncrement === true;
    })());
    ok('BIGSERIAL 折叠为整型+自增', (() => {
      const st = parseSQL('CREATE TABLE t (id BIGSERIAL PRIMARY KEY)');
      return st.schema.id.type === 'integer' && st.schema.id.autoIncrement === true;
    })());
  }

  console.log('\n--- executeSQL 结果信封（README 承诺的字段）---');
  {
    const engine = {
      hasTable: () => true, truncate: async () => {}, flush: async () => {},
      find: async () => [{ id: 1, name: 'a' }, { id: 2, name: 'b' }],
      getTableSchema: async () => ({ id: { type: 'integer', primaryKey: true }, name: { type: 'string' } }),
    };
    const r = await executeSQL(engine, 'SELECT * FROM t', OPTS);
    for (const f of ['columns', 'columnTypes', 'rows', 'rowCount', 'affectedRows', 'message', 'command', 'durationMs', 'warnings']) {
      ok(`信封含 ${f}`, r[f] !== undefined, Object.keys(r));
    }
    ok('rowCount = 2', r.rowCount === 2);
    ok('command = SELECT', r.command === 'SELECT');
    ok('columnTypes 可推断（id → INT）', Array.isArray(r.columnTypes) && r.columnTypes[0] === 'INT');
  }

  console.log('\n--- 顶层工厂导出不得为 undefined ---');
  {
    const jsql = require('../index.js');
    for (const n of ['createMysqlServer', 'createPgServer', 'createRedisServer',
      'createMongoServer', 'createMultiServer', 'createTUI']) {
      ok(`导出 ${n}`, typeof jsql[n] === 'function');
    }
  }

  console.log('\n--- 子路径导出（README 里写的 require 路径必须真能引到）---');
  {
    const mod = require('../package.json');
    const exportsMap = mod.exports || {};
    ok('exports 暴露 ./lib/plugins 目录入口', !!exportsMap['./lib/plugins']);
    try {
      const plugins = require('../lib/plugins/index.js');
      ok('lib/plugins 可加载且导出工厂函数', typeof plugins.createTimestamps === 'function');
    } catch (e) {
      ok('lib/plugins 可加载', false, e.message);
    }
  }

  console.log('\n--- 数据正确性：查不存在的列必须报错（曾静默返回 null）---');
  {
    const engine = {
      hasTable: () => true, truncate: async () => {}, flush: async () => {},
      find: async () => [{ id: 1, name: 'a', dept: 'eng' }],
      getTableSchema: async () => ({
        id: { type: 'integer', primaryKey: true }, name: { type: 'string' }, dept: { type: 'string' },
      }),
    };
    const expectErr = async (sql) => {
      let threw = null;
      try { await executeSQL(engine, sql, OPTS); } catch (e) { threw = e; }
      return threw;
    };
    ok('SELECT 不存在的列报错', !!(await expectErr('SELECT nosuchcol FROM t')));
    ok('SELECT 混有不存在列时报错', !!(await expectErr('SELECT id, nope FROM t')));
    ok('WHERE 引用不存在列报错', !!(await expectErr('SELECT id FROM t WHERE ghost = 1')));
    ok('GROUP BY 不存在列报错', !!(await expectErr('SELECT COUNT(*) AS c FROM t GROUP BY ghost')));
    // 不能误伤：正常查询与聚合别名都要放行
    let normal = null;
    try { await executeSQL(engine, 'SELECT id, UPPER(name) FROM t', OPTS); } catch (e) { normal = e; }
    ok('正常查询不受影响', normal === null, normal && normal.message);
    let aliasOk = null;
    try {
      await executeSQL(engine, 'SELECT dept, COUNT(*) AS cnt FROM t GROUP BY dept HAVING cnt >= 1', OPTS);
    } catch (e) { aliasOk = e; }
    ok('HAVING 引用 SELECT 别名不报错', aliasOk === null, aliasOk && aliasOk.message);
    let subOk = null;
    try { await executeSQL(engine, 'SELECT id FROM t WHERE id IN (SELECT id FROM t)', OPTS); } catch (e) { subOk = e; }
    ok('子查询内部列名不误判', subOk === null, subOk && subOk.message);
  }

  console.log('\n--- 并发 insert 不得重复写（曾行数暴涨 / 丢失）---');
  {
    // 两个引擎都要验收：曾只测 wasm，导致 native（默认引擎）的同款竞态长期漏网。
    for (const engineName of ['wasm_client', 'native_client']) {
      let JSQL, db;
      try {
        ({ JSQL } = require('../lib/' + engineName + '.js'));
        db = new JSQL();
        await db.start();
      } catch (e) {
        console.log(`[SKIP] ${engineName} 不可用：` + e.message.slice(0, 60));
        continue;
      }
      const tag = `[${engineName}]`;
      let id = 0;
      await db.createTable('conc', { id: { type: 'INT', primaryKey: true }, b: { type: 'INT' } });
      await Promise.all(Array.from({ length: 200 }, () => db.insert('conc', { id: ++id, b: 5 })));
      const cnt = await db.count('conc');
      ok(`${tag} 并发 insert 200 行 → count 恰为 200（实际 ${cnt}）`, cnt === 200);

      // flush 失败不得把坏行留在 buffer 里二次爆炸
      ok(`${tag} insert(null) 抛 TypeError`, await (async () => {
        try { await db.insert('conc', null); return false; } catch (e) { return e instanceof TypeError; }
      })());
      ok(`${tag} insert(undefined) 抛 TypeError`, await (async () => {
        try { await db.insert('conc', undefined); return false; } catch (e) { return e instanceof TypeError; }
      })());
      ok(`${tag} insert(非对象) 抛 TypeError`, await (async () => {
        try { await db.insert('conc', 42); return false; } catch (e) { return e instanceof TypeError; }
      })());

      // 环形对象：应给可读错误，而不是 "Converting circular structure" 裸崩
      await db.createTable('cyc', { id: { type: 'INT', primaryKey: true }, meta: { type: 'JSON' } });
      const cyc = { self: null };
      cyc.self = cyc;
      let cycErr = null;
      try { await db.insert('cyc', { id: 1, meta: cyc }); } catch (e) { cycErr = e; }
      ok(`${tag} 环形对象给出带表/列名的错误`,
        !!cycErr && /Cannot serialize column 'meta'/.test(cycErr.message),
        cycErr && cycErr.message);
      await db.stop();
    }
  }

  console.log('\n--- 唯一约束：非主键 UNIQUE 必须报 ER_DUP_ENTRY ---');
  {
    let JSQL, db;
    try {
      ({ JSQL } = require('../lib/native_client.js'));
      db = new JSQL();
      await db.start();
    } catch (e) {
      console.log('[SKIP] native 不可用：' + e.message.slice(0, 60));
    }
    if (db) {
      const run = (sql) => executeSQL(db, sql, OPTS);
      const dupErrMsg = async (sql) => {
        try { await run(sql); return null; } catch (e) { return e.message; }
      };
      await run('CREATE TABLE u (id SERIAL PRIMARY KEY, email TEXT UNIQUE, nick TEXT UNIQUE)');
      await run("INSERT INTO u (email, nick) VALUES ('a@x.com', 'a')");
      ok('唯一列重复 → ER_DUP_ENTRY',
        /ER_DUP_ENTRY/.test(await dupErrMsg("INSERT INTO u (email, nick) VALUES ('a@x.com', 'z')") || ''));
      ok('批内唯一重复 → ER_DUP_ENTRY',
        /ER_DUP_ENTRY/.test(await dupErrMsg("INSERT INTO u (email, nick) VALUES ('b@x.com', 'n1'), ('c@x.com', 'n1')") || ''));
      const r1 = await run('SELECT id FROM u');
      ok('冲突后仍只有 1 行', r1.rows.length === 1, r1.rows);
      await run("INSERT INTO u (email, nick) VALUES (NULL, 'x'), (NULL, 'y')");
      const r2 = await run('SELECT id FROM u');
      ok('UNIQUE 允许多个 NULL', r2.rows.length === 3, r2.rows);
      await db.stop();
    }
  }

  console.log('\n--- Redis：RESP2 帧解析（曾 inline 命令恒为 unknown command）---');
  {
    const { RedisServer } = require('../lib/redis_server.js');
    const s = new RedisServer({ port: 0 });
    const p = (raw) => s._parse(Buffer.from(raw, 'utf8'));

    ok('RESP 数组 PING', JSON.stringify((p('*1\r\n$4\r\nPING\r\n') || {}).cmd) === '"PING"');
    ok('RESP SET foo bar',
      JSON.stringify((p('*3\r\n$3\r\nSET\r\n$3\r\nfoo\r\n$3\r\nbar\r\n') || {}).args) === '["foo","bar"]');
    // 曾经这里返回数组，导致 switch(cmd) 永远匹配不上
    ok('inline 命令 cmd 是字符串', (p('PING\r\n') || {}).cmd === 'PING');
    ok('inline 带参数', JSON.stringify((p('SET k v\r\n') || {}).args) === '["k","v"]');
    ok('*0 不崩溃', (p('*0\r\n') || {}).ignore === true);
    ok('*-1 不崩溃', (p('*-1\r\n') || {}).ignore === true);
    // $N 是字节长度：按字符切片会把多字节值截断
    const cn = p('*3\r\n$3\r\nSET\r\n$2\r\nk1\r\n$12\r\n中文测试\r\n');
    ok('多字节 UTF-8 按字节解析', JSON.stringify(cn && cn.args) === '["k1","中文测试"]');
    ok('不完整帧返回 null（等待续包）', p('*3\r\n$3\r\nSET\r\n') === null);
    ok('null bulk $-1', JSON.stringify((p('*2\r\n$3\r\nGET\r\n$-1\r\n') || {}).args) === '[null]');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(1); });
