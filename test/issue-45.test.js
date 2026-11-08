/*
 * Issue #45 — MongoDB $avg 把 NULL 当 0 且计入分母。
 *
 * [10, null, 30] 曾经得到 (10+0+30)/3 = 13.33，MongoDB 是 20；
 * 全 null 的分组曾经返回 0，MongoDB 返回 null。
 */
const path = require('path');
const { createMongoServer } = require(path.join(__dirname, '..', 'lib', 'mongo_server.js'));

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('[OK]  ', name); }
  else { fail++; console.log('[FAIL]', name, extra !== undefined ? '-> ' + JSON.stringify(extra).slice(0, 300) : ''); }
}

(async () => {
  try {
    const srv = createMongoServer({ port: 0, noAuth: true, dataDir: ':memory:' });
    const engine = await srv._getEngine('test');
    await engine.createTable('m', {
      _id: { type: 'integer' },
      g: { type: 'string' },
      x: { type: 'integer' },
    });
    const table = engine._ensureTable('m');
    table._rows = [
      { _id: 1, g: 'a', x: 10 },
      { _id: 2, g: 'a', x: null },
      { _id: 3, g: 'a', x: 30 },
      { _id: 4, g: 'b', x: null },
      { _id: 5, g: 'b', x: undefined },
    ];

    const r = await srv._dispatch('aggregate', {
      aggregate: 'm',
      pipeline: [{ $group: { _id: '$g', avg: { $avg: '$x' } } }],
      $db: 'test',
    });
    const batch = r.cursor ? r.cursor.firstBatch : [];
    const byGroup = {};
    for (const row of batch) byGroup[row._id] = row.avg;

    ok('#45 $avg 忽略 null：#a = (10+30)/2 = 20', byGroup.a === 20, byGroup);
    ok('#45 全 null 组返回 null', byGroup.b === null, byGroup);

    // $sum 语义不受影响（null 加 0 仍是 no-op）
    const r2 = await srv._dispatch('aggregate', {
      aggregate: 'm',
      pipeline: [{ $group: { _id: '$g', total: { $sum: '$x' } } }],
      $db: 'test',
    });
    const bySum = {};
    for (const row of (r2.cursor ? r2.cursor.firstBatch : [])) bySum[row._id] = row.total;
    ok('#45 $sum 不受影响：#a = 40', bySum.a === 40, bySum);
  } catch (e) {
    fail++;
    console.log('[FAIL] unexpected exception:', e && e.stack || e);
  }

  console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed\n`);
  if (fail > 0) process.exit(1);
})();
