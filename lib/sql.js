class SQLToken {
  constructor(type, value, pos) {
    this.type = type;   // 'keyword' | 'ident' | 'number' | 'string' | 'op' | 'eof'
    this.value = value;
    this.pos = pos;
  }
}

const KEYWORDS = new Set([
  'CREATE', 'TABLE', 'DROP', 'INSERT', 'INTO', 'VALUES', 'SELECT', 'FROM',
  'WHERE', 'UPDATE', 'SET', 'DELETE', 'AND', 'OR', 'NOT', 'NULL', 'IS',
  'LIKE', 'IN', 'LIMIT', 'OFFSET', 'ORDER', 'BY', 'ASC', 'DESC', 'PRIMARY',
  'KEY', 'AUTO_INCREMENT', 'INTEGER', 'INT', 'BIGINT', 'STRING', 'TEXT',
  'FLOAT', 'DOUBLE', 'REAL', 'BOOLEAN', 'BOOL', 'DATE', 'DATETIME',
  'TIMESTAMP', 'ANY', 'OBJECT', 'ARRAY', 'BEGIN', 'COMMIT', 'ROLLBACK',
  'TRANSACTION', 'WORK', 'COUNT', 'SUM', 'AVG', 'MIN', 'MAX', 'AS', 'UNIQUE',
  'NOTNULL', 'DEFAULT', 'IF', 'EXISTS', 'DISTINCT', 'SHOW', 'USE', 'TABLES',
  'DATABASES', 'DESCRIBE', 'DESC'
]);

function tokenize(sql) {
  const tokens = [];
  let i = 0;
  const n = sql.length;

  while (i < n) {
    const c = sql[i];

    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { i++; continue; }

    if (c === '-' && sql[i + 1] === '-') {
      while (i < n && sql[i] !== '\n') i++;
      continue;
    }
    if (c === '#' || (c === '/' && sql[i + 1] === '*')) {
      if (c === '#') { while (i < n && sql[i] !== '\n') i++; continue; }
      i += 2;
      while (i + 1 < n && !(sql[i] === '*' && sql[i + 1] === '/')) i++;
      i += 2;
      continue;
    }

    if (c === "'" || c === '"') {
      const quote = c;
      let j = i + 1;
      let str = '';
      while (j < n) {
        if (sql[j] === '\\' && j + 1 < n) {
          const esc = sql[j + 1];
          const map = { n: '\n', t: '\t', r: '\r', '0': '\0', "'": "'", '"': '"', '\\': '\\' };
          str += map[esc] !== undefined ? map[esc] : esc;
          j += 2;
        } else if (sql[j] === quote) {
          break;
        } else {
          str += sql[j];
          j++;
        }
      }
      tokens.push(new SQLToken('string', str, i));
      i = j + 1;
      continue;
    }

    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(sql[i + 1] || ''))) {
      let j = i;
      let isFloat = false;
      while (j < n && /[0-9.]/.test(sql[j])) {
        if (sql[j] === '.') isFloat = true;
        j++;
      }
      if (sql[j] === 'e' || sql[j] === 'E') {
        j++;
        if (sql[j] === '+' || sql[j] === '-') j++;
        while (j < n && /[0-9]/.test(sql[j])) j++;
        isFloat = true;
      }
      const raw = sql.slice(i, j);
      tokens.push(new SQLToken('number', isFloat ? parseFloat(raw) : parseInt(raw, 10), i));
      i = j;
      continue;
    }

    if (/[a-zA-Z_$]/.test(c)) {
      let j = i;
      while (j < n && /[a-zA-Z0-9_$]/.test(sql[j])) j++;
      const word = sql.slice(i, j);
      const upper = word.toUpperCase();
      tokens.push(new SQLToken(KEYWORDS.has(upper) ? 'keyword' : 'ident', upper === word ? word : word, i));
      if (KEYWORDS.has(upper)) {
        tokens[tokens.length - 1].value = upper;
        tokens[tokens.length - 1].isKeyword = true;
      }
      i = j;
      continue;
    }

    if (c === '`') {
      let j = i + 1;
      while (j < n && sql[j] !== '`') j++;
      tokens.push(new SQLToken('ident', sql.slice(i + 1, j), i));
      i = j + 1;
      continue;
    }

    const two = sql.slice(i, i + 2);
    if (two === '<=' || two === '>=' || two === '!=' || two === '<>' || two === '==') {
      tokens.push(new SQLToken('op', two, i));
      i += 2;
      continue;
    }

    if ('=<>+-*/(),.;'.includes(c)) {
      tokens.push(new SQLToken('op', c, i));
      i++;
      continue;
    }

    throw new Error(`Unexpected character '${c}' at position ${i}`);
  }

  tokens.push(new SQLToken('eof', null, n));
  return tokens;
}

