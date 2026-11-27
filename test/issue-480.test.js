'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// #480: exportToFile 自动创建缺失父目录
let passed = 0, failed = 0;
function ok(name, fn) {
  return Promise.resolve().then(fn).then(() => { passed++; console.log('ok -', name); })
    .catch(e => { failed++; console.log('not ok -', name, '\n  ', e.message); });
}

(async () => {
  const { Database } = require('../index.js');
  const migrate = require('../lib/migrate');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsql-h480-'));
  const db = new Database(':memory:', { safety: false });
  try {
    await db.createTable('x', { id: 'integer' });
    await db.insert('x', [{ id: 1 }]);
    const out = path.join(dir, 'no-such-dir', 'nested', 'x.csv');

    await ok('#480 exportToFile 递归建父目录', async () => {
      await migrate.exportToFile(db, 'x', out);
      assert.ok(fs.existsSync(out), 'export file should exist');
      const content = fs.readFileSync(out, 'utf8');
      assert.ok(content.length > 0, 'export file should not be empty');
    });

    await ok('#480 exportToFile JSON 同样建目录', async () => {
      const out2 = path.join(dir, 'another-dir', 'x.json');
      await migrate.exportToFile(db, 'x', out2);
      assert.ok(fs.existsSync(out2), 'json export file should exist');
    });
  } finally {
    await db.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
})();
