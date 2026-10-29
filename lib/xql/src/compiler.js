'use strict';
/**
 * XQL 编译器：AST → 单个 JS 函数
 *
 * ## 演进过程（三次被打脸）
 *
 * 1. **闭包组合**：每个 AST 节点返回一个函数，互相调用。
 *    `WHERE age > 35` 每行调 3 次函数 → 比手写慢 6.4 倍。
 *
 * 2. **生成表达式**：把 AST 编成 JS 源码字符串，但直接拼表达式。
 *    `L == null || R == null ? null : L > R` 里 L 出现三次，
 *    `r["age"]` 每行求值三遍 → OR 查询慢 7.2 倍。
 *
 * 3. **生成语句 + 临时变量**：每个子表达式求值一次存入 `_vN`。
 *    谓词本身从 7.3 倍降到 3.2 倍，但仍有天花板。
 *
 * 4. **现在：整条管道生成一个函数，WHERE 内联进循环。**
 *
 *    第 3 版遗留的 3.2 倍，隔离后发现不在生成码里，而在
 *    **`Array.prototype.filter` 的回调中介**：
 *      同一个谓词，手动内联循环  0.180ms（比手写还快）
 *      同一个谓词，过 filter()    0.543ms（慢 3 倍）
 *
 *    所以正解不是把谓词写得更漂亮，而是**根本不回调** ——
 *    WHERE 的判定语句直接生成在 for 循环体内。
 *
 * ## NULL 语义（与 SQL 三值逻辑一致）
 *   - 算术/比较任一操作数为 NULL → NULL
 *   - WHERE 里 NULL 一律当假（UNKNOWN 不匹配）
 *   - IS NULL / IS NOT NULL / COALESCE 显式处理 NULL
 */

const { pickIndexableConjunct } = require('./index-store');

/** 生成注入给生成码的候选查找函数 */
function makeCandFinder(indexes) {
  return function _ixcand(field, op, value) {
    const ix = indexes.get(field);
    if (!ix) return null;
    return ix.candidates(op, value);
  };
}

/** LIKE → RegExp（编译一次，运行期只 test） */
function likeToRegExp(pat) {
  const esc = String(pat).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*').replace(/_/g, '.');
  return new RegExp('^' + esc + '$', 'i');
}

/** 标量函数：编译期内联 */
function emitCall(fn, a) {
  switch (fn) {
    case 'upper': return `String(${a[0]}).toUpperCase()`;
    case 'lower': return `String(${a[0]}).toLowerCase()`;
    case 'length': return `String(${a[0]}).length`;
    case 'trim': return `String(${a[0]}).trim()`;
    case 'abs': return `Math.abs(${a[0]})`;
    case 'floor': return `Math.floor(${a[0]})`;
    case 'ceil': return `Math.ceil(${a[0]})`;
    case 'sqrt': return `Math.sqrt(${a[0]})`;
    case 'round': {
      const d = a[1] || '0';
      return `((${d}) === 0 ? Math.round(${a[0]}) : Math.round((${a[0]}) * 10 ** (${d})) / 10 ** (${d}))`;
    }
    case 'coalesce': return a.map(x => `${x} != null ? ${x} : `).join('') + 'null';
    case 'concat': return a.map(x => `String(${x})`).join(' + ');
    case 'substr': case 'substring':
      return `String(${a[0]}).substring((${a[1]}) - 1${a[2] ? `, (${a[1]}) - 1 + (${a[2]})` : ''})`;
    default: return null;
  }
}

const KNOWN_FNS = new Set(['upper', 'lower', 'length', 'trim', 'abs', 'floor', 'ceil',
  'sqrt', 'round', 'coalesce', 'concat', 'substr', 'substring']);

/** 这些函数本身就是用来处理 NULL 的，不做 NULL 传播 */
const NULL_TOLERANT_FNS = new Set(['coalesce']);

/** 语句发射器：每个子表达式求值一次并存入临时变量 */
class Emitter {
  constructor() {
    this.body = [];
    this.regexes = [];
    this.sets = [];
    this._n = 0;
    this._usesLike = false;
  }
  tmp() { return '_v' + (this._n++); }
  push(s) { this.body.push(s); }

