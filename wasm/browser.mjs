import {
  init,
  jsql_reset,
  jsql_create_table,
  jsql_drop_table,
  jsql_insert_json,
  jsql_find,
  jsql_find_by_id,
  jsql_find_by_ids,
  jsql_update_by_id,
  jsql_update_by_ids,
  jsql_remove_by_id,
  jsql_remove_by_ids,
  jsql_count,
} from './browser_bg.mjs';

function safeJsonParse(str) {
  try { return JSON.parse(str); } catch { return str; }
}

const PAGE = 500;

/**
 * JSQL-NEO browser engine — full SQL database running in the browser.
 *
 * WASM (Rust) for data, IndexedDB for persistence, the shared SQL engine for
 * queries. Node.js and browsers share the same JSQL API.
 */
export class JSQL {
  constructor(opts = {}) {
    this._dbName = opts.dbName || 'jsql-neo';
    this._persist = opts.persistence !== false;
    this._wasmBytes = opts.wasmBytes || null;
    this._tableNames = new Set();
    this._schemas = {};
    this._dbList = new Set(['default']);
    this._txId = undefined;
    this._txSnapshot = null;
    this._hooks = {
      beforeInsert: [], afterInsert: [],
      beforeUpdate: [], afterUpdate: [],
      beforeDelete: [], afterDelete: [],
      beforeFind: [], afterFind: [],
      beforeCreateTable: [], afterCreateTable: [],
      beforeDropTable: [], afterDropTable: [],
      beforeFlush: [], afterFlush: [],
      onStart: [], onStop: [],
    };
    this._eventListeners = [];
    this._idb = null;
    this._idbPromise = null;
    this._persistTimer = null;
    this._snapPromise = null;
  }

  /* ---------- hooks / events (same API as Node engines) ---------- */

  on(event, fn) {
    if (this._hooks[event]) this._hooks[event].push(fn);
    return this;
  }

  onEvent(fn) {
    this._eventListeners.push(fn);
    return this;
  }

  _emit(eventName, data) {
    for (const fn of this._eventListeners) {
      try { fn(eventName, data); } catch { /* ignore */ }
    }
  }

  _runHooks(hookName, args) {
    const hooks = this._hooks[hookName];
    if (!hooks || hooks.length === 0) return true;
    for (const fn of hooks) {
      const r = fn(...args);
      if (r === false) return false;
      if (r !== undefined && args.length > 0) args[0] = r;
    }
    return true;
  }

  /* ---------- IndexedDB persistence ---------- */

