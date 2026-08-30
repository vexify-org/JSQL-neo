const DANGEROUS_SQL = [
  { re: /^INTO$/, next: /^(OUTFILE|DUMPFILE)$/, name: 'INTO OUTFILE/DUMPFILE' },
  { re: /^LOAD$/, next: /^(FILE|DATA)$/, name: 'LOAD_FILE/LOAD DATA' },
  { re: /^LOAD_FILE$/, name: 'LOAD_FILE' },
  { re: /^LOAD_DATA$/, next: /^(INFILE)$/, name: 'LOAD DATA INFILE' },
  { re: /^SLEEP$/, name: 'SLEEP' },
  { re: /^BENCHMARK$/, name: 'BENCHMARK' },
  { re: /^GET_LOCK$/, name: 'GET_LOCK' },
  { re: /^RELEASE_LOCK$/, name: 'RELEASE_LOCK' },
  { re: /^SONAME$/, name: 'UDF SONAME' },
  { re: /^SYSEXEC$|^SYS_EXEC$/, name: 'sys_exec' },
];

function findDangerousSQL(tokens) {
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type !== 'keyword' && t.type !== 'ident') continue;
    const upper = String(t.value).toUpperCase();
    for (const d of DANGEROUS_SQL) {
      if (d.re.test(upper)) {
        if (d.next) {
          const nxt = tokens[i + 1];
          if (nxt && d.next.test(String(nxt.value).toUpperCase())) {
            return d.name;
          }
        } else {
          return d.name;
        }
      }
    }
  }
  return null;
}

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
  'KEY', 'AUTO_INCREMENT', 'AUTOINCREMENT', 'INTEGER', 'INT', 'BIGINT', 'STRING', 'TEXT',
  'VARCHAR', 'CHAR', 'FLOAT', 'DOUBLE', 'REAL', 'NUMERIC', 'DECIMAL', 'BOOLEAN', 'BOOL', 'DATE', 'DATETIME',
  'TIMESTAMP', 'ANY', 'OBJECT', 'ARRAY', 'JSON', 'SMALLINT', 'TINYINT', 'BEGIN', 'COMMIT', 'ROLLBACK',
  'START',
  'TRANSACTION', 'WORK', 'COUNT', 'SUM', 'AVG', 'MIN', 'MAX', 'AS', 'UNIQUE',
  'NOTNULL', 'DEFAULT', 'IF', 'EXISTS', 'DISTINCT', 'SHOW', 'USE', 'TABLES',
  'DATABASES', 'DATABASE', 'DESCRIBE', 'DESC', 'ON', 'DUPLICATE',
  'JOIN', 'LEFT', 'RIGHT', 'INNER', 'OUTER', 'CROSS',
  'GROUP', 'HAVING', 'UNION', 'ALL', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END',
  'BETWEEN', 'USING', 'FULL', 'UNSIGNED', 'ZEROFILL', 'TRUNCATE', 'COLLATE', 'CHARACTER',
  'ALTER', 'ADD', 'COLUMN', 'MODIFY', 'CHANGE', 'INDEX', 'FOREIGN', 'REFERENCES',
  'CONSTRAINT', 'RENAME', 'TO', 'AFTER', 'FIRST', 'ENGINE', 'AUTO_INCREMENT', 'SPATIAL',
  'REGEXP', 'TRUE', 'FALSE', 'RLIKE', 'PRAGMA', 'REPLACE', 'BLOB', 'RAISE', 'IGNORE'
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
          const map = { n: '\n', t: '\t', r: '\r', '0': '\0', "'": "'", '"': '"', '\\': '\\', b: '\b', Z: '\x1a', a: '\a' };
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

    if (c === '@') {
      let j = i;
      while (j < n && sql[j] === '@') j++;
      const ats = j - i;
      let k = j;
      while (k < n && /[A-Za-z0-9_$]/.test(sql[k])) k++;
      if (k > j) {
        tokens.push(new SQLToken('sysvar', sql.slice(j, k), i));
        if (ats > 1) i = k;
        else i = k;
        continue;
      }
      i = j;
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

  // 匹配大小写不敏感的词（无论被 tokenize 成 ident 还是 keyword）
  isWord(kw, offset = 0) {
    const t = this.peek(offset);
    return t.value !== undefined && String(t.value).toUpperCase() === kw;
  }

  parseStatement() {
    const t = this.peek();
    if (t.type === 'eof') return null;
    if (t.type !== 'keyword') throw new Error(`Expected SQL statement, got '${t.value}'`);

    switch (t.value) {
      case 'CREATE':
        if (this.isKeyword('TABLE', 1)) return this.parseCreateTable();
        if (this.isKeyword('DATABASE', 1)) return this.parseCreateDatabase();
        throw new Error('Unsupported CREATE statement');
      case 'DROP':
        if (this.isKeyword('TABLE', 1)) return this.parseDropTable();
        if (this.isKeyword('DATABASE', 1)) return this.parseDropDatabase();
        throw new Error('Unsupported DROP statement');
      case 'INSERT': return this.parseInsert();
      case 'ALTER': return this.parseAlter();
      case 'TRUNCATE': this.expectKeyword('TRUNCATE'); if (this.isKeyword('TABLE')) this.next(); return { type: 'truncate', name: this.parseTableName() };
      case 'SELECT': return this.parseSelect();
      case 'UPDATE': return this.parseUpdate();
      case 'DELETE': return this.parseDelete();
      case 'BEGIN': this.expectKeyword('BEGIN'); this.optionalTransaction(); return { type: 'begin' };
      case 'START': this.expectKeyword('START'); if (this.isKeyword('TRANSACTION')) this.next(); return { type: 'begin' };
      case 'COMMIT': this.expectKeyword('COMMIT'); this.optionalTransaction(); return { type: 'commit' };
      case 'ROLLBACK': this.expectKeyword('ROLLBACK'); this.optionalTransaction(); return { type: 'rollback' };
      case 'SHOW': return this.parseShow();
      case 'SET': return this.parseSet();
      case 'DESCRIBE': case 'DESC': return this.parseDescribe();
      case 'USE': return this.parseUse();
      case 'PRAGMA': return this.parsePragma();
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
    if (this.peek().type === 'op' && this.peek().value === '.') {
      this.next();
      const t2 = this.next();
      if (t2.type !== 'ident' && !(t2.type === 'keyword' && this._isSchemaView(t2.value))) {
        throw new Error(`Expected table name after '.', got '${t2.value}'`);
      }
      return t.value + '.' + t2.value;
    }
    return t.value;
  }

  _isSchemaView(v) {
    return ['TABLES', 'COLUMNS', 'SCHEMATA', 'STATISTICS', 'KEY_COLUMN_USAGE', 'REFERENTIAL_CONSTRAINTS', 'TABLE_CONSTRAINTS', 'VIEWS'].includes(String(v).toUpperCase());
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
          const pkCols = [this.parseTableName()];
          while (this.peek().type === 'op' && this.peek().value === ',') {
            this.next();
            pkCols.push(this.parseTableName());
          }
          this.expect('op', ')');
          for (const pkCol of pkCols) {
            if (schema[pkCol]) schema[pkCol].primaryKey = true;
          }
          hasPk = true;
        } else {
          this.expectKeyword('UNIQUE');
          this.expect('op', '(');
          const uCols = [this.parseTableName()];
          while (this.peek().type === 'op' && this.peek().value === ',') {
            this.next();
            uCols.push(this.parseTableName());
          }
          this.expect('op', ')');
          for (const uCol of uCols) {
            if (schema[uCol]) schema[uCol].unique = true;
          }
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

    // 跳过表选项: ENGINE=InnoDB, DEFAULT CHARSET=..., AUTO_INCREMENT=1, COLLATE=...（直到 ; 或语句结束）
    while (!(this.peek().type === 'eof' || (this.peek().type === 'op' && this.peek().value === ';'))) {
      this.next();
    }
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

    // 长度限制: TEXT(255) / VARCHAR(100) / INTEGER(11) ...
    if (this.peek().type === 'op' && this.peek().value === '(') {
      this.next();
      const lenTok = this.next();
      if (lenTok.type !== 'number') throw new Error(`Expected length after type '(', got '${lenTok.value}'`);
      const len = lenTok.value;
      if (this.peek().type === 'op' && this.peek().value === ',') {
        this.next();
        const decTok = this.next();
        if (decTok.type !== 'number') throw new Error(`Expected precision after ',', got '${decTok.value}'`);
        def.precision = decTok.value;
      }
      this.expect('op', ')');
      if (len > 0) {
        def.length = len;
        if (mapped === 'string') def.maxLength = len;
      }
    }

    while (true) {
      const t = this.peek();
      if (t.type === 'keyword') {
        switch (t.value) {
          case 'PRIMARY':
            this.next(); this.expectKeyword('KEY'); def.primaryKey = true; def.unique = true;
            // SQLite 语义: INTEGER PRIMARY KEY 是 rowid 别名, 自动生成
            if (mapped === 'integer') def.autoIncrement = true;
            break;
          case 'KEY':
            this.next(); def.primaryKey = true; def.unique = true;
            if (mapped === 'integer') def.autoIncrement = true;
            break;
          case 'AUTO_INCREMENT':
          case 'AUTOINCREMENT':
            this.next(); def.autoIncrement = true; break;
          case 'UNSIGNED':
          case 'ZEROFILL':
            this.next(); def.unsigned = true; break;
          case 'UNIQUE':
            this.next(); def.unique = true; break;
          case 'NOT':
            this.next(); this.expectKeyword('NULL'); def.required = true; break;
          case 'NULL':
            this.next(); break;
          case 'DEFAULT':
            this.next(); def.default = this.parseValue(); break;
          case 'COLLATE':
            this.next(); if (this.peek().type !== 'op' && this.peek().type !== 'eof') this.next(); break;
          case 'CHARACTER':
            this.next();
            if (this.isKeyword('SET')) this.next();
            if (this.peek().type !== 'op' && this.peek().type !== 'eof') this.next();
            break;
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

    let onDuplicate = null;
    if (this.isKeyword('ON')) {
      this.expectKeyword('ON');
      this.expectKeyword('DUPLICATE');
      this.expectKeyword('KEY');
      this.expectKeyword('UPDATE');
      onDuplicate = [];
      while (true) {
        const col = this.parseTableName();
        this.expect('op', '=');
        const val = this.parseValue();
        onDuplicate.push([col, val]);
        if (this.peek().value === ',') { this.next(); continue; }
        break;
      }
    }
    this.optionalTailSemicolon();

    return { type: 'insert', name, columns, dataRows: columns ? dataRows : null, values: columns ? null : rows, onDuplicate };
  }

  parseValue() {
    const t = this.next();
    if (t.type === 'number' || t.type === 'string') return t.value;
    if (t.type === 'keyword' && t.value === 'NULL') return null;
    if (t.type === 'keyword' && t.value === 'DEFAULT') return { _default: true };
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
        let col = null;
        if (this.peek().type === 'op' && this.peek().value === '*') { this.next(); }
        else if (!(this.peek().type === 'op' && this.peek().value === ')')) col = this.parseScalar();
        this.expect('op', ')');
        aggregate = { type: 'COUNT', column: col };
        aggregate.alias = this.parseOptionalAlias();
        columns.push({ expr: col, aggregate: 'COUNT', column: col, alias: aggregate.alias });
      } else if (t.type === 'keyword' && ['SUM', 'AVG', 'MIN', 'MAX'].includes(t.value)) {
        this.next();
        const fn = t.value;
        this.expect('op', '(');
        const col = this.parseScalar();
        this.expect('op', ')');
        aggregate = { type: fn, column: col };
        aggregate.alias = this.parseOptionalAlias();
        columns.push({ expr: col, aggregate: fn, column: col, alias: aggregate.alias });
      } else if (t.type === 'op' && t.value === '*') {
        this.next();
        columns.push({ expr: '*' });
      } else if (t.type === 'keyword' && t.value === 'CASE') {
        const caseExpr = this.parseOperand();
        let alias = null;
        alias = this.parseOptionalAlias();
        columns.push({ expr: null, caseExpr, alias });
      } else {
        // 列 / 常量 / 函数 / 算术表达式
        const expr = this.parseScalar();
        let alias = null;
        alias = this.parseOptionalAlias();
        if (expr.type === 'star') {
          columns.push({ expr: '*' });
        } else if (expr.type === 'aggregate') {
          columns.push({ expr: expr.column, aggregate: expr.fn, column: expr.column, alias, scalar: expr });
        } else if (expr.type === 'column') {
          columns.push({ expr: expr.name, scalar: expr, alias });
        } else {
          columns.push({ expr: null, scalar: expr, alias });
        }
      }
      if (this.peek().type === 'op' && this.peek().value === ',') { this.next(); continue; }
      break;
    }

    let from = null;
    if (this.isKeyword('FROM')) {
      this.next();
      from = this.parseFrom();
    }
    let where = null;
    if (this.isKeyword('WHERE')) { this.next(); where = this.parseExpr(); }
    let groupBy = null;
    if (this.isKeyword('GROUP')) {
      this.expectKeyword('GROUP'); this.expectKeyword('BY');
      groupBy = [];
      while (true) {
        groupBy.push(this.parseColumnRef());
        if (this.peek().type === 'op' && this.peek().value === ',') { this.next(); continue; }
        break;
      }
    }
    let having = null;
    if (this.isKeyword('HAVING')) { this.next(); having = this.parseExpr(); }
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
      if (typeof limit === 'number' && limit < 0) throw new Error(`LIMIT must be a non-negative integer, got ${limit}`);
      if (this.isKeyword('OFFSET')) { this.next(); offset = this.parseValue(); if (typeof offset === 'number' && offset < 0) throw new Error(`OFFSET must be a non-negative integer, got ${offset}`); }
      else if (this.peek().type === 'op' && this.peek().value === ',') { this.next(); offset = limit; limit = this.parseValue(); if (typeof limit === 'number' && limit < 0) throw new Error(`LIMIT must be a non-negative integer, got ${limit}`); }
    }
    let union = null;
    if (this.isKeyword('UNION')) {
      this.next();
      const all = this.isKeyword('ALL');
      if (all) this.next();
      union = { all, select: this.parseSelect() };
    }
    this.optionalTailSemicolon();

    return { type: 'select', columns, aggregate, distinct, from, where, groupBy, having, orderBy, limit, offset, union };
  }

  parseFrom() {
    const tables = [this.parseFromItem()];
    const joins = [];
    while (true) {
      let type = null;
      if (this.isKeyword('LEFT') || this.isKeyword('RIGHT')) {
        type = this.peek().value.toLowerCase();
        this.next();
        if (this.isKeyword('OUTER')) this.next();
        this.expectKeyword('JOIN');
      } else if (this.isKeyword('INNER') || this.isKeyword('CROSS')) {
        this.next();
        this.expectKeyword('JOIN');
        type = 'inner';
      } else if (this.isKeyword('JOIN')) {
        this.next();
        type = 'inner';
      } else if (this.peek().type === 'op' && this.peek().value === ',') {
        this.next();
        type = 'cross';
      } else {
        break;
      }
      const item = this.parseFromItem();
      let on = null;
      if (this.isKeyword('ON')) { this.next(); on = this.parseExpr(); }
      joins.push({ type, item, on });
    }
    return { tables, joins };
  }

  parseFromItem() {
    // 子查询: (SELECT ...) [AS] alias
    if (this.peek().type === 'op' && this.peek().value === '(' && this.isKeyword('SELECT', 1)) {
      this.next();
      const sub = this.parseSelect();
      this.expect('op', ')');
      let alias = null;
      if (this.isKeyword('AS')) { this.next(); alias = this.parseAlias(); }
      else if (this.peek().type === 'ident') { alias = this.next().value; }
      if (!alias) throw new Error('Subquery in FROM requires an alias');
      return { subquery: sub, alias };
    }
    const table = this.parseTableName();
    let alias = null;
    if (this.isKeyword('AS')) { this.next(); alias = this.parseAlias(); }
    else if (this.peek().type === 'ident' && !this.isKeyword('JOIN') && !this.isKeyword('LEFT') && !this.isKeyword('RIGHT') && !this.isKeyword('WHERE') && !this.isKeyword('GROUP') && !this.isKeyword('ORDER') && !this.isKeyword('LIMIT') && !this.isKeyword('ON') && !this.isKeyword('HAVING') && !this.isKeyword('UNION') && !this.isKeyword('INNER') && !this.isKeyword('CROSS')) {
      alias = this.next().value;
    }
    return { table, alias };
  }

  parseAlias() {
    const t = this.next();
    if (t.type !== 'ident' && t.type !== 'keyword') throw new Error(`Expected alias, got '${t.value}'`);
    return t.value;
  }

  parseOptionalAlias() {
    if (this.isKeyword('AS')) { this.next(); return this.parseAlias(); }
    if (this.peek().type === 'ident') return this.parseAlias();
    return null;
  }

  parseColumnRef() {
    const t = this.next();
    if (t.type !== 'ident') throw new Error(`Expected column name, got '${t.value}'`);
    if (this.peek().type === 'op' && this.peek().value === '.') {
      this.next();
      const col = this.next();
      if (col.type !== 'ident') throw new Error(`Expected column name after '.', got '${col.value}'`);
      return t.value + '.' + col.value;
    }
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
      assignments.push([col, this.parseScalar()]);
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

  parseCreateDatabase() {
    this.expectKeyword('CREATE');
    this.expectKeyword('DATABASE');
    let ifNotExists = false;
    if (this.isKeyword('IF')) {
      this.expectKeyword('IF'); this.expectKeyword('NOT'); this.expectKeyword('EXISTS');
      ifNotExists = true;
    }
    const name = this.parseTableName();
    this.optionalTailSemicolon();
    return { type: 'createDatabase', database: name, ifNotExists };
  }

  parseDropDatabase() {
    this.expectKeyword('DROP');
    this.expectKeyword('DATABASE');
    let ifExists = false;
    if (this.isKeyword('IF')) {
      this.expectKeyword('IF'); this.expectKeyword('EXISTS'); ifExists = true;
    }
    const name = this.parseTableName();
    this.optionalTailSemicolon();
    return { type: 'dropDatabase', database: name, ifExists };
  }

  _skipAlterTail() {
    while (!(this.peek().type === 'eof' || this.peek().value === ';')) {
      if (this.peek().type === 'op' && this.peek().value === ',') return;
      if (this.peek().type === 'keyword' && ['ADD', 'DROP', 'MODIFY', 'CHANGE', 'RENAME', 'ENGINE', 'CONVERT', 'DEFAULT'].includes(this.peek().value)) return;
      this.next();
    }
  }

  _skipFirstAfter() {
    if (this.isKeyword('FIRST')) { this.next(); return; }
    if (this.isKeyword('AFTER')) { this.next(); if (this.peek().type === 'ident') this.next(); }
  }

  _parseIndexColumns() {
    this.expect('op', '(');
    const columns = [];
    for (;;) {
      const col = this.parseTableName();
      if (this.isKeyword('ASC') || this.isKeyword('DESC')) this.next();
      columns.push(col);
      if (this.peek().value === ',') { this.next(); continue; }
      break;
    }
    this.expect('op', ')');
    return columns;
  }

  parseAlter() {
    this.expectKeyword('ALTER');
    this.expectKeyword('TABLE');
    const name = this.parseTableName();
    const ops = [];
    for (;;) {
      const t = this.next();
      if (t.type !== 'keyword') throw new Error(`Expected ALTER operation, got '${t.value}'`);
      switch (t.value) {
        case 'ADD': {
          if (this.isKeyword('COLUMN')) this.next();
          if (this.isKeyword('INDEX') || this.isKeyword('KEY') || this.isKeyword('UNIQUE') || this.isKeyword('FULLTEXT') || this.isKeyword('SPATIAL')) {
            const unique = this.isKeyword('UNIQUE');
            if (unique || this.isKeyword('FULLTEXT') || this.isKeyword('SPATIAL')) this.next();
            if (this.isKeyword('INDEX') || this.isKeyword('KEY')) this.next();
            let indexName = null;
            if (this.peek().type === 'ident') indexName = this.parseTableName();
            if (this.isKeyword('USING')) { this.next(); this.next(); }
            const columns = this._parseIndexColumns();
            ops.push({ op: 'addIndex', columns, unique, name: indexName });
          } else if (this.isKeyword('PRIMARY')) {
            this.expectKeyword('PRIMARY'); this.expectKeyword('KEY');
            if (this.peek().type === 'op' && this.peek().value === '(') {
              const columns = this._parseIndexColumns();
              ops.push({ op: 'addPrimary', columns });
            }
          } else if (this.isKeyword('CONSTRAINT')) {
            this.next();
            if (this.peek().type === 'ident') this.next();
            if (this.isKeyword('UNIQUE')) { this.next(); }
            if (this.isKeyword('INDEX') || this.isKeyword('KEY')) { this.next(); if (this.peek().type === 'ident') this.next(); }
            if (this.isKeyword('FOREIGN')) {
              this.expectKeyword('FOREIGN'); this.expectKeyword('KEY');
              const columns = this._parseIndexColumns();
              this.expectKeyword('REFERENCES');
              const refTable = this.parseTableName();
              const refCols = this._parseIndexColumns();
              this._skipAlterTail();
              ops.push({ op: 'addForeign', columns, refTable, refCols });
            } else {
              const columns = this._parseIndexColumns();
              ops.push({ op: 'addIndex', columns, unique: true });
            }
          } else {
            const column = this.parseTableName();
            const def = this.parseColumnDef();
            this._skipFirstAfter();
            ops.push({ op: 'addColumn', column, def });
          }
          break;
        }
        case 'DROP': {
          if (this.isKeyword('COLUMN')) this.next();
          if (this.isKeyword('PRIMARY')) { this.expectKeyword('PRIMARY'); this.expectKeyword('KEY'); ops.push({ op: 'dropPrimary' }); break; }
          if (this.isKeyword('FOREIGN')) { this.next(); this.expectKeyword('KEY'); if (this.peek().type === 'ident') this.next(); ops.push({ op: 'dropIndex' }); break; }
          if (this.isKeyword('INDEX') || this.isKeyword('KEY')) { this.next(); if (this.peek().type === 'ident') this.next(); ops.push({ op: 'dropIndex' }); break; }
          const column = this.parseTableName();
          ops.push({ op: 'dropColumn', column });
          break;
        }
        case 'MODIFY':
        case 'CHANGE': {
          if (this.isKeyword('COLUMN')) this.next();
          const column = this.parseTableName();
          let newColumn = column;
          if (t.value === 'CHANGE') newColumn = this.parseTableName();
          const def = this.parseColumnDef();
          this._skipFirstAfter();
          ops.push({ op: t.value === 'CHANGE' ? 'changeColumn' : 'modifyColumn', column, newColumn, def });
          break;
        }
        case 'RENAME': {
          if (this.isKeyword('TO')) this.next();
          const newName = this.parseTableName();
          ops.push({ op: 'rename', newName });
          break;
        }
        default:
          this._skipAlterTail();
          break;
      }
      if (this.peek().type === 'op' && this.peek().value === ',') { this.next(); continue; }
      break;
    }
    this.optionalTailSemicolon();
    return { type: 'alterTable', name, ops };
  }

  parseShow() {
    this.expectKeyword('SHOW');
    if (this.isKeyword('TABLES')) {
      this.next();
      let database = null;
      if (this.isKeyword('FROM')) { this.next(); database = this.parseTableName(); }
      let like = null;
      if (this.isKeyword('LIKE')) { this.next(); like = this.parseValue(); }
      this.optionalTailSemicolon();
      return { type: 'showTables', database, like };
    }
    if (this.isKeyword('DATABASES')) { this.next(); this.optionalTailSemicolon(); return { type: 'showDatabases' }; }
    if (this.isWord('FULL')) this.next();
    if (this.isWord('COLUMNS')) {
      this.next();
      if (!(this.isKeyword('FROM') || this.isWord('IN'))) throw new Error("Expected FROM after SHOW COLUMNS");
      this.next();
      let table = this.parseTableName();
      if (table.includes('.')) table = table.slice(table.lastIndexOf('.') + 1);
      let like = null;
      if (this.isKeyword('LIKE')) { this.next(); like = this.parseValue(); }
      this.optionalTailSemicolon();
      return { type: 'showColumns', table, like };
    }
    if (this.isWord('INDEX') || this.isWord('INDEXES') || this.isWord('KEYS')) {
      this.next();
      if (!(this.isKeyword('FROM') || this.isWord('IN'))) throw new Error("Expected FROM after SHOW INDEX");
      this.next();
      let table = this.parseTableName();
      if (table.includes('.')) table = table.slice(table.lastIndexOf('.') + 1);
      this.optionalTailSemicolon();
      return { type: 'showIndex', table };
    }
    if (this.isKeyword('CREATE')) {
      this.next();
      this.expectKeyword('TABLE');
      let table = this.parseTableName();
      if (table.includes('.')) table = table.slice(table.lastIndexOf('.') + 1);
      this.optionalTailSemicolon();
      return { type: 'showCreateTable', table };
    }
    if (this.isWord('SESSION') || this.isWord('GLOBAL')) {
      this.next();
    }
    if (this.isWord('VARIABLES')) {
      this.next();
      let like = null;
      if (this.isKeyword('LIKE')) { this.next(); like = this.parseValue(); }
      this.optionalTailSemicolon();
      return { type: 'showVariables', like };
    }
    if (this.isWord('STATUS')) {
      this.next();
      this.optionalTailSemicolon();
      return { type: 'showStatus' };
    }
    if (this.isWord('GRANTS')) {
      this.next();
      if (this.isKeyword('FOR')) { this.next(); this.parseTableName(); }
      this.optionalTailSemicolon();
      return { type: 'showGrants' };
    }
    if (this.isWord('WARNINGS') || this.isWord('ERRORS')) {
      this.next();
      this.optionalTailSemicolon();
      return { type: 'showWarnings' };
    }
    throw new Error('Unsupported SHOW statement');
  }

  parseSet() {
    this.expectKeyword('SET');
    const parts = [];
    while (!(this.peek().type === 'eof' || (this.peek().type === 'op' && this.peek().value === ';'))) {
      parts.push(this.next().value);
    }
    this.optionalTailSemicolon();
    return { type: 'set', raw: parts.join(' ') };
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

  parsePragma() {
    this.expectKeyword('PRAGMA');
    let name = '';
    const first = this.next();
    if (first.type !== 'ident' && first.type !== 'keyword') throw new Error(`Expected pragma name, got '${first.value}'`);
    name = first.value;
    // pragma 名可能带 db. 前缀: PRAGMA main.table_info(users)
    if (this.peek().type === 'op' && this.peek().value === '.') {
      this.next();
      const second = this.next();
      if (second.type !== 'ident' && second.type !== 'keyword') throw new Error(`Expected pragma name after '.', got '${second.value}'`);
      name = first.value + '.' + second.value;
    }
    let arg = null;
    if (this.peek().type === 'op' && this.peek().value === '(') {
      this.next();
      const a = this.next();
      if (a.type !== 'op' && a.type !== 'eof') arg = a.value;
      if (this.peek().type === 'op' && this.peek().value === ')') this.next();
    } else if (this.peek().type === 'op' && this.peek().value === '=') {
      this.next();
      const v = this.next();
      if (v.type === 'number' || v.type === 'ident' || v.type === 'keyword' || v.type === 'string') arg = v.value;
    } else if (this.peek().type !== 'eof' && !(this.peek().type === 'op' && this.peek().value === ';')) {
      const v = this.next();
      if (v.type === 'number' || v.type === 'ident' || v.type === 'keyword') arg = v.value;
    }
    this.optionalTailSemicolon();
    return { type: 'pragma', name, arg };
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
    if (t.type === 'ident') {
      // 支持 alias.column 引用
      if (this.peek().type === 'op' && this.peek().value === '.') {
        this.next();
        const col = this.next();
        if (col.type === 'op' && col.value === '*') return { type: 'star', alias: t.value };
        if (col.type !== 'ident') throw new Error(`Expected column name after '.', got '${col.value}'`);
        return { type: 'column', name: t.value + '.' + col.value };
      }
      // 函数调用: VERSION() / CONCAT(a, b) / NOW() ...
      if (this.peek().type === 'op' && this.peek().value === '(') {
        const name = t.value;
        this.next();
        const args = [];
        if (!(this.peek().type === 'op' && this.peek().value === ')')) {
          for (;;) {
            if (this.peek().type === 'op' && this.peek().value === '*') { this.next(); args.push({ type: 'star' }); }
            else args.push(this.parseOperand());
            if (this.peek().type === 'op' && this.peek().value === ',') { this.next(); continue; }
            break;
          }
        }
        this.expect('op', ')');
        return { type: 'func', name, args };
      }
      return { type: 'column', name: t.value };
    }
    if (t.type === 'number' || t.type === 'string') return { type: 'value', value: t.value };
    if (t.type === 'sysvar') return { type: 'sysvar', name: t.value };
    if (t.type === 'keyword' && t.value === 'NULL') return { type: 'value', value: null };
    if (t.type === 'keyword' && t.value === 'CASE') return this.parseCase();
    if (t.type === 'keyword' && !['SUM', 'AVG', 'MIN', 'MAX', 'COUNT'].includes(t.value) && this.peek().type === 'op' && this.peek().value === '(') {
      const name = t.value;
      this.next();
      const args = [];
      if (!(this.peek().type === 'op' && this.peek().value === ')')) {
        for (;;) {
          if (this.peek().type === 'op' && this.peek().value === '*') { this.next(); args.push({ type: 'star' }); }
          else args.push(this.parseOperand());
          if (this.peek().type === 'op' && this.peek().value === ',') { this.next(); continue; }
          break;
        }
      }
      this.expect('op', ')');
      return { type: 'func', name, args };
    }
    if (t.type === 'keyword' && ['SUM', 'AVG', 'MIN', 'MAX', 'COUNT'].includes(t.value)) {
      const fn = t.value;
      this.expect('op', '(');
      let column = null;
      if (this.peek().type === 'op' && this.peek().value === '*') { this.next(); }
      else if (!(this.peek().type === 'op' && this.peek().value === ')')) column = this.parseScalar();
      this.expect('op', ')');
      return { type: 'aggregate', fn, column };
    }
    if (t.type === 'op' && t.value === '(' && this.peek().type === 'keyword' && this.peek().value === 'SELECT') {
      const sub = this.parseSelect();
      this.expect('op', ')');
      return { type: 'subquery', select: sub };
    }
    if (t.type === 'op' && (t.value === '-' || t.value === '+')) {
      const num = this.next();
      if (num.type !== 'number') throw new Error('Expected number after sign');
      return { type: 'value', value: t.value === '-' ? -num.value : num.value };
    }
    throw new Error(`Expected value or column, got '${t.value}'`);
  }

  // 算术表达式: + - * / % (左结合, * / 优先)
  parseScalar() {
    let node = this.parseTerm();
    for (;;) {
      const t = this.peek();
      if (t.type === 'op' && (t.value === '+' || t.value === '-')) {
        this.next();
        const right = this.parseTerm();
        node = { type: 'arith', op: t.value, left: node, right };
        continue;
      }
      break;
    }
    // 后缀：expr IN (...)、expr IS [NOT] TRUE/FALSE/NULL（标量上下文，如 SELECT 1 IN (...))
    for (;;) {
      const t = this.peek();
      if (t.type === 'keyword' && t.value === 'IN') {
        this.next();
        this.expect('op', '(');
        if (this.isKeyword('SELECT')) {
          const sub = this.parseSelect();
          this.expect('op', ')');
          node = { type: 'in', operand: node, subquery: sub };
        } else {
          const list = [];
          while (true) {
            list.push(this.parseValue());
            if (this.peek().type === 'op' && this.peek().value === ',') { this.next(); continue; }
            break;
          }
          this.expect('op', ')');
          node = { type: 'in', operand: node, list };
        }
        continue;
      }
      if (t.type === 'keyword' && t.value === 'IS') {
        this.next();
        const not = this.isKeyword('NOT');
        if (not) this.next();
        if (this.isKeyword('NULL')) { this.next(); node = { type: 'isNull', operand: node, not: !!not }; continue; }
        if (this.isKeyword('TRUE')) { this.next(); node = { type: 'isTruth', operand: node, not: !!not, truth: true }; continue; }
        if (this.isKeyword('FALSE')) { this.next(); node = { type: 'isTruth', operand: node, not: !!not, truth: false }; continue; }
        throw new Error(`Expected NULL, TRUE or FALSE after IS, got '${this.peek().value}'`);
      }
      break;
    }
    return node;
  }

  parseTerm() {
    let node = this.parseOperand();
    for (;;) {
      const t = this.peek();
      if (t.type === 'op' && (t.value === '*' || t.value === '/' || t.value === '%')) {
        this.next();
        const right = this.parseOperand();
        node = { type: 'arith', op: t.value, left: node, right };
        continue;
      }
      break;
    }
    return node;
  }

  parseCase() {
    let base = null;
    if (!this.isKeyword('WHEN')) {
      base = this.parseOperand();
    }
    const branches = [];
    while (this.isKeyword('WHEN')) {
      this.next();
      // 简单 CASE: CASE x WHEN v THEN ... ; 搜索 CASE: CASE WHEN cond THEN ...
      let cond;
      if (base) {
        const v = this.parseOperand();
        cond = { type: 'compare', op: '=', left: base, right: v };
      } else {
        cond = this.parseComparison();
      }
      this.expectKeyword('THEN');
      const val = this.parseOperand();
      branches.push({ cond, val });
    }
    let elseVal = null;
    if (this.isKeyword('ELSE')) { this.next(); elseVal = this.parseOperand(); }
    this.expectKeyword('END');
    return { type: 'case', branches, elseVal };
  }

  parseComparison() {
    const left = this.parseOperand();
    const t = this.peek();
    let not = false;
    if (t.type === 'keyword' && t.value === 'NOT') {
      this.next();
      not = true;
      // NOT 后必须紧跟比较关键字
      const n = this.peek();
      if (!['IN', 'BETWEEN', 'LIKE', 'REGEXP'].includes(n.value)) {
        throw new Error(`Expected IN, BETWEEN, LIKE or REGEXP after NOT, got '${n.value}'`);
      }
    }
    const t2 = this.peek();

    if (t2.type === 'keyword' && t2.value === 'IS') {
      this.next();
      const n = this.isKeyword('NOT');
      if (n) this.next();
      if (this.isKeyword('NULL')) {
        this.next();
        return { type: 'isNull', operand: left, not: not || !!n };
      }
      if (this.isKeyword('TRUE')) { this.next(); return { type: 'isTruth', operand: left, not: not || !!n, truth: true }; }
      if (this.isKeyword('FALSE')) { this.next(); return { type: 'isTruth', operand: left, not: not || !!n, truth: false }; }
      throw new Error(`Expected NULL, TRUE or FALSE after IS, got '${this.peek().value}'`);
    }

    if (t2.type === 'keyword' && t2.value === 'IN') {
      this.next();
      this.expect('op', '(');
      // IN (SELECT ...) 子查询
      if (this.isKeyword('SELECT')) {
        const sub = this.parseSelect();
        this.expect('op', ')');
        return { type: 'in', operand: left, subquery: sub, not };
      }
      const list = [];
      while (true) {
        list.push(this.parseValue());
        if (this.peek().type === 'op' && this.peek().value === ',') { this.next(); continue; }
        break;
      }
      this.expect('op', ')');
      return { type: 'in', operand: left, list, not };
    }

    if (t2.type === 'keyword' && t2.value === 'BETWEEN') {
      this.next();
      const low = this.parseOperand();
      let andTok = this.peek();
      if (andTok.type === 'keyword' && andTok.value === 'AND') {
        this.next();
        const high = this.parseOperand();
        return { type: 'between', operand: left, low, high, not };
      }
      throw new Error(`Expected AND in BETWEEN, got '${andTok.value}'`);
    }

    if (t2.type === 'keyword' && t2.value === 'LIKE') {
      this.next();
      const pattern = this.parseValue();
      return { type: 'like', operand: left, pattern, not };
    }

    if (t2.type === 'keyword' && t2.value === 'REGEXP') {
      this.next();
      const pattern = this.parseValue();
      return { type: 'regexp', operand: left, pattern, not };
    }

    if (t2.type === 'op' && ['=', '!=', '<>', '<', '<=', '>', '>='].includes(t2.value)) {
      this.next();
      const right = this.parseOperand();
      return { type: 'compare', op: t2.value === '<>' ? '!=' : t2.value, left, right };
    }

    throw new Error(`Expected comparison operator, got '${t2.value}'`);
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

function resolveOperand(operand, row, ctx) {
  if (operand === null || operand === undefined) return null;
  if (typeof operand === 'string') return resolveOperand({ type: 'column', name: operand }, row, ctx);
  switch (operand.type) {
    case 'value':
    case 'literal':
      return operand.value;
    case 'sysvar': {
      const s = (ctx && ctx.session && ctx.session.sysvars) || {};
      const name = String(operand.name).toLowerCase();
      if (s[name] !== undefined) return s[name];
      const DEFAULTS = {
        'version': '8.0.0-jsql-neo',
        'version_comment': 'jsql-neo',
        'version_compile_os': 'linux',
        'sql_mode': '',
        'autocommit': 1,
        'character_set_client': 'utf8mb4',
        'character_set_connection': 'utf8mb4',
        'character_set_results': 'utf8mb4',
        'collation_connection': 'utf8mb4_general_ci',
        'transaction_isolation': 'REPEATABLE-READ',
        'max_allowed_packet': 67108864,
        'wait_timeout': 28800,
        'lower_case_table_names': 0,
        'sql_auto_is_null': 0,
      };
      return DEFAULTS[name] !== undefined ? DEFAULTS[name] : '';
    }
    case 'column': {
      const n = operand.name;
      if (n === undefined) return undefined;
      if (row[n] !== undefined) return row[n];
      if (n.includes('.')) {
        if (row[n] !== undefined) return row[n];
        const col = n.slice(n.lastIndexOf('.') + 1);
        return row[col];
      }
      return undefined;
    }
    case 'arith': {
      const l = resolveOperand(operand.left, row, ctx);
      const r = resolveOperand(operand.right, row, ctx);
      if (l === null || r === null || l === undefined || r === undefined) return null;
      switch (operand.op) {
        case '+': return l + r;
        case '-': return l - r;
        case '*': return l * r;
        case '/': return r === 0 ? null : l / r;
        case '%': return r === 0 ? null : l % r;
      }
      return null;
    }
    case 'func':
      return applyScalarFunction(operand, row, ctx);
    case 'case':
      return evaluateCaseVal(operand, row, ctx);
    case 'in':
    case 'isNull':
    case 'isTruth':
    case 'regexp':
    case 'like':
    case 'between':
      return evaluateExpr(operand, row, ctx);
    case 'aggregate':
    case 'subquery':
      return undefined;
    default:
      return undefined;
  }
}

function applyScalarFunction(fnNode, row, ctx) {
  const name = (fnNode.name || '').toUpperCase();
  const args = (fnNode.args || []).map(a => resolveOperand(a, row, ctx));
  const session = ctx && ctx.session;
  if (ctx && ctx.functions && Object.prototype.hasOwnProperty.call(ctx.functions, name)) {
    return ctx.functions[name].apply(null, args);
  }
  switch (name) {
    case 'VERSION': return '8.0.0-jsql-neo';
    case 'LAST_INSERT_ID':
    case 'LAST_INSERT_ROWID': {
      if (args.length > 0) {
        if (session) session.lastInsertId = args[0];
        return args[0];
      }
      return session && session.lastInsertId !== undefined ? session.lastInsertId : 0;
    }
    case 'ROW_COUNT': return session && session.rowCount !== undefined ? session.rowCount : 0;
    case 'FOUND_ROWS': return session && session.foundRows !== undefined ? session.foundRows : 0;
    case 'CONNECTION_ID': return session && session.connectionId !== undefined ? session.connectionId : 0;
    case 'DATABASE': case 'SCHEMA': return session && session.currentDb ? session.currentDb : 'default';
    case 'NOW': case 'CURRENT_TIMESTAMP': return new Date().toISOString().slice(0, 19).replace('T', ' ');
    case 'CURDATE': case 'CURRENT_DATE': return new Date().toISOString().slice(0, 10);
    case 'CURTIME': return new Date().toISOString().slice(11, 19);
    case 'UTC_TIMESTAMP': return new Date().toISOString().slice(0, 19).replace('T', ' ') + ' UTC';
    case 'CONCAT': return args.map(a => a === null || a === undefined ? '' : String(a)).join('');
    case 'CONCAT_WS': {
      const sep = args[0] == null ? ',' : String(args[0]);
      return args.slice(1).filter(a => a !== null && a !== undefined).map(a => String(a)).join(sep);
    }
    case 'UPPER': case 'UCASE': return args[0] == null ? null : String(args[0]).toUpperCase();
    case 'LOWER': case 'LCASE': return args[0] == null ? null : String(args[0]).toLowerCase();
    case 'LENGTH': case 'CHAR_LENGTH': case 'CHARACTER_LENGTH': return args[0] == null ? null : String(args[0]).length;
    case 'TRIM': return args[0] == null ? null : String(args[0]).trim();
    case 'LTRIM': return args[0] == null ? null : String(args[0]).replace(/^\s+/, '');
    case 'RTRIM': return args[0] == null ? null : String(args[0]).replace(/\s+$/, '');
    case 'ABS': return args[0] == null ? null : Math.abs(args[0]);
    case 'ROUND': return args[0] == null ? null : (args[1] !== undefined ? Number(args[0].toFixed(args[1])) : Math.round(args[0]));
    case 'FLOOR': return args[0] == null ? null : Math.floor(args[0]);
    case 'CEIL': case 'CEILING': return args[0] == null ? null : Math.ceil(args[0]);
    case 'MOD': return (args[0] == null || args[1] === 0) ? null : args[0] % args[1];
    case 'POWER': case 'POW': return args[0] == null ? null : Math.pow(args[0], args[1]);
    case 'SQRT': return args[0] == null ? null : Math.sqrt(args[0]);
    case 'IFNULL': case 'NVL': return args[0] != null ? args[0] : args[1];
    case 'COALESCE': return args.find(a => a != null);
    case 'NULLIF': return args[0] === args[1] ? null : args[0];
    case 'IF': return args[0] ? args[1] : args[2];
    case 'REPLACE': return args[0] == null ? null : String(args[0]).split(args[1]).join(args[2]);
    case 'SUBSTRING': case 'SUBSTR': {
      if (args[0] == null) return null;
      const s = String(args[0]);
      const len = s.length;
      let start = Number(args[1]);
      // MySQL 语义：1-based；负数从末尾倒数；0 视为 1（MySQL 返回空串）
      if (start === 0) return '';
      if (start < 0) start = len + start + 1;
      if (args[2] !== undefined) {
        let n = Number(args[2]);
        if (n < 0) return '';
        return s.substr(start - 1, n);
      }
      return s.substr(start - 1);
    }
    case 'LEFT': return args[0] == null ? null : String(args[0]).slice(0, Number(args[1]));
    case 'RIGHT': return args[0] == null ? null : String(args[0]).slice(-Number(args[1]));
    case 'LOCATE': case 'INSTR': {
      if (args[0] == null || args[1] == null) return null;
      const idx = String(args[1]).indexOf(String(args[0]));
      return idx + 1;
    }
    case 'REVERSE': return args[0] == null ? null : String(args[0]).split('').reverse().join('');
    case 'LPAD': {
      if (args[0] == null) return null;
      let s = String(args[0]);
      const n = Number(args[1]);
      const pad = args[2] == null ? ' ' : String(args[2]);
      if (n <= s.length) return s.slice(0, n);
      while (s.length < n) s = pad + s;
      return s;
    }
    case 'RPAD': {
      if (args[0] == null) return null;
      let s = String(args[0]);
      const n = Number(args[1]);
      const pad = args[2] == null ? ' ' : String(args[2]);
      if (n <= s.length) return s.slice(0, n);
      while (s.length < n) s = s + pad;
      return s;
    }
    case 'RAND': return args.length > 0 && args[0] != null ? seedRand(Number(args[0]))() : Math.random();
    case 'UNIX_TIMESTAMP': {
      if (args.length > 0 && args[0] != null) {
        const d = new Date(String(args[0]).replace(' ', 'T'));
        return isNaN(d.getTime()) ? 0 : Math.floor(d.getTime() / 1000);
      }
      return Math.floor(Date.now() / 1000);
    }
    case 'GREATEST': return args.reduce((m, a) => a > m ? a : m, args[0]);
    case 'LEAST': return args.reduce((m, a) => a < m ? a : m, args[0]);
    case 'UUID': return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
      const r = Math.random() * 16 | 0; const v = c === 'x' ? r : (r & 0x3 | 0x8);
      return v.toString(16);
    });
    case 'DATABASE': case 'SCHEMA': return row && row.__db !== undefined ? row.__db : 'default';
    default:
      return null;
  }
}

function seedRand(seed) {
  let s = Math.abs(seed) % 2147483647;
  if (s <= 0) s = 1;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

function likeMatch(value, pattern) {
  if (typeof value !== 'string') return false;
  const regex = pattern
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/%/g, '.*')
    .replace(/_/g, '.');
  return new RegExp('^' + regex + '$', 'i').test(value);
}

function extractEqualPushdown(expr, schema) {
  if (!expr || !schema) return null;
  const filter = {};
  const restParts = [];
  const walk = (node) => {
    if (!node) return;
    if (node.type === 'and') { walk(node.left); walk(node.right); return; }
    if (node.type === 'compare' && node.op === '=') {
      const col = node.left && node.left.type === 'column' ? node.left.name : null;
      const val = node.right && (node.right.type === 'literal' || node.right.type === 'value') ? node.right.value : undefined;
      if (col && val !== undefined && val !== null && schema[col] && !(schema[col].primaryKey && schema[col].autoIncrement === false)) {
        filter[col] = val;
        return;
      }
    }
    restParts.push(node);
  };
  walk(expr);
  if (Object.keys(filter).length === 0) return null;
  let rest = null;
  if (restParts.length === 1) rest = restParts[0];
  else if (restParts.length > 1) rest = restParts.slice(1).reduce((a, b) => ({ type: 'and', left: a, right: b }), restParts[0]);
  return { filter, rest };
}

function evaluateExpr(expr, row, ctx) {
  if (expr === null || expr === undefined) return false;
  switch (expr.type) {
    case 'and': return evaluateExpr(expr.left, row, ctx) && evaluateExpr(expr.right, row, ctx);
    case 'or': return evaluateExpr(expr.left, row, ctx) || evaluateExpr(expr.right, row, ctx);
    case 'not': return !evaluateExpr(expr.expr, row, ctx);
    case 'compare': {
      const l = resolveOperand(expr.left, row, ctx);
      const r = resolveOperand(expr.right, row, ctx);
      // SQL 标准：任何与 NULL 的比较结果为 UNKNOWN（在 WHERE/ON/HAVING 中视为 false）
      if (l === null || r === null) return false;
      if (expr.op === '=') return l === r || (l !== null && r !== null && String(l) === String(r));
      const fn = OPERATORS[expr.op];
      return typeof l === 'number' && typeof r === 'number' ? fn(l, r) : fn(String(l), String(r));
    }
    case 'isNull': {
      const v = resolveOperand(expr.operand, row, ctx);
      const isNull = v === null || v === undefined;
      return expr.not ? !isNull : isNull;
    }
    case 'in': {
      const v = resolveOperand(expr.operand, row, ctx);
      if (expr.subquery && expr.subquery._values !== undefined) expr.list = expr.subquery._values;
      if (!expr.list) return false;
      return expr.list.some(x => x === v || String(x) === String(v));
    }
    case 'like': {
      const r = likeMatch(resolveOperand(expr.operand, row, ctx), expr.pattern);
      return expr.not ? !r : r;
    }
    case 'regexp': {
      const v = resolveOperand(expr.operand, row, ctx);
      if (v === null || v === undefined) return false;
      const re = new RegExp(String(expr.pattern), 'i');
      const r = re.test(String(v));
      return expr.not ? !r : r;
    }
    case 'isTruth': {
      const v = resolveOperand(expr.operand, row, ctx);
      const isTrue = v === true || v === 1 || v === '1' || v === 'true' || v === 'TRUE' || v === 't' || (typeof v === 'number' && v !== 0);
      const isFalse = !isTrue && v !== null && v !== undefined;
      const result = expr.truth ? isTrue : isFalse;
      return expr.not ? !result : result;
    }
    case 'between': {
      const v = resolveOperand(expr.operand, row, ctx);
      const lo = resolveOperand(expr.low, row, ctx);
      const hi = resolveOperand(expr.high, row, ctx);
      if (v === null || lo === null || hi === null) return false;
      const inRange = typeof v === 'number' && typeof lo === 'number' && typeof hi === 'number'
        ? v >= lo && v <= hi
        : String(v) >= String(lo) && String(v) <= String(hi);
      return expr.not ? !inRange : inRange;
    }
    case 'case': {
      for (const b of expr.branches) {
        if (evaluateExpr(b.cond, row, ctx)) return resolveOperand(b.val, row, ctx);
      }
      return expr.elseVal ? resolveOperand(expr.elseVal, row, ctx) : null;
    }
    default: return false;
  }
}

function evaluateCaseVal(caseExpr, row, ctx) {
  if (!caseExpr || caseExpr.type !== 'case') return undefined;
  for (const b of caseExpr.branches) {
    if (evaluateExpr(b.cond, row, ctx)) return resolveOperand(b.val, row, ctx);
  }
  return caseExpr.elseVal ? resolveOperand(caseExpr.elseVal, row, ctx) : null;
}

function scalarName(node) {
  if (!node) return 'expr';
  switch (node.type) {
    case 'column': {
      const dot = node.name.indexOf('.');
      return dot !== -1 ? node.name.slice(dot + 1) : node.name;
    }
    case 'func': return node.name + '()';
    case 'value':
    case 'literal': return String(node.value);
    case 'arith': return scalarName(node.left) + ' ' + node.op + ' ' + scalarName(node.right);
    case 'case': return 'CASE';
    case 'aggregate': return node.fn + '(' + (node.column || '*') + ')';
    default: return 'expr';
  }
}

function scalarColumnName(c) {
  if (c.alias) return c.alias;
  if (c.scalar) return scalarName(c.scalar);
  if (c.aggregate) return c.alias || (c.aggregate === 'COUNT' ? 'COUNT(*)' : c.aggregate + '(' + c.column + ')');
  if (c.literal !== undefined) return String(c.literal);
  if (c.caseExpr) return 'CASE';
  if (c.expr === '*') return '*';
  const dot = (c.expr || '').indexOf('.');
  return dot !== -1 ? c.expr.slice(dot + 1) : c.expr;
}

function scalarColumnValue(c, r, ctx) {
  if (c.scalar) {
    const s = c.scalar;
    if (s && s.type === 'func' && ctx && ctx.ctxAggregates && Object.prototype.hasOwnProperty.call(ctx.ctxAggregates, String(s.name).toUpperCase())) {
      const fn = String(s.name).toUpperCase();
      const col = s.args && s.args[0];
      return ctx._aggValue(ctx.group, fn, col);
    }
    return resolveOperand(c.scalar, r, ctx);
  }
  if (c.aggregate) return ctx._aggValue(ctx.group, c.aggregate || 'COUNT', c.column);
  if (c.literal !== undefined) return c.literal;
  if (c.caseExpr) return evaluateCaseVal(c.caseExpr, r, ctx);
  if (c.expr === '*') return r[Object.keys(r).find(k => !k.startsWith('_'))];
  return resolveOperand({ type: 'column', name: c.expr }, r, ctx);
}

function sqlTypeName(type) {
  const t = String(type || 'string').toLowerCase();
  if (t === 'string' || t === 'text') return 'varchar(255)';
  if (t === 'integer') return 'int';
  if (t === 'float' || t === 'double') return 'float';
  if (t === 'boolean') return 'tinyint(1)';
  if (t === 'date' || t === 'datetime' || t === 'timestamp') return 'datetime';
  if (t === 'object' || t === 'array') return 'json';
  return t;
}

function buildCreateTableSql(name, schema) {
  const parts = Object.entries(schema).map(([col, def]) => {
    const seg = ['`' + col + '`', sqlTypeName(def.type)];
    if (def.autoIncrement) seg.push('AUTO_INCREMENT');
    if (def.nullable === false) seg.push('NOT NULL');
    if (def.default !== undefined) seg.push('DEFAULT ' + (typeof def.default === 'string' ? "'" + def.default + "'" : def.default));
    return seg.join(' ');
  });
  const pks = Object.keys(schema).filter(k => schema[k].primaryKey);
  if (pks.length > 0) parts.push('PRIMARY KEY (' + pks.map(k => '`' + k + '`').join(', ') + ')');
  return 'CREATE TABLE `' + name + '` (\n  ' + parts.join(',\n  ') + '\n) ENGINE=JSQL DEFAULT CHARSET=utf8mb4';
}

function normalizeRow(row, schema) {  if (row && typeof row === 'object' && row.fields && typeof row.fields === 'object') {
    const flat = { ...row.fields };
    if (schema) {
      const pkCols = Object.keys(schema).filter(k => schema[k].primaryKey);
      for (const c of pkCols) {
        if ((flat[c] === undefined || flat[c] === null) && row.id !== undefined) flat[c] = row.id;
      }
    } else if (row.id !== undefined && flat.id === undefined) {
      flat.id = row.id;
    }
    flat._rid = row.id;
    return flat;
  }
  return row;
}

class SQLExecutor {
  constructor(engine, ctx) {
    this.engine = engine;
    this.ctx = ctx || null;
  }

  async execute(statement) {
    switch (statement.type) {
      case 'createTable': {
        if (statement.ifNotExists && this.engine.hasTable && this.engine.hasTable(statement.name)) {
          return { ok: true, type: 'createTable', table: statement.name, affectedRows: 0, skipped: true };
        }
        const r = await this.engine.createTable(statement.name, statement.schema);
        return { ok: true, type: 'createTable', table: statement.name, affectedRows: 0, result: r };
      }
      case 'dropTable': {
        if (statement.ifExists && !this.engine.hasTable(statement.table)) {
          return { ok: true, type: 'dropTable', table: statement.table, affectedRows: 0 };
        }
        await this.engine.dropTable(statement.table);
        return { ok: true, type: 'dropTable', table: statement.table, affectedRows: 0 };
      }
      case 'truncate': {
        if (this.engine.hasTable(statement.name)) await this.engine.truncate(statement.name);
        return { ok: true, type: 'truncate', table: statement.name, affectedRows: 0 };
      }
      case 'alterTable': {
        const table = this.engine._tables ? this.engine._tables[statement.name] : null;
        if (!table) throw new Error(`Table '${statement.name}' does not exist`);
        for (const op of statement.ops) {
          switch (op.op) {
            case 'addColumn': {
              table._schema[op.column] = op.def;
              for (const row of table._rows) if (!(op.column in row)) row[op.column] = null;
              break;
            }
            case 'dropColumn': {
              delete table._schema[op.column];
              for (const row of table._rows) delete row[op.column];
              break;
            }
            case 'changeColumn':
            case 'modifyColumn': {
              const def = { ...op.def };
              const prev = table._schema[op.column];
              if (prev && op.column === op.newColumn) {
                if (prev.autoIncrement && !def.autoIncrement) def.autoIncrement = true;
                if (prev.primaryKey && !def.primaryKey) { def.primaryKey = true; def.unique = true; }
              }
              table._schema[op.column] = def;
              if (op.newColumn !== op.column) {
                table._schema[op.newColumn] = def;
                delete table._schema[op.column];
                for (const row of table._rows) {
                  if (op.column in row) { row[op.newColumn] = row[op.column]; delete row[op.column]; }
                }
              }
              break;
            }
            case 'addPrimary': {
              for (const c of op.columns) { table._schema[c].primaryKey = true; table._schema[c].unique = true; }
              break;
            }
            case 'dropPrimary': {
              for (const def of Object.values(table._schema)) { if (def && typeof def === 'object') { def.primaryKey = false; } }
              break;
            }
            case 'addIndex': {
              if (!op.unique) break;
              for (const c of op.columns) table._schema[c].unique = true;
              break;
            }
            case 'addForeign':
            case 'dropIndex':
            case 'rename':
            default:
              break;
          }
        }
        await this._rebuildTableCache(table);
        await this.engine.flush();
        return { ok: true, type: 'alterTable', table: statement.name, affectedRows: 0 };
      }
      case 'insert': {
        let dataRows = statement.dataRows;
        let schema = this.engine.getTableSchema
          ? await this.engine.getTableSchema(statement.name)
          : (this.engine._schemas ? this.engine._schemas[statement.name] : null);
        if (!schema) throw new Error(`Table '${statement.name}' does not exist`);
        const stripDefault = (row) => {
          const out = {};
          for (const [k, v] of Object.entries(row)) {
            if (v && typeof v === 'object' && v._default) continue;
            out[k] = v;
          }
          return out;
        };
        if (statement.dataRows) {
          statement.dataRows = statement.dataRows.map(row => {
            for (const [c, def] of Object.entries(schema)) {
              if (def.autoIncrement && (row[c] === null || row[c] === undefined)) delete row[c];
            }
            return stripDefault(row);
          });
          dataRows = statement.dataRows;
        }
        if (dataRows === null && statement.values) {
          const colNames = Object.keys(schema);
          const skipAuto = statement.values[0].length < colNames.length;
          dataRows = statement.values.map(vals => {
            const row = {};
            let vi = 0;
            colNames.forEach(c => {
              const isDefault = vals[vi] && typeof vals[vi] === 'object' && vals[vi]._default;
              if (schema[c].autoIncrement && (skipAuto || vals[vi] === undefined || vals[vi] === null || isDefault)) {
                if (!skipAuto && vi < vals.length) vi++;
                return;
              }
              const v = vals[vi] !== undefined ? vals[vi] : null;
              row[c] = v;
              vi++;
            });
            return row;
          });
          dataRows = dataRows.map(stripDefault);
        }
        const pkCols = schema ? Object.keys(schema).filter(k => schema[k].primaryKey) : [];
        let toInsert = dataRows;
        let updated = 0;
        if (pkCols.length > 0) {
          const keyOf = (row) => pkCols.map(c => (row[c] !== undefined && row[c] !== null ? String(row[c]) : '')).join('|');
          const hasExplicitPk = (row) => pkCols.some(c => row[c] !== undefined && row[c] !== null);
          const explicit = dataRows.filter(hasExplicitPk);
          if (explicit.length > 0) {
            const all = (await this.engine.find(statement.name, {}, { limit: 1e9, offset: 0 })).map(r => normalizeRow(r, schema));
            const pkMap = new Map();
            for (const row of all) {
              const keys = pkCols.map(c => row[c]).filter(v => v !== undefined && v !== null);
              if (keys.length === pkCols.length) pkMap.set(keyOf(row), keys);
            }
            const conflicts = [];
            const fresh = [];
            for (const d of dataRows) {
              const key = keyOf(d);
              if (hasExplicitPk(d) && pkMap.has(key)) {
                conflicts.push({ d, existingId: pkMap.get(key) });
              } else {
                fresh.push(d);
              }
            }
            if (conflicts.length > 0 && !statement.onDuplicate) {
              throw new Error('ER_DUP_ENTRY: Duplicate entry for primary key');
            }
            if (statement.onDuplicate && conflicts.length > 0) {
              for (const { d, existingId } of conflicts) {
                const data = {};
                for (const [col, val] of statement.onDuplicate) data[col] = val;
                if (this.engine.updateById && existingId.length === 1) {
                  this.engine.updateById(statement.name, existingId[0], data);
                } else if (this.engine.update) {
                  const filter = {};
                  pkCols.forEach((c, i) => { filter[c] = existingId[i]; });
                  this.engine.update(statement.name, filter, data);
                }
                updated++;
              }
              await this.engine.flush();
            }
            toInsert = fresh;
          }
          const seen = new Map();
          let kept = [];
          for (const d of toInsert) {
            if (!hasExplicitPk(d)) { kept.push(d); continue; }
            const key = keyOf(d);
            if (seen.has(key)) {
              if (!statement.onDuplicate) {
                throw new Error('ER_DUP_ENTRY: Duplicate entry for primary key');
              }
              seen.get(key).row = d;
            } else {
              seen.set(key, { row: d });
            }
          }
          if (seen.size > 0) kept = kept.concat(Array.from(seen.values()).map(v => v.row));
          toInsert = kept;
        }
        let ids = [];
        if (toInsert.length > 0) {
          ids = await this.engine.insert(statement.name, toInsert);
          await this.engine.flush();
        }
        return {
          ok: true, type: 'insert', table: statement.name,
          affectedRows: toInsert.length + updated,
          insertId: Array.isArray(ids) && ids.length > 0 ? ids[0] : null,
          ids,
          duplicateUpdated: updated,
        };
      }
      case 'select': {
        return await this.executeSelect(statement);
      }
      case 'update': {
        const schema = this.engine.getTableSchema
          ? await this.engine.getTableSchema(statement.table)
          : (this.engine._schemas ? this.engine._schemas[statement.table] : null);
        const pkCols = schema ? Object.keys(schema).filter(k => schema[k].primaryKey) : [];
        const all = (await this.engine.find(statement.table, {}, { limit: 1e9, offset: 0 })).map(r => normalizeRow(r, schema));
        let count = 0;
        for (const row of all) {
          if (!statement.where || evaluateExpr(statement.where, row, this.ctx)) {
            const id = this._rowPkId(row, pkCols);
            if (id !== undefined) {
              const data = {};
              for (const [col, val] of statement.assignments) {
                data[col] = typeof val === 'object' && val !== null && val.type ? resolveOperand(val, row, this.ctx) : val;
              }
              this.engine.updateById(statement.table, id, data);
              count++;
            }
          }
        }
        await this.engine.flush();
        return { ok: true, type: 'update', table: statement.table, affectedRows: count };
      }
      case 'delete': {
        const schema = this.engine.getTableSchema
          ? await this.engine.getTableSchema(statement.table)
          : (this.engine._schemas ? this.engine._schemas[statement.table] : null);
        const pkCols = schema ? Object.keys(schema).filter(k => schema[k].primaryKey) : [];
        const all = (await this.engine.find(statement.table, {}, { limit: 1e9, offset: 0 })).map(r => normalizeRow(r, schema));
        const ids = [];
        for (const row of all) {
          if (!statement.where || evaluateExpr(statement.where, row, this.ctx)) {
            const id = this._rowPkId(row, pkCols);
            if (id !== undefined) ids.push(id);
          }
        }
        if (ids.length > 0) {
          if (this.engine.removeByIds) this.engine.removeByIds(statement.table, ids);
          else for (const id of ids) this.engine.removeById(statement.table, id);
        }
        await this.engine.flush();
        return { ok: true, type: 'delete', table: statement.table, affectedRows: ids.length };
      }
      case 'begin':
        if (this.engine.beginTx) this.engine._txId = await this.engine.beginTx();
        else if (this.engine.begin) await this.engine.begin();
        return { ok: true, type: 'begin' };
      case 'commit':
        if (this.engine._txId !== undefined && this.engine.commitTx) {
          await this.engine.commitTx(this.engine._txId);
          this.engine._txId = undefined;
        } else if (this.engine.commit) await this.engine.commit();
        return { ok: true, type: 'commit' };
      case 'rollback':
        if (this.engine._txId !== undefined && this.engine.rollbackTx) {
          await this.engine.rollbackTx(this.engine._txId);
          this.engine._txId = undefined;
        } else if (this.engine.rollback) await this.engine.rollback();
        return { ok: true, type: 'rollback' };
      case 'showTables': {
        const tables = this.engine.getTables ? this.engine.getTables() : (this.engine.tables ? this.engine.tables() : []);
        let list = tables.map(t => [t]);
        if (statement.like) {
          const re = new RegExp('^' + statement.like.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*').replace(/_/g, '.') + '$', 'i');
          list = list.filter(r => re.test(r[0]));
        }
        return { ok: true, type: 'showTables', columns: ['Tables_in_' + (statement.database || 'default')], rows: list };
      }
      case 'showDatabases': {
        const list = this.engine.listDatabases
          ? await this.engine.listDatabases()
          : ['jsql'];
        return { ok: true, type: 'showDatabases', columns: ['Database'], rows: list.map(d => [d]) };
      }
      case 'showColumns': {
        const schema = this.engine.getTableSchema ? await this.engine.getTableSchema(statement.table) : null;
        if (!schema) throw new Error(`Table '${statement.table}' does not exist`);
        let rows = Object.entries(schema).map(([col, def]) => [
          col,
          sqlTypeName(def.type),
          def.nullable === false ? 'NO' : 'YES',
          def.primaryKey ? 'PRI' : (def.unique ? 'UNI' : ''),
          def.default !== undefined && def.default !== null ? String(def.default) : null,
          def.autoIncrement ? 'auto_increment' : '',
        ]);
        if (statement.like) {
          const re = new RegExp('^' + statement.like.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*').replace(/_/g, '.') + '$', 'i');
          rows = rows.filter(r => re.test(r[0]));
        }
        return { ok: true, type: 'showColumns', table: statement.table, columns: ['Field', 'Type', 'Null', 'Key', 'Default', 'Extra'], rows };
      }
      case 'showIndex': {
        const schema = this.engine.getTableSchema ? await this.engine.getTableSchema(statement.table) : null;
        if (!schema) throw new Error(`Table '${statement.table}' does not exist`);
        const rows = [];
        let seq = 0;
        for (const col of Object.keys(schema).filter(k => schema[k].primaryKey)) {
          rows.push([statement.table, 0, 'PRIMARY', ++seq, col, 'A', 0, null, null, schema[col].nullable === false ? '' : 'YES', 'BTREE', '']);
        }
        for (const col of Object.keys(schema).filter(k => schema[k].unique && !schema[k].primaryKey)) {
          rows.push([statement.table, 0, col, ++seq, col, 'A', 0, null, null, schema[col].nullable === false ? '' : 'YES', 'BTREE', '']);
        }
        return { ok: true, type: 'showIndex', table: statement.table, columns: ['Table', 'Non_unique', 'Key_name', 'Seq_in_index', 'Column_name', 'Collation', 'Cardinality', 'Sub_part', 'Packed', 'Null', 'Index_type', 'Comment'], rows };
      }
      case 'showCreateTable': {
        const schema = this.engine.getTableSchema ? await this.engine.getTableSchema(statement.table) : null;
        if (!schema) throw new Error(`Table '${statement.table}' does not exist`);
        const ddl = buildCreateTableSql(statement.table, schema);
        return { ok: true, type: 'showCreateTable', table: statement.table, columns: ['Table', 'Create Table'], rows: [[statement.table, ddl]] };
      }
      case 'showVariables': {
        const vars = {
          'version': '8.0.0-jsql-neo',
          'version_comment': 'JSQL-NEO',
          'version_compile_os': 'any',
          'sql_mode': '',
          'character_set_client': 'utf8mb4',
          'character_set_connection': 'utf8mb4',
          'character_set_server': 'utf8mb4',
          'collation_server': 'utf8mb4_general_ci',
          'lower_case_table_names': '1',
          'max_allowed_packet': '1048576',
          'autocommit': 'ON',
          'transaction_isolation': 'REPEATABLE-READ',
        };
        let entries = Object.entries(vars);
        if (statement.like) {
          const re = new RegExp('^' + statement.like.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*').replace(/_/g, '.') + '$', 'i');
          entries = entries.filter(([k]) => re.test(k));
        }
        return { ok: true, type: 'showVariables', columns: ['Variable_name', 'Value'], rows: entries };
      }
      case 'showStatus':
        return { ok: true, type: 'showStatus', columns: ['Variable_name', 'Value'], rows: [] };
      case 'showGrants':
        return { ok: true, type: 'showGrants', columns: ['Grants for root@localhost'], rows: ['GRANT ALL PRIVILEGES ON *.* TO `root`@`localhost`'].map(g => [g]) };
      case 'showWarnings':
        return { ok: true, type: 'showWarnings', columns: ['Level', 'Code', 'Message'], rows: [] };
      case 'set': {
        const session = this.ctx && this.ctx.session;
        if (session) {
          const raw = String(statement.raw || '');
          const m = raw.match(/^\s*([A-Za-z0-9_]+)(?:\.[A-Za-z0-9_]+)?\s*=\s*(.+)$/);
          if (m) {
            let val = m[2].trim().replace(/^'|'$/g, '').replace(/^"|"$/g, '');
            if (/^-?\d+(\.\d+)?$/.test(val)) val = Number(val);
            session.sysvars[m[1].toLowerCase()] = val;
          }
        }
        return { ok: true, type: 'set', raw: statement.raw };
      }
      case 'createDatabase': {
        if (!this.engine.createDatabase) throw new Error('CREATE DATABASE is not supported by this engine');
        await this.engine.createDatabase(statement.database, { ifNotExists: statement.ifNotExists });
        return { ok: true, type: 'createDatabase', database: statement.database };
      }
      case 'dropDatabase': {
        if (!this.engine.dropDatabase) throw new Error('DROP DATABASE is not supported by this engine');
        await this.engine.dropDatabase(statement.database, { ifExists: statement.ifExists });
        return { ok: true, type: 'dropDatabase', database: statement.database };
      }
      case 'use':
        if (this.engine.useDatabase) {
          await this.engine.useDatabase(statement.database);
        }
        return { ok: true, type: 'use', database: statement.database };
      case 'pragma': {
        const rows = this._runPragma(statement.name, statement.arg);
        const isSelect = ['table_info', 'table_list', 'index_list', 'index_info', 'collation_list', 'database_list', 'module_list', 'function_list', 'pragma_list'].includes(statement.name.toLowerCase());
        if (isSelect) {
          const cols = rows.length > 0 ? Object.keys(rows[0]) : [];
          return { ok: true, type: 'select', columns: cols, rows: rows.map(r => cols.map(c => r[c])), raw: rows };
        }
        const simple = rows.length > 0 && Object.keys(rows[0]).length === 1 ? rows[0][Object.keys(rows[0])[0]] : rows;
        return { ok: true, type: 'pragma', name: statement.name, value: simple };
      }
      case 'describe': {
        const schema = this.engine.getTableSchema ? await this.engine.getTableSchema(statement.table) : null;
        if (!schema) throw new Error(`Table '${statement.table}' does not exist`);
        const rows = Object.entries(schema).map(([col, def]) => [col, def.type, def.primaryKey ? 'PRI' : '', def.autoIncrement ? 'auto_increment' : null, def.default !== undefined ? def.default : null]);
        return { ok: true, type: 'describe', table: statement.table, columns: ['Field', 'Type', 'Key', 'Extra', 'Default'], rows };
      }
      default:
        throw new Error(`Unsupported statement type: ${statement.type}`);
    }
  }

  _runPragma(name, arg) {
    const engine = this.engine;
    const lname = String(name).toLowerCase().replace(/^.*\./, '');
    const rows = [];
    switch (lname) {
      case 'table_info': {
        const schema = engine.getTableSchema ? engine.getTableSchema(arg) : (engine._schemas ? engine._schemas[arg] : null);
        if (!schema) throw new Error(`table ${arg} may not be queried: no such table`);
        let cid = 0;
        for (const [col, def] of Object.entries(schema)) {
          let typeName = String(def.type || 'text').toUpperCase();
          if (typeName === 'NUMBER') typeName = 'REAL';
          if (typeName === 'OBJECT' || typeName === 'ARRAY') typeName = 'TEXT';
          rows.push({
            cid,
            name: col,
            type: typeName,
            notnull: def.required ? 1 : 0,
            dflt_value: def.default !== undefined ? def.default : null,
            pk: def.primaryKey ? 1 : 0,
          });
          cid++;
        }
        break;
      }
      case 'table_list': {
        const tables = engine.listTables ? engine.listTables() : Array.from(engine._tableNames || []);
        for (const t of tables) {
          rows.push({ schema: 'main', name: t, type: 'table', ncol: 0, wr: 1, strict: 0 });
        }
        break;
      }
      case 'index_list': {
        const schema = engine.getTableSchema ? engine.getTableSchema(arg) : (engine._schemas ? engine._schemas[arg] : null);
        if (!schema) throw new Error(`table ${arg} may not be queried: no such table`);
        let seq = 0;
        for (const [col, def] of Object.entries(schema)) {
          if (def.primaryKey || def.unique) {
            rows.push({ seq, name: 'sqlite_autoindex_' + arg + '_' + (seq + 1), unique: def.unique ? 1 : 0, origin: def.primaryKey ? 'pk' : 'u', partial: 0 });
            seq++;
          }
        }
        break;
      }
      case 'index_info': {
        const schema = engine.getTableSchema ? engine.getTableSchema(arg) : (engine._schemas ? engine._schemas[arg] : null);
        if (!schema) throw new Error(`no such index: ${arg}`);
        let seqno = 0;
        for (const [col, def] of Object.entries(schema)) {
          if (def.primaryKey || def.unique) {
            rows.push({ seqno, cid: seqno, name: col });
            seqno++;
          }
        }
        break;
      }
      case 'database_list': {
        rows.push({ seq: 0, name: 'main', file: '' });
        break;
      }
      case 'user_version': {
        const val = arg !== undefined && arg !== null ? arg : ((engine._pragmaValues && engine._pragmaValues.user_version) || 0);
        if (arg !== undefined && arg !== null) {
          engine._pragmaValues = engine._pragmaValues || {};
          engine._pragmaValues.user_version = Number(arg);
        }
        rows.push({ user_version: val });
        break;
      }
      case 'journal_mode': {
        rows.push({ journal_mode: arg !== undefined && arg !== null ? arg : 'memory' });
        break;
      }
      case 'foreign_keys': {
        rows.push({ foreign_keys: arg !== undefined && arg !== null ? arg : 0 });
        break;
      }
      case 'synchronous': {
        rows.push({ synchronous: arg !== undefined && arg !== null ? arg : 0 });
        break;
      }
      case 'cache_size': {
        rows.push({ cache_size: arg !== undefined && arg !== null ? arg : 0 });
        break;
      }
      case 'page_size':
      case 'encoding':
      case 'auto_vacuum':
      case 'temp_store':
      case 'locking_mode':
      case 'application_id':
      case 'integrity_check':
      case 'quick_check': {
        rows.push({ [lname]: lname === 'encoding' ? 'UTF-8' : (arg !== undefined && arg !== null ? arg : 0) });
        break;
      }
      default: {
        rows.push({ [lname]: arg !== undefined && arg !== null ? arg : 0 });
        break;
      }
    }
    return rows;
  }

  async _getSchema(name) {
    if (this.engine.hasTable && !this.engine.hasTable(name)) {
      throw new Error(`Table '${name}' does not exist`);
    }
    const schema = this.engine.getTableSchema
      ? await this.engine.getTableSchema(name)
      : (this.engine._schemas ? this.engine._schemas[name] : null);
    if (!schema) throw new Error(`Table '${name}' does not exist`);
    return schema;
  }

  /**
   * 取行的行 ID：优先内部 _rid，否则用实际主键字段值（不再硬编码 id）。
   */
  _rowPkId(row, pkCols) {
    if (row && row._rid !== undefined) return row._rid;
    if (pkCols.length > 0) {
      for (const c of pkCols) {
        if (row[c] !== undefined && row[c] !== null) return row[c];
      }
    }
    return row ? row.id : undefined;
  }

  async _readTable(table) {
    const schema = await this._getSchema(table);
    const rows = (await this.engine.find(table, {}, { limit: 1e9, offset: 0 })).map(r => normalizeRow(r, schema));
    return { schema, rows };
  }

  async _execFromItem(item) {
    if (item.subquery) {
      const res = await this.executeSelect(item.subquery);
      return { schema: null, rows: res.rows.map(r => Object.assign({}, r)) };
    }
    return this._readTable(item.table);
  }

  _infoSchemaColumns(view) {
    const defs = {
      'tables': ['TABLE_CATALOG', 'TABLE_SCHEMA', 'TABLE_NAME', 'TABLE_TYPE', 'ENGINE', 'VERSION', 'ROW_FORMAT', 'TABLE_ROWS', 'AVG_ROW_LENGTH', 'DATA_LENGTH', 'MAX_DATA_LENGTH', 'INDEX_LENGTH', 'DATA_FREE', 'AUTO_INCREMENT', 'CREATE_TIME', 'UPDATE_TIME', 'CHECK_TIME', 'TABLE_COLLATION', 'CHECKSUM', 'CREATE_OPTIONS', 'TABLE_COMMENT'],
      'columns': ['TABLE_CATALOG', 'TABLE_SCHEMA', 'TABLE_NAME', 'COLUMN_NAME', 'ORDINAL_POSITION', 'COLUMN_DEFAULT', 'IS_NULLABLE', 'DATA_TYPE', 'CHARACTER_MAXIMUM_LENGTH', 'CHARACTER_OCTET_LENGTH', 'NUMERIC_PRECISION', 'NUMERIC_SCALE', 'DATETIME_PRECISION', 'CHARACTER_SET_NAME', 'COLLATION_NAME', 'COLUMN_TYPE', 'COLUMN_KEY', 'EXTRA', 'PRIVILEGES', 'COLUMN_COMMENT', 'GENERATION_EXPRESSION'],
      'schemata': ['CATALOG_NAME', 'SCHEMA_NAME', 'DEFAULT_CHARACTER_SET_NAME', 'DEFAULT_COLLATION_NAME', 'SQL_PATH', 'DEFAULT_ENCRYPTION'],
      'statistics': ['TABLE_CATALOG', 'TABLE_SCHEMA', 'TABLE_NAME', 'NON_UNIQUE', 'INDEX_SCHEMA', 'INDEX_NAME', 'SEQ_IN_INDEX', 'COLUMN_NAME', 'COLLATION', 'CARDINALITY', 'SUB_PART', 'PACKED', 'NULLABLE', 'INDEX_TYPE', 'COMMENT', 'INDEX_COMMENT'],
      'key_column_usage': ['CONSTRAINT_CATALOG', 'CONSTRAINT_SCHEMA', 'CONSTRAINT_NAME', 'TABLE_CATALOG', 'TABLE_SCHEMA', 'TABLE_NAME', 'COLUMN_NAME', 'ORDINAL_POSITION', 'POSITION_IN_UNIQUE_CONSTRAINT', 'REFERENCED_TABLE_SCHEMA', 'REFERENCED_TABLE_NAME', 'REFERENCED_COLUMN_NAME'],
      'referential_constraints': ['CONSTRAINT_CATALOG', 'CONSTRAINT_SCHEMA', 'CONSTRAINT_NAME', 'UNIQUE_CONSTRAINT_CATALOG', 'UNIQUE_CONSTRAINT_SCHEMA', 'UNIQUE_CONSTRAINT_NAME', 'MATCH_OPTION', 'UPDATE_RULE', 'DELETE_RULE', 'TABLE_NAME', 'REFERENCED_TABLE_NAME'],
      'table_constraints': ['CONSTRAINT_CATALOG', 'CONSTRAINT_SCHEMA', 'CONSTRAINT_NAME', 'TABLE_SCHEMA', 'TABLE_NAME', 'CONSTRAINT_TYPE'],
    };
    return defs[view] || ['COLUMN_NAME'];
  }

  _infoSchemaType(def) {
    const t = String(def.type || '').toLowerCase();
    const m = { int: 'int', integer: 'int', smallint: 'smallint', mediumint: 'mediumint', bigint: 'bigint', tinyint: 'tinyint', string: 'varchar', varchar: 'varchar', char: 'char', text: 'text', tinytext: 'tinytext', mediumtext: 'mediumtext', longtext: 'longtext', blob: 'blob', float: 'float', double: 'double', real: 'double', decimal: 'decimal', numeric: 'decimal', boolean: 'tinyint', bool: 'tinyint', date: 'date', datetime: 'datetime', timestamp: 'timestamp', time: 'time', year: 'year', json: 'json', enum: 'enum', uuid: 'varchar', binary: 'varbinary' };
    return m[t] || t || 'varchar';
  }

  async _infoSchemaRows(view) {
    const tables = this.engine._tableNames ? Array.from(this.engine._tableNames) : (this.engine.tables ? this.engine.tables() : []);
    const dbName = 'default';
    const base = { TABLE_CATALOG: 'def' };
    if (view === 'tables' || view === 'views') {
      const out = [];
      for (const name of tables) {
        const schema = this.engine.getTableSchema(name) || {};
        const table = this.engine._tables ? this.engine._tables[name] : null;
        const rowCount = table && table._rows ? table._rows.length : 0;
        out.push(Object.assign({}, base, {
          TABLE_SCHEMA: dbName,
          TABLE_NAME: name,
          TABLE_TYPE: view === 'views' ? 'VIEW' : 'BASE TABLE',
          ENGINE: 'InnoDB',
          VERSION: 10,
          ROW_FORMAT: 'Dynamic',
          TABLE_ROWS: rowCount,
          AVG_ROW_LENGTH: 0,
          DATA_LENGTH: 0,
          MAX_DATA_LENGTH: 0,
          INDEX_LENGTH: 0,
          DATA_FREE: 0,
          AUTO_INCREMENT: table && table._autoIncrement ? table._autoIncrement : null,
          CREATE_TIME: null,
          UPDATE_TIME: null,
          CHECK_TIME: null,
          TABLE_COLLATION: 'utf8mb4_general_ci',
          CHECKSUM: null,
          CREATE_OPTIONS: '',
          TABLE_COMMENT: '',
        }));
      }
      return out;
    }
    if (view === 'columns') {
      const out = [];
      for (const name of tables) {
        const schema = this.engine.getTableSchema(name) || {};
        let pos = 0;
        for (const [col, def] of Object.entries(schema)) {
          pos++;
          const dataType = this._infoSchemaType(def);
          const len = def.length != null ? def.length : (def.maxLength != null ? def.maxLength : null);
          const colType = len != null ? `${dataType}(${len})` : dataType;
          out.push(Object.assign({}, base, {
            TABLE_SCHEMA: dbName,
            TABLE_NAME: name,
            COLUMN_NAME: col,
            ORDINAL_POSITION: pos,
            COLUMN_DEFAULT: def.default !== undefined ? def.default : null,
            IS_NULLABLE: def.required || def.autoIncrement ? 'NO' : 'YES',
            DATA_TYPE: dataType,
            CHARACTER_MAXIMUM_LENGTH: /char|text/.test(dataType) ? len : null,
            CHARACTER_OCTET_LENGTH: /char|text/.test(dataType) ? (len ? len * 4 : null) : null,
            NUMERIC_PRECISION: /int|decimal|float|double|numeric/.test(dataType) ? 10 : null,
            NUMERIC_SCALE: /decimal|numeric/.test(dataType) ? 0 : null,
            DATETIME_PRECISION: null,
            CHARACTER_SET_NAME: /char|text/.test(dataType) ? 'utf8mb4' : null,
            COLLATION_NAME: /char|text/.test(dataType) ? 'utf8mb4_general_ci' : null,
            COLUMN_TYPE: colType,
            COLUMN_KEY: def.primaryKey ? 'PRI' : (def.unique ? 'UNI' : ''),
            EXTRA: def.autoIncrement ? 'auto_increment' : '',
            PRIVILEGES: 'select,insert,update,references',
            COLUMN_COMMENT: def.comment || '',
            GENERATION_EXPRESSION: '',
          }));
        }
      }
      return out;
    }
    if (view === 'schemata') {
      return [Object.assign({}, base, {
        SCHEMA_NAME: dbName,
        CATALOG_NAME: 'def',
        DEFAULT_CHARACTER_SET_NAME: 'utf8mb4',
        DEFAULT_COLLATION_NAME: 'utf8mb4_general_ci',
        SQL_PATH: null,
        DEFAULT_ENCRYPTION: 'NO',
      })];
    }
    return [];
  }

  async _rebuildTableCache(table) {
    const schema = table._schema;
    table._primaryKey = null;
    table._autoIncrementField = null;
    table._dateFields = {};
    for (const [f, def] of Object.entries(schema)) {
      if (f === '_softDelete') continue;
      const isPk = def.primaryKey || def.primary === true;
      if (isPk && !table._primaryKey) table._primaryKey = f;
      if (def.autoIncrement) {
        table._autoIncrementField = f;
        if (isPk) table._primaryKey = f;
      }
      if (['date', 'datetime', 'timestamp', 'time'].includes(def.type)) table._dateFields[f] = def.type;
    }
    table._cachedSchemaFields = Object.keys(schema).filter(f => f !== '_softDelete');
    table._cachedDateFields = Object.keys(table._dateFields);
    table._cachedUniqueFields = table._cachedSchemaFields.filter(f => schema[f].unique);
    table._cachedRequiredFields = table._cachedSchemaFields.filter(f => schema[f].required);
    table._pkIndex = table._primaryKey ? new Map() : null;
    table._btrees = {};
    for (const [f, def] of Object.entries(schema)) {
      if (f === '_softDelete') continue;
      if (def.primaryKey || def.unique) {
        table._btrees[f] = new (require('./btree'))(64, true);
      }
    }
    table._rows.forEach((row, idx) => {
      for (const [f, tree] of Object.entries(table._btrees)) {
        const v = row[f];
        if (v !== undefined && v !== null) tree.insert(v, idx);
      }
    });
  }

  // 物化表达式树中的子查询：IN (SELECT ...) -> expr.list
  async _materialize(expr) {
    if (!expr || typeof expr !== 'object') return;
    if (expr.type === 'in' && expr.subquery) {
      const res = await this.executeSelect(expr.subquery);
      expr.list = res.rows.map(r => r[0]);
      delete expr.subquery;
      return;
    }
    if (expr.type === 'subquery') {
      const res = await this.executeSelect(expr.select);
      const v = res.rows.length > 0 ? res.rows[0][0] : null;
      expr.type = 'value';
      expr.value = v;
      delete expr.select;
      return;
    }
    for (const k of Object.keys(expr)) {
      if (expr[k] && typeof expr[k] === 'object') await this._materialize(expr[k]);
    }
  }

  // 物化 FROM 子查询（把子查询替换为行数组），返回 { rows, alias }
  async _materializeFrom(item) {
    if (item.subquery) {
      const res = await this.executeSelect(item.subquery);
      const rows = res.rows.map(r => {
        if (Array.isArray(r)) {
          const obj = {};
          res.columns.forEach((c, i) => { obj[c] = r[i]; });
          return obj;
        }
        return Object.assign({}, r);
      });
      return { rows, alias: item.alias };
    }
    return null;
  }

  _prefixRow(row, prefix) {
    const out = {};
    for (const k of Object.keys(row)) {
      out[prefix + '.' + k] = row[k];
      if (out[k] === undefined) out[k] = row[k];
    }
    return out;
  }

  /**
   * 生成对端表的前缀 null 行：仅含 `prefix.col` 键（值为 null），
   * 用于 JOIN 未匹配行补齐限定列，避免回退到未前缀副本拿错值。
   */
  _nullPrefixedRow(schema, prefix) {
    const out = {};
    for (const k of Object.keys(schema)) {
      if (k === '_softDelete') continue;
      out[prefix + '.' + k] = null;
    }
    return out;
  }

  _aggValue(rows, fn, column) {
    if (fn === 'COUNT') return rows.length;
    const op = typeof column === 'string' ? { type: 'column', name: column } : column;
    const values = op && op.type === 'star'
      ? rows.map(r => 1)
      : rows.map(r => resolveOperand(op, r, this.ctx)).filter(v => v !== null && v !== undefined);
    if (this.ctx && this.ctx.aggregates && Object.prototype.hasOwnProperty.call(this.ctx.aggregates, fn)) {
      const agg = this.ctx.aggregates[fn];
      if (typeof agg === 'function') {
        return agg(values);
      }
      if (agg && typeof agg.step === 'function') {
        let state = typeof agg.start === 'function' ? agg.start() : undefined;
        for (const v of values) state = agg.step(state, v);
        return typeof agg.result === 'function' ? agg.result(state) : state;
      }
    }
    if (fn === 'SUM') return values.reduce((s, v) => s + (typeof v === 'number' ? v : Number(v) || 0), 0);
    if (fn === 'AVG') return values.length ? values.reduce((s, v) => s + (typeof v === 'number' ? v : Number(v) || 0), 0) / values.length : null;
    if (fn === 'MIN') return values.length ? Math.min(...values.map(v => Number(v))) : null;
    if (fn === 'MAX') return values.length ? Math.max(...values.map(v => Number(v))) : null;
    return null;
  }

  _replaceAggregates(node, group) {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'aggregate') {
      node.type = 'value';
      node.value = this._aggValue(group, node.fn, node.column);
      delete node.fn;
      delete node.column;
      return;
    }
    for (const k of Object.keys(node)) {
      if (node[k] && typeof node[k] === 'object') this._replaceAggregates(node[k], group);
    }
  }

  _subQueryRows(res) {
    return res.rows.map(r => {
      if (Array.isArray(r)) {
        const obj = {};
        res.columns.forEach((c, i) => { obj[c] = r[i]; });
        return obj;
      }
      return Object.assign({}, r);
    });
  }

  async executeSelect(statement) {
    // UNION 处理
    if (statement.union) {
      const left = await this.executeSelect({ ...statement, union: null });
      const right = await this.executeSelect(statement.union.select);
      let rows = left.rows.concat(right.rows);
      if (!statement.union.all) {
        const seen = new Set();
        rows = rows.filter(r => {
          const k = JSON.stringify(r);
          if (seen.has(k)) return false;
          seen.add(k);
          return true;
        });
      }
      return { ok: true, type: 'select', columns: left.columns, rows, raw: rows };
    }

    // 物化 WHERE / HAVING / JOIN ON 中的子查询
    await this._materialize(statement.where);
    await this._materialize(statement.having);
    if (statement.from) {
      for (const j of statement.from.joins) await this._materialize(j.on);
    }
    for (const c of statement.columns) {
      if (c.caseExpr) await this._materialize(c.caseExpr);
    }

    let schema = null;
    let all;
    let rowsAll;
    if (!statement.from) {
      // 无 FROM：虚拟行（SELECT 1, 'a'）
      all = [{ _virtual: true }];
    } else {
      const items = statement.from.tables.concat(statement.from.joins.map(j => j.item));
      const prefix = item => item.alias || (item.subquery ? item.alias : item.table);

      // 读第一表
      const firstItem = statement.from.tables[0];
      if (firstItem && firstItem.table && String(firstItem.table).toLowerCase().startsWith('information_schema.')) {
        const view = String(firstItem.table).toLowerCase().split('.')[1];
        const all = await this._infoSchemaRows(view);
        const filtered = statement.where ? all.filter(r => evaluateExpr(statement.where, r)) : all;
        const cols = statement.columns.map(c => scalarColumnName(c));
        const isStar = cols.length === 1 && cols[0] === '*';
        let outCols;
        if (isStar) {
          outCols = filtered.length > 0 ? Object.keys(filtered[0]) : this._infoSchemaColumns(view);
        } else {
          outCols = cols;
        }
        const rows = filtered.map(r => outCols.map(c => (c in r ? r[c] : null)));
        return { ok: true, type: 'select', table: firstItem.table, columns: outCols, rows, raw: filtered };
      }
      if (firstItem.subquery) {
        const res = await this.executeSelect(firstItem.subquery);
        rowsAll = { rows: this._subQueryRows(res), schema: null, columns: res.columns };
      } else {
        rowsAll = await this._readTable(firstItem.table);
      }
      schema = rowsAll.schema;
      const firstPrefix = firstItem.alias || firstItem.table;
      let rows = rowsAll.rows.map(r => this._prefixRow(r, firstPrefix));

      for (const j of statement.from.joins) {
        const rightRes = j.item.subquery
          ? await this.executeSelect(j.item.subquery)
          : await this._readTable(j.item.table);
        const rightPrefix = j.item.alias || j.item.table;
        const rightRows = (j.item.subquery ? this._subQueryRows(rightRes) : rightRes.rows).map(r => this._prefixRow(r, rightPrefix));

        // 匹配（INNER/LEFT/RIGHT）
        if (j.type === 'cross' || (!j.on)) {
          // CROSS JOIN / 逗号：笛卡尔积
          rows = rows.flatMap(l => rightRows.map(r => ({ ...l, ...r })));
          continue;
        }
        const matched = [];
        const unmatchedRight = new Set(rightRows.map((r, i) => i));
        // 未匹配行补对端表的前缀 null 列：限定列名（如 a.id / b.id）按前缀解析，
        // 避免回退到未前缀副本拿到错误值。
        const rightNulls = (rightRes.schema) ? this._nullPrefixedRow(rightRes.schema, rightPrefix) : null;
        const leftNulls = (rowsAll && rowsAll.schema) ? this._nullPrefixedRow(rowsAll.schema, firstPrefix) : null;
        rows.forEach(l => {
          let m = null;
          for (let ri = 0; ri < rightRows.length; ri++) {
            if (evaluateExpr(j.on, { ...l, ...rightRows[ri] })) {
              m = ri;
              break;
            }
          }
          if (m !== null) {
            matched.push({ ...l, ...rightRows[m] });
            unmatchedRight.delete(m);
          } else if (j.type === 'left') {
            matched.push(rightNulls ? { ...rightNulls, ...l } : { ...l });
          }
        });
        if (j.type === 'right') {
          for (const ri of unmatchedRight) matched.push(leftNulls ? { ...leftNulls, ...rightRows[ri] } : { ...rightRows[ri] });
        }
        rows = matched;
      }
      all = rows;
    }

    let rows = all;
    if (statement.where) {
      rows = rows.filter(r => evaluateExpr(statement.where, r, this.ctx));
    }

    // 分组聚合
    if (statement.groupBy) {
      const groups = new Map();
      for (const row of rows) {
        const key = JSON.stringify(statement.groupBy.map(g => resolveOperand({ type: 'column', name: g }, row, this.ctx)));
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(row);
      }
      const groupList = [...groups.values()];
      rows = groupList.map(g => {
        const rep = g[0];
        const out = { ...rep, _group: g };
        return out;
      });
    }

    if (statement.having) {
      const havingAst = JSON.parse(JSON.stringify(statement.having));
      rows = rows.filter(r => {
        const ctx = { ...r };
        const h = JSON.parse(JSON.stringify(havingAst));
        this._replaceAggregates(h, r._group || [r]);
        for (const c of statement.columns) {
          if (c.aggregate) {
            const group = r._group || [r];
            const v = this._aggValue(group, c.aggregate || 'COUNT', c.column);
            ctx['__agg_' + (c.alias || c.column || 'COUNT(*)')] = v;
            if (c.column) ctx[c.column] = v;
            if (c.alias) ctx[c.alias] = v;
          }
        }
        return evaluateExpr(h, ctx);
      });
    }

    if (statement.distinct) {
      const seen = new Set();
      rows = rows.filter(r => {
        const key = JSON.stringify(statement.columns.map(c => {
          if (c.scalar) return resolveOperand(c.scalar, r, this.ctx);
          if (c.caseExpr) return evaluateCaseVal(c.caseExpr, r);
          if (c.aggregate) return this._aggValue(r._group || [r], c.aggregate || 'COUNT', c.column);
          return resolveOperand({ type: 'column', name: c.expr }, r, this.ctx);
        }));
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    }

    // 聚合输出（无 GROUP BY 时）
    const hasCustomAgg = this.ctx && this.ctx.aggregates && statement.columns.some(c => c.scalar && c.scalar.type === 'func' && Object.prototype.hasOwnProperty.call(this.ctx.aggregates, String(c.scalar.name).toUpperCase()));
    if (!statement.groupBy && (statement.columns.some(c => c.aggregate) || hasCustomAgg)) {
      const cols = statement.columns.map(c => scalarColumnName(c));
      const valueOf = (c) => {
        if (c.aggregate) return this._aggValue(rows, c.aggregate || 'COUNT', c.column);
        if (c.scalar && c.scalar.type === 'func' && hasCustomAgg) {
          const fn = String(c.scalar.name).toUpperCase();
          if (Object.prototype.hasOwnProperty.call(this.ctx.aggregates, fn)) {
            return this._aggValue(rows, fn, c.scalar.args && c.scalar.args[0]);
          }
        }
        if (c.scalar) return resolveOperand(c.scalar, rows[0] || {}, this.ctx);
        if (c.caseExpr) return resolveOperand(c.caseExpr, rows[0] || {}, this.ctx);
        if (c.expr !== null && c.expr !== '*') return rows[0] ? resolveOperand({ type: 'column', name: c.expr }, rows[0]) : null;
        return null;
      };
      return { ok: true, type: 'select', table: statement.from ? (statement.from.tables[0].table || null) : null, columns: cols, rows: [[...statement.columns.map(valueOf)]], aggregate: statement.aggregate };
    }

    // GROUP BY 输出：每组的列（含聚合列）
    if (statement.groupBy) {
      const cols = statement.columns.map(c => scalarColumnName(c));
      const mapped = rows.map(r => {
        const group = r._group || [r];
        return statement.columns.map(c => scalarColumnValue(c, r, { _aggValue: this._aggValue.bind(this), group, ctxAggregates: this.ctx ? this.ctx.aggregates : null }));
      });
      return { ok: true, type: 'select', table: statement.from ? (statement.from.tables[0].table || null) : null, columns: cols, rows: mapped, raw: rows };
    }

    if (statement.orderBy) {
      const cmp = (a, b) => {
        for (const o of statement.orderBy) {
          const av = resolveOperand({ type: 'column', name: o.column }, a, this.ctx);
          const bv = resolveOperand({ type: 'column', name: o.column }, b, this.ctx);
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

    if (statement.limit !== null) {
      const start = statement.offset || 0;
      rows = rows.slice(start, start + statement.limit);
    }

    // 无分组、无聚合的正常输出
    const tableName = statement.from ? (statement.from.tables[0].table || null) : null;
    if (statement.columns.length === 1 && statement.columns[0].expr === '*') {
      const schemaKeys = schema ? Object.keys(schema) : [];
      const pkCols = schemaKeys.filter(k => schema && schema[k] && schema[k].primaryKey);
      const pk = pkCols.length > 0 ? pkCols[0] : (schemaKeys[0] || 'id');
      let cols;
      if (schema) {
        cols = [pk, ...schemaKeys.filter(k => k !== pk)];
      } else if (rowsAll && rowsAll.columns) {
        cols = rowsAll.columns;
      } else {
        cols = Object.keys(all[0] || {}).filter((v, i, a) => a.indexOf(v) === i);
      }
      return { ok: true, type: 'select', table: tableName, columns: cols, rows: rows.map(r => cols.map(c => r[c])), raw: rows };
    }

    const cols = statement.columns.map(c => scalarColumnName(c));
    const mapped = rows.map(r => statement.columns.map(c => {
      if (c.scalar) return resolveOperand(c.scalar, r, this.ctx);
      if (c.expr === '*') return null;
      if (c.literal !== undefined) return c.literal;
      if (c.caseExpr) return evaluateCaseVal(c.caseExpr, r);
      return resolveOperand({ type: 'column', name: c.expr }, r, this.ctx);
    }));
    return { ok: true, type: 'select', table: tableName, columns: cols, rows: mapped, raw: rows };
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
    if (c === '-' && sql[i + 1] === '-') {
      while (i < sql.length && sql[i] !== '\n') i++;
      continue;
    }
    if (c === '#') {
      while (i < sql.length && sql[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && sql[i + 1] === '*') {
      current += '/*';
      i += 2;
      while (i + 1 < sql.length && !(sql[i] === '*' && sql[i + 1] === '/')) { current += sql[i]; i++; }
      if (i + 1 < sql.length) { current += '*/'; i += 2; }
      continue;
    }
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

function hasComments(sql) {
  let inStr = null;
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    if (inStr) {
      if (c === '\\') i += 2;
      else { if (c === inStr) inStr = null; i++; }
      continue;
    }
    if (c === "'" || c === '"') { inStr = c; i++; continue; }
    if (c === '`') { i++; while (i < sql.length && sql[i] !== '`') i++; i++; continue; }
    if (c === '-' && sql[i + 1] === '-') return true;
    if (c === '#') return true;
    if (c === '/' && sql[i + 1] === '*') return true;
    i++;
  }
  return false;
}

function escapeId(name) {
  return '`' + String(name).replace(/`/g, '``') + '`';
}

function escapeValue(value) {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'NULL';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (value instanceof Date) {
    const p = n => String(n).padStart(2, '0');
    return `'${value.getFullYear()}-${p(value.getMonth() + 1)}-${p(value.getDate())} ${p(value.getHours())}:${p(value.getMinutes())}:${p(value.getSeconds())}'`;
  }
  if (Buffer.isBuffer(value)) return "X'" + value.toString('hex') + "'";
  if (Array.isArray(value)) {
    if (value.some(Array.isArray)) {
      return value.map(row => '(' + row.map(escapeValue).join(', ') + ')').join(', ');
    }
    return value.map(escapeValue).join(', ');
  }
  if (typeof value === 'object') return "'" + JSON.stringify(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'";
  const str = String(value)
    .replace(/\\/g, '\\\\')
    .replace(/\0/g, '\\0')
    .replace(/'/g, "\\'")
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\u001a/g, '\\Z');
  return "'" + str + "'";
}

function applyParams(sql, values) {
  const args = values || [];
  let count = 0;
  let out = '';
  let idx = 0;
  let inStr = null;
  let i = 0;
  const named = {};
  let hasNamed = false;
  if (args && typeof args === 'object' && !Array.isArray(args)) {
    hasNamed = true;
  }
  while (i < sql.length) {
    const c = sql[i];
    if (inStr) {
      out += c;
      if (c === '\\' && i + 1 < sql.length) { out += sql[i + 1]; i += 2; continue; }
      if (c === inStr) inStr = null;
      i++;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') { inStr = c; out += c; i++; continue; }
    if (c === '?' && sql[i + 1] === '?') {
      if (!hasNamed && idx >= args.length) throw new Error('Not enough parameters for SQL: expected ' + (count + 1));
      out += escapeId(hasNamed ? args['@@'] : args[idx++]);
      count++;
      i += 2;
      continue;
    }
    if (c === '?') {
      if (sql[i + 1] >= '0' && sql[i + 1] <= '9') {
        // ?N 编号占位符
        let num = '';
        let j = i + 1;
        while (j < sql.length && sql[j] >= '0' && sql[j] <= '9') { num += sql[j]; j++; }
        const n = parseInt(num, 10);
        if (hasNamed) {
          if (!(n in args)) throw new Error(`No value for parameter ?${n}`);
          out += escapeValue(args[n]);
        } else {
          if (n - 1 >= args.length) throw new Error(`Not enough parameters for SQL: expected ?${n}`);
          out += escapeValue(args[n - 1]);
          if (n > idx) idx = n;
        }
        count++;
        i = j;
        continue;
      }
      if (!hasNamed && idx >= args.length) throw new Error('Not enough parameters for SQL: expected ' + (count + 1));
      out += escapeValue(hasNamed ? args['?'] : args[idx++]);
      count++;
      i++;
      continue;
    }
    if ((c === ':' || c === '@' || c === '$') && i + 1 < sql.length && /[A-Za-z_]/.test(sql[i + 1])) {
      // 命名占位符 :name @name $name
      let name = '';
      let j = i + 1;
      while (j < sql.length && /[A-Za-z0-9_]/.test(sql[j])) { name += sql[j]; j++; }
      if (!hasNamed) throw new Error(`Named parameter ${c}${name} requires an object of parameters`);
      if (!(name in args)) throw new Error(`No value for parameter ${c}${name}`);
      out += escapeValue(args[name]);
      count++;
      i = j;
      continue;
    }
    out += c;
    i++;
  }
  if (!hasNamed && idx !== args.length) {
    throw new Error(`Too many parameters for SQL: got ${args.length}, expected ${count}`);
  }
  return out;
}

async function executeSQL(engine, sql, paramsOrOpts, opts = {}) {
  if (Array.isArray(paramsOrOpts)) {
    sql = applyParams(sql, paramsOrOpts);
  } else if (paramsOrOpts && typeof paramsOrOpts === 'object') {
    opts = paramsOrOpts;
  }
  if (opts.safety !== false) {
    if (!opts.allowComments && hasComments(sql)) {
      throw new Error('SQL comments are disabled for security (--, #, /* */)');
    }
  }
  let statements = splitStatements(sql);
  if (opts.maxStatements != null && statements.length > opts.maxStatements) {
    throw new Error(`too many statements (${statements.length} > ${opts.maxStatements})`);
  }
  if (opts.safety !== false) {
    for (const stmtSql of statements) {
      const dangerous = findDangerousSQL(tokenize(stmtSql));
      if (dangerous) throw new Error(`SQL statement blocked by security policy: ${dangerous}`);
    }
  }
  const ctx = {};
  if (opts.session) ctx.session = opts.session;
  if (opts.functions && typeof opts.functions === 'object') ctx.functions = opts.functions;
  if (opts.aggregates && typeof opts.aggregates === 'object') ctx.aggregates = opts.aggregates;
  const executor = new SQLExecutor(engine, Object.keys(ctx).length > 0 ? ctx : null);
  const results = [];
  for (const stmtSql of statements) {
    const stmt = parseSQL(stmtSql);
    results.push(await executor.execute(stmt));
  }
  return results.length === 1 ? results[0] : results;
}

module.exports = { tokenize, parseSQL, executeSQL, SQLExecutor, splitStatements, applyParams, escapeValue, escapeId };
