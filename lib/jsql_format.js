const zlib = require('zlib');
const crypto = require('crypto');
const fs = require('fs');
const { ObjectId } = require('./objectid');


const SZ = {
  SUPER: 4096,
  HEADER: 64,
  BLOCK: 4096,
  DATA: 4096 - 64
};

const BT = { FREE: 0, DATA: 1, IDX: 2 };

const TYPE = { NUL:0, BOL:1, I32:2, F64:3, STR:4, BUF:5, ARR:6, OBJ:7, I64:8, DATE:9, OID:10 };

function tag(v) {
  if (v===null||v===undefined) return TYPE.NUL;
  if (typeof v==='boolean') return TYPE.BOL;
  if (typeof v==='number') {
    if (Number.isInteger(v)) {
      // P2-29-fix: 超出 int32 范围的整数用 I64 存储
      if (v >= -0x80000000 && v <= 0x7FFFFFFF) return TYPE.I32;
      return TYPE.I64;
    }
    return TYPE.F64;
  }
  if (typeof v==='bigint') return TYPE.I64;
  // Date 必须在通用对象分支之前识别：Object.keys(date) 为空，否则会存成 {}
  if (v instanceof Date) return TYPE.DATE;
  if (typeof v==='string') return TYPE.STR;
  if (v instanceof Buffer) return TYPE.BUF;
  // ObjectId 必须在通用对象分支之前识别，否则会退化成普通对象
  if (v instanceof ObjectId) return TYPE.OID;
  return Array.isArray(v)?TYPE.ARR:TYPE.OBJ;
}

function enc(v) {
  const t = tag(v);
  switch (t) {
    case TYPE.NUL: return Buffer.from([t]);
    case TYPE.BOL: return Buffer.from([t, v?1:0]);
    case TYPE.I32: { const b=Buffer.alloc(5); b[0]=t; b.writeInt32LE(v,1); return b; }
    case TYPE.I64: { const b=Buffer.alloc(9); b[0]=t; b.writeBigInt64LE(BigInt(v),1); return b; }
    case TYPE.F64: { const b=Buffer.alloc(9); b[0]=t; b.writeDoubleLE(v,1); return b; }
    case TYPE.DATE: { const b=Buffer.alloc(9); b[0]=t; b.writeBigInt64LE(BigInt(v.getTime()),1); return b; }
    case TYPE.OID: { const b=Buffer.alloc(13); b[0]=t; v.bytes.copy(b,1); return b; }
    case TYPE.STR: { const s=Buffer.from(v,'utf8'); const b=Buffer.alloc(5+s.length); b[0]=t; b.writeUInt32LE(s.length,1); s.copy(b,5); return b; }
    case TYPE.BUF: { const b=Buffer.alloc(5+v.length); b[0]=t; b.writeUInt32LE(v.length,1); v.copy(b,5); return b; }
    case TYPE.ARR: { const p=[Buffer.from([t]),enc(v.length)]; for(const i of v) p.push(enc(i)); return Buffer.concat(p); }
    case TYPE.OBJ: { const k=Object.keys(v); const p=[Buffer.from([t]),enc(k.length)]; for(const f of k){p.push(enc(f));p.push(enc(v[f]));} return Buffer.concat(p); }
  }
}

function dec(buf, off) {
  const t = buf[off++];
  switch (t) {
    case TYPE.NUL: return {v:null,off};
    case TYPE.BOL: return {v:buf[off]!==0,off:off+1};
    case TYPE.I32: return {v:buf.readInt32LE(off),off:off+4};
    case TYPE.I64: {
      // 安全范围内的值仍还原成 number（兼容旧数据/行为）；超出范围返回 BigInt，避免精度丢失（Issue #38）
      const b = buf.readBigInt64LE(off);
      const safe = b >= BigInt(Number.MIN_SAFE_INTEGER) && b <= BigInt(Number.MAX_SAFE_INTEGER);
      return {v: safe ? Number(b) : b, off:off+8};
    }
    case TYPE.F64: return {v:buf.readDoubleLE(off),off:off+8};
    case TYPE.DATE: return {v:new Date(Number(buf.readBigInt64LE(off))),off:off+8};
    case TYPE.OID: return {v:new ObjectId(buf.subarray(off,off+12)),off:off+12};
    case TYPE.STR: { const l=buf.readUInt32LE(off);off+=4; return {v:buf.toString('utf8',off,off+l),off:off+l}; }
    case TYPE.BUF: { const l=buf.readUInt32LE(off);off+=4; return {v:Buffer.from(buf.subarray(off,off+l)),off:off+l}; }
    case TYPE.ARR: { let r=dec(buf,off);off=r.off; const l=r.v,a=new Array(l); for(let i=0;i<l;i++){r=dec(buf,off);a[i]=r.v;off=r.off;} return {v:a,off}; }
    case TYPE.OBJ: { let r=dec(buf,off);off=r.off; const l=r.v,o={}; for(let i=0;i<l;i++){r=dec(buf,off);const k=r.v;off=r.off;r=dec(buf,off);o[k]=r.v;off=r.off;} return {v:o,off}; }
    default: throw new Error('bad type '+t);
  }
}

