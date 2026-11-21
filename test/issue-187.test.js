/*
 * Regression test for issue #187.
 *   node test/issue-187.test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const { createRedisServer } = require(path.join(ROOT, 'lib', 'redis_server.js'));

let passed = 0, failed = 0;
function ok(name, cond, extra) {
  if (cond) { passed++; console.log('[OK]', name); }
  else { failed++; console.log('[FAIL]', name, extra !== undefined ? '→ ' + JSON.stringify(extra) : ''); }
}

(async () => {
  const prevCwd = process.cwd();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsql-redis-memory-'));
  process.chdir(dir);

  const srv = createRedisServer({ port: 0, dataDir: ':memory:' });
  ok('#187 snapshotPath is null in memory mode', srv.snapshotPath() === null);
  srv.execute('SET', ['leak', 'from-process-1']);
  await new Promise((resolve) => setTimeout(resolve, 700));
  ok('#187 no literal :memory: directory', !fs.existsSync(path.join(dir, ':memory')), fs.readdirSync(dir));

  srv.stop();
  const srv2 = createRedisServer({ port: 0, dataDir: ':memory:' });
  ok('#187 new instance starts empty', srv2.execute('GET', ['leak']) === null);

  process.chdir(prevCwd);
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
