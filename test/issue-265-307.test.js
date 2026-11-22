/*
 * Regression tests for #265 #267 #273 #294 #307.
 *   node test/issue-265-307.test.js
 */
const path = require('path');
const ROOT = path.join(__dirname, '..');
const { Database, executeSQL, JSQL } = require(path.join(ROOT, 'index.js'));
const SqliteDatabase = require(path.join(ROOT, 'lib', 'sqlite_compat.js'));

let passed = 0, failed = 0;
function ok(name, cond, extra) {
  if (cond) { passed++; console.log('[OK]', name); }
  else { failed++; console.log('[FAIL]', name, extra !== undefined ? '→ ' + JSON.stringify(extra) : ''); }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  // #267
  {
    const db = new Database(':memory:');
    await executeSQL(db, 'CREATE TABLE t (v VARCHAR(3))', { safety: false });
    let e3 = null;
    try { await executeSQL(db, "INSERT INTO t VALUES ('😀😀😀')", { safety: false }); } catch (e) { e3 = e.code; }
    let e4 = null;
    try { await executeSQL(db, "INSERT INTO t VALUES ('😀😀😀😀')", { safety: false }); } catch (e) { e4 = e.code; }
    ok('#267 VARCHAR length counts code points', e3 === null && e4 === 1406, { e3, e4 });
    db.stop();
  }
  // #265
  {
    const db = new SqliteDatabase(':memory:');
    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY)');
    let caught = null;
    try {
      db.transaction(() => {
        db.prepare('INSERT INTO t VALUES (1)').run();
        db.transaction(() => { db.prepare('INSERT INTO t VALUES (2)').run(); })();
        throw new Error('outer rollback');
      })();
    } catch (e) { caught = e.message; }
    const n = db.prepare('SELECT COUNT(*) c FROM t').get().c;
    ok('#265 nested sqlite transaction rolls back inner writes', caught === 'outer rollback' && n === 0, { caught, n });
    db.close();
  }
  // #294
  {
    const db = new JSQL();
    await db.start();
    await db.createTable('x', { id: { type: 'integer', primaryKey: true } });
    await db.stop();
    await db.start();
    const tables = await db.getTables();
    ok('#294 wasm stop/start clears JS table metadata', Array.isArray(tables) && tables.length === 0, tables);
    await db.stop();
  }
  // #273 / #307 via protocol-level unit invocation
  {
    const { MysqlConnection } = require(path.join(ROOT, 'lib', 'mysql_server.js'));
    const engine = new Database(':memory:');
    await engine.createTable('t', { id: { type: 'integer', primaryKey: true }, name: { type: 'string' } });
    const makeConn = () => {
      const c = Object.create(MysqlConnection.prototype);
      c.sequence = 0;
      c.authenticated = true;
      c._stmtSeq = 0;
      c._stmts = new Map();
      c.currentDb = 'app';
      c.server = { _getDatabase: async () => engine };
      c.packets = [];
      c.socket = { writable: true, write: (b) => c.packets.push(b.slice(4)), end() {} };
      return c;
    };
    const conn = makeConn();
    conn._handleStmtPrepare(Buffer.from('SELECT id, name FROM t'));
    await sleep(50);
    const joined = Buffer.concat(conn.packets).toString('latin1');
    ok('#273 prepare column metadata uses real names', joined.includes('id') && joined.includes('name') && !joined.includes('col1'), conn.packets.length);

    const conn2 = makeConn();
    conn2._handlePacket(Buffer.concat([Buffer.from([0x04]), Buffer.from('t\0\0')]), 0);
    await sleep(50);
    const fieldList = Buffer.concat(conn2.packets).toString('latin1');
    ok('#307 COM_FIELD_LIST returns column definitions', fieldList.includes('id') && fieldList.includes('name'), conn2.packets.length);
    engine.stop();
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
