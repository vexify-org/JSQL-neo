/**
 * JSQL Plugin Registry CLI
 *
 * 协议文档: /root/.openclaw/workspace/registry-protocol.md
 * Registry API: https://registry-beta.vexify.top/?action=xxx
 *
 * 注意: 当前 registry-beta 实例仅实现了 plugins / search / registry 三个 action，
 * 尚未实现 info 和 download。本模块优先使用实际 API，缺失能力时给出友好提示。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');

const REGISTRY_BASE = 'https://registry-beta.vexify.top';
const PLUGIN_DIR = path.join(os.homedir(), '.jsql', 'plugins');

// ─── 工具函数 ──────────────────────────────────────────────

/** 确保插件目录存在 */
function ensurePluginDir() {
  if (!fs.existsSync(PLUGIN_DIR)) {
    fs.mkdirSync(PLUGIN_DIR, { recursive: true });
  }
}

/** 从可能含有 PHP Warning 前缀的响应文本中提取 JSON */
function extractJson(text) {
  // 找到第一个 '{' 的位置，从那里开始解析
  const idx = text.indexOf('{');
  if (idx === -1) return null;
  try {
    return JSON.parse(text.slice(idx));
  } catch {
    return null;
  }
}

/** 发起 registry API 请求，返回解析后的 JSON */
async function apiRequest(action, params = {}) {
  const url = new URL(REGISTRY_BASE);
  url.searchParams.set('action', action);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) url.searchParams.set(k, v);
  }

  const res = await fetch(url.toString());
  const text = await res.text();
  const body = extractJson(text);

  if (!res.ok || !body || body.status !== 'success') {
    const msg = body?.error || `HTTP ${res.status}`;
    throw new Error(`Registry error: ${msg}`);
  }
  return body.data;
}

// ─── 核心操作 ──────────────────────────────────────────────

/** 列出所有插件（支持 category / tag / author / q / sort / order / page / limit） */
async function listPlugins(opts = {}) {
  const params = {};
  if (opts.category) params.category = opts.category;
  if (opts.tag) params.tag = opts.tag;
  if (opts.author) params.author = opts.author;
  if (opts.q) params.q = opts.q;
  if (opts.sort) params.sort = opts.sort;
  if (opts.order) params.order = opts.order;
  if (opts.page) params.page = opts.page;
  if (opts.limit) params.limit = opts.limit;
  return apiRequest('plugins', params);
}

/** 搜索插件（q 参数必填） */
async function searchPlugins(query, opts = {}) {
  if (!query) throw new Error('Search query is required');
  const params = { q: query };
  if (opts.category) params.category = opts.category;
  if (opts.tag) params.tag = opts.tag;
  if (opts.sort) params.sort = opts.sort;
  return apiRequest('search', params);
}

/** 获取单个插件信息（实际 API 未实现 info action，通过 plugins 列表过滤） */
async function getPluginInfo(name) {
  const plugins = await listPlugins({ q: name, limit: 100 });
  const plugin = plugins.find(p => p.name === name);
  if (!plugin) throw new Error(`Plugin '${name}' not found in registry`);
  return plugin;
}

/**
 * 带重试的 fetch（P1 修复：install 网络间歇性失败 30-40%）
 * 3 次重试 + 指数退避（500ms, 1s, 2s）
 */
async function fetchWithRetry(url, retries = 3, baseDelay = 500) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url.toString());
      if (res.ok) return res;
      // 5xx / 429 可重试
      if ((res.status >= 500 || res.status === 429) && i < retries - 1) {
        const delay = baseDelay * Math.pow(2, i);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      return res;
    } catch (e) {
      if (i < retries - 1) {
        const delay = baseDelay * Math.pow(2, i);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      throw e;
    }
  }
}

