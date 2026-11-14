/**
 * #91 / #95 / #97 —— MySQL 线协议层
 *
 *   #91  多语句（`SELECT 1; SELECT 2`）时从不设置 SERVER_MORE_RESULTS_EXISTS，
 *        客户端读完第一个结果集就收工，后续语句的结果集被丢弃。
 *   #95  COM_PROCESS_INFO 把行当裸字节发（Buffer.from([0x31])），缺少
 *        length-encoded 长度前缀，客户端会把它读成「长度 49」并一直等下去。
 *   #97  MysqlServer#_route 用「原始 SQL 算出的 mask + 逐步缩短的 SQL 偏移」做替换，
 *        偏移错位后会删掉字符串字面量里的表名。
 *
 *   node test/mysql-protocol.test.js
 */
const { MysqlConnection, MysqlServer } = require('../lib/mysql_server');
const { parseSQL } = require('../lib/sql');
const Database = require('../lib/database');

let p = 0, f = 0;
const ok = (n, c, g) => { if (c) p++; else { f++; console.log('[FAIL]', n, '->', JSON.stringify(g)); } };

/** 一条 socket.write 可能包含多个 MySQL 包，按 4 字节头切开 */
function splitPackets(buffers) {
  const out = [];
  for (const buf of buffers) {
    let off = 0;
    while (off + 4 <= buf.length) {
      const len = buf.readUIntLE(off, 3);
      const seq = buf[off + 3];
      const payload = buf.slice(off + 4, off + 4 + len);
      out.push({ seq, payload });
      off += 4 + len;
      if (len === 0) break;
    }
  }
  return out;
}

const isEof = (pl) => pl[0] === 0xfe && pl.length < 9;
const isOk = (pl) => pl[0] === 0x00 && pl.length >= 7;
const eofStatus = (pl) => pl.readUInt16LE(3);
const okStatus = (pl) => {
  let o = 1;
  for (let k = 0; k < 2; k++) {
    const b = pl[o];
    if (b < 0xfb) o += 1;
    else if (b === 0xfc) o += 3;
    else if (b === 0xfd) o += 4;
    else o += 9;
  }
  return pl.readUInt16LE(o);
};

function fakeConn(db) {
  const writes = [];
  const conn = Object.create(MysqlConnection.prototype);
  conn.socket = { writable: true, write: (b) => { writes.push(Buffer.from(b)); return true; } };
  conn.sequence = 1;
  conn.multiStatements = true;
  conn.auth = false;
  conn.authenticated = true;
  conn.user = 'root';
  conn.currentDb = 'testdb';
  conn.session = {};
  conn._moreResults = false;
  conn.server = {
    allowComments: false,
    safety: false,
    _getDatabase: async () => db,
    _getEngine: async () => db,
    _canAccessDb: () => true,
    _dbExists: () => true,
    _userDbList: () => null,
    listDatabases: async () => ['testdb'],
    createDatabase: async () => {},
    dropDatabase: async () => {},
    _switchDb: async () => {},
    _safeDbName: () => true,
    _defaultDbName: 'testdb',
    _route: async (stmt, sql) => ({ engine: db, sql }),
  };
  return { conn, writes };
}

