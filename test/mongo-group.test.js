// Test: MongoDB $group aggregation operators
// Directly tests the _dispatch method of createMongoServer
const { createMongoServer } = require('../lib/mongo_server.js');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('[OK]', name); }
  else { fail++; console.log('[FAIL]', name, extra !== undefined ? '→ ' + JSON.stringify(extra) : ''); }
};

// Build a test server with a pre-populated collection
const srv = createMongoServer({ port: 0, noAuth: true, dataDir: ':memory:' });
srv.listen(() => {
  (async () => {
    // Get the engine and pre-populate
    const engine = await srv._getEngine();
    engine.createTable('sales', { schema: { _id: { type: 'integer' }, item: { type: 'string' }, qty: { type: 'integer' }, price: { type: 'integer' } } });
    const table = engine._ensureTable('sales');
    table._rows = [
      { _id: 1, item: 'A', qty: 10, price: 5 },
      { _id: 2, item: 'B', qty: 5, price: 10 },
      { _id: 3, item: 'A', qty: 3, price: 5 },
      { _id: 4, item: 'B', qty: 7, price: 10 },
    ];

    // --- Test 1: $group with $sum on field (the bug we're fixing) ---
    let r = await srv._dispatch('aggregate', {
      aggregate: 'sales',
      pipeline: [{ '$group': { _id: '$item', total: { '$sum': '$qty' } } }],
      '$db': 'test'
    });
    const batch1 = r.cursor ? r.cursor.firstBatch : [];
    const byItem = {};
    for (const row of batch1) byItem[row._id] = row.total;
    ok('$group $sum on field (item:A)', byItem['A'] === 13, byItem);
    ok('$group $sum on field (item:B)', byItem['B'] === 12, byItem);

    // --- Test 2: $group with $sum:1 (count) ---
    r = await srv._dispatch('aggregate', {
      aggregate: 'sales',
      pipeline: [{ '$group': { _id: '$item', count: { '$sum': 1 } } }],
      '$db': 'test'
    });
    const batch2 = r.cursor ? r.cursor.firstBatch : [];
    const byCount = {};
    for (const row of batch2) byCount[row._id] = row.count;
    ok('$group $sum:1 count (item:A)', byCount['A'] === 2, byCount);
    ok('$group $sum:1 count (item:B)', byCount['B'] === 2, byCount);

    // --- Test 3: $group with $avg ---
    r = await srv._dispatch('aggregate', {
      aggregate: 'sales',
      pipeline: [{ '$group': { _id: '$item', avgQty: { '$avg': '$qty' } } }],
      '$db': 'test'
    });
    const batch3 = r.cursor ? r.cursor.firstBatch : [];
    const byAvg = {};
    for (const row of batch3) byAvg[row._id] = row.avgQty;
    ok('$group $avg on field (item:A)', byAvg['A'] === 6.5, byAvg);
    ok('$group $avg on field (item:B)', byAvg['B'] === 6, byAvg);

    // --- Test 4: $group with $min / $max ---
    r = await srv._dispatch('aggregate', {
      aggregate: 'sales',
      pipeline: [{ '$group': { _id: '$item', minQty: { '$min': '$qty' }, maxQty: { '$max': '$qty' } } }],
      '$db': 'test'
    });
    const batch4 = r.cursor ? r.cursor.firstBatch : [];
    const byRange = {};
    for (const row of batch4) byRange[row._id] = { min: row.minQty, max: row.maxQty };
    ok('$group $min (item:A)', byRange['A'] && byRange['A'].min === 3, byRange);
    ok('$group $min (item:B)', byRange['B'] && byRange['B'].min === 5, byRange);
    ok('$group $max (item:A)', byRange['A'] && byRange['A'].max === 10, byRange);
    ok('$group $max (item:B)', byRange['B'] && byRange['B'].max === 7, byRange);

    // --- Test 5: existing $sum:1 still works ---
    r = await srv._dispatch('aggregate', {
      aggregate: 'sales',
      pipeline: [{ '$group': { _id: '$item', cnt: { '$sum': 1 } } }],
      '$db': 'test'
    });
    const batch5 = r.cursor ? r.cursor.firstBatch : [];
    const byCnt = {};
    for (const row of batch5) byCnt[row._id] = row.cnt;
    ok('$group $sum:1 (count) still works', byCnt['A'] === 2 && byCnt['B'] === 2, byCnt);

    // --- Test 6: $group with $sum on a different field ---
    r = await srv._dispatch('aggregate', {
      aggregate: 'sales',
      pipeline: [{ '$group': { _id: '$item', totalPrice: { '$sum': '$price' } } }],
      '$db': 'test'
    });
    const batch6 = r.cursor ? r.cursor.firstBatch : [];
    const byPrice = {};
    for (const row of batch6) byPrice[row._id] = row.totalPrice;
    ok('$group $sum on different field (price)', byPrice['A'] === 10 && byPrice['B'] === 20, byPrice);

    srv.close();
    console.log(fail === 0 ? '\nALL TESTS PASSED' : `\n${fail} FAILURES`);
    process.exit(fail === 0 ? 0 : 1);
  })().catch(e => {
    console.error('FATAL:', e.message, e.stack);
    process.exit(1);
  });
});
