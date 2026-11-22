/*
 * Regression tests for issues #188-#237.
 *   node test/issue-188-237.test.js
 *
 * MySQL / PG blocks run only when the corresponding driver is installed;
 * the repo itself has no runtime dependency on them.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const { Database, executeSQL, migrate } = require(path.join(ROOT, 'index.js'));
const { createRedisServer } = require(path.join(ROOT, 'lib', 'redis_server.js'));
const { createMongoServer } = require(path.join(ROOT, 'lib', 'mongo_server.js'));
const SqliteDatabase = require(path.join(ROOT, 'lib', 'sqlite_compat.js'));
const { Datastore } = require(path.join(ROOT, 'lib', 'nedb_compat.js'));

let passed = 0, failed = 0;
function ok(name, cond, extra) {
  if (cond) { passed++; console.log('[OK]', name); }
  else { failed++; console.log('[FAIL]', name, extra !== undefined ? '→ ' + JSON.stringify(extra) : ''); }
}
const q = (db, sql) => db.query(sql, { safety: false });
const rows = async (db, sql) => (await q(db, sql)).rows;

function optionalRequire(name) {
  try { return require(path.join(ROOT, 'node_modules', name)); } catch (e) { return null; }
}

async function sqlCases() {
  // #197
  {
    const db = new Database(':memory:');
    await q(db, 'CREATE TABLE t (id INT PRIMARY KEY, v TEXT)');
    await q(db, "INSERT INTO t VALUES (1,'a')");
    await q(db, "ALTER TABLE t ADD COLUMN w TEXT DEFAULT 'dw'");
    await q(db, 'INSERT INTO t (id) VALUES (2)');
    const r = await rows(db, 'SELECT id,v,w FROM t ORDER BY id');
    ok('#197 ALTER ADD COLUMN DEFAULT backfills and applies', JSON.stringify(r) === JSON.stringify([[1, 'a', 'dw'], [2, null, 'dw']]), r);
    db.stop();
  }
  // #198
  {
    const db = new Database(':memory:');
    await q(db, 'CREATE TABLE t (a INT, b INT, v TEXT, PRIMARY KEY (a,b))');
    await q(db, "INSERT INTO t VALUES (1,1,'x')");
    let err = null;
    try { await q(db, "INSERT INTO t VALUES (2,1,'y')"); } catch (e) { err = e.message; }
    const r = await rows(db, 'SELECT a,b,v FROM t ORDER BY a');
    ok('#198 composite PK allows distinct tuples', err === null && r.length === 2, { err, r });
    let dup = null;
    try { await q(db, "INSERT INTO t VALUES (1,1,'z')"); } catch (e) { dup = e.message; }
    ok('#198 composite PK rejects duplicate tuple', !!dup, dup);
    db.stop();
  }
  // #199
  {
    const db = new Database(':memory:');
    await q(db, 'CREATE TABLE t (id INT PRIMARY KEY, v TEXT, w INT)');
    await q(db, "INSERT INTO t VALUES (1,'a',7)");
    await q(db, 'BEGIN'); await q(db, 'ALTER TABLE t ADD COLUMN extra TEXT'); await q(db, 'ROLLBACK');
    await q(db, 'BEGIN'); await q(db, 'ALTER TABLE t DROP COLUMN w'); await q(db, 'ROLLBACK');
    const schema = await db.getTableSchema('t');
    const r = await rows(db, 'SELECT * FROM t');
    ok('#199 DDL rolls back with transaction', JSON.stringify(Object.keys(schema)) === JSON.stringify(['id', 'v', 'w']) && r[0][2] === 7, { keys: Object.keys(schema), r });
    db.stop();
  }
  // #200
  {
    const db = new Database(':memory:');
    await q(db, 'CREATE TABLE p (id INT PRIMARY KEY)');
    await q(db, 'CREATE TABLE c (id INT PRIMARY KEY, pid INT REFERENCES p(id))');
    await q(db, 'INSERT INTO p VALUES (1)'); await q(db, 'INSERT INTO c VALUES (1,1)');
    let err = null;
    try { await q(db, 'DROP TABLE p'); } catch (e) { err = e.message; }
    ok('#200 DROP TABLE checks FK references', !!err && (await db.getTables()).includes('p'), err);
    db.stop();
  }
  // #201
  {
    const db = new Database(':memory:');
    await q(db, 'CREATE TABLE t (id INT PRIMARY KEY, v TEXT NOT NULL)');
    let err = null;
    try { await q(db, "INSERT INTO t VALUES (1,'a'),(2,NULL),(3,'c')"); } catch (e) { err = e.message; }
    const r = await rows(db, 'SELECT id FROM t');
    ok('#201 multi-row INSERT is atomic', !!err && r.length === 0, { err, r });
    db.stop();
  }
  // #202 / #203
  {
    const db = new Database(':memory:');
    await q(db, 'CREATE TABLE a (x INT, y INT)'); await q(db, 'INSERT INTO a VALUES (1,2),(3,4)');
    await q(db, 'CREATE TABLE b (x INT)');
    let e1 = null, e2 = null, e3 = null;
    try { await q(db, 'INSERT INTO b SELECT x,y FROM a'); } catch (e) { e1 = e.code; }
    await q(db, 'CREATE TABLE t (id INT, v TEXT, w INT)');
    try { await q(db, "INSERT INTO t VALUES (1,'x')"); } catch (e) { e2 = e.code; }
    try { await q(db, "INSERT INTO t (id,v,w) VALUES (1,'x')"); } catch (e) { e3 = e.code; }
    ok('#202 INSERT SELECT column count mismatch', e1 === 1136, e1);
    ok('#203 INSERT VALUES count mismatch', e2 === 1136 && e3 === 1136, [e2, e3]);
    db.stop();
  }
  // #204
  {
    const db = new Database(':memory:');
    await q(db, 'CREATE TABLE t (id INT PRIMARY KEY, v TEXT)'); await q(db, "INSERT INTO t VALUES (1,'orig')");
    db.begin('READ_COMMITTED');
    await q(db, "UPDATE t SET v='changed' WHERE id=1"); await q(db, "INSERT INTO t VALUES (2,'x')");
    db.rollback();
    const r = await rows(db, 'SELECT id,v FROM t ORDER BY id');
    ok('#204 READ_COMMITTED rollback restores rows', JSON.stringify(r) === JSON.stringify([[1, 'orig']]), r);
    db.stop();
  }
  // #205
  {
    const db = new Database(':memory:');
    await q(db, 'CREATE TABLE t (a INT, b INT, v TEXT, UNIQUE (a,b))');
    await q(db, "INSERT INTO t VALUES (1,2,'x')");
    let err = null;
    try { await q(db, "INSERT INTO t VALUES (1,3,'y')"); } catch (e) { err = e.message; }
    await q(db, "INSERT INTO t VALUES (1,NULL,'z')");
    const r = await rows(db, 'SELECT v FROM t ORDER BY v');
    ok('#205 table-level composite UNIQUE', err === null && r.length === 3, { err, r });
    db.stop();
  }
  // #206
  {
    const db = new Database(':memory:');
    await q(db, 'CREATE TABLE p (id INT PRIMARY KEY)');
    await q(db, 'CREATE TABLE c (id INT PRIMARY KEY, pid INT REFERENCES p(id))');
    await q(db, 'INSERT INTO p VALUES (1)'); await q(db, 'INSERT INTO c VALUES (1,1)');
    let err = null;
    try { await q(db, 'TRUNCATE TABLE p'); } catch (e) { err = e.code; }
    ok('#206 TRUNCATE checks FK references', err === 1701, err);
    db.stop();
  }
  // #207
  {
    const db = new Database(':memory:');
    await q(db, 'CREATE TABLE t (id INT PRIMARY KEY, e TEXT)'); await q(db, "INSERT INTO t VALUES (1,'a'),(2,'a')");
    let err = null;
    try { await q(db, 'CREATE UNIQUE INDEX idx_e ON t(e)'); } catch (e) { err = e.message; }
    ok('#207 unique index rejects existing duplicates', !!err, err);
    db.stop();
  }
  // #208
  {
    const db = new Database(':memory:');
    await q(db, 'CREATE TABLE t (id INT PRIMARY KEY, a INT, b INT)'); await q(db, 'INSERT INTO t VALUES (1,10,20)');
    await q(db, 'UPDATE t SET a=a+1, b=a WHERE id=1');
    const r = await rows(db, 'SELECT a,b FROM t');
    ok('#208 UPDATE assignments evaluated left-to-right', JSON.stringify(r) === JSON.stringify([[11, 11]]), r);
    db.stop();
  }
  // #229-#233
  {
    const db = new Database(':memory:');
    const v = async (s) => (await q(db, s)).rows[0][0];
    ok('#229 IF uses SQL truthiness', await v("SELECT IF('0','a','b')") === 'b' && await v("SELECT IF('0.0','a','b')") === 'b');
    ok('#230 REGEXP NULL is UNKNOWN', await v("SELECT NULL REGEXP 'a'") === null && await v("SELECT 'abc' REGEXP NULL") === null && await v("SELECT NULL NOT REGEXP 'a'") === null);
    ok('#231 REPLACE NULL/empty semantics', await v("SELECT REPLACE('abc',NULL,'X')") === null && await v("SELECT REPLACE('abc','b',NULL)") === null && await v("SELECT REPLACE('abc','','X')") === 'abc');
    ok('#232 TRIM(str, chars) arg order', await v("SELECT TRIM('xax','x')") === 'a' && await v("SELECT TRIM('xxaxx','x')") === 'a');
    db.stop();
  }
  {
    const db = new Database(':memory:');
    await q(db, 'CREATE TABLE u (id INTEGER PRIMARY KEY, b BOOLEAN)');
    await q(db, 'CREATE TABLE t (id INTEGER PRIMARY KEY, b BOOLEAN)');
    await q(db, 'INSERT INTO u (id,b) VALUES (1,true),(2,false),(3,true),(4,false),(5,true)');
    await q(db, 'INSERT INTO t (id,b) VALUES (1,true),(2,false),(3,true),(4,false),(5,true)');
    db.convertToColumnar('t');
    const a = await rows(db, 'SELECT b, COUNT(*) FROM u GROUP BY b ORDER BY b');
    const b = await rows(db, 'SELECT b, COUNT(*) FROM t GROUP BY b ORDER BY b');
    ok('#233 columnar boolean group keys normalized', JSON.stringify(a) === JSON.stringify(b), { a, b });
    db.stop();
  }
  // #234
  {
    const db = new Database(':memory:');
    await q(db, 'CREATE TABLE t (id INTEGER PRIMARY KEY, a INTEGER, b TEXT)');
    await q(db, 'CREATE UNIQUE INDEX uq_ab ON t(a,b)');
    await q(db, "INSERT INTO t (id,a,b) VALUES (1,1,'x')");
    await q(db, "INSERT INTO t (id,a,b) VALUES (2,1,'y')");
    let err = null;
    try { await q(db, "UPDATE t SET b='x' WHERE id=2"); } catch (e) { err = e.message; }
    ok('#234 composite unique enforced on UPDATE', !!err, err);
    db.stop();
  }
  // #235 / #236
  {
    const db = new Database(':memory:');
    await q(db, "CREATE TABLE t (id INTEGER PRIMARY KEY, s TEXT, n INTEGER)");
    await q(db, "INSERT INTO t (id,s,n) VALUES (1,'',NULL),(2,'hello',42),(3,NULL,0)");
    const csv = await migrate.exportTableToCSV(db, 't');
    const db2 = new Database(':memory:');
    await q(db2, 'CREATE TABLE t (id INTEGER PRIMARY KEY, s TEXT, n INTEGER)');
    await migrate.importFromCSV(db2, 't', csv);
    const r = await rows(db2, 'SELECT id,s,n FROM t ORDER BY id');
    ok('#235 CSV distinguishes empty string and NULL', JSON.stringify(r) === JSON.stringify([[1, '', null], [2, 'hello', 42], [3, null, 0]]), r);
    const db3 = new Database(':memory:');
    await q(db3, 'CREATE TABLE b (id INTEGER PRIMARY KEY, n INTEGER)');
    await migrate.importFromCSV(db3, 'b', 'id,n\n1,9007199254740993\n');
    const big = (await rows(db3, 'SELECT n FROM b'))[0][0];
    ok('#235 CSV keeps >2^53 integers exact', String(big) === '9007199254740993', String(big));
    db.stop(); db2.stop(); db3.stop();
  }
  {
    const db = new Database(':memory:');
    await db.createTable('t', { id: { type: 'integer', primaryKey: true }, big: { type: 'bigint' } });
    await db.insert('t', { id: 1, big: 9223372036854775807n });
    const out = path.join(os.tmpdir(), 'jsql-json-' + Date.now() + '.json');
    let err = null;
    try { await migrate.exportToFile(db, 't', out); } catch (e) { err = e.message; }
    const db2 = new Database(':memory:');
    if (!err) {
      await db2.createTable('t', { id: { type: 'integer', primaryKey: true }, big: { type: 'bigint' } });
      await migrate.importFromJSON(db2, fs.readFileSync(out, 'utf8'), { overwrite: true });
    }
    const r = err ? [] : await rows(db2, 'SELECT big FROM t');
    ok('#236 JSON export handles BigInt', err === null && r.length === 1 && String(r[0][0]) === '9223372036854775807', { err, r });
    db.stop(); db2.stop();
  }
  // #237
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsql-torn-'));
    const file = path.join(dir, 'db.json');
    const db = new Database(file, { autoSave: false });
    await q(db, 'CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
    await db.insert('t', { id: 1, v: 'one' }); await db.insert('t', { id: 2, v: 'two' }); db.save();
    await db.insert('t', { id: 3, v: 'three' });
    const snap = fs.readFileSync(file, 'utf8');
    fs.writeFileSync(file, snap.slice(0, Math.floor(snap.length / 2)));
    const orig = console.error; console.error = () => {};
    let err = null, r = null;
    try { const db2 = new Database(file); r = await rows(db2, 'SELECT id,v FROM t ORDER BY id'); db2.stop(); } catch (e) { err = e.message; }
    console.error = orig;
    ok('#237 torn snapshot falls back to WAL', err === null && r.some(x => x[0] === 3), { err, r });
    db.stop();
  }
}

async function cliCases() {
  const BIN = path.join(ROOT, 'bin', 'jsql');
  const r1 = spawnSync('node', [BIN, 'bench', '--n', '5', '--json'], {
    env: { ...process.env, JSQL_OFFLINE: '1', JSQL_NO_STAR_NAG: '1' }, encoding: 'utf8', cwd: os.tmpdir(),
  });
  let parsed = null;
  try { parsed = JSON.parse(r1.stdout.trim()); } catch (e) { parsed = null; }
  ok('#188 bench --json rows is number', parsed && typeof parsed.rows === 'number', r1.stdout.slice(0, 120));

  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'jsql-home-'));
  const r2 = spawnSync('node', [BIN, 'bench', '--n', '3', '--json'], {
    env: { ...process.env, HOME: fakeHome, JSQL_OFFLINE: '1' }, encoding: 'utf8', cwd: os.tmpdir(),
  });
  let jsonOk = true;
  try { JSON.parse(r2.stdout); } catch (e) { jsonOk = false; }
  ok('#189 --json stdout is clean JSON', jsonOk, r2.stdout.slice(0, 80));
}

function sqliteCases() {
  const db = new SqliteDatabase(':memory:');
  db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)');
  db.prepare('INSERT INTO t (id,name) VALUES (?,?)').run(1, 'b');
  let err = null;
  try { db.prepare('SELECT id FROM t WHERE name = ?').get({ name: 'b' }); } catch (e) { err = e.code; }
  ok('#195 anonymous ? rejects object binding', err === 'SQLITE_RANGE', err);
  db.close();

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlite-ro-'));
  const f = path.join(dir, 'ro.db.json');
  const w = new SqliteDatabase(f);
  w.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
  w.prepare("INSERT INTO t VALUES (1,'x')").run();
  w.close();
  const ro = new SqliteDatabase(f, { readonly: true });
  let werr = null, derr = null;
  try { ro.prepare("INSERT INTO t VALUES (2,'y')").run(); } catch (e) { werr = e.code; }
  try { ro.exec('CREATE TABLE z (a INT)'); } catch (e) { derr = e.code; }
  const cnt = ro.prepare('SELECT COUNT(*) c FROM t').get().c;
  ok('#196 readonly rejects writes', werr === 'SQLITE_READONLY' && derr === 'SQLITE_READONLY' && cnt === 1, { werr, derr, cnt });
  ro.close();
}

async function redisCases() {
  const srv = createRedisServer({ port: 0, dataDir: null });
  const call = (cmd, ...args) => {
    try { return { value: srv.execute(cmd, args) }; } catch (e) { return { error: e.message }; }
  };
  // #225 binary safety over real RESP frames
  await new Promise((resolve) => srv.listen(resolve));
  const port = srv.server.address().port;
  const sock = net.connect(port, '127.0.0.1');
  await new Promise((resolve) => sock.on('connect', resolve));
  const frames = [];
  sock.on('data', (c) => frames.push(c));
  const raw = Buffer.from([0x00, 0xff, 0x0a, 0x41, 0x00, 0xe4, 0xbd]);
  const setFrame = Buffer.concat([
    Buffer.from('*3\r\n$3\r\nSET\r\n$3\r\nbin\r\n$' + raw.length + '\r\n'), raw, Buffer.from('\r\n'),
  ]);
  sock.write(setFrame);
  sock.write(Buffer.from('*2\r\n$3\r\nGET\r\n$3\r\nbin\r\n'));
  await new Promise((resolve) => setTimeout(resolve, 150));
  const out = Buffer.concat(frames);
  const marker = out.indexOf('$7\r\n');
  ok('#225 Redis bulk strings are binary safe', marker >= 0 && out.slice(marker + 4, marker + 11).equals(raw), out.toString('hex'));
  sock.end();
  srv.stop();

  ok('#226 HSET prototype-named fields counted', (() => {
    const s = createRedisServer({ port: 0, dataDir: null });
    return [callOn(s, 'HSET', 'h', 'constructor', '1'), callOn(s, 'HSET', 'h', 'toString', '2')].every(x => x === 1);
  })());
  {
    const s = createRedisServer({ port: 0, dataDir: null });
    s.execute('SET', ['num', '5']);
    const inc = callOn(s, 'INCRBY', 'num', '1abc');
    s.execute('SET', ['exp', '1']);
    const exp = callOn(s, 'EXPIRE', 'exp', '1abc');
    ok('#227 INCRBY/EXPIRE reject trailing garbage', /not an integer/.test(String(inc)) && /not an integer/.test(String(exp)), { inc, exp });
  }
  {
    const s = createRedisServer({ port: 0, dataDir: null });
    for (const k of ['foo1', 'foo2', 'foo3', 'fooz']) s.execute('SET', [k, '1']);
    const keys = s.execute('KEYS', ['foo[12]']);
    ok('#228 KEYS supports [abc] globs', JSON.stringify(keys.sort()) === JSON.stringify(['foo1', 'foo2']), keys);
  }
}
function callOn(s, cmd, ...args) {
  try { return s.execute(cmd, args); } catch (e) { return 'ERR:' + e.message; }
}

async function mongoCases() {
  const mongo = createMongoServer({ dataDir: ':memory:' });
  const dispatch = (cmd, doc) => mongo._dispatch(cmd, doc);
  // seed
  await dispatch('insert', { insert: 'c216', documents: [{ n: 1, owner: { city: 'NY' } }, { n: 2, owner: { city: 'LA' } }], $db: 'test' });
  const d216 = await dispatch('distinct', { distinct: 'c216', key: 'owner.city', $db: 'test' });
  ok('#216 distinct dot-notation', JSON.stringify(d216.values.sort()) === JSON.stringify(['LA', 'NY']), d216.values);

  await dispatch('insert', { insert: 'c217', documents: [{ bio: 'line1\nline2' }], $db: 'test' });
  const f217 = await dispatch('find', { find: 'c217', filter: { bio: { $regex: '^line2', $options: 'm' } }, $db: 'test' });
  ok('#217 $regex m flag', f217.cursor.firstBatch.length === 1, f217.cursor.firstBatch.length);

  await dispatch('insert', { insert: 'c218', documents: [{ a: 1, b: 2 }], $db: 'test' });
  await dispatch('findAndModify', { findAndModify: 'c218', query: { a: 1 }, update: { c: 3 }, new: true, $db: 'test' });
  const f218 = await dispatch('find', { find: 'c218', filter: {}, $db: 'test' });
  const d218 = f218.cursor.firstBatch[0] || {};
  ok('#218 findAndModify replaces document', d218.c === 3 && !('a' in d218) && !('b' in d218), d218);

  await dispatch('insert', { insert: 'c219', documents: [{ n: 10, owner: { city: 'NY' } }, { n: 30, owner: { city: 'NY', zip: 10001 } }], $db: 'test' });
  const f219 = await dispatch('find', { find: 'c219', filter: { owner: { city: 'NY' } }, $db: 'test' });
  ok('#219 embedded document equality is exact', f219.cursor.firstBatch.length === 1 && f219.cursor.firstBatch[0].n === 10, f219.cursor.firstBatch);

  await dispatch('insert', { insert: 'c220', documents: [{ arr: [1], nil: null }], $db: 'test' });
  const t1 = await dispatch('find', { find: 'c220', filter: { arr: { $type: 'array' } }, $db: 'test' });
  const t2 = await dispatch('find', { find: 'c220', filter: { nil: { $type: 'null' } }, $db: 'test' });
  ok('#220 $type array/null', t1.cursor.firstBatch.length === 1 && t2.cursor.firstBatch.length === 1, [t1.cursor.firstBatch.length, t2.cursor.firstBatch.length]);

  await dispatch('createIndexes', { createIndexes: 'c221', indexes: [{ key: { email: 1 }, name: 'email_1', unique: true }], $db: 'test' });
  await dispatch('insert', { insert: 'c221', documents: [{ email: 'a@x.com' }], $db: 'test' });
  const dup221 = await dispatch('insert', { insert: 'c221', documents: [{ email: 'a@x.com' }], $db: 'test' });
  ok('#221 unique index enforced', dup221.n === 0 && dup221.writeErrors && dup221.writeErrors[0].code === 11000, dup221);

  const unk = await dispatch('notARealCommand', { $db: 'test' });
  ok('#222 unknown command returns code 59', unk.ok === 0 && unk.code === 59, unk);

  await dispatch('insert', { insert: 'c223', documents: [{ a: 1, b: 2 }], $db: 'test' });
  await dispatch('update', { update: 'c223', updates: [{ q: { a: 1 }, u: { $unset: { b: '' } } }], $db: 'test' });
  const f223 = await dispatch('find', { find: 'c223', filter: {}, $db: 'test' });
  ok('#223 $unset removes key', !('b' in f223.cursor.firstBatch[0]), f223.cursor.firstBatch[0]);

  await dispatch('update', { update: 'c224', updates: [{ q: { name: 'x' }, u: { $inc: { n: 1 } }, upsert: true }], $db: 'test' });
  const f224 = await dispatch('find', { find: 'c224', filter: {}, $db: 'test' });
  const doc224 = f224.cursor.firstBatch[0];
  ok('#224 upsert evaluates modifiers', doc224 && doc224.n === 1 && !('$inc' in doc224), doc224);
}

async function mysqlCases() {
  const mysql = optionalRequire('mysql2/promise');
  if (!mysql) { console.log('[SKIP] MySQL protocol tests (mysql2 not installed)'); return; }
  const { createMysqlServer } = require(path.join(ROOT, 'lib', 'mysql_server.js'));
  const srv = createMysqlServer({ port: 0, host: '127.0.0.1', dataDir: ':memory:', noAuth: true });
  await new Promise((r) => srv.listen(r));
  const conn = await mysql.createConnection({ host: '127.0.0.1', port: srv.address.port, user: 'root', database: 'app', multipleStatements: true });
  await conn.query('CREATE TABLE t (id BIGINT, name VARCHAR(50))');
  await conn.query("INSERT INTO t VALUES (4000000000, '张三 😀')");
  const [text, tf] = await conn.query('SELECT id,name FROM t');
  const [bin, bf] = await conn.execute('SELECT id,name FROM t');
  ok('#209 BIGINT text/binary protocol', text[0].id === 4000000000 && bin[0].id === 4000000000 && tf[0].type === 8 && bf[0].type === 8, { text, bin, type: tf[0].type });
  ok('#211 execute without params matches query', JSON.stringify(bin) === JSON.stringify(text), { text, bin });
  ok('#212 utf8mb4 emoji round-trip', text[0].name === '张三 😀' && tf[1].characterSet === 45, { name: text[0].name, cs: tf[1].characterSet });
  const [multi] = await conn.query('SELECT 1 AS a; SELECT 2 AS b');
  ok('#210 multi-result sets preserved', multi.length === 2 && multi[1][0].b === 2, multi);
  await conn.end();
  srv.close();
}

async function pgCases() {
  const { Client } = optionalRequire('pg') || {};
  if (!Client) { console.log('[SKIP] PG protocol tests (pg not installed)'); return; }
  const { createPgServer } = require(path.join(ROOT, 'lib', 'pg_server.js'));
  const srv = createPgServer({ port: 0, host: '127.0.0.1', dataDir: ':memory:', noAuth: true });
  await new Promise((r) => srv.listen(r));
  const c = new Client({ host: '127.0.0.1', port: srv.address.port, user: 'root', database: 'app' });
  await c.connect();
  await c.query('CREATE TABLE tx (id INT, v INT)');
  await c.query('BEGIN');
  let aborted = null, insErr = null;
  try { await c.query('SELECT * FROM no_such_table'); } catch (e) { aborted = e.code; }
  try { await c.query('INSERT INTO tx VALUES (1,100)'); } catch (e) { insErr = e.code; }
  ok('#213 aborted transaction rejects further commands', aborted === '42P01' && insErr === '25P02', { aborted, insErr });
  await c.query('ROLLBACK');
  await c.query('CREATE TABLE n (num NUMERIC(20,4), big BIGINT)');
  await c.query("INSERT INTO n VALUES (9999999999999999.99, 4000000000)");
  const r = await c.query('SELECT num, big FROM n');
  ok('#214 NUMERIC/BIGINT OID and precision', r.rows[0].num === '9999999999999999.99' && r.fields[0].dataTypeID === 1700 && r.fields[1].dataTypeID === 20, r.rows);
  await c.query('CREATE TABLE ts (ts TIMESTAMP)');
  await c.query("INSERT INTO ts (ts) VALUES ('2024-01-15 10:20:30')");
  const t = await c.query('SELECT ts FROM ts');
  ok('#215 PG timestamp does not fall back to 1970', t.rows[0].ts.getUTCFullYear() === 2024, t.rows);
  await c.end();
  srv.close();
}

async function nedbCases() {
  {
    const ds = new Datastore(); await ds.loadDatabase();
    await ds.insert({ _id: 'fixed-1', v: 1 });
    let err = null;
    try { await ds.insert({ _id: 'fixed-1', v: 2 }); } catch (e) { err = e.errorType; }
    ok('#190 duplicate explicit _id rejected', err === 'uniqueViolated' && (await ds.find({})).length === 1, err);
    await ds.stop();
  }
  {
    const ds = new Datastore(); await ds.loadDatabase();
    await ds.insert({ a: 1, b: 2, c: 3 });
    const r = await ds.find({}, { a: 0 });
    ok('#191 negative projection keeps other fields', JSON.stringify(Object.keys(r[0]).sort()) === JSON.stringify(['_id', 'b', 'c']), r);
    await ds.stop();
  }
  {
    const ds = new Datastore(); await ds.loadDatabase();
    await ds.insert({ name: 'x', age: 1 });
    const hit = await ds.update({ name: 'x' }, { $set: { age: 2 } }, { returnUpdatedDocs: true });
    const miss = await ds.update({ name: 'none' }, { $set: { age: 9 } }, { returnUpdatedDocs: true });
    ok('#192 returnUpdatedDocs shape', !Array.isArray(hit.affectedDocuments) && hit.affectedDocuments.age === 2 && miss.affectedDocuments === null, { hit, miss });
    await ds.stop();
  }
  {
    const ds = new Datastore(); await ds.loadDatabase();
    await ds.ensureIndex({ fieldName: 'email', unique: true });
    await ds.insert({ email: 'a@x.com' });
    let err = null;
    try { await ds.insert({ email: 'a@x.com' }); } catch (e) { err = e.errorType; }
    ok('#193 ensureIndex unique enforced', err === 'uniqueViolated' && (await ds.find({})).length === 1, err);
    await ds.stop();
  }
  {
    const ds = new Datastore(); await ds.loadDatabase();
    const r = await ds.update({ name: 'new' }, { $set: { name: 'new' }, $inc: { count: 5 }, $push: { tags: 't1' } }, { upsert: true, returnUpdatedDocs: true });
    const doc = (await ds.find({}))[0];
    ok('#194 upsert applies modifiers', r.numAffected === 1 && doc.count === 5 && JSON.stringify(doc.tags) === JSON.stringify(['t1']), { r, doc });
    await ds.stop();
  }
}

(async () => {
  await sqlCases();
  await cliCases();
  sqliteCases();
  await redisCases();
  await mongoCases();
  await mysqlCases();
  await pgCases();
  await nedbCases();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
