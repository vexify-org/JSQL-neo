const path = require('path');
const wasmBindings = require(path.join(__dirname, '..', 'wasm', 'jsql_neo_wasm.js'));

function safeJsonParse(str) {
  try { return JSON.parse(str); } catch { return str; }
}

const INT64_TAG = 1;
const FLOAT_TAG = 2;
const STR_TAG = 3;
const BOOL_TAG = 4;
const INT32_TAG = 5;

function encodeBatch(rows) {
  if (rows.length === 0) return new Uint8Array(0);
  const fieldNames = Object.keys(rows[0]);
  const nFields = fieldNames.length;

  // Estimate buffer: header ~100 + rows * 120 bytes/row
  const est = 100 + rows.length * 120;
  const buf = Buffer.allocUnsafe(est);
  let off = 0;

  off = buf.writeUInt8(nFields, off);
  for (let fi = 0; fi < nFields; fi++) {
    const s = fieldNames[fi];
    const nlen = Buffer.byteLength(s, 'utf8');
    off = buf.writeUInt8(nlen, off);
    off += buf.write(s, off, nlen, 'utf8');
  }
  off = buf.writeUInt32LE(rows.length, off);

  for (let ri = 0; ri < rows.length; ri++) {
    const row = rows[ri];
    let fi = 0;
    if (nFields >= 1) {
      const v = row[fieldNames[0]];
      if (v === null || v === undefined) { off = buf.writeUInt8(0, off); }
      else if (typeof v === 'number') {
        if (Number.isInteger(v)) { if (v >= -2147483648 && v <= 2147483647) { off = buf.writeUInt8(INT32_TAG, off); off = buf.writeInt32LE(v, off); } else { off = buf.writeUInt8(INT64_TAG, off); off = buf.writeBigInt64LE(BigInt(v), off); } }
        else { off = buf.writeUInt8(FLOAT_TAG, off); off = buf.writeDoubleLE(v, off); }
      } else if (typeof v === 'string') {
        off = buf.writeUInt8(STR_TAG, off);
        const sl = Buffer.byteLength(v, 'utf8');
        off = buf.writeUInt32LE(sl, off);
        off += buf.write(v, off, sl, 'utf8');
      } else { off = buf.writeUInt8(BOOL_TAG, off); off = buf.writeUInt8(v ? 1 : 0, off); }
    }
    if (nFields >= 2) {
      const v = row[fieldNames[1]];
      if (v === null || v === undefined) { off = buf.writeUInt8(0, off); }
      else if (typeof v === 'number') {
        if (Number.isInteger(v)) { if (v >= -2147483648 && v <= 2147483647) { off = buf.writeUInt8(INT32_TAG, off); off = buf.writeInt32LE(v, off); } else { off = buf.writeUInt8(INT64_TAG, off); off = buf.writeBigInt64LE(BigInt(v), off); } }
        else { off = buf.writeUInt8(FLOAT_TAG, off); off = buf.writeDoubleLE(v, off); }
      } else if (typeof v === 'string') {
        off = buf.writeUInt8(STR_TAG, off);
        const sl = Buffer.byteLength(v, 'utf8');
        off = buf.writeUInt32LE(sl, off);
        off += buf.write(v, off, sl, 'utf8');
      } else { off = buf.writeUInt8(BOOL_TAG, off); off = buf.writeUInt8(v ? 1 : 0, off); }
    }
    if (nFields >= 3) {
      const v = row[fieldNames[2]];
      if (v === null || v === undefined) { off = buf.writeUInt8(0, off); }
      else if (typeof v === 'number') {
        if (Number.isInteger(v)) { if (v >= -2147483648 && v <= 2147483647) { off = buf.writeUInt8(INT32_TAG, off); off = buf.writeInt32LE(v, off); } else { off = buf.writeUInt8(INT64_TAG, off); off = buf.writeBigInt64LE(BigInt(v), off); } }
        else { off = buf.writeUInt8(FLOAT_TAG, off); off = buf.writeDoubleLE(v, off); }
      } else if (typeof v === 'string') {
        off = buf.writeUInt8(STR_TAG, off);
        const sl = Buffer.byteLength(v, 'utf8');
        off = buf.writeUInt32LE(sl, off);
        off += buf.write(v, off, sl, 'utf8');
      } else { off = buf.writeUInt8(BOOL_TAG, off); off = buf.writeUInt8(v ? 1 : 0, off); }
    }
    if (nFields >= 4) {
      const v = row[fieldNames[3]];
      if (v === null || v === undefined) { off = buf.writeUInt8(0, off); }
      else if (typeof v === 'number') {
        if (Number.isInteger(v)) { if (v >= -2147483648 && v <= 2147483647) { off = buf.writeUInt8(INT32_TAG, off); off = buf.writeInt32LE(v, off); } else { off = buf.writeUInt8(INT64_TAG, off); off = buf.writeBigInt64LE(BigInt(v), off); } }
        else { off = buf.writeUInt8(FLOAT_TAG, off); off = buf.writeDoubleLE(v, off); }
      } else if (typeof v === 'string') {
        off = buf.writeUInt8(STR_TAG, off);
        const sl = Buffer.byteLength(v, 'utf8');
        off = buf.writeUInt32LE(sl, off);
        off += buf.write(v, off, sl, 'utf8');
      } else { off = buf.writeUInt8(BOOL_TAG, off); off = buf.writeUInt8(v ? 1 : 0, off); }
    }
    if (nFields >= 5) {
      const v = row[fieldNames[4]];
      if (v === null || v === undefined) { off = buf.writeUInt8(0, off); }
      else if (typeof v === 'number') {
        if (Number.isInteger(v)) { if (v >= -2147483648 && v <= 2147483647) { off = buf.writeUInt8(INT32_TAG, off); off = buf.writeInt32LE(v, off); } else { off = buf.writeUInt8(INT64_TAG, off); off = buf.writeBigInt64LE(BigInt(v), off); } }
        else { off = buf.writeUInt8(FLOAT_TAG, off); off = buf.writeDoubleLE(v, off); }
      } else if (typeof v === 'string') {
        off = buf.writeUInt8(STR_TAG, off);
        const sl = Buffer.byteLength(v, 'utf8');
        off = buf.writeUInt32LE(sl, off);
        off += buf.write(v, off, sl, 'utf8');
      } else { off = buf.writeUInt8(BOOL_TAG, off); off = buf.writeUInt8(v ? 1 : 0, off); }
    }
    // fallback for >5 fields
    for (let fi = 5; fi < nFields; fi++) {
      const v = row[fieldNames[fi]];
      if (v === null || v === undefined) { off = buf.writeUInt8(0, off); }
      else if (typeof v === 'number') {
        if (Number.isInteger(v)) { if (v >= -2147483648 && v <= 2147483647) { off = buf.writeUInt8(INT32_TAG, off); off = buf.writeInt32LE(v, off); } else { off = buf.writeUInt8(INT64_TAG, off); off = buf.writeBigInt64LE(BigInt(v), off); } }
        else { off = buf.writeUInt8(FLOAT_TAG, off); off = buf.writeDoubleLE(v, off); }
      } else if (typeof v === 'string') {
        off = buf.writeUInt8(STR_TAG, off);
        const sl = Buffer.byteLength(v, 'utf8');
        off = buf.writeUInt32LE(sl, off);
        off += buf.write(v, off, sl, 'utf8');
      } else { off = buf.writeUInt8(BOOL_TAG, off); off = buf.writeUInt8(v ? 1 : 0, off); }
    }
  }

  return buf.subarray(0, off);
}

