/*
 * Issue #47 — MongoDB $sort 无论升降序都把 NULL 排在最后。
 *
 * MongoDB 语义：升序 null 在最前，降序 null 在最后。
 * v6.5.26 的比较器在应用方向之前就 return 1 / -1，导致升序时 null 恒在末尾。
 */
const path = require('path');
const { createMongoServer } = require(path.join(__dirname, '..', 'lib', 'mongo_server.js'));

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('[OK]  ', name); }
  else { fail++; console.log('[FAIL]', name, extra !== undefined ? '-> ' + JSON.stringify(extra).slice(0, 300) : ''); }
}

async function sorted(srv, dir) {
  const r = await srv._dispatch('aggregate', {
    aggregate: 's',
    pipeline: [{ $sort: { score: dir } }],
    $db: 'test',
  });
  const batch = r.cursor ? r.cursor.firstBatch : [];
  return batch.map(x => (x.score === undefined ? null : x.score));
}

(async () => {
  try {
    const srv = createMongoServer({ port: 0, noAuth: true, dataDir: ':memory:' });
    const engine = await srv._getEngine('test');
    await engine.createTable('s', { _id: { type: 'integer' }, score: { type: 'integer' } });
    const table = engine._ensureTable('s');
    table._rows = [
      { _id: 1, score: 20 },
      { _id: 2, score: null },
      { _id: 3, score: 10 },
      { _id: 4, score: 30 },
    ];

    const asc = await sorted(srv, 1);
    ok('#47 升序 null 排最前', JSON.stringify(asc) === JSON.stringify([null, 10, 20, 30]), asc);

    const desc = await sorted(srv, -1);
    ok('#47 降序 null 排最后', JSON.stringify(desc) === JSON.stringify([30, 20, 10, null]), desc);

    // 多键排序：第一键相同时第二键的 null 也要跟随方向
    table._rows = [
      { _id: 1, g: 'a', score: null },
      { _id: 2, g: 'a', score: 5 },
      { _id: 3, g: 'a', score: 1 },
    ];
    const r = await srv._dispatch('aggregate', {
      aggregate: 's',
      pipeline: [{ $sort: { g: 1, score: -1 } }],
      $db: 'test',
    });
    const multi = (r.cursor ? r.cursor.firstBatch : []).map(x => x.score);
    ok('#47 多键降序 null 排最后', JSON.stringify(multi) === JSON.stringify([5, 1, null]), multi);
  } catch (e) {
    fail++;
    console.log('[FAIL] unexpected exception:', e && e.stack || e);
  }

  console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed\n`);
  if (fail > 0) process.exit(1);
})();
