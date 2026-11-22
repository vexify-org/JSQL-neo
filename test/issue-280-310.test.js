/*
 * Regression tests for #280 #281 #286 #287 #310.
 *   node test/issue-280-310.test.js
 */
const path = require('path');
const ROOT = path.join(__dirname, '..');
const { createRedisServer } = require(path.join(ROOT, 'lib', 'redis_server.js'));
const { createMongoServer } = require(path.join(ROOT, 'lib', 'mongo_server.js'));

let passed = 0, failed = 0;
function ok(name, cond, extra) {
  if (cond) { passed++; console.log('[OK]', name); }
  else { failed++; console.log('[FAIL]', name, extra !== undefined ? '→ ' + JSON.stringify(extra) : ''); }
}
function call(s, cmd, ...args) {
  try { return { value: s.execute(cmd, args) }; } catch (e) { return { error: e.message }; }
}

(async () => {
  // #286
  {
    const s = createRedisServer({ port: 0, dataDir: null });
    const r = call(s, 'SET', 'k', 'v', 'EX', '10', 'PX', '5000');
    ok('#286 SET EX+PX is a syntax error', /syntax error/.test(r.error || ''), r);
  }
  // #287
  {
    const s = createRedisServer({ port: 0, dataDir: null });
    const a = call(s, 'ZADD', 'z', 1, '__proto__');
    const b = call(s, 'ZADD', 'z', 2, 'constructor');
    const c = call(s, 'ZADD', 'z', 3, '__proto__');
    ok('#287 ZADD prototype names count as members', a.value === 1 && b.value === 1 && c.value === 0, { a, b, c });
    const score = call(s, 'ZSCORE', 'z', '__proto__');
    ok('#287 ZSCORE finds __proto__ member', score.value === '3', score);
    const rem = call(s, 'ZREM', 'z', '__proto__');
    ok('#287 ZREM removes prototype-named member', rem.value === 1, rem);
    const left = call(s, 'ZRANGE', 'z', 0, -1);
    ok('#287 ZSET contents intact', JSON.stringify(left.value) === JSON.stringify(['constructor']), left.value);
  }
  // #280 / #281
  {
    const mongo = createMongoServer({ dataDir: ':memory:' });
    const dispatch = (cmd, doc) => mongo._dispatch(cmd, doc);
    await dispatch('insert', {
      insert: 'c', $db: 'test',
      documents: [{ n: 1 }, { n: 2 }, { n: 3 }, { n: 4 }],
    });
    const count = await dispatch('count', { count: 'c', query: {}, skip: 2, limit: 1, $db: 'test' });
    ok('#280 count honors skip then limit', count.n === 1, count);

    await dispatch('createIndexes', { createIndexes: 'c', indexes: [{ key: { n: -1 }, name: 'n_-1', unique: false }], $db: 'test' });
    const idx = await dispatch('listIndexes', { listIndexes: 'c', $db: 'test' });
    const found = (idx.cursor && idx.cursor.firstBatch || []).find(i => i.name === 'n_-1');
    ok('#281 listIndexes keeps index direction', found && found.key && found.key.n === -1, found);
  }
  // #310
  {
    const { Client } = (() => { try { return require(path.join(ROOT, 'node_modules', 'pg')); } catch (e) { return {}; } })();
    if (Client) {
      const { createPgServer } = require(path.join(ROOT, 'lib', 'pg_server.js'));
      const srv = createPgServer({
        port: 0, host: '127.0.0.1', dataDir: ':memory:',
        auth: { root: { password: 'right', databases: ['app'] } },
      });
      await new Promise((r) => srv.listen(r));
      const c = new Client({ host: '127.0.0.1', port: srv.address.port, user: 'root', database: 'app', password: 'wrong' });
      let code = null;
      try { await c.connect(); await c.end(); } catch (e) { code = e.code; }
      ok('#310 wrong password returns 28P01', code === '28P01', code);
      srv.close();
    } else {
      console.log('[SKIP] PG auth (pg not installed)');
    }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
