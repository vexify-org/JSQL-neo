/*
 * Regression tests for issues #162-#179.
 *   node test/issue-162-179.test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');

const ROOT = path.join(__dirname, '..');
const { Database, executeSQL } = require(path.join(ROOT, 'index.js'));
const Cache = require(path.join(ROOT, 'lib', 'cache.js'));
const { createRedisServer } = require(path.join(ROOT, 'lib', 'redis_server.js'));
const { createMongoServer } = require(path.join(ROOT, 'lib', 'mongo_server.js'));
const bigintJson = require(path.join(ROOT, 'lib', 'bigint_json.js'));

let passed = 0, failed = 0;
function ok(name, cond, extra) {
  if (cond) { passed++; console.log('[OK]', name); }
  else { failed++; console.log('[FAIL]', name, extra !== undefined ? '→ ' + JSON.stringify(extra) : ''); }
}

function redisCall(srv, cmd, ...args) {
  try { return { value: srv.execute(cmd, args) }; }
  catch (e) { return { error: e.message }; }
}

function respFrame(args) {
  return '*' + args.length + '\r\n' + args.map((a) => {
    const b = Buffer.from(String(a));
    return '$' + b.length + '\r\n' + a + '\r\n';
  }).join('');
}

async function sqlCases() {
  const db = new Database(':memory:');
  const q = (sql) => executeSQL(db, sql, { safety: false });

  await q('CREATE TABLE t (id INT, v INT)');
  await q('INSERT INTO t VALUES (1,10),(2,NULL)');
  let r = await q('SELECT id, ISNULL(v) AS isnull_v FROM t');
  ok('#162 ISNULL in SELECT', JSON.stringify(r.rows) === JSON.stringify([[1, 0], [2, 1]]), r.rows);
  r = await q('SELECT ISNULL(NULL) a, ISNULL(1) b, ISNULL(0) c');
  ok('#162 ISNULL constants', JSON.stringify(r.rows) === JSON.stringify([[1, 0, 0]]), r.rows);
  r = await q('SELECT id FROM t WHERE ISNULL(v)');
  ok('#162 ISNULL in WHERE', JSON.stringify(r.rows) === JSON.stringify([[2]]), r.rows);

  await q('CREATE TABLE sales (region TEXT, amount INT)');
  await q("INSERT INTO sales VALUES ('north',10),('north',20),('south',100)");
  r = await q('SELECT region, SUM(amount) FROM sales GROUP BY region ORDER BY SUM(amount) DESC');
  ok('#163 ORDER BY aggregate DESC', JSON.stringify(r.rows) === JSON.stringify([['south', 100], ['north', 30]]), r.rows);
  r = await q('SELECT region, SUM(amount) FROM sales GROUP BY region ORDER BY SUM(amount) ASC');
  ok('#163 ORDER BY aggregate ASC', JSON.stringify(r.rows) === JSON.stringify([['north', 30], ['south', 100]]), r.rows);

  await q('CREATE TABLE users (id INT PRIMARY KEY AUTO_INCREMENT, name TEXT)');
  r = await q("INSERT INTO users (name) VALUES ('Alice') RETURNING id, name");
  ok('#164 INSERT RETURNING auto id', JSON.stringify(r.rows) === JSON.stringify([[1, 'Alice']]), r.rows);
  r = await q("INSERT INTO users (name) VALUES ('Bob'),('Cara') RETURNING id, name");
  ok('#164 INSERT RETURNING multi-row', JSON.stringify(r.rows) === JSON.stringify([[2, 'Bob'], [3, 'Cara']]), r.rows);

  await q('CREATE TABLE ts (ts TIMESTAMP)');
  await q('INSERT INTO ts VALUES (1000000000000)');
  r = await q('SELECT ts FROM ts');
  ok('#168 TIMESTAMP 1e12 boundary', JSON.stringify(r.rows) === JSON.stringify([[1000000000]]), r.rows);

  r = await q("SELECT DATE_FORMAT(0, '%Y-%m-%d') AS d");
  ok('#170 DATE_FORMAT(0)', JSON.stringify(r.rows) === JSON.stringify([['1970-01-01']]), r.rows);
}

function cacheCases() {
  const c = new Cache();
  for (const bad of ['abc', '1.5', NaN, Infinity]) {
    let threw = false;
    try { c.select(bad); } catch (e) { threw = true; }
    ok('#165 select rejects ' + String(bad), threw && c._db === 0, c._db);
  }
  let threw = false;
  try { c.hset('h', '_type', 'evil'); } catch (e) { threw = true; }
  ok('#166 hset rejects _type', threw && c.type('h') === 'none', c.type('h'));

  const c2 = new Cache();
  const big = '9007199254740993';
  ok('#167 incrby bigint', c2.incrby('a', big) === BigInt(big));
  ok('#167 decrby bigint symmetric', c2.decrby('b', big) === -BigInt(big));
  ok('#167 decrby rejects non-integer', (() => {
    try { c2.decrby('c', '1.5'); return false; } catch (e) { return true; }
  })());
}

function redisCases() {
  const srv = createRedisServer({ port: 0, dataDir: null });
  redisCall(srv, 'SET', 'a', '1');
  for (const [cmd, args] of [
    ['HEXISTS', ['a', 'f']], ['HLEN', ['a']], ['HKEYS', ['a']], ['HVALS', ['a']],
    ['SMEMBERS', ['a']], ['SISMEMBER', ['a', 'm']], ['SCARD', ['a']], ['ZSCORE', ['a', 'm']],
  ]) {
    const res = redisCall(srv, cmd, ...args);
    ok('#171 ' + cmd + ' WRONGTYPE', /WRONGTYPE/.test(res.error || ''), res);
  }

  const srv2 = createRedisServer({ port: 0, dataDir: null });
  const s1 = redisCall(srv2, 'SET', 'k');
  ok('#172 SET missing value', /wrong number of arguments/.test(s1.error || ''), s1);
  ok('#172 no ghost key', redisCall(srv2, 'EXISTS', 'k').value === 0);
  const z1 = redisCall(srv2, 'ZADD', 'z');
  ok('#172 ZADD missing args', /wrong number of arguments/.test(z1.error || ''), z1);
  ok('#172 no ghost zset', redisCall(srv2, 'TYPE', 'z').value === 'none');
  const l1 = redisCall(srv2, 'LPUSH', 'l');
  ok('#172 LPUSH missing value', /wrong number of arguments/.test(l1.error || ''), l1);

  const srv3 = createRedisServer({ port: 0, dataDir: null });
  redisCall(srv3, 'HSET', 'h', 'f', '1'); redisCall(srv3, 'HDEL', 'h', 'f');
  redisCall(srv3, 'ZADD', 'z', 1, 'a'); redisCall(srv3, 'ZREM', 'z', 'a');
  redisCall(srv3, 'RPUSH', 'l', 'a'); redisCall(srv3, 'LREM', 'l', 0, 'a');
  ok('#173 HDEL deletes empty hash', redisCall(srv3, 'EXISTS', 'h').value === 0);
  ok('#173 ZREM deletes empty zset', redisCall(srv3, 'EXISTS', 'z').value === 0);
  ok('#173 LREM deletes empty list', redisCall(srv3, 'EXISTS', 'l').value === 0);

  const srv4 = createRedisServer({ port: 0, dataDir: null });
  const zbad = redisCall(srv4, 'ZADD', 'z', 1, 'a', 'bad', 'b');
  ok('#174 ZADD rejects invalid score', /not a valid float/.test(zbad.error || ''), zbad);
  ok('#174 ZADD is atomic', redisCall(srv4, 'ZCARD', 'z').value === 0);
  ok('#174 no ghost zset', redisCall(srv4, 'EXISTS', 'z').value === 0);

  const srv5 = createRedisServer({ port: 0, dataDir: null });
  redisCall(srv5, 'RPUSH', 'l', 'a', 'b', 'c');
  redisCall(srv5, 'ZADD', 'z', 1, 'a', 2, 'b');
  for (const [cmd, args] of [['LRANGE', ['l', 'x', 'y']], ['LINDEX', ['l', 'x']], ['ZRANGE', ['z', 'x', 'y']]]) {
    const res = redisCall(srv5, cmd, ...args);
    ok('#175 ' + cmd + ' rejects non-integer', /not an integer/.test(res.error || ''), res);
  }

  const srv6 = createRedisServer({ port: 0, dataDir: null });
  redisCall(srv6, 'SET', 'exp', 'v', 'PX', '1');
  const end = Date.now() + 30;
  while (Date.now() < end) { /* wait for TTL */ }
  ok('#176 DEL expired key returns 0', redisCall(srv6, 'DEL', 'exp').value === 0);
}

