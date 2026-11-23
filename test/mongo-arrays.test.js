/*
 * MongoDB 数组字段过滤语义 + find 排序（与上游 dict 的 6 项缺陷对应）：
 *
 *  1. find 命令静默忽略 sort —— 排序只在 aggregate 生效，sort+skip/limit 分页取错页。
 *  2. 数组字段无元素匹配语义：{tags:"a"} / $in / $nin 拿整个数组对象比较，全部落空。
 *  3. $ne 用严格 !== ：同字节 ObjectId 等值被误判（编译快路径 $eq/$in/$nin 同病）。
 *  4. $all 未实现：mongo_server 里未知操作符 vacuous 通过，table.js 里恒 false。
 *  5. $elemMatch 只认对象元素：标量元素的操作符条件永远不命中。
 *  6. 索引快路径丢行：数组字段的元素命中不在标量索引键里；range 路径还把
 *     空索引命中当「无数据」。schemaless / JSON 列现在跳过索引走全表过滤。
 *
 * 范围声明：null/缺失不参与范围比较（JS 的 null > -1 === true 是陷阱）；
 * findAndModify 现在也尊重 doc.sort。
 */
const path = require('path');
const { Database, createMongoServer } = require(path.join(__dirname, '..', 'index.js'));
const { ObjectId } = require(path.join(__dirname, '..', 'lib', 'objectid.js'));

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('[OK]  ', name); }
  else { fail++; console.log('[FAIL]', name, extra !== undefined ? '-> ' + JSON.stringify(extra, (k, v) => v && v.bytes ? v.toString() : v).slice(0, 300) : ''); }
}

async function insert(srv, docs) {
  const r = await srv._dispatch('insert', { insert: 'c', $db: 'test', documents: docs });
  if (r.ok !== 1 || r.n !== docs.length) throw new Error('insert failed: ' + JSON.stringify(r));
}

async function find(srv, filter, extra = {}) {
  const r = await srv._dispatch('find', { find: 'c', $db: 'test', filter, ...extra });
  return r.cursor ? r.cursor.firstBatch : [];
}

const ids = (batch) => batch.map((d) => d._id).sort((a, b) => a - b);

