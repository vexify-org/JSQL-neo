'use strict';
/**
 * XQL 解析器（递归下降，产出扁平 AST）
 *
 * 支持两种写法，解析成**同一棵 AST**：
 *   管道式：FROM users |> WHERE age > 18 |> SELECT name |> ORDER BY name |> LIMIT 10
 *   标准式：SELECT name FROM users WHERE age > 18 ORDER BY name LIMIT 10
 *
 * AST 保持扁平（不建深层节点），编译期再决定怎么生成代码。
 */

const { tokenize } = require('./tokenizer');

class Parser {
  constructor(src) {
    this.toks = tokenize(src);
    this.i = 0;
  }

  peek(k = 0) { return this.toks[this.i + k] || this.toks[this.toks.length - 1]; }
  next() { return this.toks[this.i++]; }
  isKw(v) { const t = this.peek(); return t.t === 'kw' && t.v === v; }
  isOp(v) { const t = this.peek(); return t.t === 'op' && t.v === v; }
  eatKw(v) { if (!this.isKw(v)) this.err(`期望关键字 ${v}`); return this.next(); }
  eatOp(v) { if (!this.isOp(v)) this.err(`期望 '${v}'`); return this.next(); }
  err(msg) {
    const t = this.peek();
    throw new Error(`XQL: ${msg}，位置 ${t.p}${t.v !== null && t.v !== undefined ? `（得到 '${t.v}'）` : ''}`);
  }

  // ---- 顶层 ----
  parse() {
    if (this.isKw('FROM')) return this.parsePipeline();
    if (this.isKw('SELECT')) return this.parseClassic();
    this.err('期望 FROM 或 SELECT');
  }

  /** FROM coll [|> STAGE]... —— 首段 WHERE 允许省略 |>（写 SQL 的人常这么写） */
  parsePipeline() {
    this.eatKw('FROM');
    const q = { source: this.parseSource(), where: null, select: null, orderBy: null, limit: null, offset: null };
    if (this.isKw('WHERE')) { this.next(); q.where = this.parseExpr(); }
    for (;;) {
      if (!this.isOp('|>')) break;
      this.next();
      this.parseStage(q);
    }
    if (this.peek().t !== 'eof') this.err('语句结束后还有多余内容');
    return q;
  }

  /** SELECT list FROM coll [WHERE e] [ORDER BY f] [LIMIT n] [OFFSET n] */
  parseClassic() {
    this.eatKw('SELECT');
    const q = { source: null, where: null, select: this.parseSelectList(), orderBy: null, limit: null, offset: null };
    this.eatKw('FROM');
    q.source = this.parseSource();
    if (this.isKw('WHERE')) { this.next(); q.where = this.parseExpr(); }
    if (this.isKw('ORDER')) { this.next(); this.eatKw('BY'); q.orderBy = this.parseOrderBy(); }
    if (this.isKw('LIMIT')) { this.next(); q.limit = this.parseCount(); }
    if (this.isKw('OFFSET') || this.isKw('SKIP')) { this.next(); q.offset = this.parseCount(); }
    if (this.peek().t !== 'eof') this.err('语句结束后还有多余内容');
    return q;
  }

  parseStage(q) {
    if (this.isKw('WHERE')) {
      this.next();
      const e = this.parseExpr();
      // 多个 WHERE 用 AND 串起来 —— 管道式里每一段都能加，
      // 重复出现不该是语法错误
      q.where = q.where ? { k: 'log', op: 'and', l: q.where, r: e } : e;
      return;
    }
    if (this.isKw('SELECT')) { this.next(); if (q.select) this.err('SELECT 只能出现一次'); q.select = this.parseSelectList(); return; }
    if (this.isKw('ORDER')) { this.next(); this.eatKw('BY'); if (q.orderBy) this.err('ORDER BY 只能出现一次'); q.orderBy = this.parseOrderBy(); return; }
    if (this.isKw('LIMIT')) { this.next(); if (q.limit !== null) this.err('LIMIT 只能出现一次'); q.limit = this.parseCount(); return; }
    if (this.isKw('OFFSET') || this.isKw('SKIP')) { this.next(); q.offset = this.parseCount(); return; }
    this.err('期望 WHERE / SELECT / ORDER BY / LIMIT / OFFSET');
  }

  parseSource() {
    const t = this.peek();
    if (t.t !== 'id') this.err('期望集合名');
    this.next();
    return t.v;
  }

  parseSelectList() {
    const list = [];
    for (;;) {
      // SELECT *
      if (this.isOp('*')) { this.next(); list.push({ expr: { k: 'star' }, alias: null }); }
      else {
        const expr = this.parseExpr();
        let alias = null;
        if (this.isKw('AS')) { this.next(); alias = this.parseIdent(); }
        else if (this.peek().t === 'id') alias = this.next().v;   // SELECT name n
        list.push({ expr, alias });
      }
      if (!this.isOp(',')) break;
      this.next();
    }
    return list;
  }

  parseOrderBy() {
    const list = [];
    for (;;) {
      const expr = this.parseExpr();
      let dir = 'asc';
      if (this.isKw('ASC')) { this.next(); }
      else if (this.isKw('DESC')) { this.next(); dir = 'desc'; }
      list.push({ expr, dir });
      if (!this.isOp(',')) break;
      this.next();
    }
    return list;
  }

  parseCount() {
    const t = this.peek();
    if (t.t !== 'num') this.err('期望数字');
    this.next();
    return t.v;
  }

  parseIdent() {
    const t = this.peek();
    if (t.t !== 'id') this.err('期望标识符');
    this.next();
    return t.v;
  }

