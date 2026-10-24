/*
 * WASM updateById 性能回归基准
 *   node bench/bench_wasm_update.js [--rows 100000]
 *
 * 背景：lib/wasm_client.js 的 _assertNoKeyConflict 曾**无条件**把整张表导出成
 * JSON 再逐字段查键冲突（与 6.4.8 在 native 侧修掉的「无条件整表 JSON 导出」同源，
 * 但修复没覆盖 wasm 客户端）。UPDATE t SET age=30 WHERE id=1 这类不碰主键/UNIQUE
 * 列的日常更新，也要先付一遍整表导出的钱：10 万行 ~590ms/次，且随行数近线性放大。
 *
 * 本脚本：
 *   1. 分表规模量 updateById（非键列）的耗时 —— 修复后应为 O(1)，不随行数放大；
 *   2. 直接调 wasm 绑定层隔离 Rust 侧成本（core 的 pk_index 本就是 O(1)）；
 *   3. 顺带复验键冲突语义：幂等主键更新不误报、改主键/UNIQUE 撞车仍 ER_DUP_ENTRY；
 *   4. 更新后按 id 回读，验证索引随增删改保持同步。
 */
const path = require('path');
const ROOT = path.join(__dirname, '..');

const argRows = Number(process.argv[process.argv.indexOf('--rows') + 1]);
const ROWS = Number.isFinite(argRows) && argRows > 0 ? argRows : 100000;
const SIZES = process.argv.includes('--json') ? [ROWS] : [1000, 10000, ROWS];

const { JSQL } = require(path.join(ROOT, 'lib', 'wasm_client'));
const wasmBindings = require(path.join(ROOT, 'wasm', 'jsql_neo_wasm.js'));

const SCHEMA = {
  id: { type: 'integer', primaryKey: true, autoIncrement: true },
  name: { type: 'string' },
  age: { type: 'integer' },
};

function genData(n) {
  const rows = new Array(n);
  for (let i = 0; i < n; i++) rows[i] = { name: `user_${i + 1}`, age: 20 + (i % 50) };
  return rows;
}

const hr = () => Number(process.hrtime.bigint()) / 1e6; // ms, sub-ms 精度

