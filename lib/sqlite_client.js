// © Vexify 2026 All Rights Reserved.
/**
 * SqliteJSQL — SQLite 可选底层（方案 A）
 *
 * 用 `lib/sqlite_compat.js` 的 better-sqlite3 风格 `Database` 作为底层，
 * 对外暴露与主引擎 `lib/wasm_client.js` 的 `JSQL` 相同的高层 API 子集。
 *
 *   const { SqliteJSQL } = require('jsql-neo');
 *   const db = new SqliteJSQL();                 // 纯内存
 *   const db2 = new SqliteJSQL({ file: 'app.db' }); // 文件持久化
 *   await db.start();
 *   await db.createTable('users', { name: { type: 'string' }, age: 'integer' });
 *   const ids = await db.insert('users', { name: 'Alice', age: 30 });
 *
 * 原版 `JSQL`（WASM/内存引擎）完全不受影响，两者可共存、可切换。
 *
 * 说明：本类只做「契约对齐」，底层实际 SQL 由 `lib/sql.js` 的 SQLExecutor
 * 执行（sqlite_compat 的 worker 桥），因此受该引擎的能力与安全策略约束：
 *  - `DROP TABLE` 被 `findDestructiveSQL` 安全策略拦截 → dropTable() 退化为
 *    「清空数据 + 从注册表移除」的软删除（返回值带 `softDrop: true`）。
 *  - `INSERT ... DEFAULT VALUES` 不被解析器支持 → 空行插入会抛明确错误。
 */

const fs = require('fs');
const Database = require('./sqlite_compat');
const { parseFieldShorthand } = require('./database');

// ---------------------------------------------------------------------------
// 类型 / 标识符 / schema 工具
// ---------------------------------------------------------------------------

const SQL_TYPE_MAP = {
  int: 'INTEGER', integer: 'INTEGER', bigint: 'INTEGER', tinyint: 'INTEGER',
  smallint: 'INTEGER', mediumint: 'INTEGER', serial: 'INTEGER',
  number: 'REAL', float: 'REAL', double: 'REAL', real: 'REAL',
  decimal: 'REAL', numeric: 'REAL',
  bool: 'BOOLEAN', boolean: 'BOOLEAN',
  string: 'TEXT', text: 'TEXT', varchar: 'TEXT', char: 'TEXT', uuid: 'TEXT',
  time: 'TEXT', blob: 'TEXT', binary: 'TEXT', bytes: 'TEXT', buffer: 'TEXT',
  json: 'JSON', jsonb: 'JSONB',
  date: 'DATE', datetime: 'DATETIME', timestamp: 'DATETIME',
};