  // ---- 表达式（优先级递增）----
  parseExpr() { return this.parseOr(); }

  parseOr() {
    let l = this.parseAnd();
    while (this.isKw('OR')) { this.next(); l = { k: 'log', op: 'or', l, r: this.parseAnd() }; }
    return l;
  }

  parseAnd() {
    let l = this.parseNot();
    while (this.isKw('AND')) { this.next(); l = { k: 'log', op: 'and', l, r: this.parseNot() }; }
    return l;
  }

  parseNot() {
    if (this.isKw('NOT')) { this.next(); return { k: 'not', e: this.parseNot() }; }
    return this.parseCmp();
  }

  parseCmp() {
    const l = this.parseAdd();
    const t = this.peek();
    if (t.t === 'op' && (t.v === '=' || t.v === '==' || t.v === '!=' || t.v === '<' || t.v === '>' || t.v === '<=' || t.v === '>=')) {
      this.next();
      return { k: 'bin', op: t.v === '==' ? '=' : t.v, l, r: this.parseAdd() };
    }
    if (this.isKw('IS')) {
      this.next();
      const neg = this.isKw('NOT');
      if (neg) this.next();
      this.eatKw('NULL');
      return { k: 'isnull', e: l, neg };
    }
    if (this.isKw('LIKE')) { this.next(); return { k: 'like', e: l, p: this.parseAdd() }; }
    // IN / NOT IN
    if (this.isKw('IN') || (this.isKw('NOT') && this.peek(1).t === 'kw' && this.peek(1).v === 'IN')) {
      const neg = this.isKw('NOT');
      if (neg) this.next();
      this.next();                                  // IN
      this.eatOp('(');
      const list = [this.parseExpr()];
      while (this.isOp(',')) { this.next(); list.push(this.parseExpr()); }
      this.eatOp(')');
      return { k: 'in', e: l, list, neg };
    }
    if (this.isKw('BETWEEN')) {
      this.next();
      const lo = this.parseAdd();
      this.eatKw('AND');
      const hi = this.parseAdd();
      return { k: 'between', e: l, lo, hi };
    }
    return l;
  }

  parseAdd() {
    let l = this.parseMul();
    for (;;) {
      const t = this.peek();
      if (t.t === 'op' && (t.v === '+' || t.v === '-')) { this.next(); l = { k: 'bin', op: t.v, l, r: this.parseMul() }; }
      else break;
    }
    return l;
  }

  parseMul() {
    let l = this.parseUnary();
    for (;;) {
      const t = this.peek();
      if (t.t === 'op' && (t.v === '*' || t.v === '/' || t.v === '%')) { this.next(); l = { k: 'bin', op: t.v, l, r: this.parseUnary() }; }
      else break;
    }
    return l;
  }

  parseUnary() {
    if (this.isOp('-')) { this.next(); return { k: 'neg', e: this.parseUnary() }; }
    if (this.isOp('+')) { this.next(); return this.parseUnary(); }
    return this.parsePostfix();
  }

  /** 点号路径与数组下标：a.b.c、a[0]、a.b[1] */
  parsePostfix() {
    let e = this.parsePrimary();
    for (;;) {
      if (this.isOp('.')) {
        this.next();
        const t = this.peek();
        if (t.t !== 'id' && t.t !== 'kw') this.err('点号后期望字段名');
        this.next();
        e = e.k === 'path' ? { k: 'path', segs: e.segs.concat(t.v) } : { k: 'path', segs: [t.v], base: e };
      } else if (this.isOp('[')) {
        this.next();
        const idx = this.parseExpr();
        this.eatOp(']');
        e = { k: 'idx', obj: e, idx };
      } else break;
    }
    return e;
  }

  parsePrimary() {
    const t = this.peek();

    if (t.t === 'num' || t.t === 'str') { this.next(); return { k: 'lit', v: t.v }; }
    if (this.isKw('NULL')) { this.next(); return { k: 'lit', v: null }; }
    if (this.isKw('TRUE')) { this.next(); return { k: 'lit', v: true }; }
    if (this.isKw('FALSE')) { this.next(); return { k: 'lit', v: false }; }

    if (this.isOp('(')) {
      this.next();
      const e = this.parseExpr();
      this.eatOp(')');
      return e;
    }

    // 聚合函数
    if (t.t === 'kw' && (t.v === 'COUNT' || t.v === 'SUM' || t.v === 'AVG' || t.v === 'MIN' || t.v === 'MAX')) {
      this.next();
      this.eatOp('(');
      let arg;
      if (this.isOp('*')) { this.next(); arg = { k: 'star' }; }
      else arg = this.parseExpr();
      this.eatOp(')');
      return { k: 'agg', fn: t.v, arg };
    }

    // 标量函数
    if (t.t === 'id' && this.peek(1).t === 'op' && this.peek(1).v === '(') {
      const name = this.next().v;
      this.eatOp('(');
      const args = [];
      if (!this.isOp(')')) {
        args.push(this.parseExpr());
        while (this.isOp(',')) { this.next(); args.push(this.parseExpr()); }
      }
      this.eatOp(')');
      return { k: 'call', fn: name.toLowerCase(), args };
    }

    if (t.t === 'id') { this.next(); return { k: 'path', segs: [t.v] }; }

    this.err('期望表达式');
  }
}

function parse(src) {
  if (typeof src !== 'string' || src.trim() === '') throw new Error('XQL: 查询不能为空');
  return new Parser(src).parse();
}

module.exports = { parse, Parser };