  _openIDB() {
    if (this._idbPromise) return this._idbPromise;
    this._idbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(this._dbName, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('store')) db.createObjectStore('store', { keyPath: 'k' });
      };
      req.onsuccess = () => { this._idb = req.result; resolve(this._idb); };
      req.onerror = () => reject(req.error);
    });
    return this._idbPromise;
  }

  async _readSnapshot() {
    const db = await this._openIDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('store', 'readonly');
      const get = tx.objectStore('store').get('snap');
      get.onsuccess = () => resolve(get.result ? get.result.v : null);
      get.onerror = () => reject(get.error);
    });
  }

  async _writeSnapshot() {
    if (!this._persist) return;
    if (this._snapPromise) return this._snapPromise;
    this._snapPromise = (async () => {
      const tables = {};
      for (const name of this._tableNames) {
        const rows = [];
        let offset = 0;
        for (;;) {
          const page = safeJsonParse(jsql_find(name, '', PAGE, offset)) || [];
          rows.push(...page);
          if (page.length < PAGE) break;
          offset += page.length;
        }
        tables[name] = { schema: this._schemas[name] || {}, rows: rows.map(r => r.fields) };
      }
      const db = await this._openIDB();
      await new Promise((resolve, reject) => {
        const tx = db.transaction('store', 'readwrite');
        tx.objectStore('store').put({ k: 'snap', v: { tables } });
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    })().finally(() => { this._snapPromise = null; });
    return this._snapPromise;
  }

  _schedulePersist() {
    if (!this._persist) return;
    clearTimeout(this._persistTimer);
    this._persistTimer = setTimeout(() => { this._writeSnapshot(); }, 300);
  }

  /* ---------- lifecycle ---------- */

  async start() {
    const bytes = this._wasmBytes ||
      new Uint8Array(await (await fetch(new URL('./jsql_neo_wasm_bg.wasm', import.meta.url))).arrayBuffer());
    await init(bytes);
    jsql_reset();
    if (this._persist) {
      const snap = await this._readSnapshot();
      if (snap && snap.tables) {
        for (const [name, t] of Object.entries(snap.tables)) {
          if (!t.schema) continue;
          jsql_create_table(name, JSON.stringify(t.schema));
          this._tableNames.add(name);
          this._schemas[name] = t.schema;
          if (t.rows && t.rows.length) {
            for (let i = 0; i < t.rows.length; i += PAGE) {
              jsql_insert_json(name, JSON.stringify(t.rows.slice(i, i + PAGE)));
            }
          }
        }
      }
    }
    this._runHooks('onStart', []);
    this._emit('start', {});
  }

  async flush() {
    if (!this._runHooks('beforeFlush', [])) return;
    await this._writeSnapshot();
    this._runHooks('afterFlush', []);
  }

  async stop() {
    clearTimeout(this._persistTimer);
    await this._writeSnapshot();
    if (this._idb) {
      this._idb.close();
      this._idb = null;
    }
    this._idbPromise = null;
    this._runHooks('onStop', []);
    this._emit('stop', {});
  }

  /* ---------- CRUD ---------- */

  async createTable(name, schema) {
    if (!this._runHooks('beforeCreateTable', [name, schema])) return null;
    const r = safeJsonParse(jsql_create_table(name, JSON.stringify(schema)));
    if (r && r.ok === false) throw new Error(r.error || 'create table failed');
    this._tableNames.add(name);
    this._schemas[name] = schema;
    this._emit('createTable', { name, schema });
    this._runHooks('afterCreateTable', [name, schema]);
    this._schedulePersist();
    return r;
  }

  async dropTable(name) {
    if (!this._runHooks('beforeDropTable', [name])) return null;
    const r = safeJsonParse(jsql_drop_table(name));
    if (r && r.ok === false) throw new Error(r.error || 'drop table failed');
    this._tableNames.delete(name);
    delete this._schemas[name];
    this._emit('dropTable', { name });
    this._runHooks('afterDropTable', [name]);
    this._schedulePersist();
    return r;
  }

  async insert(table, data) {
    const arr = Array.isArray(data) ? data : [data];
    if (!this._runHooks('beforeInsert', [table, arr])) return [];
    let result = [];
    for (let i = 0; i < arr.length; i += PAGE) {
      const r = safeJsonParse(jsql_insert_json(table, JSON.stringify(arr.slice(i, i + PAGE))));
      if (r && r.error) throw new Error(r.error);
      result = result.concat(r || []);
    }
    this._emit('insert', { table, count: arr.length, ids: result });
    this._runHooks('afterInsert', [table, arr, result]);
    this._schedulePersist();
    return result;
  }

  async insertMany(table, data) {
    return this.insert(table, data);
  }

  async findById(table, id) {
    const r = safeJsonParse(jsql_find_by_id(table, BigInt(id)));
    if (r && r.error) throw new Error(r.error);
    return r;
  }

  async findByIds(table, ids) {
    const r = safeJsonParse(jsql_find_by_ids(table, JSON.stringify(ids)));
    if (r && r.error) throw new Error(r.error);
    return r;
  }

  async find(table, filter, opts = {}) {
    if (!this._runHooks('beforeFind', [table, { filter, opts }])) return [];
    const { limit = 100, offset = 0 } = opts;
    const filterStr = filter ? JSON.stringify(filter) : '';
    const r = safeJsonParse(jsql_find(table, filterStr, limit, offset));
    if (r && r.error) throw new Error(r.error);
    this._runHooks('afterFind', [table, { filter, opts }, r]);
    return r;
  }

  async count(table) {
    const r = parseInt(jsql_count(table), 10);
    return isNaN(r) ? 0 : r;
  }

  async updateById(table, id, data) {
    if (!this._runHooks('beforeUpdate', [table, id, data])) return;
    const r = safeJsonParse(jsql_update_by_id(table, BigInt(id), JSON.stringify(data)));
    if (r && r.ok === false) throw new Error(r.error || 'update failed');
    this._emit('update', { table, id, data });
    this._runHooks('afterUpdate', [table, id, data, r]);
    this._schedulePersist();
    return r;
  }

  async updateByIds(table, entries) {
    const pairs = entries.map(([id, data]) => [Number(id), data]);
    if (!this._runHooks('beforeUpdate', [table, pairs])) return;
    const r = safeJsonParse(jsql_update_by_ids(table, JSON.stringify(pairs)));
    if (r && r.error) throw new Error(r.error);
    this._emit('update', { table, entries: pairs, result: r });
    this._runHooks('afterUpdate', [table, pairs, r]);
    this._schedulePersist();
    return r;
  }

  async removeById(table, id) {
    if (!this._runHooks('beforeDelete', [table, id])) return;
    const r = safeJsonParse(jsql_remove_by_id(table, BigInt(id)));
    if (r && r.ok === false) throw new Error(r.error || 'remove failed');
    this._emit('delete', { table, id });
    this._runHooks('afterDelete', [table, id, r]);
    this._schedulePersist();
    return r;
  }

  async removeByIds(table, ids) {
    if (!this._runHooks('beforeDelete', [table, ids])) return;
    const r = safeJsonParse(jsql_remove_by_ids(table, JSON.stringify(ids)));
    if (r && r.error) throw new Error(r.error);
    this._emit('delete', { table, ids, result: r });
    this._runHooks('afterDelete', [table, ids, r]);
    this._schedulePersist();
    return r;
  }

  async hasTable(name) {
    return this._tableNames.has(name);
  }

  async getTables() {
    return Array.from(this._tableNames);
  }

  tables() {
    return Array.from(this._tableNames);
  }

  async getTableSchema(name) {
    return this._schemas[name] || null;
  }

  /* ---------- transactions (snapshot rollback) ---------- */

  async beginTx() {
    this._txSnapshot = await this._snapshotAll();
    this._txId = (this._txId || 0) + 1;
    return this._txId;
  }

  async commitTx() {
    this._txId = undefined;
    this._txSnapshot = null;
  }

  async rollbackTx() {
    const snap = this._txSnapshot;
    this._txId = undefined;
    this._txSnapshot = null;
    if (snap) await this._restoreSnapshot(snap);
    this._schedulePersist();
  }

  /* same-name aliases used by some SQL paths */
  async begin() { return this.beginTx(); }
  async commit() { return this.commitTx(); }
  async rollback() { return this.rollbackTx(); }

  async _snapshotAll() {
    const tables = {};
    for (const name of this._tableNames) {
      const rows = [];
      let offset = 0;
      for (;;) {
        const page = safeJsonParse(jsql_find(name, '', PAGE, offset)) || [];
        rows.push(...page);
        if (page.length < PAGE) break;
        offset += page.length;
      }
      tables[name] = { schema: this._schemas[name], rows: rows.map(r => r.fields) };
    }
    return tables;
  }

  async _restoreSnapshot(tables) {
    jsql_reset();
    this._tableNames.clear();
    for (const [name, t] of Object.entries(tables)) {
      jsql_create_table(name, JSON.stringify(t.schema));
      this._tableNames.add(name);
      this._schemas[name] = t.schema;
      if (t.rows && t.rows.length) {
        for (let i = 0; i < t.rows.length; i += PAGE) {
          jsql_insert_json(name, JSON.stringify(t.rows.slice(i, i + PAGE)));
        }
      }
    }
  }

  /* ---------- multi-database (single-DB simulation) ---------- */

  async listDatabases() {
    return Array.from(this._dbList);
  }

  async createDatabase(name) {
    this._dbList.add(name);
  }

  async dropDatabase(name) {
    this._dbList.delete(name);
  }

  async useDatabase(name) {
    if (!this._dbList.has(name)) {
      throw new Error(`Unknown database '${name}'`);
    }
  }

  /* ---------- SQL ---------- */

  async executeSQL(sqlText, params) {
    const mod = await import('../lib/sql.js');
    const sql = mod.default && mod.default.executeSQL ? mod.default : mod;
    return sql.executeSQL(this, sqlText, params);
  }
}

export default { JSQL };
