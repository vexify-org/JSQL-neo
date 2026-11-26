// © Vexify 2026 All Rights Reserved.
// jsql server start/stop/status — 后台常驻服务控制（对标 `net mysql80 start`）。
// 状态文件放在 ~/.jsql/ 下：server.pid / server.log / server.json（保存启动配置）。

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const STATE_DIR = path.join(os.homedir(), '.jsql');
const PID_FILE = path.join(STATE_DIR, 'server.pid');
const LOG_FILE = path.join(STATE_DIR, 'server.log');
const CONF_FILE = path.join(STATE_DIR, 'server.json');

function ensureStateDir() {
  fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
}

// #537：PID 文件同时保存启动令牌。仅凭数字 PID 判活会在 PID 被复用后
// 误把无关进程当成 jsql server 并 SIGTERM。
function readPidInfo() {
  try {
    const raw = fs.readFileSync(PID_FILE, 'utf8').trim();
    let pid = null, token = null;
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        pid = parsed.pid;
        if (typeof parsed.token === 'string' && parsed.token) token = parsed.token;
      } else {
        pid = parseInt(raw, 10);
      }
    } catch (_) {
      pid = parseInt(raw, 10);
    }
    if (!Number.isInteger(pid) || pid <= 0) return null;
    return { pid, token };
  } catch (e) {
    return null;
  }
}

function readPid() {
  const info = readPidInfo();
  return info ? info.pid : null;
}

function isAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

// 令牌通过环境变量注入子进程；/proc/<pid>/environ 反映进程启动时的环境。
function hasIdentity(pid, token) {
  if (!token) return false; // 旧格式 PID 文件无法校验身份，保守视为非本服务
  const marker = 'JSQL_SERVER_TOKEN=' + token;
  try {
    return fs.readFileSync('/proc/' + pid + '/environ', 'utf8').split('\0').includes(marker);
  } catch (e) {
    // 非 Linux 环境退而校验命令行是否指向本服务的启动入口
    try {
      const { execFileSync } = require('child_process');
      const cmd = execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' });
      return cmd.includes(path.join(__dirname, 'jsql-server'));
    } catch (_) { return false; }
  }
}

function isOurServer(info) {
  return !!(info && isAlive(info.pid) && hasIdentity(info.pid, info.token));
}

function isPortOpen(port, host) {
  return new Promise(resolve => {
    const net = require('net');
    const sock = net.connect({ port, host: host || '127.0.0.1' });
    sock.once('connect', () => { sock.destroy(); resolve(true); });
    sock.once('error', () => resolve(false));
    setTimeout(() => { sock.destroy(); resolve(false); }, 800);
  });
}

function parseAuthSpecs(list) {
  const auth = {};
  for (const spec of list) {
    const idx = spec.indexOf(':');
    if (idx <= 0) {
      auth[spec] = '';
      continue;
    }
    const user = spec.slice(0, idx);
    const rest = spec.slice(idx + 1);
    const idx2 = rest.indexOf(':');
    const password = idx2 === -1 ? rest : rest.slice(0, idx2);
    const dbPart = idx2 === -1 ? '' : rest.slice(idx2 + 1);
    const dbs = dbPart
      ? dbPart.split(',').map(s => s.trim()).filter(Boolean)
      : null;
    auth[user] = dbs ? { password, databases: dbs } : password;
  }
  return auth;
}

