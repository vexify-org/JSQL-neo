// © Vexify 2026 All Rights Reserved.
// jsql server start/stop/status — 后台常驻服务控制（对标 `net mysql80 start`）。
// 状态文件放在 ~/.jsql/ 下：server.pid / server.log / server.json（保存启动配置）。

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const STATE_DIR = path.join(os.homedir(), '.jsql');
const PID_FILE = path.join(STATE_DIR, 'server.pid');
const LOG_FILE = path.join(STATE_DIR, 'server.log');
const CONF_FILE = path.join(STATE_DIR, 'server.json');

function ensureStateDir() {
  fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
}

function readPid() {
  try {
    const pid = parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch (e) {
    return null;
  }
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
  const existing = readPid();
  if (existing && isAlive(existing)) {
    return `jsql server is already running (pid ${existing}).`;
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
  const child = spawn(process.execPath, [entry, '--config', CONF_FILE], {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: Object.assign({}, process.env, { JSQL_SERVER_MAIN: '1' }),
  });
  child.once('error', err => {
    fs.closeSync(logFd);
    throw err;
  });
  child.unref();

  fs.writeFileSync(PID_FILE, String(child.pid), 'utf8');

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
  const pid = readPid();
  if (!pid) return 'jsql server is not running.';
  if (!isAlive(pid)) {
    fs.unlinkSync(PID_FILE);
    return 'jsql server is not running.';
  }
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
  const pid = readPid();
  if (!pid || !isAlive(pid)) {
    return 'jsql server is not running.';
  }
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
