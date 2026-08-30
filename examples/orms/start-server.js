/*
 * Start a jsql-neo MySQL-compatible server for the ORM tests.
 *   node start-server.js
 * Creates data in ./data (remove it before re-running tests for a clean slate).
 */
const path = require('path');
const { createMysqlServer } = require(path.join(__dirname, '..', '..', 'lib', 'mysql_server'));

const srv = createMysqlServer({
  port: 33309,
  host: '127.0.0.1',
  dataDir: path.join(__dirname, 'data'),
  noAuth: true,
});

srv.listen();
console.log('jsql-neo MySQL server on 33309 (data: ' + path.join(__dirname, 'data') + ')');
setInterval(() => {}, 1 << 30);
