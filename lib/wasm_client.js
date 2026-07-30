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
  }

  async start() {}

  async _insertBatch(table, rows) {
    const r = safeJsonParse(wasmBindings.jsql_insert_json(table, JSON.stringify(rows)));
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
