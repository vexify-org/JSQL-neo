const path = require('path');
const native = require(path.join(__dirname, '..', 'native', 'jsql-neo-native.node'));
const INT64_TAG = 1;
const FLOAT_TAG = 2;
const STR_TAG = 3;
const BOOL_TAG = 4;
const INT32_TAG = 5;

function encodeBatch(rows) {
  if (rows.length === 0) return new Uint8Array(0);
  const fieldNames = Object.keys(rows[0]);
  const nFields = fieldNames.length;
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

  return buf.slice(0, off);
}

class JSQL {
  constructor(opts = {}) {
    this._flushThreshold = opts.flushThreshold || 5000;
    this._buffer = {};
    this._bufferSize = 0;
    this._opBuffer = { remove: {}, update: {} };
    this._opTimer = null;
    this._opFlushInterval = opts.opFlushInterval || 50;
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
    const bin = encodeBatch(rows);
    const r = JSON.parse(native.jsqlInsertBuf(table, bin));
    if (r && r.error) throw new Error(r.error);
    return r;
  }

  _scheduleOpFlush() {
    if (this._opTimer) return;
    this._opTimer = setTimeout(() => {
      this._opTimer = null;
      this._flushOps();
    }, this._opFlushInterval);
  }

  _flushOps() {
    var remove = this._opBuffer.remove;
    var update = this._opBuffer.update;
    for (var table in remove) {
      var ids = remove[table];
      if (ids.size === 0) continue;
      var idsArr = Array.from(ids);
      var r = JSON.parse(native.jsqlRemoveByIds(table, JSON.stringify(idsArr)));
      this._emit('delete', { table, ids: idsArr, result: r });
    }
    for (var table in update) {
      var entries = update[table];
      if (entries.length === 0) continue;
      var r = JSON.parse(native.jsqlUpdateByIds(table, JSON.stringify(entries)));
      this._emit('update', { table, entries, result: r });
    }
    this._opBuffer = { remove: {}, update: {} };
  }

  async _flush() {
    this._flushOpsNow();
    if (!this._runHooks('beforeFlush', [])) return null;
    const flushed = {};
    for (const [table, rows] of Object.entries(this._buffer)) {
      if (rows.length === 0) continue;
      const r = await this._insertBatch(table, rows);
      flushed[table] = r;
    }
    this._buffer = {};
    this._bufferSize = 0;
    this._runHooks('afterFlush', []);
    return flushed;
  }

  _flushOpsNow() {
    if (this._opTimer) {
      clearTimeout(this._opTimer);
      this._opTimer = null;
    }
    this._flushOps();
  }

  async flush() {
    await this._flush();
  }

  async insert(table, data) {
    const arr = Array.isArray(data) ? data : [data];
    var filtered = arr;
    if (!this._runHooks('beforeInsert', [table, filtered])) return [];
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
      this._runHooks('afterInsert', [table, filtered, result]);
      return result;
    }
    if (!this._buffer[table]) this._buffer[table] = [];
    this._buffer[table].push(arr[0]);
    this._bufferSize++;
    const flushed = await this._flush();
    return flushed && flushed[table] ? flushed[table] : null;
  }

  async createTable(name, schema) {
    await this._flush();
    if (!this._runHooks('beforeCreateTable', [name, schema])) return null;
    const r = JSON.parse(native.jsqlCreateTable(name, JSON.stringify(schema)));
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
    const r = JSON.parse(native.jsqlDropTable(name));
    if (r && r.ok === false) throw new Error(r.error || 'drop table failed');
    this._tableNames.delete(name);
    delete this._schemas[name];
    this._emit('dropTable', { name });
    this._runHooks('afterDropTable', [name]);
    return r;
  }

  findById(table, id) {
    this._flushOpsNow();
    if (!this._runHooks('beforeFind', [table, { id }])) return null;
    const raw = JSON.parse(native.jsqlFindById(table, Number(id)));
    if (raw && raw.error) throw new Error(raw.error);
    this._runHooks('afterFind', [table, { id }, raw]);
    return raw;
  }

  findByIds(table, ids) {
    this._flushOpsNow();
    if (!this._runHooks('beforeFind', [table, { ids }])) return null;
    const resultStr = native.jsqlFindByIds(table, JSON.stringify(ids));
    const r = JSON.parse(resultStr);
    if (r && r.error) throw new Error(r.error);
    this._runHooks('afterFind', [table, { ids }, r]);
    return r;
  }

  findByIdsRaw(table, ids) {
    return this.findByIds(table, ids);
  }

  async find(table, filter, opts = {}) {
    this._flushOpsNow();
    if (!this._runHooks('beforeFind', [table, { filter, opts }])) return [];
    const filterStr = filter ? JSON.stringify(filter) : '';
    const { limit = 100, offset = 0 } = opts;
    const r = JSON.parse(native.jsqlFind(table, filterStr, limit, offset));
    if (r && r.error) throw new Error(r.error);
    this._runHooks('afterFind', [table, { filter, opts }, r]);
    return r;
  }

  async count(table) {
    this._flushOpsNow();
    this._runHooks('beforeCount', [table]);
    const r = parseInt(native.jsqlCount(table), 10);
    const n = isNaN(r) ? 0 : r;
    this._runHooks('afterCount', [table, n]);
    return n;
  }

  updateByIds(table, entries) {
    const pairs = entries.map(([id, data]) => [Number(id), data]);
    if (!this._runHooks('beforeUpdate', [table, pairs])) return;
    if (!this._opBuffer.update[table]) this._opBuffer.update[table] = [];
    this._opBuffer.update[table].push(...pairs);
    this._scheduleOpFlush();
  }

  removeByIds(table, ids) {
    if (!this._runHooks('beforeDelete', [table, ids])) return;
    if (!this._opBuffer.remove[table]) this._opBuffer.remove[table] = new Set();
    for (const id of ids) this._opBuffer.remove[table].add(Number(id));
    this._scheduleOpFlush();
  }

  updateById(table, id, data) {
    if (!this._runHooks('beforeUpdate', [table, id, data])) return;
    if (!this._opBuffer.update[table]) this._opBuffer.update[table] = [];
    this._opBuffer.update[table].push([Number(id), data]);
    this._scheduleOpFlush();
  }

  removeById(table, id) {
    if (!this._runHooks('beforeDelete', [table, id])) return;
    if (!this._opBuffer.remove[table]) this._opBuffer.remove[table] = new Set();
    this._opBuffer.remove[table].add(Number(id));
    this._scheduleOpFlush();
  }

  hasTable(name) {
    return this._tableNames.has(name);
  }

  getTables() {
    return Array.from(this._tableNames);
  }

  getTableSchema(name) {
    return this._schemas[name] || null;
  }

  async stop() {
    this._flushOpsNow();
    await this._flush();
    this._runHooks('onStop', []);
    this._emit('stop', {});
  }
}

module.exports = { JSQL };