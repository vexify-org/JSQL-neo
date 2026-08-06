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
  'BETWEEN', 'USING', 'FULL', 'UNSIGNED', 'ZEROFILL', 'TRUNCATE', 'COLLATE', 'CHARACTER'
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
      if (t2.type !== 'ident') throw new Error(`Expected table name after '.', got '${t2.value}'`);
      return t.value + '.' + t2.value;
    }
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
            this.next(); this.expectKeyword('KEY'); def.primaryKey = true; def.unique = true; break;
          case 'KEY':
            this.next(); def.primaryKey = true; def.unique = true; break;
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
        if (this.isKeyword('AS')) { this.next(); aggregate.alias = this.parseAlias(); }
        columns.push({ expr: col, aggregate: 'COUNT', column: col, alias: aggregate.alias });
      } else if (t.type === 'keyword' && ['SUM', 'AVG', 'MIN', 'MAX'].includes(t.value)) {
        this.next();
        const fn = t.value;
        this.expect('op', '(');
        const col = this.parseScalar();
        this.expect('op', ')');
        aggregate = { type: fn, column: col };
        if (this.isKeyword('AS')) { this.next(); aggregate.alias = this.parseAlias(); }
        columns.push({ expr: col, aggregate: fn, column: col, alias: aggregate.alias });
      } else if (t.type === 'op' && t.value === '*') {
        this.next();
        columns.push({ expr: '*' });
      } else if (t.type === 'keyword' && t.value === 'CASE') {
        const caseExpr = this.parseOperand();
        let alias = null;
        if (this.isKeyword('AS')) { this.next(); alias = this.parseAlias(); }
        columns.push({ expr: null, caseExpr, alias });
      } else {
        // 列 / 常量 / 函数 / 算术表达式
        const expr = this.parseScalar();
        let alias = null;
        if (this.isKeyword('AS')) { this.next(); alias = this.parseAlias(); }
        if (expr.type === 'aggregate') {
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
      if (this.isKeyword('OFFSET')) { this.next(); offset = this.parseValue(); }
      else if (this.peek().type === 'op' && this.peek().value === ',') { this.next(); offset = limit; limit = this.parseValue(); }
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
            args.push(this.parseOperand());
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
    if (t.type === 'keyword' && this.peek().type === 'op' && this.peek().value === '(') {
      const name = t.value;
      this.next();
      const args = [];
      if (!(this.peek().type === 'op' && this.peek().value === ')')) {
        for (;;) {
          args.push(this.parseOperand());
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
      // IN (SELECT ...) 子查询
      if (this.isKeyword('SELECT')) {
        const sub = this.parseSelect();
        this.expect('op', ')');
        return { type: 'in', operand: left, subquery: sub };
      }
      const list = [];
      while (true) {
        list.push(this.parseValue());
        if (this.peek().type === 'op' && this.peek().value === ',') { this.next(); continue; }
        break;
      }
      this.expect('op', ')');
      return { type: 'in', operand: left, list };
    }

    if (t.type === 'keyword' && t.value === 'BETWEEN') {
      this.next();
      const low = this.parseOperand();
      const not = false;
      let andTok = this.peek();
      if (andTok.type === 'keyword' && andTok.value === 'AND') {
        this.next();
        const high = this.parseOperand();
        return { type: 'between', operand: left, low, high, not };
      }
      throw new Error(`Expected AND in BETWEEN, got '${andTok.value}'`);
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
  switch (name) {
    case 'VERSION': return '8.0.0-jsql-neo';
    case 'LAST_INSERT_ID': {
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
    case 'CONCAT_WS': return (args.slice(1).map(a => a === null || a === undefined ? '' : String(a))).join(args[0] == null ? ',' : String(args[0]));
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
      const start = Number(args[1]);
      if (args[2] !== undefined) return s.substr(start - 1, Number(args[2]));
      return s.substr(start - 1);
    }
    case 'LEFT': return args[0] == null ? null : String(args[0]).slice(0, Number(args[1]));
    case 'RIGHT': return args[0] == null ? null : String(args[0]).slice(-Number(args[1]));
    case 'LOCATE': case 'INSTR': {
      if (args[0] == null || args[1] == null) return null;
      const idx = String(args[1]).indexOf(String(args[0]));
      return idx + 1;
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
      if (expr.op === '=') return l === r || (l === null && r === null) || (l !== null && r !== null && String(l) === String(r));
      if (l === null || r === null) return false;
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
    case 'like': return likeMatch(resolveOperand(expr.operand, row, ctx), expr.pattern);
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
  if (c.scalar) return resolveOperand(c.scalar, r, ctx);
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
      case 'insert': {
        let dataRows = statement.dataRows;
        let schema = null;
        const stripDefault = (row) => {
          const out = {};
          for (const [k, v] of Object.entries(row)) {
            if (v && typeof v === 'object' && v._default) continue;
            out[k] = v;
          }
          return out;
        };
        if (statement.dataRows) {
          statement.dataRows = statement.dataRows.map(stripDefault);
          dataRows = statement.dataRows;
        }
        if (dataRows === null && statement.values) {
          schema = this.engine.getTableSchema
            ? await this.engine.getTableSchema(statement.name)
            : (this.engine._schemas ? this.engine._schemas[statement.name] : null);
          if (!schema) throw new Error(`Table '${statement.name}' does not exist`);
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
        if (!schema) {
          schema = this.engine.getTableSchema
            ? await this.engine.getTableSchema(statement.name)
            : (this.engine._schemas ? this.engine._schemas[statement.name] : null);
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
            for (const row of all) pkMap.set(keyOf(row), row.id);
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
                this.engine.updateById(statement.name, existingId, data);
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
        const all = (await this.engine.find(statement.table, {}, { limit: 1e9, offset: 0 })).map(r => normalizeRow(r, schema));
        let count = 0;
        for (const row of all) {
          if (!statement.where || evaluateExpr(statement.where, row, this.ctx)) {
            const id = row._rid !== undefined ? row._rid : row.id;
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
        const schema = this.engine.getTableSchema
          ? await this.engine.getTableSchema(statement.table)
          : (this.engine._schemas ? this.engine._schemas[statement.table] : null);
        const all = (await this.engine.find(statement.table, {}, { limit: 1e9, offset: 0 })).map(r => normalizeRow(r, schema));
        const ids = [];
        for (const row of all) {
          if (!statement.where || evaluateExpr(statement.where, row, this.ctx)) {
            const id = row._rid !== undefined ? row._rid : row.id;
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

  _aggValue(rows, fn, column) {
    if (fn === 'COUNT') return rows.length;
    const op = typeof column === 'string' ? { type: 'column', name: column } : column;
    const values = rows.map(r => resolveOperand(op, r, this.ctx)).filter(v => v !== null && v !== undefined);
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
    if (!statement.from) {
      // 无 FROM：虚拟行（SELECT 1, 'a'）
      all = [{ _virtual: true }];
    } else {
      const items = statement.from.tables.concat(statement.from.joins.map(j => j.item));
      const prefix = item => item.alias || (item.subquery ? item.alias : item.table);

      // 读第一表
      const firstItem = statement.from.tables[0];
      if (firstItem && firstItem.table && String(firstItem.table).toLowerCase().startsWith('information_schema.')) {
        const cols = statement.columns.map(c => scalarColumnName(c));
        return { ok: true, type: 'select', table: null, columns: cols, rows: [], raw: [] };
      }
      let rowsAll;
      if (firstItem.subquery) {
        const res = await this.executeSelect(firstItem.subquery);
        rowsAll = { rows: this._subQueryRows(res), schema: null };
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
            matched.push({ ...l });
          }
        });
        if (j.type === 'right') {
          for (const ri of unmatchedRight) matched.push({ ...rightRows[ri] });
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
    if (!statement.groupBy && statement.columns.some(c => c.aggregate)) {
      const cols = statement.columns.map(c => scalarColumnName(c));
      const valueOf = (c) => {
        if (c.aggregate) return this._aggValue(rows, c.aggregate || 'COUNT', c.column);
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
        return statement.columns.map(c => scalarColumnValue(c, r, { _aggValue: this._aggValue.bind(this), group }));
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
      const cols = schema ? [pk, ...schemaKeys.filter(k => k !== pk)] : Object.keys(all[0] || {}).filter((v, i, a) => a.indexOf(v) === i);
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
      while (i < sql.length && sql[i] !== '\n') { current += sql[i]; i++; }
      continue;
    }
    if (c === '#') {
      while (i < sql.length && sql[i] !== '\n') { current += sql[i]; i++; }
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
      if (idx >= args.length) throw new Error('Not enough parameters for SQL: expected ' + (count + 1));
      out += escapeId(args[idx++]);
      count++;
      i += 2;
      continue;
    }
    if (c === '?') {
      if (idx >= args.length) throw new Error('Not enough parameters for SQL: expected ' + (count + 1));
      out += escapeValue(args[idx++]);
      count++;
      i++;
      continue;
    }
    out += c;
    i++;
  }
  if (idx !== args.length) {
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
  const executor = new SQLExecutor(engine, opts.session ? { session: opts.session } : null);
  const results = [];
  for (const stmtSql of statements) {
    const stmt = parseSQL(stmtSql);
    results.push(await executor.execute(stmt));
  }
  return results.length === 1 ? results[0] : results;
}

module.exports = { tokenize, parseSQL, executeSQL, SQLExecutor, splitStatements, applyParams, escapeValue, escapeId };
