/* ---- 回归：#314 / #317 / #318 / #319 / #321 ---- */
/*
 * #314 Redis LPOP/RPOP 的 count 参数用裸 parseInt —— '1.5' 被截成 1、'2abc'
 *      被截成 2，尾随垃圾静默接受。改为复用 parseRedisInt（严格十进制）。
 * #317 REGEXP/RLIKE 非法正则模式串抛裸 V8 SyntaxError（无 errno/SQLSTATE），
 *      归一为 MySQL 的 ER_REGEXP_ERROR(1139) / SQLSTATE 42000。
 * #318 LPAD/RPAD 的填充串为 NULL 时退化成空格填充（'  7'），MySQL 应整体 NULL。
 * #319 Cache 的 TTL 清理定时器与自动保存定时器未 unref()，漏调 close() 时
 *      挂住 Node 事件循环，进程无法自然退出。
 * #321 legacy 单文件模式的自动保存定时器未 unref()（同文件 _flushTimer /
 *      _monitorTimer 已 unref），处理不一致。
 */
const path = require('path');
const { execFileSync } = require('child_process');
const ROOT = path.join(__dirname, '..');
const { Database, executeSQL } = require(path.join(ROOT, 'index.js'));

let pass = 0, fail = 0;
function ok(name, cond, got) {
  if (cond) { pass++; console.log('[OK]   ' + name); }
  else { fail++; console.log('[FAIL] ' + name + ' -> ' + JSON.stringify(got)); }
}