// Pre-encoded field names for faster row encoding
function buildFieldEncoders(schema) {
  const fields = Object.keys(schema).filter(f => f !== '_softDelete');
  return fields.map(f => enc(f));
}

function writeEnc(buf, off, v) {
  if (v === null || v === undefined) { buf[off] = 0; return off + 1; }
  if (typeof v === 'boolean') { buf[off] = 1; buf[off+1] = v ? 1 : 0; return off + 2; }
  if (typeof v === 'number') {
    if (Number.isInteger(v)) {
      // P2-29-fix: 超出 int32 范围的整数用 I64 存储
      if (v >= -0x80000000 && v <= 0x7FFFFFFF) { buf[off] = 2; buf.writeInt32LE(v, off+1); return off + 5; }
      buf[off] = 8; buf.writeBigInt64LE(BigInt(v), off+1); return off + 9;
    }
    buf[off] = 3; buf.writeDoubleLE(v, off+1); return off + 9;
  }
  if (typeof v === 'bigint') {
    // Issue #38：64 位整数精确保存，读回时再决定还原成 number 还是 BigInt
    buf[off] = 8; buf.writeBigInt64LE(v, off+1); return off + 9;
  }
  if (typeof v === 'string') {
    buf[off] = 4;
    const encoded = Buffer.from(v, 'utf8');
    buf.writeUInt32LE(encoded.length, off+1);
    encoded.copy(buf, off+5);
    return off + 5 + encoded.length;
  }
  const e = enc(v);
  e.copy(buf, off);
  return off + e.length;
}

function encRowInPlace(row, encoders, scratch, offStart) {
  let off = offStart + 4;
  for (let i = 0; i < encoders.length; i++) {
    encoders[i].nameEnc.copy(scratch, off); off += encoders[i].nameEnc.length;
    off = writeEnc(scratch, off, row[encoders[i].name]);
  }
  scratch.writeUInt32LE(off - offStart - 4, offStart);
  return off;
}

// Build reusable field encoders from schema
// 无 schema 的表（如 Mongo collection 以 {} 建表）：字段从行数据本身取并集。
// 否则 0 个编码器会把每一行刷成 4 字节空桩，重载时一行都读不回来。
// shortcut: 某行缺的字段重载后变 null（不区分「缺字段」和「值为 null」），需要严格区分时再升级
function buildEncoders(schema, rows) {
  const skip = f => f !== '_softDelete'; // _softDelete 是 schema 配置键，不会是数据字段
  const schemaFields = Object.keys(schema || {}).filter(skip);
  if (schemaFields.length > 0) {
    return schemaFields.map(name => ({ name, nameEnc: enc(name) }));
  }
  const seen = new Set();
  for (const row of rows || []) {
    if (!row) continue;
    for (const f of Object.keys(row)) if (skip(f)) seen.add(f);
  }
  return [...seen].map(name => ({ name, nameEnc: enc(name) }));
}

const encRow = encRowInPlace;

function decRow(buf, off) {
  const l = buf.readUInt32LE(off); off += 4;
  const end = off + l;
  const row = {};
  while (off < end) {
    const r1 = dec(buf, off); const f = r1.v; off = r1.off;
    const r2 = dec(buf, off); row[f] = r2.v; off = r2.off;
  }
  return { row, off };
}

function hashPK(val) {
  let h = 0;
  const s = String(val);
  for (let i = 0; i < s.length; i++) h = (Math.imul(h,31) + s.charCodeAt(i)) | 0;
  return h >>> 0;
}

