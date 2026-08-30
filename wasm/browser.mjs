import {
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
  jsql_begin_tx,
  jsql_commit_tx,
  jsql_rollback_tx,
} from './browser_bg.mjs';
import init from './browser_bg.mjs';

function safeJsonParse(str) {
  try { return JSON.parse(str); } catch { return str; }
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

function parseSchemaString(str) {
  const out = {};
  for (const seg of str.split(',')) {
    const trimmed = seg.trim();
    if (!trimmed) continue;
    const parts = trimmed.split(/\s+/);
    const name = parts.shift();
    const def = parseShorthandSchema(parts.join(' ').toLowerCase().trim());
    if (def.type.length === 0) def.type = 'string';
    out[name] = def;
  }
  return out;
}

function mapNativeSchema(schema) {
  if (typeof schema === 'string') schema = parseSchemaString(schema);
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

const INT64_TAG = 1;
const FLOAT_TAG = 2;
const STR_TAG = 3;
const BOOL_TAG = 4;
const INT32_TAG = 5;


export class JSQL {
  constructor(opts = {}) {
    this._flushThreshold = opts.flushThreshold || 5000;
    this._buffer = {};
    this._bufferSize = 0;
    this._tableNames = new Set();
    this._schemas = {};
    this._txId = undefined;
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
    if (this._autoPlugins && typeof globalThis.__jsqlLoadModules === 'function') {
      globalThis.__jsqlLoadModules(this);
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
    await init();
    jsql_reset();
    this._runHooks('onStart', []);
    this._emit('start', {});
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
      const r = safeJsonParse(jsql_find(table, JSON.stringify(filter), 1, 0));
      if (r && r.error) return r;
      return Array.isArray(r) && r.length > 0 ? r[0] : null;
    }
    return safeJsonParse(jsql_find_by_id(table, BigInt(id)));
  }

  _seqIdByPk(table, id) {
    const pk = this._pkOf(table);
    if (pk) {
      const filter = {};
      filter[pk] = this._coercePkId(table, id);
      const r = safeJsonParse(jsql_find(table, JSON.stringify(filter), 1, 0));
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
          const def = schema[k];
          let t = null;
          if (typeof def === 'string') t = def.toLowerCase();
          else if (def && typeof def === 'object' && def.type) t = String(def.type).toLowerCase();
          if (v !== null && v !== undefined && ['json', 'array', 'object'].includes(t) && typeof v !== 'string') {
            out[k] = JSON.stringify(v);
          } else if (v instanceof Date) {
            out[k] = v.toISOString();
          } else {
            out[k] = v;
          }
        }
        return out;
      });
    }
    const r = safeJsonParse(jsql_insert_json(table, JSON.stringify(rows)));
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

  async _flush() {
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
    const flushed = await this._flush();
    return flushed && flushed[table] ? flushed[table] : null;
  }

  async insertMany(table, data) {
    return this.insert(table, data);
  }

  async createTable(name, schema) {
    await this._flush();
    if (!this._runHooks('beforeCreateTable', [name, schema])) return null;
    const r = safeJsonParse(jsql_create_table(name, JSON.stringify(mapNativeSchema(schema))));
    if (r && r.ok === false) throw new Error(r.error || 'create table failed');
    this._tableNames.add(name);
    this._schemas[name] = typeof schema === 'string' ? mapNativeSchema(schema) : schema;
    this._emit('createTable', { name, schema });
    this._runHooks('afterCreateTable', [name, schema]);
    return r;
  }

  async dropTable(name) {
    await this._flush();
    if (!this._runHooks('beforeDropTable', [name])) return null;
    const r = safeJsonParse(jsql_drop_table(name));
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
    const r = this._findRawById(table, id);
    if (r && r.error) throw new Error(r.error);
    this._runHooks('afterFind', [table, { id }, r]);
    const schema = this._schemas[table];
    if (schema && r && typeof r === 'object') return restoreRow(r, schema);
    return r;
  }

  async find(table, filter, opts = {}) {
    await this._flush();
    if (!this._runHooks('beforeFind', [table, { filter, opts }])) return [];
    const filterStr = filter ? JSON.stringify(filter) : '';
    const { limit = 100, offset = 0 } = opts;
    const r = safeJsonParse(jsql_find(table, filterStr, limit, offset));
    if (r && r.error) throw new Error(r.error);
    this._runHooks('afterFind', [table, { filter, opts }, r]);
    const schema = this._schemas[table];
    if (schema && Array.isArray(r)) return r.map(row => restoreRow(row, schema));
    return r;
  }

  async count(table) {
    await this._flush();
    this._runHooks('beforeCount', [table]);
    const r = parseInt(jsql_count(table), 10);
    const n = isNaN(r) ? 0 : r;
    this._runHooks('afterCount', [table, n]);
    return n;
  }

  async updateByIds(table, entries) {
    const pairs = [];
    for (const [id, data] of entries) {
      const seq = this._seqIdByPk(table, id);
      if (seq !== null) pairs.push([seq, data]);
    }
    if (!this._runHooks('beforeUpdate', [table, pairs])) return;
    await this._flush();
    const r = safeJsonParse(jsql_update_by_ids(table, JSON.stringify(pairs)));
    if (r && r.error) throw new Error(r.error);
    this._emit('update', { table, entries: pairs, result: r });
    this._runHooks('afterUpdate', [table, pairs, r]);
    return r;
  }

  async removeByIds(table, ids) {
    if (!this._runHooks('beforeDelete', [table, ids])) return;
    await this._flush();
    const seqs = ids.map(id => this._seqIdByPk(table, id)).filter(s => s !== null);
    const r = safeJsonParse(jsql_remove_by_ids(table, JSON.stringify(seqs)));
    if (r && r.error) throw new Error(r.error);
    this._emit('delete', { table, ids: seqs, result: r });
    this._runHooks('afterDelete', [table, ids, r]);
    return r;
  }

  async findByIds(table, ids) {
    await this._flush();
    if (!this._runHooks('beforeFind', [table, { ids }])) return null;
    let r;
    if (this._pkOf(table)) {
      r = ids.map(id => this._findRawById(table, id)).filter(x => x !== null && !(x && x.error));
    } else {
      r = safeJsonParse(jsql_find_by_ids(table, JSON.stringify(ids)));
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

  async updateById(table, id, data) {
    if (!this._runHooks('beforeUpdate', [table, id, data])) return;
    await this._flush();
    const seq = this._seqIdByPk(table, id);
    if (seq === null) return null;
    const r = safeJsonParse(jsql_update_by_id(table, BigInt(seq), JSON.stringify(data)));
    if (r && r.ok === false) throw new Error(r.error || 'update failed');
    this._emit('update', { table, id, data });
    this._runHooks('afterUpdate', [table, id, data, r]);
    return r;
  }

  async removeById(table, id) {
    if (!this._runHooks('beforeDelete', [table, id])) return;
    await this._flush();
    const seq = this._seqIdByPk(table, id);
    if (seq === null) return null;
    const r = safeJsonParse(jsql_remove_by_id(table, BigInt(seq)));
    if (r && r.ok === false) throw new Error(r.error || 'remove failed');
    this._emit('delete', { table, id });
    this._runHooks('afterDelete', [table, id, r]);
    return r;
  }

  async beginTx() {
    await this._flush();
    const r = safeJsonParse(jsql_begin_tx());
    if (r && r.ok === false) throw new Error(r.error || 'begin transaction failed');
    this._txId = r.txId;
    return r.txId;
  }

  async commitTx(txId) {
    const r = safeJsonParse(jsql_commit_tx(String(txId)));
    if (r && r.ok === false) throw new Error(r.error || 'commit transaction failed');
    return true;
  }

  async rollbackTx(txId) {
    const r = safeJsonParse(jsql_rollback_tx(String(txId)));
    if (r && r.ok === false) throw new Error(r.error || 'rollback transaction failed');
    return true;
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

  async hasTable(name) {
    return this._tableNames.has(name);
  }

  async getTables() {
    return Array.from(this._tableNames);
  }

  async getTableSchema(name) {
    return this._schemas[name] || null;
  }

  async stop() {
    await this._flush();
    this._runHooks('onStop', []);
    this._emit('stop', {});
  }
}

