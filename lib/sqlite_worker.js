// © Vexify 2026 All Rights Reserved.
/**
 * better-sqlite3 兼容层 — worker 线程
 * 在 worker 中持有一个持久 Database，主线程通过 postMessage + Atomics 同步桥调用。
 */

const { workerData } = require('worker_threads');
const Database = require('./database');
const { executeSQL, parseSQL, applyParams } = require('./sql');

const PARENT = require('worker_threads').parentPort;
const PORT = workerData.port || PARENT;
let db = null;
let sab = null;
let ctrl = null;
const userFunctions = {};
const userAggregates = {};

function startEngine(filename, options) {
  const opts = options || {};
  const isMemory = filename === ':memory:' || !filename;
  if (opts.engine === 'native') {
    const { JSQL: NativeJSQL } = require('./native_client');
    const engine = new NativeJSQL({ mode: 'memory' });
    db = {
      start: async () => { await engine.start(); },
      stop: async () => { await engine.stop(); },
      hasTable: name => engine._tableNames.has(name),
      createTable: (n, s) => engine.createTable(n, s),
      dropTable: n => engine.dropTable(n),
      insert: (n, rows) => engine.insert(n, rows),
      find: (n, f, o) => engine.find(n, f, o),
      updateById: (n, id, data) => engine.updateById(n, id, data),
      updateByIds: (n, e) => engine.updateByIds(n, e),
      removeByIds: (n, ids) => engine.removeByIds(n, ids),
      count: (n, f) => engine.count ? engine.count(n, f) : engine.find(n, f || {}, {}).then(rs => rs.length),
      getTableSchema: n => engine._schemas[n] || null,
      beginTx: () => engine.beginTx(),
      commitTx: id => engine.commitTx(id),
      rollbackTx: id => engine.rollbackTx(id),
      truncate: async () => { throw new Error('truncate not supported on native engine'); },
      flush: async () => { if (engine.flush) await engine.flush(); },
      listTables: () => Array.from(engine._tableNames || []),
      _schemas: engine._schemas,
    };
    return db;
  }
  // 纯 JS 引擎
  db = new Database(isMemory ? ':memory:' : filename, opts.mode === 'hybrid' ? { mode: 'hybrid' } : {});
  return db;
}

function toRows(result) {
  // 把 executeSQL 的 select 结果转成 better-sqlite3 风格的对象行数组
  if (result && result.type === 'select' && Array.isArray(result.rows)) {
    const cols = Array.isArray(result.columns) ? result.columns : [];
    return result.rows.map(r => {
      const o = {};
      for (let i = 0; i < cols.length; i++) o[cols[i]] = r[i];
      return o;
    });
  }
  if (result && result.type === 'pragma' && result.value !== undefined) {
    return result.value;
  }
  return undefined;
}

let _lastInsertId = 0;

async function executeStatement(sql, params) {
  if (params && typeof params === 'object' && !Array.isArray(params)) {
    sql = applyParams(sql, params);
    params = null;
  }
  const result = await executeSQL(db, sql, params, {
    session: {
      get lastInsertId() { return _lastInsertId; },
      set lastInsertId(v) { _lastInsertId = Number(v); },
    },
    functions: userFunctions,
    aggregates: userAggregates,
  });
  if (result && result.type === 'insert' && result.insertId !== null && result.insertId !== undefined) {
    _lastInsertId = Number(result.insertId);
  }
  return result;
}

function cleanResult(r) {
  if (!r || typeof r !== 'object') return r;
  if (Array.isArray(r)) return r.map(cleanResult);
  if (Buffer.isBuffer(r) || r instanceof Uint8Array || r instanceof ArrayBuffer || ArrayBuffer.isView(r)) return r;
  const out = {};
  for (const [k, v] of Object.entries(r)) {
    if (k === 'result' || k === 'engine') continue;
    if (v instanceof Date) out[k] = v.toISOString();
    else if (v === undefined) out[k] = null;
    else if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
      // 仅保留可 JSON 化的值（防止 Table/内部对象循环引用）
      try { JSON.stringify(v); out[k] = v; } catch (e) { out[k] = null; }
    } else out[k] = v;
  }
  return out;
}

