'use strict';
/* #24: CLI must boot even when @vexify-org/yaggs is missing (offline install). */
const { buildYaggsFallback } = require('../bin/yaggs-fallback');

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log(`[OK] ${name}`); }
  else { fail++; console.log(`[FAIL] ${name}`); }
}

async function runCLI(argv) {
  const cli = buildYaggsFallback({ version: '6.5.21' })({ pkg: { version: '6.5.21' } });
  let handlerCalled = null;
  cli.command('serve', 'Run server', null, (a) => { handlerCalled = a; });
  cli.command('version', 'Show version', null, () => { handlerCalled = { __version: true }; });
  const logs = [];
  const origLog = console.log, origErr = console.error;
  console.log = (...a) => logs.push(a.join(' '));
  console.error = (...a) => logs.push(a.join(' '));
  let threw = null;
  try { await cli.run(argv); } catch (e) { threw = e; }
  console.log = origLog; console.error = origErr;
  return { logs, handlerCalled, threw };
}

(async () => {
  // --help must not throw
  let r = await runCLI(['--help']);
  ok('--help does not throw', r.threw === null);
  ok('--help prints usage', r.logs.some(l => l.includes('Usage:')));

  // --version must not throw
  r = await runCLI(['--version']);
  ok('--version does not throw', r.threw === null);
  ok('--version prints version', r.logs.some(l => l.includes('6.5.21')));

  // unknown command -> graceful error, not crash
  r = await runCLI(['frobnicate']);
  ok('unknown command does not throw', r.threw === null);
  ok('unknown command reports error', r.logs.some(l => l.includes('Unknown command')));

  // handler dispatch with flags
  r = await runCLI(['serve', '--port', '3307', '--no-auth', '--data-dir', '/tmp/d']);
  ok('command handler dispatched', r.handlerCalled !== null);
  ok('flag value parsed', r.handlerCalled && r.handlerCalled.port === '3307');
  ok('boolean flag parsed', r.handlerCalled && r.handlerCalled['no-auth'] === true);
  ok('kebab flag parsed', r.handlerCalled && r.handlerCalled['data-dir'] === '/tmp/d');

  // positional args
  r = await runCLI(['serve', 'extra1', 'extra2']);
  ok('positional args collected', r.handlerCalled && r.handlerCalled._.join(',') === 'extra1,extra2');

  console.log(`\n=== pass ${pass}  fail ${fail} ===`);
  process.exit(fail ? 1 : 0);
})();
