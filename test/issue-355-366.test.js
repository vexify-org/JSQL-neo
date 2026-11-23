/*
 * Regression tests for #360 #363 #364 #366.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const ROOT = path.join(__dirname, '..');
const { Database, WebUI } = require(path.join(ROOT, 'index.js'));

let passed = 0, failed = 0;
function ok(name, cond, extra) {
  if (cond) { passed++; console.log('[OK]', name); }
  else { failed++; console.log('[FAIL]', name, extra !== undefined ? '→ ' + JSON.stringify(extra) : ''); }
}

function request(port, method, p, body) {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: p,
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' } }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    if (body !== undefined) req.write(body);
    req.end();
  });
}

(async () => {
  // #360 同名 CTE
  {
    const db = new Database(':memory:');
    const q = async (sql) => { try { return await db.query(sql, { safety: false }); } catch (e) { return { err: e.message }; } };
    const dup = await q('WITH a AS (SELECT 1), a AS (SELECT 2) SELECT * FROM a');
    ok('#360 同名 CTE 报错', !!dup.err && /Duplicate CTE name/i.test(dup.err), dup.err);
    const single = await q('WITH a AS (SELECT 1 AS x) SELECT * FROM a');
    ok('#360 单个 CTE 正常', !single.err && JSON.stringify(single.rows) === '[[1]]', single.err || single.rows);
    const distinct = await q('WITH a AS (SELECT 1 AS x), b AS (SELECT 2 AS x) SELECT * FROM b');
    ok('#360 不同名 CTE 正常', !distinct.err && JSON.stringify(distinct.rows) === '[[2]]', distinct.err || distinct.rows);
    await db.close();
  }

  // WebUI HTTP 状态码
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsql-ui-'));
    const seed = new Database(path.join(dir, 'app.json'));
    await seed.createTable('t', { id: { type: 'integer', primaryKey: true } });
    await seed.close();

    const ui = new WebUI({ port: 0, dataDir: dir, noAuth: true, host: '127.0.0.1' });
    const port = await ui.start();

    const bad = await request(port, 'POST', '/api/query', '{oops');
    ok('#364 非法 JSON 回 400', bad.status === 400, bad);

    const sqlErr = await request(port, 'POST', '/api/query', JSON.stringify({ db: 'app', sql: 'SELECT * FROM no_such' }));
    ok('#363 SQL 失败回 500', sqlErr.status === 500, sqlErr);

    const noDb = await request(port, 'GET', '/api/tables');
    ok('#366 缺 db 参数回 400', noDb.status === 400, noDb);

    const missing = await request(port, 'GET', '/api/tables?db=nope');
    ok('#366 库不存在回 404', missing.status === 404, missing);

    const good = await request(port, 'GET', '/api/tables?db=app');
    ok('#366 正常库回 200', good.status === 200, good);

    const goodQ = await request(port, 'POST', '/api/query', JSON.stringify({ db: 'app', sql: 'SELECT * FROM t' }));
    ok('#363 正常查询仍回 200 且 ok=true', goodQ.status === 200 && JSON.parse(goodQ.body).ok === true, goodQ);

    await ui.stop();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