async function start(opts = {}) {
  ensureStateDir();
  const existing = readPidInfo();
  if (isOurServer(existing)) {
    return `jsql server is already running (pid ${existing.pid}).`;
  }

  const configPath = opts.config || CONF_FILE;
  let cfg = { port: 3306, host: '127.0.0.1' };
  if (fs.existsSync(configPath)) {
    try { cfg = Object.assign(cfg, JSON.parse(fs.readFileSync(configPath, 'utf8'))); } catch (e) {}
  }
  if (opts.port != null) cfg.port = opts.port;
  if (opts.host != null) cfg.host = opts.host;
  if (opts.dataDir != null) cfg.dataDir = path.resolve(opts.dataDir);
  if (opts.noAuth) {
    cfg.noAuth = true;
    delete cfg.auth;
    delete cfg.user;
    delete cfg.password;
  } else {
    cfg.noAuth = false;
  }
  if (opts.auth) cfg.auth = parseAuthSpecs(Array.isArray(opts.auth) ? opts.auth : [opts.auth]);
  fs.writeFileSync(CONF_FILE, JSON.stringify(cfg, null, 2), 'utf8');

  const entry = path.join(__dirname, 'jsql-server');
  const logFd = fs.openSync(LOG_FILE, 'a');
  const token = crypto.randomBytes(16).toString('hex'); // #537：进程身份令牌
  const child = spawn(process.execPath, [entry, '--config', CONF_FILE], {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: Object.assign({}, process.env, { JSQL_SERVER_MAIN: '1', JSQL_SERVER_TOKEN: token }),
  });
  child.once('error', err => {
    fs.closeSync(logFd);
    throw err;
  });
  child.unref();

  fs.writeFileSync(PID_FILE, JSON.stringify({ pid: child.pid, token }), 'utf8');

  const ready = await waitReady(cfg.port, cfg.host, 5000);
  if (!ready) {
    if (isAlive(child.pid)) {
      try { process.kill(child.pid, 'SIGTERM'); } catch (e) {}
      fs.unlinkSync(PID_FILE);
    }
    throw new Error(`server failed to start (see ${LOG_FILE})`);
  }
  return `jsql server started (pid ${child.pid}, ${cfg.host}:${cfg.port}, dataDir: ${cfg.dataDir || 'in-memory'}). Log: ${LOG_FILE}`;
}

function waitReady(port, host, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise(resolve => {
    const tick = async () => {
      if (await isPortOpen(port, host)) return resolve(true);
      if (Date.now() > deadline) return resolve(false);
      setTimeout(tick, 200);
    };
    tick();
  });
}

async function stop(opts = {}) {
  const info = readPidInfo();
  if (!isOurServer(info)) {
    // #537：PID 复用或旧格式文件都不能作为发信号依据，只清理陈旧文件
    try { fs.unlinkSync(PID_FILE); } catch (_) {}
    return 'jsql server is not running.';
  }
  const pid = info.pid;
  try {
    process.kill(pid, 'SIGTERM');
  } catch (e) {
    throw new Error(`failed to stop server (pid ${pid}): ${e.message}`);
  }
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) break;
    await new Promise(r => setTimeout(r, 150));
  }
  if (isAlive(pid)) {
    try { process.kill(pid, 'SIGKILL'); } catch (e) {}
  }
  fs.unlinkSync(PID_FILE);
  return `jsql server stopped (pid ${pid}).`;
}

async function status(opts = {}) {
  const info = readPidInfo();
  if (!isOurServer(info)) {
    return 'jsql server is not running.';
  }
  const pid = info.pid;
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(CONF_FILE, 'utf8')); } catch (e) {}
  const port = (opts.port != null ? opts.port : cfg.port) || 3306;
  const host = (opts.host != null ? opts.host : cfg.host) || '127.0.0.1';
  const up = await isPortOpen(port, host);
  const lines = [
    `jsql server is running (pid ${pid}).`,
    `  ${host}:${port} ${up ? 'listening' : 'NOT responding'}`,
    `  dataDir: ${cfg.dataDir || 'in-memory'}`,
    `  log: ${LOG_FILE}`,
  ];
  if (cfg.auth) lines.push(`  users: ${Object.keys(cfg.auth).join(', ')}`);
  return lines.join('\n');
}

module.exports = { serverControl: { start, stop, status }, STATE_DIR, PID_FILE, LOG_FILE, CONF_FILE };
