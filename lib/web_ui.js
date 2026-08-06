/*
 * JSQL-NEO built-in web UI: zero-dependency HTTP management console.
 *
 *   const { WebUI } = require('jsql-neo');
 *   const ui = new WebUI({ port: 8080, dataDir: './data' });
 *   await ui.start();
 *
 * Routes:
 *   GET  /                       management console (HTML, no external deps)
 *   GET  /api/databases          [{name, tables, rows}]
 *   GET  /api/tables?db=name     {tables: [{name, count}]}
 *   POST /api/query  {db, sql}   {columns, rows, rowCount, ok, error?}
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const Database = require('./database');
const { executeSQL } = require('./sql');

const PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>JSQL-NEO</title>
<style>
:root { color-scheme: dark; }
body { margin: 0; font: 14px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; background: #0d1117; color: #e6edf3; display: flex; height: 100vh; }
.side { width: 260px; border-right: 1px solid #21262d; padding: 12px; overflow: auto; }
.main { flex: 1; display: flex; flex-direction: column; }
h1 { font-size: 15px; margin: 4px 0 12px; }
h2 { font-size: 12px; color: #8b949e; text-transform: uppercase; letter-spacing: 1px; margin: 14px 0 6px; }
.db { cursor: pointer; padding: 3px 6px; border-radius: 6px; }
.db:hover, .db.active { background: #1f6feb33; }
.db .rows { color: #8b949e; font-size: 12px; }
.tbl { cursor: pointer; padding: 2px 6px 2px 18px; color: #79c0ff; border-radius: 4px; }
.tbl:hover { background: #21262d; }
textarea { flex: 1; margin: 12px; padding: 10px; background: #010409; color: #e6edf3; border: 1px solid #21262d; border-radius: 8px; resize: none; font: inherit; }
.actions { padding: 0 12px; }
button { background: #238636; border: 0; color: #fff; padding: 6px 16px; border-radius: 6px; cursor: pointer; font: inherit; }
button:hover { background: #2ea043; }
button:disabled { background: #21262d; cursor: wait; }
.status { padding: 0 12px 10px; color: #8b949e; min-height: 20px; }
table { border-collapse: collapse; width: 100%; font-size: 13px; }
th, td { border: 1px solid #21262d; padding: 4px 8px; text-align: left; white-space: pre; }
th { background: #161b22; position: sticky; top: 0; }
tr:nth-child(even) td { background: #0d1117; }
.result { flex: 1.4; overflow: auto; margin: 0 12px 12px; border: 1px solid #21262d; border-radius: 8px; background: #010409; }
.err { color: #f85149; padding: 10px; }
.ok { color: #3fb950; }
</style>
</head>
<body>
<div class="side">
  <h1>JSQL-NEO</h1>
  <h2>Databases</h2>
  <div id="dbs"></div>
  <h2>Tables</h2>
  <div id="tbls"></div>
</div>
<div class="main">
  <textarea id="sql" spellcheck="false" placeholder="SELECT * FROM t LIMIT 100">SELECT 1</textarea>
  <div class="actions">
    <button id="run" onclick="run()">Run (Ctrl+Enter)</button>
  </div>
  <div class="status" id="status"></div>
  <div class="result" id="res"></div>
</div>
<script>
let dbs = [], cur = null;
const q = async (u, o) => { const r = await fetch(u, o); return r.json(); };
function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
async function load() {
  dbs = await q('/api/databases');
  const el = document.getElementById('dbs');
  el.innerHTML = dbs.map(d => '<div class="db" onclick="openDb(' + esc(d.name) + ')">' + esc(d.name) + ' <span class="rows">(' + d.tables + ' tbl)</span></div>').join('');
  if (!cur && dbs.length) openDb(dbs[0].name);
}
async function openDb(n) {
  cur = n;
  document.querySelectorAll('.db').forEach(e => e.classList.toggle('active', e.textContent.indexOf(n) === 0));
  const r = await q('/api/tables?db=' + encodeURIComponent(n));
  document.getElementById('tbls').innerHTML = r.tables.map(t =>
    '<div class="tbl" onclick="sel(' + esc(t.name) + ')">' + esc(t.name) + ' (' + t.count + ')</div>').join('');
}
function sel(n) { document.getElementById('sql').value = 'SELECT * FROM ' + n + ' LIMIT 100'; run(); }
async function run() {
  const sql = document.getElementById('sql').value;
  if (!cur || !sql.trim()) return;
  const btn = document.getElementById('run'); btn.disabled = true;
  const st = document.getElementById('status'); st.innerHTML = 'running...';
  try {
    const r = await q('/api/query', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ db: cur, sql }) });
    st.innerHTML = r.ok ? '<span class="ok">ok</span> ' + r.rowCount + ' row(s), ' + r.ms + 'ms' : '<span class="err">' + esc(r.error) + '</span>';
    if (r.columns && r.columns.length) {
      let h = '<table><tr>' + r.columns.map(c => '<th>' + esc(c) + '</th>').join('') + '</tr>';
      h += r.rows.map(row => '<tr>' + row.map(c => '<td>' + (c === null ? '<i>NULL</i>' : esc(c)) + '</td>').join('') + '</tr>').join('');
      document.getElementById('res').innerHTML = h + '</table>';
    } else if (r.affected !== undefined) {
      document.getElementById('res').innerHTML = '<p class="ok">' + r.affected + ' row(s) affected</p>';
    }
  } catch (e) { st.innerHTML = '<span class="err">' + esc(e.message) + '</span>'; }
  btn.disabled = false;
}
document.addEventListener('keydown', e => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') run(); });
load();
</script>
</body>
</html>
`;

class WebUI {
  constructor(opts = {}) {
    this.port = opts.port || 8080;
    this.dataDir = opts.dataDir || '.';
    this.readonly = !!opts.readonly;
    this.host = opts.host || '0.0.0.0';
    this.cache = new Map();
  }

  dbPath(name) {
    if (!/^[A-Za-z0-9_.-]+$/.test(name)) throw new Error('invalid database name');
    const p = path.join(this.dataDir, name + '.json');
    if (!fs.existsSync(p)) throw new Error('database not found: ' + name);
    return p;
  }

  async db(name) {
    if (this.cache.has(name)) return this.cache.get(name);
    const db = new Database(this.dbPath(name), { autoSave: !this.readonly });
    if (db.loadDatabase) await db.loadDatabase();
    this.cache.set(name, db);
    return db;
  }

  listDatabases() {
    if (!fs.existsSync(this.dataDir)) return [];
    return fs.readdirSync(this.dataDir)
      .filter(f => f.endsWith('.json'))
      .map(f => {
        let tables = 0;
        try { tables = Object.keys(JSON.parse(fs.readFileSync(path.join(this.dataDir, f), 'utf8')).__schema__ || {}).length; } catch (_) {}
        return { name: f.slice(0, -5), tables };
      });
  }

  tableList(db) {
    const map = db._tables || {};
    return Object.values(map).map(t => ({
      name: t._name || t.name,
      count: (t._rows || t.rows || []).length,
    }));
  }

  async handle(req, res) {
    const url = new URL(req.url, 'http://x');
    const send = (code, obj) => {
      const body = JSON.stringify(obj);
      res.writeHead(code, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(body);
    };

    try {
      if (url.pathname === '/' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(PAGE);
      }
      if (url.pathname === '/api/databases' && req.method === 'GET') {
        return send(200, this.listDatabases());
      }
      if (url.pathname === '/api/tables' && req.method === 'GET') {
        const db = await this.db(url.searchParams.get("db"));
        return send(200, { tables: this.tableList(db) });
      }
      if (url.pathname === '/api/query' && req.method === 'POST') {
        let body = '';
        for await (const chunk of req) body += chunk;
        const { db: dbName, sql } = JSON.parse(body || '{}');
        if (!dbName || !sql) return send(400, { ok: false, error: 'db and sql are required' });
        const db = await this.db(dbName);
        const t0 = Date.now();
        try {
          const res2 = await executeSQL(db, sql);
          const ms = Date.now() - t0;
          const out = { ok: true, ms };
          if (res2 && res2.rows) {
            out.columns = res2.columns;
            out.rows = res2.rows;
            out.rowCount = res2.rows.length;
          } else if (res2 && res2.affectedRows !== undefined) {
            out.affected = res2.affectedRows;
          } else {
            out.rowCount = 0;
          }
          return send(200, out);
        } catch (e) {
          return send(200, { ok: false, error: String(e.message || e) });
        }
      }
      return send(404, { ok: false, error: 'not found' });
    } catch (e) {
      return send(500, { ok: false, error: String(e.message || e) });
    }
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => this.handle(req, res).catch(e => {
        try { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: String(e.message || e) })); } catch (_) {}
      }));
      this.server.on('error', reject);
      this.server.listen(this.port, this.host, () => resolve(this.server.address().port));
    });
  }

  stop() {
    return new Promise(resolve => {
      for (const db of this.cache.values()) db.stop();
      this.cache.clear();
      if (this.server) this.server.close(() => resolve());
      else resolve();
    });
  }
}

module.exports = { WebUI };
