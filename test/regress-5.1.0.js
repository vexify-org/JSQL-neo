/*
 * Regression tests locking in the bug fixes shipped in 5.1.0 / 5.1.1.
 * Zero runtime dependencies (uses Node builtins + in-repo libs only).
 *
 *   node test/regress-5.1.0.js
 *
 * Covers:
 *   M1 $like regex-escape   M2 removeById(s) index consistency
 *   M3 B-Tree open intervals  M4 transaction deep-copy snapshot
 *   M5 swap-pop hash sync   M6 importFromJSON shapes/overwrite
 *   H1/H3 parseFieldShorthand + ER_DUP_ENTRY
 *   S1 Redis per-socket AUTH   S2/S4 WebUI CORS & authToken
 *   S3/S4 MySQL ACL (1044)     S6 mysql_compat pool filename
 *   N1 CLI --version sync
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const net = require('net');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const Database = require(path.join(ROOT, 'lib/database'));
const BTree = require(path.join(ROOT, 'lib/btree'));
const migrate = require(path.join(ROOT, 'lib/migrate'));
const { RedisServer } = require(path.join(ROOT, 'lib/redis_server'));
const { WebUI } = require(path.join(ROOT, 'lib/web_ui'));
const { MysqlServer } = require(path.join(ROOT, 'lib/mysql_server'));
const compat = require(path.join(ROOT, 'lib/mysql_compat'));

let passed = 0, failed = 0;
function ok(name, cond, extra) {
  if (cond) { passed++; console.log('[OK]', name); }
  else { failed++; console.log('[FAIL]', name, extra !== undefined ? '-> ' + JSON.stringify(extra) : ''); }
}

function tmp(name) {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'jsql-r-')), name);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  return p;
}

function freePort() {
  return new Promise((res) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
  });
}

/* Minimal RESP client for integration tests. */
function respClient(port) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    let buf = '';
    const queue = [];
    socket.on('connect', () => resolve({
      cmd(line) {
        return new Promise((r) => {
          queue.push(r);
          socket.write(line);
        });
      },
      end() { socket.end(); },
    }));
    socket.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      while (queue.length) {
        const idx = buf.indexOf('\r\n');
        if (idx < 0) break;
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        queue.shift()(line);
      }
    });
    socket.on('error', reject);
  });
}

