/*
 * jsql-neo TUI — zero-dependency interactive SQL terminal.
 *
 * Raw-mode keyboard handling, line editing with history & Tab completion,
 * statement continuation (quote/paren balance + trailing ";"), table
 * rendering with CJK-aware column widths, meta commands, and a status bar.
 *
 * When stdin is NOT a TTY it degrades to batch mode (execute each line).
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const Database = require('./database');
const { executeSQL } = require('./sql');

const HISTORY_FILE = path.join(os.homedir(), '.jsql-history');
const MAX_HISTORY = 500;

/* ---------- ANSI helpers ---------- */

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';
const MAGENTA = '\x1b[35m';
const GRAY = '\x1b[90m';
const CLEAR_LINE = '\x1b[2K';
const CLEAR_SCREEN = '\x1b[2J';
const HOME = '\x1b[H';
const HIDE_CURSOR = '\x1b[?25l';
const SHOW_CURSOR = '\x1b[?25h';

/* ---------- display width (CJK-aware) ---------- */

function wswidth(str) {
  let w = 0;
  for (const ch of String(str)) {
    const cp = ch.codePointAt(0);
    if (cp >= 0x1100 && (cp <= 0x115f || cp === 0x2329 || cp === 0x232a ||
        (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) ||
        (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xf900 && cp <= 0xfaff) ||
        (cp >= 0xfe30 && cp <= 0xfe4f) || (cp >= 0xff00 && cp <= 0xff60) ||
        (cp >= 0xffe0 && cp <= 0xffe6) || (cp >= 0x20000 && cp <= 0x2fffd))) {
      w += 2;
    } else w += 1;
  }
  return w;
}

function pad(str, width) {
  const s = String(str);
  return s + ' '.repeat(Math.max(0, width - wswidth(s)));
}

/* ---------- table rendering ---------- */

function renderTable(headers, rows, maxWidth) {
  if (!headers || headers.length === 0) return '(no columns)';
  const widths = headers.map((h) => wswidth(h));
  const lines = [];
  for (const row of rows) {
    headers.forEach((_, i) => {
      const v = row[i] == null ? 'NULL' : String(row[i]);
      if (wswidth(v) > widths[i]) widths[i] = wswidth(v);
    });
  }
  const maxCol = maxWidth || 200;
  let total = 1;
  for (const w of widths) total += w + 3;
  if (total > maxCol && widths.length > 1) {
    let overshoot = total - maxCol;
    let i = widths.indexOf(Math.max(...widths));
    while (overshoot > 0) {
      if (i === -1 || widths[i] <= 3) break;
      const cut = Math.min(widths[i] - 3, overshoot);
      widths[i] -= cut;
      overshoot -= cut;
    }
  }
  const border = '+' + widths.map((w) => '-'.repeat(w + 2)).join('+') + '+';
  lines.push(border);
  lines.push('| ' + headers.map((h, i) => pad(h, widths[i])).join(' | ') + ' |');
  lines.push(border);
  for (const row of rows) {
    const cells = headers.map((_, i) => {
      const v = row[i] == null ? 'NULL' : String(row[i]);
      return v.length > widths[i] + 0 && widths[i] >= 3 && wswidth(v) > widths[i]
        ? v.slice(0, Math.max(1, widths[i] - 1)) + '…'
        : v;
    });
    lines.push('| ' + cells.map((c, i) => pad(c, widths[i])).join(' | ') + ' |');
  }
  lines.push(border);
  return lines.join('\n');
}

/* ---------- meta commands ---------- */

const META_HELP = [
  ['\\q, \\quit, exit', '退出'],
  ['\\c', '清屏'],
  ['\\db', '显示当前数据库'],
  ['\\use <name>', '切换数据库'],
  ['\\tables', '列出所有表'],
  ['\\desc <table>', '查看表结构'],
  ['\\help', '显示帮助'],
  ['Ctrl+L 清屏 · Ctrl+C 取消当前行(再按退出) · Ctrl+D 退出', '快捷键'],
  ['Tab', '自动补全关键字'],
];

/* ---------- TUI shell ---------- */