class Parser {
  constructor(tokens) {
    this.tokens = tokens;
    this.pos = 0;
  }

  peek(offset = 0) { return this.tokens[this.pos + offset]; }

  next() { return this.tokens[this.pos++]; }

  expect(type, value) {
    const t = this.next();
    if (t.type !== type || (value !== undefined && t.value !== value)) {
      throw new Error(`Expected ${value || type} but got '${t.value}' at position ${t.pos}`);
    }
    return t;
  }

  expectKeyword(kw) {
    const t = this.next();
    if (t.type !== 'keyword' || t.value !== kw) {
      throw new Error(`Expected ${kw} but got '${t.value}' at position ${t.pos}`);
    }
    return t;
  }

  isKeyword(kw, offset = 0) {
    const t = this.peek(offset);
    return t.type === 'keyword' && t.value === kw;
  }

  parseStatement() {
    const t = this.peek();
    if (t.type === 'eof') return null;
    if (t.type !== 'keyword') throw new Error(`Expected SQL statement, got '${t.value}'`);

    switch (t.value) {
      case 'CREATE': return this.parseCreateTable();
      case 'DROP': return this.parseDropTable();
      case 'INSERT': return this.parseInsert();
      case 'SELECT': return this.parseSelect();
      case 'UPDATE': return this.parseUpdate();
      case 'DELETE': return this.parseDelete();
      case 'BEGIN': this.expectKeyword('BEGIN'); this.optionalTransaction(); return { type: 'begin' };
      case 'COMMIT': this.expectKeyword('COMMIT'); this.optionalTransaction(); return { type: 'commit' };
      case 'ROLLBACK': this.expectKeyword('ROLLBACK'); this.optionalTransaction(); return { type: 'rollback' };
      case 'SHOW': return this.parseShow();
      case 'DESCRIBE': case 'DESC': return this.parseDescribe();
      case 'USE': return this.parseUse();
      default: throw new Error(`Unsupported statement: ${t.value}`);
    }
  }

  optionalTransaction() {
    if (this.isKeyword('TRANSACTION')) this.next();
    if (this.isKeyword('WORK')) this.next();
  }

  parseTableName() {
    const t = this.next();
    if (t.type !== 'ident') throw new Error(`Expected table name, got '${t.value}'`);
    return t.value;
  }

