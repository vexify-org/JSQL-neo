const { parentPort } = require('worker_threads');
const zlib = require('zlib');

let commPort = null;

parentPort.on('message', (msg) => {
  if (msg.type === 'init' && msg.port) {
    commPort = msg.port;
    commPort.on('message', (task) => {
      try {
        if (task.type === 'compress') {
          const buf = Buffer.from(task.data);
          const result = zlib.gzipSync(buf, { level: task.level || 1 });
          const ab = new ArrayBuffer(result.length);
          const view = new Uint8Array(ab);
          for (let i = 0; i < result.length; i++) view[i] = result[i];
          commPort.postMessage({ id: task.id, result: ab, len: result.length }, [ab]);
        } else if (task.type === 'decompress') {
          const buf = Buffer.from(task.data);
          const result = zlib.gunzipSync(buf);
          const ab = new ArrayBuffer(result.length);
          const view = new Uint8Array(ab);
          for (let i = 0; i < result.length; i++) view[i] = result[i];
          commPort.postMessage({ id: task.id, result: ab, len: result.length }, [ab]);
        }
      } catch (e) {
        commPort.postMessage({ id: task.id, error: e.message });
      }
    });
    commPort.unref();
  }
});
