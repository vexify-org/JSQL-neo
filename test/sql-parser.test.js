/*
 * test/sql-parser.test.js — SQL 解析与执行回归测试
 *
 * 覆盖 jsql-neo 5.5.0 的：
 *   BUG 修复  : 反引号分号误切分 / RLIKE / TRUE|FALSE 字面量 / 限定列回退
 *   新增语法  : CTE、窗口函数、EXISTS、INTERSECT/EXCEPT、? 占位符、INSERT...SELECT
 *   新增能力  : AST 访问与改写
 *
 * 运行：node test/sql-parser.test.js
 */
const { parseSQL, executeSQL, splitStatements, tokenize, AST } = require('../lib/sql.js');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('[OK]', name); }
  else { fail++; console.log('[FAIL]', name, extra !== undefined ? '→ ' + JSON.stringify(extra) : ''); }
};

const ROWS = [
  { id: 1, dept: 'eng', name: 'a', sal: 100 },
  { id: 2, dept: 'eng', name: 'b', sal: 200 },
  { id: 3, dept: 'ops', name: 'c', sal: 300 },
  { id: 4, dept: 'ops', name: 'd', sal: 300 },
];

const engine = {
  hasTable: () => true,
  truncate: async () => {},
  flush: async () => {},
  find: async () => ROWS.map(r => ({ ...r })),
  getTableSchema: async () => ({
    id: { type: 'integer', primaryKey: true },
    dept: { type: 'string' },
    name: { type: 'string' },
    sal: { type: 'integer' },
  }),
};

const OPTS = { safety: false };
const rowsOf = (r) => (Array.isArray(r) ? r[0] : r).rows;

