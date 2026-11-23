/*
 * Regression tests for issues #445–#449.
 *   node test/issue-445-449.test.js
 *
 * 覆盖：
 *   #445 递归 CTE 递归项内 JOIN 自引用不展开（INNER / LEFT JOIN 层级遍历）
 *   #446 未提交事务写入经 WAL 在 SIGKILL 后回放复活（真实子进程崩溃重启）
 *   #447 活动 beginTx 期间自动 checkpoint 固化未提交行
 *   #448 窗口聚合静默丢弃 DISTINCT
 *   #449 disk/hybrid 目录模式从不获取文件锁
 *
 * 用例断言用户可见行为：SQL 结果、恢复后行集、错误码/错误消息、实例打开结果，
 * 不直接断言内部字段。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const { Database } = require(path.join(ROOT, 'index.js'));

let passed = 0, failed = 0;
function ok(name, cond, extra) {
  if (cond) { passed++; console.log('[OK]', name); }
  else { failed++; console.log('[FAIL]', name, extra !== undefined ? '→ ' + JSON.stringify(extra) : ''); }
}

const SCHEMA = { id: { type: 'integer', primaryKey: true }, v: { type: 'string' } };

function tmpDir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'jsql-445-449-' + tag + '-'));
}

// ---------------------------------------------------------------------------
// #445 递归 CTE：递归项以 JOIN 形式引用 CTE 自身
// ---------------------------------------------------------------------------
async function testRecursiveCteJoin() {
  console.log('\n--- #445 递归 CTE JOIN 自引用 ---');
  const db = new Database(':memory:');
  try {
    await db.query("CREATE TABLE e (id INT, mgr INT, name TEXT)");
    await db.query("INSERT INTO e VALUES (1,NULL,'CEO'),(2,1,'A'),(3,1,'B'),(4,2,'C')");

    const inner = `WITH RECURSIVE hier(id, name, depth) AS (
      SELECT id, name, 1 FROM e WHERE mgr IS NULL
      UNION ALL
      SELECT e.id, e.name, h.depth+1 FROM e JOIN hier h ON e.mgr = h.id
    ) SELECT id, name, depth FROM hier ORDER BY id`;
    const rInner = await db.query(inner);
    const expected = [[1, 'CEO', 1], [2, 'A', 2], [3, 'B', 2], [4, 'C', 3]];
    ok('INNER JOIN 自引用逐层展开（锚点 + 两层子女）',
      JSON.stringify(rInner.rows) === JSON.stringify(expected), rInner.rows);

    // LEFT JOIN 自引用：已匹配的子女节点必须出现，且结果有界、
    // 不会每轮重复累积到行数上限。
    const left = `WITH RECURSIVE hier(id, name, depth) AS (
      SELECT id, name, 1 FROM e WHERE mgr IS NULL
      UNION ALL
      SELECT e.id, e.name, h.depth+1 FROM e LEFT JOIN hier h ON e.mgr = h.id
    ) SELECT id, name, depth FROM hier ORDER BY id, depth`;
    const rLeft = await db.query(left);
    const ids = rLeft.rows.map(x => x[0]);
    ok('LEFT JOIN 自引用：根/子女/孙节点均出现',
      [1, 2, 3, 4].every(id => ids.includes(id)), rLeft.rows.map(x => x.slice(0, 2)));
    ok('LEFT JOIN 自引用：结果有界（未累积到行数上限）',
      rLeft.rows.length < 10000, rLeft.rows.length);
  } catch (e) {
    ok('递归 CTE JOIN 用例未抛错', false, String(e && e.message).slice(0, 120));
  } finally {
    await db.stop();
  }
}

// ---------------------------------------------------------------------------
// #448 窗口聚合 DISTINCT
// ---------------------------------------------------------------------------
async function testWindowDistinct() {
  console.log('\n--- #448 窗口聚合 DISTINCT ---');
  const db = new Database(':memory:');
  try {
    await db.query("CREATE TABLE w (id INT, dept TEXT, sal INT)");
    await db.query("INSERT INTO w VALUES (1,'x',100),(2,'x',200),(3,'x',200),(4,'y',150),(5,'y',250),(6,'y',250)");
    const r = await db.query("SELECT dept, COUNT(DISTINCT sal) OVER (PARTITION BY dept) c, SUM(DISTINCT sal) OVER (PARTITION BY dept) s FROM w ORDER BY id");
    const expected = [['x', 2, 300], ['x', 2, 300], ['x', 2, 300], ['y', 2, 400], ['y', 2, 400], ['y', 2, 400]];
    ok('COUNT(DISTINCT) / SUM(DISTINCT) 窗口按分区去重',
      JSON.stringify(r.rows) === JSON.stringify(expected), r.rows);
  } catch (e) {
    ok('窗口 DISTINCT 用例未抛错', false, String(e && e.message).slice(0, 120));
  } finally {
    await db.stop();
  }
}

// ---------------------------------------------------------------------------
// #447 活动 beginTx 期间自动 checkpoint 不固化未提交行
// ---------------------------------------------------------------------------
async function testCheckpointDuringTx() {
  console.log('\n--- #447 活动事务期间 checkpoint ---');
  const dir = tmpDir('cptx');
  const file = path.join(dir, 'db.json');
  const db = new Database(file, { walCheckpointOps: 2 });
  try {
    await db.createTable('t', SCHEMA);
    await db.insert('t', { id: 1, v: 'committed' });
    await db.save();

    await db.beginTx();
    await db.insert('t', { id: 2, v: 'uncommitted-A' });
    await db.insert('t', { id: 3, v: 'uncommitted-B' });
    // 等待 setImmediate 调度的自动 checkpoint 跑完
    await new Promise(r => setTimeout(r, 300));

    const snap = JSON.parse(fs.readFileSync(file, 'utf8'));
    const snapRows = snap.t || [];
    ok('主快照不含未提交行',
      snapRows.length === 1 && snapRows[0].id === 1, snapRows);
    ok('WAL 未被 checkpoint 清空', fs.existsSync(file + '.wal'));
    ok('inTransaction() 识别 beginTx 路径', db.inTransaction() === true);

    await db.rollbackTx();
  } catch (e) {
    ok('事务 checkpoint 用例未抛错', false, String(e && e.message).slice(0, 120));
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// #446 未提交事务写入在 SIGKILL 后不随 WAL 回放复活（真实子进程崩溃重启）
// ---------------------------------------------------------------------------
function writeChildCrashScript() {
  const script = path.join(tmpDir('child'), 'midtx-child.js');
  fs.writeFileSync(script, `
    const jsql = require(${JSON.stringify(path.join(ROOT, 'index.js'))});
    const file = process.argv[2];
    (async () => {
      const db = new jsql.Database(file, { walCheckpointOps: 0 });
      await db.beginTx();
      await db.insert('t', { id: 2, v: 'uncommitted' });
      console.log('child inserted');
      setTimeout(() => process.kill(process.pid, 'SIGKILL'), 200);
    })().catch(e => { console.error('ERR', e); process.exit(1); });
  `);
  return script;
}

function writeChildCommitScript() {
  const script = path.join(tmpDir('childc'), 'commit-child.js');
  fs.writeFileSync(script, `
    const jsql = require(${JSON.stringify(path.join(ROOT, 'index.js'))});
    const file = process.argv[2];
    (async () => {
      const db = new jsql.Database(file, { walCheckpointOps: 0 });
      await db.beginTx();
      await db.insert('t', { id: 2, v: 'committed-tx' });
      await db.commitTx();
      setTimeout(() => process.kill(process.pid, 'SIGKILL'), 200);
    })().catch(e => { console.error('ERR', e); process.exit(1); });
  `);
  return script;
}

async function seedFile(file) {
  const seed = new Database(file, { walCheckpointOps: 0 });
  await seed.createTable('t', SCHEMA);
  await seed.insert('t', { id: 1, v: 'committed' });
  await seed.save();
  seed.close();
}

async function testUncommittedTxNoResurrect() {
  console.log('\n--- #446 SIGKILL 后未提交事务不复活 ---');
  const dir = tmpDir('midtx');
  const file = path.join(dir, 'db.json');
  await seedFile(file);

  const childScript = writeChildCrashScript();
  const ch = spawnSync('node', [childScript, file], { encoding: 'utf8' });
  ok('子进程被 SIGKILL 终止', ch.signal === 'SIGKILL', { status: ch.status, signal: ch.signal });

  try { fs.unlinkSync(file + '.lock'); } catch (_) { /* 崩溃残留锁由测试侧清理 */ }

  const db2 = new Database(file, { walCheckpointOps: 0 });
  const rows = await db2.find('t');
  ok('崩溃重开后只剩已提交行（未提交行不复活）',
    rows.length === 1 && rows[0].id === 1 && rows[0].v === 'committed', rows);
  db2.close();
  fs.rmSync(dir, { recursive: true, force: true });
}

