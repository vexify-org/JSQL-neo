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
const bigintJson = require('./bigint_json');

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
  // #235：NULL 与空串必须可区分（MySQL 约定 NULL 写 \N）；字面量 \N 反向转义
  if (v === null || v === undefined) return '\\N';
  if (v === '\\N') return '\\\\N';
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

function parseValue(str, type) {
  if (str === '\\\\N') return '\\N';   // 字面量 \N 的转义形式
  if (str === '\\N') return null;   // #235：显式 NULL 标记
  if (str === null || str === undefined) return null;
  const t = String(type || 'string').toLowerCase();
  if (str === '') return (t === 'string' || t === 'text' || t === 'varchar' || t === 'char') ? '' : null;
  if (t === 'integer' || t === 'int' || t === 'bigint') {
    const s = str.trim();
    if (!/^[-+]?\d+$/.test(s)) return str;
    try {
      const b = BigInt(s);
      // #235：>2^53 用 BigInt 精确保留，不能先过 Number
      return (b >= BigInt(Number.MIN_SAFE_INTEGER) && b <= BigInt(Number.MAX_SAFE_INTEGER)) ? Number(b) : b;
    } catch (e) { return str; }
  }
  if (t === 'float' || t === 'number' || t === 'numeric' || t === 'decimal') return Number.isFinite(Number(str)) ? Number(str) : str;
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
  // 带 BOM 的 UTF-8 文件：去掉 BOM，否则首列表头会变成 \uFEFFid
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
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
  const lines = [csvLine(columns, columns)];
  for (const r of rows) lines.push(csvLine(r, columns));
  return lines.join('\n') + '\n';
}

