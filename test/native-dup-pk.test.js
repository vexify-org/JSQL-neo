/*
 * 显式重复主键回归测试（issue #20）
 *   node test/native-dup-pk.test.js
 *
 * 覆盖：
 *   1. Native (Rust) 引擎显式指定已存在的主键插入 → 抛 ER_DUP_ENTRY，且不产生
 *      shadow row（行数不变、原行仍能按主键查到、未被覆盖）。
 *   2. 纯 JS 引擎同样输入 → 同样的错误码/消息（两引擎行为一致）。
 *   3. 批量插入中夹带重复主键 → 同样报错。
 *   4. Native 持久化表重新打开后，重复主键仍报错。
 *
 * 无 native 编译产物时：Native 部分标记 SKIP 而不是失败，纯 JS 部分照常跑。
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const ROOT = path.join(__dirname, '..');

const { Database, NativeJSQL } = require(path.join(ROOT, 'index.js'));

const NATIVE_FILE = path.join(ROOT, 'native', 'jsql-neo-native.node');
const NATIVE_AVAILABLE = (() => {
  if (!fs.existsSync(NATIVE_FILE)) return false;
  try { require(NATIVE_FILE); return true; } catch (e) { return false; }
})();

let passed = 0, failed = 0, skipped = 0;
function ok(name, cond, extra) {
  if (cond) { passed++; console.log('[OK]', name); }
  else { failed++; console.log('[FAIL]', name, extra !== undefined ? JSON.stringify(extra) : ''); }
}
function skip(name, why) { skipped++; console.log('[SKIP]', name, why ? `(${why})` : ''); }

const DUP_MSG = "Duplicate entry '2' for key 'id'";
const isDupErr = (e) => !!e && e.message === DUP_MSG
  && (e.code === 1062 || e.code === 'ER_DUP_ENTRY');

/** 执行并捕获错误，返回 {err, message, code} */
async function capture(fn) {
  try { await fn(); return { err: null }; }
  catch (e) { return { err: e, message: e && e.message, code: e && e.code }; }
}

/** 返回该引擎在这次重复主键插入中观察到的错误（供两引擎比对） */
async function scenario(name, mk) {
  const db = await mk();
  await db.createTable('users', { id: 'integer primary key auto_increment', name: 'string' });

  await db.insert('users', { name: 'Alice' });            // id = 1
  await db.insert('users', { id: 2, name: 'Bob' });       // 显式 id = 2

  // 显式重复主键：必须报错
  const r = await capture(() => db.insert('users', { id: 2, name: 'Shadow' }));
  ok(`${name} 显式重复主键插入抛错`, !!r.err && isDupErr(r.err), { message: r.message, code: r.code });
  ok(`${name} 错误消息与 MySQL 一致`, r.message === DUP_MSG, r.message);
  ok(`${name} 错误带 MySQL 错误码 1062`, !!r.err && (r.err.code === 1062 || r.err.errno === 1062),
    r.err && { code: r.err.code, errno: r.err.errno });

  // 不产生 shadow row：行数不变，原行仍可查到且未被覆盖
  const all = await db.find('users', {});
  ok(`${name} 行数不变（无 shadow row）`, all.length === 2, all.map(x => x.id));
  const bob = await db.findById('users', 2);
  ok(`${name} 原行仍可 findById 查到且未被覆盖`, !!bob && bob.name === 'Bob', bob);

  // 批量插入夹带重复主键：同样报错
  const rb = await capture(() => db.insert('users', [{ id: 7, name: 'ok' }, { id: 2, name: 'dup' }]));
  ok(`${name} 批量中的重复主键抛错`, !!rb.err && isDupErr(rb.err), { message: rb.message, code: rb.code });

  if (typeof db.stop === 'function') await db.stop();
  return { message: r.message, code: r.code };
}

(async () => {
  console.log('--- 纯 JS 引擎（Database）---');
  const pure = await scenario('PureJS', async () => new Database(':memory:'));

  console.log('\n--- Native 引擎 ---');
  if (!NATIVE_AVAILABLE) {
    skip('NativeJSQL 重复主键', 'native module unavailable');
  } else {
    const nat = await scenario('Native', async () => {
      const db = new NativeJSQL({ mode: 'memory' });
      await db.start();
      return db;
    });
    ok('两引擎错误消息一致', pure.message === nat.message, { pure: pure.message, native: nat.message });
    ok('两引擎错误码一致', pure.code === nat.code, { pure: pure.code, native: nat.code });

    // 持久化表：重新打开后主键索引也要保持一致（不因回填而错位）
    {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsql-dup-pk-'));
      const mk = async () => {
        const db = new NativeJSQL({ mode: 'disk', path: dir });
        await db.start();
        return db;
      };
      let db = await mk();
      await db.createTable('users', { id: 'integer primary key auto_increment', name: 'string' });
      await db.insert('users', { name: 'Alice' });
      await db.insert('users', { id: 2, name: 'Bob' });
      await db.stop();
      db = await mk();                                    // 从磁盘重新加载
      const r = await capture(() => db.insert('users', { id: 2, name: 'Shadow' }));
      ok('Native(disk) 重开后重复主键仍抛错', !!r.err && isDupErr(r.err), { message: r.message, code: r.code });
      const all = await db.find('users', {});
      ok('Native(disk) 重开后行数不变', all.length === 2, all.map(x => x.id));
      await db.stop();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  console.log(`\n共 ${passed + failed} 项：${passed} 通过, ${failed} 失败, ${skipped} 跳过`);
  process.exitCode = failed ? 1 : 0;
})();