  parseCreateTable() {
    this.expectKeyword('CREATE');
    this.expectKeyword('TABLE');
    let ifNotExists = false;
    if (this.isKeyword('IF')) {
      this.expectKeyword('IF'); this.expectKeyword('NOT'); this.expectKeyword('EXISTS');
      ifNotExists = true;
    }
    const name = this.parseTableName();
    this.expect('op', '(');

    const schema = {};
    let hasPk = false;
    while (true) {
      const t = this.peek();
      if (t.type === 'keyword' && (t.value === 'PRIMARY' || t.value === 'UNIQUE')) {
        if (t.value === 'PRIMARY') {
          this.expectKeyword('PRIMARY'); this.expectKeyword('KEY');
          this.expect('op', '(');
          const pkCol = this.parseTableName();
          this.expect('op', ')');
          if (schema[pkCol]) schema[pkCol].primaryKey = true;
          hasPk = true;
        } else {
          this.expectKeyword('UNIQUE');
          this.expect('op', '(');
          const uCol = this.parseTableName();
          this.expect('op', ')');
          if (schema[uCol]) schema[uCol].unique = true;
        }
      } else if (t.type === 'keyword' && t.value === 'CONSTRAINT') {
        this.expectKeyword('CONSTRAINT');
        this.next();
      } else if (t.type === 'eof' || (t.type === 'op' && t.value === ')')) {
        break;
      } else {
        const col = this.parseTableName();
        const def = this.parseColumnDef();
        schema[col] = def;
        if (def.primaryKey) hasPk = true;
      }

      const sep = this.peek();
      if (sep.type === 'op' && sep.value === ',') { this.next(); continue; }
      if (sep.type === 'op' && sep.value === ')') break;
      throw new Error(`Expected ',' or ')' in CREATE TABLE, got '${sep.value}'`);
    }
    this.expect('op', ')');
    this.optionalTailSemicolon();

    if (!hasPk && schema.id === undefined) {
      schema.id = { type: 'integer', primaryKey: true, autoIncrement: true };
    }
    return { type: 'createTable', name, schema, ifNotExists };
  }

  parseColumnDef() {
    const def = {};
    const typeTok = this.next();
    if (typeTok.type !== 'keyword') throw new Error(`Expected column type, got '${typeTok.value}'`);
    const type = typeTok.value.toLowerCase();
    const typeMap = {
      integer: 'integer', int: 'integer', bigint: 'integer', tinyint: 'integer', smallint: 'integer',
      string: 'string', text: 'string', varchar: 'string', char: 'string',
      float: 'number', double: 'number', real: 'number', numeric: 'number', decimal: 'number',
      boolean: 'boolean', bool: 'boolean',
      date: 'date', datetime: 'datetime', timestamp: 'timestamp',
      any: 'any', object: 'object', json: 'object', array: 'array'
    };
    const mapped = typeMap[type];
    if (!mapped) throw new Error(`Unsupported column type: ${typeTok.value}`);
    def.type = mapped;

    while (true) {
      const t = this.peek();
      if (t.type === 'keyword') {
        switch (t.value) {
          case 'PRIMARY':
            this.next(); this.expectKeyword('KEY'); def.primaryKey = true; def.unique = true; break;
          case 'KEY':
            this.next(); def.primaryKey = true; def.unique = true; break;
          case 'AUTO_INCREMENT':
            this.next(); def.autoIncrement = true; break;
          case 'UNIQUE':
            this.next(); def.unique = true; break;
          case 'NOT':
            this.next(); this.expectKeyword('NULL'); def.required = true; break;
          case 'NULL':
            this.next(); break;
          case 'DEFAULT':
            this.next(); def.default = this.parseValue(); break;
          default:
            return def;
        }
      } else {
        return def;
      }
    }
  }

  parseInsert() {
    this.expectKeyword('INSERT');
    this.expectKeyword('INTO');
    const name = this.parseTableName();
    let columns = null;
    if (this.peek().type === 'op' && this.peek().value === '(') {
      this.next();
      columns = [];
      while (true) {
        columns.push(this.parseTableName());
        if (this.peek().value === ',') { this.next(); continue; }
        break;
      }
      this.expect('op', ')');
    }
    this.expectKeyword('VALUES');
    const rows = [];
    while (true) {
      this.expect('op', '(');
      const values = [];
      while (true) {
        values.push(this.parseValue());
        if (this.peek().value === ',') { this.next(); continue; }
        break;
      }
      this.expect('op', ')');
      rows.push(values);
      if (this.peek().type === 'op' && this.peek().value === ',') { this.next(); continue; }
      break;
    }
    this.optionalTailSemicolon();

    const dataRows = rows.map(vals => {
      const row = {};
      if (columns) {
        columns.forEach((c, idx) => { row[c] = vals[idx] !== undefined ? vals[idx] : null; });
      } else {
        vals.forEach((v, idx) => { row['col' + (idx + 1)] = v; });
      }
      return row;
    });
    return { type: 'insert', name, dataRows };
  }

