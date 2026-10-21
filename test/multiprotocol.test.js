/**
 * 单端口多协议回归测试
 *
 * 校验 README 里「One Port」这条承诺：
 *   1. 同一个 TCP 端口按首包嗅探到 MySQL / PostgreSQL / MongoDB / Redis
 *   2. 静默连接（MySQL 客户端等服务器先握手）按 idleProtocol 兜底
 *   3. `jsql serve` 默认启动多协议服务器，`--mysql-only` 保留单协议行为
 *
 * 全部使用原始 socket，不依赖 mysql2 / pg / mongodb / ioredis。
 */
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');
const { createMultiServer, sniffProtocol } = require('../lib/multiserver');
const { bsonDocument } = require('../lib/mongo_server');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('[OK]   ' + name); }
  else { fail++; console.log('[FAIL] ' + name + (extra !== undefined ? ' → ' + JSON.stringify(extra) : '')); }
}

function connect(port) {
  return new Promise((resolve, reject) => {
    const s = net.connect(port, '127.0.0.1', () => resolve(s));
    s.on('error', reject);
  });
}

function readSome(socket, ms = 1500) {
  return new Promise((resolve) => {
    let buf = Buffer.alloc(0);
    const done = () => { clearTimeout(t); socket.removeListener('data', onData); resolve(buf); };
    const onData = (c) => { buf = Buffer.concat([buf, c]); };
    const t = setTimeout(done, ms);
    socket.on('data', onData);
  });
}

function mongoHello() {
  const payload = bsonDocument({ hello: 1, helloOk: true, $db: 'admin' });
  const head = Buffer.alloc(16);
  head.writeInt32LE(16 + 4 + 1 + payload.length, 0);
  head.writeInt32LE(1, 4);
  head.writeInt32LE(0, 8);
  head.writeInt32LE(2013, 12);
  return Buffer.concat([head, Buffer.alloc(4), Buffer.from([0]), payload]);
}

async function main() {
  console.log('--- 首包嗅探 ---');
  ok('PG StartupMessage 判为 pg', sniffProtocol(Buffer.from([0, 0, 0, 60, 0, 3, 0, 0])) === 'pg');
  ok('MySQL 握手版本判为 mysql', sniffProtocol(Buffer.from([0x0a, 0x38, 0x2e, 0x30])) === 'mysql');
  ok('RESP 数组判为 redis', sniffProtocol(Buffer.from('*1\r\n$4\r\nPING\r\n')) === 'redis');
  {
    const m = mongoHello();
    ok('Mongo OP_MSG 判为 mongo', sniffProtocol(m) === 'mongo');
  }

  console.log('\n--- 同一端口四协议 ---');
  const srv = createMultiServer({ port: 0, host: '127.0.0.1', noAuth: true });
  await new Promise((r) => srv.listen(r));
  const port = srv.address.port;
  ok('监听成功', port > 0, port);

  {
    const s = await connect(port);
    const buf = await readSome(s);
    s.destroy();
    ok('MySQL 静默连接收到握手包', buf.length > 5 && buf[4] === 0x0a, buf.slice(0, 8).toString('hex'));
    ok('握手包含服务器版本', buf.includes(Buffer.from('jsql-neo')));
  }

  {
    const s = await connect(port);
    const ssl = Buffer.alloc(8);
    ssl.writeInt32BE(8, 0);
    ssl.writeInt32BE(80877103, 4); // SSLRequest
    s.write(ssl);
    const buf = await readSome(s, 800);
    s.destroy();
    ok('PostgreSQL SSLRequest 被拒绝并回 N', buf.toString('utf8') === 'N', buf.toString('utf8'));
  }

  {
    const s = await connect(port);
    s.write(Buffer.from('PING\r\n'));
    const buf = await readSome(s, 800);
    s.destroy();
    ok('Redis PING 返回 +PONG', buf.toString('utf8').startsWith('+PONG'), buf.toString('utf8'));
  }

  {
    const s = await connect(port);
    s.write(mongoHello());
    const buf = await readSome(s, 1500);
    s.destroy();
    ok('Mongo hello 返回 OP_MSG', buf.length >= 16 && buf.readInt32LE(12) === 2013);
    ok('Mongo hello ok:1', buf.includes(Buffer.from('isWritablePrimary')));
  }

  console.log('\n--- 共享同一份 SQL 引擎 ---');
  {
    // 直接用 MT 服务器内部的引擎实例验证：Mongo 与 SQL 走同一个 Database
    const eng = await srv.mysql._getEngine('shared');
    const sameAsPg = (await srv.pg._getEngine('shared')) === eng;
    const sameAsMongo = (await srv.mongo._getEngine('shared')) === eng;
    ok('MySQL/PG/Mongo 取到同一个引擎', sameAsPg && sameAsMongo);
  }

  await new Promise((r) => srv.close(r));

  console.log('\n--- idleProtocol 兜底 ---');
  {
    const redisIdle = createMultiServer({ port: 0, host: '127.0.0.1', idleProtocol: 'redis' });
    await new Promise((r) => redisIdle.listen(r));
    const s = await connect(redisIdle.address.port);
    // 不主动发包：按 idleProtocol 走 Redis，随后发 PING 必须能回
    await new Promise((r) => setTimeout(r, 350));
    s.write(Buffer.from('PING\r\n'));
    const buf = await readSome(s, 800);
    s.destroy();
    ok('idleProtocol=redis 时空闲连接仍可用', buf.toString('utf8').startsWith('+PONG'), buf.toString('utf8'));
    await new Promise((r) => redisIdle.close(r));
  }

  console.log('\n--- CLI serve 入口 ---');
  {
    const bin = path.join(__dirname, '..', 'bin', 'jsql');
    const child = spawn(process.execPath, [bin, 'serve', '-p', '0'], {
      env: { ...process.env, JSQL_NO_STAR_NAG: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { out += c; });
    const started = await new Promise((resolve) => {
      const t = setTimeout(() => resolve(false), 5000);
      const check = () => {
        if (/multi-protocol server on/.test(out) || /serve failed/.test(out)) {
          clearTimeout(t); resolve(/multi-protocol server on/.test(out));
        } else setTimeout(check, 50);
      };
      check();
    });
    ok('jsql serve 默认启动多协议服务器', started, out.trim());
    child.kill('SIGTERM');
    await new Promise((r) => { child.on('exit', r); setTimeout(r, 1000); });
  }

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