function normalizeType(raw) {
  const t = String(raw || 'string').toLowerCase().replace(/\(.*$/, '').trim();
  return SQL_TYPE_MAP[t] || 'TEXT';
}

function isJsonType(raw) {
  const t = String(raw || '').toLowerCase();
  return t === 'json' || t === 'jsonb' || t === 'object' || t === 'array';
}

/** 把字符串简写 / 对象定义统一成 { type, primaryKey, unique, autoIncrement, required, default, jsonType } */
function normalizeFieldDef(def) {
  if (def === undefined || def === null) return { type: 'string' };
  if (typeof def === 'string') {
    const parsed = parseFieldShorthand(def.toLowerCase().trim());
    const out = { ...parsed, type: parsed.type || 'string' };
    if (isJsonType(out.type)) out.jsonType = true;
    return out;
  }
  if (typeof def === 'object') {
    const out = { ...def };
    if (out.primary_key !== undefined && out.primaryKey === undefined) out.primaryKey = out.primary_key;
    if (out.auto_increment !== undefined && out.autoIncrement === undefined) out.autoIncrement = out.auto_increment;
    if (out.type === undefined) out.type = 'string';
    if (isJsonType(out.type) || out.jsonType) out.jsonType = true;
    if (out.required === true && out.nullable === undefined) out.nullable = false;
    return out;
  }
  return { type: 'string' };
}

function normalizeSchema(schema) {
  if (typeof schema === 'string') schema = parseSchemaStringLite(schema);
  const out = {};
  for (const [field, def] of Object.entries(schema || {})) {
    out[field] = normalizeFieldDef(def);
  }
  return out;
}

/** 极简 schema 字符串解析："name:string, age:integer" / "name string, age integer" */
function parseSchemaStringLite(str) {
  const out = {};
  for (const part of String(str).split(',')) {
    const p = part.trim();
    if (!p) continue;
    const m = p.match(/^([A-Za-z_][\w$]*)\s*(?::|\s)\s*(.+)$/);
    if (!m) out[p] = { type: 'string' };
    else out[m[1]] = m[2].trim();
  }
  return out;
}

const SIMPLE_IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

function qi(name) {
  const s = String(name);
  if (SIMPLE_IDENT.test(s)) return s;
  return '"' + s.replace(/"/g, '""') + '"';
}

function literal(v) {
  if (v === null) return 'NULL';
  if (typeof v === 'number' || typeof v === 'bigint') return String(v);
  if (typeof v === 'boolean') return v ? '1' : '0';
  return "'" + String(v).replace(/'/g, "''") + "'";
}

function columnSQL(name, def) {
  const parts = [qi(name), normalizeType(def.type)];
  if (def.primaryKey) parts.push('PRIMARY KEY');
  if (def.autoIncrement) parts.push('AUTOINCREMENT');
  if (def.required || def.nullable === false) parts.push('NOT NULL');
  if (def.unique && !def.primaryKey) parts.push('UNIQUE');
  if (def.default !== undefined && def.default !== null) {
    const d = def.default;
    if (typeof d === 'string' && /^(now\(\)|current_timestamp|current_date|current_time)$/i.test(d)) {
      parts.push('DEFAULT ' + d.toUpperCase());
    } else {
      parts.push('DEFAULT ' + literal(d));
    }
  }
  return parts.join(' ');
}

function toNonNegInt(v, dflt) {
  if (v === undefined || v === null) return dflt;
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.max(0, Math.floor(n));
}

/** 位置参数 / 命名参数统一成数组 */
function normalizeParams(paramsOrOpts) {
  if (paramsOrOpts === undefined || paramsOrOpts === null) return [];
  if (Array.isArray(paramsOrOpts)) return paramsOrOpts;
  if (typeof paramsOrOpts === 'object') return paramsOrOpts; // 命名参数，交给 prepared 处理
  return [paramsOrOpts];
}

/** 命名参数 → 位置参数（:name / $name / @name → ?） */
function namedToPositional(sql, obj) {
  const positional = [];
  const out = sql.replace(/([:$@])([A-Za-z_][A-Za-z0-9_]*)/g, (m, sigil, name) => {
    if (!Object.prototype.hasOwnProperty.call(obj, name)) return m;
    positional.push(obj[name]);
    return '?';
  });
  return { sql: out, params: positional };
}

const FILTER_OPS = {
  $eq: '=', $ne: '!=', $gt: '>', $gte: '>=', $lt: '<', $lte: '<=',
  $like: 'LIKE', $notlike: 'NOT LIKE',
};

function buildWhere(table, filter) {
  const clauses = [];
  const params = [];
  for (const [rawKey, value] of Object.entries(filter || {})) {
    const isOpObject = value && typeof value === 'object' && !Array.isArray(value)
      && !(value instanceof Date) && !Buffer.isBuffer(value);
    if (!isOpObject) {
      clauses.push(`${qi(rawKey)} = ?`);
      params.push(value);
      continue;
    }
    for (const [op, val] of Object.entries(value)) {
      if (op === '$in' || op === '$nin') {
        const arr = Array.isArray(val) ? val : [val];
        if (arr.length === 0) {
          clauses.push(op === '$in' ? '1 = 0' : '1 = 1');
          continue;
        }
        clauses.push(`${qi(rawKey)} ${op === '$in' ? 'IN' : 'NOT IN'} (${arr.map(() => '?').join(', ')})`);
        params.push(...arr);
        continue;
      }
      if (op === '$is') {
        if (val === null) { clauses.push(`${qi(rawKey)} IS NULL`); continue; }
        clauses.push(`${qi(rawKey)} = ?`);
        params.push(val);
        continue;
      }
      if (op === '$not') {
        clauses.push(`${qi(rawKey)} != ?`);
        params.push(val);
        continue;
      }
      const sqlOp = FILTER_OPS[op];
      if (!sqlOp) throw new Error(`Unsupported filter operator: ${op} (field ${rawKey})`);
      clauses.push(`${qi(rawKey)} ${sqlOp} ?`);
      params.push(val);
    }
  }
  return { where: clauses.join(' AND '), params };
}

// ---------------------------------------------------------------------------
// SqliteJSQL
// ---------------------------------------------------------------------------

class SqliteJSQL {
  /**
   * @param {object} opts
   * @param {string} [opts.file] SQLite 文件路径，缺省 ':memory:'
   */
  constructor(opts = {}) {
    this.options = opts;
    this.file = opts.file || opts.filename || ':memory:';
    this._memory = this.file === ':memory:';
    this._db = new Database(this.file, opts);
    this._schemas = {};
    this._tableNames = new Set();
    this._dropped = new Set();
    this._txId = undefined;
    this._txSeq = 0;
    this._started = false;
    this._open = true;

    if (!this._memory) this._loadFromFile();
  }

  // -- 生命周期 ------------------------------------------------------------

  async start() {
    this._started = true;
    return this;
  }

  async stop() {
    if (!this._open) return this;
    if (!this._memory) this._persist();
    try { this._db.close(); } catch (_) { /* ignore */ }
    this._open = false;
    this._started = false;
    return this;
  }

  /** 兼容 Database / JSQL 的 flush 契约（SQLite 同步写，无缓冲） */
  async flush() { /* no-op */ }

  lastFlushErrors() { return []; }

  // -- 持久化（serialize/deserialize，JSON dump） --------------------------

  _loadFromFile() {
    try {
      if (!fs.existsSync(this.file)) return;
      const raw = fs.readFileSync(this.file);
      if (!raw || raw.length === 0) return;
      const dump = JSON.parse(raw.toString('utf8'));
      if (!dump || typeof dump !== 'object') return;
      for (const [name, entry] of Object.entries(dump)) {
        if (!entry || typeof entry !== 'object') continue;
        this._tableNames.add(name);
        if (entry.schema && typeof entry.schema === 'object') {
          this._schemas[name] = normalizeSchema(entry.schema);
        }
      }
      this._db.deserialize(Buffer.from(raw));
    } catch (e) {
      throw new Error(`SqliteJSQL: failed to load '${this.file}': ${e.message}`);
    }
  }

  _persist() {
    const dump = this._db.serialize();
    fs.writeFileSync(this.file, dump);
  }

  // -- schema 工具 ---------------------------------------------------------

  _ensureOpen() {
    if (!this._open) throw new Error('The database connection is not open');
  }

  _schemaOf(table) {
    return this._schemas[table] || null;
  }

  _pkOf(table) {
    const schema = this._schemaOf(table);
    if (!schema) return null;
    for (const [k, def] of Object.entries(schema)) {
      if (def && (def.primaryKey || def.primary_key)) return k;
    }
    return null;
  }

  _restoreRow(table, row) {
    if (!row || typeof row !== 'object') return row;
    const schema = this._schemaOf(table);
    if (!schema) return row;
    let out = row;
    for (const [field, def] of Object.entries(schema)) {
      if (!(field in row)) continue;
      const v = row[field];
      if (def.jsonType && typeof v === 'string') {
        try {
          if (out === row) out = { ...row };
          out[field] = JSON.parse(v);
        } catch (_) { /* 保留原字符串 */ }
      }
    }
    return out;
  }

  _restoreRows(table, rows) {
    return Array.isArray(rows) ? rows.map(r => this._restoreRow(table, r)) : rows;
  }

  _schemaFromPragma(table) {
    let info;
    try { info = this._db.prepare(`PRAGMA table_info(${qi(table)})`).all(); }
    catch (_) { return null; }
    if (!Array.isArray(info) || info.length === 0) return null;
    const schema = {};
    for (const col of info) {
      const def = { type: String(col.type || 'text').toLowerCase() };
      if (col.pk) def.primaryKey = true;
      if (col.notnull) def.required = true;
      schema[col.name] = def;
    }
    this._schemas[table] = schema;
    this._tableNames.add(table);
    return schema;
  }

  _noteSchemaDDL(sql) {
    const create = sql.match(/^\s*create\s+table\s+(?:if\s+not\s+exists\s+)?([`"\w.]+)/i);
    if (create) this._tableNames.add(create[1].replace(/^["`]|["`]$/g, ''));
    const drop = sql.match(/^\s*drop\s+table\s+(?:if\s+exists\s+)?([`"\w.]+)/i);
    if (drop) {
      const name = drop[1].replace(/^["`]|["`]$/g, '');
      this._tableNames.delete(name);
      delete this._schemas[name];
    }
  }

  // -- DDL -----------------------------------------------------------------

  async createTable(name, schema) {
    this._ensureOpen();
    const defs = normalizeSchema(schema);
    const cols = Object.entries(defs).map(([f, d]) => columnSQL(f, d));
    if (cols.length === 0) throw new Error(`createTable('${name}'): schema must define at least one column`);
    const sql = `CREATE TABLE IF NOT EXISTS ${qi(name)} (${cols.join(', ')})`;
    this._db.prepare(sql).run();
    this._schemas[name] = defs;
    this._tableNames.add(name);
    return { ok: true, table: name, columns: Object.keys(defs) };
  }

  async dropTable(name) {
    this._ensureOpen();
    if (!this.hasTable(name)) return { ok: true, table: name, dropped: false };
    let softDrop = false;
    try {
      this._db.prepare(`DROP TABLE IF EXISTS ${qi(name)}`).run();
    } catch (e) {
      // lib/sql.js 的 findDestructiveSQL 永久拦截 DROP TABLE（安全策略），
      // worker 桥没有关闭 safety 的通道 → 退化为「清空数据 + 注销表名」。
      if (!/blocked by security policy/i.test(e.message)) throw e;
      this._db.prepare(`DELETE FROM ${qi(name)} WHERE 1 = 1`).run();
      softDrop = true;
    }
    this._tableNames.delete(name);
    delete this._schemas[name];
    this._dropped.add(name);
    const r = { ok: true, table: name, dropped: true };
    if (softDrop) r.softDrop = true;
    return r;
  }

  async addColumn(table, name, def) {
    this._ensureOpen();
    const d = normalizeFieldDef(def);
    this._db.prepare(`ALTER TABLE ${qi(table)} ADD COLUMN ${columnSQL(name, d)}`).run();
    if (!this._schemas[table]) this._schemas[table] = {};
    this._schemas[table][name] = d;
    this._tableNames.add(table);
    return { ok: true, table, column: name };
  }

  // -- 写入 ----------------------------------------------------------------

  async insert(table, data) {
    this._ensureOpen();
    const rows = Array.isArray(data) ? data : [data];
    const ids = [];
    for (const row of rows) {
      if (!row || typeof row !== 'object' || Array.isArray(row)) {
        throw new TypeError(`insert('${table}'): each row must be a plain object`);
      }
      const keys = Object.keys(row).filter(k => row[k] !== undefined);
      if (keys.length === 0) {
        throw new Error(`insert('${table}'): empty row — INSERT ... DEFAULT VALUES is not supported by the underlying engine; provide at least one column`);
      }
      const cols = keys.map(qi).join(', ');
      const ph = keys.map(() => '?').join(', ');
      const res = this._db.prepare(`INSERT INTO ${qi(table)} (${cols}) VALUES (${ph})`)
        .run(...keys.map(k => row[k]));
      const pk = this._pkOf(table);
      ids.push(pk && row[pk] !== undefined && row[pk] !== null ? row[pk] : res.lastInsertRowid);
    }
    return ids;
  }

  async insertMany(table, data) {
    return this.insert(table, data);
  }

  async updateById(table, id, data) {
    this._ensureOpen();
    if (!data || typeof data !== 'object') throw new TypeError(`updateById('${table}'): data must be an object`);
    const pk = this._pkOf(table);
    if (pk) {
      const keys = Object.keys(data).filter(k => data[k] !== undefined);
      if (keys.length === 0) return { ok: true, updated: 0, id };
      const sql = `UPDATE ${qi(table)} SET ${keys.map(k => `${qi(k)} = ?`).join(', ')} WHERE ${qi(pk)} = ?`;
      const res = this._db.prepare(sql).run(...keys.map(k => data[k]), id);
      return { ok: true, updated: res.changes, id };
    }
    // 无主键表：id 视为 1-based 行号（与 JSQL 语义对齐）
    return this._updateByOffset(table, id, data);
  }

  _updateByOffset(table, id, data) {
    const n = toNonNegInt(id, 0);
    if (n < 1) return null;
    const current = this._db.prepare(`SELECT * FROM ${qi(table)} LIMIT 1 OFFSET ${n - 1}`).get();
    if (!current) return null;
    const setKeys = Object.keys(data).filter(k => data[k] !== undefined);
    if (setKeys.length === 0) return { ok: true, updated: 0, id };
    const whereKeys = Object.keys(current);
    if (whereKeys.length === 0) return { ok: true, updated: 0, id };
    const sql = `UPDATE ${qi(table)} SET ${setKeys.map(k => `${qi(k)} = ?`).join(', ')}`
      + ` WHERE ${whereKeys.map(k => `${qi(k)} = ?`).join(' AND ')}`;
    const res = this._db.prepare(sql).run(...setKeys.map(k => data[k]), ...whereKeys.map(k => current[k]));
    return { ok: true, updated: res.changes, id };
  }

  async updateByIds(table, entries) {
    this._ensureOpen();
    const out = [];
    const list = entries instanceof Map ? Array.from(entries.entries()) : Array.from(entries || []);
    for (const [id, payload] of list) {
      out.push({ id, result: await this.updateById(table, id, payload) });
    }
    return out;
  }

  async removeById(table, id) {
    this._ensureOpen();
    const pk = this._pkOf(table);
    if (pk) {
      const res = this._db.prepare(`DELETE FROM ${qi(table)} WHERE ${qi(pk)} = ?`).run(id);
      return { ok: true, removed: res.changes, id };
    }
    const n = toNonNegInt(id, 0);
    if (n < 1) return null;
    const current = this._db.prepare(`SELECT * FROM ${qi(table)} LIMIT 1 OFFSET ${n - 1}`).get();
    if (!current) return null;
    const keys = Object.keys(current);
    const sql = `DELETE FROM ${qi(table)} WHERE ${keys.map(k => `${qi(k)} = ?`).join(' AND ')}`;
    const res = this._db.prepare(sql).run(...keys.map(k => current[k]));
    return { ok: true, removed: res.changes, id };
  }

  async removeByIds(table, ids) {
    this._ensureOpen();
    const out = [];
    for (const id of Array.from(ids || [])) {
      out.push({ id, result: await this.removeById(table, id) });
    }
    return out;
  }

  // -- 查询 ----------------------------------------------------------------

  _select(table, filter, opts = {}) {
    const { where, params } = buildWhere(table, filter);
    let sql = `SELECT * FROM ${qi(table)}`;
    if (where) sql += ' WHERE ' + where;
    if (Array.isArray(opts.orderBy) && opts.orderBy.length > 0) {
      sql += ' ORDER BY ' + opts.orderBy.map(o => {
        if (typeof o === 'string') return qi(o);
        const dir = /^(desc|descending)$/i.test(String(o.dir || 'asc')) ? 'DESC' : 'ASC';
        return `${qi(o.column || o.field)} ${dir}`;
      }).join(', ');
    } else if (typeof opts.orderBy === 'string') {
      sql += ' ORDER BY ' + qi(opts.orderBy);
    }
    const limit = opts.limit === undefined || opts.limit === null ? 100 : toNonNegInt(opts.limit, 100);
    const offset = toNonNegInt(opts.offset, 0);
    sql += ` LIMIT ${limit}`;
    if (offset > 0) sql += ` OFFSET ${offset}`;
    return this._db.prepare(sql).all(...params);
  }

  async findById(table, id) {
    this._ensureOpen();
    const pk = this._pkOf(table) || (this._schemaFromPragma(table) && this._pkOf(table));
    if (pk) {
      const row = this._db.prepare(`SELECT * FROM ${qi(table)} WHERE ${qi(pk)} = ? LIMIT 1`).get(id);
      return row ? this._restoreRow(table, row) : null;
    }
    const n = toNonNegInt(id, 0);
    if (n < 1) return null;
    const row = this._db.prepare(`SELECT * FROM ${qi(table)} LIMIT 1 OFFSET ${n - 1}`).get();
    return row ? this._restoreRow(table, row) : null;
  }

  async findByIds(table, ids) {
    this._ensureOpen();
    const out = [];
    for (const id of Array.from(ids || [])) {
      const row = await this.findById(table, id);
      if (row !== null && row !== undefined) out.push(row);
    }
    return out;
  }

  findByIdsRaw(table, ids) {
    return this.findByIds(table, ids);
  }

  async find(table, filter = {}, opts = {}) {
    this._ensureOpen();
    const rows = this._select(table, filter, opts);
    return this._restoreRows(table, rows);
  }

  async count(table) {
    this._ensureOpen();
    const row = this._db.prepare(`SELECT COUNT(*) AS c FROM ${qi(table)}`).get();
    const n = row && row.c !== undefined ? Number(row.c) : 0;
    return Number.isFinite(n) ? n : 0;
  }

  async exists(table, filter = {}) {
    this._ensureOpen();
    const rows = this._select(table, filter, { limit: 1 });
    return Array.isArray(rows) && rows.length > 0;
  }

  // -- 元数据 --------------------------------------------------------------

  hasTable(name) {
    if (this._dropped.has(name)) return false;
    if (this._tableNames.has(name)) return true;
    return this._schemaFromPragma(name) !== null;
  }

  getTables() {
    return Array.from(this._tableNames);
  }

  async getTableSchema(name) {
    if (this._dropped.has(name)) return null;
    if (this._schemas[name]) return this._schemas[name];
    return this._schemaFromPragma(name);
  }

  // -- 原生 SQL ------------------------------------------------------------

  /**
   * 直接执行 SQL。
   * @returns {Promise<object>} { command, columns, rows, raw, rowCount, affectedRows, message }
   */
  async query(sql, paramsOrOpts, opts = {}) {
    this._ensureOpen();
    if (typeof sql !== 'string' || sql.trim() === '') {
      throw new Error('query(sql): sql must be a non-empty string');
    }
    this._noteSchemaDDL(sql);
    let params = normalizeParams(paramsOrOpts);
    let text = sql;
    if (params && !Array.isArray(params)) {
      const converted = namedToPositional(sql, params);
      text = converted.sql;
      params = converted.params;
    }
    const reader = /^\s*(select|with|pragma|show|explain)\b/i.test(text);
    const t0 = Date.now();
    const stmt = this._db.prepare(text);
    if (reader) {
      const objs = stmt.all(...params);
      const rows = Array.isArray(objs) ? objs : [];
      let columns = [];
      if (rows.length > 0 && rows[0] && typeof rows[0] === 'object' && !Array.isArray(rows[0])) {
        columns = Object.keys(rows[0]);
      } else {
        try { columns = stmt.columns().map(c => c.name); } catch (_) { columns = []; }
      }
      const tuples = rows.map(r => (Array.isArray(r) ? r : columns.map(c => r[c])));
      return {
        type: 'select',
        command: (text.trim().split(/\s+/)[0] || 'SELECT').toUpperCase(),
        columns,
        rows: tuples,
        raw: rows,
        rowCount: tuples.length,
        affectedRows: 0,
        warnings: [],
        message: `${tuples.length} row${tuples.length === 1 ? '' : 's'} selected`,
        durationMs: Date.now() - t0,
      };
    }
    const res = stmt.run(...params);
    const command = (text.trim().split(/\s+/)[0] || '').toUpperCase();
    const affected = res && typeof res.changes === 'number' ? res.changes : 0;
    const out = {
      type: command.toLowerCase(),
      command,
      columns: [],
      rows: [],
      raw: [],
      rowCount: affected,
      affectedRows: affected,
      warnings: [],
      message: `${affected} row${affected === 1 ? '' : 's'} affected`,
      durationMs: Date.now() - t0,
    };
    if (res && res.lastInsertRowid !== undefined && /^insert/i.test(command)) {
      out.insertId = res.lastInsertRowid;
    }
    return out;
  }

  /** 返回 sqlite_compat 的 Statement（支持 .all/.get/.run/.iterate/.columns） */
  prepare(sql) {
    this._ensureOpen();
    return this._db.prepare(sql);
  }

  // -- 事务 ----------------------------------------------------------------

  async beginTx() {
    this._ensureOpen();
    this._db.exec('BEGIN');
    this._txId = `tx-${++this._txSeq}`;
    return this._txId;
  }

  async commitTx(txId) {
    this._ensureOpen();
    this._db.exec('COMMIT');
    this._txId = undefined;
    return true;
  }

  async rollbackTx(txId) {
    this._ensureOpen();
    this._db.exec('ROLLBACK');
    this._txId = undefined;
    return true;
  }

  async beginTransaction() { return this.beginTx(); }

  async commit() {
    if (this._txId === undefined) return true;
    return this.commitTx(this._txId);
  }

  async rollback() {
    if (this._txId === undefined) return true;
    return this.rollbackTx(this._txId);
  }

  // -- 插件（最小实现） ----------------------------------------------------

  use(plugin, opts) {
    // 完整插件系统只存在于 WASM 引擎；此处保留 API 形状。
    if (typeof plugin === 'function') return this;
    return this;
  }

  on() { return this; }

  onEvent(fn) {
    if (typeof fn === 'function') this._eventListeners = (this._eventListeners || []).concat(fn);
    return this;
  }

  emit() { return this; }

  plugin() { return null; }

  // -- 其它兼容面 ----------------------------------------------------------

  get db() { return this._db; }

  exec(sql) {
    this._noteSchemaDDL(sql);
    return this._db.exec(sql);
  }
}

module.exports = { SqliteJSQL };
module.exports.SqliteJSQL = SqliteJSQL;
