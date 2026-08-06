/*
 * JSQL-NEO benchmark: native (Rust N-API) vs Pure JS (Database) vs better-sqlite3 vs sql.js (WASM sqlite)
 *
 *   node bench/bench.js [--rows 100000] [--json]
 * Outputs a comparison table and writes bench/report.md.
 */
const path = require('path');

const ROWS = Number(process.argv.find((a, i) => process.argv[i - 1] === '--rows') || 100000);
const JSON_OUT = process.argv.includes('--json');

const dbDir = '/tmp/opencode/bench-data';

const SCHEMA = {
  id: { type: 'integer', primaryKey: true, autoIncrement: true },
  name: { type: 'string' },
  age: { type: 'integer' },
  email: { type: 'string' },
  score: { type: 'float' },
};

function genData(n) {
  const rows = [];
  for (let i = 0; i < n; i++) {
    rows.push({ name: `user_${i + 1}`, age: 20 + (i % 50), email: `user_${i + 1}@test.com`, score: (i % 10000) / 100.0 });
  }
  return rows;
}

const results = { rows: ROWS, engines: {} };

async function bench(name, setup, ops) {
  const t = Date.now();
  const r = await ops();
  const ms = Date.now() - t;
  results.engines[name] = r;
  results.engines[name].ms = ms;
  return { ms, ...r };
}

const label = (r) => `${r.ms}ms (${(ROWS / r.ms / 1000).toFixed(2)}M/s)` + (r.insertMs !== undefined ? `, insert ${r.insertMs}ms` : '');