class JSQL {
  constructor(opts = {}) {
    this._flushThreshold = opts.flushThreshold || 5000;
    this._buffer = {};
    this._bufferSize = 0;
    this._tableNames = new Set();
    this._schemas = {};
    this._autoPlugins = opts.modules !== false;

    this._plugins = [];
    this._hooks = {
      beforeInsert: [], afterInsert: [],
      beforeUpdate: [], afterUpdate: [],
      beforeDelete: [], afterDelete: [],
      beforeFind: [], afterFind: [],
      beforeCreateTable: [], afterCreateTable: [],
      beforeDropTable: [], afterDropTable: [],
      beforeFlush: [], afterFlush: [],
      beforeCount: [], afterCount: [],
      onStart: [], onStop: []
    };
    this._eventListeners = [];
    if (this._autoPlugins) {
      const { ModuleManager } = require('./mod');
      new ModuleManager().applyTo(this);
    }
  }

  use(plugin) {
    if (typeof plugin === 'function') {
      plugin = { install: plugin };
    }
    if (plugin.hooks) {
      for (const [event, fn] of Object.entries(plugin.hooks)) {
        if (this._hooks[event]) {
          this._hooks[event].push(fn);
        }
      }
    }
    if (typeof plugin.install === 'function') {
      plugin.install(this, this._buildCtx(plugin));
    }
    if (typeof plugin.onEvent === 'function') {
      this._eventListeners.push(plugin.onEvent);
    }
    this._plugins.push(plugin);
    return this;
  }

