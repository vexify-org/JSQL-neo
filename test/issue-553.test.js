// #553: ALTER TABLE / CREATE INDEX / DROP INDEX / TRUNCATE 的 CommandComplete tag
const assert = require('assert');
const H = require('./issue-pg5-helper.js');
let passed = 0, failed = 0;
async function t(name, fn) {
  try { await fn(); passed++; console.log('ok - ' + name); }
  catch (e) { failed++; console.error('not ok - ' + name + '\n  ' + e.message); }
}
(async () => {
  await t('#553 DDL CommandComplete 回真实命令 tag', async () => {
    const h = await H.startServer();
    try {
      const c = await H.pgConnect(h.port);
      async function tag(sql) {
        c.sock.write(H.queryMsg(sql));
        return H.commandTags(await H.pgDrain(c.rd, 250));
      }
      assert.deepStrictEqual(await tag('CREATE TABLE tt (id INT, a TEXT)'), ['CREATE TABLE']);
      assert.deepStrictEqual(await tag('ALTER TABLE tt ADD COLUMN b INT'), ['ALTER TABLE']);
      assert.deepStrictEqual(await tag('CREATE INDEX ix_tt ON tt(id)'), ['CREATE INDEX']);
      assert.deepStrictEqual(await tag('DROP INDEX ix_tt'), ['DROP INDEX']);
      const tTags = await tag('TRUNCATE tt');
      assert.strictEqual(tTags.length, 1);
      assert.ok(/^TRUNCATE TABLE\b/.test(tTags[0]), 'got ' + JSON.stringify(tTags));
    } finally { h.close(); }
  });
  console.log(`${passed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
})().catch((e) => { console.error(e); process.exitCode = 1; });