function mkHeader(type, seq, tableId) {
  const h = Buffer.alloc(SZ.HEADER);
  h.writeUInt32LE(seq, 32);
  h[36] = type;
  h[37] = tableId || 0;
  return h;
}

function finalize(buf) {
  const h = crypto.createHash('sha256').update(buf.subarray(32)).digest();
  h.copy(buf, 0);
}

function verifyHash(buf) {
  const s = buf.slice(0, 32);
  const c = crypto.createHash('sha256').update(buf.subarray(32)).digest();
  return s.equals(c);
}

class JSQLFormat {
  constructor(path) {
    this.path = path;
    this.fd = null;
    this.tables = new Map();
    this.pkIdx = new Map();
    this.nBlocks = 0;
    this.dirty = false;
    this.open = false;
    this._nextTableId = 1;
  }

  _open() {
    if (this.fd) return;
    this.open = true;
    if (fs.existsSync(this.path)) {
      this.fd = fs.openSync(this.path, 'r+');
      this._load();
    } else {
      this.fd = fs.openSync(this.path, 'w+');
      this._init();
    }
  }

  _close() {
    if (!this.fd) return;
    if (this.dirty) this._flush();
    fs.closeSync(this.fd);
    this.fd = null;
    this.open = false;
  }

  _init() {
    const sb = Buffer.alloc(SZ.SUPER);
    sb.write('JSQL', 0, 'utf8');
    // block count = superblock only
    this.nBlocks = 1;
    fs.writeSync(this.fd, sb, 0, SZ.SUPER, 0);
    fs.ftruncateSync(this.fd, SZ.SUPER);
  }

  _load() {
    const sb = Buffer.alloc(SZ.SUPER);
    fs.readSync(this.fd, sb, 0, SZ.SUPER, 0);
    const magic = sb.toString('utf8', 0, 4);
    if (magic !== 'JSQL') throw new Error('not a .jsql file');

    const tCount = sb.readUInt16LE(4);
    let off = 6;
    for (let i = 0; i < tCount; i++) {
      const nLen = sb[off]; off += 1;
      const name = sb.toString('utf8', off, off + nLen); off += nLen;
      const sLen = sb.readUInt32LE(off); off += 4;
      const rCnt = sb.readUInt32LE(off); off += 4;
      const pkB = sb.readUInt32LE(off); off += 4;
      const dB = sb.readUInt32LE(off); off += 4;
      const tableId = sb.readUInt16LE(off); off += 2;
      const schema = JSON.parse(sb.toString('utf8', off, off + sLen)); off += sLen;
      this.tables.set(name, { schema, rowCount: rCnt, pkBlock: pkB, dataBlock: dB, tableId });
      this.pkIdx.set(name, this._loadIdx(pkB));
      if ((this.tables.get(name).tableId || 0) >= this._nextTableId)
        this._nextTableId = (this.tables.get(name).tableId || 0) + 1;
    }

    this.nBlocks = Math.max(1, Math.ceil(fs.fstatSync(this.fd).size / SZ.BLOCK));
  }

  _saveIdx(name) {
    const entries = this.pkIdx.get(name) || [];
    const maxPerBlock = Math.floor((SZ.DATA - 4) / 12);
    if (entries.length === 0) {
      const t0 = this.tables.get(name);
      if (t0) t0.pkBlock = 0;
      return 0;
    }

    // 先为每个分块分配物理块号，再回填 next/prev 指针，最后统一写盘。
    // 旧实现边分配边写：next 指针写进了当前块自身，上一个块永远指向 0，
    // 导致索引超过一个块（335 项）时后续行在重开后不可见。
    const chunks = [];
    const ids = [];
    for (let chunk = 0; chunk < entries.length; chunk += maxPerBlock) {
      const chunkEnd = Math.min(chunk + maxPerBlock, entries.length);
      const buf = Buffer.alloc(SZ.BLOCK);
      mkHeader(BT.IDX, chunk).copy(buf);
      let off = SZ.HEADER;

      const cnt = chunkEnd - chunk;
      buf.writeUInt32LE(cnt, off); off += 4;
      for (let i = chunk; i < chunkEnd; i++) {
        const e = entries[i];
        buf.writeUInt32LE(e.hash, off); off += 4;
        buf.writeUInt32LE(e.block, off); off += 4;
        buf.writeUInt32LE(e.off, off); off += 4;
      }
      chunks.push(buf);
      ids.push(this._alloc());
    }

    for (let c = 0; c < chunks.length; c++) {
      const buf = chunks[c];
      buf.writeUInt32LE(c + 1 < ids.length ? ids[c + 1] : 0, 52); // next block
      buf.writeUInt32LE(c > 0 ? ids[c - 1] : 0, 56);              // prev block
      if (c === 0) buf.writeUInt32LE(entries.length, 48);         // 总条目数
      finalize(buf);
      fs.writeSync(this.fd, buf, 0, SZ.BLOCK, ids[c] * SZ.BLOCK);
    }

    const t = this.tables.get(name);
    if (t) t.pkBlock = ids[0];
    return ids[0];
  }

