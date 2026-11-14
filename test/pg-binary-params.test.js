/**
 * #93 PG Bind 忽略二进制参数格式
 *
 * Bind 消息按参数声明 formats[i]=1 表示该参数是二进制编码，但代码算出 `fmt`
 * 之后从未使用，一律 `body.toString('utf8', ...)`，于是 int4/int8/float8/numeric/
 * timestamp 的二进制值被当成乱码字符串。
 *
 *   node test/pg-binary-params.test.js
 */
const { PgConnection } = require('../lib/pg_server');

let p = 0, f = 0;
const ok = (n, c, g) => { if (c) p++; else { f++; console.log('[FAIL]', n, '->', JSON.stringify(g)); } };

/** 构造一个 Bind 消息体：portal=''、stmt=''、formats、values */
function buildBind(formats, rawValues, stmtName = '') {
  const parts = [];
  parts.push(Buffer.from('\0', 'utf8'));                               // portal ''
  parts.push(Buffer.from(stmtName + '\0', 'utf8'));                    // statement
  const head = Buffer.alloc(2);
  head.writeInt16BE(formats.length, 0);
  parts.push(head);
  for (const fm of formats) { const b = Buffer.alloc(2); b.writeInt16BE(fm, 0); parts.push(b); }
  const nv = Buffer.alloc(2);
  nv.writeInt16BE(rawValues.length, 0);
  parts.push(nv);
  for (const v of rawValues) {
    const len = Buffer.alloc(4);
    if (v === null) { len.writeInt32BE(-1, 0); parts.push(len); continue; }
    len.writeInt32BE(v.length, 0);
    parts.push(len, v);
  }
  return Buffer.concat(parts);
}

function fakeConn() {
  const conn = Object.create(PgConnection.prototype);
  conn._prepared = new Map();
  conn._portal = new Map();
  conn._inTransaction = false;
  const sent = [];
  conn._send = (b) => { sent.push(Buffer.from(b)); return true; };
  conn.socket = { writable: true, write: () => true, end: () => {} };
  return { conn, sent };
}

/** 让 Bind 落到 portal 里，然后把解码后的参数取出来 */
async function bindValues(conn, formats, rawValues, paramTypes) {
  conn._prepared.set('', { sql: 'SELECT 1', paramTypes });
  conn._handleMessage(0x42, buildBind(formats, rawValues));
  const portal = conn._portal.get('');
  return portal ? portal.values : undefined;
}

(async () => {
  // ---- 文本格式不回归
  {
    const { conn } = fakeConn();
    const vs = await bindValues(conn, [0], [Buffer.from('hello', 'utf8')], [25]);
    ok('#93 文本格式仍按 utf8', JSON.stringify(vs) === JSON.stringify(['hello']), vs);
  }
  // ---- int4 二进制
  {
    const { conn } = fakeConn();
    const b = Buffer.alloc(4); b.writeInt32BE(123456, 0);
    const vs = await bindValues(conn, [1], [b], [23]);
    ok('#93 int4 二进制 → 123456', vs[0] === 123456, vs);
  }
  // ---- int8 二进制
  {
    const { conn } = fakeConn();
    const b = Buffer.alloc(8); b.writeBigInt64BE(9007199254740993n, 0);
    const vs = await bindValues(conn, [1], [b], [20]);
    ok('#93 int8 超出 2^53 → BigInt 精确值', vs[0] === 9007199254740993n, String(vs[0]));
  }
  {
    const { conn } = fakeConn();
    const b = Buffer.alloc(8); b.writeBigInt64BE(42n, 0);
    const vs = await bindValues(conn, [1], [b], [20]);
    ok('#93 int8 小整数 → number', vs[0] === 42, vs);
  }
  // ---- float8 / float4
  {
    const { conn } = fakeConn();
    const b8 = Buffer.alloc(8); b8.writeDoubleBE(3.141592653589793, 0);
    const b4 = Buffer.alloc(4); b4.writeFloatBE(1.5, 0);
    const vs = await bindValues(conn, [1, 1], [b8, b4], [701, 700]);
    ok('#93 float8 二进制', vs[0] === 3.141592653589793, vs);
    ok('#93 float4 二进制', vs[1] === 1.5, vs);
  }
  // ---- bool
  {
    const { conn } = fakeConn();
    const vs = await bindValues(conn, [1, 1], [Buffer.from([1]), Buffer.from([0])], [16, 16]);
    ok('#93 bool 二进制 true/false', vs[0] === true && vs[1] === false, vs);
  }
  // ---- numeric（二进制：ndigits,weight,sign,dscale,digits）
  {
    const { conn } = fakeConn();
    // 123.45 → ndigits=4? 用 12345/100: weight=1, dscale=2, digits=[1,2345, 0]... 简化用 [12,3450]
    const b = Buffer.alloc(8 + 2 * 2);
    b.writeInt16BE(2, 0);       // ndigits
    b.writeInt16BE(0, 2);       // weight
    b.writeUInt16BE(0x0000, 4); // sign 正
    b.writeInt16BE(2, 6);       // dscale
    b.writeInt16BE(12, 8);      // 12 * 10000^0
    b.writeInt16BE(3400, 10);   // 3400 * 10000^-1 = 0.34
    const vs = await bindValues(conn, [1], [b], [1700]);
    ok('#93 numeric 二进制 → "12.34"', String(vs[0]) === '12.34', vs);
  }
  // ---- date / timestamp
  {
    const { conn } = fakeConn();
    const d = Buffer.alloc(4); d.writeInt32BE(0, 0);                 // 2000-01-01
    const ts = Buffer.alloc(8); ts.writeBigInt64BE(0n, 0);           // 2000-01-01 00:00:00
    const vs = await bindValues(conn, [1, 1], [d, ts], [1082, 1114]);
    ok('#93 date 二进制 → 2000-01-01', vs[0] === '2000-01-01', vs);
    ok('#93 timestamp 二进制 → 2000-01-01 00:00:00', vs[1] === '2000-01-01 00:00:00', vs);
  }
  // ---- uuid
  {
    const { conn } = fakeConn();
    const b = Buffer.from('00112233445566778899aabbccddeeff', 'hex');
    const vs = await bindValues(conn, [1], [b], [2950]);
    ok('#93 uuid 二进制', vs[0] === '00112233-4455-6677-8899-aabbccddeeff', vs);
  }
  // ---- NULL
  {
    const { conn } = fakeConn();
    const vs = await bindValues(conn, [1], [null], [23]);
    ok('#93 NULL 二进制仍为 null', vs[0] === null, vs);
  }
  // ---- 混合格式：formats 长度 1 时对所有参数生效
  {
    const { conn } = fakeConn();
    const a = Buffer.alloc(4); a.writeInt32BE(7, 0);
    const vs = await bindValues(conn, [1], [a, Buffer.from('x', 'utf8')], [23, 25]);
    ok('#93 formats 单值对所有参数生效', vs[0] === 7 && vs[1] === 'x', vs);
  }
  // ---- 每参数独立格式
  {
    const { conn } = fakeConn();
    const a = Buffer.alloc(4); a.writeInt32BE(9, 0);
    const vs = await bindValues(conn, [1, 0], [a, Buffer.from('txt', 'utf8')], [23, 25]);
    ok('#93 逐参数格式混用', vs[0] === 9 && vs[1] === 'txt', vs);
  }

  console.log(`\npg-binary-params: ${p} passed, ${f} failed`);
  process.exit(f ? 1 : 0);
})().catch((e) => { console.log('ERR', e.stack); process.exit(1); });