  _buildCtx(plugin) {
    const self = this;
    return {
      name: plugin.name || 'anonymous',
      engine: this,
      plugin,
      on(hook, fn) { return self.on(hook, fn); },
      onEvent(fn) { return self.onEvent(fn); },
      emit(eventName, data) { self._emit(eventName, data); },
      tables() { return Array.from(self._tableNames); },
      hasTable(name) { return self._tableNames.has(name); },
      getTableSchema(name) { return self._schemas[name] || null; }
    };
  }

  on(event, fn) {
    if (this._hooks[event]) {
      this._hooks[event].push(fn);
    }
    return this;
  }

  onEvent(fn) {
    this._eventListeners.push(fn);
    return this;
  }

  _emit(eventName, data) {
    for (const fn of this._eventListeners) {
      try { fn(eventName, data); } catch (e) { /* ignore */ }
    }
  }

  _runHooks(hookName, args) {
    const hooks = this._hooks[hookName];
    if (!hooks || hooks.length === 0) return true;
    for (const fn of hooks) {
      const r = fn(...args);
      if (r === false) return false;
      if (r !== undefined && args.length > 0) {
        args[0] = r;
      }
    }
    return true;
  }

  async start() {
    this._runHooks('onStart', []);
    this._emit('start', {});
  }

  async _insertBatch(table, rows) {
    const r = safeJsonParse(wasmBindings.jsql_insert_json(table, JSON.stringify(rows)));
    if (r && r.error) throw new Error(r.error);
    return r;
  }

  async _flush() {
    if (!this._runHooks('beforeFlush', [])) return;
    for (const [table, rows] of Object.entries(this._buffer)) {
      if (rows.length === 0) continue;
      await this._insertBatch(table, rows);
    }
    this._buffer = {};
    this._bufferSize = 0;
    this._runHooks('afterFlush', []);
  }

  async flush() {
    await this._flush();
  }

  async insert(table, data) {
    const arr = Array.isArray(data) ? data : [data];
    if (!this._runHooks('beforeInsert', [table, arr])) return [];
    if (arr.length > 1) {
      await this._flush();
      let result;
      for (let i = 0; i < arr.length; i += this._flushThreshold) {
        const chunk = arr.slice(i, i + this._flushThreshold);
        const r = await this._insertBatch(table, chunk);
        if (r && r.error) throw new Error(r.error);
        if (!result) result = r;
      }
      this._emit('insert', { table, count: arr.length, ids: result });
      this._runHooks('afterInsert', [table, arr, result]);
      return result;
    }
    if (!this._buffer[table]) this._buffer[table] = [];
    this._buffer[table].push(arr[0]);
    this._bufferSize++;
    if (this._bufferSize >= this._flushThreshold) {
      await this._flush();
    }
  }

  async createTable(name, schema) {
    await this._flush();
    if (!this._runHooks('beforeCreateTable', [name, schema])) return null;
    const r = safeJsonParse(wasmBindings.jsql_create_table(name, JSON.stringify(schema)));
    if (r && r.ok === false) throw new Error(r.error || 'create table failed');
    this._tableNames.add(name);
    this._schemas[name] = schema;
    this._emit('createTable', { name, schema });
    this._runHooks('afterCreateTable', [name, schema]);
    return r;
  }

