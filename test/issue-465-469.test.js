/**
 * Issue #465–#469 回归测试（公共 API / 真实 PG socket / 行存-列存元数据比对）。
 *
 * #465 PG wire：缺列回 42703（undefined_column），非法日期回 22007（invalid_datetime_format）。
 * #466 GROUP_CONCAT(...) OVER (PARTITION BY ...) 按分区逐行返回，不塌缩成整表单行拼接。
 * #467 INTERSECT ALL / EXCEPT ALL 按多重集多重数运算（min(nl,nr) / max(nl-nr,0)）。
 * #468 NATURAL JOIN 按同名公共列等值连接并合并公共列，不退化为笛卡尔积。
 * #469 列存快路径与行存结果列名一致：保留实参与 `*`，不输出 COUNT() 这类无参形式。
 */
const path = require('path');
const net = require('net');

const ROOT = path.join(__dirname, '..');
const { Database, executeSQL } = require(path.join(ROOT, 'index.js'));
const { createPgServer } = require(path.join(ROOT, 'lib', 'pg_server.js'));

let passed = 0, failed = 0;
function ok(name, cond, extra) {
  if (cond) { passed++; console.log('[OK]   ' + name); }
  else { failed++; console.log('[FAIL] ' + name + (extra !== undefined ? ' -> ' + JSON.stringify(extra).slice(0, 160) : '')); }
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/* ---------- #465：极简 PG v3 客户端（真实 socket 帧） ---------- */
function pgStartup() {
  const parts = [Buffer.from('user\0postgres\0'), Buffer.from('database\0app\0'), Buffer.from('\0')];
  const body = Buffer.concat([Buffer.alloc(8), ...parts]);
  body.writeInt32BE(196608, 4);
  body.writeInt32BE(body.length, 0);
  return body;
}
function pgMsg(type, payload) {
  const head = Buffer.alloc(5);
  head[0] = type;
  head.writeInt32BE(4 + payload.length, 1);
  return Buffer.concat([head, payload]);
}
function queryMsg(sql) { return pgMsg(0x51, Buffer.from(sql + '\0', 'utf8')); }
function pgReader(sock) {
  let buf = Buffer.alloc(0);
  const waiters = [];
  sock.on('data', (c) => { buf = Buffer.concat([buf, c]); pump(); });
  function pump() {
    while (waiters.length && buf.length >= 5) {
      const len = buf.readInt32BE(1);
      if (buf.length < 1 + len) break;
      waiters.shift()({ type: buf[0], payload: buf.slice(5, 1 + len) });
      buf = buf.slice(1 + len);
    }
  }
  return {
    read(ms = 300) {
      return new Promise((res) => {
        let done = false;
        const w = (p) => { if (!done) { done = true; clearTimeout(tm); res(p); } };
        const tm = setTimeout(() => { const i = waiters.indexOf(w); if (i >= 0) waiters.splice(i, 1); w(null); }, ms);
        waiters.push(w); pump();
      });
    }
  };
}
function pgErrorFields(p) {
  const b = p.payload, f = {};
  let i = 0;
  while (i < b.length && b[i] !== 0) {
    const k = String.fromCharCode(b[i]);
    const e = b.indexOf(0, i + 1);
    f[k] = b.toString('utf8', i + 1, e);
    i = e + 1;
  }
  return f;
}
async function pgConnect(port) {
  const sock = net.connect(port, '127.0.0.1');
  await new Promise((r) => sock.on('connect', r));
  const rd = pgReader(sock);
  sock.write(pgStartup());
  for (;;) { const p = await rd.read(1500); if (!p || p.type === 0x5a) break; }
  return { sock, rd };
}
async function pgRun(conn, sql) {
  conn.sock.write(queryMsg(sql));
  const errs = [];
  for (;;) {
    const p = await conn.rd.read(300);
    if (!p) break;
    if (p.type === 0x45) errs.push(pgErrorFields(p));
  }
  return errs;
}

(async () => {
  /* ================= #465 PG SQLSTATE（真实 socket） ================= */
  console.log('\n--- #465 缺列 / 非法日期的 SQLSTATE ---');
  const srv = createPgServer({ port: 0, host: '127.0.0.1', dataDir: ':memory:', noAuth: true });
  await new Promise((r) => srv.listen(r));
  try {
    const conn = await pgConnect(srv._server.address().port);
    await pgRun(conn, 'CREATE TABLE t (id int primary key, name text, dt date)');
    await pgRun(conn, "INSERT INTO t VALUES (1,'a','2024-01-01')");

    const missing = await pgRun(conn, 'SELECT nope FROM t');
    ok('缺列回 42703（undefined_column）',
      missing.length === 1 && /^42703$/.test(missing[0].C), missing);

    const badDate = await pgRun(conn, "INSERT INTO t VALUES (2,'b','notadate')");
    ok('非法日期回 22007（invalid_datetime_format）',
      badDate.length === 1 && /^22007$/.test(badDate[0].C), badDate);

    conn.sock.end();
  } finally {
    srv.close();
  }

  /* ================= #466 GROUP_CONCAT 窗口逐分区返回 ================= */
  console.log('\n--- #466 GROUP_CONCAT ... OVER (PARTITION BY ...) ---');
  {
    const db = new Database(':memory:');
    await executeSQL(db, 'CREATE TABLE g (id INT, dept TEXT, sal INT)');
    await executeSQL(db, "INSERT INTO g VALUES (1,'x',100),(2,'x',200),(3,'y',150),(4,'y',250)");
    const res = await executeSQL(db,
      'SELECT dept, GROUP_CONCAT(sal) OVER (PARTITION BY dept) g FROM g ORDER BY id');
    ok('窗口拼接返回 4 行（未塌缩成单行）', res.rows.length === 4, res.rows);
    ok('各分区逐行返回对应拼接值',
      eq(res.rows, [['x', '100,200'], ['x', '100,200'], ['y', '150,250'], ['y', '150,250']]),
      res.rows);

    const sep = await executeSQL(db,
      'SELECT dept, GROUP_CONCAT(sal SEPARATOR "|") OVER (PARTITION BY dept) g FROM g ORDER BY id LIMIT 2');
    ok('SEPARATOR 在窗口分区内生效', eq(sep.rows, [['x', '100|200'], ['x', '100|200']]), sep.rows);
    await db.stop();
  }

  /* ================= #467 INTERSECT ALL / EXCEPT ALL 多重集 ================= */
  console.log('\n--- #467 多重集多重数运算 ---');
  {
    const db = new Database(':memory:');
    await executeSQL(db, 'CREATE TABLE a (v INT)');
    await executeSQL(db, 'INSERT INTO a VALUES (1),(1),(1),(2)');
    await executeSQL(db, 'CREATE TABLE b (v INT)');
    await executeSQL(db, 'INSERT INTO b VALUES (1)');

    const iAll = await executeSQL(db, 'SELECT v FROM a INTERSECT ALL SELECT v FROM b');
    ok('INTERSECT ALL 取 min(nl,nr)：1 左 3 右 1 → 保留 1 个', eq(iAll.rows, [[1]]), iAll.rows);

    const eAll = await executeSQL(db, 'SELECT v FROM a EXCEPT ALL SELECT v FROM b');
    ok('EXCEPT ALL 取 max(nl-nr,0)：剩 2 个 1 + 1 个 2', eq(eAll.rows, [[1], [1], [2]]), eAll.rows);

    // 对照：非 ALL 版本仍按集合去重
    const iSet = await executeSQL(db, 'SELECT v FROM a INTERSECT SELECT v FROM b');
    ok('INTERSECT（去重）保持集合语义', eq(iSet.rows, [[1]]), iSet.rows);
    const eSet = await executeSQL(db, 'SELECT v FROM a EXCEPT SELECT v FROM b');
    ok('EXCEPT（去重）保持集合语义', eq(eSet.rows, [[2]]), eSet.rows);
    await db.stop();
  }

  /* ================= #468 NATURAL JOIN 等值连接 + 列合并 ================= */
  console.log('\n--- #468 NATURAL JOIN ---');
  {
    const db = new Database(':memory:');
    await executeSQL(db, 'CREATE TABLE x (id INT, v TEXT)');
    await executeSQL(db, 'CREATE TABLE y (id INT, w TEXT)');
    await executeSQL(db, "INSERT INTO x VALUES (1,'a'),(2,'b')");
    await executeSQL(db, "INSERT INTO y VALUES (1,'c'),(3,'d')");

    const res = await executeSQL(db, 'SELECT * FROM x NATURAL JOIN y');
    ok('NATURAL JOIN 仅等值匹配 id=1 的一行', eq(res.rows, [[1, 'a', 'c']]), res.rows);
    const idCols = res.columns.filter((c) => c === 'id' || c.endsWith('.id'));
    ok('公共列 id 合并为一份（不重复输出）', idCols.length === 1, res.columns);

    const explicit = await executeSQL(db, 'SELECT x.id, x.v, y.w FROM x NATURAL JOIN y');
    ok('显式列引用下等值连接结果正确', eq(explicit.rows, [[1, 'a', 'c']]), explicit.rows);
    await db.stop();
  }

  /* ================= #469 列存 / 行存结果列名一致 ================= */
  console.log('\n--- #469 列存快路径列头与行存一致 ---');
  {
    const db = new Database(':memory:', { autoSave: false });
    await executeSQL(db, 'CREATE TABLE c (id INT, v INT, s TEXT, dept TEXT)');
    await executeSQL(db, "INSERT INTO c VALUES (1,10,'a','x'),(2,20,'b','y'),(3,NULL,NULL,'z')");

    const sqlAgg = 'SELECT COUNT(v), COUNT(*), MIN(s), MAX(s), SUM(v) FROM c';
    const rowAgg = await executeSQL(db, sqlAgg);
    db.convertToColumnar('c');
    const colAgg = await executeSQL(db, sqlAgg);
    ok('未别名聚合列头两路径一致（保留实参 / *）',
      eq(rowAgg.columns, colAgg.columns), { row: rowAgg.columns, col: colAgg.columns });
    ok('聚合值两路径一致', eq(rowAgg.rows, colAgg.rows), { row: rowAgg.rows, col: colAgg.rows });

    const sqlGrp = 'SELECT dept, COUNT(*) c FROM c GROUP BY dept';
    const rowGrp = await executeSQL(db, sqlGrp);
    const colGrp = await executeSQL(db, sqlGrp);
    ok('GROUP BY 聚合列头两路径一致', eq(rowGrp.columns, colGrp.columns),
      { row: rowGrp.columns, col: colGrp.columns });
    await db.stop();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
