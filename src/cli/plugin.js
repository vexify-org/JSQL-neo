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

  // 下载插件包
  const url = new URL(REGISTRY_BASE);
  url.searchParams.set('action', 'download');
  url.searchParams.set('name', name);
  
  const res = await fetch(url.toString());
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

  // 读取 manifest（从解压后的目录）
  const manifestFile = path.join(pluginDir, 'manifest.json');
  let manifest;
  if (fs.existsSync(manifestFile)) {
    manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  } else {
    // 创建默认 manifest
    manifest = { name, version: '0.0.0', installedAt: new Date().toISOString() };
    fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2));
  }

  // 清理压缩包
  fs.rmSync(archivePath, { force: true });

  return manifest;
}

/** 卸载插件 */
function uninstallPlugin(name) {
  const pluginDir = path.join(PLUGIN_DIR, name);
  if (!fs.existsSync(pluginDir)) {
    throw new Error(`Plugin '${name}' is not installed`);
  }
  fs.rmSync(pluginDir, { recursive: true, force: true });
  return { name, uninstalled: true };
}

/** 列出已安装的插件 */
function listInstalled() {
  ensurePluginDir();
  const entries = fs.readdirSync(PLUGIN_DIR, { withFileTypes: true });
  const plugins = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const manifestPath = path.join(PLUGIN_DIR, entry.name, 'manifest.json');
    if (fs.existsSync(manifestPath)) {
      try {
        plugins.push(JSON.parse(fs.readFileSync(manifestPath, 'utf8')));
      } catch { /* 跳过损坏的 manifest */ }
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
};