(async () => {
  try {
    /* ---------- 1. find + sort + skip/limit（mongo_server） ---------- */
    {
      const srv = createMongoServer({ port: 0, noAuth: true, dataDir: ':memory:' });
      await (await srv._getEngine('test')).createTable('c', {});
      await insert(srv, [
        { _id: 1, score: 30, g: 'b' },
        { _id: 2, score: 10, g: 'a' },
        { _id: 3, score: 20, g: 'a' },
        { _id: 4, score: 20, g: 'b' },
      ]);

      const asc = await find(srv, {}, { sort: { score: 1 } });
      ok('find sort 升序生效', JSON.stringify(asc.map((d) => d.score)) === JSON.stringify([10, 20, 20, 30]), asc.map((d) => d.score));

      const page = await find(srv, {}, { sort: { score: -1 }, skip: 1, limit: 2 });
      ok('find sort+skip+limit 分页（sort 先于分页）', JSON.stringify(page.map((d) => d.score)) === JSON.stringify([20, 20]), page.map((d) => d.score));

      const multi = await find(srv, {}, { sort: { g: 1, score: -1 } });
      ok('find 多键排序', JSON.stringify(multi.map((d) => [d.g, d.score])) === JSON.stringify([['a', 20], ['a', 10], ['b', 30], ['b', 20]]), multi.map((d) => [d.g, d.score]));

      const fam = await srv._dispatch('findAndModify', {
        findAndModify: 'c', $db: 'test', query: {}, sort: { score: -1 }, update: { $set: { top: true } },
      });
      ok('findAndModify 尊重 sort（取最高分）', fam.value && fam.value._id === 1, fam.value);
    }

    /* ---------- 2-5. 数组字段过滤语义（mongo_server._match） ---------- */
    {
      const srv = createMongoServer({ port: 0, noAuth: true, dataDir: ':memory:' });
      await (await srv._getEngine('test')).createTable('c', {});
      await insert(srv, [
        { _id: 1, tags: ['a', 'b'], scores: [5, 15] },
        { _id: 2, tags: ['b'], scores: [25] },
        { _id: 3, tags: ['c'], scores: [20], note: 'no arrays on other fields' },
      ]);

      ok('{tags:"a"} 元素命中', JSON.stringify(ids(await find(srv, { tags: 'a' }))) === '[1]');
      ok('{tags:{$eq:"b"}} 元素命中', JSON.stringify(ids(await find(srv, { tags: { $eq: 'b' } }))) === '[1,2]');
      ok('{tags:{$in:["a","c"]}}', JSON.stringify(ids(await find(srv, { tags: { $in: ['a', 'c'] } }))) === '[1,3]');
      ok('{tags:{$nin:["b"]}}', JSON.stringify(ids(await find(srv, { tags: { $nin: ['b'] } }))) === '[3]');
      ok('{tags:{$ne:"b"}}', JSON.stringify(ids(await find(srv, { tags: { $ne: 'b' } }))) === '[3]');
      ok('{tags:{$all:["a","b"]}}', JSON.stringify(ids(await find(srv, { tags: { $all: ['a', 'b'] } }))) === '[1]');
      ok('{tags:{$all:["b"]}}', JSON.stringify(ids(await find(srv, { tags: { $all: ['b'] } }))) === '[1,2]');
      ok('{tags:{$gt:"a"}} 元素范围（"b">"a"、"c">"a"）', JSON.stringify(ids(await find(srv, { tags: { $gt: 'a' } }))) === '[1,2,3]');
      ok('{scores:{$elemMatch:{$gt:10,$lt:25}}} 标量元素', JSON.stringify(ids(await find(srv, { scores: { $elemMatch: { $gt: 10, $lt: 25 } } }))) === '[1,3]');
      // shortcut: 整数组等值（{arr:[1,2]} / $in:[[1,2]]）仍是引用严格相等，需要时再补深度相等
      ok('{note:{$all:["no arrays on other fields"]}} 标量字段退化等值', JSON.stringify(ids(await find(srv, { note: { $all: ['no arrays on other fields'] } }))) === '[3]');

      // aggregate $match 复用同一 _match，抽查一个
      const agg = await srv._dispatch('aggregate', {
        aggregate: 'c', $db: 'test', pipeline: [{ $match: { tags: 'a' } }],
      });
      ok('aggregate $match 数组语义', JSON.stringify(ids(agg.cursor.firstBatch)) === '[1]');

      // null/缺失不参与范围比较：null > -1 在 JS 里是 true，必须挡住
      const nullSrv = createMongoServer({ port: 0, noAuth: true, dataDir: ':memory:' });
      await (await nullSrv._getEngine('test')).createTable('c', {});
      await insert(nullSrv, [{ _id: 1, score: null }, { _id: 2, score: 5 }]);
      ok('{score:{$gt:-1}} 不命中 null', JSON.stringify(ids(await find(nullSrv, { score: { $gt: -1 } }))) === '[2]');
    }

    /* ---------- 3. $ne 同字节 ObjectId（table.js 编译快路径） ---------- */
    {
      const db = new Database(':memory:');
      await db.createTable('oid', {});
      await db.insert('oid', { _id: 1, ref: new ObjectId('aaaaaaaaaaaaaaaaaaaaaaaa') });
      await db.insert('oid', { _id: 2, ref: new ObjectId('bbbbbbbbbbbbbbbbbbbbbbbb') });
      const rows = await db.find('oid', { ref: { $ne: new ObjectId('aaaaaaaaaaaaaaaaaaaaaaaa') } });
      ok('table $ne：同字节 ObjectId 实例视为相等', JSON.stringify(rows.map((r) => r._id)) === '[2]', rows.map((r) => r._id));
      const eq = await db.find('oid', { ref: new ObjectId('bbbbbbbbbbbbbbbbbbbbbbbb') });
      ok('table 隐式等值：同字节 ObjectId 命中（快路径 valuesEqual）', JSON.stringify(eq.map((r) => r._id)) === '[2]', eq.map((r) => r._id));
    }

    /* ---------- 2/4/5/6. table.js 文档 API + 索引正确性 ---------- */
    {
      const db = new Database(':memory:');
      // type 'object'：json 类型的字符串值必须是合法 JSON，会拒绝标量 'a'；
      // object 类型不做该校验，标量与数组可以共存
      await db.createTable('t', { id: { type: 'integer', primaryKey: true }, tags: { type: 'object' } });
      await db.insert('t', { id: 1, tags: ['a', 'b'] });
      await db.insert('t', { id: 2, tags: 'a' }); // 标量共存：索引命中部分行时数组行不能丢
      await db.insert('t', { id: 3, tags: ['c'] });

      // 6：先建索引（hash + B-Tree 都过一遍），数组行不得被索引预过滤丢掉
      const table = db._ensureTable('t');
      const withHash = await db.find('t', { tags: 'a' });
      table.createIndex('tags');
      const withHashIdx = await db.find('t', { tags: 'a' });
      table.dropIndex('tags');
      table.createBTreeIndex('tags');
      const withBTree = await db.find('t', { tags: 'a' });
      ok('无索引：{tags:"a"} 命中数组+标量行', JSON.stringify(withHash.map((r) => r.id)) === '[1,2]', withHash.map((r) => r.id));
      ok('hash 索引不丢数组行', JSON.stringify(withHashIdx.map((r) => r.id)) === '[1,2]', withHashIdx.map((r) => r.id));
      ok('B-Tree 索引不丢数组行', JSON.stringify(withBTree.map((r) => r.id)) === '[1,2]', withBTree.map((r) => r.id));

      const inRows = await db.find('t', { tags: { $in: ['a', 'c'] } });
      ok('table $in 数组语义（B-Tree 在场）', JSON.stringify(inRows.map((r) => r.id).sort()) === '[1,2,3]', inRows.map((r) => r.id));

      const ninRows = await db.find('t', { tags: { $nin: ['b', 'a'] } });
      ok('table $nin 数组语义', JSON.stringify(ninRows.map((r) => r.id)) === '[3]', ninRows.map((r) => r.id));

      const allRows = await db.find('t', { tags: { $all: ['a', 'b'] } });
      ok('table $all', JSON.stringify(allRows.map((r) => r.id)) === '[1]', allRows.map((r) => r.id));

      const emRows = await db.find('t', { tags: { $elemMatch: { $eq: 'c' } } });
      ok('table $elemMatch 标量元素（操作符条件）', JSON.stringify(emRows.map((r) => r.id)) === '[3]', emRows.map((r) => r.id));

      // 6：JSON 列上的范围查询走全表过滤（B-Tree 范围键只有标量行）
      await db.createTable('r', { id: { type: 'integer', primaryKey: true }, v: { type: 'json' } });
      await db.insert('r', { id: 1, v: [5] });
      await db.insert('r', { id: 2, v: [15] });
      await db.insert('r', { id: 3, v: 10 });
      const rt = db._ensureTable('r');
      rt.createBTreeIndex('v');
      const gt = await db.find('r', { v: { $gt: 6 } });
      ok('JSON 列范围查询索引不丢行（元素+标量都命中）', JSON.stringify(gt.map((x) => x.id).sort()) === '[2,3]', gt.map((x) => x.id));

      // 标量类型列的索引快路径保持原行为（不受 guard 影响）
      await db.createTable('s', { id: { type: 'integer', primaryKey: true }, n: { type: 'integer' } });
      await db.insert('s', { id: 1, n: 1 });
      await db.insert('s', { id: 2, n: 2 });
      db._ensureTable('s').createBTreeIndex('n');
      const sRows = await db.find('s', { n: { $gte: 2 } });
      ok('标量列 B-Tree 范围仍正确', JSON.stringify(sRows.map((x) => x.id)) === '[2]', sRows.map((x) => x.id));

      // update/remove 也走 _applyFilterOptimized：数组字段不得漏改漏删
      const upd = await db.update('t', { tags: 'a' }, { $set: { hit: true } });
      ok('update 按数组语义命中所有行', upd === 2, upd);
    }
    /* ---------- 6.8.25 回归：PR #122 尾部提交（86fb5ee）未随合并进入 main ---------- */
    {
      const srv = createMongoServer({ port: 0, noAuth: true, dataDir: ':memory:' });
      await (await srv._getEngine('test')).createTable('c', {});
      await insert(srv, [
        { _id: 1, a: [1], d: new Date('2026-01-01T00:00:00Z'), user: { name: 'x' } },
        { _id: 2, b: 1, d: new Date('2026-06-01T00:00:00Z'), user: { name: 'y' } },
      ]);

      ok('wire {$all:[]} 恒不匹配（[].every vacuous true 陷阱）', (await find(srv, { a: { $all: [] } })).length === 0);
      ok('wire {d: <Date>} 不再 vacuous 匹配全表（getTime 等值）', JSON.stringify(ids(await find(srv, { d: new Date('2026-01-01T00:00:00Z') }))) === '[1]');
      ok('wire 整数组等值 {a: [1]}（valuesEqual 数组分支）', JSON.stringify(ids(await find(srv, { a: [1] }))) === '[1]');
      ok('wire {a: {$in: [[1]]}} 命中整数组', JSON.stringify(ids(await find(srv, { a: { $in: [[1]] } }))) === '[1]');
      ok('wire {a: {$ne: [2]}} 整数组取反', JSON.stringify(ids(await find(srv, { a: { $ne: [2] } }))) === '[1,2]');
      ok('wire 子文档条件（#219 deepEqualMongo）不 vacuous', JSON.stringify(ids(await find(srv, { user: { name: 'x' } }))) === '[1]');
      ok('wire {$type: "array"}（#220 bsonTypeOf）', JSON.stringify(ids(await find(srv, { a: { $type: 'array' } }))) === '[1]');

      const db = new Database(':memory:');
      await db.createTable('t', { id: { type: 'integer', primaryKey: true }, a: { type: 'object' }, d: { type: 'date' }, bin: { type: 'object' } });
      await db.insert('t', { id: 1, a: [1] });
      await db.insert('t', { id: 2, d: new Date('2026-01-01T00:00:00Z'), bin: Buffer.from([1, 2]) });

      ok('table {$all:[]} 恒不匹配', (await db.find('t', { a: { $all: [] } })).length === 0);
      ok('table {$type: "array"}（typeof 陷阱）', JSON.stringify((await db.find('t', { a: { $type: 'array' } })).map((r) => r.id)) === '[1]');
      const byDate = await db.find('t', { d: new Date('2026-01-01T00:00:00Z') });
      ok('table 日期列 find({d: Date}) 归一后命中', JSON.stringify(byDate.map((r) => r.id)) === '[2]', byDate.map((r) => r.id));
      const gtDate = await db.find('t', { d: { $gt: new Date('2020-01-01T00:00:00Z') } });
      ok('table 日期列范围查询（Date 归一成存储字符串后比较）', JSON.stringify(gtDate.map((r) => r.id)) === '[2]', gtDate.map((r) => r.id));
      const byBin = await db.find('t', { bin: Buffer.from([1, 2]) });
      ok('table Buffer 等值（内容相等而非引用）', JSON.stringify(byBin.map((r) => r.id)) === '[2]', byBin.map((r) => r.id));
      const wholeArr = await db.find('t', { a: [1] });
      ok('table 整数组等值 {a: [1]}', JSON.stringify(wholeArr.map((r) => r.id)) === '[1]', wholeArr.map((r) => r.id));

      await db.createTable('sd', {});
      await db.insert('sd', { _id: 1, at: new Date('2026-01-01T00:00:00Z') });
      await db.insert('sd', { _id: 2, at: new Date('2026-06-01T00:00:00Z') });
      const schemalessDate = await db.find('sd', { at: new Date('2026-01-01T00:00:00Z') });
      ok('table schemaless Date 等值（valuesEqual getTime）', JSON.stringify(schemalessDate.map((r) => r._id)) === '[1]', schemalessDate.map((r) => r._id));
    }
  } catch (e) {
    fail++;
    console.log('[FAIL] unexpected exception:', e && e.stack || e);
  }

  console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed\n`);
  if (fail > 0) process.exit(1);
})();