(async () => {
  const out = { sizes: {}, notes: [] };

  for (const n of SIZES) {
    const db = new JSQL({ modules: false });
    await db.start();
    await db.createTable('users', SCHEMA);
    const t0 = Date.now();
    await db.insert('users', genData(n));
    await db._flush();
    const setupMs = Date.now() - t0;

    const rec = { rows: n, setupMs };

    /* 1. 客户端 updateById：非键列（日常路径，必须 O(1)） */
    {
      const probes = [];
      for (let i = 0; i < 100; i++) probes.push(1 + Math.floor(Math.random() * n));
      const t = hr();
      for (const pid of probes) await db.updateById('users', pid, { name: `u_${pid}` });
      rec.clientUpdateNonKeyMs = +((hr() - t) / probes.length).toFixed(3);
    }

    /* 2. 绑定层直调 jsql_update_by_id：隔离 Rust 侧成本 */
    {
      const seq = 1 + Math.floor(Math.random() * (n - 1));
      const payload = JSON.stringify({ name: 'raw_probe' });
      const t = hr();
      for (let i = 0; i < 100; i++) {
        wasmBindings.jsql_update_by_id('users', BigInt(seq), payload);
      }
      rec.rawBindingUpdateMs = +((hr() - t) / 100).toFixed(3);
    }

    /* 3. 幂等主键更新（值没变）：不得误报 ER_DUP_ENTRY */
    {
      let okFlag = true, err = null;
      const t = hr();
      try {
        await db.updateById('users', 1, { id: 1, name: 'idem' });
      } catch (e) { okFlag = false; err = e; }
      rec.idempotentPkUpdateMs = +((hr() - t).toFixed(3));
      rec.idempotentPkUpdateOk = okFlag;
      if (err) out.notes.push(`[rows=${n}] idempotent pk update threw: ${err.code || ''} ${err.message}`);
    }

    /* 4. 改主键撞车：必须 ER_DUP_ENTRY */
    {
      let code = null;
      try { await db.updateById('users', 1, { id: 2 }); } catch (e) { code = e.code || e.message; }
      rec.pkCollisionBlocked = code === 'ER_DUP_ENTRY';
      if (code !== 'ER_DUP_ENTRY') out.notes.push(`[rows=${n}] pk collision NOT blocked, got: ${code}`);
    }

    /* 5. UNIQUE 列撞车：必须 ER_DUP_ENTRY */
    {
      await db.createTable('u2', {
        id: { type: 'integer', primaryKey: true, autoIncrement: true },
        code: { type: 'string', unique: true },
        note: { type: 'string' },
      });
      await db.insert('u2', [{ code: 'A', note: '1' }, { code: 'B', note: '2' }]);
      // 注意：id 是自增主键（实际取 1,2），'A' 是 code 列的值、不是主键 ——
      // 拿 'A' 当主键去 update 命中不到任何行（no-op），必须用真实主键 1。
      let code = null;
      try { await db.updateById('u2', 1, { code: 'B' }); } catch (e) { code = e.code || e.message; }
      rec.uniqueCollisionBlocked = code === 'ER_DUP_ENTRY';
      if (code !== 'ER_DUP_ENTRY') out.notes.push(`[rows=${n}] unique collision NOT blocked, got: ${code}`);
      /* 幂等 UNIQUE 更新同样不得误报 */
      let uOk = true;
      try { await db.updateById('u2', 1, { code: 'A', note: '1b' }); } catch (e) { uOk = false; out.notes.push(`[rows=${n}] idempotent unique update threw: ${e.message}`); }
      rec.idempotentUniqueUpdateOk = uOk;
      await db.dropTable('u2');
    }

    /* 6. 索引同步：批量改完按 id 回读；删除一行后同 id 更新应为 no-op（不复活） */
    {
      const probeId = 3;
      await db.updateById('users', probeId, { name: 'synced', age: 77 });
      const row = await db.findById('users', probeId);
      rec.indexSyncAfterUpdate = !!(row && row.name === 'synced' && row.age === 77);
      if (row && (row.name !== 'synced' || row.age !== 77)) {
        out.notes.push(`[rows=${n}] index desync after update: ${JSON.stringify(row)}`);
      }
      await db.removeById('users', probeId);
      const noop = await db.updateById('users', probeId, { name: 'after-remove' });
      // 删除行后再 update 同一 id：应是 no-op（返回 null），行不会凭空复活。
      // 旧 bench 在这里断言行能更新回来，是对语义的误解（稳态下恒 FAIL）。
      rec.indexSyncAfterRemove = noop === null;
      if (noop !== null) {
        out.notes.push(`[rows=${n}] update on deleted row resurrected it: ${JSON.stringify(noop)}`);
      }
    }

    await db.stop();
    out.sizes[`${n}`] = rec;
  }

  console.log('\n===== WASM updateById bench =====');
  for (const rec of Object.values(out.sizes)) {
    console.log(
      `rows=${String(rec.rows).padStart(6)}  setup=${String(rec.setupMs).padStart(6)}ms  ` +
      `updateById(非键列)=${String(rec.clientUpdateNonKeyMs).padStart(8)}ms/op  ` +
      `raw_binding=${String(rec.rawBindingUpdateMs).padStart(7)}ms/op`
    );
  }
  console.log('----- 语义/同步校验 -----');
  for (const rec of Object.values(out.sizes)) {
    console.log(
      `rows=${String(rec.rows).padStart(6)}  ` +
      `幂等主键更新:${rec.idempotentPkUpdateOk ? 'OK' : 'FAIL'}(${rec.idempotentPkUpdateMs}ms)  ` +
      `主键撞车拦截:${rec.pkCollisionBlocked ? 'OK' : 'FAIL'}  ` +
      `UNIQUE撞车拦截:${rec.uniqueCollisionBlocked ? 'OK' : 'FAIL'}  ` +
      `幂等UNIQUE:${rec.idempotentUniqueUpdateOk ? 'OK' : 'FAIL'}  ` +
      `更新后回读:${rec.indexSyncAfterUpdate ? 'OK' : 'FAIL'}  ` +
      `删后同id更新no-op:${rec.indexSyncAfterRemove ? 'OK' : 'FAIL'}`
    );
  }
  if (out.notes.length) {
    console.log('----- notes -----');
    for (const note of out.notes) console.log('  ' + note);
  }
  if (process.argv.includes('--json')) console.log(JSON.stringify(out, null, 2));
})().catch((e) => { console.error('BENCH ERROR:', e); process.exit(1); });