  parseValue() {
    const t = this.next();
    if (t.type === 'number' || t.type === 'string') return t.value;
    if (t.type === 'keyword' && t.value === 'NULL') return null;
    if (t.type === 'op' && t.value === '-') {
      const num = this.next();
      if (num.type !== 'number') throw new Error('Expected number after -');
      return -num.value;
    }
    if (t.type === 'op' && t.value === '+') {
      const num = this.next();
      if (num.type !== 'number') throw new Error('Expected number after +');
      return num.value;
    }
    throw new Error(`Expected value, got '${t.value}'`);
  }

  parseSelect() {
    this.expectKeyword('SELECT');
    let distinct = false;
    if (this.isKeyword('DISTINCT')) { this.next(); distinct = true; }

    const columns = [];
    let aggregate = null;
    while (true) {
      const t = this.peek();
      if (t.type === 'keyword' && t.value === 'COUNT') {
        this.next();
        this.expect('op', '(');
        this.expect('op', '*');
        this.expect('op', ')');
        aggregate = { type: 'COUNT' };
        if (this.isKeyword('AS')) { this.next(); aggregate.alias = this.parseTableName(); }
        columns.push({ expr: null, aggregate: true });
      } else if (t.type === 'keyword' && ['SUM', 'AVG', 'MIN', 'MAX'].includes(t.value)) {
        this.next();
        const fn = t.value;
        this.expect('op', '(');
        const col = this.parseTableName();
        this.expect('op', ')');
        aggregate = { type: fn, column: col };
        columns.push({ expr: col, aggregate: fn, column: col });
      } else if (t.type === 'op' && t.value === '*') {
        this.next();
        columns.push({ expr: '*' });
      } else if (t.type === 'number' || t.type === 'string') {
        this.next();
        let alias = null;
        if (this.isKeyword('AS')) { this.next(); alias = this.parseTableName(); }
        columns.push({ expr: null, literal: t.value, alias });
      } else {
        const col = this.parseColumnRef();
        let alias = null;
        if (this.isKeyword('AS')) { this.next(); alias = this.parseTableName(); }
        columns.push({ expr: col, alias });
      }
      if (this.peek().type === 'op' && this.peek().value === ',') { this.next(); continue; }
      break;
    }

    let table = null;
    if (this.isKeyword('FROM')) {
      this.next();
      table = this.parseTableName();
    }
    let where = null;
    if (this.isKeyword('WHERE')) { this.next(); where = this.parseExpr(); }
    let orderBy = null;
    if (this.isKeyword('ORDER')) {
      this.expectKeyword('ORDER'); this.expectKeyword('BY');
      orderBy = [];
      while (true) {
        const col = this.parseColumnRef();
        let dir = 'asc';
        if (this.isKeyword('ASC')) { this.next(); }
        else if (this.isKeyword('DESC')) { this.next(); dir = 'desc'; }
        orderBy.push({ column: col, dir });
        if (this.peek().type === 'op' && this.peek().value === ',') { this.next(); continue; }
        break;
      }
    }
    let limit = null, offset = 0;
    if (this.isKeyword('LIMIT')) {
      this.next();
      limit = this.parseValue();
      if (this.isKeyword('OFFSET')) { this.next(); offset = this.parseValue(); }
      else if (this.peek().type === 'op' && this.peek().value === ',') { this.next(); offset = limit; limit = this.parseValue(); }
    }
    this.optionalTailSemicolon();

    return { type: 'select', columns, aggregate, distinct, table, where, orderBy, limit, offset };
  }

  parseColumnRef() {
    const t = this.next();
    if (t.type !== 'ident') throw new Error(`Expected column name, got '${t.value}'`);
    return t.value;
  }

