/*
 * #488 回归测试：WebUI /api/query 必须有请求体上限，超限回 413。
 *   node test/issue-488.test.js
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const ROOT = path.join(__dirname, '..');
const { Database, WebUI } = require(path.join(ROOT, 'index.js'));

let passed = 0, failed = 0;
async function t(name, fn) {
  try { await fn(); passed++; console.log(`ok - ${name}`); }
  catch (e) { failed++; console.error(`not ok - ${name}\n  ${e && e.message}`); }
}
function request(port, body, contentLength, chunked) {
  return new Promise((resolve) => {
    const headers = { 'Content-Type': 'application/json' };
    if (contentLength !== undefined) headers['Content-Length'] = contentLength;
    if (chunked) headers['Transfer-Encoding'] = 'chunked';
    const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/api/query', headers, agent: false }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', () => resolve({ status: 0, body: '' }));
    req.setTimeout(1500, () => { req.destroy(); resolve({ status: 0, body: 'timeout' }); });
    if (chunked) {
      // 单个 chunk 都未超限，累计才超限
      req.write('x'.repeat(1500));
      req.write('y'.repeat(1500));
      req.end();
    } else {
      req.end(body);
    }
  });
}

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsql-488-'));
  const seed = new Database(path.join(dir, 'app.json'), { autoSave: false });
  await seed.createTable('t', { id: { type: 'integer' } });
  await seed.close();
  const ui = new WebUI({ port: 0, dataDir: dir, noAuth: true, host: '127.0.0.1', maxBody: 2048 });
  const port = await ui.start();

  await t('#488 Content-Length 超限立即回 413', async () => {
    const r = await request(port, '{}', 4 * 1024 * 1024);
    assert.strictEqual(r.status, 413, `status=${r.status} body=${r.body}`);
  });

  await t('#488 流式 body 累计超限回 413（chunked，无 Content-Length）', async () => {
    const r = await request(port, undefined, undefined, true);
    assert.strictEqual(r.status, 413, `status=${r.status} body=${r.body}`);
  });

  await t('#488 正常请求仍回 200', async () => {
    const r = await request(port, JSON.stringify({ db: 'app', sql: 'SELECT * FROM t' }));
    assert.strictEqual(r.status, 200, `status=${r.status} body=${r.body}`);
    assert.strictEqual(JSON.parse(r.body).ok, true);
  });

  await ui.stop();
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
})();