(async () => {
  /* ---------- Pure JS ---------- */
  {
    const Database = require('../lib/database');
    const db = new Database(':memory:', { autoSave: false });
    await db.createTable('bench', SCHEMA);
    const data = genData(ROWS);
    const r = await bench('Pure JS', null, async () => {
      const t0 = Date.now();
      for (let i = 0; i < data.length; i += 2000) await db.insert('bench', data.slice(i, i + 2000));
      const insertMs = Date.now() - t0;
      let found = 0;
      let t1 = Date.now();
      for (let i = 0; i < 500; i++) { const rows = await db.find('bench', { age: 25 }); found += rows.length; }
      const pointMs = Date.now() - t1;
      t1 = Date.now();
      for (let i = 0; i < 500; i++) { const rows = await db.find('bench', { score: { $gt: 50 } }, { limit: 100 }); found += rows.length; }
      const rangeMs = Date.now() - t1;
      t1 = Date.now();
      const total = await db.count('bench');
      const countMs = Date.now() - t1;
      t1 = Date.now();
      for (let i = 0; i < 200; i++) await db.update('bench', { id: (i % ROWS) + 1 }, { age: 99 });
      const updateMs = Date.now() - t1;
      return { insertMs, pointMs, rangeMs, countMs, updateMs, count: total, found };
    });
    console.log(`[Pure JS]  ${label(r)}`);
  }

  /* ---------- Native (Rust N-API) ---------- */
  {
    const { JSQL } = require('../lib/native_client');
    const db = new JSQL({ flushThreshold: ROWS + 1 });
    await db.createTable('bench', SCHEMA);
    const data = genData(ROWS);
    const r = await bench('Native', null, async () => {
      const t0 = Date.now();
      await db.insert('bench', data);
      const insertMs = Date.now() - t0;
      let found = 0;
      let t1 = Date.now();
      for (let i = 0; i < 500; i++) { const rows = await db.find('bench', { age: 25 }); found += rows.length; }
      const pointMs = Date.now() - t1;
      t1 = Date.now();
      for (let i = 0; i < 500; i++) { const rows = await db.find('bench', { score: { $gt: 50 } }, { limit: 100 }); found += rows.length; }
      const rangeMs = Date.now() - t1;
      t1 = Date.now();
      const total = await db.count('bench');
      const countMs = Date.now() - t1;
      t1 = Date.now();
      for (let i = 0; i < 200; i++) await db.updateById('bench', (i % ROWS) + 1, { age: 99 });
      const updateMs = Date.now() - t1;
      return { insertMs, pointMs, rangeMs, countMs, updateMs, count: total, found };
    });
    await db.stop();
    console.log(`[Native]   ${label(r)}`);
  }

  /* ---------- better-sqlite3 ---------- */
  {
    const Database = require('better-sqlite3');
    const db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
    db.exec('CREATE TABLE bench (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, age INTEGER, email TEXT, score REAL)');
    const ins = db.prepare('INSERT INTO bench (name, age, email, score) VALUES (?, ?, ?, ?)');
    const data = genData(ROWS);
    const r = await bench('better-sqlite3', null, async () => {
      const t0 = Date.now();
      db.transaction(() => { for (const d of data) ins.run(d.name, d.age, d.email, d.score); })();
      const insertMs = Date.now() - t0;
      let found = 0;
      let t1 = Date.now();
      const pt = db.prepare('SELECT * FROM bench WHERE age = ?');
      for (let i = 0; i < 500; i++) found += pt.all(25).length;
      const pointMs = Date.now() - t1;
      t1 = Date.now();
      const rt = db.prepare('SELECT * FROM bench WHERE score > ? LIMIT 100');
      for (let i = 0; i < 500; i++) found += rt.all(50).length;
      const rangeMs = Date.now() - t1;
      t1 = Date.now();
      const total = db.prepare('SELECT COUNT(*) AS n FROM bench').get().n;
      const countMs = Date.now() - t1;
      t1 = Date.now();
      const ut = db.prepare('UPDATE bench SET age = 99 WHERE id = ?');
      for (let i = 0; i < 200; i++) ut.run((i % ROWS) + 1);
      const updateMs = Date.now() - t1;
      return { insertMs, pointMs, rangeMs, countMs, updateMs, count: total, found };
    });
    db.close();
    console.log(`[sqlite]   ${label(r)}`);
  }

  /* ---------- sql.js (WASM sqlite) ---------- */
  {
    const initSqlJs = require('sql.js');
    const SQL = await initSqlJs();
    const db = new SQL.Database();
    db.run('CREATE TABLE bench (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, age INTEGER, email TEXT, score REAL)');
    const data = genData(ROWS);
    const r = await bench('sql.js', null, async () => {
      const t0 = Date.now();
      db.run('BEGIN');
      const ins = db.prepare('INSERT INTO bench (name, age, email, score) VALUES (?, ?, ?, ?)');
      for (const d of data) ins.run([d.name, d.age, d.email, d.score]);
      ins.free();
      db.run('COMMIT');
      const insertMs = Date.now() - t0;
      let found = 0;
      let t1 = Date.now();
      for (let i = 0; i < 500; i++) {
        db.exec('SELECT * FROM bench WHERE age = 25');
        found++;
      }
      const pointMs = Date.now() - t1;
      t1 = Date.now();
      for (let i = 0; i < 500; i++) {
        db.exec('SELECT * FROM bench WHERE score > 50 LIMIT 100');
        found++;
      }
      const rangeMs = Date.now() - t1;
      t1 = Date.now();
      const total = db.exec('SELECT COUNT(*) AS n FROM bench')[0].values[0][0];
      const countMs = Date.now() - t1;
      t1 = Date.now();
      const ut = db.prepare('UPDATE bench SET age = 99 WHERE id = ?');
      for (let i = 0; i < 200; i++) ut.run([(i % ROWS) + 1]);
      const updateMs = Date.now() - t1;
      return { insertMs, pointMs, rangeMs, countMs, updateMs, count: total, found };
    });
    db.close();
    console.log(`[sql.js]   ${label(r)}`);
  }

  /* ---------- report ---------- */
  const e = results.engines;
  const fmt = (v) => String(v).padStart(9);
  const lines = [];
  lines.push('# JSQL-NEO Benchmark');
  lines.push('');
  lines.push(`Rows: ${ROWS.toLocaleString()}  |  Machine: ${process.platform} ${process.arch} / Node ${process.version}`);
  lines.push('');
  lines.push('| Engine | Insert | Insert/s | Point query (500x) | Range query (500x) | Count | Update (200x) | Total |');
  lines.push('|--------|--------|----------|--------------------|--------------------|-------|--------------|-------|');
  for (const [name, r] of Object.entries(e)) {
    lines.push(`| ${name} | ${r.insertMs}ms | ${(ROWS / r.insertMs / 1000).toFixed(2)}M | ${r.pointMs}ms | ${r.rangeMs}ms | ${r.countMs}ms | ${r.updateMs}ms | ${r.ms}ms |`);
  }
  lines.push('');
  lines.push('Notes: Pure JS = in-memory `Database`; Native = Rust N-API addon; sqlite = better-sqlite3 (WAL); sql.js = WASM sqlite.');
  const report = lines.join('\n') + '\n';
  require('fs').writeFileSync(path.join(__dirname, 'report.md'), report);
  console.log('\nReport written to bench/report.md');

  if (JSON_OUT) console.log(JSON.stringify(results, null, 2));
})().catch(e => { console.error('FATAL', e.stack.split('\n').slice(0, 3).join('\n')); process.exit(1); });