  _loadIdx(blockId) {
    if (blockId < 1) return [];
    const all = [];
    let bid = blockId;
    while (bid) {
      const buf = Buffer.alloc(SZ.BLOCK);
      fs.readSync(this.fd, buf, 0, SZ.BLOCK, bid * SZ.BLOCK);
      if (!verifyHash(buf)) throw new Error('corrupt idx block ' + bid);
      let off = SZ.HEADER;
      const cnt = buf.readUInt32LE(off); off += 4;
      for (let i = 0; i < cnt; i++) {
        const hash = buf.readUInt32LE(off); off += 4;
        const block = buf.readUInt32LE(off); off += 4;
        const dataOff = buf.readUInt32LE(off); off += 4;
        all.push({ hash, block, off: dataOff });
      }
      bid = buf.readUInt32LE(52);
    }
    return all;
  }

  _alloc() { return this.nBlocks++; }

  _flush() {
    for (const name of this.tables.keys()) this._saveIdx(name);
    this._saveSuper();
    this.dirty = false;
  }

  _saveSuper() {
    const sb = Buffer.alloc(SZ.SUPER);
    sb.write('JSQL', 0, 'utf8');
    sb.writeUInt16LE(this.tables.size, 4);
    let off = 6;
    for (const [name, t] of this.tables) {
      const nB = Buffer.from(name, 'utf8');
      sb[off] = nB.length; off += 1;
      nB.copy(sb, off); off += nB.length;
      const sStr = JSON.stringify(t.schema);
      sb.writeUInt32LE(sStr.length, off); off += 4;
      sb.writeUInt32LE(t.rowCount, off); off += 4;
      sb.writeUInt32LE(t.pkBlock||0, off); off += 4;
      sb.writeUInt32LE(t.dataBlock||0, off); off += 4;
      sb.writeUInt16LE(t.tableId || 0, off); off += 2;
      Buffer.from(sStr, 'utf8').copy(sb, off); off += sStr.length;
    }
    fs.writeSync(this.fd, sb, 0, SZ.SUPER, 0);
    fs.fsyncSync(this.fd);
  }

  _reset() {
    this.nBlocks = 1;
    this._nextTableId = 1;
    this.tables.clear();
    this.pkIdx.clear();
  }

  _truncateToSuper() {
    fs.ftruncateSync(this.fd, SZ.SUPER);
    const sb = Buffer.alloc(SZ.SUPER); sb.write('JSQL', 0, 'utf8');
    fs.writeSync(this.fd, sb, 0, SZ.SUPER, 0);
    this.nBlocks = 1;
  }