  parseUpdate() {
    this.expectKeyword('UPDATE');
    const table = this.parseTableName();
    this.expectKeyword('SET');
    const assignments = [];
    while (true) {
      const col = this.parseColumnRef();
      this.expect('op', '=');
      assignments.push([col, this.parseValue()]);
      if (this.peek().type === 'op' && this.peek().value === ',') { this.next(); continue; }
      break;
    }
    let where = null;
    if (this.isKeyword('WHERE')) { this.next(); where = this.parseExpr(); }
    this.optionalTailSemicolon();
    return { type: 'update', table, assignments, where };
  }

  parseDelete() {
    this.expectKeyword('DELETE');
    this.expectKeyword('FROM');
    const table = this.parseTableName();
    let where = null;
    if (this.isKeyword('WHERE')) { this.next(); where = this.parseExpr(); }
    this.optionalTailSemicolon();
    return { type: 'delete', table, where };
  }

  parseDropTable() {
    this.expectKeyword('DROP');
    this.expectKeyword('TABLE');
    let ifExists = false;
    if (this.isKeyword('IF')) {
      this.expectKeyword('IF'); this.expectKeyword('EXISTS'); ifExists = true;
    }
    const table = this.parseTableName();
    this.optionalTailSemicolon();
    return { type: 'dropTable', table, ifExists };
  }

  parseShow() {
    this.expectKeyword('SHOW');
    if (this.isKeyword('TABLES')) { this.next(); this.optionalTailSemicolon(); return { type: 'showTables' }; }
    if (this.isKeyword('DATABASES')) { this.next(); this.optionalTailSemicolon(); return { type: 'showDatabases' }; }
    throw new Error('Unsupported SHOW statement');
  }

  parseDescribe() {
    this.next();
    const table = this.parseTableName();
    this.optionalTailSemicolon();
    return { type: 'describe', table };
  }

  parseUse() {
    this.expectKeyword('USE');
    const db = this.parseTableName();
    this.optionalTailSemicolon();
    return { type: 'use', database: db };
  }

  optionalTailSemicolon() {
    if (this.peek().type === 'op' && this.peek().value === ';') this.next();
  }

  parseExpr() {
    return this.parseOr();
  }

  parseOr() {
    let left = this.parseAnd();
    while (this.isKeyword('OR')) {
      this.next();
      const right = this.parseAnd();
      left = { type: 'or', left, right };
    }
    return left;
  }

  parseAnd() {
    let left = this.parseNot();
    while (this.isKeyword('AND')) {
      this.next();
      const right = this.parseNot();
      left = { type: 'and', left, right };
    }
    return left;
  }

  parseNot() {
    if (this.isKeyword('NOT')) {
      this.next();
      return { type: 'not', expr: this.parseNot() };
    }
    if (this.peek().type === 'op' && this.peek().value === '(') {
      this.next();
      const e = this.parseExpr();
      this.expect('op', ')');
      return e;
    }
    return this.parseComparison();
  }

  parseOperand() {
    const t = this.next();
    if (t.type === 'ident') return { type: 'column', name: t.value };
    if (t.type === 'number' || t.type === 'string') return { type: 'value', value: t.value };
    if (t.type === 'keyword' && t.value === 'NULL') return { type: 'value', value: null };
    if (t.type === 'op' && (t.value === '-' || t.value === '+')) {
      const num = this.next();
      if (num.type !== 'number') throw new Error('Expected number after sign');
      return { type: 'value', value: t.value === '-' ? -num.value : num.value };
    }
    throw new Error(`Expected value or column, got '${t.value}'`);
  }

