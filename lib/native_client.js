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

  return new Uint8Array(buf.buffer, 0, off);
}

class JSQL {
  constructor(opts = {}) {
    this._flushThreshold = opts.flushThreshold || 5000;
    this._buffer = {};
    this._bufferSize = 0;
    this._opBuffer = { remove: {}, update: {} };
    this._opTimer = null;
    this._opFlushInterval = opts.opFlushInterval || 50;
  }

  async start() {}

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
      native.jsqlRemoveByIds(table, JSON.stringify(Array.from(ids)));
    }
    for (var table in update) {
      var entries = update[table];
      if (entries.length === 0) continue;
      native.jsqlUpdateByIds(table, JSON.stringify(entries));
    }
    this._opBuffer = { remove: {}, update: {} };
  }

  async _flush() {
    this._flushOpsNow();
    for (const [table, rows] of Object.entries(this._buffer)) {
      if (rows.length === 0) continue;
      await this._insertBatch(table, rows);
    }
    this._buffer = {};
    this._bufferSize = 0;
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
    const r = JSON.parse(native.jsqlCreateTable(name, JSON.stringify(schema)));
    if (r && r.ok === false) throw new Error(r.error || 'create table failed');
    return r;
  }

  async dropTable(name) {
    await this._flush();
    const r = JSON.parse(native.jsqlDropTable(name));
    if (r && r.ok === false) throw new Error(r.error || 'drop table failed');
    return r;
  }

  findById(table, id) {
    this._flushOpsNow();
    const raw = JSON.parse(native.jsqlFindById(table, Number(id)));
    if (raw && raw.error) throw new Error(raw.error);
    return raw;
  }

  findByIds(table, ids) {
    this._flushOpsNow();
    const resultStr = native.jsqlFindByIds(table, JSON.stringify(ids));
    const r = JSON.parse(resultStr);
    if (r && r.error) throw new Error(r.error);
    return r;
  }

  findByIdsRaw(table, ids) {
    return this.findByIds(table, ids);
  }

  async find(table, filter, opts = {}) {
    this._flushOpsNow();
    const filterStr = filter ? JSON.stringify(filter) : '';
    const { limit = 100, offset = 0 } = opts;
    const r = JSON.parse(native.jsqlFind(table, filterStr, limit, offset));
    if (r && r.error) throw new Error(r.error);
    return r;
  }

  async count(table) {
    this._flushOpsNow();
    const r = parseInt(native.jsqlCount(table), 10);
    return isNaN(r) ? 0 : r;
  }

  updateById(table, id, data) {
    if (!this._opBuffer.update[table]) this._opBuffer.update[table] = [];
    this._opBuffer.update[table].push([Number(id), data]);
    this._scheduleOpFlush();
  }

  removeById(table, id) {
    if (!this._opBuffer.remove[table]) this._opBuffer.remove[table] = new Set();
    this._opBuffer.remove[table].add(Number(id));
    this._scheduleOpFlush();
  }

  async stop() {
    this._flushOpsNow();
    await this._flush();
  }
}

module.exports = { JSQL };