  saveAll(allTables) {
    this._open();
    this._reset();

    const pending = [];

    for (const [name, info] of Object.entries(allTables)) {
      const { schema, rows, pkField } = info;
      if (!rows || rows.length === 0) continue;

      const tableId = this._nextTableId++;
      this.tables.set(name, { schema, rowCount:0, pkBlock:0, dataBlock:0, tableId });

      const pkEntries = [];
      const rawBlocks = [];
      const blockIds = [];
      let curBlock = this._alloc();
      let buf = Buffer.alloc(SZ.BLOCK);
      let bp = SZ.HEADER;
      mkHeader(BT.DATA, curBlock, tableId).copy(buf);

      // Pre-build field encoders once per table
      const encoders = buildEncoders(schema, rows);
      // Scratch buffer for row encoding (max row size fits in one block)
      const scratch = Buffer.allocUnsafe(SZ.DATA);

      // Phase 1: encode every row into memory first. Any error thrown here
      // (oversized row, bad value) aborts before the file is touched.
      for (const row of rows) {
        const end = encRowInPlace(row, encoders, scratch, 0);
        if (end > SZ.DATA) {
          throw new Error(
            `row in table '${name}' is too large (${end} bytes > max row size ${SZ.DATA} bytes); ` +
            'split the value or reduce field sizes before saving'
          );
        }
        if (bp + end > SZ.BLOCK) {
          const raw = Buffer.from(buf.subarray(SZ.HEADER, bp));
          rawBlocks.push(raw);
          blockIds.push(curBlock);
          buf.writeUInt32LE(bp - SZ.HEADER, 40);

          curBlock = this._alloc();
          buf = Buffer.alloc(SZ.BLOCK);
          bp = SZ.HEADER;
          mkHeader(BT.DATA, curBlock, tableId).copy(buf);
        }

        const startOff = bp;
        scratch.copy(buf, bp, 0, end);
        bp += end;

        if (pkField && row[pkField] !== undefined) {
          pkEntries.push({ hash: hashPK(row[pkField]), block: curBlock, off: startOff - SZ.HEADER });
        }
      }

      if (bp > SZ.HEADER) {
        const raw = Buffer.from(buf.subarray(SZ.HEADER, bp));
        rawBlocks.push(raw);
        blockIds.push(curBlock);
        buf.writeUInt32LE(bp - SZ.HEADER, 40);
      }

      pkEntries.sort((a, b) => a.hash - b.hash);
      pending.push({ name, tableId, rawBlocks, blockIds, pkEntries });
    }

    // Phase 2: all rows encoded successfully — now write to disk.
    for (const p of pending) {
      // Compress and write blocks
      for (let i = 0; i < p.rawBlocks.length; i++) {
        const bid = p.blockIds[i];
        const compBuf = zlib.gzipSync(p.rawBlocks[i], { level: 1 });
        const block = Buffer.alloc(SZ.BLOCK);
        mkHeader(BT.DATA, bid, p.tableId).copy(block);
        block.writeUInt32LE(p.rawBlocks[i].length, 40);
        block[48] = 1;
        block.writeUInt32LE(compBuf.length, 44);
        compBuf.copy(block, SZ.HEADER);
        finalize(block);
        fs.writeSync(this.fd, block, 0, SZ.BLOCK, bid * SZ.BLOCK);
      }

      const t = this.tables.get(p.name);
      t.rowCount = p.pkEntries.length;
      t.dataBlock = p.blockIds.length > 0 ? p.blockIds[p.blockIds.length - 1] : 0;

      this.pkIdx.set(p.name, p.pkEntries);
      this._saveIdx(p.name);
    }

    this._saveSuper();
    this.dirty = false;
    // 整表重写后回收文件尾部的历史空洞块，否则反复「增量追加 + 压缩」会让
    // 文件只增不减。
    fs.ftruncateSync(this.fd, this.nBlocks * SZ.BLOCK);
  }

  writeTable(name, schema, rows, pkField) {
    this.saveAll({ [name]: { schema, rows, pkField } });
  }

  // ---- 行级增量写入（hybrid/disk 一行一刷盘） ----

  _hashRange(entries, hash) {
    let lo = 0, hi = entries.length;
    while (lo < hi) {
      const m = (lo + hi) >>> 1;
      if (entries[m].hash < hash) lo = m + 1; else hi = m;
    }
    return lo;
  }

  /** 在索引中定位某个主键值的条目，返回下标；未找到返回 -1。 */
  _findEntry(entries, pkValue, pkField) {
    const h = hashPK(pkValue);
    for (let i = this._hashRange(entries, h); i < entries.length && entries[i].hash === h; i++) {
      const row = this._readInBlock(entries[i].block, entries[i].off);
      if (!pkField || row[pkField] === pkValue) return i;
    }
    return -1;
  }

  _setEntry(entries, entry, pkValue, pkField) {
    const idx = this._findEntry(entries, pkValue, pkField);
    if (idx >= 0) { entries[idx] = entry; return; }
    entries.splice(this._hashRange(entries, entry.hash), 0, entry);
  }

  _delEntry(entries, pkValue, pkField) {
    const idx = this._findEntry(entries, pkValue, pkField);
    if (idx >= 0) entries.splice(idx, 1);
  }