(async () => {
  const db = new Database(':memory:');

  // ---------------- #91 两条 SELECT
  {
    const { conn, writes } = fakeConn(db);
    conn._handleQuery('SELECT 1 AS a; SELECT 2 AS b');
    await new Promise(r => setTimeout(r, 120));
    const pkts = splitPackets(writes);
    const eofs = pkts.filter(k => isEof(k.payload));
    const rows = pkts.filter(k => k.payload[0] === 0x01 && k.payload.length === 2);
    ok('#91 两个语句各有一个结果集', rows.length === 2, rows.map(k => [...k.payload]));
    ok('#91 两个结果集都被执行', rows.some(k => k.payload[1] === 0x31) && rows.some(k => k.payload[1] === 0x32),
      rows.map(k => [...k.payload]));
    // 每个结果集末尾各有 2 个 EOF（列定义后 / 行后）
    ok('#91 共 4 个 EOF', eofs.length === 4, eofs.length);
    const statuses = eofs.map(k => eofStatus(k.payload));
    ok('#91 第一个结果集的 EOF 带 MORE_RESULTS', statuses[0] & 0x0008, statuses);
    ok('#91 第一个结果集第二个 EOF 也带 MORE_RESULTS', statuses[1] & 0x0008, statuses);
    ok('#91 最后一个结果集不带 MORE_RESULTS', !(statuses[2] & 0x0008) && !(statuses[3] & 0x0008), statuses);
    // 序号在整条连接上连续
    ok('#91 包序号连续', pkts.every((k, i) => i === 0 || k.seq === ((pkts[i - 1].seq + 1) & 0xff)),
      pkts.map(k => k.seq));
  }

  // ---------------- #91 单语句不应带标志
  {
    const { conn, writes } = fakeConn(db);
    conn._handleQuery('SELECT 42 AS v');
    await new Promise(r => setTimeout(r, 80));
    const statuses = splitPackets(writes).filter(k => isEof(k.payload)).map(k => eofStatus(k.payload));
    ok('#91 单语句不带 MORE_RESULTS', statuses.length > 0 && statuses.every(v => !(v & 0x0008)), statuses);
  }

  // ---------------- #91 两条非查询语句：OK 包
  {
    const { conn, writes } = fakeConn(db);
    conn._handleQuery('CREATE TABLE IF NOT EXISTS m2 (a INT); INSERT INTO m2 VALUES (7)');
    await new Promise(r => setTimeout(r, 150));
    const statuses = splitPackets(writes).filter(k => isOk(k.payload)).map(k => okStatus(k.payload));
    ok('#91 两个 OK 包', statuses.length === 2, statuses);
    ok('#91 第一个 OK 带 MORE_RESULTS', statuses.length === 2 && (statuses[0] & 0x0008), statuses);
    ok('#91 最后一个 OK 不带', statuses.length === 2 && !(statuses[1] & 0x0008), statuses);
  }

  // ---------------- #95 COM_PROCESS_INFO
  {
    const { conn, writes } = fakeConn(db);
    conn._handlePacket(Buffer.from([0x0a]), 0);
    await new Promise(r => setTimeout(r, 60));
    const pkts = splitPackets(writes);
    const row = pkts.find(k => k.payload.length === 2 && k.payload[0] === 0x01);
    ok('#95 行带 length-encoded 前缀（0x01 0x31）', row && row.payload[1] === 0x31,
      pkts.map(k => [...k.payload]));
    ok('#95 不再发送裸 0x31', !pkts.some(k => k.payload.length === 1 && k.payload[0] === 0x31),
      pkts.map(k => [...k.payload]));
    ok('#95 包序号连续', pkts.every((k, i) => i === 0 || k.seq === ((pkts[i - 1].seq + 1) & 0xff)),
      pkts.map(k => k.seq));
  }

  // ---------------- #97 _route 偏移错位
  {
    const srv = Object.create(MysqlServer.prototype);
    srv.auth = false;
    srv._dbDir = null;
    srv.allowComments = false;
    srv._dbExists = () => true;
    srv.createDatabase = async () => {};
    srv._canAccessDb = () => true;
    srv._getDatabase = async () => db;
    srv._getEngine = async () => db;
    const sql = "SELECT '  db1.t2  ' AS lit FROM db1.t2";
    const routed = await srv._route(parseSQL(sql), sql, 'other', 'root');
    ok('#97 字符串字面量保持完整', routed.sql.includes("'  db1.t2  '"), routed.sql);
    ok('#97 限定表名仍去掉库前缀', /FROM\s+t2\b/.test(routed.sql), routed.sql);
  }

  console.log(`\nmysql-protocol: ${p} passed, ${f} failed`);
  if (db.stop) db.stop();
  process.exit(f ? 1 : 0);
})().catch((e) => { console.log('ERR', e.stack); process.exit(1); });