async function main() {
  const db = new Database(':memory:', { autoSave: false });
  const q = async (sql) => (await executeSQL(db, sql, { safety: false })).rows[0][0];

  // ================= #318 LPAD / RPAD 的 NULL 填充串 =================
  ok("LPAD('7',3,NULL) = NULL（MySQL 三值逻辑）",
    await q("SELECT LPAD('7', 3, NULL)") === null, null);
  ok("RPAD('7',3,NULL) = NULL（MySQL 三值逻辑）",
    await q("SELECT RPAD('7', 3, NULL)") === null, null);
  ok("LPAD('7',3,NULL) IS NULL 为真",
    await q("SELECT LPAD('7', 3, NULL) IS NULL") === 1, null);
  ok("LPAD('7',3,'0') = '007'（不回归）",
    await q("SELECT LPAD('7', 3, '0')") === '007', null);
  ok("RPAD('7',3,'0') = '700'（不回归）",
    await q("SELECT RPAD('7', 3, '0')") === '700', null);
  ok("LPAD('hi',5,'ab') = 'abahi'（填充串循环不回归）",
    await q("SELECT LPAD('hi', 5, 'ab')") === 'abahi', null);
  ok("LPAD('hi',4,'') = ''（空填充串不回归）",
    await q("SELECT LPAD('hi', 4, '')") === '', null);
  // 缺省第三参仍按空格填充（MySQL 允许省略 padstr）
  ok("LPAD('7',3) = '  7'（缺省填充串仍用空格）",
    await q("SELECT LPAD('7', 3)") === '  7', null);

  // ================= #317 REGEXP 非法正则 =================
  let regexpErr = null;
  try { await q("SELECT 'abc' REGEXP '['"); }
  catch (e) { regexpErr = e; }
  ok("非法正则 '[' 抛出错误而不是静默", !!regexpErr, regexpErr && regexpErr.message);
  ok("非法正则归一为 errno 1139", regexpErr && regexpErr.errno === 1139,
    regexpErr && regexpErr.errno);
  ok("非法正则带 SQLSTATE 42000", regexpErr && regexpErr.sqlState === '42000',
    regexpErr && regexpErr.sqlState);
  ok("非法正则带 code ER_REGEXP_ERROR", regexpErr && regexpErr.code === 'ER_REGEXP_ERROR',
    regexpErr && regexpErr.code);

  let rlikeErr = null;
  try { await q("SELECT 'abc' RLIKE '('"); }
  catch (e) { rlikeErr = e; }
  ok("非法正则 '('（RLIKE）同样归一为 1139", rlikeErr && rlikeErr.errno === 1139,
    rlikeErr && rlikeErr.errno);

  // 合法正则行为不变
  ok("合法 REGEXP 不受影响：'abc' REGEXP '^a' = 1",
    await q("SELECT 'abc' REGEXP '^a'") === 1, null);
  ok("合法 REGEXP 不受影响：'abc' REGEXP '^z' = 0",
    await q("SELECT 'abc' REGEXP '^z'") === 0, null);
  ok("REGEXP 操作数为 NULL 仍返回 NULL（#230 不回归）",
    await q("SELECT NULL REGEXP 'a'") === null, null);

  // ================= #314 Redis LPOP / RPOP count 校验 =================
  const { createRedisServer } = require(path.join(ROOT, 'lib/redis_server.js'));
  const net = require('net');

  function frame(args) {
    const parts = args.map((a) => { const b = Buffer.from(String(a)); return '$' + b.length + '\r\n' + b + '\r\n'; });
    return Buffer.from('*' + args.length + '\r\n' + parts.join(''));
  }
  const srv = createRedisServer({ port: 0, dataDir: null });
  await new Promise((r) => srv.listen(r));
  const sock = net.connect(srv.server.address().port, '127.0.0.1');
  await new Promise((r) => sock.on('connect', r));
  const chunks = [];
  sock.on('data', (c) => chunks.push(c));
  const send = async (args) => {
    chunks.length = 0;
    sock.write(frame(args));
    await new Promise((r) => setTimeout(r, 120));
    return Buffer.concat(chunks).toString('utf8');
  };

  await send(['RPUSH', 'l', '1', '2', '3']);
  ok('RPUSH 返回 :3', (await send(['RPUSH', 'l2', '1', '2', '3'])) === ':3\r\n', null);

  const lpopFrac = await send(['LPOP', 'l', '1.5']);
  ok('LPOP count=1.5 报 integer 错误', lpopFrac.startsWith('-ERR'), lpopFrac);
  ok('LPOP count=1.5 错误文案为 not an integer',
    /not an integer or out of range/.test(lpopFrac), lpopFrac);

  const lpopJunk = await send(['LPOP', 'l', '2abc']);
  ok('LPOP count=2abc 报 integer 错误', lpopJunk.startsWith('-ERR'), lpopJunk);

  const lpopNeg = await send(['LPOP', 'l', '-1']);
  ok('LPOP count=-1 报 out of range 错误', lpopNeg.startsWith('-ERR'), lpopNeg);

  // 报错后不应弹出任何元素
  const llen = await send(['LLEN', 'l']);
  ok('非法 count 不弹出元素（LLEN 仍为 3）', llen === ':3\r\n', llen);

  const lpopOk = await send(['LPOP', 'l', '2']);
  ok('LPOP count=2 正常返回两个元素', /^\*2\r\n/.test(lpopOk), lpopOk);
  const llen2 = await send(['LLEN', 'l']);
  ok('LPOP count=2 后 LLEN = 1', llen2 === ':1\r\n', llen2);

  const rpopOk = await send(['RPOP', 'l2', '1']);
  ok('RPOP count=1 正常返回', /^\*1\r\n/.test(rpopOk), rpopOk);

  sock.destroy();
  srv.stop();

  // ================= #319 / #321 定时器 unref =================
  // 用子进程跑一个「实例化后不 close()」的脚本，检查进程能自然退出。
  const timerProbe = `
    const root = ${JSON.stringify(ROOT)};
    const { Database } = require(root + '/index.js');
    const Cache = require(root + '/lib/cache.js');
    const fs = require('fs'), os = require('os'), path = require('path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsql-timer-'));
    const db = new Database(path.join(dir, 'db.json'), { autoSave: true, autoSaveInterval: 5000 });
    const cache = new Cache();
    cache.set('a', '1');
    db.createTable('t', { id: { type: 'integer', primaryKey: true } }).then(() => {
      db.insert('t', { id: 1 }).then(() => {
        console.log('READY');
      });
    });
  `;
  const probeFile = path.join(ROOT, 'test', '.tmp-timer-probe.js');
  fs.writeFileSync(probeFile, timerProbe, 'utf8');
  let exited = false;
  try {
    execFileSync(process.execPath, [probeFile], { timeout: 4000, stdio: 'pipe' });
    exited = true;
  } catch (e) {
    // 超时（SIGTERM）说明定时器挂住了事件循环
    exited = false;
  } finally {
    fs.unlinkSync(probeFile);
  }
  ok('#319/#321 未 close() 时进程能自然退出（定时器已 unref）', exited, null);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

const fs = require('fs');
main().catch(e => {
  console.log('[FAIL] unexpected exception: ' + (e.stack || e).split('\n').slice(0, 4).join('\n'));
  process.exit(1);
});