  parseComparison() {
    const left = this.parseOperand();
    const t = this.peek();

    if (t.type === 'keyword' && t.value === 'IS') {
      this.next();
      const not = this.isKeyword('NOT');
      if (not) this.next();
      this.expectKeyword('NULL');
      return { type: 'isNull', operand: left, not: !!not };
    }

    if (t.type === 'keyword' && t.value === 'IN') {
      this.next();
      this.expect('op', '(');
      const list = [];
      while (true) {
        list.push(this.parseValue());
        if (this.peek().type === 'op' && this.peek().value === ',') { this.next(); continue; }
        break;
      }
      this.expect('op', ')');
      return { type: 'in', operand: left, list };
    }

    if (t.type === 'keyword' && t.value === 'LIKE') {
      this.next();
      const pattern = this.parseValue();
      return { type: 'like', operand: left, pattern };
    }

    if (t.type === 'op' && ['=', '!=', '<>', '<', '<=', '>', '>='].includes(t.value)) {
      this.next();
      const right = this.parseOperand();
      return { type: 'compare', op: t.value === '<>' ? '!=' : t.value, left, right };
    }

    throw new Error(`Expected comparison operator, got '${t.value}'`);
  }
}

const OPERATORS = {
  '=': (a, b) => a === b,
  '==': (a, b) => a === b,
  '!=': (a, b) => a !== b,
  '<': (a, b) => a < b,
  '<=': (a, b) => a <= b,
  '>': (a, b) => a > b,
  '>=': (a, b) => a >= b
};

function resolveOperand(operand, row) {
  if (operand.type === 'value') return operand.value;
  return row[operand.name];
}

function likeMatch(value, pattern) {
  if (typeof value !== 'string') return false;
  const regex = pattern
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/%/g, '.*')
    .replace(/_/g, '.');
  return new RegExp('^' + regex + '$', 'i').test(value);
}

function evaluateExpr(expr, row) {
  if (expr === null || expr === undefined) return false;
  switch (expr.type) {
    case 'and': return evaluateExpr(expr.left, row) && evaluateExpr(expr.right, row);
    case 'or': return evaluateExpr(expr.left, row) || evaluateExpr(expr.right, row);
    case 'not': return !evaluateExpr(expr.expr, row);
    case 'compare': {
      const l = resolveOperand(expr.left, row);
      const r = resolveOperand(expr.right, row);
      if (expr.op === '=') return l === r || (l === null && r === null) || (l !== null && r !== null && String(l) === String(r));
      if (l === null || r === null) return false;
      const fn = OPERATORS[expr.op];
      return typeof l === 'number' && typeof r === 'number' ? fn(l, r) : fn(String(l), String(r));
    }
    case 'isNull': {
      const v = resolveOperand(expr.operand, row);
      const isNull = v === null || v === undefined;
      return expr.not ? !isNull : isNull;
    }
    case 'in': {
      const v = resolveOperand(expr.operand, row);
      return expr.list.some(x => x === v || String(x) === String(v));
    }
    case 'like': return likeMatch(resolveOperand(expr.operand, row), expr.pattern);
    default: return false;
  }
}

function normalizeRow(row) {
  if (row && typeof row === 'object' && row.fields && typeof row.fields === 'object') {
    return { ...row.fields, id: row.id };
  }
  return row;
}

class SQLExecutor {
  constructor(engine) {
    this.engine = engine;
  }

