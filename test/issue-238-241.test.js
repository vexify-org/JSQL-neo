/*
 * Regression tests for issues #238-#241.
 *   node test/issue-238-241.test.js
 */
const path = require('path');
const ROOT = path.join(__dirname, '..');
const { formatDate, validateDateType } = require(path.join(ROOT, 'lib', 'date-types.js'));
const Cache = require(path.join(ROOT, 'lib', 'cache.js'));
const { JSQL } = require(path.join(ROOT, 'index.js'));

let passed = 0, failed = 0;
function ok(name, cond, extra) {
  if (cond) { passed++; console.log('[OK]', name); }
  else { failed++; console.log('[FAIL]', name, extra !== undefined ? '→ ' + JSON.stringify(extra) : ''); }
}

(async () => {
  // #238
  const f1 = formatDate('2024-01-02 13:45:59', 'YYYY-MM-DD HH:mm:ss HH');
  const f2 = formatDate('2024-01-02', 'YYYY YYYY');
  ok('#238 repeated format tokens all replaced', f1 === '2024-01-02 13:45:59 13' && f2 === '2024 2024', { f1, f2 });

  // #239
  const dates = ['0099-01-02', '0050-06-15', '0001-12-31'];
  let allOk = true;
  for (const s of dates) {
    try { if (validateDateType(s, 'date', 'd') !== s) allOk = false; } catch (e) { allOk = false; }
  }
  ok('#239 years 0001-0099 are valid', allOk);
  ok('#239 formatDate keeps low year', formatDate('0099-01-02', 'YYYY') === '0099', formatDate('0099-01-02', 'YYYY'));

  // #241
  {
    const c = new Cache();
    ['a*', 'ab', 'a?'].forEach(k => c.set(k, 1));
    const star = c.keys('a\\*');
    const qm = c.keys('a\\?');
    ok('#241 Cache.keys glob backslash escape', JSON.stringify(star) === JSON.stringify(['a*']) && JSON.stringify(qm) === JSON.stringify(['a?']), { star, qm });
    c.close();
  }

  // #240
  {
    const db = new JSQL();
    await db.start();
    await db.createTable('t', {
      id: { type: 'integer', primaryKey: true },
      v: { type: 'integer' },
      s: { type: 'string' },
    });
    await db.insert('t', { id: 1, v: 10, s: 'aa' });
    await db.insert('t', { id: 2, v: 20, s: 'bb' });
    const sum = await db.query('SELECT SUM(v) AS s FROM t');
    const avg = await db.query('SELECT AVG(v) AS v FROM t');
    const count = await db.query('SELECT COUNT(*) AS c FROM t');
    const plain = await db.query('SELECT s FROM t');
    ok('#240 aggregate column types do not use alias', sum.columnTypes[0] !== 'VARCHAR(255)' && avg.columnTypes[0] !== 'INT', { sum: sum.columnTypes, avg: avg.columnTypes });
    ok('#240 COUNT is INT', count.columnTypes[0] === 'INT', count.columnTypes);
    ok('#240 plain string column type', plain.columnTypes[0] === 'VARCHAR(255)', plain.columnTypes);
    await db.stop();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
