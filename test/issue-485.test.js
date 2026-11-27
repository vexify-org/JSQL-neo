'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// #485: TUI 历史文件落盘应为 0600
let passed = 0, failed = 0;
function ok(name, fn) {
  return Promise.resolve().then(fn).then(() => { passed++; console.log('ok -', name); })
    .catch(e => { failed++; console.log('not ok -', name, '\n  ', e.message); });
}

(async () => {
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'jsql-h485-'));
  const prevHome = process.env.HOME;
  process.env.HOME = fakeHome;
  try {
    // 清除模块缓存，让 HISTORY_FILE 使用 fake HOME
    const tuiPath = require.resolve('../lib/tui');
    delete require.cache[tuiPath];
    const { createTUI } = require('../lib/tui');
    const tui = createTUI({ dataDir: null, db: 'default' });
    tui._pushHistory("SELECT * FROM users WHERE password = 'secret'");

    await ok('#485 历史文件权限为 0600', () => {
      const f = path.join(fakeHome, '.jsql-history');
      assert.ok(fs.existsSync(f), 'history file should exist');
      const mode = fs.statSync(f).mode & 0o777;
      assert.strictEqual(mode, 0o600, `expected 0600, got ${mode.toString(8)}`);
    });

    // 已存在且权限过宽的文件也应被收敛
    await ok('#485 已存在的宽权限文件被收敛', () => {
      const f = path.join(fakeHome, '.jsql-history');
      fs.chmodSync(f, 0o644);
      tui._pushHistory('SELECT 2');
      const mode = fs.statSync(f).mode & 0o777;
      assert.strictEqual(mode, 0o600, `expected 0600, got ${mode.toString(8)}`);
    });
  } finally {
    process.env.HOME = prevHome;
    fs.rmSync(fakeHome, { recursive: true, force: true });
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
})();
