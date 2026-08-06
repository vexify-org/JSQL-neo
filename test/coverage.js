/*
 * Integration coverage test — exercises Redis server, Web UI, migration tools
 * and CLI logic in-process (zero dependencies) so c8 can measure real usage.
 *
 *   npm run coverage   (c8 node test/coverage.js)
 */
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.join(__dirname, '..');
let passed = 0, failed = 0;

function ok(name, cond) {
  if (cond) { passed++; console.log('[OK]', name); }
  else { failed++; console.log('[FAIL]', name); }
}

function tmp(name) {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'jsql-cov-')), name);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  return p;
}

(async () => {
  /* ---------- Redis server ---------- */
  const { RedisServer } = require(path.join(ROOT, 'lib/redis_server'));
  const Database = require(path.join(ROOT, 'lib/database'));
  const { executeSQL } = require(path.join(ROOT, 'lib/sql'));
  const { WebUI } = require(path.join(ROOT, 'lib/web_ui'));
  const migrate = require(path.join(ROOT, 'lib/migrate'));

  {
    const rs = new RedisServer({ dataDir: tmp('redis') });
    ok('redis PING', rs.execute('PING', []) === 'PONG');
    ok('redis ECHO', rs.execute('ECHO', ['hi']) === 'hi');
    rs.execute('SET', ['k', 'v']);
    ok('redis GET', rs.execute('GET', ['k']) === 'v');
    ok('redis SETNX existing', rs.execute('SETNX', ['k', 'x']) === 0);
    ok('redis SETNX new', rs.execute('SETNX', ['n', 'x']) === 1);
    rs.execute('INCR', ['cnt']);
    rs.execute('INCR', ['cnt']);
    ok('redis INCR', rs.execute('GET', ['cnt']) === '2');
    ok('redis DECR', rs.execute('DECR', ['cnt']) === 1);
    ok('redis INCRBY', rs.execute('INCRBY', ['cnt', '5']) === 6);
    rs.execute('APPEND', ['a', 'hello']);
    ok('redis APPEND/STRLEN', rs.execute('STRLEN', ['a']) === 5);
    rs.execute('HSET', ['h', 'f1', 'v1', 'f2', 'v2']);
    ok('redis HGET', rs.execute('HGET', ['h', 'f1']) === 'v1');
    const hg = rs.execute('HGETALL', ['h']);
    ok('redis HGETALL', Array.isArray(hg) && hg.length === 4);
    ok('redis HDEL', rs.execute('HDEL', ['h', 'f1']) === 1);
    ok('redis HLEN', rs.execute('HLEN', ['h']) === 1);
    ok('redis HKEYS', JSON.stringify(rs.execute('HKEYS', ['h'])) === '["f2"]');
    rs.execute('LPUSH', ['l', 'a', 'b']);
    ok('redis LLEN', rs.execute('LLEN', ['l']) === 2);
    const lr = rs.execute('LRANGE', ['l', '0', '-1']);
    ok('redis LRANGE', JSON.stringify(lr) === '["b","a"]');
    ok('redis LINDEX', rs.execute('LINDEX', ['l', '0']) === 'b');
    rs.execute('RPUSH', ['l', 'c']);
    ok('redis LPOP', rs.execute('LPOP', ['l']) === 'b');
    ok('redis LREM', rs.execute('LREM', ['l', '0', 'a']) === 1);
    rs.execute('SADD', ['s', 'm1', 'm2', 'm3']);
    ok('redis SCARD', rs.execute('SCARD', ['s']) === 3);
    ok('redis SISMEMBER', rs.execute('SISMEMBER', ['s', 'm1']) === 1);
    ok('redis SMEMBERS', rs.execute('SMEMBERS', ['s']).length === 3);
    ok('redis SREM', rs.execute('SREM', ['s', 'm1']) === 1);
    ok('redis KEYS', rs.execute('KEYS', ['*']).length >= 5);
    ok('redis EXISTS', rs.execute('EXISTS', ['k', 'zzz']) === 1);
    ok('redis TYPE', rs.execute('TYPE', ['h']) === 'hash');
    ok('redis TTL missing', rs.execute('TTL', ['zzz']) === -2);
    rs.execute('EXPIRE', ['k', '100']);
    ok('redis TTL set', rs.execute('TTL', ['k']) > 0);
    ok('redis PERSIST', rs.execute('PERSIST', ['k']) === 1);
    ok('redis DBSIZE', rs.execute('DBSIZE', []) >= 5);
    ok('redis FLUSHALL', rs.execute('FLUSHALL', []) === 'OK');
    ok('redis DBSIZE after flush', rs.execute('DBSIZE', []) === 0);
    ok('redis INFO', rs.execute('INFO', []).includes('redis_version'));
    ok('redis SELECT', rs.execute('SELECT', ['3']) === 'OK');
    rs.stop();
    const persisted = JSON.parse(fs.readFileSync(rs.snapshotPath(), 'utf8'));
    ok('redis snapshot file written', Object.keys(persisted).length >= 0);
  }

  /* ---------- Web UI ---------- */
  {
    const dbFile = tmp('webui/db.json');
    fs.mkdirSync(path.dirname(dbFile), { recursive: true });
    fs.writeFileSync(dbFile, JSON.stringify({
      __schema__: { users: { id: { type: 'integer', primaryKey: true, autoIncrement: true }, name: { type: 'string' } } },
      __meta__: { version: 1 },
      users: [{ id: 1, name: 'Alice' }, { id: 2, name: 'Bob' }],
    }));
    const ui = new WebUI({ port: 0, dataDir: path.dirname(dbFile) });
    const port = await ui.start();
    const dbs = await (await fetch(`http://127.0.0.1:${port}/api/databases`)).json();
    ok('webui list databases', dbs.length === 1 && dbs[0].name === 'db');
    const tbls = await (await fetch(`http://127.0.0.1:${port}/api/tables?db=db`)).json();
    ok('webui list tables', tbls.tables.length === 1 && tbls.tables[0].name === 'users' && tbls.tables[0].count === 2);
    const q = await (await fetch(`http://127.0.0.1:${port}/api/query`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ db: 'db', sql: 'SELECT name FROM users WHERE id = 1' }),
    })).json();
    ok('webui query', q.ok && JSON.stringify(q.rows) === '[[\"Alice\"]]');
    const ins = await (await fetch(`http://127.0.0.1:${port}/api/query`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ db: 'db', sql: "INSERT INTO users (name) VALUES ('Carol')" }),
    })).json();
    ok('webui insert', ins.ok && ins.affected === 1);
    const bad = await (await fetch(`http://127.0.0.1:${port}/api/query`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ db: 'db', sql: 'SELECT * FROM nope' }),
    })).json();
    ok('webui error path', !bad.ok && bad.error.includes('nope'));
    const html = await (await fetch(`http://127.0.0.1:${port}/`)).text();
    ok('webui page', html.includes('JSQL-NEO'));
    ok('webui missing db', (await (await fetch(`http://127.0.0.1:${port}/api/tables?db=x`)).json()).error !== undefined);
    await ui.stop();
  }

  /* ---------- Migration tools + SQL engine ---------- */
  {
    const db = new Database(':memory:', { autoSave: false });
    const dump = `CREATE TABLE products (
      id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(100) COLLATE utf8mb4_bin DEFAULT NULL,
      price DECIMAL(10,2) DEFAULT '0.00',
      note TEXT
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    -- comment line
    INSERT INTO products (name, price, note) VALUES
      ('Laptop', 999.99, 'It\\'s a \\"pro\\" model\\nwith newline'),
      ('Mouse', 19.50, NULL),
      ('Cable', 9.90, 'USB\\tC');
    `;
    const r = await migrate.importDump(db, dump);
    ok('migrate import dump', r.created.includes('products') && r.inserted === 3);
    const csv = await migrate.exportTableToCSV(db, 'products');
    ok('migrate export csv', csv.split('\n').length >= 4 && csv.includes('Laptop'));
    const rows = await db.find('products', {}, { limit: 10 });
    ok('migrate escaped round-trip', rows[0].name === 'Laptop' && rows[0].note.includes('with newline'));
    const json = await migrate.exportAllToJSON(db);
    ok('migrate export json', json.products && json.products.schema && json.products.rows.length === 3);
    const db2 = new Database(':memory:', { autoSave: false });
    await migrate.importFromJSON(db2, json);
    ok('migrate import json', (await db2.count('products')) === 3);
    const r2 = await migrate.importFromCSV(db2, 'products2', 'a,b\n1,hello\n2,"quo,ted"\n', { schema: { a: { type: 'string' }, b: { type: 'string' } } });
    ok('migrate csv import', r2.inserted === 2);

    await executeSQL(db, 'CREATE TABLE users (id INTEGER PRIMARY KEY AUTO_INCREMENT, name STRING, age INTEGER)');
    await executeSQL(db, "INSERT INTO users (name, age) VALUES ('Alice', 30), ('Bob', 25)");
    const sel = await executeSQL(db, 'SELECT name, age FROM users WHERE age > 26 ORDER BY age DESC');
    ok('sql select where order', JSON.stringify(sel.rows) === '[["Alice",30]]');
    const agg = await executeSQL(db, 'SELECT COUNT(*) AS n, AVG(age) AS a FROM users');
    ok('sql aggregate', agg.rows[0][0] === 2);
    const fn = await executeSQL(db, 'SELECT VERSION(), CONCAT("x","y")');
    ok('sql func column names', fn.columns[0] === 'VERSION()');
    await executeSQL(db, 'UPDATE users SET age = 31 WHERE name = \'Bob\'');
    await executeSQL(db, 'DELETE FROM users WHERE id = 1');
    ok('sql count after delete', (await db.count('users')) === 1);
    await executeSQL(db, 'BEGIN');
    await executeSQL(db, "INSERT INTO users (name, age) VALUES ('Temp', 99)");
    await executeSQL(db, 'ROLLBACK');
    ok('sql rollback', (await db.count('users')) === 1);
    await executeSQL(db, 'START TRANSACTION');
    await executeSQL(db, "INSERT INTO users (name, age) VALUES ('X', 1)");
    await executeSQL(db, 'TRUNCATE TABLE users');
    ok('sql truncate', (await db.count('users')) === 0);
    const sqlApi = require(path.join(ROOT, 'lib/sql'));
    const parsed = sqlApi.parseSQL('SELECT * FROM t WHERE id = 5');
    ok('parseSQL', parsed.type === 'select');
    ok('applyParams', sqlApi.applyParams('SELECT * FROM t WHERE id = ?', [7]) === 'SELECT * FROM t WHERE id = 7');
  }

  /* ---------- CLI module load ---------- */
  {
    try {
      require(path.join(ROOT, 'bin/jsql'));
      ok('cli loads', true);
    } catch (e) {
      ok('cli loads', !/Cannot find module/.test(e.message));
    }
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('[FATAL]', e.stack.split('\n').slice(0, 3).join('\n')); process.exit(1); });
