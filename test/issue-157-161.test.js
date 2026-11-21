/* 回归测试：issue #157-#161（Redis RESP 命令语义） */
const path = require('path');
const ROOT = path.join(__dirname, '..');
const { RedisServer } = require(path.join(ROOT, 'lib', 'redis_server.js'));

let pass = 0, fail = 0;
function ok(name, cond, got) {
  if (cond) { pass++; console.log('[OK]   ' + name); }
  else { fail++; console.log('[FAIL] ' + name + ' -> ' + JSON.stringify(got)); }
}
function throws(fn, re) {
  try { fn(); return false; } catch (e) { return re ? re.test(e.message) : true; }
}

const s = new RedisServer({ port: 0, noAuth: true });

// #157 SET EX/PX 非正过期时间报错
ok('#157 SET EX 0 报错', throws(() => s.execute('SET', ['k', 'v', 'EX', '0']), /invalid expire time/));
ok('#157 SET PX 0 报错', throws(() => s.execute('SET', ['k2', 'v', 'PX', '0']), /invalid expire time/));
ok('#157 SET EX -5 报错', throws(() => s.execute('SET', ['k3', 'v', 'EX', '-5']), /invalid expire time/));
ok('#157 SET EX 10 正常', s.execute('SET', ['ok1', 'v', 'EX', '10']) === 'OK');

// #158 互斥/重复选项报错
ok('#158 NX+XX 报错', throws(() => s.execute('SET', ['k', 'v', 'NX', 'XX']), /syntax error/));
ok('#158 重复 EX 报错', throws(() => s.execute('SET', ['k', 'v', 'EX', '10', 'EX', '20']), /syntax error/));

// #159 EXISTS 去重计数
s.execute('SET', ['ek', 'v']);
ok('#159 EXISTS k k k = 1', s.execute('EXISTS', ['ek', 'ek', 'ek']) === 1);
ok('#159 EXISTS k missing k = 1', s.execute('EXISTS', ['ek', 'nope', 'ek']) === 1);
ok('#159 EXISTS 两个不同 key', s.execute('EXISTS', ['ek', 'ok1']) === 2);

// #160 PERSIST 触发快照
{
  s.execute('SET', ['pk', 'v', 'EX', '100']);
  const orig = s._scheduleSnapshot.bind(s);
  let called = 0;
  s._scheduleSnapshot = () => { called++; orig(); };
  const r = s.execute('PERSIST', ['pk']);
  s._scheduleSnapshot = orig;
  ok('#160 PERSIST 返回 1 且调度快照', r === 1 && called > 0, { r, called });
}

// #161 ZADD/ZINCRBY 严格浮点
ok('#161 ZADD 尾随垃圾报错', throws(() => s.execute('ZADD', ['z', '1abc', 'm']), /valid float/));
ok('#161 ZINCRBY 尾随垃圾报错', throws(() => s.execute('ZINCRBY', ['z', '2xyz', 'm']), /valid float/));
ok('#161 ZADD 合法小数', s.execute('ZADD', ['z', '1.5', 'm']) === 1 && s.execute('ZSCORE', ['z', 'm']) === '1.5');
ok('#161 ZADD NaN 报错', throws(() => s.execute('ZADD', ['z2', 'NaN', 'm']), /valid float/));
ok('#161 ZADD inf 放行', s.execute('ZADD', ['z3', 'inf', 'm']) === 1);

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
if (s.stop) s.stop();
process.exit(fail ? 1 : 0);