  /**
   * 只把变更行追加为独立数据块并更新主键索引，不重写整表。
   * upserts 为最新行（同主键旧索引项被就地替换），deletes 为主键值数组。
   * 旧数据块保留为空洞，由调用方按阈值触发全量重写回收。
   */
  writeRows(name, schema, upserts, deletes, pkField) {
    this._open();
    const t = this.tables.get(name);
    if (!t) {
      if (upserts && upserts.length > 0) this.writeTable(name, schema, upserts, pkField);
      return [];
    }
    if (schema) t.schema = schema;

    const entries = this.pkIdx.get(name) || [];
    this.pkIdx.set(name, entries);
    const encoders = buildEncoders(t.schema);
    const scratch = Buffer.allocUnsafe(SZ.DATA);
    const written = [];

    for (const row of upserts || []) {
      const end = encRowInPlace(row, encoders, scratch, 0);
      if (end > SZ.DATA) {
        throw new Error(
          `row in table '${name}' is too large (${end} bytes > max row size ${SZ.DATA} bytes); ` +
          'split the value or reduce field sizes before saving'
        );
      }
      const bid = this._alloc();
      const buf = Buffer.alloc(SZ.BLOCK);
      mkHeader(BT.DATA, bid, t.tableId).copy(buf);
      const comp = zlib.gzipSync(Buffer.from(scratch.subarray(0, end)), { level: 1 });
      buf.writeUInt32LE(end, 40);
      buf[48] = 1;
      buf.writeUInt32LE(comp.length, 44);
      comp.copy(buf, SZ.HEADER);
      finalize(buf);
      fs.writeSync(this.fd, buf, 0, SZ.BLOCK, bid * SZ.BLOCK);
      t.dataBlock = bid;
      written.push({ block: bid, off: 0 });

      const pkValue = pkField ? row[pkField] : undefined;
      if (pkValue !== undefined && pkValue !== null) {
        this._setEntry(entries, { hash: hashPK(pkValue), block: bid, off: 0 }, pkValue, pkField);
      }
    }

    for (const pkValue of deletes || []) {
      if (pkValue !== undefined && pkValue !== null) this._delEntry(entries, pkValue, pkField);
    }

    t.rowCount = entries.length;
    this._saveIdx(name);
    this._saveSuper();
    return written;
  }

  /**
   * 扫描某张表，返回所有「有效行」的物理位置（按 readTableSync 的同一顺序）。
   * 只走长度前缀，不 decode 行内容，因此内存占用与行大小无关 —— 供行级
   * 懒加载缓存建立 {block, off} 引用使用。
   */
  scanLocators(name) {
    this._open();
    const t = this.tables.get(name);
    if (!t) return [];
    const entries = this.pkIdx.get(name) || [];
    const pkField = Object.keys(t.schema || {})
      .find(f => t.schema[f] && t.schema[f].primaryKey) || null;
    const live = entries.length > 0
      ? new Set(entries.map(e => `${e.block}:${e.off}`))
      : null;

    const locs = [];
    for (let bid = 1; bid < this.nBlocks; bid++) {
      const buf = Buffer.alloc(SZ.BLOCK);
      try { fs.readSync(this.fd, buf, 0, SZ.BLOCK, bid * SZ.BLOCK); } catch (e) { continue; }
      if (buf[36] !== BT.DATA || buf[37] !== t.tableId) continue;
      if (!verifyHash(buf)) {
        throw new Error(`[JSQLFormat] Table '${name}': data block ${bid} failed integrity check`);
      }
      const compFlag = buf[48];
      const raw = compFlag
        ? zlib.gunzipSync(buf.slice(SZ.HEADER, SZ.HEADER + buf.readUInt32LE(44)))
        : buf.slice(SZ.HEADER, SZ.HEADER + buf.readUInt32LE(40));

      let off = 0;
      while (off + 4 <= raw.length) {
        const l = raw.readUInt32LE(off);
        if (l === 0 || off + 4 + l > raw.length) break;
        if (!live || live.has(`${bid}:${off}`)) {
          locs.push({ block: bid, off });
          off += 4 + l;
          continue;
        }
        // 不在索引里：可能是旧版本空洞，也可能是没有主键值的行。只有后者要保留。
        const r = decRow(raw, off);
        if (pkField && (r.row[pkField] === undefined || r.row[pkField] === null)) {
          locs.push({ block: bid, off });
        }
        off = r.off;
      }
    }
    return locs;
  }

  /** 按物理位置读取一行（行级懒加载的最小读单位）。 */
  readRowAt(block, off) {
    this._open();
    return this._readInBlock(block, off);
  }