async function testCommittedTxSurvivesCrash() {
  console.log('\n--- #446 已提交事务崩溃后仍恢复 ---');
  const dir = tmpDir('ctxtx');
  const file = path.join(dir, 'db.json');
  await seedFile(file);

  const childScript = writeChildCommitScript();
  const ch = spawnSync('node', [childScript, file], { encoding: 'utf8' });
  ok('提交事务子进程被 SIGKILL 终止', ch.signal === 'SIGKILL', { status: ch.status, signal: ch.signal });

  try { fs.unlinkSync(file + '.lock'); } catch (_) { /* ignore */ }

  const db2 = new Database(file, { walCheckpointOps: 0 });
  const rows = await db2.find('t');
  ok('崩溃重开后已提交事务的行仍然存在',
    rows.length === 2 && rows[0].id === 1 && rows[1].id === 2, rows);
  db2.close();
  fs.rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// #449 disk/hybrid 目录模式文件锁
// ---------------------------------------------------------------------------
async function testDirModeFileLock() {
  console.log('\n--- #449 目录模式文件锁 ---');
  const dir = tmpDir('dirlock');
  try {
    const dbA = new Database(dir, { mode: 'disk', flushInterval: 0 });
    await dbA.createTable('t', SCHEMA);
    await dbA.insert('t', { id: 1, v: 'seed' });
    await dbA.flush();

    // 同目录第二个实例必须被拒绝（锁冲突）
    let bErr = null;
    let dbB = null;
    try { dbB = new Database(dir, { mode: 'disk', flushInterval: 0 }); }
    catch (e) { bErr = e; }
    ok('同目录第二个实例被文件锁拒绝',
      !!bErr && (bErr.code === 1205 || bErr.code === 'ER_LOCK_WAIT_TIMEOUT' || /locked/i.test(bErr.message || '')),
      bErr && (bErr.code || bErr.message));

    dbA.close();

    // 锁释放后第二个实例可正常打开并读到已提交行
    const dbC = new Database(dir, { mode: 'disk', flushInterval: 0 });
    const rows = await dbC.find('t');
    ok('锁释放后实例可打开并读到已提交行', rows.length === 1 && rows[0].v === 'seed', rows);
    dbC.close();

    // 崩溃残留的过期锁（>30s）可被新实例接管
    const staleDir = tmpDir('stale');
    fs.writeFileSync(path.join(staleDir, '.lock'), '99999');
    const old = (Date.now() - 31000) / 1000;
    fs.utimesSync(path.join(staleDir, '.lock'), old, old);
    const dbD = new Database(staleDir, { mode: 'disk', flushInterval: 0 });
    await dbD.createTable('t', SCHEMA);
    await dbD.insert('t', { id: 1, v: 'takeover' });
    await dbD.flush();
    ok('过期残留锁被新实例接管', (await dbD.find('t')).length === 1);
    dbD.close();
    fs.rmSync(staleDir, { recursive: true, force: true });
  } catch (e) {
    ok('目录锁用例未抛错', false, String(e && e.message).slice(0, 120));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

(async () => {
  await testRecursiveCteJoin();
  await testWindowDistinct();
  await testCheckpointDuringTx();
  await testUncommittedTxNoResurrect();
  await testCommittedTxSurvivesCrash();
  await testDirModeFileLock();

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
