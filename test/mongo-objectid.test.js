/*
 * ObjectId 类型回归测试。
 *
 * 复现（v6.7.2 及之前）：BSON 解码把 0x07 直接 toString('hex')，ObjectId 的
 * 类型在协议边界就丢了。同一 24-hex 的 ObjectId 与 String 在真实 MongoDB 里
 * 是两个不同的键，这里却判为重复：insert 第二篇文档被静默丢弃，
 * insertMany ordered:false 也不报 writeErrors（实测两批数据分别丢
 * 148/4744 与 164/4824，重载后的行数恰好等于去掉孪生对后的数量）。
 *
 * 修复：ObjectId 成为一等 JS 值（lib/objectid.js），BSON 编解码、
 * .jsql 存储（TYPE.OID）、全库 === 判等点（valuesEqual）、$group/distinct
 * 规范键全部类型感知；真重复以 E11000 writeErrors 显式上报。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const { Database, createMongoServer } = require(path.join(ROOT, 'index.js'));
const { ObjectId } = require(path.join(ROOT, 'lib', 'objectid.js'));
const { bsonDocument, bsonReadDocument } = require(path.join(ROOT, 'lib', 'mongo_server.js'));

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('[OK]  ', name); }
  else { fail++; console.log('[FAIL]', name, extra !== undefined ? '-> ' + String(extra).slice(0, 300) : ''); }
}

(async () => {
  // --- Layer 0: BSON 编解码往返 ---
  {
    const oid = ObjectId.fromHex('507f1f77bcf86cd799439011');
    const doc = { _id: oid, s: 'plain string', twin: '507f1f77bcf86cd799439011', nested: { ref: oid }, arr: [oid, 'x'] };
    const buf = bsonDocument(doc);
    const back = bsonReadDocument(buf, 0).value;
    ok('bson: _id decodes back to ObjectId', back._id instanceof ObjectId && back._id.toString() === '507f1f77bcf86cd799439011', back._id);
    ok('bson: plain string stays a string', back.s === 'plain string');
    ok('bson: same-hex string stays a string (twin distinct)', back.twin === '507f1f77bcf86cd799439011' && !(back.twin instanceof ObjectId));
    ok('bson: nested ObjectId survives', back.nested.ref instanceof ObjectId && back.nested.ref.equals(oid));
    ok('bson: ObjectId in array survives', Array.isArray(back.arr) && back.arr[0] instanceof ObjectId && back.arr[1] === 'x');
    // 类型字节位：0x07 vs 0x02
    const wire = bsonDocument({ _id: oid }).toString('hex');
    ok('bson: ObjectId wire type is 0x07', wire.includes('075f696400'), wire.slice(0, 20));
  }

  // --- Layer 0.5: .jsql 存储往返 ---
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsql-oid-'));
    const db = new Database(dir, { mode: 'hybrid' });
    await db.createTable('c', {});
    const oid = ObjectId.fromHex('507f1f77bcf86cd799439011');
    await db.insert('c', { _id: oid, ref: ObjectId.fromHex('507f1f77bcf86cd799439011'), s: 'str' });
    await db.stop();
    const db2 = new Database(dir, { mode: 'hybrid' });
    const rows = await db2.find('c', {});
    ok('storage: ObjectId survives flush→reload as ObjectId',
      rows.length === 1 && rows[0]._id instanceof ObjectId && rows[0]._id.toString() === '507f1f77bcf86cd799439011', rows[0] && rows[0]._id);
    ok('storage: reloaded ObjectId equals original', rows[0]._id.equals(oid));
    await db2.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // --- Layer 1: e2e —— 用户实际场景（孪生 _id 不再互撞） ---
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsql-oidmongo-'));
    const srv = createMongoServer({ port: 0, noAuth: true, dataDir: dir });
    await new Promise((res) => srv.listen(res));

    const HEX = '507f1f77bcf86cd799439011';
    const ins = await srv._dispatch('insert', {
      insert: 'docs', $db: 'test',
      documents: [
        { _id: ObjectId.fromHex(HEX), kind: 'oid' },
        { _id: HEX, kind: 'str' },   // 真实 MongoDB 中合法的另一个键
        { _id: 3, kind: 'num' },
      ],
    });
    ok('e2e: twin ObjectId+String _ids both accepted', ins.ok === 1 && ins.n === 3 && !ins.writeErrors, ins);

    // 真重复必须显式报错而不是静默丢弃
    const dup = await srv._dispatch('insert', {
      insert: 'docs', $db: 'test', ordered: false,
      documents: [{ _id: ObjectId.fromHex(HEX), kind: 'oid-dup' }, { _id: 4, kind: 'ok' }],
    });
    ok('e2e: true duplicate surfaces E11000 writeErrors',
      dup.n === 1 && Array.isArray(dup.writeErrors) && dup.writeErrors.length === 1 && dup.writeErrors[0].code === 11000, dup);

    await new Promise((res) => srv.close(res));

    // 重载：两篇孪生文档都必须在
    const srv2 = createMongoServer({ port: 0, noAuth: true, dataDir: dir });
    await new Promise((res) => srv2.listen(res));
    const found = await srv2._dispatch('find', { find: 'docs', filter: {}, $db: 'test' });
    const batch = found.cursor ? found.cursor.firstBatch : [];
    ok('e2e: all rows survive reload (twins intact)', batch.length === 4, batch.length);

    // 按 ObjectId 查询命中 oid 文档而非孪生 string 文档
    const byOid = await srv2._dispatch('find', { find: 'docs', filter: { _id: ObjectId.fromHex(HEX) }, $db: 'test' });
    const oidRows = byOid.cursor ? byOid.cursor.firstBatch : [];
    ok('e2e: find by ObjectId returns only the oid doc', oidRows.length === 1 && oidRows[0].kind === 'oid', oidRows);
    const byStr = await srv2._dispatch('find', { find: 'docs', filter: { _id: HEX }, $db: 'test' });
    const strRows = byStr.cursor ? byStr.cursor.firstBatch : [];
    ok('e2e: find by String returns only the string doc', strRows.length === 1 && strRows[0].kind === 'str', strRows);

    // $in / $type
    const inMixed = await srv2._dispatch('find', { find: 'docs', filter: { _id: { $in: [ObjectId.fromHex(HEX), 3] } }, $db: 'test' });
    const inRows = inMixed.cursor ? inMixed.cursor.firstBatch : [];
    ok('e2e: $in [oid, 3] matches exactly oid+num docs', inRows.length === 2 && ['oid', 'num'].every(k => inRows.some(r => r.kind === k)), inRows);
    const typeQ = await srv2._dispatch('find', { find: 'docs', filter: { _id: { $type: 'objectId' } }, $db: 'test' });
    const typeRows = typeQ.cursor ? typeQ.cursor.firstBatch : [];
    ok('e2e: $type objectId matches only oid doc', typeRows.length === 1 && typeRows[0].kind === 'oid', typeRows);

    // $group：同字节 ObjectId 不拆组；ObjectId 与 String 仍分组
    const agg = await srv2._dispatch('aggregate', {
      aggregate: 'docs', $db: 'test',
      pipeline: [{ $group: { _id: '$_id', n: { $sum: 1 } } }],
    });
    const groups = agg.cursor ? agg.cursor.firstBatch : [];
    const oidGroup = groups.find(g => g._id instanceof ObjectId && g._id.toString() === HEX);
    ok('e2e: $group keeps oid and string twins in separate groups', groups.length === 4, groups.map(g => String(g._id)));
    ok('e2e: $group oid group has exactly 1 member', oidGroup && oidGroup.n === 1, oidGroup);

    // $sort：重复 ObjectId 值（外键场景）不能让比较器失序（同字节不 ===）
    await srv2._dispatch('insert', {
      insert: 'refs', $db: 'test',
      documents: [
        { _id: 1, ref: ObjectId.fromHex(HEX), tag: 'a' },
        { _id: 2, ref: ObjectId.fromHex(HEX), tag: 'b' },
        { _id: 3, ref: ObjectId.fromHex('507f1f77bcf86cd799439022'), tag: 'c' },
      ],
    });
    const sorted = await srv2._dispatch('aggregate', {
      aggregate: 'refs', $db: 'test',
      pipeline: [{ $sort: { ref: 1 } }],
    });
    const srows = sorted.cursor ? sorted.cursor.firstBatch : [];
    ok('e2e: $sort by ObjectId field orders by bytes',
      srows.length === 3 && srows.map(r => r.tag).join(',') === 'a,b,c', srows.map(r => r.tag));

    // distinct：两种类型都作为独立值返回
    const d = await srv2._dispatch('distinct', { distinct: 'docs', key: '_id', query: {}, $db: 'test' });
    ok('e2e: distinct returns both twin values', d.values.length === 4, d.values.map(String));

    // update/delete 按 ObjectId 精确命中
    const upd = await srv2._dispatch('update', { update: 'docs', updates: [{ q: { _id: ObjectId.fromHex(HEX) }, u: { $set: { kind: 'oid-updated' } } }], $db: 'test' });
    ok('e2e: update by ObjectId touches only the oid doc', upd.n === 1, upd);
    const del = await srv2._dispatch('delete', { delete: 'docs', deletes: [{ q: { _id: ObjectId.fromHex(HEX) }, limit: 1 }], $db: 'test' });
    ok('e2e: delete by ObjectId removes only the oid doc', del.n === 1, del);
    const after = await srv2._dispatch('find', { find: 'docs', filter: {}, $db: 'test' });
    const remain = after.cursor ? after.cursor.firstBatch : [];
    ok('e2e: string twin still present after oid delete', remain.length === 3 && remain.some(r => r._id === HEX), remain.map(r => r._id));

    await new Promise((res) => srv2.close(res));
    fs.rmSync(dir, { recursive: true, force: true });
  }

  console.log(fail === 0 ? `\nALL ${pass} TESTS PASSED` : `\n${fail} FAILURES (${pass} passed)`);
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => {
  console.error('FATAL:', e.message, e.stack);
  process.exit(1);
});