function csvLine(row, columns) {
  const escape = (v) => {
    const s = serializeValue(v);
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  return columns.map((c, i) => escape(Array.isArray(row) ? row[i] : row[c])).join(',');
}

/**
 * 分页遍历整表，避免 `find(table, {}, { limit: 1e9 })` 把整表读进内存。
 * onRow 每批回调一次（rows 数组）。
 */
async function iterateTable(engine, table, opts, onRows) {
  const chunkSize = opts.chunkSize != null ? opts.chunkSize : DEFAULT_CHUNK_SIZE;
  if (!Number.isInteger(chunkSize) || chunkSize < 1) throw new Error('chunkSize must be a positive integer');
  const maxRows = opts.maxRows == null ? Infinity : opts.maxRows;
  let offset = 0;
  let total = 0;
  for (;;) {
    const rows = await engine.find(table, {}, { limit: chunkSize, offset });
    if (!Array.isArray(rows) || rows.length === 0) break;
    if (rows.length > chunkSize) throw new Error('engine.find() ignored the limit option');
    total += rows.length;
    if (total > maxRows) throw new Error(`export exceeded maxRows limit of ${maxRows}`);
    await onRows(rows);
    offset += rows.length;
    if (rows.length < chunkSize) break;
  }
  return total;
}

function writeChunk(stream, text) {
  return new Promise((resolve, reject) => {
    stream.write(text, (err) => (err ? reject(err) : resolve()));
  });
}

function closeStream(stream) {
  return new Promise((resolve, reject) => {
    stream.once('error', reject);
    stream.end(() => resolve());
  });
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
    try { tables = bigintJson.parse(data); }
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
  const result = { created, inserted };
  for (const [name, t] of Object.entries(tables)) {
    if (!t || !t.schema) continue;
    if (engine.hasTable(name)) {
      if (!overwrite) throw new Error(`Table '${name}' already exists; pass { overwrite: true } to replace it`);
      await engine.dropTable(name);
    }
    await engine.createTable(name, normalizeSchema(t.schema));
    created.push(name);
    if (Array.isArray(t.rows) && t.rows.length > 0) {
      // #454：只保留目标 schema 内的列，schema 外的幽灵字段不得写进存储行。
      const schemaCols = new Set(Object.keys(normalizeSchema(t.schema)));
      const ghostCols = new Set();
      // 分块 insert —— 避免全量 rows.map 先攒再 insert
      const chunkSize = opts.chunkSize != null ? opts.chunkSize : DEFAULT_CHUNK_SIZE;
      for (let i = 0; i < t.rows.length; i += chunkSize) {
        const chunk = t.rows.slice(i, i + chunkSize).map(r => {
          const out = {};
          for (const k of Object.keys(r)) {
            if (schemaCols.has(k)) out[k] = r[k];
            else ghostCols.add(k);
          }
          return out;
        });
        const ids = await engine.insert(name, chunk);
        inserted += Array.isArray(ids) ? ids.length : chunk.length;
      }
      if (ghostCols.size > 0) {
        (result.warnings = result.warnings || []).push({
          kind: 'unknownColumn',
          columns: [...ghostCols].slice(0, 50)
        });
        if (opts.strictColumns) throw new Error(`importFromJSON: columns not in schema: ${[...ghostCols].join(', ')}`);
      }
    }
  }
  return result;
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
  // #454：按目标表 schema 做白名单投影；schema 外的未知列不得写进存储行。
  const liveSchema = schema || await engine.getTableSchema(table);
  const schemaCols = liveSchema ? new Set(Object.keys(liveSchema)) : new Set();
  const chunkSize = opts.chunkSize != null ? opts.chunkSize : DEFAULT_CHUNK_SIZE;
  let inserted = 0;
  // #362：行宽与表头不一致此前完全静默 —— 多出来的字段被丢掉，缺的列补 NULL，
  // 导入后行数对得上、数据却缺一块。这里统计并按 strictRows 决定是否中止。
  const warnings = [];
  let rowNo = start;
  // 不攒 dataRows 全量，边解析边分块写入 —— 避免 2M 行全在内存里
  for (let i = start; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    const dataRows = chunk.map(raw => {
      rowNo++;
      if (raw.length !== columns.length) {
        const kind = raw.length > columns.length ? 'extra' : 'missing';
        const n = Math.abs(raw.length - columns.length);
        if (warnings.length < 50) warnings.push({ row: rowNo, kind, count: n, expected: columns.length, actual: raw.length });
        if (opts.strictRows) throw new Error(`CSV row ${rowNo}: expected ${columns.length} fields, got ${raw.length}`);
      }
      const row = {};
      for (let j = 0; j < columns.length; j++) {
        if (liveSchema && !schemaCols.has(columns[j])) {
          // #454：schema 外的幽灵列丢弃，记入 warnings（与 #362 行宽告警同一通道）。
          if (warnings.length < 50) warnings.push({ row: rowNo, kind: 'unknownColumn', column: columns[j] });
          if (opts.strictColumns) throw new Error(`CSV row ${rowNo}: column '${columns[j]}' is not in table schema`);
          continue;
        }
        const type = liveSchema && liveSchema[columns[j]] ? liveSchema[columns[j]].type : 'string';
        row[columns[j]] = parseValue(raw[j], type);
      }
      if (row.id === null || row.id === undefined || row.id === '') delete row.id;
      return row;
    });
    const ids = await engine.insert(table, dataRows);
    inserted += Array.isArray(ids) ? ids.length : dataRows.length;
  }
  const out = { inserted };
  if (warnings.length > 0) out.warnings = warnings;
  return out;
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

async function exportToFile(engine, table, filePath, opts = {}) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext !== '.json' && ext !== '.csv') {
    throw new Error('Unsupported export format (use .json or .csv): ' + filePath);
  }
  const schema = await engine.getTableSchema(table);
  if (!schema) throw new Error(`Table '${table}' does not exist`);
  const columns = Object.keys(schema);
  const stream = fs.createWriteStream(filePath, { encoding: 'utf8' });
  // 防止磁盘写满等异步错误在 write 回调之外变成未捕获异常
  stream.on('error', () => {});
  let bytes = 0;
  const write = async (text) => {
    bytes += Buffer.byteLength(text, 'utf8');
    await writeChunk(stream, text);
  };
  try {
    if (ext === '.json') {
      await write(
        '{\n  "table": ' + bigintJson.stringify(table) +
        ',\n  "schema": ' + bigintJson.stringify(schema, 2) +
        ',\n  "rows": [\n'
      );
      let first = true;
      await iterateTable(engine, table, opts, async (rows) => {
        let buf = '';
        for (const row of rows) {
          buf += (first ? '    ' : ',\n    ') + bigintJson.stringify(row);
          first = false;
        }
        await write(buf);
      });
      await write('\n  ]\n}\n');
    } else {
      await write(csvLine(columns, columns) + '\n');
      await iterateTable(engine, table, opts, async (rows) => {
        let buf = '';
        for (const row of rows) buf += csvLine(row, columns) + '\n';
        await write(buf);
      });
    }
    await closeStream(stream);
    return bytes;
  } catch (e) {
    stream.destroy();
    try { fs.unlinkSync(filePath); } catch (_) { /* ignore */ }
    throw e;
  }
}

module.exports = {
  normalizeSchema,
  parseCSV,
  toCSV,
  csvLine,
  iterateTable,
  exportTableToJSON,
  exportAllToJSON,
  importFromJSON,
  exportTableToCSV,
  importFromCSV,
  importDump,
  importDumpFile,
  exportToFile,
};