  /** 发射「值」表达式，返回存放结果的变量名（或内联常量） */
  emit(node) {
    switch (node.k) {
      case 'lit': {
        if (node.v === null) return 'null';
        if (typeof node.v === 'number' || typeof node.v === 'boolean') return String(node.v);
        return JSON.stringify(node.v);
      }
      case 'path': return this.emitPath(node);
      case 'idx': {
        const o = this.emit(node.obj);
        const i = this.emit(node.idx);
        const t = this.tmp();
        this.push(`let ${t} = (${o} == null ? null : ${o}[Number(${i})]);`);
        return t;
      }
      case 'neg': {
        const e = this.emit(node.e);
        const t = this.tmp();
        this.push(`let ${t} = (${e} == null ? null : -(${e}));`);
        return t;
      }
      case 'bin': return this.emitBin(node);
      case 'log': {
        const l = this.emitBool(node.l);
        const r = this.emitBool(node.r);
        const t = this.tmp();
        this.push(`let ${t} = ${l} ${node.op === 'and' ? '&&' : '||'} ${r};`);
        return t;
      }
      case 'not': {
        const e = this.emitBool(node.e);
        const t = this.tmp();
        this.push(`let ${t} = !${e};`);
        return t;
      }
      case 'isnull': {
        const e = this.emit(node.e);
        const t = this.tmp();
        this.push(`let ${t} = ${node.neg ? `(${e} !== null && ${e} !== undefined)` : `(${e} === null || ${e} === undefined)`};`);
        return t;
      }
      case 'in': return this.emitIn(node);
      case 'between': {
        const v = this.emit(node.e);
        const lo = this.emit(node.lo);
        const hi = this.emit(node.hi);
        const t = this.tmp();
        this.push(`let ${t} = (${v} == null ? null : (${v} >= ${lo} && ${v} <= ${hi}));`);
        return t;
      }
      case 'like': {
        const v = this.emit(node.e);
        const t = this.tmp();
        if (node.p.k === 'lit') {
          const name = '_re' + this.regexes.length;
          this.regexes.push({ name, re: likeToRegExp(node.p.v) });
          this.push(`let ${t} = (typeof ${v} !== 'string' ? null : ${name}.test(${v}));`);
        } else {
          const p = this.emit(node.p);
          this._usesLike = true;
          this.push(`let ${t} = (typeof ${v} !== 'string' ? null : _like(${p}).test(${v}));`);
        }
        return t;
      }
      case 'call': {
        const args = node.args.map(a => this.emit(a));
        const inner = emitCall(node.fn, args);
        if (inner === null) throw new Error(`XQL: 未知函数 ${node.fn}()`);
        const t = this.tmp();
        // NULL 传播：任一参数为 NULL → NULL。
        // 例外：COALESCE / IFNULL 天生就是用来吃 NULL 的，不能传播。
        if (NULL_TOLERANT_FNS.has(node.fn)) {
          this.push(`let ${t} = (${inner});`);
        } else {
          this.push(`let ${t} = (${args.map(a => `${a} == null`).join(' || ')} ? null : (${inner}));`);
        }
        return t;
      }
      case 'agg': throw new Error(`XQL: 聚合函数 ${node.fn} 只能出现在 SELECT / HAVING 中`);
      case 'star': return 'undefined';
      default: throw new Error(`XQL: 无法编译的节点 '${node.k}'`);
    }
  }

  emitBin(node) {
    const l = this.emit(node.l);
    const r = this.emit(node.r);
    const t = this.tmp();
    switch (node.op) {
      case '+': this.push(`let ${t} = (${l} == null || ${r} == null ? null : ${l} + ${r});`); break;
      case '-': this.push(`let ${t} = (${l} == null || ${r} == null ? null : ${l} - ${r});`); break;
      case '*': this.push(`let ${t} = (${l} == null || ${r} == null ? null : ${l} * ${r});`); break;
      case '/': this.push(`let ${t} = (${l} == null || ${r} == null || Number(${r}) === 0 ? null : ${l} / ${r});`); break;
      case '%': this.push(`let ${t} = (${l} == null || ${r} == null || Number(${r}) === 0 ? null : ${l} % ${r});`); break;
      case '=': this.push(`let ${t} = (${l} == null ? null : ${l} === ${r});`); break;
      case '!=': this.push(`let ${t} = (${l} == null ? null : ${l} !== ${r});`); break;
      case '<': this.push(`let ${t} = (${l} == null || ${r} == null ? null : ${l} < ${r});`); break;
      case '>': this.push(`let ${t} = (${l} == null || ${r} == null ? null : ${l} > ${r});`); break;
      case '<=': this.push(`let ${t} = (${l} == null || ${r} == null ? null : ${l} <= ${r});`); break;
      case '>=': this.push(`let ${t} = (${l} == null || ${r} == null ? null : ${l} >= ${r});`); break;
      default: throw new Error(`XQL: 未知二元操作符 '${node.op}'`);
    }
    return t;
  }

