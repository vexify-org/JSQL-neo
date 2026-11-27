'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// #545: .jsql 单文件模式零行表重开后不消失
let passed = 0, failed = 0;
function ok(name, fn) {
  return Promise.resolve().then(fn).then(() => { passed++; console.log('ok -', name); })
    .catch(e => { failed++; console.log('not ok -', name, '\n  ', e.message); });
}

(async () => {
  const { Database } = require('../index.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsql-h545-'));
  const file = path.join(dir, 'db.jsql');
  try {
    let db = new Database(file, { wal: false, fileLock: false, safety: false });
    await db.query('CREATE TABLE t1(id INTEGER PRIMARY KEY, v STRING)');
    await db.query('CREATE TABLE t2(id INTEGER PRIMARY KEY, v STRING)');
    await db.insertMany('t1', [{ id: 1, v: 'a' }]);
    db.save();
    db.close();

    await ok('#545 空表 t2 重开后仍存在', () => {
      db = new Database(file, { wal: false, fileLock: false, safety: false });
      const tables = db.getTables();
      assert.ok(tables.includes('t2'), `expected t2 in ${JSON.stringify(tables)}`);
      assert.ok(tables.includes('t1'), `expected t1 in ${JSON.stringify(tables)}`);
      db.close();
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
})();
