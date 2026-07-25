const { Worker, MessageChannel, receiveMessageOnPort } = require('worker_threads');
const path = require('path');
const os = require('os');
const zlib = require('zlib');

const POOL_SIZE = Math.max(2, Math.min(os.cpus().length - 1, 8));

let pool = null;

class SyncCompressionPool {
  constructor(size) {
    this.size = size;
    this.workers = [];
    this.ports = [];
    this.nextId = 1;
    const wp = path.join(__dirname, 'compress_worker.js');

    for (let i = 0; i < size; i++) {
      const { port1, port2 } = new MessageChannel();
      const worker = new Worker(wp);
      worker.postMessage({ type: 'init', port: port2 }, [port2]);
      worker.unref();
      this.workers.push({ worker, port: port1 });
      this.ports.push(port1);
    }
  }

  _getIdle() {
    for (const p of this.ports) {
      if (!p._busy) return p;
    }
    return null;
  }

  _copyBuffer(data) {
    const src = Buffer.isBuffer(data) ? data : Buffer.from(data);
    const ab = new ArrayBuffer(src.length);
    const dst = Buffer.from(ab);
    src.copy(dst);
    return dst;
  }

  _sendMsg(port, msg, data) {
    const copy = this._copyBuffer(data);
    port._busy = true;
    port.postMessage({ ...msg, data: copy.buffer, level: msg.level || 1 }, [copy.buffer]);
  }

  _waitResult(port) {
    let r = null;
    while (!r) { r = receiveMessageOnPort(port); }
    port._busy = false;
    if (r.message.error) throw new Error(r.message.error);
    return r.message;
  }

  compressSync(data, level = 1) {
    const port = this._getIdle();
    if (!port) {
      return { result: zlib.gzipSync(Buffer.isBuffer(data) ? data : Buffer.from(data), { level }).buffer };
    }
    const id = this.nextId++;
    this._sendMsg(port, { type: 'compress', id, level }, data);
    return this._waitResult(port);
  }

  decompressSync(data) {
    const port = this._getIdle();
    if (!port) {
      return { result: zlib.gunzipSync(Buffer.isBuffer(data) ? data : Buffer.from(data)).buffer };
    }
    const id = this.nextId++;
    this._sendMsg(port, { type: 'decompress', id }, data);
    return this._waitResult(port);
  }

  compressBatchSync(blocks, level = 1) {
    const n = blocks.length;
    const results = new Array(n);
    let submitted = 0;
    let completed = 0;

    const trySubmit = () => {
      while (submitted < n) {
        const port = this._getIdle();
        if (!port) break;
        const idx = submitted++;
        port._idx = idx;
        port._busy = true;
        const copy = this._copyBuffer(blocks[idx]);
        port.postMessage({ type: 'compress', id: this.nextId++, data: copy.buffer, level }, [copy.buffer]);
      }
    };

    trySubmit();
    while (completed < n) {
      for (const port of this.ports) {
        if (!port._busy) continue;
        const msg = receiveMessageOnPort(port);
        if (msg) {
          results[port._idx] = msg.message;
          port._busy = false;
          completed++;
          trySubmit();
        }
      }
    }
    return results;
  }

  terminate() {
    for (const { worker } of this.workers) worker.terminate();
    pool = null;
  }
}

function getPool() {
  if (!pool) pool = new SyncCompressionPool(POOL_SIZE);
  return pool;
}

module.exports = { getPool, SyncCompressionPool };
