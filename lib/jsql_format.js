const zlib = require('zlib');
const crypto = require('crypto');
const fs = require('fs');


const SZ = {
  SUPER: 4096,
  HEADER: 64,
  BLOCK: 4096,
  DATA: 4096 - 64
};

const BT = { FREE: 0, DATA: 1, IDX: 2 };

const TYPE = { NUL:0, BOL:1, I32:2, F64:3, STR:4, BUF:5, ARR:6, OBJ:7 };

function tag(v) {
  if (v===null||v===undefined) return TYPE.NUL;
  if (typeof v==='boolean') return TYPE.BOL;
  if (typeof v==='number') return Number.isInteger(v)?TYPE.I32:TYPE.F64;
  if (typeof v==='string') return TYPE.STR;
  if (v instanceof Buffer) return TYPE.BUF;
  return Array.isArray(v)?TYPE.ARR:TYPE.OBJ;
}

function enc(v) {
  const t = tag(v);
  switch (t) {
    case TYPE.NUL: return Buffer.from([t]);
    case TYPE.BOL: return Buffer.from([t, v?1:0]);
    case TYPE.I32: { const b=Buffer.alloc(5); b[0]=t; b.writeInt32LE(v,1); return b; }
    case TYPE.F64: { const b=Buffer.alloc(9); b[0]=t; b.writeDoubleLE(v,1); return b; }
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
    case TYPE.F64: return {v:buf.readDoubleLE(off),off:off+8};
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

function encRowFast(row, fieldEncoders) {
  // Estimate: 4(len) + sum of field values
  // fieldEncoders includes pre-encoded field names
  let size = 4;
  for (let i = 0; i < fieldEncoders.length; i++) {
    size += fieldEncoders[i].length;
    const v = row[Object.keys(row)[i] || '']; // fallback
  }
  // Just use the buffer approach
  const chunks = [Buffer.alloc(4)];
  for (let i = 0; i < fieldEncoders.length; i++) {
    chunks.push(fieldEncoders[i], enc(row[Object.keys(row)[i]]));
  }
  const data = Buffer.concat(chunks);
  data.writeUInt32LE(data.length - 4, 0);
  return data;
}

function writeEnc(buf, off, v) {
  if (v === null || v === undefined) { buf[off] = 0; return off + 1; }
  if (typeof v === 'boolean') { buf[off] = 1; buf[off+1] = v ? 1 : 0; return off + 2; }
  if (typeof v === 'number') {
    if (Number.isInteger(v)) { buf[off] = 2; buf.writeInt32LE(v, off+1); return off + 5; }
    buf[off] = 3; buf.writeDoubleLE(v, off+1); return off + 9;
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
function buildEncoders(schema) {
  return Object.keys(schema).filter(f => f !== '_softDelete').map(name => ({ name, nameEnc: enc(name) }));
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
    let firstBlock = 0, prevBlock = 0;

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

      const bid = this._alloc();
      if (chunk === 0) firstBlock = bid;
      if (prevBlock) buf.writeUInt32LE(bid, 52); // next block pointer
      buf.writeUInt32LE(prevBlock, 56); // prev block pointer

      // total entry count in first block
      if (chunk === 0) buf.writeUInt32LE(entries.length, 48);

      finalize(buf);
      fs.writeSync(this.fd, buf, 0, SZ.BLOCK, bid * SZ.BLOCK);
      prevBlock = bid;
    }

    const t = this.tables.get(name);
    if (t) t.pkBlock = firstBlock;
    return firstBlock;
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
      const encoders = buildEncoders(schema);
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
  }

  writeTable(name, schema, rows, pkField) {
    this.saveAll({ [name]: { schema, rows, pkField } });
  }

  readTableSync(name) {
    this._open();
    const t = this.tables.get(name);
    if (!t) return { schema: null, rows: [] };

    const rows = [];
    for (let bid = 1; bid < this.nBlocks; bid++) {
      const buf = Buffer.alloc(SZ.BLOCK);
      try { fs.readSync(this.fd, buf, 0, SZ.BLOCK, bid * SZ.BLOCK); } catch(e) { continue; }
      if (buf[36] !== BT.DATA || buf[37] !== t.tableId) continue;
      if (!verifyHash(buf)) continue;

      const compFlag = buf[48];
      const raw = compFlag
        ? zlib.gunzipSync(buf.slice(SZ.HEADER, SZ.HEADER + buf.readUInt32LE(44)))
        : buf.slice(SZ.HEADER, SZ.HEADER + buf.readUInt32LE(40));

      let off = 0;
      while (off + 4 <= raw.length) {
        const l = raw.readUInt32LE(off);
        if (l === 0 || off + 4 + l > raw.length) break;
        const r = decRow(raw, off);
        rows.push(r.row);
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
      if (e.hash === h) return this._readInBlock(e.block, e.off);
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
    oldRows.push(...rows);
    this.writeTable(name, schema, oldRows, pkField);
  }
}

module.exports = JSQLFormat;