async function respCase() {
  const srv = createRedisServer({ port: 0, dataDir: null });
  await new Promise((resolve) => srv.listen(resolve));
  const port = srv.server.address().port;
  const sock = net.connect(port, '127.0.0.1');
  await new Promise((resolve) => sock.on('connect', resolve));
  const chunks = [];
  sock.on('data', (c) => chunks.push(c));
  for (const args of [['ECHO', 'OK'], ['HSET', 'h', 'f', 'OK'], ['HGET', 'h', 'f'], ['PING'], ['SET', 's', 'v']]) {
    sock.write(respFrame(args));
  }
  await new Promise((resolve) => setTimeout(resolve, 200));
  const out = Buffer.concat(chunks).toString('utf8');
  ok('#177 ECHO OK is bulk', out.includes('$2\r\nOK\r\n'), out);
  ok('#177 HGET OK is bulk', (out.match(/\$2\r\nOK\r\n/g) || []).length >= 2, out);
  ok('#177 PING is simple', out.includes('+PONG\r\n'), out);
  ok('#177 SET is simple', out.includes('+OK\r\n'), out);
  sock.end();
  srv.stop();
}

async function mongoCase() {
  const mongo = createMongoServer({ dataDir: ':memory:' });
  await mongo._dispatch('insert', {
    insert: 'users',
    documents: [{ _id: 1, name: 'a', age: 20 }, { _id: 2, name: 'b', age: 30 }],
    $db: 'test',
  });
  const engine = await mongo._getEngine('test');
  const schema = engine.getTableSchema('users');
  ok('#178 auto collection schema', schema && Object.keys(schema).length === 3, schema);
  const r = await executeSQL(engine, 'SELECT * FROM users ORDER BY _id', { safety: false });
  ok('#178 SELECT * on mongo collection', JSON.stringify(r.rows) === JSON.stringify([[1, 'a', 20], [2, 'b', 30]]), r.rows);
}