(async () => {

  /* ================= BUG 1: splitStatements 反引号内的分号 ================= */
  console.log('\n--- BUG 1: 反引号标识符中的分号不再被误切分 ---');
  {
    ok('反引号内含分号只切出 1 条语句',
      splitStatements('SELECT `a;b` FROM t').length === 1,
      splitStatements('SELECT `a;b` FROM t'));
    ok('反引号内容保持完整',
      splitStatements('SELECT `a;b` FROM t')[0] === 'SELECT `a;b` FROM t');
    ok('转义反引号 `` 不提前结束标识符',
      splitStatements('SELECT `a``b;c` FROM t')[0] === 'SELECT `a``b;c` FROM t',
      splitStatements('SELECT `a``b;c` FROM t'));
    ok('普通字符串内的分号仍不被切分（既有行为）',
      splitStatements("SELECT 'a;b'; SELECT 2").length === 2);
    ok('多条语句依旧正常切分',
      splitStatements('SELECT 1; SELECT 2').length === 2);
    ok('反引号列名可正常解析',
      parseSQL('SELECT `a;b` FROM t').columns.length === 1);
  }

  /* ================= BUG 2: RLIKE 方言兼容 ================= */
  console.log('\n--- BUG 2: RLIKE 作为 REGEXP 同义词 ---');
  {
    const ast = parseSQL("SELECT * FROM t WHERE a RLIKE '^x$'");
    ok('RLIKE 解析为 regexp 节点', ast.where.type === 'regexp', ast.where.type);
    const ast2 = parseSQL("SELECT * FROM t WHERE a NOT RLIKE '^x$'");
    ok('NOT RLIKE 带 not 标记', ast2.where.type === 'regexp' && ast2.where.not === true);
    ok('REGEXP 行为未变', parseSQL("SELECT * FROM t WHERE a REGEXP 'x'").where.type === 'regexp');
  }

  /* ================= BUG 3: TRUE / FALSE 字面量 ================= */
  console.log('\n--- BUG 3: TRUE/FALSE 可作为值字面量 ---');
  {
    ok('WHERE a = TRUE 可解析',
      parseSQL('SELECT * FROM t WHERE a = TRUE').where.right.value === true);
    ok('WHERE a = FALSE 可解析',
      parseSQL('SELECT * FROM t WHERE a = FALSE').where.right.value === false);
    ok('IS TRUE 行为未变', parseSQL('SELECT * FROM t WHERE a IS TRUE').where.type === 'isTruth');
    const r = await executeSQL(engine, 'SELECT name FROM emp WHERE 1 = TRUE', OPTS);
    ok('1 = TRUE 求值为真（MySQL 语义）', rowsOf(r).length === ROWS.length, rowsOf(r));
    const r2 = await executeSQL(engine, 'SELECT name FROM emp WHERE 0 = FALSE', OPTS);
    ok('0 = FALSE 求值为真', rowsOf(r2).length === ROWS.length, rowsOf(r2));
  }

  /* ================= BUG 4: 限定列回退到裸列名 ================= */
  console.log('\n--- BUG 4: 未知限定符不再静默回退到裸列名 ---');
  {
    // 相关子查询曾因 e.dept 回退到内层行的 dept 而变成自匹配，EXISTS 恒为真
    const r = await executeSQL(engine,
      'SELECT name FROM emp e WHERE EXISTS (SELECT 1 FROM emp x WHERE x.dept = e.dept AND x.sal > 250)', OPTS);
    ok('相关 EXISTS 只返回匹配外层的行',
      JSON.stringify(rowsOf(r)) === '[["c"],["d"]]', rowsOf(r));
    const r2 = await executeSQL(engine,
      'SELECT name FROM emp e WHERE NOT EXISTS (SELECT 1 FROM emp x WHERE x.dept = e.dept AND x.sal > 250)', OPTS);
    ok('NOT EXISTS 返回补集', JSON.stringify(rowsOf(r2)) === '[["a"],["b"]]', rowsOf(r2));
    // 未加前缀的行（来自子查询投影）仍允许回退，保证既有行为不破
    const r3 = await executeSQL(engine, 'SELECT x.name FROM emp x WHERE x.sal > 250', OPTS);
    ok('限定列正常解析不受影响', JSON.stringify(rowsOf(r3)) === '[["c"],["d"]]', rowsOf(r3));
  }

  /* ================= 新增：CTE ================= */
  console.log('\n--- 新增: WITH CTE ---');
  {
    ok('简单 CTE 可解析', parseSQL('WITH c AS (SELECT * FROM t) SELECT * FROM c').type === 'with');
    ok('RECURSIVE 关键字可解析',
      parseSQL('WITH RECURSIVE c AS (SELECT 1 AS n) SELECT * FROM c').recursive === true);
    ok('多 CTE 可解析', parseSQL('WITH a AS (SELECT * FROM t), b AS (SELECT * FROM a) SELECT * FROM b').ctes.length === 2);
    ok('CTE 列清单可解析',
      parseSQL('WITH c (x, y) AS (SELECT a, b FROM t) SELECT x FROM c').ctes[0].columns.length === 2);
    const r = await executeSQL(engine, "WITH e AS (SELECT * FROM emp WHERE dept = 'ops') SELECT name FROM e", OPTS);
    ok('CTE 执行结果正确', JSON.stringify(rowsOf(r)) === '[["c"],["d"]]', rowsOf(r));
    const r2 = await executeSQL(engine, 'WITH a AS (SELECT * FROM emp), b AS (SELECT * FROM a WHERE sal > 150) SELECT name FROM b', OPTS);
    ok('嵌套 CTE（引用前一个 CTE）', JSON.stringify(rowsOf(r2)) === '[["b"],["c"],["d"]]', rowsOf(r2));
    const r3 = await executeSQL(engine, 'WITH e AS (SELECT * FROM emp) SELECT COUNT(*) AS n FROM e', OPTS);
    ok('CTE + 聚合', JSON.stringify(rowsOf(r3)) === '[[4]]', rowsOf(r3));
    const r4 = await executeSQL(engine, 'WITH t (who, howmuch) AS (SELECT name, sal FROM emp) SELECT who FROM t', OPTS);
    ok('CTE 显式列名清单生效', JSON.stringify(rowsOf(r4)) === '[["a"],["b"],["c"],["d"]]', rowsOf(r4));
  }

  /* ================= 新增：窗口函数 ================= */
  console.log('\n--- 新增: 窗口函数 OVER() ---');
  {
    ok('ROW_NUMBER() OVER 可解析',
      parseSQL('SELECT ROW_NUMBER() OVER (PARTITION BY a ORDER BY b) AS rn FROM t').columns[0].scalar.over != null);
    ok('SUM() OVER 可解析',
      parseSQL('SELECT SUM(a) OVER (PARTITION BY b) AS s FROM t').columns[0].window === true);
    ok('COUNT(*) OVER () 可解析',
      parseSQL('SELECT COUNT(*) OVER () AS c FROM t').columns[0].over != null);
    // AVG 是关键字，走聚合分支 → 窗口定义挂在 columns[0].over 上
    ok('窗口帧 ROWS BETWEEN 可解析',
      parseSQL('SELECT AVG(a) OVER (ORDER BY b ROWS BETWEEN 1 PRECEDING AND CURRENT ROW) AS m FROM t')
        .columns[0].over.frame.unit === 'ROWS');

    // 排序：sal DESC → c(300) d(300) b(200) a(100)
    const rn = await executeSQL(engine, 'SELECT name, ROW_NUMBER() OVER (ORDER BY sal DESC) AS rn FROM emp', OPTS);
    ok('ROW_NUMBER 连续编号', JSON.stringify(rowsOf(rn)) === '[["a",4],["b",3],["c",1],["d",2]]', rowsOf(rn));

    const rk = await executeSQL(engine, 'SELECT name, RANK() OVER (ORDER BY sal DESC) AS rk FROM emp', OPTS);
    ok('RANK 并列跳号', JSON.stringify(rowsOf(rk)) === '[["a",4],["b",3],["c",1],["d",1]]', rowsOf(rk));

    const dr = await executeSQL(engine, 'SELECT name, DENSE_RANK() OVER (ORDER BY sal DESC) AS dr FROM emp', OPTS);
    ok('DENSE_RANK 并列不跳号', JSON.stringify(rowsOf(dr)) === '[["a",3],["b",2],["c",1],["d",1]]', rowsOf(dr));

    const sm = await executeSQL(engine, 'SELECT dept, name, SUM(sal) OVER (PARTITION BY dept) AS tot FROM emp', OPTS);
    ok('SUM() OVER (PARTITION BY)', JSON.stringify(rowsOf(sm)) === '[["eng","a",300],["eng","b",300],["ops","c",600],["ops","d",600]]', rowsOf(sm));

    const ct = await executeSQL(engine, 'SELECT name, COUNT(*) OVER () AS total FROM emp', OPTS);
    ok('COUNT(*) OVER ()', JSON.stringify(rowsOf(ct)) === '[["a",4],["b",4],["c",4],["d",4]]', rowsOf(ct));

    const lg = await executeSQL(engine, 'SELECT name, LAG(sal, 1) OVER (ORDER BY sal) AS prev FROM emp', OPTS);
    ok('LAG 取上一行', JSON.stringify(rowsOf(lg)) === '[["a",null],["b",100],["c",200],["d",300]]', rowsOf(lg));

    const nt = await executeSQL(engine, 'SELECT name, NTILE(2) OVER (ORDER BY sal) AS nt FROM emp', OPTS);
    ok('NTILE 分桶', JSON.stringify(rowsOf(nt)) === '[["a",1],["b",1],["c",2],["d",2]]', rowsOf(nt));

    const fv = await executeSQL(engine, 'SELECT name, FIRST_VALUE(sal) OVER (PARTITION BY dept ORDER BY sal) AS f FROM emp', OPTS);
    ok('FIRST_VALUE 取分区首行', JSON.stringify(rowsOf(fv)) === '[["a",100],["b",100],["c",300],["d",300]]', rowsOf(fv));
  }

  /* ================= 新增：集合运算 ================= */
  console.log('\n--- 新增: INTERSECT / EXCEPT ---');
  {
    ok('INTERSECT 可解析', parseSQL('SELECT * FROM t1 INTERSECT SELECT * FROM t2').intersect != null);
    ok('EXCEPT 可解析', parseSQL('SELECT * FROM t1 EXCEPT SELECT * FROM t2').except != null);
    ok('UNION DISTINCT 可解析', parseSQL('SELECT * FROM t1 UNION DISTINCT SELECT * FROM t2').union != null);

    const is = await executeSQL(engine, 'SELECT dept FROM emp WHERE sal > 100 INTERSECT SELECT dept FROM emp WHERE sal < 300', OPTS);
    ok('INTERSECT 默认去重', JSON.stringify(rowsOf(is)) === '[["eng"]]', rowsOf(is));

    const ex = await executeSQL(engine, 'SELECT dept FROM emp EXCEPT SELECT dept FROM emp WHERE sal < 200', OPTS);
    ok('EXCEPT 默认去重', JSON.stringify(rowsOf(ex)) === '[["ops"]]', rowsOf(ex));

    const un = await executeSQL(engine, "SELECT name FROM emp WHERE dept = 'eng' UNION SELECT name FROM emp WHERE dept = 'ops'", OPTS);
    ok('UNION 去重（既有行为）', rowsOf(un).length === 4, rowsOf(un));
    const ua = await executeSQL(engine, "SELECT name FROM emp WHERE dept = 'eng' UNION ALL SELECT name FROM emp WHERE name = 'a'", OPTS);
    ok('UNION ALL 保留重复', rowsOf(ua).length === 3, rowsOf(ua));
  }

  /* ================= 新增：? 占位符 / INSERT...SELECT ================= */
  console.log('\n--- 新增: ? 占位符 / INSERT ... SELECT ---');
  {
    const paramTok = tokenize('SELECT * FROM t WHERE a = ?').find(t => t.value === null && t.type === 'param');
    ok('? 被词法层识别为 param', !!paramTok, tokenize('SELECT * FROM t WHERE a = ?').map(t => t.type));
    ok('?1 编号占位符', tokenize('SELECT * FROM t WHERE a = ?1').some(t => t.type === 'param' && t.value === 1));
    ok('?? 标识符占位符', tokenize('SELECT * FROM t WHERE a = ??').some(t => t.type === 'param' && t.value === '??'));
    const ast = parseSQL('SELECT * FROM t WHERE a = ?');
    ok('? 生成 param 节点', ast.where.right.type === 'param');
    const r = await executeSQL(engine, 'SELECT name FROM emp WHERE sal > ?', { ...OPTS, params: [150] });
    ok('原生 ? 参数绑定生效', JSON.stringify(rowsOf(r)) === '[["b"],["c"],["d"]]', rowsOf(r));
    const r2 = await executeSQL(engine, 'SELECT name FROM emp WHERE dept = ? OR sal > ?', { ...OPTS, params: ['ops', 250] });
    ok('多个 ? 按序绑定', JSON.stringify(rowsOf(r2)) === '[["c"],["d"]]', rowsOf(r2));
    // applyParams 路径（数组入参）依然有效
    const r3 = await executeSQL(engine, 'SELECT name FROM emp WHERE sal > ?', [150]);
    ok('数组入参走 applyParams 仍有效', JSON.stringify(rowsOf(r3)) === '[["b"],["c"],["d"]]', rowsOf(r3));

    ok('INSERT ... SELECT 可解析', parseSQL('INSERT INTO u SELECT * FROM t').select != null);
  }

  /* ================= 新增：AST 访问与改写 ================= */
  console.log('\n--- 新增: AST 访问与改写 ---');
  {
    const ast = parseSQL('SELECT name, sal FROM emp WHERE sal > 100 ORDER BY sal DESC');
    ok('tables() 列出引用表', JSON.stringify(AST.tables(ast)) === '["emp"]', AST.tables(ast));
    ok('columns() 列出引用列',
      AST.columns(ast).includes('sal') && AST.columns(ast).includes('name'), AST.columns(ast));

    let count = 0;
    AST.walk(ast, () => { count++; });
    ok('walk 遍历到多个节点', count > 3, count);

    const compares = AST.collect(ast, n => n.type === 'compare');
    ok('collect 找出 compare 节点', compares.length === 1, compares.length);

    const found = AST.find(ast, n => n.type === 'column' && n.name === 'sal');
    ok('find 定位指定列', found && found.name === 'sal');

    // 改写：把列名统一改成小写（此处已是小写，改为验证 transform 生效与不可变性）
    const renamed = AST.transform(ast, (n) => {
      if (n && n.type === 'column' && n.name === 'name') return { ...n, name: 'NAME' };
    });
    ok('transform 改写生效', AST.columns(renamed).includes('NAME'), AST.columns(renamed));
    ok('transform 不修改原 AST', AST.columns(ast).includes('name') && !AST.columns(ast).includes('NAME'));

    const ast2 = parseSQL('SELECT name FROM emp WHERE sal > 100');
    AST.rewrite(ast2, (n) => {
      if (n && n.type === 'value' && n.value === 100) return { ...n, value: 250 };
    });
    ok('rewrite 原地改写生效',
      AST.find(ast2, n => n.type === 'value').value === 250);

    class Upper extends AST.StatementVisitor {
      visitColumn(node) { node.name = String(node.name).toUpperCase(); }
    }
    const ast3 = parseSQL('SELECT name FROM emp');
    new Upper().run(ast3);
    ok('StatementVisitor 按类型分派', AST.columns(ast3).includes('NAME'), AST.columns(ast3));
  }

  /* ================= 既有行为回归：新增关键字不得误伤标识符 ================= */
  console.log('\n--- 回归: 新增关键字不得误伤普通标识符 ---');
  {
    for (const col of ['rank', 'row', 'current', 'over', 'window', 'partition', 'unbounded', 'preceding', 'following', 'dense_rank']) {
      let bad = null;
      try { parseSQL(`SELECT ${col} FROM t`); } catch (e) { bad = e.message; }
      ok(`列名为 ${col} 仍可解析`, bad === null, bad);
    }
    ok('表名 with 之外的既有语句不受影响', parseSQL('SELECT * FROM t WHERE a = 1').where.type === 'compare');
    ok('CREATE TABLE 不受影响', parseSQL('CREATE TABLE t (id INTEGER PRIMARY KEY)').type === 'createTable');
    ok('INSERT VALUES 不受影响', parseSQL("INSERT INTO t (a) VALUES (1)").type === 'insert');
    ok('UPDATE 不受影响', parseSQL('UPDATE t SET a = 1').type === 'update');
    ok('DELETE 不受影响', parseSQL('DELETE FROM t WHERE a = 1').type === 'delete');
  }

  /* ================= 边界与错误输入 ================= */
  console.log('\n--- 边界与错误输入应抛出明确错误而非崩溃 ---');
  {
    const bad = ['SELECT', 'SELECT * FROM', 'SELECT * FROM t WHERE', 'FOO BAR', 'SELECT a FROM t WHERE a'];
    for (const sql of bad) {
      let threw = null;
      try { parseSQL(sql); } catch (e) { threw = e; }
      ok(`畸形输入抛出 Error: ${sql}`, threw instanceof Error);
    }
    ok('空语句 parseSQL 返回 null', parseSQL('') === null);
    let threw = null;
    try { parseSQL('SELECT * FROM t WHERE a = ?'); } catch (e) { threw = e; }
    ok('未绑定参数不应在解析期报错', threw === null);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
