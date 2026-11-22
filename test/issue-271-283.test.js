/*
 * Regression tests for #271 #275 #276 #278 #283.
 *   node test/issue-271-283.test.js
 */
const path = require('path');
const net = require('net');
const ROOT = path.join(__dirname, '..');
const { createMongoServer } = require(path.join(ROOT, 'lib', 'mongo_server.js'));

let passed = 0, failed = 0;
function ok(name, cond, extra) {
  if (cond) { passed++; console.log('[OK]', name); }
  else { failed++; console.log('[FAIL]', name, extra !== undefined ? '→ ' + JSON.stringify(extra) : ''); }
}

(async () => {
  // #271
  {
    const mysql = (() => { try { return require(path.join(ROOT, 'node_modules', 'mysql2/promise')); } catch (e) { return null; } })();
    if (mysql) {
      const { createMysqlServer } = require(path.join(ROOT, 'lib', 'mysql_server.js'));
      const srv = createMysqlServer({ port: 0, host: '127.0.0.1', dataDir: ':memory:', noAuth: true });
      await new Promise((r) => srv.listen(r));
      const c = await mysql.createConnection({ host: '127.0.0.1', port: srv.address.port, user: 'root', database: 'app' });
      await c.query('CREATE TABLE t (id INT PRIMARY KEY AUTO_INCREMENT, v VARCHAR(10) NOT NULL)');
      const [, f] = await c.query('SELECT id, v FROM t');
      ok('#271 column flags expose PK/NOT NULL/AUTO_INCREMENT', (f[0].flags & 0x0002) !== 0 && (f[0].flags & 0x0200) !== 0 && (f[1].flags & 0x0001) !== 0, f.map(x => x.flags));
      await c.end(); srv.close();
    } else { console.log('[SKIP] MySQL flags (mysql2 not installed)'); }
  }

  // #275 CancelRequest closes socket without ErrorResponse
  {
    const { createPgServer } = require(path.join(ROOT, 'lib', 'pg_server.js'));
    const srv = createPgServer({ port: 0, host: '127.0.0.1', dataDir: ':memory:', noAuth: true });
    await new Promise((r) => srv.listen(r));
    const sock = net.connect(srv.address.port, '127.0.0.1');
    await new Promise((r) => sock.on('connect', r));
    const chunks = [];
    let closed = false;
    sock.on('data', (c) => chunks.push(c));
    sock.on('close', () => { closed = true; });
    const body = Buffer.alloc(12);
    body.writeInt32BE(12, 0);
    body.writeInt32BE(80877102, 4);
    body.writeInt32BE(1234, 8);
    sock.write(body);
    await new Promise((r) => setTimeout(r, 150));
    ok('#275 CancelRequest closes without response', closed && chunks.length === 0, { closed, bytes: Buffer.concat(chunks).toString('hex') });
  }

  // #276 Bind parameter count mismatch (直接驱动协议层，pg 客户端会在本地拦截)
  {
    const { PgConnection } = require(path.join(ROOT, 'lib', 'pg_server.js'));
    const conn = Object.create(PgConnection.prototype);
    conn._prepared = new Map([['', { sql: 'SELECT $1::int', paramTypes: [23] }]]);
    conn._portal = new Map();
    conn.socket = { write() {} };
    const body = Buffer.from([0, 0, 0, 0, 0, 0, 0, 0]);
    let code = null;
    try { await conn._handleMessage(0x42, body); } catch (e) { code = e.sqlState; }
    ok('#276 bind param count mismatch -> 08P01', code === '08P01', code);
  }

  // #283 unknown aggregate stage
  {
    const mongo = createMongoServer({ dataDir: ':memory:' });
    await mongo._dispatch('insert', { insert: 'c', documents: [{ a: 1 }], $db: 'test' });
    const r = await mongo._dispatch('aggregate', { aggregate: 'c', pipeline: [{ $addFields: { b: 2 } }], cursor: {}, $db: 'test' });
    ok('#283 unknown pipeline stage errors', r.ok === 0 && r.code === 40324, r);
  }

  // #278 batchSize + getMore
  {
    const mongo = createMongoServer({ dataDir: ':memory:' });
    await mongo._dispatch('insert', { insert: 'c', documents: [{ n: 1 }, { n: 2 }, { n: 3 }, { n: 4 }, { n: 5 }], $db: 'test' });
    const first = await mongo._dispatch('find', { find: 'c', filter: {}, batchSize: 2, $db: 'test' });
    const id = first.cursor.id.$long;
    ok('#278 find honors batchSize', first.cursor.firstBatch.length === 2 && id !== 0, first.cursor);
    const more = await mongo._dispatch('getMore', { getMore: { $long: id }, collection: 'c', batchSize: 2, $db: 'test' });
    ok('#278 getMore returns remaining rows', more.cursor.nextBatch.length === 2 && more.cursor.nextBatch[0].n === 3, more.cursor);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
