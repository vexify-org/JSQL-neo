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
const { parseFieldShorthand } = require('./database');

// 体积护栏（CWE-770）：与 lib/sql.js 的 DEFAULT_MAX_SQL_LENGTH 同风格。
// 可用 opts.maxInputSize / opts.maxRows 覆盖；传 Infinity 关闭；chunkSize 控制每批 insert 行数。
const DEFAULT_MAX_CSV_LENGTH = 64 * 1024 * 1024;  // 64 MiB
const DEFAULT_MAX_JSON_LENGTH = 64 * 1024 * 1024;
const DEFAULT_MAX_SQL_LENGTH = 64 * 1024 * 1024;  // 与 lib/sql.js 保持一致
const DEFAULT_MAX_ROWS = 2_000_000;             // 200 万行
const DEFAULT_MAX_STATEMENTS = 200_000;          // dump 文件最多允许 20 万条语句
const DEFAULT_CHUNK_SIZE = 1000;

function normalizeSchema(schema) {
  const out = {};
  for (const [name, def] of Object.entries(schema || {})) {
    const d = typeof def === 'string' ? parseFieldShorthand(def.toLowerCase()) : { ...def };
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

function parseCSV(text, opts = {}) {
  if (typeof text !== 'string') {
    throw new Error('parseCSV: csv must be a string');
  }
  const maxLen = opts.maxInputSize == null ? DEFAULT_MAX_CSV_LENGTH : opts.maxInputSize;
  if (typeof maxLen === 'number' && Number.isFinite(maxLen) && text.length > maxLen) {
    throw new Error(
      `CSV text too large: ${text.length} chars exceeds limit of ${maxLen} ` +
      `(raise opts.maxInputSize to allow larger input)`
    );
  }
  const maxRows = opts.maxRows == null ? DEFAULT_MAX_ROWS : opts.maxRows;
  const isFiniteMaxRows = typeof maxRows === 'number' && Number.isFinite(maxRows);

  const rows = [];
  // 把 `field += c` 改为数组收集中间 join —— 与 splitStatements 同修 O(n²)
  let fieldBuf = [];
  const flushField = () => { const s = fieldBuf.join(''); fieldBuf.length = 0; return s; };
  let row = [];
  const flushRow = () => {
    const r = row;
    row = [];
    rows.push(r);
    return r;
  };
  let inQuotes = false;
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { fieldBuf.push('"'); i += 2; continue; }
        inQuotes = false;
        i++;
        continue;
      }
      fieldBuf.push(c);
      i++;
      continue;
    }
    if (c === '"' && fieldBuf.length === 0) { inQuotes = true; i++; continue; }
    if (c === ',') { row.push(flushField()); i++; continue; }
    if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(flushField());
      if (row.length > 1 || row[0] !== '') {
        if (isFiniteMaxRows && rows.length + 1 > maxRows) {
          throw new Error(
            `CSV too many rows: ${rows.length + 1} exceeds limit of ${maxRows} ` +
            `(raise opts.maxRows or split the file)`
          );
        }
        flushRow();
      } else {
        row = [];
      }
      i++;
      continue;
    }
    fieldBuf.push(c);
    i++;
  }
  if (fieldBuf.length > 0 || row.length > 0) {
    row.push(flushField());
    if (row.length > 1 || row[0] !== '') {
      if (isFiniteMaxRows && rows.length + 1 > maxRows) {
        throw new Error(
          `CSV too many rows: ${rows.length + 1} exceeds limit of ${maxRows} ` +
          `(raise opts.maxRows or split the file)`
        );
      }
      flushRow();
    }
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

async function importFromJSON(engine, data, opts = {}) {
  const overwrite = !!(opts && opts.overwrite);
  let tables;
  if (typeof data === 'string') {
    // JSON.parse 吞超长输入也会打爆堆 —— 先加体积护栏，错误带位置
    const maxLen = opts.maxInputSize == null ? DEFAULT_MAX_JSON_LENGTH : opts.maxInputSize;
    if (typeof maxLen === 'number' && Number.isFinite(maxLen) && data.length > maxLen) {
      throw new Error(
        `JSON text too large: ${data.length} chars exceeds limit of ${maxLen} ` +
        `(raise opts.maxInputSize to allow larger input)`
      );
    }
    try { tables = JSON.parse(data); }
    catch (e) {
      throw new Error(`importFromJSON: invalid JSON: ${e.message}`);
    }
  } else {
    tables = data;
  }
  // 兼容单表形状：exportTableToJSON 返回 { table, schema, rows }
  if (tables && !Array.isArray(tables) && typeof tables === 'object'
      && tables.table && tables.schema && !tables[tables.table]) {
    const single = tables;
    tables = {};
    tables[single.table] = single;
  }
  const created = [];
  let inserted = 0;
  for (const [name, t] of Object.entries(tables)) {
    if (!t || !t.schema) continue;
    if (engine.hasTable(name)) {
      if (!overwrite) throw new Error(`Table '${name}' already exists; pass { overwrite: true } to replace it`);
      await engine.dropTable(name);
    }
    await engine.createTable(name, normalizeSchema(t.schema));
    created.push(name);
    if (Array.isArray(t.rows) && t.rows.length > 0) {
      // 分块 insert —— 避免全量 rows.map 先攒再 insert
      const chunkSize = opts.chunkSize != null ? opts.chunkSize : DEFAULT_CHUNK_SIZE;
      for (let i = 0; i < t.rows.length; i += chunkSize) {
        const chunk = t.rows.slice(i, i + chunkSize).map(r => ({ ...r }));
        const ids = await engine.insert(name, chunk);
        inserted += Array.isArray(ids) ? ids.length : chunk.length;
      }
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
  // parseCSV 内已有体积/行数护栏，这里传 opts.maxInputSize / opts.maxRows
  const rows = parseCSV(csv, opts);
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
  const chunkSize = opts.chunkSize != null ? opts.chunkSize : DEFAULT_CHUNK_SIZE;
  let inserted = 0;
  // 不攒 dataRows 全量，边解析边分块写入 —— 避免 2M 行全在内存里
  for (let i = start; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    const dataRows = chunk.map(raw => {
      const row = {};
      for (let j = 0; j < columns.length; j++) {
        const type = schema && schema[columns[j]] ? schema[columns[j]].type : 'string';
        row[columns[j]] = parseValue(raw[j], type);
      }
      if (row.id === null || row.id === undefined || row.id === '') delete row.id;
      return row;
    });
    const ids = await engine.insert(table, dataRows);
    inserted += Array.isArray(ids) ? ids.length : dataRows.length;
  }
  return { inserted };
}

/* ---------- mysqldump ---------- */

async function importDump(engine, sqlText, opts = {}) {
  // splitStatements 自身有体积护栏，但这里要让用户能通过 opts.maxInputSize 覆盖，
  // 还要额外加「语句数量」护栏 —— 64 MiB 里可能塞几百万条小 INSERT，每条都合法但合起来打爆堆。
  const maxLen = opts.maxInputSize == null ? DEFAULT_MAX_SQL_LENGTH : opts.maxInputSize;
  const splitOpts = { maxLength: maxLen };
  const statements = splitStatements(sqlText, splitOpts);

  const maxStmts = opts.maxStatements == null ? DEFAULT_MAX_STATEMENTS : opts.maxStatements;
  if (typeof maxStmts === 'number' && Number.isFinite(maxStmts) && statements.length > maxStmts) {
    throw new Error(
      `SQL dump too many statements: ${statements.length} exceeds limit of ${maxStmts} ` +
      `(raise opts.maxStatements or split the dump file)`
    );
  }

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
  // 先看文件大小再决定是否读 —— 避免 fs.readFileSync 把超大 dump 一次性吃进堆
  const maxLen = opts.maxInputSize == null ? DEFAULT_MAX_SQL_LENGTH : opts.maxInputSize;
  const stat = fs.statSync(filePath);
  if (typeof maxLen === 'number' && Number.isFinite(maxLen) && stat.size > maxLen) {
    throw new Error(
      `Dump file too large: ${stat.size} bytes exceeds limit of ${maxLen} ` +
      `(raise opts.maxInputSize or split the file)`
    );
  }
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