function bigintCase() {
  const userData = { name: 'x', meta: { __jsql_bigint__: '12345' } };
  const back = bigintJson.parse(bigintJson.stringify(userData));
  ok('#169 user marker object preserved', back.meta && typeof back.meta === 'object' && back.meta.__jsql_bigint__ === '12345', back.meta);
  const round = bigintJson.parse(bigintJson.stringify({ v: 9007199254740993n }));
  ok('#169 real BigInt still round-trips', round.v === 9007199254740993n, round.v);
}

function snapshotCase() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsql-rdb-'));
  fs.writeFileSync(path.join(dir, 'data.rdb.json'), '{broken json');
  let reported = null;
  const origError = console.error;
  console.error = (...args) => { reported = args.join(' '); };
  const srv = createRedisServer({ port: 0, dataDir: dir, onError: (e) => { reported = reported || e.message; } });
  console.error = origError;
  const files = fs.readdirSync(dir);
  ok('#179 corrupt snapshot reported', !!reported);
  ok('#179 corrupt snapshot backed up', files.some((f) => f.includes('.corrupt-')));
  ok('#179 corrupt snapshot does not crash', srv.execute('DBSIZE', []) === 0);

  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'jsql-rdb2-'));
  fs.writeFileSync(path.join(dir2, 'data.rdb.json'), '{broken json');
  fs.writeFileSync(path.join(dir2, 'data.rdb.json.tmp'), JSON.stringify({
    __jsql_redis__: 2,
    databases: { 0: { k: { type: 'string', val: 'from-tmp', ttl: null } } },
  }));
  const origError2 = console.error;
  console.error = () => {};
  const srv2 = createRedisServer({ port: 0, dataDir: dir2, onError: () => {} });
  console.error = origError2;
  ok('#179 recovers from tmp file', srv2.execute('GET', ['k']) === 'from-tmp');
  srv2.stop();
}

(async () => {
  await sqlCases();
  cacheCases();
  redisCases();
  await respCase();
  await mongoCase();
  bigintCase();
  snapshotCase();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
