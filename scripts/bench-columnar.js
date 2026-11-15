#!/usr/bin/env node
'use strict';
/**
 * 列存基准：jsql 行存 / jsql 列存 / DuckDB 三方对比。
 *
 * 运行：
 *   npm i duckdb --no-save   # 可选；缺失时只报 jsql 的两个数字
 *   node scripts/bench-columnar.js
 *
 * 说明：单机、单进程、10 万行 × 4 列的粗测，不代表 TPC-H 等标准基准。
 * 数字会随机器波动，结论请看相对量级而不是绝对值。
 */
const path = require('path');
const ROOT = path.join(__dirname, '..');
const jsql = require(path.join(ROOT, 'index.js'));

const ROWS = 100000;
const N = 5;

let duckdb = null;
try { duckdb = require(path.join(ROOT, 'node_modules', 'duckdb')); } catch (_) { /* 可选依赖 */ }

const QUERIES = [
  ['SELECT id LIMIT 10', 'SELECT id FROM t LIMIT 10'],
  ['SELECT id (100k)', 'SELECT id FROM t'],
  ['SELECT * LIMIT 10', 'SELECT * FROM t LIMIT 10'],
  ['SUM(score)', 'SELECT SUM(score) AS s FROM t'],
  ['COUNT(*) WHERE age>30', 'SELECT COUNT(*) AS c FROM t WHERE age > 30'],
  ['GROUP BY age', 'SELECT age, COUNT(*) AS c FROM t GROUP BY age'],
];

async function bench(fn) {
  await fn();
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < N; i++) await fn();
  return Number(process.hrtime.bigint() - t0) / 1e6 / N;
}
const duckAll = (conn, sql) => new Promise((res, rej) => conn.all(sql, (e, r) => (e ? rej(e) : res(r))));

(async () => {
  const db = new jsql.Database(':memory:', { autoSave: false });
  await db.createTable('t', {
    id: { type: 'integer', primaryKey: true, autoIncrement: true },
    age: { type: 'integer' }, score: { type: 'float' }, name: { type: 'string' },
  });
  const rows = [];
  for (let i = 0; i < ROWS; i++) rows.push({ age: 20 + (i % 50), score: (i % 1000) / 10, name: 'u' + i });
  for (let i = 0; i < rows.length; i += 5000) await db.insert('t', rows.slice(i, i + 5000));

  const rowRes = {};
  for (const [label, sql] of QUERIES) rowRes[label] = await bench(() => db.query(sql));

  db.convertToColumnar('t');
  const colRes = {};
  for (const [label, sql] of QUERIES) colRes[label] = await bench(() => db.query(sql));

  let duckRes = null;
  if (duckdb) {
    const ddb = new duckdb.Database(':memory:');
    const conn = ddb.connect();
    await duckAll(conn, 'CREATE TABLE t (id INTEGER, age INTEGER, score DOUBLE, name VARCHAR)');
    const values = rows.map((r, i) => `(${i + 1},${r.age},${r.score},'${r.name}')`).join(',');
    await duckAll(conn, 'INSERT INTO t VALUES ' + values);
    duckRes = {};
    for (const [label, sql] of QUERIES) duckRes[label] = await bench(() => duckAll(conn, sql));
    conn.close(); ddb.close();
  }

  console.log('\n  ' + 'query'.padEnd(24) + 'jsql(row)'.padStart(11) + 'jsql(col)'.padStart(11) +
    (duckRes ? 'duckdb'.padStart(10) + '   vs duckdb' : ''));
  for (const [label] of QUERIES) {
    let line = '  ' + label.padEnd(24) + rowRes[label].toFixed(1).padStart(11) + colRes[label].toFixed(1).padStart(11);
    if (duckRes) {
      const d = duckRes[label], c = colRes[label];
      line += d.toFixed(1).padStart(10) + '   ' + (c < d ? (d / c).toFixed(1) + 'x faster' : (c / d).toFixed(1) + 'x slower');
    }
    console.log(line);
  }
  console.log('\n  单位 ms，各 %d 次均值，%d 行。duckdb 未安装时只显示 jsql 两列。', N, ROWS);
})().catch(e => console.log('BOOM ' + e.stack.split('\n').slice(0, 4).join('\n')));