class TUIShell {
  constructor(opts = {}) {
    this.dataDir = opts.dataDir || null;
    this.dbName = opts.db || 'default';
    this.engine = this._openEngine(this.dbName);
    this._engines = new Map();
    this._engines.set(this.dbName, this.engine);
    this.history = [];
    this._loadHistory();
    this.line = '';
    this.cursor = 0;
    this.histIdx = -1;
    this.pending = ''; // 续行 buffer
    this.dialect = opts.dialect || 'mysql';
    this.batch = !process.stdin.isTTY;
    this._exiting = false;
  }

  _openEngine(name) {
    if (this.dataDir && this.dataDir !== ':memory:') {
      return new Database(path.join(this.dataDir, name), { autoSave: true });
    }
    return new Database(':memory:', { autoSave: false });
  }

  _loadHistory() {
    try {
      const raw = fs.readFileSync(HISTORY_FILE, 'utf8').split('\n').filter(Boolean);
      this.history = raw.slice(-MAX_HISTORY);
    } catch (e) { this.history = []; }
  }

  _saveHistory() {
    try {
      const head = this.history.slice(-MAX_HISTORY);
      fs.writeFileSync(HISTORY_FILE, head.join('\n') + '\n');
    } catch (e) { /* ignore */ }
  }

  listen() { /* compat no-op (TUI owns the process) */ }

