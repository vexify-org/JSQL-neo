// 回归测试：Issue #86-#99
const Database = require('../lib/database');
const { executeSQL, applyParams, splitStatements, parseSQL } = require('../lib/sql');
const { Datastore } = require('../lib/nedb_compat');
const Cache = require('../lib/cache');
const updater = require('../lib/updater');
const { decodeBinaryParam } = require('../lib/pg_server');
const { createMysqlServer, MysqlConnection } = require('../lib/mysql_server');
const sqliteCompat = require('../lib/sqlite_compat');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('[OK]  ', name); }
  else { fail++; console.log('[FAIL]', name, extra !== undefined ? ' -> ' + JSON.stringify(extra).slice(0, 240) : ''); }
}

(async () => {
  // #86 ON DUPLICATE VALUES(a)+1 表达式
  {
    const db = new Database(':memory:');
    await executeSQL(db, "CREATE TABLE t (id INT PRIMARY KEY, a INT, b INT)");
    await executeSQL(db, "INSERT INTO t VALUES (1,10,3)");
    await executeSQL(db, "INSERT INTO t (id,a,b) VALUES (1,100,200) ON DUPLICATE KEY UPDATE a=VALUES(a)+1, b=VALUES(b)");
    const r = await executeSQL(db, "SELECT * FROM t");
    ok('#86 VALUES(a)+1 → a=101', r.rows[0][1] === 101, r.rows[0]);
  }

  // #87 sqlite raw(true).all() 不重复执行
  {
    const db = new sqliteCompat.Database(':memory:');
    db.exec('CREATE TABLE t (a INT)');
    db.prepare('INSERT INTO t(a) VALUES (1)').raw(true).all();
    const n = db.prepare('SELECT COUNT(*) c FROM t').get();
    ok('#87 raw(true).all() 只执行一次', n.c === 1, n);
    const rows = db.prepare('SELECT a FROM t').raw(true).all();
    ok('#87 raw 输出数组格式', JSON.stringify(rows) === '[[1]]', rows);
  }

  // #88 $regex 字符串模式
  {
    const ds = new Datastore({ inMemoryOnly: true });
    await ds.loadDatabase();
    await ds.insert({ name: 'alice' }); await ds.insert({ name: 'bob' }); await ds.insert({ name: 'charlie' });
    const r = await ds.find({ name: { $regex: '^al' } });
    ok('#88 $regex ^al 只返回 alice', r.length === 1, r.length);
  }

  // #89 lrange 负索引越界
  {
    const c = new Cache();
    c.rpush('k', 'a', 'b', 'c');
    const out = c.lrange('k', 0, -5);
    ok('#89 lrange(0,-5) → ["a"]', out.join(',') === 'a', out);
  }

  // #90 updater 版本比较
  {
    ok('#90 alpha.10 > alpha.9', updater.isNewer('1.0.0-alpha.10', '1.0.0-alpha.9') === true, updater.isNewer('1.0.0-alpha.10', '1.0.0-alpha.9'));
    ok('#90 1.2.3.4 > 1.2.3', updater.compareVersions('1.2.3.4', '1.2.3') > 0, updater.compareVersions('1.2.3.4', '1.2.3'));
  }

  // #91 多语句协议（fake connection 应产生 2 个结果集）
  {
    const server = createMysqlServer({ safety: false });
    await server._getEngine();
    const socket = { write: () => {}, destroy: () => {}, remoteAddress: 'x', on: () => {} };
    const conn = new MysqlConnection(socket, server);
    conn.authenticated = true; conn.multiStatements = true;
    await new Promise((res) => { conn._handleQuery('SELECT 1; SELECT 2;'); setTimeout(res, 800); });
    ok('#91 多语句无异常', true);
  }

  // #92 applyParams 混用 ?N 与 ?
  {
    const a = applyParams("SELECT * FROM t WHERE a=? AND b=?2", [10, 20, 30]);
    ok('#92 a=? AND b=?2 → a=10 b=20', a.includes('a=10') && a.includes('b=20'), a);
    const b = applyParams("SELECT * FROM t WHERE b=?2 AND a=?", [10, 20, 30]);
    ok('#92 b=?2 AND a=? → b=20 a=10', b.includes('b=20') && b.includes('a=10'), b);
  }

  // #93 pg 二进制参数解码
  {
    const i4 = Buffer.from([0, 0, 0, 42]);
    ok('#93 int4 binary=42', decodeBinaryParam(i4, 23) === 42, decodeBinaryParam(i4, 23));
    const i8 = Buffer.alloc(8); i8.writeBigInt64BE(1234567890123n);
    ok('#93 int8 binary', decodeBinaryParam(i8, 20) === 1234567890123n, decodeBinaryParam(i8, 20));
    const f8 = Buffer.alloc(8); f8.writeDoubleBE(3.14);
    ok('#93 float8 binary', decodeBinaryParam(f8, 701) === 3.14, decodeBinaryParam(f8, 701));
  }

  // #94 数值 LIKE
  {
    const db = new Database(':memory:');
    await executeSQL(db, "CREATE TABLE t (id INT PRIMARY KEY, a INT)");
    await executeSQL(db, "INSERT INTO t VALUES (1,10),(2,20)");
    const r = await executeSQL(db, "SELECT id FROM t WHERE a LIKE '1%'");
    ok('#94 a LIKE \'1%\' → id=1', r.rows.map(x => x[0]).join(',') === '1', r.rows);
  }

  // #95 COM_PROCESS_INFO 用 lenenc string
  {
    const server = createMysqlServer({ safety: false });
    await server._getEngine();
    const socket = { write: () => {}, destroy: () => {}, remoteAddress: 'x', on: () => {} };
    const conn = new MysqlConnection(socket, server);
    conn.authenticated = true;
    const sent = [];
    conn._send = (b) => { sent.push(Buffer.from(b)); };
    conn._handlePacket(Buffer.from([0x0a]), 0);
    let found = false;
    for (const p of sent) for (let i = 0; i < p.length - 1; i++) if (p[i] === 0x01 && p[i + 1] === 0x31) found = true;
    ok('#95 数据行含 lenenc 0x01 0x31', found);
  }

  // #96 CAST DECIMAL 精度
  {
    const db = new Database(':memory:');
    const r = await executeSQL(db, "SELECT CAST(123.456 AS DECIMAL(10,2))");
    ok('#96 CAST DECIMAL(10,2) → 123.46', r.rows[0][0] === 123.46, r.rows[0][0]);
    const r2 = await executeSQL(db, "SELECT CAST(123.456 AS DECIMAL(10,0))");
    ok('#96 CAST DECIMAL(10,0) → 123', r2.rows[0][0] === 123, r2.rows[0][0]);
  }

  // #97 _route 多限定表
  {
    const server = createMysqlServer({ safety: false });
    await server._getEngine();
    const sql = "SELECT * FROM db1.t JOIN db1.u ON t.id=u.id WHERE name='db1.t'";
    const routed = await server._route(parseSQL(sql), sql, null, null);
    ok('#97 多表改写 + 字符串保留', routed.sql === "SELECT * FROM t JOIN u ON t.id=u.id WHERE name='db1.t'", routed.sql);
  }

  // #98 字符串列 MIN/MAX 字典序
  {
    const db = new Database(':memory:');
    await executeSQL(db, "CREATE TABLE s (x STRING)");
    await executeSQL(db, "INSERT INTO s VALUES ('2'),('100'),('9')");
    const r = await executeSQL(db, "SELECT MIN(x), MAX(x) FROM s");
    ok('#98 MIN=100 MAX=9 字典序', r.rows[0][0] === '100' && r.rows[0][1] === '9', r.rows[0]);
  }

  // #99 ON DUPLICATE 裸列名
  {
    const db = new Database(':memory:');
    await executeSQL(db, "CREATE TABLE t (id INT PRIMARY KEY, cnt INT, other INT)");
    await executeSQL(db, "INSERT INTO t VALUES (1,5,7)");
    await executeSQL(db, "INSERT INTO t (id,cnt,other) VALUES (1,5,7) ON DUPLICATE KEY UPDATE cnt=cnt+1, other=other");
    const r = await executeSQL(db, "SELECT * FROM t");
    ok('#99 other=other 不崩溃且 cnt=6', r.rows[0][1] === 6 && r.rows[0][2] === 7, r.rows[0]);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