  emitIn(node) {
    const v = this.emit(node.e);
    const t = this.tmp();
    const not = node.neg ? '!' : '';
    const join = node.neg ? ' && ' : ' || ';
    if (node.list.every(n => n.k === 'lit')) {
      const name = '_set' + this.sets.length;
      this.sets.push({ name, set: new Set(node.list.map(n => n.v)) });
      this.push(`let ${t} = (${v} == null ? null : ${not}${name}.has(${v}));`);
    } else {
      const parts = node.list.map(n => `(${v} != null && ${v} === ${this.emit(n)})`);
      this.push(`let ${t} = (${v} == null ? null : ${not}(${parts.join(join)}));`);
    }
    return t;
  }

  /**
   * 点号路径。**必须存临时变量**：父节点会把操作数用两遍，
   * 内联会让 `r["age"]` 每行求值两次（第二版就是这么栽的）。
   */
  emitPath(node) {
    let expr = node.base ? this.emit(node.base) : 'r';
    for (const seg of node.segs) {
      const t = this.tmp();
      this.push(`let ${t} = (${expr} == null ? undefined : ${expr}[${JSON.stringify(seg)}]);`);
      expr = t;
    }
    return expr;
  }

  /** 发射「布尔」表达式，返回变量名；NULL 一律当假 */
  emitBool(node) {
    switch (node.k) {
      case 'lit': return `${JSON.stringify(node.v)} === true`;
      case 'log': {
        const l = this.emitBool(node.l);
        const r = this.emitBool(node.r);
        const t = this.tmp();
        this.push(`let ${t} = ${l} ${node.op === 'and' ? '&&' : '||'} ${r};`);
        return t;
      }
      case 'not': {
        // NOT 保留三值逻辑：NOT UNKNOWN = UNKNOWN（WHERE 里当假），不是 TRUE。
        //   true  → false / false → true / null → false
        // 走 emit（值路径）而不是 emitBool —— 后者已经把 NULL 压成 false，
        // 那样就分不清「原来是 FALSE」和「原来是 UNKNOWN」。
        const e = this.emit(node.e);
        const t = this.tmp();
        this.push(`let ${t} = (${e} === true ? false : ${e} === false);`);
        return t;
      }
      case 'isnull': {
        const e = this.emit(node.e);
        const t = this.tmp();
        this.push(`let ${t} = ${node.neg ? `(${e} !== null && ${e} !== undefined)` : `(${e} === null || ${e} === undefined)`};`);
        return t;
      }
      case 'bin': {
        // 比较：NULL → false，直接产布尔（不走「三值再 === true」，省一条 let）
        if (['=', '!=', '<', '>', '<=', '>='].includes(node.op)) {
          const l = this.emit(node.l);
          const r = this.emit(node.r);
          const t = this.tmp();
          const op = node.op === '=' ? '===' : node.op;
          this.push(`let ${t} = ${l} != null && ${r} != null && ${l} ${op} ${r};`);
          return t;
        }
        const v = this.emit(node);
        const t = this.tmp();
        this.push(`let ${t} = ${v} === true;`);
        return t;
      }
      case 'in': {
        // NOT IN 的三值逻辑比较绕：
        //   匹配上了        → FALSE
        //   没匹配上        → 列表含 NULL 时 UNKNOWN（WHERE 里当假），否则 TRUE
        //   被查找值为 NULL → UNKNOWN
        if (node.neg) {
          const v = this.emit(node.e);
          const hasNullInList = node.list.some(n => n.k === 'lit' && n.v === null);
          if (node.list.every(n => n.k === 'lit')) {
            const name = '_set' + this.sets.length;
            this.sets.push({ name, set: new Set(node.list.map(n => n.v)) });
            const t = this.tmp();
            this.push(`let ${t} = (${v} != null && !${name}.has(${v})${hasNullInList ? ' && false' : ''});`);
            return t;
          }
          const parts = node.list.map(n => `(${v} != null && ${v} === ${this.emit(n)})`);
          const t = this.tmp();
          this.push(`let ${t} = (${v} != null && !(${parts.join(' || ')})${hasNullInList ? ' && false' : ''});`);
          return t;
        }
        const v = this.emit(node);
        const t = this.tmp();
        this.push(`let ${t} = ${v} === true;`);
        return t;
      }
      default: {
        const v = this.emit(node);
        const t = this.tmp();
        this.push(`let ${t} = ${v} === true;`);
        return t;
      }
    }
  }