  async execute(statement) {
    switch (statement.type) {
      case 'createTable': {
        const r = await this.engine.createTable(statement.name, statement.schema);
        return { ok: true, type: 'createTable', table: statement.name, affectedRows: 0, result: r };
      }
      case 'dropTable': {
        await this.engine.dropTable(statement.table);
        return { ok: true, type: 'dropTable', table: statement.table, affectedRows: 0 };
      }
      case 'insert': {
        const ids = await this.engine.insert(statement.name, statement.dataRows);
        await this.engine.flush();
        return { ok: true, type: 'insert', table: statement.name, affectedRows: statement.dataRows.length, insertId: Array.isArray(ids) && ids.length > 0 ? ids[0] : null, ids };
      }
      case 'select': {
        let schema = null;
        let all;
        if (statement.table === null) {
          all = [{ _virtual: true }];
        } else {
          if (this.engine.hasTable && !this.engine.hasTable(statement.table)) {
            throw new Error(`Table '${statement.table}' does not exist`);
          }
          schema = this.engine.getTableSchema
            ? await this.engine.getTableSchema(statement.table)
            : (this.engine._schemas ? this.engine._schemas[statement.table] : null);
          if (!schema) {
            throw new Error(`Table '${statement.table}' does not exist`);
          }
          all = (await this.engine.find(statement.table, {}, { limit: 1e9, offset: 0 })).map(normalizeRow);
        }

        let rows = all;
        if (statement.where) {
          rows = rows.filter(r => evaluateExpr(statement.where, r));
        }
        if (statement.distinct) {
          const seen = new Set();
          rows = rows.filter(r => {
            const key = JSON.stringify(statement.columns.map(c => r[c.expr]));
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
          });
        }
        if (statement.orderBy) {
          const cmp = (a, b) => {
            for (const o of statement.orderBy) {
              const av = a[o.column], bv = b[o.column];
              if (av === bv || (av === undefined && bv === undefined)) continue;
              if (av === undefined || av === null) return o.dir === 'asc' ? -1 : 1;
              if (bv === undefined || bv === null) return o.dir === 'asc' ? 1 : -1;
              const r = typeof av === 'number' && typeof bv === 'number' ? av - bv : String(av).localeCompare(String(bv));
              if (r !== 0) return o.dir === 'asc' ? r : -r;
            }
            return 0;
          };
          rows = rows.slice().sort(cmp);
        }

        if (statement.aggregate) {
          const agg = statement.aggregate;
          const rowsOnly = rows;
          const aggName = agg.alias || (agg.type === 'COUNT' ? 'COUNT(*)' : agg.type + '(' + agg.column + ')');
          if (agg.type === 'COUNT') {
            return { ok: true, type: 'select', table: statement.table, columns: [aggName], rows: [[rowsOnly.length]], aggregate: agg };
          }
          const values = rowsOnly.map(r => r[agg.column]).filter(v => v !== null && v !== undefined);
          let value;
          if (agg.type === 'SUM') value = values.reduce((s, v) => s + (typeof v === 'number' ? v : Number(v) || 0), 0);
          else if (agg.type === 'AVG') value = values.length ? values.reduce((s, v) => s + (typeof v === 'number' ? v : Number(v) || 0), 0) / values.length : null;
          else if (agg.type === 'MIN') value = values.length ? Math.min(...values.map(v => Number(v))) : null;
          else if (agg.type === 'MAX') value = values.length ? Math.max(...values.map(v => Number(v))) : null;
          return { ok: true, type: 'select', table: statement.table, columns: [aggName], rows: [[value]], aggregate: agg };
        }

        if (statement.limit !== null) {
          const start = statement.offset || 0;
          rows = rows.slice(start, start + statement.limit);
        }

        if (statement.columns.length === 1 && statement.columns[0].expr === '*') {
          const schemaKeys = schema ? Object.keys(schema) : [];
          const pkCols = schemaKeys.filter(k => schema[k].primaryKey);
          const pk = pkCols.length > 0 ? pkCols[0] : (schemaKeys[0] || 'id');
          const cols = schema ? [pk, ...schemaKeys.filter(k => k !== pk)] : Object.keys(all[0] || {});
          return { ok: true, type: 'select', table: statement.table, columns: cols, rows: rows.map(r => cols.map(c => r[c])), raw: rows };
        }

        const cols = statement.columns.map(c => c.alias || (c.literal !== undefined ? (c.expr === null ? String(c.literal) : c.expr) : c.expr));
        const mapped = rows.map(r => statement.columns.map(c => {
          if (c.expr === '*') return null;
          if (c.literal !== undefined) return c.literal;
          return r[c.expr];
        }));
        return { ok: true, type: 'select', table: statement.table, columns: cols, rows: mapped, raw: rows };
      }
      case 'update': {
        const all = (await this.engine.find(statement.table, {}, { limit: 1e9, offset: 0 })).map(normalizeRow);
        let count = 0;
        for (const row of all) {
          if (!statement.where || evaluateExpr(statement.where, row)) {
            const id = row.id !== undefined ? row.id : (row.id);
            if (id !== undefined) {
              const data = {};
              for (const [col, val] of statement.assignments) data[col] = val;
              this.engine.updateById(statement.table, id, data);
              count++;
            }
          }
        }
        await this.engine.flush();
        return { ok: true, type: 'update', table: statement.table, affectedRows: count };
      }
      case 'delete': {
        const all = (await this.engine.find(statement.table, {}, { limit: 1e9, offset: 0 })).map(normalizeRow);
        const ids = [];
        for (const row of all) {
          if (!statement.where || evaluateExpr(statement.where, row)) {
            if (row.id !== undefined) ids.push(row.id);
          }
        }
        if (ids.length > 0) {
          if (this.engine.removeByIds) this.engine.removeByIds(statement.table, ids);
          else for (const id of ids) this.engine.removeById(statement.table, id);
        }
        await this.engine.flush();
        return { ok: true, type: 'delete', table: statement.table, affectedRows: ids.length };
      }
      case 'begin': return { ok: true, type: 'begin' };
      case 'commit': return { ok: true, type: 'commit' };
      case 'rollback': return { ok: true, type: 'rollback' };
      case 'showTables': {
        const tables = this.engine.getTables ? this.engine.getTables() : (this.engine.tables ? this.engine.tables() : []);
        return { ok: true, type: 'showTables', columns: ['Tables'], rows: tables.map(t => [t]) };
      }
      case 'showDatabases':
        return { ok: true, type: 'showDatabases', columns: ['Database'], rows: [['jsql']] };
      case 'describe': {
        const schema = this.engine.getTableSchema ? await this.engine.getTableSchema(statement.table) : null;
        if (!schema) throw new Error(`Table '${statement.table}' does not exist`);
        const rows = Object.entries(schema).map(([col, def]) => [col, def.type, def.primaryKey ? 'PRI' : '', def.autoIncrement ? 'auto_increment' : null, def.default !== undefined ? def.default : null]);
        return { ok: true, type: 'describe', table: statement.table, columns: ['Field', 'Type', 'Key', 'Extra', 'Default'], rows };
      }
      case 'use':
        return { ok: true, type: 'use', database: statement.database };
      default:
        throw new Error(`Unsupported statement type: ${statement.type}`);
    }
  }
}

