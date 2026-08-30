/*
 * ORM compatibility test runner.
 *
 * Usage:
 *   1. Start a jsql-neo MySQL server (see ../server.js / createMysqlServer)
 *      on 127.0.0.1:33309, then:
 *   2. npm install && npm test   (or: node run-all.js)
 *
 * Requires a running MySQL-compatible jsql-neo server at 127.0.0.1:33309
 * with an empty/default database. The tests create and drop their own tables.
 */
const { execSync } = require('child_process');
const path = require('path');

const tests = ['sequelize-test.js', 'knex-test.js', 'typeorm-test.js'];
let failed = 0;

for (const t of tests) {
  process.stdout.write('=== ' + t + ' ===\n');
  try {
    execSync('node ' + path.join(__dirname, t), { stdio: 'inherit', timeout: 120000 });
  } catch (e) {
    failed++;
  }
}

if (failed > 0) {
  console.log(`\n${failed}/${tests.length} suites FAILED`);
  process.exit(1);
}
console.log('\nAll ORM suites passed');