  async dropTable(name) {
    await this._flush();
    if (!this._runHooks('beforeDropTable', [name])) return null;
    const r = safeJsonParse(wasmBindings.jsql_drop_table(name));
    if (r && r.ok === false) throw new Error(r.error || 'drop table failed');
    this._tableNames.delete(name);
    delete this._schemas[name];
    this._emit('dropTable', { name });
    this._runHooks('afterDropTable', [name]);
    return r;
  }

  async findById(table, id) {
    await this._flush();
    if (!this._runHooks('beforeFind', [table, { id }])) return null;
    const r = safeJsonParse(wasmBindings.jsql_find_by_id(table, BigInt(id)));
    if (r && r.error) throw new Error(r.error);
    this._runHooks('afterFind', [table, { id }, r]);
    return r;
  }

  async find(table, filter, opts = {}) {
    await this._flush();
    if (!this._runHooks('beforeFind', [table, { filter, opts }])) return [];
    const filterStr = filter ? JSON.stringify(filter) : '';
    const { limit = 100, offset = 0 } = opts;
    const r = safeJsonParse(wasmBindings.jsql_find(table, filterStr, limit, offset));
    if (r && r.error) throw new Error(r.error);
    this._runHooks('afterFind', [table, { filter, opts }, r]);
    return r;
  }

  async count(table) {
    await this._flush();
    this._runHooks('beforeCount', [table]);
    const r = parseInt(wasmBindings.jsql_count(table), 10);
    const n = isNaN(r) ? 0 : r;
    this._runHooks('afterCount', [table, n]);
    return n;
  }

  async updateByIds(table, entries) {
    const pairs = entries.map(([id, data]) => [Number(id), data]);
    if (!this._runHooks('beforeUpdate', [table, pairs])) return;
    await this._flush();
    const r = safeJsonParse(wasmBindings.jsql_update_by_ids(table, JSON.stringify(pairs)));
    if (r && r.error) throw new Error(r.error);
    this._emit('update', { table, entries: pairs, result: r });
    this._runHooks('afterUpdate', [table, pairs, r]);
    return r;
  }

  async removeByIds(table, ids) {
    if (!this._runHooks('beforeDelete', [table, ids])) return;
    await this._flush();
    const r = safeJsonParse(wasmBindings.jsql_remove_by_ids(table, JSON.stringify(ids)));
    if (r && r.error) throw new Error(r.error);
    this._emit('delete', { table, ids, result: r });
    this._runHooks('afterDelete', [table, ids, r]);
    return r;
  }

  async findByIds(table, ids) {
    await this._flush();
    if (!this._runHooks('beforeFind', [table, { ids }])) return null;
    const r = safeJsonParse(wasmBindings.jsql_find_by_ids(table, JSON.stringify(ids)));
    if (r && r.error) throw new Error(r.error);
    this._runHooks('afterFind', [table, { ids }, r]);
    return r;
  }

  findByIdsRaw(table, ids) {
    return this.findByIds(table, ids);
  }

  async updateById(table, id, data) {
    if (!this._runHooks('beforeUpdate', [table, id, data])) return;
    await this._flush();
    const r = safeJsonParse(wasmBindings.jsql_update_by_id(table, BigInt(id), JSON.stringify(data)));
    if (r && r.ok === false) throw new Error(r.error || 'update failed');
    this._emit('update', { table, id, data });
    this._runHooks('afterUpdate', [table, id, data, r]);
    return r;
  }

  async removeById(table, id) {
    if (!this._runHooks('beforeDelete', [table, id])) return;
    await this._flush();
    const r = safeJsonParse(wasmBindings.jsql_remove_by_id(table, BigInt(id)));
    if (r && r.ok === false) throw new Error(r.error || 'remove failed');
    this._emit('delete', { table, id });
    this._runHooks('afterDelete', [table, id, r]);
    return r;
  }

  async stop() {
    await this._flush();
    this._runHooks('onStop', []);
    this._emit('stop', {});
  }
}

module.exports = { JSQL };
