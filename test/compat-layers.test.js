/** #87 sqlite raw 重复执行 / #88 NeDB $regex 字符串 / #89 lrange 负向 stop */
const Cache = require('../lib/cache');
const { Datastore } = require('../lib/nedb_compat');
const SqliteDatabase = require('../lib/sqlite_compat');
let p = 0, f = 0; const ok = (n, c, g) => { if (c) p++; else { f++; console.log('[FAIL]', n, '->', JSON.stringify(g)); } };
(async () => {
  // ---- #89
  const c = new Cache();
  c.rpush('k', 'a'); c.rpush('k', 'b'); c.rpush('k', 'c');
  ok('#89 lrange(0,-5) 长度1 → [a]', JSON.stringify(c.lrange('k', 0, -5)) === JSON.stringify(['a']), c.lrange('k', 0, -5));
  ok('#89 lrange(0,-3) → [a]', JSON.stringify(c.lrange('k', 0, -3)) === JSON.stringify(['a']), c.lrange('k', 0, -3));
  ok('#89 lrange(0,-1) 不回归 → 全部', JSON.stringify(c.lrange('k', 0, -1)) === JSON.stringify(['a', 'b', 'c']), c.lrange('k', 0, -1));
  ok('#89 lrange(-2,-1) 不回归', JSON.stringify(c.lrange('k', -2, -1)) === JSON.stringify(['b', 'c']), c.lrange('k', -2, -1));
  ok('#89 lrange(0,-100) → [a]', JSON.stringify(c.lrange('k', 0, -100)) === JSON.stringify(['a']), c.lrange('k', 0, -100));
  ok('#89 lrange(1,0) → []', JSON.stringify(c.lrange('k', 1, 0)) === '[]', c.lrange('k', 1, 0));

  // ---- #88
  const db = new Datastore({ inMemoryOnly: true });
  await db.loadDatabase();
  {
    for (const n of ['apple', 'banana', 'cherry']) await db.insert({ name: n });
    const all = await db.find({});
    ok('#88 插入 3 条', all.length === 3, all.length);
    const r1 = await db.find({ name: { $regex: 'a' } });
    ok("#88 $regex:'a' 只匹配 2 条（apple/banana）", r1.length === 2, r1.map(x => x.name));
    const r2 = await db.find({ name: { $regex: '^c' } });
    ok("#88 $regex:'^c' → cherry", r2.length === 1 && r2[0].name === 'cherry', r2.map(x => x.name));
    const r3 = await db.find({ name: { $regex: /^a/ } });
    ok('#88 $regex: RegExp 不回归', r3.length === 1 && r3[0].name === 'apple', r3.map(x => x.name));
  }
  // ---- #87 .raw(true).all() 重复执行
  {
    const sdb = new SqliteDatabase(':memory:');
    sdb.prepare('CREATE TABLE t (a INT)').run();
    sdb.prepare('INSERT INTO t VALUES (1)').raw(true).all();
    ok('#87 raw().all() 执行 INSERT 只写一次', sdb.prepare('SELECT COUNT(*) c FROM t').get().c === 1,
      sdb.prepare('SELECT COUNT(*) c FROM t').get().c);
    sdb.prepare('INSERT INTO t VALUES (2)').run();
    sdb.prepare('SELECT * FROM t').raw(true).all();
    ok('#87 raw().all() 执行 SELECT 不产生副作用',
      sdb.prepare('SELECT COUNT(*) c FROM t').get().c === 2,
      sdb.prepare('SELECT COUNT(*) c FROM t').get().c);
    const rawRows = sdb.prepare('SELECT a FROM t ORDER BY a').raw(true).all();
    ok('#87 raw 仍返回数组形式的行', Array.isArray(rawRows) && Array.isArray(rawRows[0]),
      rawRows);
    const normal = sdb.prepare('SELECT a FROM t ORDER BY a').all();
    ok('#87 非 raw 模式仍返回对象行', normal.length === 2 && normal[0].a === 1, normal);
    const pluck = sdb.prepare('SELECT a FROM t ORDER BY a').pluck(true).all();
    ok('#87 pluck 不回归', JSON.stringify(pluck) === JSON.stringify([1, 2]), pluck);
    sdb.close();
  }

  console.log(`\ncompat-layers: ${p} passed, ${f} failed`);
  process.exit(f ? 1 : 0);
})();