function splitStatements(sql) {
  const statements = [];
  let current = '';
  let inStr = null;
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    if (inStr) {
      current += c;
      if (c === '\\' && i + 1 < sql.length) { current += sql[i + 1]; i += 2; continue; }
      if (c === inStr) inStr = null;
      i++;
      continue;
    }
    if (c === "'" || c === '"') { inStr = c; current += c; i++; continue; }
    if (c === ';') {
      if (current.trim()) statements.push(current.trim());
      current = '';
      i++;
      continue;
    }
    current += c;
    i++;
  }
  if (current.trim()) statements.push(current.trim());
  return statements;
}

function parseSQL(sql) {
  const tokens = tokenize(sql);
  const parser = new Parser(tokens);
  const stmt = parser.parseStatement();
  if (parser.peek().type !== 'eof') {
    throw new Error(`Unexpected token '${parser.peek().value}' after statement`);
  }
  return stmt;
}

async function executeSQL(engine, sql) {
  const statements = splitStatements(sql);
  const executor = new SQLExecutor(engine);
  const results = [];
  for (const stmtSql of statements) {
    const stmt = parseSQL(stmtSql);
    results.push(await executor.execute(stmt));
  }
  return results.length === 1 ? results[0] : results;
}

module.exports = { tokenize, parseSQL, executeSQL, SQLExecutor, splitStatements };