  /** 收尾：语句缓冲 + 返回值 → 函数 */
  build(param, resultVar, extraParams = []) {
    const names = [];
    const vals = [];
    for (const r of this.regexes) { names.push(r.name); vals.push(r.re); }
    for (const s of this.sets) { names.push(s.name); vals.push(s.set); }
    if (this._usesLike) { names.push('_like'); vals.push(likeToRegExp); }
    const src = `"use strict";\n${this.body.map(s => '  ' + s).join('\n')}\n  return ${resultVar};`;
    // eslint-disable-next-line no-new-func
    const factory = new Function(...names, `return function (${[param, ...extraParams].join(', ')}) {\n${src}\n};`);
    return factory(...vals);
  }
}

/** 没写别名时的默认列名 */
function defaultAlias(expr) {
  switch (expr.k) {
    case 'path': return expr.segs.join('.');
    case 'lit': return String(expr.v);
    case 'call': return expr.fn;
    case 'bin': return `${defaultAlias(expr.l)}${expr.op}${defaultAlias(expr.r)}`;
    case 'idx': return `${defaultAlias(expr.obj)}[${expr.idx.k === 'lit' ? expr.idx.v : ''}]`;
    default: return 'expr';
  }
}

const CMP_OPS = new Set(['=', '!=', '<', '>', '<=', '>=']);

/**
 * 编译整条查询 → (rows) => resultRows
 *
 * **整条管道生成一个函数**：WHERE 的判定语句直接内联在 for 循环体内，
 * 不经过 Array.filter 的回调（实测那一道中介要付 3 倍）。
 * SELECT 的每列投影、ORDER BY 的每个排序键是独立编译的小函数，
 * 作为参数注入主管道 —— 它们不在最热路径上，换来的是可读性。
 */