async function handleOp(op, args) {
  let result;
  switch (op) {
    case 'start': {
      await startEngine(args[0], args[1]).start();
      result = { ok: true };
      break;
    }
    case 'close': {
      if (db && typeof db.stop === 'function') await db.stop();
      result = { ok: true };
      break;
    }
    case 'exec': {
      result = await executeStatement(args[0], args[1]);
      break;
    }
    case 'run': {
      const r = await executeStatement(args[0], args[1]);
      result = {
        changes: r ? (r.affectedRows || 0) : 0,
        lastInsertRowid: r && r.type === 'insert' ? Number(r.insertId || 0) : _lastInsertId,
      };
      break;
    }
    case 'get': {
      const r = await executeStatement(args[0], args[1]);
      const rows = toRows(r);
      result = Array.isArray(rows) ? (rows.length > 0 ? rows[0] : undefined) : rows;
      break;
    }
    case 'all': {
      const r = await executeStatement(args[0], args[1]);
      const rows = toRows(r);
      result = rows === undefined || rows === null ? [] : rows;
      break;
    }
    case 'raw': {
      const r = await executeStatement(args[0], args[1]);
      let rows = r && r.type === 'select' ? (r.rows || []) : (toRows(r) || []);
      const cols = r && Array.isArray(r.columns) ? r.columns : (rows.length > 0 ? Object.keys(rows[0]) : []);
      if (Array.isArray(rows) && rows.length > 0 && typeof rows[0] === 'object' && !Array.isArray(rows[0])) {
        rows = rows.map(row => cols.map(c => row[c]));
      }
      result = rows;
      break;
    }
    case 'columns': {
      const r = await executeStatement(args[0], args[1]);
      const cols = r && r.type === 'select' && Array.isArray(r.columns) ? r.columns : [];
      result = cols.map((name, i) => ({
        name,
        type: 'TEXT',
        column: name,
        table: r && r.table ? r.table : null,
        database: null,
      }));
      break;
    }
    case 'parse': {
      const stmt = parseSQL(args[0]);
      result = { type: stmt.type, name: stmt.name || stmt.table || null };
      break;
    }
    case 'hasTable': {
      result = typeof db.hasTable === 'function' ? db.hasTable(args[0]) : false;
      break;
    }
    case 'registerFunction': {
      const [name, fnStr, deterministic] = args;
      // 用函数源码在 worker 中重建（无闭包依赖的纯函数）
      try {
        // eslint-disable-next-line no-new-func
        const fn = new Function('return (' + fnStr + ')')();
        userFunctions[String(name).toUpperCase()] = fn;
        result = { ok: true };
      } catch (e) {
        throw new Error('Failed to register function ' + name + ': ' + e.message);
      }
      break;
    }
    case 'clearFunctions': {
      for (const k of Object.keys(userFunctions)) delete userFunctions[k];
      result = { ok: true };
      break;
    }
    case 'registerAggregate': {
      const [name, specStr, deterministic] = args;
      try {
        // eslint-disable-next-line no-new-func
        const spec = new Function('return (' + specStr + ')')();
        userAggregates[String(name).toUpperCase()] = spec;
        result = { ok: true };
      } catch (e) {
        throw new Error('Failed to register aggregate ' + name + ': ' + e.message);
      }
      break;
    }
    case 'serialize': {
      const { exportAllToJSON } = require('./migrate');
      const tables = db.listTables ? db.listTables() : Array.from(db._tableNames || []);
      const dump = await exportAllToJSON(db, tables);
      result = Buffer.from(JSON.stringify(dump), 'utf8');
      break;
    }
    case 'deserialize': {
      const { importFromJSON } = require('./migrate');
      const dump = JSON.parse(Buffer.from(args[0]).toString('utf8'));
      await importFromJSON(db, dump, { overwrite: true });
      if (typeof db.save === 'function') db.save();
      result = { ok: true };
      break;
    }
    case 'backup': {
      // 复制到另一个 sqlite 兼容库
      const { exportAllToJSON } = require('./migrate');
      const target = args[0];
      const tables = db.listTables ? db.listTables() : Array.from(db._tableNames || []);
      const dump = await exportAllToJSON(db, tables);
      // 目标由主线程用另一个 Database 加载，此处返回 dump
      result = Buffer.from(JSON.stringify(dump), 'utf8');
      break;
    }
    case 'clearAggregates': {
      for (const k of Object.keys(userAggregates)) delete userAggregates[k];
      result = { ok: true };
      break;
    }
    default:
      throw new Error(`Unknown op: ${op}`);
  }
  return result;
}

PARENT.on('message', async (msg) => {
  const { id, op, args, sab: sabArr } = msg;
  if (sabArr) {
    sab = sabArr;
    ctrl = new Int32Array(sab);
  }
  let payload;
  try {
    payload = { ok: true, result: cleanResult(await handleOp(op, args)) };
  } catch (e) {
    payload = { ok: false, error: { message: e.message, code: e.code || 'SQLITE_ERROR' } };
  }
  PORT.postMessage({ id, ...payload });
  if (ctrl) {
    Atomics.store(ctrl, 0, id);
    Atomics.notify(ctrl, 0);
  }
});

PARENT.on('close', async () => {
  try {
    if (db && typeof db.stop === 'function') await db.stop();
  } catch (e) { /* ignore */ }
});
