const path = require('path');
const wasmBindings = require(path.join(__dirname, '..', 'wasm', 'jsql_neo_wasm.js'));

function safeJsonParse(str) {
  try { return JSON.parse(str); } catch { return str; }
}

class JSQL {
  constructor(opts = {}) {
    this._flushThreshold = opts.flushThreshold || 2000;
    this._buffer = {};
    this._bufferSize = 0;
  }

  async start() {}

  async _insertBatch(table, rows) {
    const r = safeJsonParse(wasmBindings.jsql_insert(table, JSON.stringify(rows)));
    if (r && r.error) throw new Error(r.error);
    return r;
  }

  async _flush() {
    for (const [table, rows] of Object.entries(this._buffer)) {
      if (rows.length === 0) continue;
      await this._insertBatch(table, rows);
    }
    this._buffer = {};
    this._bufferSize = 0;
  }

  async flush() {
    await this._flush();
  }

  async insert(table, data) {
    const arr = Array.isArray(data) ? data : [data];
    if (arr.length > 1) {
      await this._flush();
      let result;
      for (let i = 0; i < arr.length; i += this._flushThreshold) {
        const chunk = arr.slice(i, i + this._flushThreshold);
        const r = await this._insertBatch(table, chunk);
        if (r && r.error) throw new Error(r.error);
        if (!result) result = r;
      }
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
    const r = safeJsonParse(wasmBindings.jsql_create_table(name, JSON.stringify(schema)));
    if (r && r.ok === false) throw new Error(r.error || 'create table failed');
    return r;
  }

  async dropTable(name) {
    await this._flush();
    const r = safeJsonParse(wasmBindings.jsql_drop_table(name));
    if (r && r.ok === false) throw new Error(r.error || 'drop table failed');
    return r;
  }

  async findById(table, id) {
    await this._flush();
    const r = safeJsonParse(wasmBindings.jsql_find_by_id(table, BigInt(id)));
    if (r && r.error) throw new Error(r.error);
    return r;
  }

  async find(table, filter, opts = {}) {
    await this._flush();
    const filterStr = filter ? JSON.stringify(filter) : '';
    const { limit = 100, offset = 0 } = opts;
    const r = safeJsonParse(wasmBindings.jsql_find(table, filterStr, limit, offset));
    if (r && r.error) throw new Error(r.error);
    return r;
  }

  async count(table) {
    await this._flush();
    const r = parseInt(wasmBindings.jsql_count(table), 10);
    return isNaN(r) ? 0 : r;
  }

  async updateById(table, id, data) {
    await this._flush();
    const r = safeJsonParse(wasmBindings.jsql_update_by_id(table, BigInt(id), JSON.stringify(data)));
    if (r && r.ok === false) throw new Error(r.error || 'update failed');
    return r;
  }

  async removeById(table, id) {
    await this._flush();
    const r = safeJsonParse(wasmBindings.jsql_remove_by_id(table, BigInt(id)));
    if (r && r.ok === false) throw new Error(r.error || 'remove failed');
    return r;
  }

  async stop() {
    await this._flush();
  }
}

module.exports = { JSQL };
