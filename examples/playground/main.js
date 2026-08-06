import { JSQL } from 'jsql-neo';

const sqlEl = document.getElementById('sql');
const resEl = document.getElementById('res');
const statusEl = document.getElementById('status');
const tblsEl = document.getElementById('tbls');
const sizeEl = document.getElementById('dbsize');
const runBtn = document.getElementById('run');

let db = null;

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function fmt(v) {
  if (v === null || v === undefined) return '<i>NULL</i>';
  if (typeof v === 'object') return esc(JSON.stringify(v));
  return esc(String(v));
}

function setStatus(html, cls) {
  statusEl.innerHTML = html;
  statusEl.className = 'status' + (cls ? ' ' + cls : '');
}

async function init() {
  try {
    db = new JSQL({ dbName: 'jsql-playground', persistence: true });
    await db.start();
    setStatus('engine ready', 'ok');
    await refresh();
  } catch (e) {
    setStatus('init failed: ' + esc(e.message || e), 'err');
  }
}

async function refresh() {
  if (!db) return;
  try {
    const list = await db.getTables();
    if (list.length === 0) {
      tblsEl.innerHTML = '<div class="tbl">no tables — seed demo data</div>';
      sizeEl.textContent = '';
      return;
    }
    tblsEl.innerHTML = '';
    for (const t of list) {
      const meta = await db.getTableSchema(t);
      const cols = meta ? Object.keys(meta).join(', ') : '';
      const div = document.createElement('div');
      div.className = 'tbl';
      div.textContent = t;
      if (cols) {
        const c = document.createElement('div');
        c.className = 'cols';
        c.textContent = cols;
        div.appendChild(c);
      }
      div.onclick = () => {
        sqlEl.value = 'SELECT * FROM ' + t + ' LIMIT 100';
        run();
      };
      tblsEl.appendChild(div);
    }
    sizeEl.textContent = list.length + ' table(s)';
  } catch (e) {
    tblsEl.innerHTML = '<div class="tbl">' + esc(e.message || e) + '</div>';
  }
}

async function seed() {
  if (!db) return;
  try {
    await db.executeSQL('CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTO_INCREMENT, name VARCHAR(50), age INTEGER, email VARCHAR(100))');
    await db.executeSQL("INSERT INTO users (name, age, email) VALUES ('Alice', 30, 'alice@example.com'), ('Bob', 25, 'bob@example.com'), ('Carol', 35, 'carol@example.com'), ('Dan', 41, 'dan@example.com')");
    await db.executeSQL('CREATE TABLE IF NOT EXISTS products (id INTEGER PRIMARY KEY AUTO_INCREMENT, name VARCHAR(50), price FLOAT, in_stock INTEGER)');
    await db.executeSQL("INSERT INTO products (name, price, in_stock) VALUES ('Keyboard', 49.9, 12), ('Mouse', 19.5, 40), ('Monitor', 199.0, 5), ('USB-C Cable', 9.9, 120)");
    setStatus('seeded users + products', 'ok');
    await refresh();
  } catch (e) {
    setStatus('seed failed: ' + esc(e.message || e), 'err');
  }
}

async function wipe() {
  if (!db || !confirm('Delete all data in this browser?')) return;
  try {
    await db.executeSQL('DROP TABLE IF EXISTS users');
    await db.executeSQL('DROP TABLE IF EXISTS products');
    setStatus('database reset', 'ok');
    await refresh();
  } catch (e) {
    setStatus('reset failed: ' + esc(e.message || e), 'err');
  }
}

async function run() {
  const sql = sqlEl.value.trim();
  if (!sql || !db) return;
  runBtn.disabled = true;
  setStatus('running…');
  resEl.innerHTML = '';
  try {
    const t0 = performance.now();
    const r = await db.executeSQL(sql);
    const ms = Math.round(performance.now() - t0);
    if (r.rows && r.columns && r.columns.length) {
      let h = '<table><tr>' + r.columns.map(c => '<th>' + esc(c) + '</th>').join('') + '</tr>';
      h += r.rows.map(row => '<tr>' + r.columns.map(c => '<td>' + fmt(row[c]) + '</td>').join('') + '</tr>').join('');
      resEl.innerHTML = h + '</table>';
      setStatus(r.rows.length + ' row(s), ' + ms + 'ms', 'ok');
    } else {
      resEl.innerHTML = '<div class="hint" style="color:#3fb950">ok — ' + ms + 'ms</div>';
      setStatus('done, ' + ms + 'ms', 'ok');
    }
    await refresh();
  } catch (e) {
    resEl.innerHTML = '<div class="hint" style="color:#f85149">' + esc(e.message || e) + '</div>';
    setStatus('error', 'err');
  }
  runBtn.disabled = false;
}

sqlEl.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') run();
});
runBtn.addEventListener('click', run);
window.seed = seed;
window.wipe = wipe;

init();
