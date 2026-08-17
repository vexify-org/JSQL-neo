const path = require('path');
const os = require('os');
const native = require(path.join(__dirname, '..', 'native', 'jsql-neo-native.node'));
const INT64_TAG = 1;
const FLOAT_TAG = 2;
const STR_TAG = 3;
const BOOL_TAG = 4;
const INT32_TAG = 5;

function safeParse(str, fallback) {
  if (typeof str !== 'string') return fallback;
  try { return JSON.parse(str); } catch (e) { return fallback; }
}

const NATIVE_TYPE_MAP = {
  text: 'string',
  varchar: 'string',
  double: 'float',
  number: 'float',
  numeric: 'float',
  decimal: 'float',
  date: 'string',
  timestamp: 'string',
  datetime: 'string',
  json: 'string',
  array: 'string',
  object: 'string',
  bool: 'boolean',
  bigint: 'string',
  int: 'integer',
};

function parseShorthandSchema(str) {
  const def = { type: str };
  const strip = (re) => {
    const next = def.type.replace(re, '').trim();
    def.type = next || def.type;
  };
  if (/\bprimary\s+key\b/i.test(def.type)) { def.primaryKey = true; strip(/\bprimary\s+key\b/gi); }
  if (/\bauto_?increment\b/i.test(def.type)) { def.autoIncrement = true; strip(/\bauto_?increment\b/gi); }
  if (/\bnot\s+null\b/i.test(def.type)) { def.required = true; strip(/\bnot\s+null\b/gi); }
  if (/\bunique\b/i.test(def.type)) { def.unique = true; strip(/\bunique\b/gi); }
  if (/\bdefault\s+(\S+)/i.test(def.type)) {
    const m = def.type.match(/\bdefault\s+(\S+)/i);
    def.default = m[1].replace(/^['"]|['"]$/g, '');
    strip(/\bdefault\s+\S+/gi);
  }
  return def;
}

function mapNativeSchema(schema) {
  const mapped = {};
  for (const [field, def] of Object.entries(schema || {})) {
    if (typeof def === 'string') {
      const parsed = parseShorthandSchema(def.toLowerCase().trim());
      if (parsed.type.length === 0) parsed.type = 'string';
      mapped[field] = { ...parsed, type: NATIVE_TYPE_MAP[parsed.type] || parsed.type };
    } else if (def && typeof def === 'object') {
      const t = (def.type || 'string').toLowerCase();
      const out = { ...def, type: NATIVE_TYPE_MAP[t] || t };
      if (out.primary_key !== undefined && out.primaryKey === undefined) { out.primaryKey = out.primary_key; delete out.primary_key; }
      if (out.auto_increment !== undefined && out.autoIncrement === undefined) { out.autoIncrement = out.auto_increment; delete out.auto_increment; }
      mapped[field] = out;
    } else {
      mapped[field] = { type: 'string' };
    }
  }
  return mapped;
}

function restoreRow(row, schema) {
  if (typeof row !== 'object' || row === null) return row;
  let src = row;
  if (row.fields && typeof row.fields === 'object' && row.fields !== null) {
    src = { ...row.fields };
    if (row.id !== undefined) {
      const pkCols = [];
      if (schema) {
        for (const [k, def] of Object.entries(schema)) {
          if (def && typeof def === 'object' && def.autoIncrement) continue;
          const isPk = typeof def === 'string'
            ? /\bprimary\s+key\b/i.test(def)
            : !!(def && (def.primaryKey || def.primary_key));
          if (isPk) pkCols.push(k);
        }
      } else if (src.id === undefined) {
        pkCols.push('id');
      }
      for (const c of pkCols) {
        const v = src[c];
        if (v === undefined || v === null || v === 0 || v === '' || v === false) src[c] = row.id;
      }
    }
    if (row.created_at !== undefined) src.created_at = row.created_at;
    if (row.updated_at !== undefined) src.updated_at = row.updated_at;
  }
  if (!schema) return src;
  const out = {};
  for (const [field, value] of Object.entries(src)) {
    const colDef = schema[field];
    let t = null;
    if (typeof colDef === 'string') t = colDef.toLowerCase();
    else if (colDef && typeof colDef === 'object' && colDef.type) t = String(colDef.type).toLowerCase();
    if (['json', 'array', 'object'].includes(t) && typeof value === 'string') {
      try { out[field] = JSON.parse(value); } catch (e) { out[field] = value; }
    } else if ((t === 'integer' || t === 'int' || t === 'bigint') && typeof value === 'string' && /^-?\d+$/.test(value)) {
      out[field] = Number(value);
    } else if ((t === 'float' || t === 'double' || t === 'number') && typeof value === 'string' && !Number.isNaN(Number(value))) {
      out[field] = Number(value);
    } else {
      out[field] = value;
    }
  }
  return out;
}

function _encodedFieldSize(v) {
  if (v === null || v === undefined) return 1;
  if (typeof v === 'number') {
    if (Number.isInteger(v)) return (v >= -2147483648 && v <= 2147483647) ? 1 + 4 : 1 + 8;
    return 1 + 8;
  }
  if (typeof v === 'boolean') return 1 + 1;
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  return 1 + 4 + Buffer.byteLength(s, 'utf8');
}

function encodeField(buf, off, v) {
  if (v === null || v === undefined) {
    buf.writeUInt8(0, off); return off + 1;
  }
  if (typeof v === 'number') {
    if (Number.isInteger(v)) {
      if (v >= -2147483648 && v <= 2147483647) {
        buf.writeUInt8(INT32_TAG, off); buf.writeInt32LE(v, off + 1); return off + 5;
      }
      buf.writeUInt8(INT64_TAG, off); buf.writeBigInt64LE(BigInt(v), off + 1); return off + 9;
    }
    buf.writeUInt8(FLOAT_TAG, off); buf.writeDoubleLE(v, off + 1); return off + 9;
  }
  if (typeof v === 'string') {
    const sl = Buffer.byteLength(v, 'utf8');
    buf.writeUInt8(STR_TAG, off);
    buf.writeUInt32LE(sl, off + 1);
    buf.write(v, off + 5, sl, 'utf8');
    return off + 5 + sl;
  }
  if (typeof v === 'boolean') {
    buf.writeUInt8(BOOL_TAG, off); buf.writeUInt8(v ? 1 : 0, off + 1); return off + 2;
  }
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  const sl = Buffer.byteLength(s, 'utf8');
  buf.writeUInt8(STR_TAG, off);
  buf.writeUInt32LE(sl, off + 1);
  buf.write(s, off + 5, sl, 'utf8');
  return off + 5 + sl;
}

function encodeBatch(rows) {
  if (rows.length === 0) return new Uint8Array(0);
  const fieldNames = Object.keys(rows[0]);
  const nFields = fieldNames.length;
  let size = 1;
  for (const s of fieldNames) size += 1 + Buffer.byteLength(s, 'utf8');
  size += 4;
  for (const row of rows) {
    for (let fi = 0; fi < nFields; fi++) size += _encodedFieldSize(row[fieldNames[fi]]);
  }
  const buf = Buffer.allocUnsafe(size);
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
    for (let fi = 0; fi < nFields; fi++) {
      off = encodeField(buf, off, row[fieldNames[fi]]);
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
    this._txId = undefined;
    this._autoPlugins = opts.modules !== false;

    // 持久化模式: 'memory' | 'hybrid' | 'disk'
    this._path = opts.path || null;
    this._mode = opts.mode || (this._path ? 'hybrid' : 'memory');
    this._memReserveMB = opts.memReserveMB !== undefined ? opts.memReserveMB : 512;
    this._flushInterval = opts.flushInterval !== undefined
      ? opts.flushInterval
      : (this._mode === 'disk' ? 50 : 200);
    this._evictInterval = opts.evictInterval !== undefined ? opts.evictInterval : 1000;
    this._diskFlushTimer = null;
    this._evictTimer = null;

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
    if (this._inHook) {
      // 防止插件 hook 内重入 native 调用导致 N-API 崩溃（段错误）
      throw new Error('ER_PLUGIN_REENTRY: plugin hook "' + hookName + '" re-entered native call; plugin must not call engine methods inside its own hook');
    }
    this._inHook = true;
    try {
      for (const fn of hooks) {
        const r = fn(...args);
        if (r === false) return false;
        if (r !== undefined && args.length > 0) {
          args[0] = r;
        }
      }
      return true;
    } finally {
      this._inHook = false;
    }
  }

  async start() {
    if (this._mode !== 'memory') {
      if (!this._path) throw new Error('hybrid/disk mode requires a directory path');
      let r;
      try {
        r = safeParse(native.jsqlOpen(this._path, this._mode));
      } catch (e) {
        throw new Error('failed to open native storage: ' + e.message);
      }
      if (r && r.ok === false) throw new Error(r.error || 'open storage failed');
      if (r && Array.isArray(r.tables)) {
        this._tableNames = new Set(r.tables);
        if (r.schemas) this._schemas = r.schemas;
      }
    } else {
      try {
        JSON.parse(native.jsqlOpen('', 'memory'));
      } catch (e) {
        throw new Error('failed to open native memory storage: ' + e.message);
      }
    }
    if (this._mode !== 'memory') {
      if (this._flushInterval > 0) {
        this._diskFlushTimer = setInterval(() => {
          try { native.jsqlFlushDirty(); } catch (e) { /* ignore */ }
        }, this._flushInterval);
        if (this._diskFlushTimer.unref) this._diskFlushTimer.unref();
      }
      this._evictTimer = setInterval(() => {
        try { this._checkMemory(); } catch (e) { /* ignore */ }
      }, this._evictInterval);
      if (this._evictTimer.unref) this._evictTimer.unref();
    }
    this._runHooks('onStart', []);
    this._emit('start', {});
  }

  _checkMemory() {
    const total = os.totalmem();
    if (!total) return;
    const budget = total - this._memReserveMB * 1024 * 1024;
    if (budget <= 0) return;
    if (process.memoryUsage().rss <= budget) return;
    for (let i = 0; i < 16; i++) {
      let r;
      try { r = JSON.parse(native.jsqlEvict()); } catch (e) { return; }
      if (r.ok === false || !r.evicted || r.remaining === 0) return;
      if (process.memoryUsage().rss <= budget) return;
    }
  }

  _pkOf(table) {
    const schema = this._schemas[table];
    if (!schema) return null;
    for (const [k, def] of Object.entries(schema)) {
      const isPk = (typeof def === 'string' && /\bprimary\s+key\b/i.test(def))
        || !!(def && typeof def === 'object' && (def.primaryKey || def.primary_key));
      if (isPk) return k;
    }
    return null;
  }

  _pkAutoIncrement(table) {
    const schema = this._schemas[table];
    const pk = this._pkOf(table);
    if (!pk || !schema) return false;
    const def = schema[pk];
    if (typeof def === 'string') return /\bauto_?increment\b/i.test(def);
    return !!(def && def.autoIncrement);
  }

  _coercePkId(table, id) {
    const schema = this._schemas[table];
    const pk = this._pkOf(table);
    if (!schema || !pk) return id;
    const def = schema[pk];
    let t = null;
    if (typeof def === 'string') t = def.toLowerCase();
    else if (def && typeof def === 'object' && def.type) t = String(def.type).toLowerCase();
    if (['integer', 'int', 'bigint'].includes(t)) return Number(id);
    return id;
  }

  _findRawById(table, id) {
    const pk = this._pkOf(table);
    if (pk) {
      const filter = {};
      filter[pk] = this._coercePkId(table, id);
      const r = safeParse(native.jsqlFind(table, JSON.stringify(filter), 1, 0));
      if (r && r.error) return r;
      return Array.isArray(r) && r.length > 0 ? r[0] : null;
    }
    return safeParse(native.jsqlFindById(table, Number(id)));
  }

  _seqIdByPk(table, id) {
    const pk = this._pkOf(table);
    if (pk) {
      const filter = {};
      filter[pk] = this._coercePkId(table, id);
      const r = safeParse(native.jsqlFind(table, JSON.stringify(filter), 1, 0));
      if (Array.isArray(r) && r.length > 0) return r[0].id;
      return null;
    }
    return Number(id);
  }

  async _insertBatch(table, rows) {
    const schema = this._schemas[table];
    if (schema) {
      rows = rows.map(row => {
        const out = {};
        for (const [k, v] of Object.entries(row)) {
          if (v instanceof Date) out[k] = v.toISOString();
          else out[k] = v;
        }
        return out;
      });
    }
    const bin = encodeBatch(rows);
    const r = safeParse(native.jsqlInsertBuf(table, bin));
    if (r && r.error) throw new Error(r.error);
    if (r && Array.isArray(r) && !this._pkAutoIncrement(table)) {
      const pk = this._pkOf(table);
      if (pk) {
        return r.map((seq, i) => {
          const row = rows[i];
          return (row && row[pk] !== undefined && row[pk] !== null) ? row[pk] : seq;
        });
      }
    }
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
      var r = safeParse(native.jsqlRemoveByIds(table, JSON.stringify(idsArr)));
      this._emit('delete', { table, ids: idsArr, result: r });
    }
    for (var table in update) {
      var entries = update[table];
      if (entries.length === 0) continue;
      var r = safeParse(native.jsqlUpdateByIds(table, JSON.stringify(entries)));
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
    this._flushOpsNow();
    if (this._mode !== 'memory') {
      try { native.jsqlFlushDirty(); } catch (e) { /* ignore */ }
    }
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
    const r = safeParse(native.jsqlCreateTable(name, JSON.stringify(mapNativeSchema(schema))));
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
    const r = safeParse(native.jsqlDropTable(name));
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
    const raw = this._findRawById(table, id);
    if (raw && raw.error) throw new Error(raw.error);
    this._runHooks('afterFind', [table, { id }, raw]);
    const schema = this._schemas[table];
    if (schema && raw && typeof raw === 'object') return restoreRow(raw, schema);
    return raw;
  }

  findByIds(table, ids) {
    this._flushOpsNow();
    if (!this._runHooks('beforeFind', [table, { ids }])) return null;
    let r;
    if (this._pkOf(table)) {
      r = ids.map(id => this._findRawById(table, id)).filter(x => x !== null && !(x && x.error));
    } else {
      r = safeParse(native.jsqlFindByIds(table, JSON.stringify(ids)));
    }
    if (r && r.error) throw new Error(r.error);
    this._runHooks('afterFind', [table, { ids }, r]);
    const schema = this._schemas[table];
    if (schema && Array.isArray(r)) return r.map(row => restoreRow(row, schema));
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
    const r = safeParse(native.jsqlFind(table, filterStr, limit, offset));
    if (r && r.error) throw new Error(r.error);
    this._runHooks('afterFind', [table, { filter, opts }, r]);
    const schema = this._schemas[table];
    if (schema && Array.isArray(r)) return r.map(row => restoreRow(row, schema));
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
    const pairs = [];
    for (const [id, data] of entries) {
      const seq = this._seqIdByPk(table, id);
      if (seq !== null) pairs.push([seq, data]);
    }
    if (!this._runHooks('beforeUpdate', [table, pairs])) return;
    if (!this._opBuffer.update[table]) this._opBuffer.update[table] = [];
    this._opBuffer.update[table].push(...pairs);
    this._scheduleOpFlush();
  }

  removeByIds(table, ids) {
    if (!this._runHooks('beforeDelete', [table, ids])) return;
    if (!this._opBuffer.remove[table]) this._opBuffer.remove[table] = new Set();
    for (const id of ids) {
      const seq = this._seqIdByPk(table, id);
      if (seq !== null) this._opBuffer.remove[table].add(seq);
    }
    this._scheduleOpFlush();
  }

  updateById(table, id, data) {
    if (!this._runHooks('beforeUpdate', [table, id, data])) return;
    const seq = this._seqIdByPk(table, id);
    if (seq === null) return;
    if (!this._opBuffer.update[table]) this._opBuffer.update[table] = [];
    this._opBuffer.update[table].push([seq, data]);
    this._scheduleOpFlush();
  }

  removeById(table, id) {
    if (!this._runHooks('beforeDelete', [table, id])) return;
    const seq = this._seqIdByPk(table, id);
    if (seq === null) return;
    if (!this._opBuffer.remove[table]) this._opBuffer.remove[table] = new Set();
    this._opBuffer.remove[table].add(seq);
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
    if (this._diskFlushTimer) { clearInterval(this._diskFlushTimer); this._diskFlushTimer = null; }
    if (this._evictTimer) { clearInterval(this._evictTimer); this._evictTimer = null; }
    if (this._mode !== 'memory') {
      try { JSON.parse(native.jsqlClose()); } catch (e) { /* ignore */ }
    }
    this._runHooks('onStop', []);
    this._emit('stop', {});
  }

  async beginTx() {
    this._flushOpsNow();
    const r = safeParse(native.jsqlBeginTx());
    if (r && r.ok === false) throw new Error(r.error || 'begin transaction failed');
    this._txId = r.txId;
    return r.txId;
  }

  async beginTransaction() {
    return this.beginTx();
  }

  async commit() {
    if (this._txId === undefined) return true;
    const r = await this.commitTx(this._txId);
    this._txId = undefined;
    return r;
  }

  async rollback() {
    if (this._txId === undefined) return true;
    const r = await this.rollbackTx(this._txId);
    this._txId = undefined;
    return r;
  }

  async commitTx(txId) {
    const r = safeParse(native.jsqlCommitTx(String(txId)));
    if (r && r.ok === false) throw new Error(r.error || 'commit transaction failed');
    return true;
  }

  async rollbackTx(txId) {
    const r = safeParse(native.jsqlRollbackTx(String(txId)));
    if (r && r.ok === false) throw new Error(r.error || 'rollback transaction failed');
    return true;
  }
}

module.exports = { JSQL };