(async () => {
  /* ============ M3: B-Tree strict open intervals ============ */
  {
    const t = new BTree();
    for (const k of [1, 3, 5, 7, 9]) t.insert(k, k);
    ok('btree.greaterThan excludes min', JSON.stringify(t.greaterThan(5)) === '[7,9]', t.greaterThan(5));
    ok('btree.greaterThan(9) empty', JSON.stringify(t.greaterThan(9)) === '[]');
    ok('btree.lessThan excludes max', JSON.stringify(t.lessThan(5)) === '[1,3]', t.lessThan(5));
    ok('btree.lessThan(1) empty', JSON.stringify(t.lessThan(1)) === '[]');
  }

  /* ============ Core engine ============ */
  const db = new Database(':memory:', { autoSave: false });
  await db.start();
  db.createTable('users', { id: 'integer primary key auto_increment', name: 'string', email: 'string unique', age: 'integer' });
  for (const [n, a] of [['A', 10], ['B', 20], ['C', 30]]) db.insert('users', { name: n, email: n.toLowerCase() + '@x', age: a });

  {
    const gt = db.find('users', { age: { $gt: 20 } }).map(r => r.name);
    ok('find $gt excludes boundary', JSON.stringify(gt) === '["C"]', gt);
    const lt = db.find('users', { age: { $lt: 20 } }).map(r => r.name);
    ok('find $lt excludes boundary', JSON.stringify(lt) === '["A"]', lt);
  }

  {
    db.removeById('users', 2); // B (id=2) removed, C still id=3
    ok('removeById with PK count', db.count('users') === 2, db.count('users'));
    ok('removeById PK lookup null', db.findById('users', 2) === null);
    ok('removeById B-Tree still consistent', db.find('users', { age: { $gt: 15 } }).length === 1);
  }

  {
    db.createTable('np', { v: 'string', n: 'integer' });
    for (let i = 0; i < 10; i++) db.insert('np', { v: 'v' + i, n: i });
    db.createTable('h', { id: 'integer primary key auto_increment', grp: 'string', val: 'integer' });
    for (let i = 0; i < 12; i++) db.insert('h', { grp: 'g' + (i % 4), val: i });
    db._tables.h.createIndex('grp');

    db.removeByIds('np', [1, 2]);
    ok('removeByIds no-PK rebuilds indexes', db.find('np').length === 8, db.find('np').length);

    const pre = db.find('h', { grp: 'g1' }).map(r => r.id).sort((a, b) => a - b);
    db.removeById('h', 1); db.removeById('h', 5); db.removeById('h', 9); // the g0 rows
    const post = db.find('h', { grp: 'g1' }).map(r => r.id).sort((a, b) => a - b);
    ok('hash index survives swap-pop (g1 intact)', JSON.stringify(post) === JSON.stringify(pre), { pre, post });
    ok('hash index has no stale g0 rows', db.find('h', { grp: 'g0' }).length === 0);
    let stale = 0;
    for (const list of db._tables.h._indexes.grp.values()) for (const i of list) if (!db._tables.h._rows[i]) stale++;
    ok('hash index zero stale entries', stale === 0, stale);
  }

  {
    db.createTable('docs', { id: 'integer primary key', data: 'string' });
    db.insert('docs', { id: 1, data: JSON.stringify({ a: { b: 1 }, list: [1, 2, 3] }) });
    db.begin();
    db.updateById('docs', 1, { data: JSON.stringify({ a: { b: 2 }, list: [9] }) });
    db.rollback();
    const d = JSON.parse(db.findById('docs', 1).data);
    ok('transaction snapshot deep-copies nested object', d.a.b === 1, d);
    ok('transaction snapshot deep-copies arrays', JSON.stringify(d.list) === '[1,2,3]', d.list);
  }

  {
    const pfs = Database.parseFieldShorthand;
    const s1 = pfs('integer primary key auto_increment');
    ok('parseFieldShorthand pk+ai', s1.primaryKey === true && s1.autoIncrement === true && s1.type === 'integer', s1);
    const s2 = pfs('string unique not null');
    ok('parseFieldShorthand unique+notnull', s2.unique === true && s2.required === true && s2.type === 'string', s2);
    const s3 = pfs('string default x');
    ok('parseFieldShorthand default', s3.default === 'x' && s3.type === 'string', s3);

    let e = null;
    try { db.insert('users', { name: 'X', email: 'a@x', age: 1 }); } catch (err) { e = err; }
    ok('duplicate unique throws ER_DUP_ENTRY', e && (e.code === 1062 || String(e).includes('1062')), e && (e.code || e.message));
    db.createTable('pk2', { a: 'integer primary key', b: 'string' });
    db.insert('pk2', { a: 1, b: 'x' });
    e = null;
    try { db.insert('pk2', { a: 1, b: 'y' }); } catch (err) { e = err; }
    ok('duplicate primary key throws ER_DUP_ENTRY', e && (e.code === 1062 || String(e).includes('1062')), e && (e.code || e.message));
  }

  {
    const r = await migrate.importFromJSON(db, { table: 't1', schema: { id: 'integer primary key' }, rows: [{ id: 1 }, { id: 2 }] });
    ok('importFromJSON single-table shape', r && db.count('t1') === 2);
    let threw = null;
    try { await migrate.importFromJSON(db, { table: 't1', schema: { id: 'integer primary key' }, rows: [{ id: 3 }] }); } catch (err) { threw = err; }
    ok('importFromJSON refuses existing table without overwrite', !!threw, threw && (threw.message || String(threw)));
    await migrate.importFromJSON(db, { table: 't1', schema: { id: 'integer primary key' }, rows: [{ id: 3 }] }, { overwrite: true });
    ok('importFromJSON overwrite replaces table', db.count('t1') === 1, db.count('t1'));
  }

  {
    db.createTable('lk', { s: 'string' });
    for (const s of ['a.b', 'axb', 'aXb', 'abc']) db.insert('lk', { s });
    const m = db.find('lk', { s: { $like: 'a.b' } }).map(r => r.s);
    ok('$like escapes regex metacharacters', JSON.stringify(m) === '["a.b"]', m);
    const m2 = db.find('lk', { s: { $like: 'a%b' } }).map(r => r.s);
    ok('$like % wildcard still works', JSON.stringify(m2) === '["a.b","axb","aXb"]', m2);
  }
  await db.stop();

  /* ============ CLI (N1) ============ */
  {
    const pkg = require(path.join(ROOT, 'package.json')).version;
    const v = execFileSync(process.execPath, [path.join(ROOT, 'bin/jsql'), '--version']).toString().trim();
    ok('cli --version reports package version', v === pkg, v);
    const v2 = execFileSync(process.execPath, [path.join(ROOT, 'bin/jsql'), 'version']).toString().trim();
    ok('cli version command matches', v2 === pkg, v2);
    const help = execFileSync(process.execPath, [path.join(ROOT, 'bin/jsql'), 'ui', '--help']).toString();
    ok('cli subcommand --help does not crash', help.includes('127.0.0.1') && help.includes('auth-token'));
  }

  /* ============ WebUI CORS + auth (N2 / S2) ============ */
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsql-wui-'));
    fs.writeFileSync(path.join(dir, 'db.json'), JSON.stringify({ __schema__: { u: { id: { type: 'integer', primaryKey: true } } }, u: [{ id: 1 }] }));

    const p1 = await freePort();
    const w1 = new WebUI({ port: p1, host: undefined, dataDir: dir });
    await w1.start();
    ok('webui default host is 127.0.0.1', w1.host === '127.0.0.1', w1.host);
    let r = await fetch('http://127.0.0.1:' + p1 + '/api/databases', { headers: { Origin: 'http://evil.example' } });
    ok('webui no-token emits no ACAO', r.headers.get('access-control-allow-origin') === null, r.headers.get('access-control-allow-origin'));
    r = await fetch('http://127.0.0.1:' + p1 + '/api/query', { method: 'OPTIONS', headers: { Origin: 'http://evil.example', 'Access-Control-Request-Method': 'POST' } });
    ok('webui no-token preflight emits no ACAO', r.headers.get('access-control-allow-origin') === null);
    await w1.stop();

    const p2 = await freePort();
    const w2 = new WebUI({ port: p2, host: '127.0.0.1', dataDir: dir, authToken: 'tok' });
    await w2.start();
    r = await fetch('http://127.0.0.1:' + p2 + '/api/databases', { headers: { Origin: 'http://evil.example' } });
    ok('webui missing bearer returns 401', r.status === 401);
    r = await fetch('http://127.0.0.1:' + p2 + '/api/databases', { headers: { Origin: 'http://good.example', Authorization: 'Bearer tok' } });
    ok('webui auth echoes origin', r.status === 200 && r.headers.get('access-control-allow-origin') === 'http://good.example', { status: r.status, acao: r.headers.get('access-control-allow-origin') });
    await w2.stop();

    const p3 = await freePort();
    const w3 = new WebUI({ port: p3, host: '127.0.0.1', dataDir: dir, allowOrigin: '*' });
    await w3.start();
    r = await fetch('http://127.0.0.1:' + p3 + '/api/databases', { headers: { Origin: 'http://any.example' } });
    ok('webui explicit allowOrigin honored', r.headers.get('access-control-allow-origin') === '*');
    await w3.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }

  /* ============ Redis per-socket AUTH (S1) ============ */
  {
    const p = await freePort();
    const rs = new RedisServer({ port: p, host: '127.0.0.1', password: 'pw' });
    rs.listen();
    await new Promise((res) => rs.server.once('listening', res));

    const a = await respClient(p);
    const b = await respClient(p);
    const noauthA = await a.cmd('*1\r\n$4\r\nPING\r\n');
    ok('redis unauth socket gets NOAUTH', noauthA.startsWith('-NOAUTH'), noauthA);
    const authB = await b.cmd('*2\r\n$4\r\nAUTH\r\n$2\r\npw\r\n');
    ok('redis AUTH pw succeeds', authB === '+OK', authB);
    const pingB = await b.cmd('*1\r\n$4\r\nPING\r\n');
    ok('redis authed socket works', pingB === '+PONG', pingB);
    const pingA = await a.cmd('*1\r\n$4\r\nPING\r\n');
    ok('redis auth is per-socket (other socket still NOAUTH)', pingA.startsWith('-NOAUTH'), pingA);
    a.end(); b.end();
    rs.server.close();
  }

  /* ============ MySQL ACL (S3 / S4) ============ */
  {
    const ms = new MysqlServer({ dataDir: ':memory:', auth: { alice: { password: 'pw', databases: ['app'] } } });
    ok('mysql acl allows member db', ms._canAccessDb('alice', 'app') === true);
    ok('mysql acl denies foreign db', ms._canAccessDb('alice', 'other') === false);
    let code = null;
    try { await ms._switchDb({ user: 'alice' }, 'other'); } catch (e) { code = e.code; }
    ok('mysql cross-db switch denied (1044)', code === 1044, code);
  }

  /* ============ mysql_compat pool filename (S6) ============ */
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsql-cp-'));
    const file = path.join(dir, 'pool.json');
    const pool = compat.createPool({ filename: file });
    await pool.query('CREATE TABLE t (id INT PRIMARY KEY, v VARCHAR(20))');
    await pool.query("INSERT INTO t VALUES (1,'x')");
    const [rows] = await pool.query('SELECT * FROM t');
    ok('mysql_compat pool query roundtrip', rows.length === 1 && rows[0].v === 'x', rows);
    ok('mysql_compat pool persists to filename', fs.existsSync(file) && fs.statSync(file).size > 0);
    if (typeof pool.end === 'function') await pool.end();
    fs.rmSync(dir, { recursive: true, force: true });
  }

  console.log(failed === 0 ? `\nALL ${passed} REGRESSION TESTS PASSED` : `\n${failed} FAILURES (${passed} passed)`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