function compileQuery(q, opts = {}) {
  const copy = !!opts.copy;
  // ---- SELECT：每列编译成一个投影函数 ----
  let project = null;
  if (q.select && !q.select.some(s => s.expr.k === 'star')) {
    // 只记录「别名 + 表达式」，编译留到主管道里内联完成
    project = q.select.map(s => ({
      expr: s.expr,
      alias: s.alias || defaultAlias(s.expr),
    }));
  }

  // ---- ORDER BY：每个排序键编译成一个取值函数 ----
  const orderBy = q.orderBy
    ? q.orderBy.map(o => {
      const e = new Emitter();
      const v = e.emit(o.expr);
      return { fn: e.build('r', v), dir: o.dir === 'desc' ? -1 : 1 };
    })
    : null;

  // ---- 主管道 ----
  const e = new Emitter();
  const B = e.body;

  // 1) WHERE —— 内联进循环，零回调
  //
  //    有索引时走「候选 + 谓词确认」：索引只负责缩小要看的行，
  //    最终判定仍然由完整谓词做 —— 所以索引给多给少都不会算错。
  const cand = opts.indexes ? pickIndexableConjunct(q.where) : null;
  let candField = null;
  if (cand && opts.indexes.has(cand.field)) {
    const ix = opts.indexes.get(cand.field);
    // 索引类型要匹配操作符：等值用 hash，范围用 sorted
    const fits = cand.op === '=' || cand.op === '!='
      ? ix.type === 'hash' || ix.type === 'range'
      : ix.type === 'range';
    if (fits) candField = cand;
  }

  B.push('  let _out = [];');
  const allEmitters = [e];

  if (candField) {
    // 索引路径与全扫路径各编译一份谓词 —— temp 变量名不能跨分支复用
    const eIdx = new Emitter();
    const predIdx = eIdx.emitBool(q.where);
    const eScan = new Emitter();
    const predScan = eScan.emitBool(q.where);
    allEmitters.push(eIdx, eScan);

    B.push(`  const _cand = _ixcand(${JSON.stringify(candField.field)}, ${JSON.stringify(candField.op)}, ${JSON.stringify(candField.value)});`);
    B.push('  if (_cand !== null) {');
    B.push('    for (let _i = 0; _i < _cand.length; _i++) {');
    B.push('      const r = rows[_cand[_i]];');
    B.push(...eIdx.body);
    B.push(`      if (${predIdx}) _out.push(r);`);
    B.push('    }');
    B.push('  } else {');
    B.push('    for (let _i = 0; _i < rows.length; _i++) {');
    B.push('      const r = rows[_i];');
    B.push(...eScan.body);
    B.push(`      if (${predScan}) _out.push(r);`);
    B.push('    }');
    B.push('  }');
  } else if (q.where) {
    B.push('  for (let _i = 0; _i < rows.length; _i++) {');
    B.push('    const r = rows[_i];');
    const predVar = e.emitBool(q.where);
    B.push(`    if (${predVar}) _out.push(r);`);
    B.push('  }');
  } else {
    B.push('  for (let _i = 0; _i < rows.length; _i++) _out.push(rows[_i]);');
  }

  // 2) SELECT —— 与 WHERE 同理，投影语句也内联进循环。
  //    每列调一次函数的话，6.8 万行 × 2 列就是 13.6 万次调用，
  //    实测占掉整个管道的大半时间（2.81 倍差距主要来自这里）。
  if (project) {
    B.push('  const _res = new Array(_out.length);');
    B.push('  for (let _j = 0; _j < _out.length; _j++) {');
    B.push('    const r = _out[_j];');
    B.push('    const o = {};');
    for (const p of project) {
      const v = e.emit(p.expr);
      B.push(`    o[${JSON.stringify(p.alias)}] = ${v};`);
    }
    B.push('    _res[_j] = o;');
    B.push('  }');
    B.push('  _out = _res;');
  } else {
    // 无投影。默认**不拷贝**，直接返回内部行的引用 ——
    // 实测：命中 7.2 万行时逐行展开对象要占掉整个查询的大半时间
    // （OR 查询 5.7 倍差距主要来自这里）。需要防调用方改内部数据的话，
    // 用 xql(sql, { copy: true }) 显式打开。
    if (copy) {
      B.push('  const _cp = new Array(_out.length);');
      B.push('  for (let _k = 0; _k < _out.length; _k++) _cp[_k] = { ..._out[_k] };');
      B.push('  _out = _cp;');
    }
  }

  const limit = q.limit;
  const offset = q.offset || 0;

  // 3) ORDER BY
  if (orderBy) {
    // 每个排序键一个块。注意不能用 continue —— 块级作用域里没有循环可继续，
    // 改成 if 包裹。
    //
    // 字符串用 < / > 而不是 localeCompare：后者是 locale 感知的排序，
    // 6.8 万行排序要调 ~110 万次，实测比朴素比较多一个量级
    // （这一项就是从 2.93 倍降到持平的关键）。
    const cmp = orderBy.map((o, i) => `    { const av = _ok${i}(a), bv = _ok${i}(b);
      if (av !== bv) {
        if (av === null || av === undefined) return -1 * ${o.dir};
        if (bv === null || bv === undefined) return 1 * ${o.dir};
        const d = (typeof av === 'number' && typeof bv === 'number') || (typeof av === 'boolean' && typeof bv === 'boolean')
          ? (av < bv ? -1 : 1)
          : (String(av) < String(bv) ? -1 : 1);
        if (d !== 0) return d * ${o.dir};
      } }`).join('\n');
    B.push('  _out.sort((a, b) => {\n' + cmp + '\n    return 0;\n  });');
  }

  // 4) OFFSET / LIMIT
  if (offset || (limit !== null && limit !== undefined)) {
    const end = (limit === null || limit === undefined) ? 'undefined' : String(offset + limit);
    B.push(`  _out = _out.slice(${offset}, ${end});`);
  }

  // ---- 组装 ----
  const injectNames = [];
  const injectVals = [];
  if (orderBy) for (let i = 0; i < orderBy.length; i++) { injectNames.push('_ok' + i); injectVals.push(orderBy[i].fn); }

  // 索引候选查找：返回候选行下标数组；返回 null 表示「这条查询用不上索引」，
  // 由生成码里那条 else 分支走全表扫。
  if (candField) {
    injectNames.push('_ixcand');
    injectVals.push(makeCandFinder(opts.indexes));
  }

  // 正则 / Set 收集 —— 索引路径与全扫路径的 emitter 也要算进来
  for (const em of allEmitters) {
    for (const r of em.regexes) { injectNames.push(r.name); injectVals.push(r.re); }
    for (const s of em.sets) { injectNames.push(s.name); injectVals.push(s.set); }
    if (em._usesLike) { injectNames.push('_like'); injectVals.push(likeToRegExp); }
  }

  const src = `"use strict";\n${e.body.join('\n')}\n  return _out;`;
  // eslint-disable-next-line no-new-func
  const factory = new Function('rows', ...injectNames, src);
  const run = (...args) => factory(args[0], ...injectVals, ...args.slice(1));
  run.__source = q.source;
  return run;
}

module.exports = { compileQuery, likeToRegExp, defaultAlias, KNOWN_FNS, Emitter };