  async run() {
    if (this.batch) {
      return this._runBatch();
    }
    this._statusBar();
    console.log(`${CYAN}Welcome to jsql-neo ${BOLD}v${require('../package.json').version}${RESET} ${GRAY}(type \\help for commands)${RESET}\n`);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => this._onKeys(chunk));
    process.stdout.write(HIDE_CURSOR);
    this._redrawPrompt();
    this._term = process.stdin;
    this._term.on('end', () => { this._saveHistory(); });
    return new Promise(() => {});
  }

  /* ---------- batch mode ---------- */

  async _runBatch() {
    let data = '';
    try { data = fs.readFileSync(0, 'utf8'); } catch (e) {}
    const lines = data.split('\n');
    let combined = '';
    let results = 0;
    for (const line of lines) {
      const trimmed = line.trim();
      if (combined === '' && (trimmed.startsWith('\\q') || trimmed.startsWith('exit') || trimmed.startsWith('quit'))) break;
      if (combined === '' && trimmed.startsWith('\\')) {
        const r = this._meta(trimmed, true);
        if (r === 'quit') break;
        continue;
      }
      if (trimmed === '') {
        if (combined !== '') { await this._exec(combined); results++; combined = ''; }
        continue;
      }
      combined += (combined ? '\n' : '') + line;
      if (this._statementComplete(combined)) { await this._exec(combined); results++; combined = ''; }
    }
    if (combined) { await this._exec(combined); results++; }
    if (results === 0) {
      this._err('(no SQL statements — use interactive mode for the TUI, e.g. `jsql tui`)');
      process.exitCode = 1;
    }
  }

  /* ---------- keyboard ---------- */

  _onKeys(chunk) {
    const seq = Buffer.from(chunk, 'utf8');
    let i = 0;
    while (i < seq.length) {
      const b = seq[i];
      if (b === 0x1b) {
        if (seq[i + 1] === 0x5b) {
          const c = seq[i + 2];
          if (c === 0x41) this._histPrev();
          else if (c === 0x42) this._histNext();
          else if (c === 0x43) this._moveRight();
          else if (c === 0x44) this._moveLeft();
          else if (c === 0x48 || c === 0x31) this.cursor = 0, this._redrawPrompt();
          else if (c === 0x46 || c === 0x34) this.cursor = this.line.length, this._redrawPrompt();
          else if (c === 0x33 && seq[i + 3] === 0x7e) { this._deleteAt(); i += 4; continue; }
          i += 3;
          continue;
        }
        if (seq[i + 1] === 0x4f) { // ESC O x
          const c = seq[i + 2];
          if (c === 0x48) this.cursor = 0;
          else if (c === 0x46) this.cursor = this.line.length;
          this._redrawPrompt();
          i += 3;
          continue;
        }
        i += 1; // lone ESC: ignore
        continue;
      }
      if (b === 0x0d || b === 0x0a) { this._enter(); i++; continue; }
      if (b === 0x7f || b === 0x08) { this._backspace(); i++; continue; }
      if (b === 0x01) { this.cursor = 0; this._redrawPrompt(); i++; continue; }      // Ctrl+A
      if (b === 0x05) { this.cursor = this.line.length; this._redrawPrompt(); i++; continue; } // Ctrl+E
      if (b === 0x0c) { this._clearScreen(); i++; continue; }                        // Ctrl+L
      if (b === 0x03) { if (this.line || this.pending) this._cancelLine(); else this._quit(); i++; continue; } // Ctrl+C
      if (b === 0x04) { if (!this.line && !this.pending) this._quit(); i++; continue; } // Ctrl+D
      if (b === 0x09) { this._complete(); i++; continue; }                            // Tab
      if (b === 0x15) { this.line = ''; this.cursor = 0; this._redrawPrompt(); i++; continue; } // Ctrl+U
      if (b >= 0x20) {
        let ch, step;
        if (b < 0x80) { ch = String.fromCharCode(b); step = 1; }
        else {
          let n = 1;
          if (b >= 0xf0) n = 4;
          else if (b >= 0xe0) n = 3;
          else if (b >= 0xc0) n = 2;
          ch = seq.toString('utf8', i, i + n);
          step = ch.length || n;
        }
        this.line = this.line.slice(0, this.cursor) + ch + this.line.slice(this.cursor);
        this.cursor += ch.length;
        this._redrawPrompt();
        i += step;
        continue;
      }
      i++;
    }
  }

  _isMultibyte(seq, i) {
    const b = seq[i];
    let n = 1;
    if (b >= 0xf0) n = 4;
    else if (b >= 0xe0) n = 3;
    else if (b >= 0xc0) n = 2;
    return n > 1 && i + n <= seq.length;
  }

  _enter() {
    this._pushHistory(this.line);
    const text = this.line;
    this.line = '';
    this.cursor = 0;
    this.histIdx = -1;
    if (this.pending === '' && text.trim() === '') { this._redrawPrompt(); return; }
    this.pending += (this.pending ? '\n' : '') + text;
    if (this._statementComplete(this.pending)) {
      const stmt = this.pending;
      this.pending = '';
      this._exec(stmt);
    } else {
      this._redrawPrompt();
    }
  }

  _statementComplete(sql) {
    let inSQ = false, inDQ = false, parens = 0;
    for (let i = 0; i < sql.length; i++) {
      const c = sql[i];
      if (c === "'" && !inDQ) inSQ = !inSQ;
      else if (c === '"' && !inSQ) inDQ = !inDQ;
      else if (!inSQ && !inDQ) {
        if (c === '(') parens++;
        else if (c === ')') parens--;
      }
    }
    const trimmed = sql.trimEnd();
    return !inSQ && !inDQ && parens <= 0 && (trimmed.endsWith(';') || trimmed.endsWith('\\g'));
  }

  _backspace() {
    if (this.cursor <= 0) return;
    this.line = this.line.slice(0, this.cursor - 1) + this.line.slice(this.cursor);
    this.cursor--;
    this._redrawPrompt();
  }

  _deleteAt() {
    if (this.cursor >= this.line.length) return;
    this.line = this.line.slice(0, this.cursor) + this.line.slice(this.cursor + 1);
    this._redrawPrompt();
  }

  _moveLeft() { if (this.cursor > 0) { this.cursor--; this._redrawPrompt(); } }
  _moveRight() { if (this.cursor < this.line.length) { this.cursor++; this._redrawPrompt(); } }

  _histPrev() {
    if (this.history.length === 0) return;
    if (this.histIdx === -1) this.histIdx = this.history.length - 1;
    else if (this.histIdx > 0) this.histIdx--;
    this.line = this.history[this.histIdx];
    this.cursor = this.line.length;
    this._redrawPrompt();
  }

  _histNext() {
    if (this.histIdx === -1) return;
    this.histIdx++;
    if (this.histIdx >= this.history.length) { this.histIdx = -1; this.line = ''; }
    else this.line = this.history[this.histIdx];
    this.cursor = this.line.length;
    this._redrawPrompt();
  }

  _pushHistory(line) {
    const t = line.trim();
    if (!t || t.startsWith('\\')) return;
    if (this.history[this.history.length - 1] === t) return;
    this.history.push(t);
    if (this.history.length > MAX_HISTORY) this.history = this.history.slice(-MAX_HISTORY);
    this._saveHistory();
  }

  _cancelLine() {
    this.line = '';
    this.cursor = 0;
    if (this.pending) {
      this.pending = '';
      process.stdout.write('\r' + CLEAR_LINE + (this.pending ? '' : ''));
    }
    this._redrawPrompt();
  }

  _quit() {
    this._exiting = true;
    process.stdout.write('\r' + CLEAR_LINE + SHOW_CURSOR + '\n');
    this._saveHistory();
    try { process.stdin.setRawMode(false); } catch (e) {}
    process.stdin.pause();
    process.exit(0);
  }

  _redrawPrompt() {
    const prompt = this.pending ? `${GREEN}  ->${RESET} ` : `${GREEN}jsql>${RESET} `;
    const display = this.line.slice(0, this.cursor) + this.line.slice(this.cursor);
    process.stdout.write('\r' + CLEAR_LINE + prompt + display);
    const left = wswidth(prompt + this.line.slice(0, this.cursor));
    if (left > 0) process.stdout.write(`\x1b[${left}D`);
  }

  _clearScreen() {
    process.stdout.write(CLEAR_SCREEN + HOME);
    this._statusBar();
    process.stdout.write('\n');
    this._redrawPrompt();
  }

  _statusBar() {
    const mode = this.dataDir ? `data: ${this.dataDir}` : 'in-memory';
    const bar = `${BOLD}${GREEN} jsql-neo ${RESET}${GRAY}v${require('../package.json').version}${RESET}  |  db: ${CYAN}${this.dbName}${RESET}  |  ${GRAY}${mode}${RESET}  |  dialect: ${this.dialect}`;
    process.stdout.write('\x1b[7m' + bar + RESET + '\n');
  }

  /* ---------- completion ---------- */

  _complete() {
    const keywords = ['SELECT', 'FROM', 'WHERE', 'INSERT', 'INTO', 'VALUES', 'UPDATE', 'SET', 'DELETE',
      'CREATE', 'TABLE', 'DROP', 'ALTER', 'ADD', 'COLUMN', 'PRIMARY', 'KEY', 'INDEX', 'AND', 'OR', 'NOT',
      'NULL', 'LIKE', 'ILIKE', 'IN', 'BETWEEN', 'ORDER', 'BY', 'GROUP', 'HAVING', 'LIMIT', 'OFFSET',
      'JOIN', 'LEFT', 'RIGHT', 'INNER', 'OUTER', 'ON', 'AS', 'DISTINCT', 'COUNT', 'SUM', 'AVG', 'MIN',
      'MAX', 'BEGIN', 'COMMIT', 'ROLLBACK', 'SHOW', 'USE', 'EXPLAIN', 'UNION', 'ALL', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END'];
    const lastWord = this.line.slice(0, this.cursor).match(/[A-Za-z_][A-Za-z0-9_]*$/);
    if (!lastWord) { process.stdout.write('\a'); return; }
    const w = lastWord[0];
    const rest = this.line.slice(this.cursor);
    const match = keywords.find((k) => k.startsWith(w.toUpperCase()));
    if (!match) { process.stdout.write('\a'); return; }
    this.line = this.line.slice(0, this.cursor - w.length) + match + rest;
    this.cursor += match.length - w.length;
    this._redrawPrompt();
  }

  /* ---------- execution ---------- */

  async _exec(sql) {
    const start = Date.now();
    try {
      const result = await executeSQL(this.engine, sql, { dialect: this.dialect, safety: false });
      const elapsed = Date.now() - start;
      this._showResult(result, elapsed);
    } catch (e) {
      this._err(e.message || String(e));
    }
  }

  _showResult(result, elapsed) {
    if (result == null) { this._out(`(no result) ${GRAY}${elapsed} ms${RESET}`); return; }
    if (Array.isArray(result)) {
      result.forEach((r) => this._showResult(r, elapsed));
      this._redrawPrompt();
      return;
    }
    if (result.ok === true && result.columns && result.type === 'select') {
      const maxW = (process.stdout.columns || 120) - 4;
      this._out(renderTable(result.columns, result.rows, maxW));
      const n = result.rows.length;
      this._out(`${n} row${n === 1 ? '' : 's'} in set ${GRAY}(${elapsed} ms)${RESET}`);
    } else if (result.ok === true && (result.affectedRows !== undefined || result.rows !== undefined)) {
      const n = result.affectedRows !== undefined ? result.affectedRows : (Array.isArray(result.rows) ? result.rows.length : 0);
      this._out(`${GREEN}Query OK${RESET}, ${n} row${n === 1 ? '' : 's'} affected ${GRAY}(${elapsed} ms)${RESET}`);
    } else if (result.ok === true && result.message) {
      this._out(GREEN + result.message + RESET);
    } else if (result.ok === true && result.rows && Array.isArray(result.rows)) {
      this._out(renderTable(result.columns || Object.keys(result.rows[0] || {}), result.rows, (process.stdout.columns || 120) - 4));
    } else {
      this._out(JSON.stringify(result, null, 2));
    }
  }

  _out(text) {
    if (this.batch) { console.log(text.replace(/\x1b\[[0-9;]*m/g, '')); return; }
    process.stdout.write('\r' + CLEAR_LINE + text + '\n');
    this._redrawPrompt();
  }

  _err(msg) {
    if (this.batch) { console.error(msg.replace(/\x1b\[[0-9;]*m/g, '')); return; }
    process.stdout.write('\r' + CLEAR_LINE + `${RED}ERROR ${RESET}${msg}\n`);
    this._redrawPrompt();
  }

  /* ---------- meta ---------- */

  _meta(line, batch) {
    const out = (t) => (batch ? console.log(String(t).replace(/\x1b\[[0-9;]*m/g, '')) : this._out(t));
    const [head, ...rest] = line.trim().split(/\s+/);
    const arg = rest.join(' ');
    switch (head.toLowerCase()) {
      case '\\q': case '\\quit': case '\\exit': case 'exit': case 'quit':
        if (batch) return 'quit';
        this._quit(); break;
      case '\\c': case '\\clear':
        if (!batch) this._clearScreen(); break;
      case '\\db': return out(`current database: ${CYAN}${this.dbName}${RESET}`);
      case '\\use': {
        if (!arg) return out('usage: \\use <name>');
        if (!this._engines.has(arg)) this._engines.set(arg, this._openEngine(arg));
        this.engine = this._engines.get(arg);
        this.dbName = arg;
        return out(`switched to database: ${CYAN}${arg}${RESET}`);
      }
      case '\\tables': {
        const meta = this.engine._meta && this.engine._meta.tables ? Object.keys(this.engine._meta.tables) : [];
        const runtime = Object.keys(this.engine._tables || {});
        const tables = [...new Set([...meta, ...runtime])];
        if (tables.length === 0) return out('(no tables)');
        return out(renderTable(['Table'], tables.map((t) => [t]), (process.stdout.columns || 120) - 4));
      }
      case '\\desc': {
        if (!arg) return out('usage: \\desc <table>');
        const schema = this.engine.getTableSchema(arg);
        if (!schema) return out(`${RED}table not found:${RESET} ${arg}`);
        return out(renderTable(['Field', 'Type'], Object.entries(schema || {}).map(([k, v]) => [k, typeof v === 'object' ? JSON.stringify(v) : String(v)]), (process.stdout.columns || 120) - 4));
      }
      case '\\help': case '\\?':
        return out(renderTable(['Command', 'Description'], META_HELP, (process.stdout.columns || 120) - 4));
      default:
        return out(`${RED}unknown meta command:${RESET} ${head} (try \\help)`);
    }
    return null;
  }
}

function createTUI(options) {
  return new TUIShell(options || {});
}

module.exports = { TUIShell, createTUI, renderTable, wswidth, pad };