  readTableSync(name) {
    this._open();
    const t = this.tables.get(name);
    if (!t) return { schema: null, rows: [] };

    // 行级增量写入会留下旧版本的「空洞」块；有主键索引时只保留索引指向的
    // 最新行，保证更新/删除后不会读出重复或已删的行。
    const entries = this.pkIdx.get(name) || [];
    const pkField = Object.keys(t.schema || {}).find(f => t.schema[f] && t.schema[f].primaryKey) || null;
    const live = entries.length > 0
      ? new Set(entries.map(e => `${e.block}:${e.off}`))
      : null;

    const rows = [];
    for (let bid = 1; bid < this.nBlocks; bid++) {
      const buf = Buffer.alloc(SZ.BLOCK);
      try { fs.readSync(this.fd, buf, 0, SZ.BLOCK, bid * SZ.BLOCK); } catch(e) {
        console.warn(`[JSQLFormat] Table '${name}': failed to read block ${bid}: ${e.message}`);
        continue;
      }
      if (buf[36] !== BT.DATA || buf[37] !== t.tableId) continue;
      if (!verifyHash(buf)) {
        throw new Error(`[JSQLFormat] Table '${name}': data block ${bid} failed integrity check`);
      }

      const compFlag = buf[48];
      const raw = compFlag
        ? zlib.gunzipSync(buf.slice(SZ.HEADER, SZ.HEADER + buf.readUInt32LE(44)))
        : buf.slice(SZ.HEADER, SZ.HEADER + buf.readUInt32LE(40));

      let off = 0;
      while (off + 4 <= raw.length) {
        const l = raw.readUInt32LE(off);
        if (l === 0 || off + 4 + l > raw.length) break;
        const r = decRow(raw, off);
        // 只有索引指向的最新行有效；无主键值的行无法进索引，保留以免丢数据
        if (!live || live.has(`${bid}:${off}`)
            || (pkField && (r.row[pkField] === undefined || r.row[pkField] === null))) {
          rows.push(r.row);
        }
        off = r.off;
      }
    }
    return { schema: t.schema, rows };
  }

  readTable(name) {
    return this.readTableSync(name);
  }

  findRow(name, pkValue) {
    const entries = this.pkIdx.get(name);
    if (!entries || entries.length === 0) return null;
    const h = hashPK(pkValue);
    let lo = 0, hi = entries.length - 1;
    while (lo <= hi) {
      const m = (lo + hi) >>> 1;
      const e = entries[m];
      if (e.hash === h) {
        // 命中相同 hash，但可能是哈希冲突，需要验证实际 pk 值
        const row = this._readInBlock(e.block, e.off);
        const t = this.tables.get(name);
        const pkField = t && t.pkField;
        if (pkField && row[pkField] === pkValue) return row;
        // 哈希冲突：线性探测相邻项
        let found = null;
        // 向左探测
        for (let i = m - 1; i >= 0 && entries[i].hash === h; i--) {
          const r = this._readInBlock(entries[i].block, entries[i].off);
          if (r[pkField] === pkValue) { found = r; break; }
        }
        // 向右探测
        if (!found) {
          for (let i = m + 1; i < entries.length && entries[i].hash === h; i++) {
            const r = this._readInBlock(entries[i].block, entries[i].off);
            if (r[pkField] === pkValue) { found = r; break; }
          }
        }
        return found;
      }
      if (e.hash < h) lo = m + 1;
      else hi = m - 1;
    }
    return null;
  }

  _readInBlock(blockId, off) {
    const buf = Buffer.alloc(SZ.BLOCK);
    fs.readSync(this.fd, buf, 0, SZ.BLOCK, blockId * SZ.BLOCK);
    const compFlag = buf[48];
    const compSz = buf.readUInt32LE(44);
    const dataSz = buf.readUInt32LE(40);
    let raw;
    if (compFlag) {
      raw = zlib.gunzipSync(buf.slice(SZ.HEADER, SZ.HEADER + compSz));
    } else {
      raw = buf.slice(SZ.HEADER, SZ.HEADER + dataSz);
    }
    const r = decRow(raw, off);
    return r.row;
  }

  appendRows(name, schema, rows, pkField) {
    this._open();
    const t = this.tables.get(name);
    if (!t) { this.writeTable(name, schema, rows, pkField); return; }
    t.schema = schema;

    const { rows: oldRows } = this.readTable(name);
    for (const __e of rows) oldRows.push(__e);
    this.writeTable(name, schema, oldRows, pkField);
  }
}

module.exports = JSQLFormat;
