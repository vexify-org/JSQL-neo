/*
 * Migration tools: mysqldump import, JSON import/export, CSV import/export.
 *
 * Works against any engine exposing:
 *   hasTable(name) / getTableSchema(name) / find(name, {}, {limit, offset})
 *   createTable(name, schema) / insert(name, rows) / executeSQL(sql, ...)
 * (Database instances and the jsql-neo MySQL server engine both qualify.)
 */

const fs = require('fs');
const path = require('path');
const { splitStatements, executeSQL } = require('./sql');

function normalizeSchema(schema) {
  const out = {};
  for (const [name, def] of Object.entries(schema || {})) {
    const d = typeof def === 'string' ? { type: def } : { ...def };
    if (!d.type) d.type = typeof d === 'object' ? 'any' : 'string';
    if (d.type === 'int' || d.type === 'bigint' || d.type === 'smallint' || d.type === 'tinyint') d.type = 'integer';
    if (d.type === 'varchar' || d.type === 'text' || d.type === 'char') d.type = 'string';
    if (d.type === 'double' || d.type === 'real' || d.type === 'decimal' || d.type === 'numeric') d.type = 'float';
    if (d.type === 'bool') d.type = 'boolean';
    delete d.length;
    if (d.maxLength) { d.length = d.maxLength; delete d.maxLength; }
    out[name] = d;
  }
  return out;
}

function serializeValue(v) {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

function parseValue(str, type) {
  if (str === '' || str === null || str === undefined) return null;
  const t = String(type || 'string').toLowerCase();
  if (t === 'integer') return Number.isFinite(Number(str)) ? Math.trunc(Number(str)) : str;
  if (t === 'float' || t === 'number') return Number.isFinite(Number(str)) ? Number(str) : str;
  if (t === 'boolean') {
    const s = str.toLowerCase();
    if (['1', 'true', 'yes', 'y'].includes(s)) return true;
    if (['0', 'false', 'no', 'n'].includes(s)) return false;
    return str;
  }
  if (t === 'object' || t === 'array') {
    try { return JSON.parse(str); } catch (e) { return str; }
  }
  return str;
}

function parseCSV(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false;
        i++;
        continue;
      }
      field += c;
      i++;
      continue;
    }
    if (c === '"' && field === '') { inQuotes = true; i++; continue; }
    if (c === ',') { row.push(field); field = ''; i++; continue; }
    if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
      i++;
      continue;
    }
    field += c;
    i++;
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    if (row.length > 1 || row[0] !== '') rows.push(row);
  }
  return rows;
}

function toCSV(rows, columns) {
  const escape = (v) => {
    const s = serializeValue(v);
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const lines = [columns.map(escape).join(',')];
  for (const r of rows) {
    lines.push(columns.map(c => escape(r[c])).join(','));
  }
  return lines.join('\n') + '\n';
}

/* ---------- JSON ---------- */

async function exportTableToJSON(engine, table) {
  const schema = await engine.getTableSchema(table);
  if (!schema) throw new Error(`Table '${table}' does not exist`);
  const rows = await engine.find(table, {}, { limit: 1e9, offset: 0 });
  return { table, schema, rows };
}

async function exportAllToJSON(engine, tables) {
  const list = tables || await engine.getTables();
  const out = {};
  for (const t of list) out[t] = await exportTableToJSON(engine, t);
  return out;
}

async function importFromJSON(engine, data) {
  const tables = typeof data === 'string' ? JSON.parse(data) : data;
  const created = [];
  let inserted = 0;
  for (const [name, t] of Object.entries(tables)) {
    if (!t || !t.schema) continue;
    if (engine.hasTable(name)) await engine.dropTable(name);
    await engine.createTable(name, normalizeSchema(t.schema));
    created.push(name);
    if (Array.isArray(t.rows) && t.rows.length > 0) {
      const ids = await engine.insert(name, t.rows.map(r => ({ ...r })));
      inserted += Array.isArray(ids) ? ids.length : t.rows.length;
    }
  }
  return { created, inserted };
}

/* ---------- CSV ---------- */

async function exportTableToCSV(engine, table) {
  const schema = await engine.getTableSchema(table);
  if (!schema) throw new Error(`Table '${table}' does not exist`);
  const columns = Object.keys(schema);
  const rows = await engine.find(table, {}, { limit: 1e9, offset: 0 });
  return toCSV(rows, columns);
}

async function importFromCSV(engine, table, csv, opts = {}) {
  const schema = opts.schema || await engine.getTableSchema(table);
  const rows = parseCSV(csv);
  if (rows.length === 0) return { inserted: 0 };
  let columns;
  let start = 0;
  if (opts.header !== false) {
    columns = rows[0];
    start = 1;
  } else if (schema) {
    columns = Object.keys(schema);
  } else {
    columns = rows[0].map((_, i) => 'col' + (i + 1));
  }
  if (!engine.hasTable(table)) {
    if (!schema) {
      throw new Error(`Table '${table}' does not exist; provide opts.schema to create it`);
    }
    await engine.createTable(table, normalizeSchema(schema));
  }
  const dataRows = [];
  for (let i = start; i < rows.length; i++) {
    const row = {};
    for (let j = 0; j < columns.length; j++) {
      const type = schema && schema[columns[j]] ? schema[columns[j]].type : 'string';
      row[columns[j]] = parseValue(rows[i][j], type);
    }
    if (row.id === null || row.id === undefined || row.id === '') delete row.id;
    dataRows.push(row);
  }
  const ids = dataRows.length > 0 ? await engine.insert(table, dataRows) : [];
  return { inserted: dataRows.length, ids };
}

/* ---------- mysqldump ---------- */

async function importDump(engine, sqlText, opts = {}) {
  const statements = splitStatements(sqlText);
  const created = [];
  let inserted = 0;
  const errors = [];
  for (const raw of statements) {
    const stmt = raw.trim();
    if (!stmt) continue;
    if (stmt.startsWith('--') || stmt.startsWith('#')) continue;
    const upper = stmt.toUpperCase();
    if (upper.startsWith('LOCK ') || upper.startsWith('UNLOCK ')) continue;
    if (upper.startsWith('/*!')) continue;
    if (upper.startsWith('SET ') && opts.skipSet !== false) continue;
    try {
      const r = await executeSQL(engine, stmt, { safety: false });
      if (r && r.type === 'createTable') created.push(r.table);
      if (r && r.type === 'insert') inserted += (r.ids || []).length || r.affectedRows || 0;
    } catch (e) {
      if (opts.strict) throw e;
      errors.push({ sql: stmt.slice(0, 120), error: e.message });
    }
  }
  return { created, inserted, errors };
}

async function importDumpFile(engine, filePath, opts = {}) {
  const text = fs.readFileSync(filePath, 'utf8');
  return importDump(engine, text, opts);
}

async function exportToFile(engine, table, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  let content;
  if (ext === '.json') {
    content = JSON.stringify(await exportTableToJSON(engine, table), null, 2);
  } else if (ext === '.csv') {
    content = await exportTableToCSV(engine, table);
  } else {
    throw new Error('Unsupported export format (use .json or .csv): ' + filePath);
  }
  fs.writeFileSync(filePath, content);
  return content.length;
}

module.exports = {
  normalizeSchema,
  parseCSV,
  toCSV,
  exportTableToJSON,
  exportAllToJSON,
  importFromJSON,
  exportTableToCSV,
  importFromCSV,
  importDump,
  importDumpFile,
  exportToFile,
};
