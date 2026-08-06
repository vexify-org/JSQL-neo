/*
 * Zero-dependency smoke test for the SQL engine core.
 *   npm test   (or: node test/smoke.js)
 */
const { executeSQL, parseSQL, applyParams } = require('../lib/sql.js');
const { createMysqlServer } = require('../lib/mysql_server.js');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('[OK]', name); }
  else { fail++; console.log('[FAIL]', name, extra !== undefined ? '→ ' + JSON.stringify(extra) : ''); }
};

const engine = {
  hasTable: () => true,
  truncate: async () => {},
  flush: async () => {},
  find: async () => [
    { id: 1, name: 'A', age: 30 },
    { id: 2, name: 'B', age: 40 },
    { id: 3, name: 'C', age: 25 },
  ],
  getTableSchema: async () => ({
    id: { type: 'integer', primaryKey: true },
    name: { type: 'string' },
    age: { type: 'integer' },
  }),
};

(async () => {
  const opts = { safety: false };

  const agg = await executeSQL(engine, 'SELECT COUNT(*) AS n, MAX(age) AS m, SUM(age) AS s, AVG(age) AS a FROM users', opts);
  ok('multi-aggregate SELECT returns all columns', JSON.stringify(agg.columns) === JSON.stringify(['n', 'm', 's', 'a'])
    && JSON.stringify(agg.rows[0]) === JSON.stringify([3, 40, 95, 31.666666666666668]), { cols: agg.columns, row: agg.rows[0] });

  const w = await executeSQL(engine, 'SELECT name, age FROM users WHERE age > 29 ORDER BY age DESC', opts);
  ok('WHERE + ORDER BY', w.rows.length === 2 && w.rows[0][1] === 40, w.rows);

  const funcs = await executeSQL(engine, "SELECT CONCAT(name, '!') AS c, UPPER(name) AS u, IFNULL(age, 0) AS f FROM users LIMIT 1", opts);
  ok('scalar functions CONCAT/UPPER/IFNULL', funcs.rows[0][0] === 'A!' && funcs.rows[0][1] === 'A', funcs.rows);

  const c1 = await executeSQL(engine, 'SELECT COUNT(1) AS n FROM users', opts);
  ok('COUNT(1) literal', c1.rows[0][0] === 3, c1.rows);

  ok('parseSQL TRUNCATE', parseSQL('TRUNCATE TABLE users').type === 'truncate');
  ok('parseSQL START TRANSACTION', parseSQL('START TRANSACTION').type === 'begin');
  ok('parseSQL VALUES DEFAULT', parseSQL(applyParams('INSERT INTO t (id, name) VALUES (DEFAULT, ?)', ['x'])).dataRows[0].id._default === true);

  const srv = createMysqlServer({ port: 0, host: '127.0.0.1', dataDir: ':memory:', noAuth: true });
  await new Promise(r => srv.listen(r));
  const addr = srv.address;
  ok('createMysqlServer listens on ephemeral port', addr && addr.port > 0, addr);
  srv.close();

  console.log(fail === 0 ? '\nALL SMOKE TESTS PASSED' : `\n${fail} FAILURES`);
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });
