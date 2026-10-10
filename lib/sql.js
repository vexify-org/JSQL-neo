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

// SQL 文本体积上限（默认 64 MiB）：防止超大、无分号的输入造成无界内存消耗
// （CWE-770）。可在 executeSQL 通过 opts.maxSqlLength 放宽/关闭（传 Infinity）。
const DEFAULT_MAX_SQL_LENGTH = 64 * 1024 * 1024;

function findDangerousSQL(tokens) {
  // 先把注释去掉，防止通过 /*comment*/DROP 绕过检测
  const commentStripped = [];
  let skip = false;
  for (const t of tokens) {
    if (t.type === 'comment') { skip = true; continue; }
    if (!skip) commentStripped.push(t);
    else skip = false;
  }
  for (let i = 0; i < commentStripped.length; i++) {
    const t = commentStripped[i];
    if (t.type !== 'keyword' && t.type !== 'ident') continue;
    const upper = String(t.value).toUpperCase();
    for (const d of DANGEROUS_SQL) {
      if (d.re.test(upper)) {
        if (d.next) {
          const nxt = commentStripped[i + 1];
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
  'REGEXP', 'TRUE', 'FALSE', 'RLIKE', 'PRAGMA', 'REPLACE', 'BLOB', 'RAISE', 'IGNORE',
  // 5.5.0 新增：CTE 与集合运算符
  'WITH', 'RECURSIVE', 'INTERSECT', 'EXCEPT'
  // 注意：OVER / PARTITION / UNBOUNDED / PRECEDING / FOLLOWING 等刻意不加入此表。
  // 它们同时是常见标识符（列名 rank、current、row…），若被词法层标记为 keyword
  // 会让 `SELECT rank FROM t` 之类的既有语句解析失败。这些词改由 Parser.isWord()
  // 在语法层按上下文大小写不敏感地匹配，从而不破坏既有解析行为。
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
    // PG 的 JSON 路径操作符 #> / #>>（必须在 '#' 行注释之前识别）
    if (c === '#' && sql[i + 1] === '>') {
      const op = sql[i + 2] === '>' ? '#>>' : '#>';
      tokens.push(new SQLToken('op', op, i));
      i += op.length;
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
          // MySQL 语义：\% 与 \_ 保留反斜杠（供 LIKE 匹配字面量通配符），其余未知转义忽略反斜杠
          if (map[esc] !== undefined) str += map[esc];
          else if (esc === '%' || esc === '_') str += '\\' + esc;
          else str += esc;
          j += 2;
        } else if (sql[j] === quote) {
          // SQL 标准转义：字符串内两个连续引号表示一个字面量引号（'O''Brien' → O'Brien）
          if (sql[j + 1] === quote) { str += quote; j += 2; continue; }
          break;
        } else {
          str += sql[j];
          j++;
        }
      }
      if (j >= n) throw new Error(`Unterminated ${quote === '"' ? 'double' : 'single'}-quoted string at position ${i}`);
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
      // parseInt 会错误处理某些前导零（'07' 在非严格模式被当八进制），
      // 大数 parseInt 也丢失精度。统一用 Number()（bigint 用 BigInt()）。
      let numVal;
      if (raw.includes('.') || raw.includes('e') || raw.includes('E')) {
        numVal = parseFloat(raw);
      } else {
        const n = BigInt(raw);
        numVal = n <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(n) : n;
      }
      tokens.push(new SQLToken('number', numVal, i));
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
      if (j >= n) throw new Error(`Unterminated backtick-quoted identifier at position ${i}`);
      tokens.push(new SQLToken('ident', sql.slice(i + 1, j), i));
      i = j + 1;
      continue;
    }

    // PG 的 JSON 包含操作符 @>
    if (c === '@' && sql[i + 1] === '>') {
      tokens.push(new SQLToken('op', '@>', i));
      i += 2;
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

    // 参数占位符：? （顺序）、?N （编号）、?? （标识符占位）
    // 注意：?| / ?& 是 PG 的 JSON 键存在操作符，必须优先识别
    if (c === '?' && (sql[i + 1] === '|' || sql[i + 1] === '&')) {
      tokens.push(new SQLToken('op', '?' + sql[i + 1], i));
      i += 2;
      continue;
    }
    if (c === '?') {
      if (sql[i + 1] === '?') { tokens.push(new SQLToken('param', '??', i)); i += 2; continue; }
      let j = i + 1;
      let num = '';
      while (j < n && sql[j] >= '0' && sql[j] <= '9') { num += sql[j]; j++; }
      tokens.push(new SQLToken('param', num ? Number(num) : null, i));
      i = j;
      continue;
    }

    const three = sql.slice(i, i + 3);
    if (sql.slice(i, i + 2) === '<@') {
      tokens.push(new SQLToken('op', '<@', i));
      i += 2;
      continue;
    }
    if (three === '->>' || three === '<=>' || three === '!~*') {
      tokens.push(new SQLToken('op', three, i));
      i += 3;
      continue;
    }

    const two = sql.slice(i, i + 2);
    if (two === '<=' || two === '>=' || two === '!=' || two === '<>' || two === '==' ||
        two === '<<' || two === '>>' || two === '->' || two === '::' ||
        two === '&&' || two === '||' || two === '~*' || two === '!~') {
      tokens.push(new SQLToken('op', two, i));
      i += 2;
      continue;
    }

    // 注意：% & | ^ ~ 这些运算符必须在词法层产出 token。
    // 之前 parseTerm() 里写了 '%' 分支但字符集里没有 '%'，
    // 导致 SELECT 10 % 3 直接报 "Unexpected character '%'"，那段是死代码。
    if ('=<>+-*/(),.;%&|^~'.includes(c)) {
      tokens.push(new SQLToken('op', c, i));
      i++;
      continue;
    }

    throw new Error(`Unexpected character '${c}' at position ${i}`);
  }

  tokens.push(new SQLToken('eof', null, n));
  return tokens;
}

// 聚合函数集合：这些必须走 aggregate 节点，否则会被当成逐行标量函数（返回 null 且不折叠行）
const AGG_FUNCS = new Set(['SUM', 'AVG', 'MIN', 'MAX', 'COUNT',
  'GROUP_CONCAT', 'STDDEV', 'STDDEV_POP', 'STDDEV_SAMP',
  'VARIANCE', 'VAR_POP', 'VAR_SAMP', 'FIRST', 'LAST']);

// 这些词会跟在表名/子查询之后，不能被误当成表别名。
// 新增任何"跟在 FROM 之后"的子句时，都要往这里加词。
const NOT_ALIAS_WORDS = ['JOIN', 'LEFT', 'RIGHT', 'FULL', 'WHERE', 'GROUP', 'ORDER', 'LIMIT',
  'ON', 'HAVING', 'UNION', 'INNER', 'CROSS', 'OUTER', 'INTERSECT', 'EXCEPT',
  'FETCH', 'RETURNING', 'WINDOW', 'OFFSET', 'FOR'];

class Parser {
  constructor(tokens) {
    this.tokens = tokens;
    this.pos = 0;
    this.paramCount = 0;   // 顺序占位符 ? 的序号（从 0 开始）
    this.subquerySeq = 0;  // FROM 子查询无别名时自动生成 __subN
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
    if (t.type !== 'keyword') {
      // 少数语句起始词刻意不进关键字表（它们同时是常见标识符），按上下文识别
      const w = String(t.value).toUpperCase();
      if (w === 'EXPLAIN') {
        this.next();
        if (this.isWord('ANALYZE')) this.next();
        const stmt = this.parseStatement();
        if (!stmt) throw new Error('EXPLAIN requires a following statement');
        return { type: 'explain', statement: stmt };
      }
      if (w === 'SAVEPOINT') {
        this.next();
        const nm = this.next();
        if (nm.type !== 'ident') throw new Error(`Expected savepoint name, got '${nm.value}'`);
        this.optionalTailSemicolon();
        return { type: 'savepoint', name: nm.value };
      }
      if (w === 'RELEASE') {
        this.next();
        if (this.isWord('SAVEPOINT')) this.next();
        const nm = this.next();
        if (nm.type !== 'ident') throw new Error(`Expected savepoint name, got '${nm.value}'`);
        this.optionalTailSemicolon();
        return { type: 'releaseSavepoint', name: nm.value };
      }
      throw new Error(`Expected SQL statement, got '${t.value}'`);
    }

    switch (t.value) {
      case 'CREATE':
        if (this.isKeyword('TABLE', 1)) return this.parseCreateTable();
        if (this.isKeyword('DATABASE', 1)) return this.parseCreateDatabase();
        if (this.isWord('VIEW', 1) || this.isWord('OR', 1)) return this.parseCreateView();
        if (this.isKeyword('INDEX', 1) || this.isKeyword('UNIQUE', 1)) return this.parseCreateIndex();
        throw new Error('Unsupported CREATE statement');
      case 'DROP':
        if (this.isKeyword('TABLE', 1)) return this.parseDropTable();
        if (this.isKeyword('DATABASE', 1)) return this.parseDropDatabase();
        if (this.isWord('VIEW', 1)) return this.parseDropView();
        if (this.isKeyword('INDEX', 1)) return this.parseDropIndex();
        throw new Error('Unsupported DROP statement');
      case 'INSERT': return this.parseInsert();
      case 'REPLACE': return this.parseReplace();
      case 'ALTER': return this.parseAlter();
      case 'TRUNCATE': this.expectKeyword('TRUNCATE'); if (this.isKeyword('TABLE')) this.next(); return { type: 'truncate', name: this.parseTableName() };
      case 'SELECT': return this.parseSelect();
      case 'WITH': return this.parseWith();
      case 'UPDATE': return this.parseUpdate();
      case 'DELETE': return this.parseDelete();
      case 'BEGIN': this.expectKeyword('BEGIN'); this.optionalTransaction(); return { type: 'begin' };
      case 'START': this.expectKeyword('START'); if (this.isKeyword('TRANSACTION')) this.next(); return { type: 'begin' };
      case 'COMMIT': this.expectKeyword('COMMIT'); this.optionalTransaction(); return { type: 'commit' };
      case 'ROLLBACK': {
        this.expectKeyword('ROLLBACK');
        // ROLLBACK TO [SAVEPOINT] name —— 回滚到保存点而非回滚整个事务
        if (this.isKeyword('TO')) {
          this.next();
          if (this.isWord('SAVEPOINT')) this.next();
          const nm = this.next();
          if (nm.type !== 'ident') throw new Error(`Expected savepoint name, got '${nm.value}'`);
          this.optionalTailSemicolon();
          return { type: 'rollbackTo', name: nm.value };
        }
        this.optionalTransaction();
        return { type: 'rollback' };
      }
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

  /**
   * CREATE [OR REPLACE] VIEW name [(cols)] AS SELECT ...
   * 视图在语法层解析成 { type:'createView', name, columns, select }；
   * 执行层由引擎侧决定如何注册（不存在视图存储时退化为"可用即查询"）。
   */
  parseCreateView() {
    this.expectKeyword('CREATE');
    let orReplace = false;
    if (this.isWord('OR')) {
      this.next();
      if (!this.isWord('REPLACE')) throw new Error(`Expected REPLACE after OR, got '${this.peek().value}'`);
      this.next();
      orReplace = true;
    }
    if (!this.isWord('VIEW')) throw new Error(`Expected VIEW, got '${this.peek().value}'`);
    this.next();
    const name = this.parseTableName();
    let columns = null;
    if (this.peek().type === 'op' && this.peek().value === '(') {
      this.next();
      columns = [];
      for (;;) {
        columns.push(this.parseColumnRef());
        if (this.peek().type === 'op' && this.peek().value === ',') { this.next(); continue; }
        break;
      }
      this.expect('op', ')');
    }
    if (!this.isKeyword('AS')) throw new Error(`Expected AS in CREATE VIEW, got '${this.peek().value}'`);
    this.next();
    const select = this.parseSelect();
    this.optionalTailSemicolon();
    return { type: 'createView', name, columns, select, orReplace };
  }

  /**
   * CREATE [UNIQUE] INDEX name ON table (col [, col]...)
   * 归一成 { type:'createIndex', name, table, columns, unique }
   */
  parseCreateIndex() {
    this.expectKeyword('CREATE');
    let unique = false;
    if (this.isKeyword('UNIQUE')) { this.next(); unique = true; }
    if (!this.isKeyword('INDEX')) throw new Error(`Expected INDEX, got '${this.peek().value}'`);
    this.next();
    const name = this.parseTableName();
    if (!this.isKeyword('ON')) throw new Error(`Expected ON in CREATE INDEX, got '${this.peek().value}'`);
    this.next();
    const table = this.parseTableName();
    this.expect('op', '(');
    const columns = [];
    for (;;) {
      columns.push(this.parseColumnRef());
      if (this.peek().type === 'op' && this.peek().value === ',') { this.next(); continue; }
      break;
    }
    this.expect('op', ')');
    this.optionalTailSemicolon();
    return { type: 'createIndex', name, table, columns, unique };
  }

  /** DROP INDEX name ON table */
  parseDropIndex() {
    this.expectKeyword('DROP');
    this.expectKeyword('INDEX');
    let ifExists = false;
    if (this.isKeyword('IF')) { this.expectKeyword('IF'); this.expectKeyword('EXISTS'); ifExists = true; }
    const name = this.parseTableName();
    let table = null;
    if (this.isKeyword('ON')) { this.next(); table = this.parseTableName(); }
    this.optionalTailSemicolon();
    return { type: 'dropIndex', name, table, ifExists };
  }

  parseDropView() {
    this.expectKeyword('DROP');
    if (!this.isWord('VIEW')) throw new Error(`Expected VIEW, got '${this.peek().value}'`);
    this.next();
    let ifExists = false;
    if (this.isKeyword('IF')) {
      this.expectKeyword('IF'); this.expectKeyword('EXISTS'); ifExists = true;
    }
    const name = this.parseTableName();
    this.optionalTailSemicolon();
    return { type: 'dropView', name, ifExists };
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
          // UNIQUE [KEY|INDEX] [name] (cols...)
          if (this.isKeyword('KEY') || this.isKeyword('INDEX')) this.next();
          if (this.peek().type === 'ident') this.next();
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
        if (this.peek().type === 'ident') this.next();   // 约束名
        this._parseTableConstraint(schema);
      } else if (this.isWord('FOREIGN') || this.isWord('CHECK') ||
                 t.type === 'keyword' && (t.value === 'KEY' || t.value === 'INDEX')) {
        // 表级约束：FOREIGN KEY ... REFERENCES ... / CHECK (...) / KEY name (cols)
        this._parseTableConstraint(schema);
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
    const typeRaw = String(typeTok.value);
    // 这些类型不在 KEYWORDS 里（避免影响同名标识符），按上下文识别
    const IDENT_TYPES = /^(BIG)?SERIAL$|^JSONB$|^TIMESTAMPTZ$|^BYTEA$|^UUID$/i;
    const isIdentType = IDENT_TYPES.test(typeRaw);
    if (typeTok.type !== 'keyword' && !isIdentType) throw new Error(`Expected column type, got '${typeTok.value}'`);
    const type = typeRaw.toLowerCase();
    const typeMap = {
      integer: 'integer', int: 'integer', bigint: 'integer', tinyint: 'integer', smallint: 'integer',
      string: 'string', text: 'string', varchar: 'string', char: 'string',
      float: 'number', double: 'number', real: 'number', numeric: 'number', decimal: 'number',
      boolean: 'boolean', bool: 'boolean',
      date: 'date', datetime: 'datetime', timestamp: 'timestamp', timestamptz: 'timestamp',
      any: 'any', object: 'object', json: 'object', jsonb: 'object', array: 'array',
      bytea: 'string', uuid: 'string',
      // PG 自增序列类型：等价于整型 + 自增 + NOT NULL
      serial: 'integer', bigserial: 'integer'
    };
    const mapped = typeMap[type];
    if (!mapped) throw new Error(`Unsupported column type: ${typeTok.value}`);
    def.type = mapped;
    if (/^(BIG)?SERIAL$/i.test(typeRaw)) { def.autoIncrement = true; def.required = true; }

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
      // 列级 CHECK (age INT CHECK(age >= 0))。
      // CHECK 刻意不在 KEYWORDS 里（避免影响同名标识符），所以用 isWord 匹配，
      // 放在 keyword switch 之外。表级 CHECK 已能被解析（同样只是跳过），
      // 列级此前会直接 return def，把 CHECK 留在流里 →
      // "Expected ',' or ')' in CREATE TABLE, got 'CHECK'"。
      // 与表级保持一致：解析并跳过，条件文本存到 def.check 供后续实现。
      if (this.isWord('CHECK')) {
        this.next();
        if (this.peek().type === 'op' && this.peek().value === '(') this._skipParens();
        continue;
      }
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
            this.next();
            // 默认值可以是字面量，也可以是函数/关键字形式（CURRENT_TIMESTAMP / NOW() 等）。
            // 函数形式存成字符串 + defaultExpr 标记，与 JS 侧 `default: 'CURRENT_TIMESTAMP'` 约定一致。
            if (this.peek().type === 'ident' ||
                (this.peek().type === 'keyword' && !['NULL', 'TRUE', 'FALSE'].includes(this.peek().value))) {
              const fnTok = this.next();
              let name = String(fnTok.value);
              if (this.peek().type === 'op' && this.peek().value === '(') {
                this.next();
                this.expect('op', ')');
                name += '()';
              }
              def.default = name;
              def.defaultExpr = true;
            } else {
              def.default = this.parseValue();
              // 允许字面量后带 :: 类型转换：DEFAULT '{}'::jsonb
              if (this.peek().type === 'op' && this.peek().value === '::') {
                this.next();
                if (this.peek().type === 'keyword' || this.peek().type === 'ident') this.next();
              }
            }
            break;
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

  // REPLACE INTO t ... —— 等价于"存在则替换"，解析结构与 INSERT 一致
  parseReplace() {
    this.expectKeyword('REPLACE');
    if (this.isKeyword('INTO')) this.next();
    const stmt = this.parseInsertBody();
    stmt.replace = true;
    return stmt;
  }

  parseInsert() {
    this.expectKeyword('INSERT');
    let ignore = false;
    if (this.isKeyword('IGNORE')) { this.next(); ignore = true; }
    this.expectKeyword('INTO');
    const stmt = this.parseInsertBody();
    stmt.ignore = ignore;
    return stmt;
  }

  /** 跳过一对括号（含嵌套），用于表级约束里的列清单 */
  _skipParens() {
    this.expect('op', '(');
    let depth = 1;
    while (depth > 0 && this.peek().type !== 'eof') {
      const tk = this.next();
      if (tk.type === 'op' && tk.value === '(') depth++;
      else if (tk.type === 'op' && tk.value === ')') depth--;
    }
  }

  /**
   * 解析表级约束（FOREIGN KEY / CHECK / KEY / INDEX / PRIMARY KEY / UNIQUE）。
   * 目前只做语法层面消费并在可能时补充列属性，不做外键实际校验。
   */
  _parseTableConstraint(schema) {
    if (this.isWord('FOREIGN')) {
      this.next();
      if (!this.isKeyword('KEY')) throw new Error(`Expected KEY after FOREIGN, got '${this.peek().value}'`);
      this.next();
      if (this.peek().type === 'op' && this.peek().value === '(') this._skipParens();
      if (this.isWord('REFERENCES')) {
        this.next();
        this.parseTableName();
        if (this.peek().type === 'op' && this.peek().value === '(') this._skipParens();
      }
      // ON DELETE / ON UPDATE <action>
      while (this.isKeyword('ON')) {
        this.next();
        this.next();                       // DELETE | UPDATE
        const act = String(this.next().value).toUpperCase();
        if (act === 'SET' || act === 'NO') this.next();   // SET NULL / NO ACTION
      }
      return;
    }
    if (this.isWord('CHECK')) {
      this.next();
      if (this.peek().type === 'op' && this.peek().value === '(') this._skipParens();
      return;
    }
    if (this.isKeyword('PRIMARY')) {
      this.expectKeyword('PRIMARY');
      if (this.isKeyword('KEY')) this.next();
      if (this.peek().type === 'op' && this.peek().value === '(') {
        this.next();
        const cols = [this.parseTableName()];
        while (this.peek().type === 'op' && this.peek().value === ',') { this.next(); cols.push(this.parseTableName()); }
        this.expect('op', ')');
        for (const c of cols) if (schema[c]) schema[c].primaryKey = true;
      }
      return;
    }
    if (this.isKeyword('UNIQUE')) {
      this.next();
    }
    if (this.isKeyword('KEY') || this.isKeyword('INDEX')) {
      this.next();
      if (this.peek().type === 'ident') this.next();     // 索引名
      if (this.peek().type === 'op' && this.peek().value === '(') this._skipParens();
    }
  }

  parseInsertBody() {
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
    // INSERT INTO t [(cols)] SELECT ... —— 与 VALUES 互斥的另一条插入来源
    if (this.isKeyword('SELECT')) {
      const select = this.parseSelect();
      this.optionalTailSemicolon();
      return { type: 'insert', name, columns, select, dataRows: null, values: null, onDuplicate: null };
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
    let onConflict = null;
    if (this.isKeyword('ON')) {
      this.expectKeyword('ON');
      // PostgreSQL: ON CONFLICT [(cols)] DO NOTHING | DO UPDATE SET ...
      if (this.isWord('CONFLICT')) {
        this.next();
        let target = null;
        if (this.peek().type === 'op' && this.peek().value === '(') {
          this.next();
          target = [];
          for (;;) {
            target.push(this.parseColumnRef());
            if (this.peek().type === 'op' && this.peek().value === ',') { this.next(); continue; }
            break;
          }
          this.expect('op', ')');
        }
        if (!this.isWord('DO')) throw new Error(`Expected DO after ON CONFLICT, got '${this.peek().value}'`);
        this.next();
        if (this.isWord('NOTHING')) { this.next(); onConflict = { target, action: 'nothing' }; }
        else if (this.isWord('UPDATE')) {
          this.next();
          if (!this.isKeyword('SET')) throw new Error(`Expected SET after DO UPDATE, got '${this.peek().value}'`);
          this.next();
          const sets = [];
          for (;;) {
            const col = this.parseColumnRef();
            this.expect('op', '=');
            const val = this.parseConflictValue();
            sets.push([col, val]);
            if (this.peek().value === ',') { this.next(); continue; }
            break;
          }
          onConflict = { target, action: 'update', sets };
        } else {
          throw new Error(`Expected NOTHING or UPDATE after DO, got '${this.peek().value}'`);
        }
      } else {
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
    }
    this.optionalTailSemicolon();

    // RETURNING * | RETURNING col [, col]...
    const returning = this.parseOptionalReturning();
    return { type: 'insert', name, columns, dataRows: columns ? dataRows : null, values: columns ? null : rows, onDuplicate, onConflict, returning };
  }

  /**
   * 冲突处理策略 —— 把四种写法归一成一个动作：
   *   REPLACE INTO                      → 'replace'
   *   INSERT IGNORE / ON CONFLICT DO NOTHING → 'ignore'
   *   ON DUPLICATE KEY UPDATE / ON CONFLICT DO UPDATE → 'update'
   *   默认                               → 'throw'（ER_DUP_ENTRY）
   */
  /** 解析可选的 RETURNING 子句（INSERT / UPDATE / DELETE 通用） */
  parseOptionalReturning() {
    if (!this.isWord('RETURNING')) return null;
    this.next();
    if (this.peek().type === 'op' && this.peek().value === '*') { this.next(); return ['*']; }
    const cols = [];
    for (;;) {
      cols.push(this.parseColumnRef());
      if (this.peek().type === 'op' && this.peek().value === ',') { this.next(); continue; }
      break;
    }
    return cols;
  }

  parseValue() {
    const t = this.next();
    if (t.type === 'number' || t.type === 'string') return t.value;
    // MySQL: ON DUPLICATE KEY UPDATE col = VALUES(col) —— 引用"本次本应插入的值"
    if (t.type === 'keyword' && t.value === 'VALUES' && this.peek().type === 'op' && this.peek().value === '(') {
      this.next();
      const col = this.parseColumnRef();
      this.expect('op', ')');
      return { _valuesOf: col };
    }
    if (t.type === 'keyword' && t.value === 'NULL') return null;
    if (t.type === 'keyword' && t.value === 'TRUE') return true;
    if (t.type === 'keyword' && t.value === 'FALSE') return false;
    if (t.type === 'keyword' && t.value === 'DEFAULT') return { _default: true };
    if (t.type === 'param') return { type: 'param', index: t.value, position: this.paramCount++ };
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

  /**
   * ON CONFLICT DO UPDATE 赋值右侧：
   *   EXCLUDED.col —— PG：引用"本次本应插入的值"
   *   VALUES(col)  —— MySQL 同义（在 parseValue 中处理）
   *   其他字面量
   */
  parseConflictValue() {
    if (this.isWord('EXCLUDED') && this.peek(1).type === 'op' && this.peek(1).value === '.') {
      this.next(); this.next();
      const col = this.parseColumnRef();
      return { _excludedOf: col };
    }
    return this.parseValue();
  }

  /**
   * WITH [RECURSIVE] name [(col, ...)] AS (SELECT ...), ... <statement>
   * CTE 在语法层解析为 { type:'with', ctes:[{name, columns, select}], statement }。
   * 执行层会把 CTE 内联为 FROM 子查询，因此不需要引擎侧临时表。
   */
  parseWith() {
    this.expectKeyword('WITH');
    let recursive = false;
    if (this.isKeyword('RECURSIVE')) { this.next(); recursive = true; }
    const ctes = [];
    for (;;) {
      // 部分方言把 RECURSIVE 放在第一个 CTE 之后（WITH a AS (...), RECURSIVE c AS (...)），
      // 标准 SQL 里它是 WITH 后的可选关键字 —— 两种写法都接受。
      if (!recursive && ctes.length && this.isKeyword('RECURSIVE')) { this.next(); recursive = true; ctes[0].recursive = true; }
      const nameTok = this.next();
      if (nameTok.type !== 'ident') throw new Error(`Expected CTE name, got '${nameTok.value}'`);
      let columns = null;
      if (this.peek().type === 'op' && this.peek().value === '(') {
        this.next();
        columns = [];
        for (;;) {
          columns.push(this.parseColumnRef());
          if (this.peek().type === 'op' && this.peek().value === ',') { this.next(); continue; }
          break;
        }
        this.expect('op', ')');
      }
      this.expectKeyword('AS');
      this.expect('op', '(');
      const select = this.parseSelect();
      this.expect('op', ')');
      ctes.push({ name: nameTok.value, columns, select, recursive });
      if (this.peek().type === 'op' && this.peek().value === ',') { this.next(); continue; }
      break;
    }
    const statement = this.parseStatement();
    if (!statement) throw new Error('WITH requires a following SELECT/INSERT/UPDATE/DELETE statement');
    return { type: 'with', recursive, ctes, statement };
  }

  /**
   * 可选的窗口定义：OVER ( [PARTITION BY ...] [ORDER BY ...] [frame] ) 或 OVER win_name
   * 只在真的出现 OVER 时才改写节点，因此不影响既有 func / aggregate 节点形状。
   */
  parseOptionalOver(node) {
    if (!this.isWord('OVER')) return node;
    this.next();
    // 命名窗口：OVER w（后面必须不是 '(' ）
    if (!(this.peek().type === 'op' && this.peek().value === '(')) {
      const nameTok = this.next();
      if (nameTok.type === 'eof') throw new Error('Expected window name or "(" after OVER');
      node.over = { windowName: nameTok.value };
      return node;
    }
    this.expect('op', '(');
    const spec = {};
    if (this.isWord('PARTITION')) {
      this.next();
      if (!this.isWord('BY')) throw new Error(`Expected BY after PARTITION, got '${this.peek().value}'`);
      this.next();
      spec.partitionBy = [];
      for (;;) {
        spec.partitionBy.push(this.parseOperand());
        if (this.peek().type === 'op' && this.peek().value === ',') { this.next(); continue; }
        break;
      }
    }
    if (this.isWord('ORDER')) {
      this.next();
      if (!this.isWord('BY')) throw new Error(`Expected BY after ORDER, got '${this.peek().value}'`);
      this.next();
      spec.orderBy = [];
      for (;;) {
        const col = this.parseOperand();
        let dir = 'asc';
        if (this.isWord('ASC')) { this.next(); }
        else if (this.isWord('DESC')) { this.next(); dir = 'desc'; }
        spec.orderBy.push({ column: col, dir });
        if (this.peek().type === 'op' && this.peek().value === ',') { this.next(); continue; }
        break;
      }
    }
    if (this.isWord('ROWS') || this.isWord('RANGE')) spec.frame = this.parseFrameSpec();
    this.expect('op', ')');
    node.over = spec;
    return node;
  }

  // ROWS/RANGE BETWEEN <bound> AND <bound> | ROWS <bound>
  parseFrameSpec() {
    const unit = String(this.next().value).toUpperCase() === 'RANGE' ? 'RANGE' : 'ROWS';
    const bound = () => {
      if (this.isWord('UNBOUNDED')) {
        this.next();
        const d = String(this.next().value).toUpperCase();
        if (d !== 'PRECEDING' && d !== 'FOLLOWING') throw new Error(`Expected PRECEDING or FOLLOWING after UNBOUNDED, got '${d}'`);
        return { type: 'unbounded', direction: d === 'FOLLOWING' ? 'following' : 'preceding' };
      }
      if (this.isWord('CURRENT')) {
        this.next();
        this.next();   // ROW
        return { type: 'currentRow' };
      }
      const nTok = this.next();
      const num = nTok.type === 'number' ? nTok.value : parseInt(String(nTok.value), 10);
      if (!Number.isFinite(num)) throw new Error(`Expected number in window frame bound, got '${nTok.value}'`);
      const d = String(this.next().value).toUpperCase();
      if (d !== 'PRECEDING' && d !== 'FOLLOWING') throw new Error(`Expected PRECEDING or FOLLOWING, got '${d}'`);
      return { type: 'offset', value: num, direction: d === 'FOLLOWING' ? 'following' : 'preceding' };
    };
    let start = null, end = null;
    if (this.isWord('BETWEEN')) {
      this.next();
      start = bound();
      if (!this.isWord('AND')) throw new Error(`Expected AND in window frame, got '${this.peek().value}'`);
      this.next();
      end = bound();
    } else {
      start = bound();
    }
    return { unit, start, end };
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
        let aggDistinct = false;
        if (this.isKeyword('DISTINCT')) { this.next(); aggDistinct = true; }
        let col = null;
        if (this.peek().type === 'op' && this.peek().value === '*') { this.next(); }
        else if (!(this.peek().type === 'op' && this.peek().value === ')')) col = this.parseScalar();
        // COUNT(DISTINCT a, b) —— 多列去重（仅对 COUNT 有意义，其它聚合按元组处理）
        if (aggDistinct && this.peek().type === 'op' && this.peek().value === ',') {
          const cols = [col];
          while (this.peek().type === 'op' && this.peek().value === ',') {
            this.next();
            cols.push(this.parseScalar());
          }
          col = { type: 'tuple', items: cols };
        }
        this.expect('op', ')');
        aggregate = { type: 'COUNT', column: col, distinct: aggDistinct };
        aggregate = this.parseOptionalOver(aggregate);
        // 聚合后紧跟运算符：SUM(v)/COUNT(*) / COUNT(*)-1 …
        // 顶层聚合默认被表示为独立的 aggregate 字段，不参与后续运算，
        // 运算符会留在流里 → "Unexpected token '/' after statement"。
        // 此时整体降级成 scalar 表达式（arith 里嵌 aggregate），
        // 由执行层的嵌套聚合替换逻辑求值。
        // 注意：先看尾随运算符，再取别名 —— 顺序反了会把 AS 当成运算符的一部分。
        const cntTail = this.parseArithTail(aggregate);
        if (cntTail) {
          columns.push({ expr: null, scalar: cntTail, alias: this.parseOptionalAlias() });
        } else {
          aggregate.alias = this.parseOptionalAlias();
          columns.push({ expr: col, aggregate: 'COUNT', column: col, alias: aggregate.alias, over: aggregate.over || null, window: !!aggregate.over, distinct: aggDistinct });
        }
      } else if (t.type === 'keyword' && ['SUM', 'AVG', 'MIN', 'MAX'].includes(t.value)) {
        this.next();
        const fn = t.value;
        this.expect('op', '(');
        let aggDistinct2 = false;
        if (this.isKeyword('DISTINCT')) { this.next(); aggDistinct2 = true; }
        const col = this.parseScalar();
        this.expect('op', ')');
        aggregate = { type: fn, column: col, distinct: aggDistinct2 };
        aggregate = this.parseOptionalOver(aggregate);
        // 同 COUNT 分支：聚合参与后续算术时降级成 scalar 表达式
        const fnTail = this.parseArithTail(aggregate);
        if (fnTail) {
          columns.push({ expr: null, scalar: fnTail, alias: this.parseOptionalAlias() });
        } else {
          aggregate.alias = this.parseOptionalAlias();
          columns.push({ expr: col, aggregate: fn, column: col, alias: aggregate.alias, over: aggregate.over || null, window: !!aggregate.over, distinct: aggDistinct2 });
        }
      } else if (t.type === 'op' && t.value === '*') {
        this.next();
        columns.push({ expr: '*' });
      } else if (t.type === 'keyword' && t.value === 'CASE') {
        const caseExpr = this.parseOperand();
        let alias = null;
        alias = this.parseOptionalAlias();
        columns.push({ expr: null, caseExpr, alias });
      } else {
        // 列 / 常量 / 函数 / 算术表达式 / 括号分组 / 标量布尔（NOT、比较、LIKE…）。
        // 此前用 parseScalar()，导致 SELECT (1+2) / SELECT NOT 0 / SELECT 'a' LIKE 'b'
        // 这类合法标量在投影列表里解析报错。parseArgExpr() 允许裸操作数，
        // 又能在存在运算符时走完整表达式解析，列/常量/函数行为不变。
        const expr = this.parseArgExpr();
        let alias = null;
        alias = this.parseOptionalAlias();
        if (expr.type === 'star') {
          columns.push({ expr: '*' });
        } else if (expr.type === 'aggregate') {
          columns.push({ expr: expr.column, aggregate: expr.fn, column: expr.column, alias, scalar: expr, distinct: expr.distinct, separator: expr.separator, orderBy: expr.orderBy });
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
    let rollup = false;
    if (this.isKeyword('GROUP')) {
      this.expectKeyword('GROUP'); this.expectKeyword('BY');
      groupBy = [];
      while (true) {
        groupBy.push(this.parseColumnRef());
        if (this.peek().type === 'op' && this.peek().value === ',') { this.next(); continue; }
        break;
      }
      // WITH ROLLUP 必须紧跟 GROUP BY 列表，之后才是 HAVING / ORDER BY / LIMIT
      // （标准顺序：GROUP BY <list> [WITH ROLLUP] [HAVING] [ORDER BY] [LIMIT]）
      if (this.isKeyword('WITH') && this.isWord('ROLLUP', 1)) {
        this.next(); this.next();
        rollup = true;
      }
    }
    let having = null;
    if (this.isKeyword('HAVING')) { this.next(); having = this.parseExpr(); }
    let orderBy = null;
    if (this.isKeyword('ORDER')) {
      this.expectKeyword('ORDER'); this.expectKeyword('BY');
      orderBy = [];
      while (true) {
        // 支持表达式排序：ORDER BY a + b DESC、ORDER BY UPPER(name)
        // 纯列名仍走 parseColumnRef，保持既有字符串形态不破坏下游
        let col;
        const save = this.pos;
        // ORDER BY 项的合法结束符；不是这些就说明是表达式（如 a+b、UPPER(name)）
        const ORDER_END = ['ASC', 'DESC', 'LIMIT', 'OFFSET', 'FETCH', 'UNION', 'INTERSECT',
          'EXCEPT', 'RETURNING', 'FOR', 'WITH'];
        const endsClause = (tk) => {
          if (tk.type === 'eof') return true;
          if (tk.type === 'op' && (tk.value === ',' || tk.value === ';' || tk.value === ')')) return true;
          return ORDER_END.some(w => this.isWord(w));
        };
        try {
          col = this.parseColumnRef();
          if (!endsClause(this.peek())) {
            this.pos = save;
            col = this.parseScalar();
          }
        } catch (e) {
          this.pos = save;
          // ORDER BY 可以引用输出列别名，而别名可能与聚合函数同名：
          //   SELECT AVG(v) AS avg FROM t GROUP BY g ORDER BY avg DESC
          // 这种 token 已被词法器标成 keyword（AVG/SUM/COUNT/MAX/MIN 都在关键字表里），
          // parseColumnRef 只认 ident 会失败，parseScalar 又会把它当函数调用 → "got 'AVG'"。
          // 此处把裸 keyword 当作列名，与 SQLite / MySQL 的行为一致。
          const tk = this.peek();
          if (tk.type === 'keyword' && !this.isWord('ASC') && !this.isWord('DESC')
              && !ORDER_END.some(w => this.isWord(w))) {
            this.next();
            col = tk.value;
          } else {
            col = this.parseScalar();
          }
        }
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
    // 集合运算：UNION [ALL|DISTINCT] / INTERSECT [ALL|DISTINCT] / EXCEPT [ALL|DISTINCT]
    let union = null, intersect = null, except = null;
    if (this.isKeyword('UNION')) {
      this.next();
      const all = this.isKeyword('ALL');
      if (all) this.next();
      else if (this.isKeyword('DISTINCT')) this.next();
      union = { all, select: this.parseSelect() };
    } else if (this.isKeyword('INTERSECT')) {
      this.next();
      const all = this.isKeyword('ALL');
      if (all) this.next();
      else if (this.isKeyword('DISTINCT')) this.next();
      intersect = { all, select: this.parseSelect() };
    } else if (this.isKeyword('EXCEPT')) {
      this.next();
      const all = this.isKeyword('ALL');
      if (all) this.next();
      else if (this.isKeyword('DISTINCT')) this.next();
      except = { all, select: this.parseSelect() };
    }
    // FETCH FIRST n ROWS ONLY（SQL 标准的 LIMIT 写法）
    if (this.isWord('FETCH')) {
      this.next();
      if (this.isWord('FIRST') || this.isWord('NEXT')) this.next();
      else throw new Error(`Expected FIRST or NEXT after FETCH, got '${this.peek().value}'`);
      const nTok = this.next();
      const n = nTok.type === 'number' ? nTok.value : Number(nTok.value);
      if (!Number.isFinite(n)) throw new Error(`Expected row count after FETCH FIRST, got '${nTok.value}'`);
      limit = n;
      if (this.isWord('ROW') || this.isWord('ROWS')) this.next();
      if (this.isWord('ONLY')) this.next();
    }
    this.optionalTailSemicolon();

    return { type: 'select', columns, aggregate, distinct, from, where, groupBy, having, orderBy, limit, offset, union, intersect, except, rollup };
  }

  parseFrom() {
    const tables = [this.parseFromItem()];
    const joins = [];
    while (true) {
      let type = null;
      if (this.isKeyword('FULL')) {
        this.next();
        if (this.isKeyword('OUTER')) this.next();
        this.expectKeyword('JOIN');
        type = 'full';
      } else if (this.isKeyword('LEFT') || this.isKeyword('RIGHT')) {
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
      else if (this.peek().type === 'ident' && !NOT_ALIAS_WORDS.some(w => this.isWord(w))) { alias = this.next().value; }
      // 标准 SQL 要求 FROM 子查询必须带别名，这里放宽为自动生成，
      // 避免 README 里 SELECT ... FROM (SELECT ...) 这类示例直接报错
      if (!alias) alias = '__sub' + (++this.subquerySeq);
      return { subquery: sub, alias };
    }
    const table = this.parseTableName();
    let alias = null;
    // 这里排除的是"未进关键字表、但会跟在表名之后"的子句起始词，
    // 否则 `FROM t FETCH FIRST 10 ROWS ONLY` 会把 FETCH 当成表别名吃掉。
    if (this.isKeyword('AS')) { this.next(); alias = this.parseAlias(); }
    else if (this.peek().type === 'ident' && !NOT_ALIAS_WORDS.some(w => this.isWord(w))) {
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
    const returning = this.parseOptionalReturning();
    this.optionalTailSemicolon();
    return { type: 'update', table, assignments, where, returning };
  }

  parseDelete() {
    this.expectKeyword('DELETE');
    this.expectKeyword('FROM');
    const table = this.parseTableName();
    let where = null;
    if (this.isKeyword('WHERE')) { this.next(); where = this.parseExpr(); }
    let orderBy = null, limit = null;
    if (this.isKeyword('ORDER')) {
      this.next(); this.expectKeyword('BY');
      orderBy = [];
      for (;;) {
        const col = this.parseColumnRef();
        let dir = 'asc';
        if (this.isKeyword('ASC')) this.next();
        else if (this.isKeyword('DESC')) { this.next(); dir = 'desc'; }
        orderBy.push({ column: col, dir });
        if (this.peek().type === 'op' && this.peek().value === ',') { this.next(); continue; }
        break;
      }
    }
    if (this.isKeyword('LIMIT')) {
      this.next();
      limit = this.parseValue();
      if (typeof limit === 'number' && limit < 0) throw new Error(`LIMIT must be a non-negative integer, got ${limit}`);
    }
    const returning = this.parseOptionalReturning();
    this.optionalTailSemicolon();
    return { type: 'delete', table, where, orderBy, limit, returning };
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

  /**
   * 函数实参用的表达式：与 parseExpr 相同，但叶子允许是"裸操作数"。
   * 例如 IF(1 > 0, 'y', 'n') 的第一个参数是完整比较表达式，
   * 而 IF(age, 'y', 'n') 这种裸列名也必须能解析。
   */
  parseArgExpr() {
    this.bareExprDepth = (this.bareExprDepth || 0) + 1;
    try {
      return this.parseOr();
    } finally {
      this.bareExprDepth--;
    }
  }

  // 位运算优先级（低 → 高）：|  <  ^  <  &  <  << >>  <  加减  <  乘除模
  parseBitwise() {
    let node = this.parseBitXor();
    for (;;) {
      const t = this.peek();
      if (t.type === 'op' && t.value === '|') { this.next(); node = { type: 'arith', op: '|', left: node, right: this.parseBitXor() }; continue; }
      break;
    }
    return node;
  }

  parseBitXor() {
    let node = this.parseBitAnd();
    for (;;) {
      const t = this.peek();
      if (t.type === 'op' && t.value === '^') { this.next(); node = { type: 'arith', op: '^', left: node, right: this.parseBitAnd() }; continue; }
      break;
    }
    return node;
  }

  parseBitAnd() {
    let node = this.parseShift();
    for (;;) {
      const t = this.peek();
      if (t.type === 'op' && t.value === '&') { this.next(); node = { type: 'arith', op: '&', left: node, right: this.parseShift() }; continue; }
      break;
    }
    return node;
  }

  parseShift() {
    let node = this.parseAdditive();
    for (;;) {
      const t = this.peek();
      if (t.type === 'op' && (t.value === '<<' || t.value === '>>')) {
        this.next();
        node = { type: 'arith', op: t.value, left: node, right: this.parseAdditive() };
        continue;
      }
      break;
    }
    return node;
  }

  parseOr() {
    let left = this.parseXor();
    for (;;) {
      const isOr = this.isKeyword('OR') || (this.peek().type === 'op' && this.peek().value === '||');
      if (!isOr) break;
      this.next();
      const right = this.parseXor();
      left = { type: 'or', left, right };
    }
    return left;
  }

  // 逻辑异或 XOR（MySQL 优先级：OR < XOR < AND）
  parseXor() {
    let left = this.parseAnd();
    while (this.isWord('XOR')) {
      this.next();
      const right = this.parseAnd();
      left = { type: 'xor', left, right };
    }
    return left;
  }

  parseAnd() {
    let left = this.parseNot();
    for (;;) {
      const isAnd = this.isKeyword('AND') || (this.peek().type === 'op' && this.peek().value === '&&');
      if (!isAnd) break;
      this.next();
      const right = this.parseNot();
      left = { type: 'and', left, right };
    }
    return left;
  }

  parseNot() {
    if (this.isKeyword('NOT')) {
      this.next();
      const inner = this.parseNot();
      // NOT EXISTS (...) 折叠成 exists.not，而不是包一层 not —— 语义等价且便于执行层物化
      if (inner && inner.type === 'exists') { inner.not = !inner.not; return inner; }
      return { type: 'not', expr: inner };
    }
    // 括号分组 —— 但 `(SELECT ...)` 是标量子查询，不能当分组吃掉
    const isSubqueryParen = this.peek().type === 'op' && this.peek().value === '(' &&
      this.peek(1) && this.peek(1).type === 'keyword' && this.peek(1).value === 'SELECT';
    if (!isSubqueryParen && this.peek().type === 'op' && this.peek().value === '(') {
      this.next();
      // 递归解析括号内的完整表达式（到 ')' 为止）。
      // 此处不能用 parseExpr()：它一路走到 parseComparison，
      // 而内层看不到 ')' 会抛 "Expected comparison operator, got ')'"。
      // 用 bareExprDepth>0 的 parseArgExpr 走同一套优先级，但允许裸操作数收尾。
      this.bareExprDepth = (this.bareExprDepth || 0) + 1;
      let left;
      try {
        left = this.parseOr();
      } finally {
        this.bareExprDepth--;
      }
      this.expect('op', ')');
      // 括号整体是一个完整的左操作数，后面若紧跟运算符必须继续参与运算：
      //   SELECT (1+2)*3  /  SELECT (a+b)/2  /  WHERE (x+1) > 5
      // 直接 return 会把运算符留在流里 → "Unexpected token '*' after statement"
      // （2*(3+4) 正常是因为 '(' 出现在右操作数位置，不走这个分支。）
      // 先乘除后加减，与 parseTerm/parseAdditive 的优先级一致。
      for (;;) {
        const t = this.peek();
        if (t.type !== 'op' || !['*', '/', '%'].includes(t.value)) break;
        this.next();
        const right = this.parseExpr();
        left = { type: 'arith', op: t.value, left, right };
      }
      for (;;) {
        const t = this.peek();
        if (t.type !== 'op' || !['+', '-'].includes(t.value)) break;
        this.next();
        const right = this.parseExpr();
        left = { type: 'arith', op: t.value, left, right };
      }
      // 尾随比较/条件运算符：WHERE (a) = 1 / (a) IN (...) / (a) LIKE 'x' /
      // (a) IS NULL / (a) BETWEEN 1 AND 5 / (a) NOT IN (...)。
      // 一律交给 parseComparison —— 它是完整实现，覆盖这些全部形式。
      const nx = this.peek();
      const isCmp = nx.type === 'op' &&
        ['=', '!=', '<>', '<', '<=', '>', '>=', '<=>', '@>', '<@'].includes(nx.value);
      const isCondKw = nx.type === 'keyword' &&
        ['IN', 'LIKE', 'ILIKE', 'IS', 'BETWEEN', 'REGEXP', 'RLIKE', 'NOT'].includes(nx.value);
      if (isCmp || isCondKw) {
        return this.parseComparison(left);
      }
      return left;
    }
    // EXISTS (SELECT ...)：子查询是否存在至少一行
    if (this.isKeyword('EXISTS')) {
      this.next();
      this.expect('op', '(');
      const select = this.parseSelect();
      this.expect('op', ')');
      return { type: 'exists', select, not: false };
    }
    return this.parseComparison();
  }

  /**
   * 聚合（或任意已解析好的左操作数）之后若紧跟算术运算符，继续解析并返回
   * 组合后的 arith 节点；没有运算符则返回 null（调用方走原有的 aggregate 列路径）。
   *   SELECT SUM(v)/COUNT(*)   → arith('/', SUM, arith('/', COUNT))
   * 优先级与 parseTerm / parseAdditive 一致：先乘除后加减。
   */
  parseArithTail(left) {
    // 投影分支里的 aggregate 对象是 { type: 'SUM', column, distinct } ——
    // type 直接是聚合函数名，不是 'aggregate'。而执行层的 _replaceAggregates
    // 只认 type === 'aggregate'，不规范化就会漏替换 → 整个表达式求值为 null。
    // 这里包一层 { type:'aggregate', fn, column, … } 供替换逻辑识别。
    const seed = left && left.type !== 'aggregate' && typeof left.type === 'string' &&
      /^[A-Z][A-Z0-9_]*$/.test(left.type)
      ? { type: 'aggregate', fn: left.type, column: left.column,
          distinct: left.distinct, separator: left.separator, orderBy: left.orderBy }
      : left;

    let node = seed;
    let touched = false;
    for (;;) {
      const t = this.peek();
      if (t.type !== 'op' || !['*', '/', '%'].includes(t.value)) break;
      this.next();
      node = { type: 'arith', op: t.value, left: node, right: this.parseScalar() };
      touched = true;
    }
    for (;;) {
      const t = this.peek();
      if (t.type !== 'op' || !['+', '-'].includes(t.value)) break;
      this.next();
      node = { type: 'arith', op: t.value, left: node, right: this.parseScalar() };
      touched = true;
    }
    return touched ? node : null;
  }

  /**
   * 解析聚合调用：fn ( [DISTINCT] expr [, expr*] [ORDER BY ...] [SEPARATOR 'x'] )
   * 以及 COUNT(*) 这类无参形式。
   */
  parseAggregateCall(fn) {
    this.expect('op', '(');
    const distinct = this.isKeyword('DISTINCT');
    if (distinct) this.next();
    let column = null;
    let separator = null;
    let innerOrder = null;
    if (this.peek().type === 'op' && this.peek().value === '*') {
      this.next();
    } else if (!(this.peek().type === 'op' && this.peek().value === ')')) {
      column = this.parseScalar();
      // COUNT(DISTINCT a, b)：多列去重
      if (distinct && this.peek().type === 'op' && this.peek().value === ',') {
        const cols = [column];
        while (this.peek().type === 'op' && this.peek().value === ',') {
          this.next();
          cols.push(this.parseScalar());
        }
        column = { type: 'tuple', items: cols };
      } else if (this.peek().type === 'op' && this.peek().value === ',') {
        // GROUP_CONCAT(expr, 'sep')
        this.next();
        separator = this.parseValue();
      }
      // GROUP_CONCAT(expr ORDER BY col [DESC])
      if (this.isKeyword('ORDER')) {
        this.next();
        if (!this.isKeyword('BY')) throw new Error('Expected BY after ORDER in aggregate, got ' + "'" + this.peek().value + "'");
        this.next();
        innerOrder = [];
        for (;;) {
          const oCol = this.parseColumnRef();
          let oDir = 'asc';
          if (this.isKeyword('ASC')) this.next();
          else if (this.isKeyword('DESC')) { this.next(); oDir = 'desc'; }
          innerOrder.push({ column: oCol, dir: oDir });
          if (this.peek().type === 'op' && this.peek().value === ',') { this.next(); continue; }
          break;
        }
      }
      // GROUP_CONCAT(expr SEPARATOR 'sep')
      if (this.isWord('SEPARATOR')) {
        this.next();
        separator = this.parseValue();
      }
    }
    this.expect('op', ')');
    return this.parseOptionalOver({ type: 'aggregate', fn, column, distinct, separator, orderBy: innerOrder });
  }

  parseOperand() {
    const t = this.next();
    if (t.type === 'ident') {
      // 聚合函数名（GROUP_CONCAT / STDDEV / FIRST...）走 aggregate 节点，
      // 否则会被当作逐行标量函数：既返回 null，又不会折叠分组
      if (AGG_FUNCS.has(String(t.value).toUpperCase()) &&
          this.peek().type === 'op' && this.peek().value === '(') {
        const agg = this.parseAggregateCall(String(t.value).toUpperCase());
        // 聚合结果也是一个完整的左操作数，后面可紧跟运算符：
        //   SELECT SUM(sal)/COUNT(*) AS avg   ← 算平均值的标准写法
        //   SELECT SUM(sal) - MIN(sal)        ← 极差
        //   SELECT MAX(sal) * 2
        // 不处理的话运算符会留在流里 → "Unexpected token '/' after statement"。
        // （加括号写成 (SUM(sal))/2 之所以正常，是走了括号分组分支。）
        let left = agg;
        for (;;) {
          const nx = this.peek();
          if (nx.type !== 'op' || !['*', '/', '%'].includes(nx.value)) break;
          this.next();
          left = { type: 'arith', op: nx.value, left, right: this.parseOperand() };
        }
        for (;;) {
          const nx = this.peek();
          if (nx.type !== 'op' || !['+', '-'].includes(nx.value)) break;
          this.next();
          left = { type: 'arith', op: nx.value, left, right: this.parseOperand() };
        }
        return left;
      }
      // 支持 alias.column 引用
      if (this.peek().type === 'op' && this.peek().value === '.') {
        this.next();
        const col = this.next();
        if (col.type === 'op' && col.value === '*') return { type: 'star', alias: t.value };
        if (col.type !== 'ident') throw new Error(`Expected column name after '.', got '${col.value}'`);
        return { type: 'column', name: t.value + '.' + col.value };
      }
      // CAST(expr AS type)
      if (String(t.value).toUpperCase() === 'CAST' && this.peek().type === 'op' && this.peek().value === '(') {
        this.next();
        const expr = this.parseScalar();
        if (!this.isWord('AS')) throw new Error(`Expected AS in CAST, got '${this.peek().value}'`);
        this.next();
        const typeTok = this.next();
        let dataType = String(typeTok.value).toUpperCase();
        // VARCHAR(10) / DECIMAL(10,2) 这类带长度的类型
        if (this.peek().type === 'op' && this.peek().value === '(') {
          this.next();
          let depth = 1;
          let spec = '';
          while (depth > 0 && this.peek().type !== 'eof') {
            const tk = this.next();
            if (tk.type === 'op' && tk.value === '(') depth++;
            else if (tk.type === 'op' && tk.value === ')') { depth--; if (depth === 0) break; }
            spec += tk.value;
          }
          dataType += '(' + spec + ')';
        }
        this.expect('op', ')');
        return { type: 'cast', expr, dataType };
      }
      // 零参时间函数：CURRENT_DATE / CURRENT_TIME / CURRENT_TIMESTAMP（可省略括号）。
      // 此前不在 KEYWORDS 里，被当成列名解析 → "no such column: CURRENT_DATE"
      if (['CURRENT_DATE', 'CURRENT_TIME', 'CURRENT_TIMESTAMP'].includes(String(t.value).toUpperCase())) {
        const name = String(t.value).toUpperCase();
        if (this.peek().type === 'op' && this.peek().value === '(') { this.next(); this.expect('op', ')'); }
        return { type: 'func', name, args: [] };
      }
      // EXTRACT(YEAR FROM expr) —— 标准 SQL 的 FROM 形式
      if (String(t.value).toUpperCase() === 'EXTRACT' && this.peek().type === 'op' && this.peek().value === '(') {
        this.next();
        const unitTok = this.next();
        const unit = String(unitTok.value).toUpperCase();
        if (!this.isWord('FROM')) throw new Error(`Expected FROM in EXTRACT, got '${this.peek().value}'`);
        this.next();
        const arg = this.parseOperand();
        this.expect('op', ')');
        return { type: 'func', name: 'EXTRACT', args: [{ type: 'value', value: unit }, arg] };
      }
      // SUBSTR(s FROM n [FOR m]) / TRIM([LEADING|TRAILING|BOTH] ['x'] FROM s)
      if (['SUBSTR', 'SUBSTRING'].includes(String(t.value).toUpperCase()) && this.peek().type === 'op' && this.peek().value === '(') {
        const name = String(t.value).toUpperCase();
        this.next();
        const s = this.parseOperand();
        let fromV = null, forV = null;
        if (this.isWord('FROM')) {
          this.next();
          fromV = this.parseOperand();
          if (this.isWord('FOR')) { this.next(); forV = this.parseOperand(); }
        } else if (this.peek().type === 'op' && this.peek().value === ',') {
          this.next();
          fromV = this.parseOperand();
          if (this.peek().type === 'op' && this.peek().value === ',') { this.next(); forV = this.parseOperand(); }
        }
        this.expect('op', ')');
        const args = [s];
        if (fromV) args.push(fromV);
        if (forV) args.push(forV);
        return { type: 'func', name, args };
      }
      if (String(t.value).toUpperCase() === 'TRIM' && this.peek().type === 'op' && this.peek().value === '(') {
        this.next();
        let spec = null;
        if (this.isWord('LEADING') || this.isWord('TRAILING') || this.isWord('BOTH')) {
          spec = String(this.next().value).toUpperCase();
        }
        const first = this.parseOperand();
        let target = null;
        if (this.isWord('FROM')) {
          this.next();
          target = this.parseOperand();
        } else if (this.peek().type === 'op' && this.peek().value === ',') {
          this.next();
          target = this.parseOperand();
        }
        this.expect('op', ')');
        // 归一成 TRIM(target[, chars[, spec]])，与 applyScalarFunction 的既有签名兼容
        if (target === null) return { type: 'func', name: 'TRIM', args: [first] };
        const args = [target, first];
        if (spec) args.push({ type: 'value', value: spec });
        return { type: 'func', name: 'TRIM', args };
      }
      // 函数调用: VERSION() / CONCAT(a, b) / NOW() ...
      if (this.peek().type === 'op' && this.peek().value === '(') {
        const name = t.value;
        this.next();
        const args = [];
        if (!(this.peek().type === 'op' && this.peek().value === ')')) {
          for (;;) {
            if (this.peek().type === 'op' && this.peek().value === '*') { this.next(); args.push({ type: 'star' }); }
            // INTERVAL n UNIT（DATE_ADD/DATE_SUB 用）
            else if (this.isWord('INTERVAL')) {
              this.next();
              const nTok = this.peek();
              let nVal;
              if (nTok.type === 'op' && (nTok.value === '-' || nTok.value === '+')) {
                this.next();
                const numTok = this.next();
                nVal = (nTok.value === '-' ? -1 : 1) * Number(numTok.value);
              } else {
                this.next();
                nVal = Number(nTok.value);
              }
              const unitTok = this.next();
              args.push({ type: 'interval', value: nVal, unit: String(unitTok.value).toUpperCase() });
            }
            // 实参允许完整的比较/布尔表达式，例如 IF(status = 'paid', amount, 0)
            else args.push(this.parseArgExpr());
            // GROUP_CONCAT(name ORDER BY age)：聚合函数内部的排序
            if (this.isKeyword('ORDER')) {
              this.next();
              if (!this.isKeyword('BY')) throw new Error(`Expected BY after ORDER in aggregate, got '${this.peek().value}'`);
              this.next();
              const innerOrder = [];
              for (;;) {
                const oCol = this.parseColumnRef();
                let oDir = 'asc';
                if (this.isKeyword('ASC')) this.next();
                else if (this.isKeyword('DESC')) { this.next(); oDir = 'desc'; }
                innerOrder.push({ column: oCol, dir: oDir });
                if (this.peek().type === 'op' && this.peek().value === ',') { this.next(); continue; }
                break;
              }
              this.expect('op', ')');
              return this.parseOptionalOver({ type: 'func', name, args, orderBy: innerOrder });
            }
            if (this.peek().type === 'op' && this.peek().value === ',') { this.next(); continue; }
            break;
          }
        }
        this.expect('op', ')');
        return this.parseOptionalOver({ type: 'func', name, args });
      }
      // 时间单位裸关键字（TIMESTAMPDIFF(MONTH, a, b) 里的 MONTH）：
      // 解析成 unit 节点，取值时优先当列、取不到才当单位名，
      // 这样既支持裸写法，也不影响真正名为 month/year 的列。
      if (TIME_UNITS.has(String(t.value).toUpperCase()) &&
          !(this.peek().type === 'op' && (this.peek().value === '(' || this.peek().value === '.'))) {
        return { type: 'unit', name: String(t.value).toUpperCase() };
      }
      return { type: 'column', name: t.value };
    }
    if (t.type === 'number' || t.type === 'string') return { type: 'value', value: t.value };
    if (t.type === 'sysvar') return { type: 'sysvar', name: t.value };
    if (t.type === 'param') return { type: 'param', index: t.value, position: this.paramCount++ };
    if (t.type === 'keyword' && t.value === 'NULL') return { type: 'value', value: null };
    // MySQL: TRUE/FALSE 是 1/0 的别名，可作为值字面量出现在任意表达式位置
    if (t.type === 'keyword' && t.value === 'TRUE') return { type: 'value', value: true };
    if (t.type === 'keyword' && t.value === 'FALSE') return { type: 'value', value: false };
    if (t.type === 'keyword' && t.value === 'CASE') return this.parseCase();
    if (t.type === 'keyword' && !['SUM', 'AVG', 'MIN', 'MAX', 'COUNT'].includes(t.value) && this.peek().type === 'op' && this.peek().value === '(') {
      const name = t.value;
      this.next();
      const args = [];
      if (!(this.peek().type === 'op' && this.peek().value === ')')) {
        for (;;) {
          if (this.peek().type === 'op' && this.peek().value === '*') { this.next(); args.push({ type: 'star' }); }
          else args.push(this.parseArgExpr());
          if (this.peek().type === 'op' && this.peek().value === ',') { this.next(); continue; }
          break;
        }
      }
      this.expect('op', ')');
      return this.parseOptionalOver({ type: 'func', name, args });
    }
    if (AGG_FUNCS.has(String(t.value).toUpperCase()) &&
        this.peek().type === 'op' && this.peek().value === '(') {
      return this.parseAggregateCall(String(t.value).toUpperCase());
    }
    // 裸关键字、且后面不跟 '(' → 当作列名/别名。
    // 典型场景：SELECT AVG(v) AS avg FROM t GROUP BY g ORDER BY avg DESC
    // 'avg' 已被词法器标成 keyword（AVG 在关键字表里），既进不了 parseColumnRef（只认 ident），
    // 也不满足上面的聚合调用分支（后面是 DESC 不是 '('），最终会抛 "got 'AVG'"。
    // ORDER BY 引用输出别名是标准 SQL 行为，SQLite / MySQL 都允许。
    if (t.type === 'keyword' && !(this.peek().type === 'op' && this.peek().value === '(')) {
      return { type: 'column', name: t.value };
    }
    // 一元按位取反 ~x
    if (t.type === 'op' && t.value === '~') {
      return { type: 'bitnot', expr: this.parseOperand() };
    }
    if (t.type === 'op' && t.value === '(' && this.peek().type === 'keyword' && this.peek().value === 'SELECT') {
      const sub = this.parseSelect();
      this.expect('op', ')');
      return { type: 'subquery', select: sub };
    }
    // 括号分组：支持 (1+2)、2*(3+4) 等出现在算术/函数参数任意位置
    // 注意：parseOperand 开头已通过 const t = this.next() 消费了 '(', 此处不可再 next()
    //
    // 括号整体是一个完整的左操作数，后面若紧跟运算符必须继续参与运算，
    // 否则运算符会留在流里：
    //   SELECT (1+2)*3        → Unexpected token '*' after statement
    //   WHERE (a) = 1         → Expected comparison operator, got ')'
    if (t.type === 'op' && t.value === '(') {
      let left = this.parseArgExpr();   // 容忍裸操作数，允许纯算术分组
      this.expect('op', ')');
      // 先乘除后加减，与 parseTerm / parseAdditive 的优先级一致
      for (;;) {
        const nx = this.peek();
        if (nx.type !== 'op' || !['*', '/', '%'].includes(nx.value)) break;
        this.next();
        left = { type: 'arith', op: nx.value, left, right: this.parseArgExpr() };
      }
      for (;;) {
        const nx = this.peek();
        if (nx.type !== 'op' || !['+', '-'].includes(nx.value)) break;
        this.next();
        left = { type: 'arith', op: nx.value, left, right: this.parseArgExpr() };
      }
      // 尾随比较运算符交给 parseComparison（完整实现，覆盖 =/</>/LIKE/IN/IS…）
      const cx = this.peek();
      if (cx.type === 'op' && ['=', '!=', '<>', '<', '<=', '>', '>=', '<=>'].includes(cx.value)) {
        return this.parseComparison(left);
      }
      return left;
    }
    if (t.type === 'op' && (t.value === '-' || t.value === '+')) {
      const num = this.next();
      if (num.type !== 'number') throw new Error('Expected number after sign');
      return { type: 'value', value: t.value === '-' ? -num.value : num.value };
    }
    throw new Error(`Expected value or column, got '${t.value}'`);
  }

  // 加减（左结合）
  parseAdditive() {
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

  /**
   * 标量表达式：算术 + 位运算，外加 IN / IS 后缀。
   * 位运算要走到这里，否则 SELECT 列表里的 `SELECT 1 << 8` 无法解析
   * （parseComparison 只在 WHERE 等布尔上下文被调用）。
   */
  parseScalar() {
    let node = this.parseBitwise();
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
    let node = this.parsePostfix(this.parseOperand());
    for (;;) {
      const t = this.peek();
      if (t.type === 'op' && (t.value === '*' || t.value === '/' || t.value === '%')) {
        this.next();
        const right = this.parsePostfix(this.parseOperand());
        node = { type: 'arith', op: t.value, left: node, right };
        continue;
      }
      // MySQL 整数除法：7 DIV 2 → 3
      if (this.isWord('DIV')) {
        this.next();
        const right = this.parsePostfix(this.parseOperand());
        node = { type: 'arith', op: 'DIV', left: node, right };
        continue;
      }
      break;
    }
    return node;
  }

  /**
   * 后缀运算符（绑定最紧）：PG 风格 `::` 类型转换、`->` / `->>` JSON 取值。
   * 例：'5'::INT、meta->>'name'、meta->'addr'->>'city'。
   */
  parsePostfix(node) {
    for (;;) {
      const t = this.peek();
      if (t.type === 'op' && t.value === '::') {
        this.next();
        const typeTok = this.next();
        let dataType = String(typeTok.value).toUpperCase();
        if (this.peek().type === 'op' && this.peek().value === '(') {
          this.next();
          let depth = 1, spec = '';
          while (depth > 0 && this.peek().type !== 'eof') {
            const tk = this.next();
            if (tk.type === 'op' && tk.value === '(') depth++;
            else if (tk.type === 'op' && tk.value === ')') { depth--; if (depth === 0) break; }
            spec += tk.value;
          }
          dataType += '(' + spec + ')';
        }
        node = { type: 'cast', expr: node, dataType };
        continue;
      }
      if (t.type === 'op' && (t.value === '->' || t.value === '->>')) {
        this.next();
        const key = this.parseValue();
        node = { type: 'jsonAccess', operand: node, key, asText: t.value === '->>' };
        continue;
      }
      // PG 路径取值：meta#>'{a,b}' / meta#>>'{a,b}'
      if (t.type === 'op' && (t.value === '#>' || t.value === '#>>')) {
        this.next();
        const key = this.parseValue();
        node = { type: 'jsonAccess', operand: node, key, asText: t.value === '#>>', isPath: true };
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
        // 条件可能是完整比较（WHEN a > 1），也可能是裸值/裸列（WHEN 1、WHEN flag）。
        // parseComparison 只接受比较式，裸值会抛 "Expected comparison operator, got 'THEN'"。
        // 先看清下一个 token 决定走哪条路，避免用 try/catch 回溯吞掉真实错误。
        const nx = this.peek();
        const isCmp = (nx.type === 'op' && ['=', '!=', '<>', '<', '<=', '>', '>=', '<=>'].includes(nx.value)) ||
          (nx.type === 'keyword' && ['IN', 'LIKE', 'ILIKE', 'IS', 'BETWEEN', 'REGEXP', 'RLIKE', 'NOT'].includes(nx.value)) ||
          this.isWord('NOT');
        cond = isCmp ? this.parseComparison()
          : { type: 'isTruth', operand: this.parseArgExpr(), not: false, truth: true };
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

  /**
   * 解析比较表达式。
   * preLeft：已解析好的左操作数（括号分组场景 —— parseNot 消费到 ')' 后传进来），
   *          省略时正常从 parseBitwise() 取左操作数。
   */
  parseComparison(preLeft) {
    const left = preLeft !== undefined ? preLeft : this.parseBitwise();
    const t = this.peek();
    let not = false;
    if (t.type === 'keyword' && t.value === 'NOT') {
      this.next();
      not = true;
      // NOT 后必须紧跟比较关键字
      const n = this.peek();
      if (!['IN', 'BETWEEN', 'LIKE', 'REGEXP', 'RLIKE', 'ILIKE'].includes(n.value)) {
        throw new Error(`Expected IN, BETWEEN, LIKE, ILIKE, REGEXP or RLIKE after NOT, got '${n.value}'`);
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

    // ILIKE 刻意不加进 KEYWORDS（避免影响同名标识符），用 isWord 按上下文匹配
    if ((t2.type === 'keyword' && t2.value === 'LIKE') || this.isWord('ILIKE')) {
      this.next();
      // 可选 BINARY 关键字：LIKE BINARY '...' 才区分大小写
      let binary = false;
      if (this.isWord('BINARY')) { this.next(); binary = true; }
      const pattern = this.parseValue();
      // 可选 ESCAPE 子句：LIKE '...' ESCAPE '!'
      let escape = null;
      if (this.isWord('ESCAPE')) { this.next(); escape = this.parseValue(); }
      // MySQL 的 LIKE 默认不区分大小写（默认 collation 为 CI），
      // 此前写成 ci: isILike，导致 LIKE 恒为大小写敏感。
      return { type: 'like', operand: left, pattern, not, ci: !binary, escape };
    }

    // PG 正则操作符（双目位置）：~（大小写敏感）/ ~*（不敏感）/ !~ / !~*
    if (t2.type === 'op' && (t2.value === '~' || t2.value === '~*' || t2.value === '!~' || t2.value === '!~*')) {
      this.next();
      const pattern = this.parseValue();
      return {
        type: 'regexp', operand: left, pattern,
        not: t2.value.startsWith('!') || not,
        ci: t2.value.endsWith('*'),
      };
    }

    // PG JSON 键存在：? / ?| / ?&
    // 裸 `?` 在此处处于"运算符位置"，与值位置上的 `?` 参数占位符不冲突。
    if ((t2.type === 'op' && (t2.value === '?|' || t2.value === '?&')) ||
        (t2.type === 'param' && t2.value === null)) {
      const mode = t2.type === 'param' ? '?' : t2.value;
      this.next();
      const keys = this.parseValue();
      return { type: 'jsonKeyExists', operand: left, keys, mode, not };
    }

    // MySQL 中 RLIKE 是 REGEXP 的同义词
    if (t2.type === 'keyword' && (t2.value === 'REGEXP' || t2.value === 'RLIKE')) {
      this.next();
      const pattern = this.parseValue();
      return { type: 'regexp', operand: left, pattern, not };
    }

    // PG JSON 包含操作符
    if (t2.type === 'op' && (t2.value === '@>' || t2.value === '<@')) {
      this.next();
      const right = this.parseBitwise();
      return { type: 'jsonContains', op: t2.value, left, right, not };
    }

    if (t2.type === 'op' && ['=', '!=', '<>', '<', '<=', '>', '>=', '<=>'].includes(t2.value)) {
      this.next();
      // = ANY (SELECT ...) / > ALL (SELECT ...)
      const anyAll = this.isWord('ANY') || this.isWord('ALL') || this.isWord('SOME');
      if (anyAll) {
        const quantifier = String(this.next().value).toUpperCase() === 'ALL' ? 'ALL' : 'ANY';
        this.expect('op', '(');
        const sub = this.parseSelect();
        this.expect('op', ')');
        return { type: 'quantified', op: t2.value === '<>' ? '!=' : t2.value, operand: left, select: sub, quantifier, not };
      }
      const right = this.parseBitwise();
      return { type: 'compare', op: t2.value === '<>' ? '!=' : t2.value, left, right };
    }

    // 函数实参场景允许裸操作数（IF(age, ...) / SUM(IF(...)) 等）
    if (this.bareExprDepth > 0) return left;

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

/** CAST(expr AS type) 的类型转换 */
function applyCast(value, dataType) {
  const t = String(dataType || '').toUpperCase().replace(/\(.*\)$/, '').trim();
  if (value === null || value === undefined) return null;
  // SIGNED / UNSIGNED 是 MySQL 的整型别名（CAST(x AS SIGNED)），
  // 此前没列入整型分支，导致 CAST('12abc' AS SIGNED) 原样返回字符串。
  if (t === 'INTEGER' || t === 'INT' || t === 'BIGINT' || t === 'SMALLINT' ||
      t === 'TINYINT' || t === 'SIGNED' || t === 'UNSIGNED' || t === 'MEDIUMINT') {
    // MySQL CAST(... AS SIGNED/INT)：取数字前缀（'12abc'→12），无法解析时返回 0（而非 null）。
    if (typeof value === 'boolean') return value ? 1 : 0;
    if (typeof value === 'number') return Number.isFinite(value) ? Math.trunc(value) : 0;
    const m = String(value).trim().match(/^[+-]?\d+(\.\d+)?/);
    return m ? Math.trunc(Number(m[0])) : 0;
  }
  if (t === 'FLOAT' || t === 'DOUBLE' || t === 'REAL' || t === 'NUMERIC' || t === 'DECIMAL') {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  if (t === 'BOOLEAN' || t === 'BOOL') {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value !== 0;
    const s = String(value).toLowerCase();
    return s === 'true' || s === '1' || s === 't' || s === 'yes';
  }
  if (t === 'TEXT' || t === 'VARCHAR' || t === 'CHAR' || t === 'STRING') return String(value);
  return value;
}

// 行对象里是否存在 `alias.col` 形式的键（即该行是否已被加过表前缀）
function rowHasPrefixedKeys(row) {
  for (const k in row) if (k.indexOf('.') !== -1) return true;
  return false;
}

/**
 * 字符串能否当作数值参与算术运算。
 * MySQL 里 '5' + 5 = 10、'5' + '5' = 10、'abc' + 1 = 1（非数字按 0）。
 * 纯数字（含小数/负号/科学计数）才返回数值，否则返回 null。
 */
function numericIfNumeric(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (s === '') return null;
  // 严格数字：可选符号 + 数字（含小数与指数），不接受 '12abc' 这类前缀形式
  if (!/^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

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
      if (n.indexOf('.') !== -1) {
        const col = n.slice(n.lastIndexOf('.') + 1);
        // 只有当行完全没有带前缀的键（即行未被 _prefixRow 处理过）时才回退到裸列名。
        // 否则 `e.dept` 这种未知限定符会静默取到当前行自己的 dept，
        // 让相关子查询变成“自匹配”，EXISTS 恒为真。
        if (!rowHasPrefixedKeys(row) && row[col] !== undefined) return row[col];
      }
      // 相关子查询：回退到外层行（ctx.__outer 由 _evalExists 临时注入）
      if (ctx && ctx.__outer && ctx.__outer[n] !== undefined) return ctx.__outer[n];
      return undefined;
    }
    case 'arith': {
      const l = resolveOperand(operand.left, row, ctx);
      const r = resolveOperand(operand.right, row, ctx);
      if (l === null || r === null || l === undefined || r === undefined) return null;
      switch (operand.op) {
        // MySQL/SQLite 里 + 永远是算术加法，字符串拼接只走 || 或 CONCAT。
        // 直接用 JS 的 l + r 会让 '5' + 5 得到 '55'（静默返回字符串），
        // 数字与字符串混合的算术会一路错下去。
        // 判据：任一侧是 number，或字符串能被完整解析为数字 → 走数值加法。
        case '+': {
          // MySQL / SQLite 语义（已用 sqlite3 实测核对）：
          //   '5' + 5 = 10   '5' + '5' = 10   'abc' + 1 = 1   'a' + 'b' = 0
          // 任一侧是「数值」时做算术加法，另一侧非数值按 0；
          // 两侧都不是数值才是 0（JS 的 l + r 会把 '5' + 5 拼成 '55'）。
          if (typeof l === 'number' || typeof r === 'number') {
            const ln2 = numericIfNumeric(l), rn2 = numericIfNumeric(r);
            return (ln2 === null ? 0 : ln2) + (rn2 === null ? 0 : rn2);
          }
          const ln = numericIfNumeric(l), rn = numericIfNumeric(r);
          if (ln !== null) return ln + (rn === null ? 0 : rn);
          if (rn !== null) return rn;   // 左侧非数值按 0
          return 0;
        }
        case '-': return Number(l) - Number(r);
        case '*': return Number(l) * Number(r);
        case '/': return r === 0 ? null : Number(l) / Number(r);
        case '%': return r === 0 ? null : Number(l) % Number(r);
        // MySQL 整数除法 DIV（结果向零取整）
        case 'DIV': return r === 0 ? null : Math.trunc(Number(l) / Number(r));
        // 位运算：先按整数归一，与 MySQL 的整数位运算语义一致
        case '&': return (Number(l) | 0) & (Number(r) | 0);
        case '|': return (Number(l) | 0) | (Number(r) | 0);
        case '^': return (Number(l) | 0) ^ (Number(r) | 0);
        case '<<': return (Number(l) | 0) << (Number(r) | 0);
        case '>>': return (Number(l) | 0) >> (Number(r) | 0);
      }
      return null;
    }
    case 'bitnot':
      return ~(Number(resolveOperand(operand.expr, row, ctx)) | 0);
    case 'func':
      return applyScalarFunction(operand, row, ctx);
    case 'case':
      return evaluateCaseVal(operand, row, ctx);
    // 布尔类节点出现在"取值"位置时（如 IF(status = 'paid', ...)、SUM(IF(a > b,1,0))），
    // 求值成 true/false 供上层按真值判断
    case 'compare':
    case 'and':
    case 'or':
    case 'xor':
    case 'not':
    case 'in':
    case 'isNull':
    case 'isTruth':
    case 'exists':
    case 'regexp':
    case 'like':
    case 'between':
      return evaluateExpr(operand, row, ctx);
    case 'unit': {
      // 裸时间单位（MONTH / DAY …）：优先当列取，取不到就返回单位名本身
      const lower = String(operand.name).toLowerCase();
      const v = row ? row[lower] : undefined;
      return v !== undefined ? v : String(operand.name).toUpperCase();
    }
    case 'param': {
      // 原生 ? 占位符。executeSQL 默认会先用 applyParams 内联替换，
      // 只有在显式传入 ctx.params 时才走这条路径。
      const params = ctx && ctx.params;
      if (params == null) return undefined;
      if (operand.index === '??') {
        return typeof params === 'object' && !Array.isArray(params) ? params['@@'] : undefined;
      }
      const i = operand.index != null && operand.index !== '??' ? operand.index - 1 : (operand.position || 0);
      return Array.isArray(params) ? params[i] : params[i];
    }
    case 'cast': {
      const v = resolveOperand(operand.expr, row, ctx);
      return applyCast(v, operand.dataType);
    }
    case 'jsonAccess': {
      let base = resolveOperand(operand.operand, row, ctx);
      if (base === null || base === undefined) return null;
      // JSON 列可能以字符串形式存储，先解析
      if (typeof base === 'string') {
        try { base = JSON.parse(base); } catch (e) { return null; }
      }
      const keys = operand.isPath ? parsePgPath(operand.key) : [operand.key];
      let v = base;
      for (const key of keys) {
        if (v === null || v === undefined) return null;
        if (Array.isArray(v)) {
          const idx = Number(key);
          v = Number.isInteger(idx) ? (idx < 0 ? v[v.length + idx] : v[idx]) : undefined;
        } else if (typeof v === 'object') {
          v = v[key];
        } else {
          return null;
        }
      }
      if (v === undefined) return null;
      if (operand.asText) {
        if (v === null) return null;
        return typeof v === 'object' ? JSON.stringify(v) : String(v);
      }
      return v;
    }
    case 'jsonContains': {
      const l = resolveOperand(operand.left, row, ctx);
      const r = resolveOperand(operand.right, row, ctx);
      const res = jsonContains(l, r, operand.op === '<@');
      return operand.not ? !res : res;
    }
    case 'jsonKeyExists': {
      const base = resolveOperand(operand.operand, row, ctx);
      const res = jsonKeyExists(base, operand.keys, operand.mode);
      return operand.not ? !res : res;
    }
    case 'quantified': {
      // = ANY / > ALL (SELECT ...) —— 需先由执行层物化成 operand._list
      const v = resolveOperand(operand.operand, row, ctx);
      const list = operand._list || [];
      if (list.length === 0) return operand.quantifier === 'ALL';
      const fn = OPERATORS[operand.op];
      if (!fn) return false;
      const results = list.map(x => (v === null || x === null) ? false : fn(v, x));
      return operand.quantifier === 'ALL' ? results.every(Boolean) : results.some(Boolean);
    }
    case 'subquery':
      // 相关子查询：值由 _evalCorrelated 按外层行算好写回 _value
      return operand._value !== undefined ? operand._value : null;
    case 'aggregate':
      return undefined;
    default:
      return undefined;
  }
}

/** 解析 SQL 里的日期文本（'YYYY-MM-DD' / 'YYYY-MM-DD HH:MM:SS' / Date） */
function parseSqlDate(v) {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  const s = String(v).trim().replace(' ', 'T');
  const d = new Date(s.length <= 10 ? s + 'T00:00:00' : s);
  return Number.isNaN(d.getTime()) ? null : d;
}

function pad2(n) { return String(n).padStart(2, '0'); }

/** 本地时区的 'YYYY-MM-DD HH:mm:ss'（MySQL 的 NOW() 语义；区别于 UTC_TIMESTAMP） */
function sqlLocalDateTime(d = new Date()) {
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' +
    pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
}

/** 按输入形态回写日期：纯日期返回 YYYY-MM-DD，带时间返回 YYYY-MM-DD HH:MM:SS */
function fmtSqlDate(dateOnly, d) {
  const ymd = d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  return dateOnly ? ymd : ymd + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
}

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

/** 可作为裸关键字出现的时间单位（TIMESTAMPDIFF(MONTH, a, b) / DATE_ADD 的 INTERVAL n unit） */
const TIME_UNITS = new Set([
  'MICROSECOND', 'SECOND', 'MINUTE', 'HOUR', 'DAY', 'WEEK', 'MONTH', 'QUARTER', 'YEAR',
  'SECONDS', 'MINUTES', 'HOURS', 'DAYS', 'WEEKS', 'MONTHS', 'YEARS',
]);

/** MySQL DATE_FORMAT 的 % 说明符 */
function strftime(d, fmt) {
  const h12 = ((d.getHours() % 12) || 12);
  const map = {
    '%Y': String(d.getFullYear()), '%y': pad2(d.getFullYear() % 100),
    '%m': pad2(d.getMonth() + 1), '%c': String(d.getMonth() + 1),
    '%d': pad2(d.getDate()), '%e': String(d.getDate()),
    '%H': pad2(d.getHours()), '%k': String(d.getHours()),
    '%h': pad2(h12), '%I': pad2(h12), '%l': String(h12),
    '%i': pad2(d.getMinutes()), '%S': pad2(d.getSeconds()), '%s': pad2(d.getSeconds()),
    '%p': d.getHours() < 12 ? 'AM' : 'PM',
    '%M': MONTH_NAMES[d.getMonth()], '%b': MONTH_NAMES[d.getMonth()].slice(0, 3),
    '%W': DAY_NAMES[d.getDay()], '%a': DAY_NAMES[d.getDay()].slice(0, 3),
    '%w': String(d.getDay()),
    '%j': String(Math.round((d - new Date(d.getFullYear(), 0, 0)) / 86400000)),
    '%%': '%',
  };
  return String(fmt).replace(/%[A-Za-z%]/g, (m) => (m in map ? map[m] : m));
}

/** PG 日期格式串（YYYY-MM-DD / HH24:MI:SS）→ MySQL 的 % 说明符 */
function pgFmtToMysql(fmt) {
  const s = String(fmt);
  if (s.indexOf('%') !== -1) return s;
  // 长模式先替换成占位符，避免被短模式（MM 吃掉 MMMM）误匹配
  const rules = [
    [/YYYY/g, '\u0001'], [/YY/g, '\u0002'],
    [/MMMM/g, '\u0003'], [/MMM/g, '\u0004'], [/MM/g, '\u0005'],
    [/DDDD/g, '\u0006'], [/DDD/g, '\u0007'], [/DD/g, '\u0008'],
    [/HH24/g, '\u0009'], [/HH12/g, '\u0010'], [/HH/g, '\u0011'],
    [/MI/g, '\u0012'], [/SS/g, '\u0013'],
    [/AM/g, '\u0014'], [/PM/g, '\u0014'],
  ];
  let out = s;
  for (const [re, ch] of rules) out = out.replace(re, ch);
  const back = { '\u0001': '%Y', '\u0002': '%y', '\u0003': '%M', '\u0004': '%b', '\u0005': '%m',
    '\u0006': '%W', '\u0007': '%a', '\u0008': '%d', '\u0009': '%H', '\u0010': '%h', '\u0011': '%H',
    '\u0012': '%i', '\u0013': '%S', '\u0014': '%p' };
  return out.replace(/[\u0001-\u0014]/g, (c) => back[c] || c);
}

/** STR_TO_DATE / TO_DATE：按格式串反解出 Date */
function strToDate(s, fmt) {
  const spec = {
    Y: '(\\d{4})', y: '(\\d{2})', m: '(\\d{1,2})', c: '(\\d{1,2})',
    d: '(\\d{1,2})', e: '(\\d{1,2})',
    H: '(\\d{1,2})', k: '(\\d{1,2})', h: '(\\d{1,2})', I: '(\\d{1,2})', l: '(\\d{1,2})',
    i: '(\\d{1,2})', S: '(\\d{1,2})', s: '(\\d{1,2})',
    M: '([A-Za-z]+)', b: '([A-Za-z]+)', p: '(?:AM|PM|am|pm)?',
  };
  let pattern = '';
  const order = [];
  for (let i = 0; i < String(fmt).length;) {
    if (String(fmt)[i] === '%' && i + 1 < String(fmt).length) {
      const c = String(fmt)[i + 1];
      if (c === '%') { pattern += '%'; i += 2; continue; }
      if (spec[c]) { pattern += spec[c]; order.push(c); i += 2; continue; }
      pattern += c; i += 2; continue;
    }
    pattern += String(fmt)[i].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    i++;
  }
  const m = new RegExp('^' + pattern + '$').exec(String(s));
  if (!m) return null;
  let year = 1970, month = 0, day = 1, hour = 0, min = 0, sec = 0;
  order.forEach((c, idx) => {
    const v = m[idx + 1];
    if (v === undefined) return;
    switch (c) {
      case 'Y': year = Number(v); break;
      case 'y': year = Number(v) < 70 ? 2000 + Number(v) : 1900 + Number(v); break;
      case 'm': case 'c': month = Number(v) - 1; break;
      case 'M': case 'b': {
        const mi = MONTH_NAMES.findIndex((x) => x.toLowerCase().startsWith(String(v).toLowerCase().slice(0, 3)));
        if (mi >= 0) month = mi;
        break;
      }
      case 'd': case 'e': day = Number(v); break;
      case 'H': case 'k': hour = Number(v); break;
      case 'h': case 'I': case 'l': {
        const hh = Number(v) % 12;
        hour = /pm/i.test(String(s)) ? hh + 12 : hh;
        break;
      }
      case 'i': min = Number(v); break;
      case 'S': case 's': sec = Number(v); break;
      default: break;
    }
  });
  const d = new Date(year, month, day, hour, min, sec);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** PG DATE_PART / EXTRACT 的部件取值 */
function pgDatePart(part, d) {
  switch (String(part).toLowerCase()) {
    case 'year': case 'y': return d.getFullYear();
    case 'month': case 'mon': case 'mm': return d.getMonth() + 1;
    case 'day': case 'dd': case 'd': return d.getDate();
    case 'hour': case 'hh': return d.getHours();
    case 'minute': case 'mi': return d.getMinutes();
    case 'second': case 'ss': return d.getSeconds();
    case 'dow': return d.getDay();
    case 'doy': return Math.round((d - new Date(d.getFullYear(), 0, 0)) / 86400000);
    case 'quarter': return Math.floor(d.getMonth() / 3) + 1;
    case 'epoch': return Math.floor(d.getTime() / 1000);
    case 'week': {
      // ISO 8601 周序号
      const t = new Date(d.getFullYear(), d.getMonth(), d.getDate());
      const dayNr = (t.getDay() + 6) % 7;
      t.setDate(t.getDate() - dayNr + 3);
      const firstThursday = new Date(t.getFullYear(), 0, 4);
      const fdayNr = (firstThursday.getDay() + 6) % 7;
      firstThursday.setDate(firstThursday.getDate() - fdayNr + 3);
      return 1 + Math.round((t - firstThursday) / (7 * 86400000));
    }
    default: return null;
  }
}

/**
 * 按自然月推进并在月末做「钳制」，对齐 MySQL 的日期加减语义。
 * JS 的 setMonth()/setFullYear() 会溢出（2023-01-31 +1 月 → 2023-03-03），
 * 而 MySQL 会把超出目标月天数的日期夹到当月最后一天（→ 2023-02-28）。
 * 先 setDate(1) 再切月，避免切换过程中先溢出再被钳制。
 */
function addMonthsClamped(d, n) {
  const day = d.getDate();
  const t = new Date(d.getTime());
  t.setDate(1);
  t.setMonth(t.getMonth() + n);
  const lastDay = new Date(t.getFullYear(), t.getMonth() + 1, 0).getDate();
  t.setDate(Math.min(day, lastDay));
  d.setTime(t.getTime());
  return d;
}

/** PG AGE(from, to) 的间隔文本：'6 years 7 mons 11 days' */
function pgAge(from, to) {
  let years = to.getFullYear() - from.getFullYear();
  let months = to.getMonth() - from.getMonth();
  let days = to.getDate() - from.getDate();
  if (days < 0) {
    months -= 1;
    days += new Date(to.getFullYear(), to.getMonth(), 0).getDate();
  }
  if (months < 0) { years -= 1; months += 12; }
  return `${years} years ${months} mons ${days} days`;
}

function applyScalarFunction(fnNode, row, ctx) {
  const name = (fnNode.name || '').toUpperCase();
  const rawArgs = fnNode.args || [];
  // INTERVAL n UNIT 是语法结构而非普通值，原样传给 DATE_ADD / DATE_SUB
  const args = rawArgs.map(a => (a && a.type === 'interval')
    ? { __interval: true, value: a.value, unit: a.unit }
    : resolveOperand(a, row, ctx));
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
    // NOW() / CURDATE() / CURTIME() 返回会话时区（本地）时间，不能用 toISOString()（UTC）——
    // 否则东八区凌晨会整整差一天（2024-02-29 被存成 2024-02-28）。
    case 'NOW': case 'CURRENT_TIMESTAMP': return sqlLocalDateTime();
    case 'CURDATE': case 'CURRENT_DATE': return sqlLocalDateTime().slice(0, 10);
    case 'CURTIME': return sqlLocalDateTime().slice(11, 19);
    case 'UTC_TIMESTAMP': return new Date().toISOString().slice(0, 19).replace('T', ' ') + ' UTC';
    case 'CONCAT': return args.map(a => a === null || a === undefined ? '' : String(a)).join('');
    case 'CONCAT_WS': {
      const sep = args[0] == null ? ',' : String(args[0]);
      return args.slice(1).filter(a => a !== null && a !== undefined).map(a => String(a)).join(sep);
    }
    case 'UPPER': case 'UCASE': return args[0] == null ? null : String(args[0]).toUpperCase();
    case 'LOWER': case 'LCASE': return args[0] == null ? null : String(args[0]).toLowerCase();
    case 'LENGTH': case 'CHAR_LENGTH': case 'CHARACTER_LENGTH': return args[0] == null ? null : String(args[0]).length;
    // TRIM(s) / TRIM([LEADING|TRAILING|BOTH] chars FROM s) / TRIM(s, chars)
    case 'TRIM': {
      if (args[0] == null) return null;
      const s = String(args[0]);
      if (args.length === 1) return s.trim();
      const chars = args[1] == null ? '' : String(args[1]);
      if (!chars) return s.trim();
      const spec = args[2] ? String(args[2]).toUpperCase() : 'BOTH';
      const esc = chars.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const head = new RegExp('^[' + esc + ']+');
      const tail = new RegExp('[' + esc + ']+$');
      if (spec === 'LEADING') return s.replace(head, '');
      if (spec === 'TRAILING') return s.replace(tail, '');
      return s.replace(head, '').replace(tail, '');
    }
    // EXTRACT(YEAR FROM d) —— 解析层会把 unit 作为第一个参数传入
    case 'EXTRACT': {
      const unit = String(args[0] == null ? '' : args[0]).toUpperCase();
      const d = parseSqlDate(args[1]);
      if (!d) return null;
      switch (unit) {
        case 'YEAR': return d.getFullYear();
        case 'MONTH': return d.getMonth() + 1;
        case 'DAY': return d.getDate();
        case 'HOUR': return d.getHours();
        case 'MINUTE': return d.getMinutes();
        case 'SECOND': return d.getSeconds();
        case 'DOW': return d.getDay();              // 0 = 周日
        case 'DAYOFWEEK': return d.getDay() + 1;    // 1 = 周日（MySQL 语义）
        case 'WEEK': {
          const start = new Date(d.getFullYear(), 0, 1);
          return Math.floor((d - start) / 604800000) + 1;
        }
        default: return null;
      }
    }
    case 'DATE_ADD': case 'ADDDATE':
    case 'DATE_SUB': case 'SUBDATE': {
      const sign = (name === 'DATE_SUB' || name === 'SUBDATE') ? -1 : 1;
      const base = parseSqlDate(args[0]);
      if (!base) return null;
      const iv = args[1];
      if (!iv || !iv.__interval) return fmtSqlDate(String(args[0]).length <= 10, base);
      const isDateOnly = String(args[0]).trim().length <= 10;
      const d = new Date(base.getTime());
      const n = sign * Number(iv.value || 0);
      switch (String(iv.unit || '').toUpperCase()) {
        case 'DAY': case 'DAYS': d.setDate(d.getDate() + n); break;
        case 'WEEK': case 'WEEKS': d.setDate(d.getDate() + n * 7); break;
        case 'MONTH': case 'MONTHS': addMonthsClamped(d, n); break;
        case 'QUARTER': addMonthsClamped(d, n * 3); break;
        case 'YEAR': case 'YEARS': addMonthsClamped(d, n * 12); break;
        case 'HOUR': case 'HOURS': d.setHours(d.getHours() + n); break;
        case 'MINUTE': case 'MINUTES': d.setMinutes(d.getMinutes() + n); break;
        case 'SECOND': case 'SECONDS': d.setSeconds(d.getSeconds() + n); break;
        default: return null;
      }
      return fmtSqlDate(isDateOnly, d);
    }
    // ===== 日期/时间（补齐 README 契约：此前这些全部缺失，静默返回 null）=====
    case 'YEAR': {
      const d = parseSqlDate(args[0]);
      return d ? d.getFullYear() : null;
    }
    case 'MONTH': {
      const d = parseSqlDate(args[0]);
      return d ? d.getMonth() + 1 : null;
    }
    case 'DAY': case 'DAYOFMONTH': {
      const d = parseSqlDate(args[0]);
      return d ? d.getDate() : null;
    }
    case 'HOUR': {
      const d = parseSqlDate(args[0]);
      return d ? d.getHours() : null;
    }
    case 'MINUTE': {
      const d = parseSqlDate(args[0]);
      return d ? d.getMinutes() : null;
    }
    case 'SECOND': {
      const d = parseSqlDate(args[0]);
      return d ? d.getSeconds() : null;
    }
    case 'QUARTER': {
      const d = parseSqlDate(args[0]);
      return d ? Math.floor(d.getMonth() / 3) + 1 : null;
    }
    case 'WEEK': {
      const d = parseSqlDate(args[0]);
      if (!d) return null;
      const mode = args[1] != null ? Number(args[1]) : 0;
      // mode 1/3（周一为一周之始且首周需 ≥4 天）走 ISO 周序；其余按 MySQL 默认 mode 0
      if (mode === 1 || mode === 3) return pgDatePart('week', d);
      // mode 0：周日为一周之始，第 1 周是本年第一个含周日的周（之前为第 0 周）
      const jan1Dow = new Date(d.getFullYear(), 0, 1).getDay();   // 0=周日
      const firstSunday = jan1Dow === 0 ? 1 : 8 - jan1Dow;
      const doy = Math.round((d - new Date(d.getFullYear(), 0, 0)) / 86400000);
      if (doy < firstSunday) return 0;
      return Math.floor((doy - firstSunday) / 7) + 1;
    }
    case 'DAYOFWEEK': {   // MySQL：1=周日 … 7=周六
      const d = parseSqlDate(args[0]);
      return d ? d.getDay() + 1 : null;
    }
    case 'DATE': {
      const d = parseSqlDate(args[0]);
      return d ? fmtSqlDate(true, d) : null;
    }
    case 'TIME': {
      const d = parseSqlDate(args[0]);
      return d ? pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds()) : null;
    }
    case 'DATEDIFF': {
      const a = parseSqlDate(args[0]);
      const b = parseSqlDate(args[1]);
      if (!a || !b) return null;
      // MySQL 语义：按日期相减（忽略时间部分）
      const ua = Date.UTC(a.getFullYear(), a.getMonth(), a.getDate());
      const ub = Date.UTC(b.getFullYear(), b.getMonth(), b.getDate());
      return Math.round((ua - ub) / 86400000);
    }
    case 'TIMESTAMPDIFF': {
      // unit 允许写成裸关键字（TIMESTAMPDIFF(MONTH, a, b)），此时会被解析成列名而取不到值，
      // 回退用列名文本；不影响真正名为 month/year 的列。
      const raw0 = rawArgs[0];
      const unit = String(args[0] != null ? args[0]
        : (raw0 && raw0.type === 'column' ? raw0.name : '') || '').toUpperCase();
      // MySQL 语义：TIMESTAMPDIFF(unit, start, end) = end - start
      const a = parseSqlDate(args[2]);
      const b = parseSqlDate(args[1]);
      if (!a || !b) return null;
      const ms = a.getTime() - b.getTime();
      // MySQL 的整月差：先算日历月数差，再按「结束日的日 < 起始日的日」退一档。
      // 只算日历月差会高估：
      //   TIMESTAMPDIFF(MONTH,'2026-01-15','2026-03-14') = 1（差 1 个月零 29 天，不足 2 个月）
      //   TIMESTAMPDIFF(MONTH,'2026-01-31','2026-03-01') = 1（1/31+1月=2/28，2/28+1月=3/28，够不到 3/1）
      let months = (a.getFullYear() - b.getFullYear()) * 12 + (a.getMonth() - b.getMonth());
      if (a.getDate() < b.getDate()) months--;
      switch (unit) {
        case 'MICROSECOND': return Math.floor(ms * 1000);
        case 'SECOND': return Math.floor(ms / 1000);
        case 'MINUTE': return Math.floor(ms / 60000);
        case 'HOUR': return Math.floor(ms / 3600000);
        case 'DAY': return Math.floor(ms / 86400000);
        case 'WEEK': return Math.floor(ms / (86400000 * 7));
        case 'MONTH': return months;
        case 'QUARTER': return Math.floor(months / 3);
        case 'YEAR': return Math.floor(months / 12);
        default: return null;
      }
    }
    case 'DATE_FORMAT': {
      const d = parseSqlDate(args[0]);
      return d ? strftime(d, String(args[1] || '%Y-%m-%d')) : null;
    }
    case 'STR_TO_DATE': {
      const d = strToDate(String(args[0] == null ? '' : args[0]), String(args[1] || ''));
      return d ? fmtSqlDate(!/%[HhIiklsS]/.test(String(args[1] || '')), d) : null;
    }
    case 'TO_CHAR': {   // PG：TO_CHAR(d, fmt) —— 格式串用 PG 风格（YYYY-MM-DD）
      const d = parseSqlDate(args[0]);
      return d ? strftime(d, pgFmtToMysql(args[1] || '%Y-%m-%d')) : null;
    }
    case 'TO_DATE': {   // PG：TO_DATE(s, fmt)
      const d = strToDate(String(args[0] == null ? '' : args[0]), pgFmtToMysql(String(args[1] || '')));
      return d ? fmtSqlDate(true, d) : null;
    }
    case 'DATE_PART': { // PG：DATE_PART('year', d)
      const d = parseSqlDate(args[1]);
      return d ? pgDatePart(args[0], d) : null;
    }
    case 'AGE': {       // PG：AGE(a, b) —— a 相对 b 的间隔
      const a = parseSqlDate(args[0]);
      const b = args[1] !== undefined && args[1] !== null ? parseSqlDate(args[1]) : new Date();
      return (a && b) ? pgAge(b, a) : null;
    }
    case 'FROM_UNIXTIME': {
      const ts = Number(args[0]);
      if (!Number.isFinite(ts)) return null;
      const d = new Date(ts * 1000);
      return args[1] !== undefined && args[1] !== null ? strftime(d, String(args[1])) : fmtSqlDate(false, d);
    }
    case 'LAST_DAY': {
      const d = parseSqlDate(args[0]);
      return d ? fmtSqlDate(true, new Date(d.getFullYear(), d.getMonth() + 1, 0)) : null;
    }
    case 'WEEKDAY': {   // MySQL：0=周一 … 6=周日
      const d = parseSqlDate(args[0]);
      return d ? (d.getDay() + 6) % 7 : null;
    }
    case 'DAYOFYEAR': {
      const d = parseSqlDate(args[0]);
      return d ? Math.round((d - new Date(d.getFullYear(), 0, 0)) / 86400000) : null;
    }
    case 'DAYNAME': {
      const d = parseSqlDate(args[0]);
      return d ? DAY_NAMES[d.getDay()] : null;
    }
    case 'MONTHNAME': {
      const d = parseSqlDate(args[0]);
      return d ? MONTH_NAMES[d.getMonth()] : null;
    }
    case 'MAKEDATE': {
      const y = Number(args[0]);
      const doy = Number(args[1]);
      if (!Number.isFinite(y) || !Number.isFinite(doy)) return null;
      const d = new Date(y, 0, 1);
      d.setDate(doy);
      return fmtSqlDate(true, d);
    }
    case 'PERIOD_DIFF': {
      const p1 = String(args[0] == null ? '' : args[0]);
      const p2 = String(args[1] == null ? '' : args[1]);
      if (!/^\d{6}$/.test(p1) || !/^\d{6}$/.test(p2)) return null;
      return (Number(p1.slice(0, 4)) * 12 + Number(p1.slice(4))) -
             (Number(p2.slice(0, 4)) * 12 + Number(p2.slice(4)));
    }
    case 'DATE_TRUNC': { // PG：DATE_TRUNC('month', d)
      const part = String(args[0] || '').toLowerCase();
      const d = parseSqlDate(args[1]);
      if (!d) return null;
      let nd;
      switch (part) {
        case 'year': nd = new Date(d.getFullYear(), 0, 1); break;
        case 'quarter': nd = new Date(d.getFullYear(), Math.floor(d.getMonth() / 3) * 3, 1); break;
        case 'month': nd = new Date(d.getFullYear(), d.getMonth(), 1); break;
        case 'week': { const wd = (d.getDay() + 6) % 7; nd = new Date(d.getFullYear(), d.getMonth(), d.getDate() - wd); break; }
        case 'day': nd = new Date(d.getFullYear(), d.getMonth(), d.getDate()); break;
        case 'hour': nd = new Date(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours()); break;
        case 'minute': nd = new Date(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes()); break;
        case 'second': nd = new Date(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds()); break;
        default: return null;
      }
      return fmtSqlDate(false, nd);
    }
    case 'LTRIM': return args[0] == null ? null : String(args[0]).replace(/^\s+/, '');
    case 'RTRIM': return args[0] == null ? null : String(args[0]).replace(/\s+$/, '');
    case 'ABS': return args[0] == null ? null : Math.abs(args[0]);
    case 'SIGN': {   // MySQL：正数 1 / 0 → 0 / 负数 -1；NULL → NULL
      const v = numericIfNumeric(args[0]);
      if (v === null) return args[0] == null ? null : 0;
      return v > 0 ? 1 : (v < 0 ? -1 : 0);
    }
    case 'TRUNCATE': {   // MySQL：直接截断，不四舍五入；NULL → NULL
      const x = numericIfNumeric(args[0]);
      if (x === null) return args[0] == null ? null : null;
      const digits = args[1] === undefined || args[1] === null ? 0 : Math.trunc(Number(args[1])) || 0;
      const factor = Math.pow(10, digits);
      if (!Number.isFinite(factor)) return x;
      return Math.trunc(x * factor) / factor;
    }
    case 'SUBSTRING_INDEX': {   // MySQL：按分隔符切，返回左边 count 段（count<0 从右数）
      const s = args[0] == null ? null : String(args[0]);
      const d = args[1] == null ? null : String(args[1]);
      if (s === null || d === null || d === '') return null;
      const n = Math.trunc(Number(args[2]));
      if (!Number.isFinite(n)) return null;
      if (n === 0) return '';
      const parts = s.split(d);
      if (n > 0) return parts.slice(0, n).join(d);
      return parts.slice(n).join(d);   // n<0：取末尾 |n| 段
    }
    case 'ROUND': {
      // MySQL 语义：四舍五入「半远离零」（Math.round 是半向 +∞，对负数会错，如 -3.5→-3）
      // 位数 D 可为负（向小数点左侧舍入）；非数值/非法输入返回 null，绝不抛 TypeError/RangeError。
      if (args[0] == null) return null;
      const x = Number(args[0]);
      if (!Number.isFinite(x)) return null;
      const digits = args[1] === undefined ? 0 : (Math.trunc(Number(args[1])) || 0);
      const factor = Math.pow(10, digits);
      if (!Number.isFinite(factor)) return x;      // 位数过大：值不变
      if (factor === 0) return 0;                   // 位数过小：舍入到 0
      const sign = x < 0 ? -1 : 1;
      const scaled = Math.abs(x) * factor;
      const floor = Math.floor(scaled);
      const frac = scaled - floor;
      // 二进制浮点误差会把恰好落在中点的值存成略小（1.005*100 = 100.49999999999999），
      // 在中点附近按相对误差判定为「半」，以「半远离零」进位，避免静默少 1。
      const eps = Math.abs(scaled) * Number.EPSILON * 4 + Number.EPSILON;
      const rounded = Math.abs(frac - 0.5) < eps ? floor + 1 : Math.round(scaled);
      return sign * rounded / factor;
    }
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
    case 'REPEAT': {
      // 此前完全缺失，静默返回 null
      if (args[0] == null || args[1] == null) return null;
      const n = Math.trunc(Number(args[1]));
      if (!Number.isFinite(n) || n <= 0) return '';
      return String(args[0]).repeat(n);
    }
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
    case 'LOCATE': {
      if (args[0] == null || args[1] == null) return null;
      const idx = String(args[1]).indexOf(String(args[0]));
      return idx + 1;
    }
    case 'INSTR': {
      // INSTR(str, substr)：参数顺序与 LOCATE(substr, str) 相反。
      // 此前两者共用一段代码，导致 INSTR 静默返回 0。
      if (args[0] == null || args[1] == null) return null;
      const idx = String(args[0]).indexOf(String(args[1]));
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

// ci 默认 true：保持 LIKE 既有的大小写不敏感行为不变；ILIKE 同为不敏感。
// escape：可选转义符（ESCAPE 子句），默认反斜杠；转义符后跟 % _ 或转义符本身按字面量匹配。
function likeMatch(value, pattern, ci = true, escape = '\\') {
  if (typeof value !== 'string') return false;
  const p = String(pattern);
  const e = (escape === null || escape === undefined || escape === '') ? '\\' : String(escape);
  const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  let out = '';
  for (let i = 0; i < p.length; i++) {
    const ch = p[i];
    if (ch === e && i + 1 < p.length && (p[i + 1] === '%' || p[i + 1] === '_' || p[i + 1] === e)) {
      out += reEsc(p[i + 1]);
      i++;
      continue;
    }
    if (ch === '%') out += '.*';
    else if (ch === '_') out += '.';
    else out += reEsc(ch);
  }
  return new RegExp('^' + out + '$', ci ? 'i' : '').test(value);
}

/** 解析 PG 的路径字面量：'{a,b}' 或数组 → ['a','b'] */
function parsePgPath(key) {
  if (Array.isArray(key)) return key.map(String);
  if (typeof key === 'string') {
    const s = key.trim();
    if (s.startsWith('{') && s.endsWith('}')) {
      return s.slice(1, -1).split(',').map(x => x.trim().replace(/^"(.*)"$/, '$1')).filter(x => x !== '');
    }
    return [s];
  }
  return [String(key)];
}

/** 把可能是 JSON 字符串的值归一为 JS 值 */
function toJsonValue(v) {
  if (typeof v === 'string') { try { return JSON.parse(v); } catch (e) { return v; } }
  return v;
}

/** JSON 包含语义（PG 的 @> / <@）。swap=true 时判断 target 是否包含 container。 */
function jsonContains(a, b, swap) {
  const container = toJsonValue(swap ? b : a);
  const target = toJsonValue(swap ? a : b);
  return jsonContainsValue(container, target);
}

function jsonContainsValue(container, target) {
  if (target === null || target === undefined) return true;
  if (Array.isArray(target)) {
    if (!Array.isArray(container)) return false;
    return target.every(t => container.some(c => jsonContainsValue(c, t)));
  }
  if (typeof target === 'object') {
    if (container === null || typeof container !== 'object' || Array.isArray(container)) return false;
    return Object.keys(target).every(k => Object.prototype.hasOwnProperty.call(container, k) && jsonContainsValue(container[k], target[k]));
  }
  if (Array.isArray(container)) return container.some(c => c === target || String(c) === String(target));
  if (container !== null && typeof container === 'object') return false;
  return container === target || String(container) === String(target);
}

/** JSON 键存在（PG 的 ? / ?| / ?&）。keys 为单个键名或 '{a,b}' 形式的键列表。 */
function jsonKeyExists(base, keys, mode) {
  const v = toJsonValue(base);
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const has = (k) => Object.prototype.hasOwnProperty.call(v, k);
  if (mode === '?|') return parsePgPath(keys).some(has);
  if (mode === '?&') return parsePgPath(keys).every(has);
  return has(String(keys));
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

// 行去重（保持首次出现顺序），供 UNION / INTERSECT / EXCEPT 的 DISTINCT 语义使用
function dedupeRows(rows) {
  const seen = new Set();
  return rows.filter(r => {
    const k = JSON.stringify(r);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// 比较前把布尔归一化为 1/0，但只在“另一侧是数值/布尔”时做，
// 避免把 true 与字符串 'true' 的比较悄悄改成 1 与 'true' 的比较。
function normalizeCmpValue(a, other) {
  if (typeof a !== 'boolean') return a;
  const otherIsNumeric = typeof other === 'number' || typeof other === 'boolean';
  return otherIsNumeric ? (a ? 1 : 0) : a;
}

function evaluateExpr(expr, row, ctx) {
  if (expr === null || expr === undefined) return false;
  switch (expr.type) {
    case 'and': return evaluateExpr(expr.left, row, ctx) && evaluateExpr(expr.right, row, ctx);
    case 'or': return evaluateExpr(expr.left, row, ctx) || evaluateExpr(expr.right, row, ctx);
    case 'xor': return Boolean(evaluateExpr(expr.left, row, ctx)) !== Boolean(evaluateExpr(expr.right, row, ctx));
    case 'not': {
      // 三值逻辑：NOT UNKNOWN = UNKNOWN（返回 null，在 WHERE/ON/HAVING 中视为不选中）
      // 必须用 resolveOperand 取值：evaluateExpr 只认布尔类节点，
      // 对 value/column/arith 会落到 default 返回 false，导致 NOT 恒为真。
      const v = resolveOperand(expr.expr, row, ctx);
      return v === null || v === undefined ? null : !v;
    }
    case 'compare': {
      const l = resolveOperand(expr.left, row, ctx);
      const r = resolveOperand(expr.right, row, ctx);
      // MySQL NULL 安全相等：NULL <=> NULL 为真；NULL <=> 值 为假
      if (expr.op === '<=>') {
        const ln = l === null || l === undefined;
        const rn = r === null || r === undefined;
        if (ln || rn) return ln && rn;
        return l === r || String(l) === String(r);
      }
      // SQL 标准：与 NULL 的比较结果是 UNKNOWN，这里用 null 表示。
      // 不能返回 false —— 否则 NOT (a > 1) 会把 a 为 NULL 的行错误纳入结果。
      if (l === null || l === undefined || r === null || r === undefined) return null;
      // 布尔与数值互通（MySQL: 1 = TRUE、0 = FALSE）
      const nl = normalizeCmpValue(l, r);
      const nr = normalizeCmpValue(r, l);
      const isNum = (v) => typeof v === 'number';
      const isNumStr = (v) => typeof v === 'string' && String(v).trim() !== '' && Number.isFinite(Number(v));
      // 数值 vs 数值字符串（age < '10'、age = '09'）必须按数值比，
      // 否则退化成字典序：'9' < '10' 为 false、'9' = '09' 为 false
      const mixedNum = (isNum(nl) && isNumStr(nr)) || (isNumStr(nl) && isNum(nr));
      if (expr.op === '=') {
        if (mixedNum) return Number(nl) === Number(nr);
        return nl === nr || String(nl) === String(nr);
      }
      const fn = OPERATORS[expr.op];
      if (mixedNum) return fn(Number(nl), Number(nr));
      return typeof nl === 'number' && typeof nr === 'number' ? fn(nl, nr) : fn(String(nl), String(nr));
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
      const r = expr.list.some(x => x === v || String(x) === String(v));
      return expr.not ? !r : r;   // NOT IN：此前漏了取反，导致 NOT IN 与 IN 结果相同
    }
    case 'like': {
      const v = resolveOperand(expr.operand, row, ctx);
      // MySQL 的 LIKE 默认不区分大小写；只有显式 BINARY / ci=false 才敏感。
      // 此前写成 !!expr.ci，把 likeMatch 的 ci 默认值 true 覆盖成了 false。
      const r = likeMatch(v, expr.pattern, expr.ci !== false, expr.escape);
      return expr.not ? !r : r;
    }
    case 'quantified':
      return !!resolveOperand(expr, row, ctx);
    case 'jsonContains':
      return !!resolveOperand(expr, row, ctx);
    case 'regexp': {
      const v = resolveOperand(expr.operand, row, ctx);
      if (v === null || v === undefined) return false;
      // REGEXP / RLIKE 历史上就是大小写不敏感的；`~` 敏感、`~*` 不敏感
      const re = new RegExp(String(expr.pattern), expr.ci === false ? '' : 'i');
      const r = re.test(String(v));
      return expr.not ? !r : r;
    }
    case 'jsonKeyExists':
      return !!resolveOperand(expr, row, ctx);
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
      // 三值逻辑：任一操作数为 NULL 时结果是 UNKNOWN（用 null 表示），
      // 与普通比较运算符一致；不能返回 false，否则 NOT BETWEEN 会被误判为真。
      if (v === null || v === undefined || lo === null || lo === undefined || hi === null || hi === undefined) return null;
      const inRange = typeof v === 'number' && typeof lo === 'number' && typeof hi === 'number'
        ? v >= lo && v <= hi
        : String(v) >= String(lo) && String(v) <= String(hi);
      return expr.not ? !inRange : inRange;
    }
    case 'exists': {
      // 执行层会把子查询物化成 expr._rowCount，这里只做布尔判定
      const n = typeof expr._rowCount === 'number' ? expr._rowCount : (expr._rows ? expr._rows.length : 0);
      const has = n > 0;
      return expr.not ? !has : has;
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
  // 未起别名的窗口函数列给一个可读的名字（仅影响新增语法，不动既有命名规则）
  if ((c.over || (c.scalar && c.scalar.over)) && !c.alias) {
    const fn = String(c.aggregate || (c.scalar && c.scalar.name) || 'WINDOW').toUpperCase();
    return fn + '() OVER ()';
  }
  if (c.alias) return c.alias;
  if (c.scalar) return scalarName(c.scalar);
  if (c.aggregate) return c.alias || (c.aggregate === 'COUNT' ? 'COUNT(*)' : c.aggregate + '(' + c.column + ')');
  if (c.literal !== undefined) return String(c.literal);
  if (c.caseExpr) return 'CASE';
  if (c.expr === '*') return '*';
  const dot = (c.expr || '').indexOf('.');
  return dot !== -1 ? c.expr.slice(dot + 1) : c.expr;
}

// 窗口函数列：值由 _computeWindows 预先写回行对象，投影时直接取用
function windowColumnValue(c, r) {
  const key = c._windowKey || c.alias || scalarColumnName(c);
  const v = r ? r[key] : undefined;
  return v === undefined ? null : v;
}

// 表达式树里是否含 aggregate 节点（用于识别 ROUND(AVG(x),1) 这类嵌套聚合）
function containsAggregateNode(node) {
  if (!node || typeof node !== 'object') return false;
  if (Array.isArray(node)) return node.some(containsAggregateNode);
  if (node.type === 'aggregate') return true;
  for (const k of Object.keys(node)) {
    const v = node[k];
    if (v && typeof v === 'object' && containsAggregateNode(v)) return true;
  }
  return false;
}

// 结果集中的 SQL 布尔值按 MySQL 语义呈现为 1/0（如 SELECT 'a' LIKE 'b' → 0）
function projectScalar(v) {
  if (v === true) return 1;
  if (v === false) return 0;
  return v;
}

function scalarColumnValue(c, r, ctx) {
  if (c.over || (c.scalar && c.scalar.over)) return windowColumnValue(c, r);
  // 聚合列优先：GROUP_CONCAT / STDDEV 等同时带 scalar 与 aggregate
  if (c.aggregate) {
    return ctx._aggValue(ctx.group, c.aggregate || 'COUNT', c.column,
      c.distinct, c.separator !== undefined ? c.separator : (c.scalar && c.scalar.separator),
      c.orderBy || (c.scalar && c.scalar.orderBy));
  }
  if (c.scalar) {
    const s = c.scalar;
    if (s && s.type === 'func' && ctx && ctx.ctxAggregates && Object.prototype.hasOwnProperty.call(ctx.ctxAggregates, String(s.name).toUpperCase())) {
      const fn = String(s.name).toUpperCase();
      const col = s.args && s.args[0];
      return ctx._aggValue(ctx.group, fn, col, c.aggregate ? c.distinct : (c.scalar && c.scalar.distinct));
    }
    // 嵌套聚合：ROUND(AVG(x),1)、UPPER(MIN(s)) 等 —— 顶层不是聚合函数，
    // 但参数里可能夹着 aggregate 节点。resolveOperand 不认识这种节点会返回 null，
    // 所以先把整棵 scalar 树里的聚合按当前分组求值替换成字面值（每行都要替换，故用深拷贝）。
    if (ctx && ctx._aggValue && s && containsAggregateNode(s)) {
      const copy = JSON.parse(JSON.stringify(s));
      ctx._replaceAggregates(copy, ctx.group || [r]);
      return projectScalar(resolveOperand(copy, r, ctx));
    }
    return projectScalar(resolveOperand(c.scalar, r, ctx));
  }
  
  if (c.literal !== undefined) return c.literal;
  if (c.caseExpr) return projectScalar(evaluateCaseVal(c.caseExpr, r, ctx));
  if (c.expr === '*') return r[Object.keys(r).find(k => !k.startsWith('_'))];
  return projectScalar(resolveOperand({ type: 'column', name: c.expr }, r, ctx));
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
    if (def.default !== undefined) {
      // defaultExpr（CURRENT_TIMESTAMP 等）不加引号，普通字符串默认值才加
      seg.push('DEFAULT ' + (typeof def.default === 'string' && !def.defaultExpr ? "'" + def.default + "'" : def.default));
    }
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
        if (statement.ifNotExists && this.engine.hasTable && await this.engine.hasTable(statement.name)) {
          return { ok: true, type: 'createTable', table: statement.name, affectedRows: 0, skipped: true };
        }
        const r = await this.engine.createTable(statement.name, statement.schema);
        return { ok: true, type: 'createTable', table: statement.name, affectedRows: 0, result: r };
      }
      case 'dropTable': {
        if (statement.ifExists && !(await this.engine.hasTable(statement.table))) {
          return { ok: true, type: 'dropTable', table: statement.table, affectedRows: 0 };
        }
        await this.engine.dropTable(statement.table);
        return { ok: true, type: 'dropTable', table: statement.table, affectedRows: 0 };
      }
      case 'truncate': {
        if (await this.engine.hasTable(statement.name)) await this.engine.truncate(statement.name);
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
        // INSERT ... SELECT：先跑 SELECT，再把结果行映射成待插入行
        if (statement.select) {
          const res = await this.executeSelect(statement.select);
          const cols = statement.columns && statement.columns.length ? statement.columns : res.columns;
          dataRows = res.rows.map(arr => {
            const row = {};
            cols.forEach((c, i) => { row[c] = arr[i]; });
            return row;
          });
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
        const uniqueCols = schema ? Object.keys(schema).filter(k => schema[k].unique && !schema[k].primaryKey) : [];
        let toInsert = dataRows;
        let updated = 0;
        let skipped = 0;
        // 非主键 UNIQUE 约束：默认动作（无 ON CONFLICT / IGNORE / REPLACE）下违反即 ER_DUP_ENTRY。
        // 主键冲突由下面的冲突逻辑处理；这里补唯一列（含批内重复）。
        if (uniqueCols.length > 0 && this._conflictAction(statement) === 'throw') {
          const existing = (await this.engine.find(statement.name, {}, { limit: 1e9, offset: 0 }))
            .map(r => normalizeRow(r, schema));
          for (const col of uniqueCols) {
            const used = new Set();
            for (const r of existing) {
              const v = r[col];
              if (v !== undefined && v !== null) used.add(String(v));
            }
            for (const d of dataRows) {
              const v = d[col];
              if (v === undefined || v === null) continue;   // UNIQUE 允许多个 NULL
              const s = String(v);
              if (used.has(s)) throw new Error(`ER_DUP_ENTRY: Duplicate entry '${s}' for unique column '${col}'`);
              used.add(s);
            }
          }
        }
        if (pkCols.length > 0) {
          const keyOf = (row) => pkCols.map(c => (row[c] !== undefined && row[c] !== null ? String(row[c]) : '')).join('|');
          const hasExplicitPk = (row) => pkCols.some(c => row[c] !== undefined && row[c] !== null);
          // 冲突判定的额外列组：
          //   ON CONFLICT (col) DO UPDATE → 指定列（PG）
          //   ON DUPLICATE KEY UPDATE     → 各唯一列（MySQL：任一唯一键冲突都触发）
          // 此前只认主键，导致这两者在唯一列冲突时会插入重复行而不是更新。
          const ocTarget = (statement.onConflict && Array.isArray(statement.onConflict.target))
            ? statement.onConflict.target.map(c => (c && c.name !== undefined ? c.name : c)).filter(Boolean)
            : null;
          const extraIdx = [];
          if (ocTarget && ocTarget.length) extraIdx.push(ocTarget);
          // 唯一列始终参与冲突判定（PG 的 ON CONFLICT 与 MySQL 的 ON DUPLICATE 都包含唯一键）
          for (const c of uniqueCols) extraIdx.push([c]);
          const hasAllOf = (cols) => (row) => cols.every(c => row[c] !== undefined && row[c] !== null);

          const explicit = dataRows.filter((row) => hasExplicitPk(row) || extraIdx.some((cols) => hasAllOf(cols)(row)));
          if (explicit.length > 0) {
            const all = (await this.engine.find(statement.name, {}, { limit: 1e9, offset: 0 })).map(r => normalizeRow(r, schema));
            const pkMap = new Map();
            for (const row of all) {
              const keys = pkCols.map(c => row[c]).filter(v => v !== undefined && v !== null);
              if (keys.length === pkCols.length) pkMap.set(keyOf(row), keys);
            }
            const pkValsOf = (row) => pkCols.map(c => row[c]).filter(v => v !== undefined && v !== null);
            const extraMaps = extraIdx.map((cols) => {
              const m = new Map();
              const pick = hasAllOf(cols);
              const key = (row) => cols.map(c => String(row[c])).join('|');
              for (const row of all) {
                if (!pick(row)) continue;
                m.set(key(row), pkValsOf(row));
              }
              return { pick, key, m };
            });
            const conflicts = [];
            const fresh = [];
            for (const d of dataRows) {
              let existingId = null;
              if (hasExplicitPk(d) && pkMap.has(keyOf(d))) existingId = pkMap.get(keyOf(d));
              if (!existingId) {
                for (const { pick, key, m } of extraMaps) {
                  if (!pick(d)) continue;
                  const k = key(d);
                  if (m.has(k)) { existingId = m.get(k); break; }
                }
              }
              if (existingId) conflicts.push({ d, existingId });
              else fresh.push(d);
            }
            const conflictAction = this._conflictAction(statement);
            const conflictSets = this._conflictSets(statement);
            if (conflicts.length > 0 && conflictAction === 'throw') {
              throw new Error('ER_DUP_ENTRY: Duplicate entry for primary key');
            }
            if (conflicts.length > 0 && conflictAction === 'ignore') {
              // INSERT IGNORE / ON CONFLICT DO NOTHING：静默跳过冲突行
              skipped = conflicts.length;
            }
            if (conflicts.length > 0 && conflictAction === 'replace') {
              // REPLACE INTO：删除旧行后按新行插入
              const oldIds = [];
              for (const { existingId } of conflicts) {
                if (existingId.length === 1) oldIds.push(existingId[0]);
              }
              if (oldIds.length > 0) {
                if (this.engine.removeByIds) await this.engine.removeByIds(statement.name, oldIds);
                else for (const id of oldIds) await this.engine.removeById(statement.name, id);
              }
              toInsert = dataRows;
              await this.engine.flush();
            } else if (conflicts.length > 0 && conflictAction === 'update') {
              for (const { d, existingId } of conflicts) {
                const data = {};
                if (conflictSets) {
                  for (const [col, val] of conflictSets) {
                    // VALUES(col) 引用本次本应插入的值；EXCLUDED.col 为 PG 同义写法
                    if (val && typeof val === 'object' && val._valuesOf !== undefined) {
                      data[col] = d[val._valuesOf] !== undefined ? d[val._valuesOf] : null;
                    } else if (val && typeof val === 'object' && val._excludedOf !== undefined) {
                      data[col] = d[val._excludedOf] !== undefined ? d[val._excludedOf] : null;
                    } else {
                      data[col] = val;
                    }
                  }
                } else {
                  for (const k of Object.keys(d)) if (!pkCols.includes(k)) data[k] = d[k];
                }
                if (this.engine.updateById && existingId.length === 1) {
                  await this.engine.updateById(statement.name, existingId[0], data);
                } else if (this.engine.update) {
                  const filter = {};
                  pkCols.forEach((c, i) => { filter[c] = existingId[i]; });
                  await this.engine.update(statement.name, filter, data);
                }
                updated++;
              }
              await this.engine.flush();
              toInsert = fresh;
            } else if (conflictAction !== 'replace') {
              toInsert = fresh;
            }
          }
          const seen = new Map();
          let kept = [];
          for (const d of toInsert) {
            if (!hasExplicitPk(d)) { kept.push(d); continue; }
            const key = keyOf(d);
            if (seen.has(key)) {
              const act = this._conflictAction(statement);
              if (act === 'throw') {
                throw new Error('ER_DUP_ENTRY: Duplicate entry for primary key');
              }
              if (act === 'ignore') { skipped++; continue; }
              seen.get(key).row = d;   // update / replace：后出现的行覆盖先出现的行
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
        const out = {
          ok: true, type: 'insert', table: statement.name,
          affectedRows: toInsert.length + updated,
          insertId: Array.isArray(ids) && ids.length > 0 ? ids[0] : null,
          ids,
          duplicateUpdated: updated,
        };
        if (skipped > 0) out.duplicateSkipped = skipped;
        if (statement.returning) this._attachReturning(out, statement, toInsert, schema);
        return out;
      }
      case 'select': {
        return await this.executeSelect(statement);
      }
      case 'with': {
        // CTE：按声明顺序把已展开的 CTE 内联进引用它的 FROM（含嵌套 CTE 引用）
        const map = new Map();
        // 递归 CTE：自身引用不能内联成子查询（会无限展开 / 找不到列），
        // 改由 _execRecursiveCte 迭代求解，这里先把名字登记进 map 供其识别。
        const recursiveNames = new Set();
        for (const cte of statement.ctes) {
          const key = String(cte.name).toLowerCase();
          // 不要求显式写 RECURSIVE：只要 CTE 引用自身就按递归求解。
          // 否则 `WITH c(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM c ...)`
          // 这种省略 RECURSIVE 的写法会走普通内联路径 → 找不到表 c。
          // 必须有 UNION：自引用但无 UNION 的 CTE 无法终止，不是递归 CTE。
          const hasUnion = !!cte.select.union;
          if (hasUnion && this._cteIsRecursive(cte, key)) {
            recursiveNames.add(key);
            map.set(key, cte.select);   // 占位，实际不参与内联
            continue;
          }
          const sel = JSON.parse(JSON.stringify(cte.select));
          // CTE 显式列名清单 `name (a, b) AS (...)`：按顺序重命名输出列
          if (cte.columns && cte.columns.length) {
            sel.columns.forEach((c, i) => {
              if (cte.columns[i] && !c.alias) c.alias = cte.columns[i];
            });
          }
          this._inlineCteRefs(sel, map);
          map.set(key, sel);
        }
        if (recursiveNames.size) {
          return await this._execWithRecursiveCtes(statement, map, recursiveNames);
        }
        const stmt = JSON.parse(JSON.stringify(statement.statement));
        this._inlineCteRefs(stmt, map);
        return await this.execute(stmt);
      }
      case 'explain': {
        const lines = [];
        const describe = (s, indent) => {
          if (!s) return;
          const pad = indent || '';
          if (s.type === 'select') {
            lines.push([pad + 'SELECT', s.from ? '' : '(no FROM)']);
            if (s.from) {
              for (const t of (s.from.tables || [])) lines.push([pad + '  SCAN', t.table || '(subquery)']);
              for (const j of (s.from.joins || [])) lines.push([pad + '  ' + String(j.type).toUpperCase() + ' JOIN', (j.item && (j.item.table || '(subquery)')) || '']);
            }
            if (s.where) lines.push([pad + '  FILTER', 'WHERE']);
            if (s.groupBy) lines.push([pad + '  AGGREGATE', 'GROUP BY ' + s.groupBy.join(', ') + (s.rollup ? ' WITH ROLLUP' : '')]);
            if (s.having) lines.push([pad + '  FILTER', 'HAVING']);
            if (s.orderBy) lines.push([pad + '  SORT', 'ORDER BY ' + s.orderBy.map(o => (typeof o.column === 'string' ? o.column : 'expr') + ' ' + o.dir).join(', ')]);
            if (s.limit !== null && s.limit !== undefined) lines.push([pad + '  LIMIT', String(s.limit)]);
            if (s.union) describe(s.union.select, pad + '  ');
          } else if (s.type === 'with') {
            for (const c of s.ctes) { lines.push([pad + 'CTE ' + c.name, '']); describe(c.select, pad + '  '); }
            describe(s.statement, indent);
          } else {
            lines.push([String(s.type).toUpperCase(), s.table || s.name || '']);
          }
        };
        describe(statement.statement, '');
        return {
          ok: true, type: 'explain', columns: ['step', 'detail'], rows: lines,
          rowCount: lines.length, affectedRows: 0, message: `${lines.length} step(s) — 无代价模型，仅展示计划结构`,
          command: 'EXPLAIN', warnings: [],
        };
      }
      case 'createView': {
        if (!this.engine._views) this.engine._views = Object.create(null);
        const key = String(statement.name).toLowerCase();
        if (this.engine._views[key] && !statement.orReplace) {
          throw new Error(`View '${statement.name}' already exists (use CREATE OR REPLACE VIEW)`);
        }
        this.engine._views[key] = {
          name: statement.name,
          columns: statement.columns || null,
          select: statement.select,
        };
        return { ok: true, type: 'createView', message: `View '${statement.name}' created`, affectedRows: 0, warnings: [] };
      }
      case 'dropView': {
        if (!this.engine._views) this.engine._views = Object.create(null);
        const key = String(statement.name).toLowerCase();
        if (!this.engine._views[key]) {
          if (statement.ifExists) return { ok: true, type: 'dropView', message: `View '${statement.name}' did not exist`, affectedRows: 0, skipped: true, warnings: [] };
          throw new Error(`View '${statement.name}' does not exist`);
        }
        delete this.engine._views[key];
        return { ok: true, type: 'dropView', message: `View '${statement.name}' dropped`, affectedRows: 0, warnings: [] };
      }
      case 'createIndex': {
        const tName = statement.table;
        if (typeof this.engine.hasTable === 'function' && !(await this.engine.hasTable(tName))) {
          throw new Error(`Table '${tName}' does not exist`);
        }
        let handled = false;
        if (typeof this.engine.createIndex === 'function') {
          await this.engine.createIndex(tName, statement.columns, { unique: statement.unique, name: statement.name });
          handled = true;
        } else if (typeof this.engine._ensureTable === 'function') {
          const tbl = this.engine._ensureTable(tName) || (this.engine._tables && this.engine._tables[tName]);
          if (tbl && typeof tbl.createIndex === 'function') {
            // Table.createIndex 目前是单字段接口，复合索引按逐列建
            for (const col of statement.columns) tbl.createIndex(col);
            handled = true;
          }
        }
        if (!handled) {
          throw new Error(
            `CREATE INDEX is not supported by this engine (no createIndex/_ensureTable on the engine object)`
          );
        }
        // 登记 索引名 → 表 + 列，供 DROP INDEX 按索引名反查
        // （标准 SQL 的 DROP INDEX 不带表名，而存储层 dropIndex 收的是列名）
        if (this.engine) {
          if (!this.engine._indexRegistry) this.engine._indexRegistry = new Map();
          this.engine._indexRegistry.set(String(statement.name).toLowerCase(), {
            table: tName, columns: statement.columns.slice(),
          });
        }
        return {
          ok: true, type: 'createIndex', table: tName, name: statement.name,
          affectedRows: 0, warnings: [],
          message: `Index '${statement.name}' created on ${tName}(${statement.columns.join(', ')})`,
        };
      }
      case 'dropIndex': {
        // DROP INDEX 只给索引名（标准 SQL 不要求写表名），而存储层的
        // Table.dropIndex(field) 收的是**列名**。此前这里直接把索引名当列名传，
        // 又因 table=null 拿不到表对象 → 一律报「not supported」。
        // 现在：CREATE INDEX 时登记 索引名 → 表 + 列，删除时据此反查。
        let tName2 = statement.table;
        const rawName = String(statement.name || '');
        // 支持 `DROP INDEX t.idx_a` 形式
        if (!tName2 && rawName.includes('.')) {
          const parts = rawName.split('.');
          tName2 = parts[0];
          statement.name = parts[parts.length - 1];
        }
        if (!tName2 && this.engine && this.engine._indexRegistry) {
          const hit = this.engine._indexRegistry.get(String(statement.name || '').toLowerCase());
          if (hit) tName2 = hit.table;
        }
        let handled = false;
        let droppedField = null;
        const findTable = () => (typeof this.engine._ensureTable === 'function')
          ? (this.engine._ensureTable(tName2) || (this.engine._tables && this.engine._tables[tName2]))
          : null;
        if (typeof this.engine.dropIndex === 'function') {
          await this.engine.dropIndex(tName2, statement.name);
          handled = true;
        } else {
          const tbl = tName2 ? findTable() : null;
          if (tbl && typeof tbl.dropIndex === 'function') {
            // 索引名 → 列名：优先用登记信息，否则当列名直接删（兼容单列同名的老用法）
            const reg = this.engine._indexRegistry && this.engine._indexRegistry.get(String(statement.name || '').toLowerCase());
            // 复合索引是逐列建的（a,b 各建一个），删除时必须全部清掉，
            // 否则只删首列会留下残余索引，白占内存还让查询走错路径。
            const fields = (reg && reg.columns && reg.columns.length) ? reg.columns.slice() : [statement.name];
            const present = fields.filter(f => tbl._indexes[f] || tbl._btrees[f]);
            if (present.length === 0) {
              if (statement.ifExists) {
                return { ok: true, type: 'dropIndex', affectedRows: 0, skipped: true, warnings: [], message: `Index '${statement.name}' did not exist` };
              }
              throw new Error(`Index '${statement.name}' does not exist`);
            }
            for (const f of present) tbl.dropIndex(f);
            droppedField = present.length === 1 ? present[0] : present.join(',');
            handled = true;
          }
        }
        if (!handled) {
          if (statement.ifExists) {
            return { ok: true, type: 'dropIndex', affectedRows: 0, skipped: true, warnings: [], message: `Index '${statement.name}' did not exist` };
          }
          throw new Error(`DROP INDEX is not supported by this engine (no dropIndex on the engine/table object)`);
        }
        if (this.engine && this.engine._indexRegistry) this.engine._indexRegistry.delete(String(statement.name || '').toLowerCase());
        return {
          ok: true, type: 'dropIndex', table: tName2, name: statement.name,
          affectedRows: 0, warnings: [],
          message: `Index '${statement.name}' dropped` + (droppedField ? ` (column '${droppedField}')` : ''),
        };
      }
      case 'savepoint': {
        // 引擎侧没有保存点/快照能力。这里只登记名字，绝不假装能回滚。
        if (!this.engine._savepoints) this.engine._savepoints = new Set();
        this.engine._savepoints.add(String(statement.name).toLowerCase());
        return { ok: true, type: 'savepoint', message: `Savepoint '${statement.name}' noted`, affectedRows: 0, warnings: [] };
      }
      case 'releaseSavepoint': {
        if (this.engine._savepoints) this.engine._savepoints.delete(String(statement.name).toLowerCase());
        return { ok: true, type: 'releaseSavepoint', message: `Savepoint '${statement.name}' released`, affectedRows: 0, warnings: [] };
      }
      case 'rollbackTo': {
        // 明确报错而不是静默无效：静默的"回滚成功"会让调用方以为数据已还原。
        throw new Error(
          `ROLLBACK TO SAVEPOINT '${statement.name}' is not supported: the engine has no savepoint/snapshot support. ` +
          `Use ROLLBACK to abort the whole transaction.`
        );
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
              // 必须 await：wasm / native client 的 updateById 是异步的，
              // 不等就会把「主键/唯一约束冲突」的异常变成未处理的 Promise 拒绝 ——
              // 表现为 UPDATE 静默成功、产生两行同主键，而调用方拿不到任何错误。
              // lib/database.js 的实现是同步的，await 同步值同样安全。
              await this.engine.updateById(statement.table, id, data);
              count++;
            }
          }
        }
        await this.engine.flush();
        const updOut = { ok: true, type: 'update', table: statement.table, affectedRows: count };
        if (statement.returning) {
          const after = (await this.engine.find(statement.table, {}, { limit: 1e9, offset: 0 })).map(r => normalizeRow(r, schema));
          const changed = [];
          for (const row of after) {
            if (!statement.where || evaluateExpr(statement.where, row, this.ctx)) changed.push(row);
          }
          this._attachReturning(updOut, statement, changed, schema);
        }
        return updOut;
      }
      case 'delete': {
        const schema = this.engine.getTableSchema
          ? await this.engine.getTableSchema(statement.table)
          : (this.engine._schemas ? this.engine._schemas[statement.table] : null);
        const pkCols = schema ? Object.keys(schema).filter(k => schema[k].primaryKey) : [];
        const all = (await this.engine.find(statement.table, {}, { limit: 1e9, offset: 0 })).map(r => normalizeRow(r, schema));
        const ids = [];
        const removedRows = [];
        let candidates = all.filter(row => !statement.where || evaluateExpr(statement.where, row, this.ctx));
        // DELETE ... ORDER BY ... LIMIT n
        if (statement.orderBy) {
          const cmp = (a, b) => {
            for (const o of statement.orderBy) {
              const av = resolveOperand({ type: 'column', name: o.column }, a, this.ctx);
              const bv = resolveOperand({ type: 'column', name: o.column }, b, this.ctx);
              if (av === bv) continue;
              if (av === undefined || av === null) return o.dir === 'asc' ? -1 : 1;
              if (bv === undefined || bv === null) return o.dir === 'asc' ? 1 : -1;
              const d = typeof av === 'number' && typeof bv === 'number' ? av - bv : String(av).localeCompare(String(bv));
              if (d !== 0) return o.dir === 'asc' ? d : -d;
            }
            return 0;
          };
          candidates = candidates.slice().sort(cmp);
        }
        if (typeof statement.limit === 'number') candidates = candidates.slice(0, statement.limit);
        for (const row of candidates) {
          // 无主键表没有稳定行标识：_rowPkId 会回退到 row.id（业务列名），
          // 而存储层的 _resolveId 把 id 当 1-based 行号 —— 两者语义不一致，
          // DELETE ... WHERE id IN (3,5) 会删错行。此时直接传行对象，存储层按引用删。
          const id = pkCols.length > 0 ? this._rowPkId(row, pkCols) : row;
          if (id !== undefined) { ids.push(id); removedRows.push(row); }
        }
        if (ids.length > 0) {
          if (this.engine.removeByIds) await this.engine.removeByIds(statement.table, ids);
          else for (const id of ids) await this.engine.removeById(statement.table, id);
        }
        await this.engine.flush();
        const delOut = { ok: true, type: 'delete', table: statement.table, affectedRows: ids.length };
        // DELETE ... RETURNING 返回被删除的行
        if (statement.returning) this._attachReturning(delOut, statement, removedRows, schema);
        return delOut;
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
    if (this.engine.hasTable && !(await this.engine.hasTable(name))) {
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

  /**
   * 从 WHERE 表达式里提取「可直接下推给存储层」的等值条件。
   *
   * 此前 _readTable 一律 `find(table, {}, ...)` 拉全表回内存再逐行 evaluateExpr，
   * WHERE 完全没有下推 —— 2 万行表上 `WHERE id = ?` 也要扫 2 万行（约 88ms/次），
   * 而主键索引本可以做到微秒级。
   *
   * 只认最安全的一类：column = <字面量>（含 AND 连接）。
   * 其它条件（范围、OR、函数、IN、子查询）一律不下推，交回内存过滤，
   * 避免为了快而改错结果。
   */
  _pushdownEqualities(statement) {
    const out = {};
    if (!statement || !statement.where || typeof statement.where !== 'object') return out;
    const visit = (node) => {
      if (!node || typeof node !== 'object') return;
      if (node.type === 'and') { visit(node.left); visit(node.right); return; }
      if (node.type !== 'compare' || node.op !== '=') return;
      const isCol = n => n && n.type === 'column' && typeof n.name === 'string';
      const isVal = n => n && n.type === 'value' && n.value !== null && n.value !== undefined;
      let col = null, val = null;
      if (isCol(node.left) && isVal(node.right)) { col = node.left.name; val = node.right.value; }
      else if (isCol(node.right) && isVal(node.left)) { col = node.right.name; val = node.left.value; }
      if (col === null) return;
      const key = col.includes('.') ? col.slice(col.lastIndexOf('.') + 1) : col;
      // 同一列出现多个等值条件（如 id=1 AND id=2）时不推，交给内存求值
      if (Object.prototype.hasOwnProperty.call(out, key)) delete out[key];
      else out[key] = val;
    };
    visit(statement.where);
    return out;
  }

  async _readTable(table, statement) {
    const schema = await this._getSchema(table);
    // 有可下推的等值条件时交给存储层走索引；没有则维持原来的全表读取
    const filter = statement ? this._pushdownEqualities(statement) : {};
    const useIndex = Object.keys(filter).length > 0 &&
      (typeof this.engine.exists === 'function' || typeof this.engine.find === 'function');
    const rows = useIndex
      ? (await this.engine.find(table, filter, { limit: 1e9, offset: 0 })).map(r => normalizeRow(r, schema))
      : (await this.engine.find(table, {}, { limit: 1e9, offset: 0 })).map(r => normalizeRow(r, schema));
    return { schema, rows };
  }

  async _execFromItem(item) {
    if (item.subquery) {
      // 递归 CTE 物化出来的派生表：直接携带行数据
      if (item.subquery._virtualSource) {
        return { schema: null, rows: item.subquery._virtualSource.map(r => Object.assign({}, r)) };
      }
      const res = await this.executeSelect(item.subquery);
      return { schema: null, rows: res.rows.map(r => Object.assign({}, r)) };
    }
    // 递归 CTE 迭代用：把已累积的行当作一张临时表
    // （否则 FROM 会去找真实表，报 no such table / no such column）
    if (item._virtualRows) {
      return { schema: null, rows: item._virtualRows.map(r => Object.assign({}, r)) };
    }
    return this._readTable(item.table, item._stmt);
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
      // 不 delete expr.subquery：相关子查询需要在逐行求值时重跑
      return;
    }
    if (expr.type === 'subquery') {
      const res = await this.executeSelect(expr.select);
      expr._value = res.rows.length > 0 ? res.rows[0][0] : null;
      // 不改写类型、不 delete select：保留节点以便相关场景逐行重算
      return;
    }
    if (expr.type === 'exists' && expr.select) {
      // 非相关场景（HAVING / JOIN ON）只求值一次；保留 select 以便 WHERE 里逐行关联求值
      await this._evalCorrelated(expr, null);
      return;
    }
    if (expr.type === 'quantified' && expr.select) {
      const res = await this.executeSelect(expr.select);
      expr._list = res.rows.map(r => (Array.isArray(r) ? r[0] : r));
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

  /**
   * 构造 WITH ROLLUP 的汇总行：把各组的原始行合并成一个"超级组"，
   * 分组列不设值（投影时会取 null），聚合列则覆盖全部行。
   */
  _rollupRow(groupReps) {
    const all = [];
    for (const rep of groupReps) {
      if (rep._group) all.push(...rep._group);
      else all.push(rep);
    }
    const out = {};
    if (all.length > 0) {
      // 分组列显式置为 null，避免取到某一组的代表值
      for (const k of Object.keys(all[0])) {
        if (k === '_group' || k === '_rid') continue;
        out[k] = null;
      }
    }
    out._group = all;
    out._rollup = true;
    return out;
  }

  _aggValue(rows, fn, column, distinct, separator, orderBy) {
    const op = typeof column === 'string' ? { type: 'column', name: column } : column;
    // COUNT(*) / COUNT()：参数为 star 或缺失，直接按行数算
    const noColumn = !op || op.type === 'star';
    let values = noColumn
      ? rows.map(r => 1)
      : op && op.type === 'tuple'
        // COUNT(DISTINCT a, b)：先把多列拼成元组再聚合
        ? rows.map(r => JSON.stringify(op.items.map(it => resolveOperand(it, r, this.ctx))))
          .filter(v => v !== null && v !== undefined)
        : rows.map(r => resolveOperand(op, r, this.ctx)).filter(v => v !== null && v !== undefined);
    // COUNT(DISTINCT x) / SUM(DISTINCT x)：先按值去重再聚合
    if (distinct) {
      const seen = new Set();
      values = values.filter(v => {
        const k = typeof v === 'object' ? JSON.stringify(v) : String(v);
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
    }
    if (fn === 'COUNT') return values.length;
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
    if (fn === 'SUM') {
      // MySQL 语义：空集（或无任何非 NULL 值）的 SUM 为 NULL，而非 0。
      // AVG/MIN/MAX 已按此处理，此前只有 SUM 漏了。
      if (!values.length) return null;
      return values.reduce((s, v) => s + (typeof v === 'number' ? v : Number(v) || 0), 0);
    }
    if (fn === 'AVG') return values.length ? values.reduce((s, v) => s + (typeof v === 'number' ? v : Number(v) || 0), 0) / values.length : null;
    if (fn === 'MIN' || fn === 'MAX') {
      const vs = values.filter(v => v !== null && v !== undefined);
      if (!vs.length) return null;
      // 数值按数值比；字符串/日期按字典序/时间序。
      // 此前一律 Number(v) —— 字符串列会得到 NaN，MIN(name) 直接变 null。
      const numeric = (v) => typeof v === 'number' ||
        (typeof v === 'string' && String(v).trim() !== '' && Number.isFinite(Number(v)));
      if (vs.every(numeric)) {
        const nums = vs.map(v => Number(v));
        return fn === 'MIN' ? Math.min(...nums) : Math.max(...nums);
      }
      let best = vs[0];
      for (const v of vs.slice(1)) {
        const a = String(v);
        const b = String(best);
        if (fn === 'MIN' ? a < b : a > b) best = v;
      }
      return best;
    }
    if (fn === 'FIRST') return values.length ? values[0] : null;
    if (fn === 'LAST') return values.length ? values[values.length - 1] : null;
    if (fn === 'GROUP_CONCAT') {
      let src = rows;
      // GROUP_CONCAT(expr ORDER BY col [DESC])：先按内部排序键排好行，再取值拼接
      if (orderBy && orderBy.length) {
        const cmp = (a, b) => {
          for (const o of orderBy) {
            const av = resolveOperand({ type: 'column', name: o.column }, a, this.ctx);
            const bv = resolveOperand({ type: 'column', name: o.column }, b, this.ctx);
            if (av === bv) continue;
            if (av === null || av === undefined) return o.dir === 'asc' ? 1 : -1;
            if (bv === null || bv === undefined) return o.dir === 'asc' ? -1 : 1;
            const d = (typeof av === 'number' && typeof bv === 'number')
              ? av - bv : String(av).localeCompare(String(bv));
            if (d !== 0) return o.dir === 'asc' ? d : -d;
          }
          return 0;
        };
        src = rows.slice().sort(cmp);
      }
      const parts = src.map(r => resolveOperand(op, r, this.ctx));
      let joined = parts.filter(v => v !== null && v !== undefined);
      if (distinct) {
        const seen = new Set();
        joined = joined.filter(v => {
          const k = typeof v === 'object' ? JSON.stringify(v) : String(v);
          if (seen.has(k)) return false;
          seen.add(k);
          return true;
        });
      }
      if (joined.length === 0) return null;
      const sep = (separator !== undefined && separator !== null) ? String(separator) : ',';
      return joined.map(v => (v === null || v === undefined ? '' : String(v))).join(sep);
    }
    // 标准差 / 方差族：_POP 为总体、_SAMP（及无后缀 VAR/STDDEV）为样本
    if (fn === 'STDDEV' || fn === 'STDDEV_POP' || fn === 'STDDEV_SAMP' ||
        fn === 'VARIANCE' || fn === 'VAR_POP' || fn === 'VAR_SAMP') {
      const nums = values.map(v => Number(v)).filter(v => Number.isFinite(v));
      if (nums.length === 0) return null;
      const pop = (fn === 'STDDEV_POP' || fn === 'VAR_POP');
      const mean = nums.reduce((s, v) => s + v, 0) / nums.length;
      const denom = pop ? nums.length : nums.length - 1;   // 样本方差用 n-1
      if (denom <= 0) return null;
      const variance = nums.reduce((s, v) => s + (v - mean) * (v - mean), 0) / denom;
      return fn.indexOf('STDDEV') === 0 ? Math.sqrt(variance) : variance;
    }
    return null;
  }

  _replaceAggregates(node, group) {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'aggregate') {
      node.type = 'value';
      node.value = this._aggValue(group, node.fn, node.column, node.distinct, node.separator, node.orderBy);
      delete node.fn;
      delete node.column;
      return;
    }
    // 投影分支构造的聚合节点形如 { type: 'SUM', column, distinct }（type 就是函数名），
    // 与 parseAggregateCall 产出的 { type:'aggregate', fn } 并存。
    // 两种都要替换，否则 SUM(v)/COUNT(*) 整式求值为 null。
    if (typeof node.type === 'string' && AGG_FUNCS.has(node.type) &&
        (node.column !== undefined || node.over === undefined)) {
      const fn = node.type;
      node.type = 'value';
      node.value = this._aggValue(group, fn, node.column, node.distinct, node.separator, node.orderBy);
      delete node.column;
      return;
    }
    for (const k of Object.keys(node)) {
      if (node[k] && typeof node[k] === 'object') this._replaceAggregates(node[k], group);
    }
  }

  /**
   * 收集表达式树里所有「带子查询」的节点：
   * exists(select) / subquery(select) / in(subquery)。
   * 这些节点都可能需要按外层行逐行重新求值（相关子查询）。
   */
  _collectSubqueries(node, out = []) {
    if (!node || typeof node !== 'object') return out;
    if (Array.isArray(node)) { for (const n of node) this._collectSubqueries(n, out); return out; }
    if ((node.select || node.subquery) &&
        (node.type === 'exists' || node.type === 'subquery' || node.type === 'in')) out.push(node);
    for (const k of Object.keys(node)) {
      const v = node[k];
      if (v && typeof v === 'object') this._collectSubqueries(v, out);
    }
    return out;
  }

  /**
   * 冲突处理策略 —— 把四种写法归一成一个动作：
   *   REPLACE INTO                                   → 'replace'
   *   INSERT IGNORE / ON CONFLICT DO NOTHING         → 'ignore'
   *   ON DUPLICATE KEY UPDATE / ON CONFLICT DO UPDATE→ 'update'
   *   默认                                            → 'throw'（ER_DUP_ENTRY）
   */
  _conflictAction(statement) {
    if (statement.replace) return 'replace';
    if (statement.ignore) return 'ignore';
    const oc = statement.onConflict;
    if (oc) return oc.action === 'nothing' ? 'ignore' : 'update';
    if (statement.onDuplicate) return 'update';
    return 'throw';
  }

  /** 冲突时要写入的列值（ON DUPLICATE KEY UPDATE / ON CONFLICT DO UPDATE SET） */
  _conflictSets(statement) {
    if (statement.onDuplicate) return statement.onDuplicate;
    if (statement.onConflict && statement.onConflict.action === 'update') return statement.onConflict.sets;
    return null;
  }

  /**
   * 把 RETURNING 结果挂到返回对象上。
   * RETURNING * → 返回完整行；RETURNING a, b → 只取指定列。
   */
  _attachReturning(out, statement, rows, schema) {
    const cols = Array.isArray(statement.returning) ? statement.returning : [];
    const isStar = cols.length === 1 && cols[0] === '*';
    const outCols = isStar
      ? (schema ? Object.keys(schema).filter(k => k !== '_softDelete') : Object.keys((rows && rows[0]) || {}))
      : cols;
    out.returning = {
      columns: outCols,
      rows: (rows || []).map(r => outCols.map(c => (r && r[c] !== undefined ? r[c] : null))),
    };
    out.columns = outCols;
    out.rows = out.returning.rows;
    return out;
  }

  /**
   * 校验语句里引用的列是否真实存在。
   * 之前 `SELECT nosuchcol FROM t` 会静默返回 null 而不是报错 —— 调用方拿到的
   * 是"一列 null"，往往被当成"数据为空"，比直接报 no such column 更难排查。
   *
   * 只在能确定列名集合时校验（取样本行的键），空表不敢断言，宁可不报。
   * 不深入子查询节点：它们有自己的 FROM，列属于另一个作用域。
   */
  _validateColumnRefs(statement, rows) {
    if (!statement || !Array.isArray(rows) || rows.length === 0) return;
    const sample = rows[0];
    if (!sample || typeof sample !== 'object') return;
    const known = new Set();
    for (const k of Object.keys(sample)) known.add(String(k).toLowerCase());
    // 相关子查询：外层行的列也算已知。
    // _evalCorrelated 会把外层行挂到 ctx.__outer，子查询（`WHERE EXISTS (SELECT ... WHERE b.av = a.v)`）
    // 里的 `a.v` 属于外层作用域，不在本层 rows 里，不纳入就会误报 no such column。
    const outer = this.ctx && this.ctx.__outer;
    if (outer && typeof outer === 'object') {
      for (const k of Object.keys(outer)) known.add(String(k).toLowerCase());
    }
    // 本层 FROM 的表名/别名，用于判断限定引用是否指向外层
    const localAliases = this._outerAliases(statement);
    // HAVING / ORDER BY 允许引用 SELECT 的输出别名（如 HAVING cnt >= 1），
    // 这些名字不在表里，必须一并视为已知，否则会误报 no such column
    if (Array.isArray(statement.columns)) {
      for (const c of statement.columns) {
        if (c && typeof c.alias === 'string' && c.alias) known.add(c.alias.toLowerCase());
      }
    }

    const walk = (node) => {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) { for (const n of node) walk(n); return; }
      // 子查询/嵌套 SELECT 有自己的表，跳过
      if (node.type === 'select' || node.type === 'subquery') return;
      if (node.type === 'column' && typeof node.name === 'string') {
        const n = node.name.toLowerCase();
        const dot = n.indexOf('.');
        const base = dot >= 0 ? n.slice(dot + 1) : n;
        // 限定列引用了本层 FROM 之外的表/别名 → 属于外层作用域（相关子查询），放行。
        // 否则 `WHERE EXISTS (SELECT 1 FROM b WHERE b.av = a.v)` 里的 a.v 会被误杀。
        if (dot >= 0 && !localAliases.has(n.slice(0, dot))) return;
        if (!known.has(n) && !known.has(base)) {
          throw new Error(`no such column: ${node.name}`);
        }
      }
      for (const k of Object.keys(node)) {
        if (k === 'select' || k === 'subquery') continue;
        walk(node[k]);
      }
    };

    walk(statement.columns);
    walk(statement.where);
    walk(statement.having);
    walk(statement.orderBy);
    if (Array.isArray(statement.groupBy)) {
      // groupBy 是列名字符串数组
      for (const g of statement.groupBy) {
        if (typeof g !== 'string') continue;
        const n = g.toLowerCase();
        const base = n.indexOf('.') >= 0 ? n.slice(n.indexOf('.') + 1) : n;
        if (!known.has(n) && !known.has(base)) throw new Error(`no such column: ${g}`);
      }
    }
  }

  /** 收集子树里所有列名（含限定形式 alias.col） */
  _collectColumnNames(node, out = []) {
    if (!node || typeof node !== 'object') return out;
    if (Array.isArray(node)) { for (const n of node) this._collectColumnNames(n, out); return out; }
    if (node.type === 'column' && typeof node.name === 'string') out.push(node.name);
    for (const k of Object.keys(node)) {
      const v = node[k];
      if (v && typeof v === 'object') this._collectColumnNames(v, out);
    }
    return out;
  }

  /** 外层 FROM 的表名 / 别名集合 */
  _outerAliases(statement) {
    const set = new Set();
    if (!statement || !statement.from) return set;
    const add = (it) => { if (it && (it.alias || it.table)) set.add(String(it.alias || it.table).toLowerCase()); };
    for (const t of (statement.from.tables || [])) add(t);
    for (const j of (statement.from.joins || [])) add(j.item);
    return set;
  }

  /**
   * 子查询是否引用了外层别名（即相关子查询）。
   * 非相关子查询只求值一次，避免无谓的 O(n) 逐行重跑。
   */
  _isCorrelated(node, outerAliases) {
    if (!outerAliases || outerAliases.size === 0) return false;
    for (const n of this._collectColumnNames(node, [])) {
      const dot = n.indexOf('.');
      if (dot === -1) continue;
      if (outerAliases.has(n.slice(0, dot).toLowerCase())) return true;
    }
    return false;
  }

  /**
   * 投影行数组。若 SELECT 列表里有相关子查询（如
   * `(SELECT COUNT(*) FROM o WHERE o.uid = u.id)`），必须"求值一行、投影一行"交错进行，
   * 因为子查询节点是共享对象，先全算再投影只会留下最后一行的结果。
   */
  async _projectRows(statement, rows, projectRow) {
    const outerAliases = this._outerAliases(statement);
    const found = [];
    for (const c of statement.columns) {
      if (c.scalar) this._collectSubqueries(c.scalar, found);
      if (c.caseExpr) this._collectSubqueries(c.caseExpr, found);
    }
    const subs = found.filter(n => this._isCorrelated(n, outerAliases));
    if (subs.length === 0) return rows.map(projectRow);
    const out = [];
    for (const r of rows) {
      for (const n of subs) await this._evalCorrelated(n, r);
      out.push(projectRow(r));
    }
    return out;
  }

  /**
   * 按外层行求值一个子查询节点。
   * 临时把外层行挂到 ctx.__outer，让 `u.id` 这类外层引用能解析到。
   * 结果写回节点：exists→_rowCount，subquery→_value，in→list。
   */
  async _evalCorrelated(node, outerRow) {
    const prevCtx = this.ctx;
    this.ctx = outerRow ? Object.assign({}, prevCtx || {}, { __outer: outerRow }) : prevCtx;
    try {
      if (node.type === 'exists') {
        const res = await this.executeSelect(node.select);
        node._rowCount = res.rows.length;
      } else if (node.type === 'subquery') {
        const res = await this.executeSelect(node.select);
        node._value = res.rows.length > 0 ? res.rows[0][0] : null;
      } else if (node.type === 'in') {
        const res = await this.executeSelect(node.subquery);
        node.list = res.rows.map(r => (Array.isArray(r) ? r[0] : r));
      }
    } finally {
      this.ctx = prevCtx;
    }
  }

  /**
   * 把 AST 中引用 CTE 名称的 FROM 项替换成对应的子查询（就地改写）。
   * map: 小写 CTE 名 -> 已展开的 select AST
   */
  /**
   * 判断某个 CTE 是否引用自身（因而需要递归求解）。
   * 自引用必须出现在 UNION / UNION ALL 的**递归项**（右侧）里；
   * 左侧（锚点）出现自引用无法终止，按普通 CTE 处理即可。
   */
  _cteIsRecursive(cte, key) {
    // 既接受 {select: ...}（CTE 节点），也接受裸 select 节点（UNION 链上的分支）。
    // 分支自身没有 union（链上最内层），所以只看「本分支内有没有自引用」，
    // 不要求存在 union —— 否则链上最后一个分支永远判不出递归。
    const sel = cte && cte.type === 'select' ? cte : (cte && cte.select);
    if (!sel) return false;
    let found = false;
    const visit = (n) => {
      if (found || !n || typeof n !== 'object') return;
      if (Array.isArray(n)) { for (const x of n) visit(x); return; }
      if (n.from) {
        for (const t of (n.from.tables || [])) {
          if (t && t.table && String(t.table).toLowerCase() === key) { found = true; return; }
        }
        for (const j of (n.from.joins || [])) {
          if (j && j.item && j.item.table && String(j.item.table).toLowerCase() === key) { found = true; return; }
        }
      }
      for (const k of Object.keys(n)) { if (k !== 'from') visit(n[k]); }
    };
    visit(sel);
    return found;
  }

  /**
   * 求解带递归 CTE 的 WITH 语句。
   *
   * 标准语义：递归 CTE = 锚点（anchor）SELECT UNION [ALL] 递归项 SELECT。
   * 递归项里的自身引用指向「到目前为止累积的所有行」，反复迭代直到不再产生新行。
   * UNION ALL 允许重复行与无限递归风险，故设迭代上限兜底。
   */
  async _execWithRecursiveCtes(statement, map, recursiveNames) {
    // 先把递归 CTE 逐个求值，结果作为「派生表」供后续 CTE 与主查询引用
    const resolved = new Map();
    for (const cte of statement.ctes) {
      const key = String(cte.name).toLowerCase();
      if (!recursiveNames.has(key)) {
        resolved.set(key, map.get(key));
        continue;
      }
      const rows = await this._evalRecursiveCte(cte, key, resolved);
      // 递归结果物化成派生表，主查询与其它 CTE 都能引用。
      // 保留输出列名（CTE 声明的列名清单或首行列名），外层才能按 alias 引用。
      const outCols = (cte.columns && cte.columns.length)
        ? cte.columns.slice()
        : Object.keys(rows[0] || { c0: 1 });
      const sub = { type: 'select', columns: outCols.map(c => ({ expr: c, alias: c })), _virtualSource: rows };
      resolved.set(key, sub);
    }
    // 主查询：把递归名替换成携带行数据的子查询
    const stmt = JSON.parse(JSON.stringify(statement.statement));
    const inject = (node) => {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) { for (const x of node) inject(x); return; }
      if (node.type === 'select' && node.from) {
        const fix = (item) => {
          if (!item || !item.table) return;
          const k = String(item.table).toLowerCase();
          if (!resolved.has(k)) return;
          if (process.env.JSQL_DBG) console.error('[dbg] fix hit:', k, 'alias=', item.alias);
          const src = resolved.get(k);
          if (src && src._virtualSource) {
            // 保留别名并清掉 table 名，否则外层 `FROM c c1` 找不到物化结果
            item.subquery = JSON.parse(JSON.stringify(src));
            item.alias = item.alias || item.table;
            delete item.table;
          } else {
            item.subquery = JSON.parse(JSON.stringify(src));
            item.alias = item.alias || item.table;
            delete item.table;
          }
        };
        for (const t of (node.from.tables || [])) fix(t);
        for (const j of (node.from.joins || [])) fix(j.item);
      }
      for (const k of Object.keys(node)) { if (k !== 'from') inject(node[k]); }
    };
    inject(stmt);
    if (process.env.JSQL_DBG) console.error('[dbg] inject done, FROM=', JSON.stringify(stmt.from));
    return await this.execute(stmt);
  }

  /** 迭代求解单个递归 CTE，返回全部累积行 */
  async _evalRecursiveCte(cte, key, resolved) {
    const sel = cte.select;
    // 兜底：UNION ALL 允许重复行，条件写错（如 WHERE 子句恒真）会导致无限增长。
    // 单看迭代次数不够 —— 每轮累积行数可能翻倍，1000 轮就是 2^1000 行，
    // 内存会先于迭代上限被打爆（实测 OOM）。所以同时限制总行数。
    const MAX_ITER = 1000;
    const MAX_ROWS = 100000;
    let accumulated = [];
    let recSel = null;          // 声明在 if 块外：循环里要用

    if (sel.union) {
      // UNION 链里可能有多个分支（`SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT n+1 FROM c`）。
      // 语义：含自身引用的分支是**递归项**（只能有一个，取最后一个），
      // 前面所有分支都是**锚点**，结果并入起始集。
      // 此前只拆一层（左侧当锚点、右侧当递归项），
      // 多个锚点时中间分支被当成递归项喂回 → 行数暴涨。
      const branches = [];
      let cur = sel;
      while (cur && cur.union) { branches.push(cur); cur = cur.union.select; }
      if (cur) branches.push(cur);   // 最内层（无 union）

      const selfRef = (n) => this._cteIsRecursive({ select: n }, key);
      const isRec = (n) => selfRef(n);
      // 最后一个含自引用的分支 = 递归项；其后的分支（若有）也并入锚点
      let recIdx = -1;
      branches.forEach((b, i) => { if (isRec(b)) recIdx = i; });
      let anchorBranches;
      if (recIdx === -1) { anchorBranches = branches; recSel = null; }
      else {
        anchorBranches = branches.slice(0, recIdx);
        recSel = branches[recIdx];
        // 递归项之后还挂着的分支（非标准写法）也当锚点，避免丢结果
        for (let i = recIdx + 1; i < branches.length; i++) anchorBranches.push(branches[i]);
      }

      // 执行锚点：逐个分支求值后合并
      const want = (cte.columns && cte.columns.length) || (sel.columns || []).length;
      for (const b of anchorBranches) {
        // 关键：分支是 UNION 链上的一节，可能还挂着更深的 union.select。
        // 只清 union=null 不够 —— 残留的深层分支里若含 FROM c 就会去查真实表。
        // 这里只取该分支自身的 SELECT（含它自己的 from/where/columns），
        // 其 union 指向的分支已在 branches 里单独处理。
        const anchorStmt = {
          type: 'select',
          columns: b.columns,
          from: b.from,
          where: b.where,
          groupBy: b.groupBy,
          having: b.having,
          orderBy: null,
          limit: null,
          offset: 0,
          union: null, intersect: null, except: null, rollup: null,
          aggregate: b.aggregate, distinct: b.distinct,
        };
        if (want) {
          anchorStmt.columns = (anchorStmt.columns || []).slice(0, want)
            .map((c, i) => ({ ...c, alias: (cte.columns && cte.columns[i]) || c.alias || ('c' + i) }));
        }
        const anchorRes = await this.executeSelect(anchorStmt);
        accumulated = accumulated.concat(anchorRes.rows.map(r => Object.assign({}, r)));
      }
      if (!recSel) return accumulated;
    } else {
      return [];
    }

    // 显式列名清单：把输出列改名，便于递归项引用
    if (cte.columns && cte.columns.length) {
      accumulated = accumulated.map((r) => {
        const keys = Object.keys(r);
        const out = {};
        cte.columns.forEach((c, idx) => { out[c] = r[keys[idx]]; });
        return out;
      });
    }

    const isAll = !!sel.union.all;
    // semi-naive 求值：每轮只对本轮「新增」的行做一次递归。
    // 若把全部累积行都喂回递归项，每行都会再产出一行 → 行数按轮次递增，
    // 结果里出现大量重复（1..5 会得到 1,2,2,3,2,3,3,4,…）。
    let frontier = accumulated;
    for (let iter = 0; iter < MAX_ITER; iter++) {
      if (frontier.length === 0) break;
      // 把自身引用换成「本轮新增的行」。
      // 只取递归项分支自身的 SELECT：它可能挂着更深的 union.select，
      // 整段丢给 executeSelect 会再跑一轮 UNION，把自引用当普通表查。
      const recBranch = JSON.parse(JSON.stringify(recSel));
      const step = {
        type: 'select',
        columns: recBranch.columns,
        from: recBranch.from,
        where: recBranch.where,
        groupBy: recBranch.groupBy,
        having: recBranch.having,
        orderBy: null, limit: null, offset: 0,
        union: null, intersect: null, except: null, rollup: null,
        aggregate: recBranch.aggregate, distinct: recBranch.distinct,
      };
      const bind = (node) => {
        if (!node || typeof node !== 'object') return;
        if (Array.isArray(node)) { for (const x of node) bind(x); return; }
        if (node.type === 'select' && node.from) {
          const fix = (item) => {
            if (item && item.table && String(item.table).toLowerCase() === key) {
              item._virtualRows = frontier;
              item.alias = item.alias || item.table;
              delete item.table;
            }
          };
          for (const t of (node.from.tables || [])) fix(t);
          for (const j of (node.from.joins || [])) fix(j.item);
        }
        for (const k of Object.keys(node)) { if (k !== 'from') bind(node[k]); }
      };
      bind(step);
      // 递归项的输出列强制用 CTE 声明的列名 —— 表达式文本（'n + 1'）不能当列名，
      // 否则下一轮迭代取不到列。
      if (cte.columns && cte.columns.length) {
        step.columns = (step.columns || []).slice(0, cte.columns.length)
          .map((c, i) => ({ ...c, alias: cte.columns[i] }));
      }
      const res = await this.executeSelect(step);
      let next = res.rows.map(r => Object.assign({}, r));
      if (cte.columns && cte.columns.length) {
        next = next.map(r => {
          const keys = Object.keys(r);
          const out = {};
          cte.columns.forEach((c, idx) => { out[c] = r[keys[idx]]; });
          return out;
        });
      }
      if (!isAll) {
        const seen = new Set(accumulated.map(r => JSON.stringify(r)));
        next = next.filter(r => !seen.has(JSON.stringify(r)));
      }
      if (next.length === 0) break;
      // 超过行数上限说明递归条件写错（恒真），提前收手而不是撑爆内存
      if (accumulated.length + next.length > MAX_ROWS) {
        accumulated = accumulated.concat(next.slice(0, MAX_ROWS - accumulated.length));
        break;
      }
      accumulated = accumulated.concat(next);
      frontier = next;      // 下一轮只喂本轮新增的行
    }
    return accumulated;
  }

  _inlineCteRefs(node, map) {
    if (!node || typeof node !== 'object' || map.size === 0) return;
    if (Array.isArray(node)) {
      for (const n of node) this._inlineCteRefs(n, map);
      return;
    }
    if (node.type === 'select' && node.from) {
      const rewrite = (item) => {
        if (!item || !item.table) return;
        const key = String(item.table).toLowerCase();
        if (!map.has(key)) return;
        const sub = JSON.parse(JSON.stringify(map.get(key)));
        item.subquery = sub;
        item.alias = item.alias || item.table;
        delete item.table;
      };
      for (const t of (node.from.tables || [])) rewrite(t);
      for (const j of (node.from.joins || [])) rewrite(j.item);
    }
    for (const k of Object.keys(node)) {
      if (k === 'from') continue;                    // 已单独处理，避免重复改写
      const v = node[k];
      if (v && typeof v === 'object') this._inlineCteRefs(v, map);
    }
  }

  /**
   * 计算 SELECT 列表中的窗口函数列，把结果直接写回每一行（键名为输出列名）。
   * 放在 WHERE / GROUP BY / HAVING 之后、ORDER BY / LIMIT 之前，符合 SQL 求值顺序。
   */
  _computeWindows(statement, rows) {
    if (!rows || rows.length === 0) return rows;
    const specs = [];
    for (const c of statement.columns) {
      const sc = c.scalar;
      const over = (sc && sc.over) || c.over;
      if (!over) continue;
      const fn = sc && sc.type === 'aggregate' ? String(sc.fn)
        : (sc && sc.type === 'func' ? String(sc.name).toUpperCase()
          : String(c.aggregate || '').toUpperCase());
      specs.push({ col: c, spec: sc, over, fn, name: scalarColumnName(c) });
    }
    if (specs.length === 0) return rows;
    const toNode = (x) => !x ? null : (typeof x === 'string' ? { type: 'column', name: x } : x);
    specs.forEach((w, i) => { w.col._windowKey = w.col.alias || ('__win_' + i); });

    for (const w of specs) {
      const partBy = w.over.partitionBy || [];
      const orderBy = w.over.orderBy || [];
      // 分区
      const buckets = new Map();
      rows.forEach((r, idx) => {
        const key = partBy.length
          ? partBy.map(p => JSON.stringify(resolveOperand(p, r, this.ctx))).join('')
          : '';
        if (!buckets.has(key)) buckets.set(key, []);
        buckets.get(key).push(idx);
      });

      for (const idxs of buckets.values()) {
        let ordered = idxs.slice();
        if (orderBy.length) {
          ordered = ordered.slice().sort((ia, ib) => {
            const ra = rows[ia], rb = rows[ib];
            for (const o of orderBy) {
              const av = resolveOperand(o.column, ra, this.ctx);
              const bv = resolveOperand(o.column, rb, this.ctx);
              if (av === bv) continue;
              if (av === undefined || av === null) return -1;
              if (bv === undefined || bv === null) return 1;
              const d = typeof av === 'number' && typeof bv === 'number' ? av - bv : String(av).localeCompare(String(bv));
              if (d !== 0) return o.dir === 'asc' ? d : -d;
            }
            return ia - ib;
          });
        }
        // 帧范围（ROWS 帧；RANGE 在当前实现下退化为整个分区，保守处理）
        const frameIdx = (i) => {
          const f = w.over.frame;
          if (!f) return { start: 0, end: ordered.length - 1 };
          let start = 0, end = ordered.length - 1;
          const apply = (b, isStart) => {
            if (!b) return isStart ? 0 : ordered.length - 1;
            if (b.type === 'unbounded') return b.direction === 'preceding' ? 0 : ordered.length - 1;
            if (b.type === 'currentRow') return i;
            return b.direction === 'preceding' ? i - b.value : i + b.value;
          };
          start = apply(f.start, true);
          end = apply(f.end, false);
          return { start: Math.max(0, start), end: Math.min(ordered.length - 1, end) };
        };

        const argNode = toNode((w.spec && (w.spec.column || (w.spec.args && w.spec.args[0]))) || w.col.column || w.col.expr);
        const valAt = (rowIdx, node) => resolveOperand(node || { type: 'value', value: 1 }, rows[rowIdx], this.ctx);

        ordered.forEach((rowIdx, pos) => {
          let v = null;
          switch (w.fn) {
            case 'ROW_NUMBER': v = pos + 1; break;
            case 'RANK': {
              // RANK = 1 + 分区内排在本行之前、且不是同值(peer)的行数
              v = 1;
              for (let k = 0; k < pos; k++) {
                if (this._windowPeerCmp(rows[ordered[k]], rows[rowIdx], orderBy, this.ctx) !== 0) v++;
              }
              break;
            }
            case 'DENSE_RANK': {
              // 1 + 排在本行之前的不同取值个数（同值并列，不跳号）
              const curKey = this._windowPeerKey(rows[rowIdx], orderBy, this.ctx);
              const seen = new Set();
              for (let k = 0; k < pos; k++) {
                const kk = this._windowPeerKey(rows[ordered[k]], orderBy, this.ctx);
                if (kk !== curKey) seen.add(kk);
              }
              v = seen.size + 1;
              break;
            }
            case 'NTILE': {
              const n = w.spec && w.spec.args && w.spec.args[0] ? Number(resolveOperand(w.spec.args[0], rows[rowIdx], this.ctx)) : 1;
              const bucketsN = Math.max(1, Math.floor(n) || 1);
              v = Math.min(bucketsN, Math.floor((pos * bucketsN) / ordered.length) + 1);
              break;
            }
            case 'LAG':
            case 'LEAD': {
              const off = w.spec && w.spec.args && w.spec.args[1] ? Number(resolveOperand(w.spec.args[1], rows[rowIdx], this.ctx)) : 1;
              const target = w.fn === 'LAG' ? pos - off : pos + off;
              if (target < 0 || target >= ordered.length) {
                v = w.spec && w.spec.args && w.spec.args[2] ? resolveOperand(w.spec.args[2], rows[rowIdx], this.ctx) : null;
              } else {
                v = valAt(ordered[target], argNode);
              }
              break;
            }
            case 'FIRST_VALUE':
            case 'LAST_VALUE': {
              const f = frameIdx(pos);
              const t = w.fn === 'FIRST_VALUE' ? f.start : f.end;
              v = valAt(ordered[t], argNode);
              break;
            }
            case 'COUNT':
            case 'SUM':
            case 'AVG':
            case 'MIN':
            case 'MAX': {
              const f = frameIdx(pos);
              const slice = ordered.slice(f.start, f.end + 1).map(i => rows[i]);
              v = this._aggValue(slice, w.fn, argNode, !!(w.spec && w.spec.distinct), w.spec && w.spec.separator);
              break;
            }
            default: v = null;
          }
          rows[rowIdx][w.col._windowKey] = v;
        });
      }
    }
    return rows;
  }

  _windowPeerKey(row, orderBy, ctx) {
    if (!orderBy.length) return '';
    return orderBy.map(o => JSON.stringify(resolveOperand(o.column, row, ctx))).join('');
  }

  _windowPeerCmp(rowA, rowB, orderBy, ctx) {
    if (!orderBy.length) return 0;
    for (const o of orderBy) {
      const av = resolveOperand(o.column, rowA, ctx);
      const bv = resolveOperand(o.column, rowB, ctx);
      if (av === bv) continue;
      if (av === undefined || av === null) return -1;
      if (bv === undefined || bv === null) return 1;
      const d = typeof av === 'number' && typeof bv === 'number' ? av - bv : String(av).localeCompare(String(bv));
      if (d !== 0) return d;
    }
    return 0;
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

  /**
   * 把 FROM 中引用视图的表名展开为视图定义里的子查询（就地改写）。
   * 与 CTE 一样走子查询内联，不需要引擎侧物化视图。
   */
  _expandViews(statement, depth = 0) {
    const views = this.engine && this.engine._views;
    if (!views || !statement || !statement.from) return statement;
    if (depth > 16) throw new Error('View nesting too deep — possible circular view definition');
    const rewrite = (item) => {
      if (!item || !item.table) return;
      const v = views[String(item.table).toLowerCase()];
      if (!v) return;
      const sub = JSON.parse(JSON.stringify(v.select));
      if (v.columns && v.columns.length) {
        sub.columns.forEach((c, i) => { if (v.columns[i] && !c.alias) c.alias = v.columns[i]; });
      }
      this._expandViews(sub, depth + 1);       // 视图里再引用视图
      item.subquery = sub;
      item.alias = item.alias || item.table;
      delete item.table;
    };
    for (const t of (statement.from.tables || [])) rewrite(t);
    for (const j of (statement.from.joins || [])) rewrite(j.item);
    return statement;
  }

  async executeSelect(statement) {
    // 视图：FROM 里的视图名展开成子查询
    if (this.engine && this.engine._views) this._expandViews(statement);

    // UNION 处理
    if (statement.union) {
      const left = await this.executeSelect({ ...statement, union: null });
      const right = await this.executeSelect(statement.union.select);
      let rows = left.rows.concat(right.rows);
      if (!statement.union.all) rows = dedupeRows(rows);
      return { ok: true, type: 'select', columns: left.columns, rows, raw: rows };
    }

    // INTERSECT：保留同时出现在右侧结果中的行（默认 DISTINCT，与 UNION 的处理保持一致）
    if (statement.intersect) {
      const left = await this.executeSelect({ ...statement, intersect: null, except: null });
      const right = await this.executeSelect(statement.intersect.select);
      const seen = new Set(right.rows.map(r => JSON.stringify(r)));
      let out = left.rows.filter(r => seen.has(JSON.stringify(r)));
      if (!statement.intersect.all) out = dedupeRows(out);
      return { ok: true, type: 'select', columns: left.columns, rows: out, raw: out };
    }

    // EXCEPT：去掉出现在右侧结果中的行（默认 DISTINCT）
    if (statement.except) {
      const left = await this.executeSelect({ ...statement, intersect: null, except: null });
      const right = await this.executeSelect(statement.except.select);
      const seen = new Set(right.rows.map(r => JSON.stringify(r)));
      let out = left.rows.filter(r => !seen.has(JSON.stringify(r)));
      if (!statement.except.all) out = dedupeRows(out);
      return { ok: true, type: 'select', columns: left.columns, rows: out, raw: out };
    }

    // 物化 WHERE / HAVING / JOIN ON 中的子查询
    await this._materialize(statement.where);
    await this._materialize(statement.having);
    if (statement.from) {
      for (const j of statement.from.joins) await this._materialize(j.on);
    }
    for (const c of statement.columns) {
      if (c.caseExpr) await this._materialize(c.caseExpr);
      // 非相关标量子查询先求值一次；相关子查询稍后由 _projectRows 逐行覆盖
      if (c.scalar) await this._materialize(c.scalar);
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
        const filtered = statement.where ? all.filter(r => evaluateExpr(statement.where, r, this.ctx)) : all;
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
        // 递归 CTE 物化出来的派生表：直接携带行数据
        if (firstItem.subquery._virtualSource) {
          rowsAll = { rows: firstItem.subquery._virtualSource.map(r => Object.assign({}, r)), schema: null, columns: null };
        } else {
          const res = await this.executeSelect(firstItem.subquery);
          rowsAll = { rows: this._subQueryRows(res), schema: null, columns: res.columns };
        }
      } else if (firstItem._virtualRows) {
        // 递归 CTE 迭代中：自身引用绑定到已累积的行
        rowsAll = { rows: firstItem._virtualRows.map(r => Object.assign({}, r)), schema: null, columns: null };
      } else {
        rowsAll = await this._readTable(firstItem.table, statement);
      }
      schema = rowsAll.schema;
      const firstPrefix = firstItem.alias || firstItem.table;
      // 虚拟行分两种，语义不同：
      //  - _virtualRows：递归 CTE **迭代过程内部**，FROM 是自身引用，列名不带前缀
      //    （否则递归项里的 `n+1` 取不到值）
      //  - subquery._virtualSource：递归 CTE **求值完成后**物化成的派生表，
      //    与普通子查询一样按别名加前缀，外层才能写 c.n / x.n
      const isVirtualSource = !!(firstItem.subquery && firstItem.subquery._virtualSource);
      // 物化派生表：行键需要同时有 'c.n'（限定引用）与 'n'（非限定引用）。
      // _prefixRow 正是这么做的 —— 但 SELECT * 会把两者都投影，同一列输出两次。
      // 所以额外记下真实列名，SELECT * 时按它们去重。
      this._curStarCols = isVirtualSource
        ? (firstItem.subquery.columns || []).map(c => {
            const a = c.alias || c.expr;
            return (a && String(a).includes('.') ? String(a) : `${firstPrefix}.${a}`);
          }).filter(Boolean)
        : null;
      let rows = isVirtualSource
        ? rowsAll.rows.map(r => this._prefixRow(r, firstPrefix))
        : (firstItem._virtualRows ? rowsAll.rows : rowsAll.rows.map(r => this._prefixRow(r, firstPrefix)));

      for (const j of statement.from.joins) {
        // 虚拟行（递归 CTE 物化的派生表）要直接取行，不能当普通子查询执行
        const jVirtual = j.item._virtualRows ||
          (j.item.subquery && j.item.subquery._virtualSource);
        const rightRes = jVirtual
          ? { rows: (j.item._virtualRows || j.item.subquery._virtualSource).map(r => Object.assign({}, r)) }
          : j.item.subquery
            ? await this.executeSelect(j.item.subquery)
            : await this._readTable(j.item.table, statement);
        const rightPrefix = j.item.alias || j.item.table;
        // 迭代内部的虚拟行不加前缀；物化后的派生表要加（与普通子查询一致）
        const jRaw = j.item._virtualRows
          ? j.item._virtualRows
          : (j.item.subquery && j.item.subquery._virtualSource
            ? j.item.subquery._virtualSource
            : (j.item.subquery ? this._subQueryRows(rightRes) : rightRes.rows));
        const rightRows = (j.item._virtualRows && !j.item.subquery)
          ? jRaw
          : jRaw.map(r => this._prefixRow(r, rightPrefix));

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
          // 一对多：一个左行可能匹配多个右行，必须全部收进来（此前只取第一个）
          const hits = [];
          for (let ri = 0; ri < rightRows.length; ri++) {
            if (evaluateExpr(j.on, { ...l, ...rightRows[ri] }, this.ctx)) hits.push(ri);
          }
          if (hits.length > 0) {
            for (const ri of hits) {
              matched.push({ ...l, ...rightRows[ri] });
              unmatchedRight.delete(ri);
            }
          } else if (j.type === 'left' || j.type === 'full') {
            matched.push(rightNulls ? { ...rightNulls, ...l } : { ...l });
          }
        });
        if (j.type === 'right' || j.type === 'full') {
          for (const ri of unmatchedRight) matched.push(leftNulls ? { ...leftNulls, ...rightRows[ri] } : { ...rightRows[ri] });
        }
        rows = matched;
      }
      all = rows;
    }

    let rows = all;
    this._validateColumnRefs(statement, rows);
    if (statement.where) {
      // 相关子查询：必须逐行重新求值，否则外层引用拿不到当前行的值
      const outerAliases = this._outerAliases(statement);
      const subNodes = this._collectSubqueries(statement.where)
        .filter(n => this._isCorrelated(n, outerAliases));
      if (subNodes.length > 0) {
        const kept = [];
        for (const r of rows) {
          for (const node of subNodes) await this._evalCorrelated(node, r);
          if (evaluateExpr(statement.where, r, this.ctx)) kept.push(r);
        }
        rows = kept;
      } else {
        rows = rows.filter(r => evaluateExpr(statement.where, r, this.ctx));
      }
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

    // 无 GROUP BY 时整张表就是一个分组。必须先给每行挂上 _group=全表，
    // 否则 HAVING 里的 COUNT(*) 会被逐行算成 1（r._group || [r]），
    // 于是 HAVING COUNT(*) > 2 会把所有行滤掉、最终输出 0 而不是真实计数。
    if (statement.having && !statement.groupBy) {
      const wholeTable = rows.slice();
      rows = rows.map((r) => ({ ...r, _group: wholeTable }));
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
            const v = this._aggValue(group, c.aggregate || 'COUNT', c.column, c.distinct, c.separator, c.orderBy);
            ctx['__agg_' + (c.alias || c.column || 'COUNT(*)')] = v;
            if (c.column) ctx[c.column] = v;
            if (c.alias) ctx[c.alias] = v;
          }
        }
        return evaluateExpr(h, ctx);
      });
    }

    // 窗口函数：在 WHERE/GROUP BY/HAVING 之后、DISTINCT/ORDER BY/LIMIT 之前求值
    if (statement.columns.some(c => (c.scalar && c.scalar.over) || c.over)) {
      this._computeWindows(statement, rows);
    }

    if (statement.distinct) {
      const seen = new Set();
      rows = rows.filter(r => {
        const key = JSON.stringify(statement.columns.map(c => {
          // SELECT DISTINCT *：按整行去重（此前把 '*' 当列名解析成 null，导致所有行同 key 只剩 1 行）
          if (c.expr === '*') {
            const allKeys = Object.keys(r).filter(k => !String(k).startsWith('_')).sort();
            // 物化派生表（递归 CTE 结果）的行同时带 'c.n' 与 'n' 两个键 ——
            // 前者供限定引用、后者供非限定引用。SELECT * 时两者都会被投影，
            // 同一列会输出两次，所以按 FROM 里的声明列去重，保留带前缀的那个。
            // 现算而不是读实例字段：投影发生在另一次调用里，字段已被覆盖。
            const fi = statement.from && statement.from.tables && statement.from.tables[0];
            const vs = fi && fi.subquery && fi.subquery._virtualSource && fi.subquery.columns;
            if (vs && vs.length) {
              return vs.map(c => {
                const a = c.alias || c.expr;
                const key = (a && String(a).includes('.')) ? String(a) : `${fi.alias || fi.table}.${a}`;
                return r[key] !== undefined ? r[key] : r[a];
              });
            }
            return allKeys.map(k => r[k]);
          }
          if (c.scalar) return resolveOperand(c.scalar, r, this.ctx);
          if (c.caseExpr) return evaluateCaseVal(c.caseExpr, r);
          if (c.aggregate) return this._aggValue(r._group || [r], c.aggregate || 'COUNT', c.column, c.distinct, c.separator, c.orderBy);
          return resolveOperand({ type: 'column', name: c.expr }, r, this.ctx);
        }));
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    }

    // 聚合输出（无 GROUP BY 时）
    const hasCustomAgg = this.ctx && this.ctx.aggregates && statement.columns.some(c => c.scalar && c.scalar.type === 'func' && Object.prototype.hasOwnProperty.call(this.ctx.aggregates, String(c.scalar.name).toUpperCase()));
    // 注意：带 OVER 的聚合是窗口函数，不是“整表塌缩成一行”的聚合，必须排除
    // 无 GROUP BY 的整表聚合：顶层是聚合（AVG(x)）、自定义聚合（total(x)），
    // 以及嵌套聚合（ROUND(AVG(x),1) —— 聚合藏在 scalar 的参数里，顶层 c.aggregate 为空）
    const hasNestedAgg = !statement.groupBy &&
      statement.columns.some(c => c.scalar && containsAggregateNode(c.scalar));
    if (!statement.groupBy && (statement.columns.some(c => c.aggregate && !c.window) || hasCustomAgg || hasNestedAgg)) {
      const cols = statement.columns.map(c => scalarColumnName(c));
      const tableName2 = statement.from ? (statement.from.tables[0].table || null) : null;
      // HAVING 判定不通过时 rows 已为空，此时整表聚合也应为空，不能无条件补一行
      if (statement.having && rows.length === 0) {
        return { ok: true, type: 'select', table: tableName2, columns: cols, rows: [], aggregate: statement.aggregate };
      }
      const valueOf = (c) => {
        if (c.aggregate) return this._aggValue(rows, c.aggregate || 'COUNT', c.column, c.distinct, c.separator, c.orderBy);
        if (c.scalar && c.scalar.type === 'func' && hasCustomAgg) {
          const fn = String(c.scalar.name).toUpperCase();
          if (Object.prototype.hasOwnProperty.call(this.ctx.aggregates, fn)) {
            return this._aggValue(rows, fn, c.scalar.args && c.scalar.args[0]);
          }
        }
        if (c.scalar) {
          // 先把参数里的聚合按整表求值替换掉，否则 ROUND(AVG(x),1) 会得到 null
          if (containsAggregateNode(c.scalar)) {
            const nested = JSON.parse(JSON.stringify(c.scalar));
            this._replaceAggregates(nested, rows);
            return projectScalar(resolveOperand(nested, rows[0] || {}, this.ctx));
          }
          return projectScalar(resolveOperand(c.scalar, rows[0] || {}, this.ctx));
        }
        if (c.caseExpr) return projectScalar(resolveOperand(c.caseExpr, rows[0] || {}, this.ctx));
        if (c.expr !== null && c.expr !== '*') return rows[0] ? projectScalar(resolveOperand({ type: 'column', name: c.expr }, rows[0])) : null;
        return null;
      };
      return { ok: true, type: 'select', table: tableName2, columns: cols, rows: [[...statement.columns.map(valueOf)]], aggregate: statement.aggregate };
    }

    // GROUP BY 输出：每组的列（含聚合列）
    if (statement.groupBy) {
      const cols = statement.columns.map(c => scalarColumnName(c));
      const rowsForGroups = (statement.rollup && rows.length > 0)
        // WITH ROLLUP：追加一个"全表汇总"分组（分组列取 NULL，聚合列覆盖全部行）
        ? rows.concat([this._rollupRow(rows)])
        : rows;
      const mapped = await this._projectRows(statement, rowsForGroups, (r) => {
        const group = r._group || [r];
        return statement.columns.map(c => scalarColumnValue(c, r, {
          _aggValue: this._aggValue.bind(this),
          _replaceAggregates: this._replaceAggregates.bind(this),
          group,
          ctxAggregates: this.ctx ? this.ctx.aggregates : null,
        }));
      });
      // GROUP BY 路径此前直接 return，ORDER BY 完全没有生效
      //（SELECT dept, SUM(sal) AS total FROM emp GROUP BY dept ORDER BY total DESC
      //   返回的仍是分组出现顺序）。这里补上排序，规则与非分组路径一致。
      let outRows = mapped;
      if (statement.orderBy && mapped.length > 1) {
        const ordVal = (row, o) => {
          // row 是投影后的 [v1, v2, ...]，按列名下标取
          const name = typeof o.column === 'string' ? o.column
            : (o.column && o.column.type === 'column' ? o.column.name : null);
          const pos = (o.column && typeof o.column === 'object' && o.column.type === 'value'
            && typeof o.column.value === 'number') ? o.column.value
            : (typeof o.column === 'number' ? o.column : null);
          if (name === null && pos !== null && pos >= 1 && pos <= cols.length) {
            return row[pos - 1];
          }
          if (name === null) return null;
          const idx = cols.indexOf(name);
          return idx === -1 ? null : row[idx];
        };
        const cmp = (a, b) => {
          for (const o of statement.orderBy) {
            const av = ordVal(a.row, o);
            const bv = ordVal(b.row, o);
            if (av === bv || (av === undefined && bv === undefined)) continue;
            if (av === undefined || av === null) return o.dir === 'asc' ? -1 : 1;
            if (bv === undefined || bv === null) return o.dir === 'asc' ? 1 : -1;
            const r = typeof av === 'number' && typeof bv === 'number' ? av - bv : String(av).localeCompare(String(bv));
            if (r !== 0) return o.dir === 'asc' ? r : -r;
          }
          return 0;
        };
        outRows = mapped
          .map((row, i) => ({ row, src: rowsForGroups[i] }))
          .sort(cmp)
          .map(x => x.row);
      }
      if (statement.limit !== null) {
        const start = statement.offset || 0;
        outRows = outRows.slice(start, start + statement.limit);
      }
      return { ok: true, type: 'select', table: statement.from ? (statement.from.tables[0].table || null) : null, columns: cols, rows: outRows, raw: rowsForGroups };
    }

    if (statement.orderBy) {
      // ORDER BY 项可能是列名字符串、表达式节点，或列的位置序号（ORDER BY 1，1-based）
      const ordNames = statement.columns.map(c => scalarColumnName(c));
      const ordVal = (row, o) => {
        const pos = (o.column && typeof o.column === 'object' && o.column.type === 'value' && typeof o.column.value === 'number')
          ? o.column.value
          : (typeof o.column === 'number' ? o.column : null);
        if (pos !== null && pos !== undefined) {
          const name = ordNames[pos - 1];
          if (name !== undefined && name !== null) return resolveOperand({ type: 'column', name }, row, this.ctx);
        }
        return typeof o.column === 'string'
          ? resolveOperand({ type: 'column', name: o.column }, row, this.ctx)
          : resolveOperand(o.column, row, this.ctx);
      };
      const cmp = (a, b) => {
        for (const o of statement.orderBy) {
          const av = ordVal(a, o);
          const bv = ordVal(b, o);
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
      // 物化派生表（递归 CTE 结果）的行同时带 'c.n' 与 'n'：前者供限定引用、
      // 后者供非限定引用。SELECT * 会把两者都输出，同一列重复。
      // 按声明的列去重，优先取带前缀的那个键。
      const fi = statement.from && statement.from.tables && statement.from.tables[0];
      const vs = fi && fi.subquery && fi.subquery._virtualSource && fi.subquery.columns;
      if (vs && vs.length) {
        cols = vs.map(c => {
          const a = c.alias || c.expr;
          return (a && String(a).includes('.')) ? String(a) : `${fi.alias || fi.table}.${a}`;
        });
      }
      return { ok: true, type: 'select', table: tableName, columns: cols, rows: rows.map(r => cols.map(c => (r[c] !== undefined ? r[c] : r[String(c).slice(String(c).indexOf('.') + 1)]))), raw: rows };
    }

    const cols = statement.columns.map(c => scalarColumnName(c));
    const mapped = await this._projectRows(statement, rows, (r) => statement.columns.map(c => {
      if (c.over || (c.scalar && c.scalar.over)) return windowColumnValue(c, r);
      if (c.scalar) return projectScalar(resolveOperand(c.scalar, r, this.ctx));
      if (c.expr === '*') return null;
      if (c.literal !== undefined) return c.literal;
      if (c.caseExpr) return projectScalar(evaluateCaseVal(c.caseExpr, r));
      return projectScalar(resolveOperand({ type: 'column', name: c.expr }, r, this.ctx));
    }));
    return { ok: true, type: 'select', table: tableName, columns: cols, rows: mapped, raw: rows };
  }
}

/** 跳过一个引号串（含转义/反引号成对），返回闭合引号之后的下标 */
function skipQuoted(sql, i, q) {
  const n = sql.length;
  i++;   // 跳过起始引号
  while (i < n) {
    const c = sql[i];
    if (q === '`') {
      // 反引号标识符内部反斜杠不是转义符；两个连续反引号表示一个字面反引号。
      if (c === '`') {
        if (sql[i + 1] === '`') { i += 2; continue; }
        return i + 1;
      }
      i++;
      continue;
    }
    if (c === '\\') { i += 2; continue; }
    if (c === q) return i + 1;
    i++;
  }
  return n;   // 未闭合：到结尾
}

function splitStatements(sql, opts = {}) {
  if (typeof sql !== 'string') {
    throw new Error('splitStatements: sql must be a string');
  }
  const maxLength = opts.maxLength == null ? DEFAULT_MAX_SQL_LENGTH : opts.maxLength;
  if (typeof maxLength === 'number' && Number.isFinite(maxLength) && sql.length > maxLength) {
    throw new Error(
      `SQL text too large: ${sql.length} chars exceeds limit of ${maxLength} ` +
      `(raise opts.maxSqlLength to allow larger input)`
    );
  }
  const statements = [];
  // 用「区间切片」收集，而不是逐字符拼接：既避免 `current += c` 的 O(n²) 拷贝放大，
  // 也避免为每个字符建一个小字符串对象（20MB 无分号输入下两者都会打爆默认堆）。
  let parts = [];
  const take = end => { parts.push(sql.slice(segStart, end)); };
  const flush = () => {
    if (parts.length === 0) return;
    const stmt = parts.join('').trim();
    parts = [];
    if (stmt) statements.push(stmt);
  };

  let segStart = 0;
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i];
    if (c === "'" || c === '"' || c === '`') { i = skipQuoted(sql, i, c); continue; }
    if (c === '-' && sql[i + 1] === '-') {
      // 行注释：丢弃注释文本本身（与原实现一致），保留其后的换行
      take(i);
      while (i < n && sql[i] !== '\n') i++;
      segStart = i;
      continue;
    }
    if (c === '#' && sql[i + 1] !== '>') {
      take(i);
      while (i < n && sql[i] !== '\n') i++;
      segStart = i;
      continue;
    }
    if (c === '/' && sql[i + 1] === '*') {
      // 块注释：原实现会保留 `/* */` 原文，这里通过切片一并保留
      i += 2;
      while (i + 1 < n && !(sql[i] === '*' && sql[i + 1] === '/')) i++;
      i = i + 1 < n ? i + 2 : n;
      continue;
    }
    if (c === ';') {
      take(i);
      flush();
      i++;
      segStart = i;
      continue;
    }
    i++;
  }
  take(n);
  flush();
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
    if (c === '#' && sql[i + 1] !== '>') return true;   // '#>' / '#>>' 是 JSON 操作符，不是注释
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
  const n = sql.length;
  while (i < n) {
    const c = sql[i];
    if (inStr) {
      out += c;
      if (c === '\\' && i + 1 < n) { out += sql[i + 1]; i += 2; continue; }
      if (c === inStr) inStr = null;
      i++;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') { inStr = c; out += c; i++; continue; }
    // 跳过注释：`--` 和 `#`（但 `#>` / `#>>` 是 JSON 操作符，不是注释）
    if (c === '-' && sql[i + 1] === '-') {
      // 行注释：整段跳过，保留换行（不在注释里的字符不进入 out）
      while (i < n && sql[i] !== '\n') i++;
      continue;
    }
    if (c === '#' && sql[i + 1] !== '>') {
      while (i < n && sql[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && sql[i + 1] === '*') {
      // 块注释：整段跳过
      i += 2;
      while (i + 1 < n && !(sql[i] === '*' && sql[i + 1] === '/')) i++;
      if (i + 1 < n) i += 2; else i = n;
      continue;
    }
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
    // $N 编号占位符（PG 风格）：$1 / $2 ...
    if (c === '$' && i + 1 < sql.length && sql[i + 1] >= '0' && sql[i + 1] <= '9') {
      let num = '';
      let j = i + 1;
      while (j < sql.length && sql[j] >= '0' && sql[j] <= '9') { num += sql[j]; j++; }
      const n = parseInt(num, 10);
      if (hasNamed) {
        if (!(n in args)) throw new Error(`No value for parameter $${n}`);
        out += escapeValue(args[n]);
      } else {
        if (n - 1 >= args.length) throw new Error(`Not enough parameters for SQL: expected $${n}`);
        out += escapeValue(args[n - 1]);
        if (n > idx) idx = n;
      }
      count++;
      i = j;
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

// 把执行器结果补齐为 README 承诺的结果信封
// （columnTypes / rowCount / message / command / durationMs / warnings）
function buildResultEnvelope(stmt, r, durationMs) {
  if (r === null || typeof r !== 'object' || Array.isArray(r)) return r;
  const out = { ...r };
  const t = stmt && stmt.type;
  if (out.command === undefined) out.command = String(t || '').toUpperCase();
  if (out.affectedRows === undefined) out.affectedRows = 0;
  if (out.rowCount === undefined) {
    out.rowCount = Array.isArray(out.rows) ? out.rows.length
      : (typeof out.affectedRows === 'number' ? out.affectedRows : 0);
  }
  if (out.warnings === undefined) out.warnings = [];
  if (out.durationMs === undefined) out.durationMs = durationMs;
  if (out.message === undefined) {
    out.message = t === 'select'
      ? `${out.rowCount} row${out.rowCount === 1 ? '' : 's'} selected`
      : `${out.affectedRows} row${out.affectedRows === 1 ? '' : 's'} affected`;
  }
  return out;
}

// SELECT 结果的列类型：单表查询按 schema 推断；表达式/多表查询该列为 null
async function inferColumnTypes(engine, stmt, r) {
  if (!r || !Array.isArray(r.columns)) return undefined;
  let schema = null;
  try {
    const t = stmt && stmt.type === 'select' && stmt.from &&
      Array.isArray(stmt.from.tables) && stmt.from.tables.length === 1
      ? stmt.from.tables[0].table : null;
    if (t && engine && typeof engine.getTableSchema === 'function') schema = await engine.getTableSchema(t);
  } catch (e) { schema = null; }
  return r.columns.map((name) => {
    const def = schema && schema[name];
    return def && def.type ? sqlTypeName(def.type).toUpperCase() : null;
  });
}

async function executeSQL(engine, sql, paramsOrOpts, opts = {}) {
  // 参数守卫：engine 必须是引擎对象，sql 必须是字符串。误用时报清晰错误，
  // 而不是在后续像 `reading 'length'` 那样抛出令人费解的 TypeError。
  if (typeof engine !== 'object' || engine === null) {
    if (typeof engine === 'string') {
      throw new Error(
        `executeSQL(engine, sql, ...) 参数错误：第一个参数不能是 SQL 字符串，必须传 engine 引擎对象。\n` +
        `正确用法：await executeSQL(db, '${engine.slice(0, 40)}…');  // db 是含 hasTable/find/getTableSchema 的对象`
      );
    }
    throw new Error(
      `executeSQL(engine, sql, ...) 参数错误：缺少第一个参数 engine。\n` +
      `正确用法：await executeSQL(db, 'SELECT 1');  // db 需是含 hasTable/find/getTableSchema 的引擎对象`
    );
  }
  if (typeof sql !== 'string' || sql.length === 0) {
    throw new Error(
      `executeSQL(engine, sql, ...) 参数错误：第二个参数 sql 必须是有效的 SQL 字符串`
    );
  }
  if (Array.isArray(paramsOrOpts)) {
    sql = applyParams(sql, paramsOrOpts);
  } else if (paramsOrOpts && typeof paramsOrOpts === 'object') {
    // 第三参为对象时：含已知 opts 键 → 视为 opts；否则视为命名参数（{id: 1} → :id / $id）
    const OPTS_KEYS = ['safety', 'session', 'params', 'functions', 'aggregates',
      'allowComments', 'maxStatements', 'maxSqlLength', 'context', 'timeout', 'dialect'];
    const looksLikeOpts = Object.keys(paramsOrOpts).some(k => OPTS_KEYS.includes(k));
    if (looksLikeOpts) opts = paramsOrOpts;
    else sql = applyParams(sql, paramsOrOpts);
  }
  if (opts.safety !== false) {
    if (!opts.allowComments && hasComments(sql)) {
      throw new Error('SQL comments are disabled for security (--, #, /* */)');
    }
  }
  let statements = splitStatements(sql, { maxLength: opts.maxSqlLength });
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
  if (opts.params) ctx.params = opts.params;   // 原生 ? 占位符（applyParams 之外的另一种用法）
  if (opts.functions && typeof opts.functions === 'object') ctx.functions = opts.functions;
  if (opts.aggregates && typeof opts.aggregates === 'object') ctx.aggregates = opts.aggregates;
  const executor = new SQLExecutor(engine, Object.keys(ctx).length > 0 ? ctx : null);
  const results = [];
  for (const stmtSql of statements) {
    const stmt = parseSQL(stmtSql);
    const t0 = process.hrtime.bigint();
    let r = await executor.execute(stmt);
    const durationMs = Number(process.hrtime.bigint() - t0) / 1e6;
    r = buildResultEnvelope(stmt, r, Math.round(durationMs * 1000) / 1000);
    if (r && r.columns && r.columnTypes === undefined) {
      r.columnTypes = await inferColumnTypes(engine, stmt, r);
    }
    results.push(r);
  }
  return results.length === 1 ? results[0] : results;
}

// AST 访问与改写能力（纯新增，不改变既有导出项）
const AST = require('./ast.js');

module.exports = {
  tokenize, parseSQL, executeSQL, SQLExecutor, Parser,
  splitStatements, applyParams, escapeValue, escapeId,
  AST,
  walk: AST.walk,
  transform: AST.transform,
  visit: AST.StatementVisitor
};