/** 安装插件：下载 tgz 并解压到 ~/.jsql/plugins/<name>/ */
async function installPlugin(name) {
  ensurePluginDir();

  // 检查是否已安装
  const pluginDir = path.join(PLUGIN_DIR, name);
  const manifestPath = path.join(pluginDir, 'manifest.json');
  if (fs.existsSync(manifestPath)) {
    const existing = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    throw new Error(`Plugin '${name}' is already installed (v${existing.version})`);
  }

  // 下载插件包（带重试）
  const url = new URL(REGISTRY_BASE);
  url.searchParams.set('action', 'download');
  url.searchParams.set('name', name);

  const res = await fetchWithRetry(url);
  const ct = res.headers.get('content-type') || '';
  const buf = Buffer.from(await res.arrayBuffer());

  // 检查 Content-Type 或 magic bytes
  if (!ct.includes('gzip') && buf[0] !== 0x1f) {
    // 返回了错误 JSON，不是 tgz
    const text = buf.toString('utf8');
    const body = extractJson(text);
    throw new Error(body?.error || `Download failed (HTTP ${res.status})`);
  }

  const archivePath = path.join(PLUGIN_DIR, `${name}.tgz`);
  fs.writeFileSync(archivePath, buf);

  // 解压 tgz
  fs.mkdirSync(pluginDir, { recursive: true });
  try {
    execSync(`tar -xzf "${archivePath}" -C "${pluginDir}"`, { stdio: 'pipe' });
  } catch (e) {
    fs.rmSync(pluginDir, { recursive: true, force: true });
    fs.rmSync(archivePath, { force: true });
    throw new Error(`Failed to extract plugin archive: ${e.message}`);
  }

  // 读取 manifest（兼容两种路径：根级 + plugins/ 子目录）
  let manifestFile = path.join(pluginDir, 'manifest.json');
  if (!fs.existsSync(manifestFile)) {
    manifestFile = path.join(pluginDir, 'plugins', 'manifest.json');
  }
  let manifest;
  if (fs.existsSync(manifestFile)) {
    manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  } else {
    // 创建默认 manifest
    manifest = { name, version: '0.0.0', installedAt: new Date().toISOString() };
    fs.writeFileSync(path.join(pluginDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  }

  // 清理压缩包
  fs.rmSync(archivePath, { force: true });

  return manifest;
}

/**
 * 卸载插件
 * P0 安全修复：校验 name 不含路径遍历序列，使用 basename 隔离，
 * 防止 `jsql plugin uninstall '../../etc/something'` 删除任意目录。
 */
function uninstallPlugin(name) {
  if (typeof name !== 'string' || !name) {
    throw new Error('Plugin name must be a non-empty string');
  }
  // 拒绝包含路径遍历的名称
  if (name.includes('..') || name.includes('/') || name.includes('\\')) {
    throw new Error(`Invalid plugin name: '${name}'`);
  }
  // 使用 basename 进一步隔离
  const safeName = path.basename(name);
  if (safeName !== name) {
    throw new Error(`Invalid plugin name: '${name}'`);
  }
  const pluginDir = path.join(PLUGIN_DIR, safeName);
  // 二次校验：确保解析后的路径严格在 PLUGIN_DIR 之下
  const resolved = path.resolve(pluginDir);
  const pluginDirResolved = path.resolve(PLUGIN_DIR);
  if (resolved !== pluginDirResolved && !resolved.startsWith(pluginDirResolved + path.sep)) {
    throw new Error(`Plugin name resolves outside plugin directory: '${name}'`);
  }
  if (!fs.existsSync(pluginDir)) {
    throw new Error(`Plugin '${safeName}' is not installed`);
  }
  fs.rmSync(pluginDir, { recursive: true, force: true });
  return { name: safeName, uninstalled: true };
}

/** 列出已安装的插件（兼容根级 + plugins/ 子目录两种布局） */
function listInstalled() {
  ensurePluginDir();
  const entries = fs.readdirSync(PLUGIN_DIR, { withFileTypes: true });
  const plugins = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    // 兼容两种路径：根级 manifest.json + plugins/ 子目录 manifest.json
    const manifestPaths = [
      path.join(PLUGIN_DIR, entry.name, 'manifest.json'),
      path.join(PLUGIN_DIR, entry.name, 'plugins', 'manifest.json'),
    ];
    for (const manifestPath of manifestPaths) {
      if (fs.existsSync(manifestPath)) {
        try {
          plugins.push(JSON.parse(fs.readFileSync(manifestPath, 'utf8')));
        } catch { /* 跳过损坏的 manifest */ }
        break;
      }
    }
  }
  return plugins;
}

// ─── 格式化输出 ────────────────────────────────────────────

/** 格式化插件列表为表格 */
function formatPluginList(plugins) {
  if (!plugins.length) return 'No plugins found.';
  const rows = plugins.map(p =>
    `${p.name.padEnd(24)} ${(p.version || '?').padEnd(10)} ${(p.description || '').slice(0, 50)}`
  );
  return rows.join('\n');
}

/** 格式化插件详情 */
function formatPluginInfo(p) {
  const lines = [
    `Name:        ${p.name}`,
    `Version:     ${p.version}`,
    `Author:      ${p.author}`,
    `License:     ${p.license}`,
    `Category:    ${p.category}`,
    `Description: ${p.description}`,
    `Tags:        ${(p.tags || []).join(', ')}`,
    `Downloads:   ${p.downloads || 0}`,
  ];
  if (p.jsql) {
    lines.push(`JSQL:        ${p.jsql.minVersion}+${p.jsql.maxVersion ? ' – ' + p.jsql.maxVersion : ''}`);
  }
  return lines.join('\n');
}

module.exports = {
  PLUGIN_DIR,
  ensurePluginDir,
  listPlugins,
  searchPlugins,
  getPluginInfo,
  installPlugin,
  uninstallPlugin,
  listInstalled,
  formatPluginList,
  formatPluginInfo,
  fetchWithRetry,
};
