/**
 * lib/ast.js — JSQL-NEO AST 访问与改写
 *
 * parseSQL() 返回的是普通 JS 对象树。本模块提供在不了解每种节点类型的
 * 前提下遍历 / 查找 / 改写这棵树的能力：
 *
 *   walk(ast, visitor[, opts])   深度优先遍历（前序 + 可选后序）
 *   collect(ast, predicate)      收集所有满足条件的节点
 *   find(ast, predicate)         返回第一个满足条件的节点
 *   transform(ast, fn)           不可变改写，返回新树
 *   rewrite(ast, fn)             原地改写
 *   tables(ast)                  列出语句引用的所有表名
 *   columns(ast)                 列出语句引用的所有列名
 *   StatementVisitor             基类，按节点类型分派 visitXxx 方法
 *
 * 设计约定：
 *  - 「节点」指带字符串 type 字段的对象；但遍历会穿透所有普通对象与数组，
 *    因为 SELECT 列描述符（{ expr, scalar, alias }）这类中间结构没有 type。
 *  - seen 集合防止共享子树被重复访问或死循环。
 *  - transform 返回新树、不改入参；rewrite 原地修改。
 */

const SKIP_KEYS = new Set(['pos']);

function isNode(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v) && typeof v.type === 'string';
}

function childKeys(obj) {
  const out = [];
  for (const k of Object.keys(obj)) if (!SKIP_KEYS.has(k)) out.push(k);
  return out;
}

/** 深度优先遍历。visitor(node, parent, key) 返回 false 可跳过该子树。 */
function walk(ast, visitor, opts = {}) {
  const seen = new Set();
  const post = opts.post || null;
  const fn = typeof visitor === 'function' ? visitor : null;

  const visit = (value, parent, key) => {
    if (value === null || typeof value !== 'object') return;
    if (seen.has(value)) return;
    seen.add(value);

    if (Array.isArray(value)) {
      for (const item of value) visit(item, parent, key);
      return;
    }

    const node = isNode(value);
    let descend = true;
    if (node && fn) {
      const r = fn(value, parent, key);
      if (r === false) descend = false;
    }
    if (descend) {
      for (const k of childKeys(value)) visit(value[k], value, k);
    }
    if (node && post) post(value, parent, key);
  };

  if (Array.isArray(ast)) { for (const n of ast) visit(n, null, null); }
  else visit(ast, null, null);
  return ast;
}

/** 收集所有满足 predicate 的节点。 */
function collect(ast, predicate) {
  const out = [];
  walk(ast, (node) => { if (predicate(node)) out.push(node); });
  return out;
}

/** 返回第一个满足 predicate 的节点，找不到返回 null。 */
function find(ast, predicate) {
  let hit = null;
  walk(ast, (node) => {
    if (hit) return false;
    if (predicate(node)) { hit = node; return false; }
  });
  return hit;
}

function cloneValue(v, seen) {
  if (v === null || typeof v !== 'object') return v;
  if (seen.has(v)) return v;
  seen.add(v);
  if (Array.isArray(v)) return v.map(x => cloneValue(x, seen));
  const out = {};
  for (const k of Object.keys(v)) out[k] = cloneValue(v[k], seen);
  return out;
}

function cloneNode(node) { return cloneValue(node, new Set()); }

/**
 * 不可变改写：对每个节点调用 fn(node)，返回值非 undefined 时替换该节点。
 * 返回新树，入参保持不变。
 */
function transform(ast, fn) {
  const seen = new Set();

  const visit = (value) => {
    if (value === null || typeof value !== 'object') {
      const r = fn(value);
      return r === undefined ? value : r;
    }
    if (seen.has(value)) return value;
    seen.add(value);

    if (Array.isArray(value)) {
      const arr = value.map(visit);
      const rep = fn(arr);
      return rep === undefined ? arr : rep;
    }

    const out = {};
    for (const k of Object.keys(value)) out[k] = visit(value[k]);

    if (isNode(value)) {
      const rep = fn(out);
      return rep === undefined ? out : rep;
    }
    return out;
  };

  return visit(ast);
}

/** 原地改写：fn(node) 返回值非 undefined 时替换原节点。 */
function rewrite(ast, fn) {
  const seen = new Set();

  const visit = (value, parent, key, index) => {
    if (value === null || typeof value !== 'object') {
      if (parent && key) {
        const r = fn(value);
        if (r !== undefined) {
          if (index === undefined) parent[key] = r; else parent[key][index] = r;
        }
      }
      return;
    }
    if (seen.has(value)) return;
    seen.add(value);

    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) visit(value[i], parent, key, i);
      return;
    }

    for (const k of childKeys(value)) visit(value[k], value, k);

    if (isNode(value) && parent && key) {
      const r = fn(value);
      if (r !== undefined) {
        if (index === undefined) parent[key] = r; else parent[key][index] = r;
      }
    }
  };

  visit(ast, null, null);
  return ast;
}

/** 语句引用的所有表名（含 JOIN / 子查询）。 */
function tables(ast) {
  const out = new Set();
  walk(ast, (node) => {
    if (node.type === 'select' && node.from) {
      for (const t of (node.from.tables || [])) if (t && t.table) out.add(t.table);
      for (const j of (node.from.joins || [])) if (j.item && j.item.table) out.add(j.item.table);
    }
    if (node.type === 'insert' || node.type === 'update' || node.type === 'delete' ||
        node.type === 'createTable' || node.type === 'dropTable' || node.type === 'truncate') {
      if (node.name) out.add(node.name);
      if (node.table) out.add(node.table);
    }
  });
  return [...out];
}

/** 语句引用的所有列名（去重）。 */
function columns(ast) {
  const out = new Set();
  walk(ast, (node) => {
    if (node.type === 'column' && node.name) out.add(node.name);
  });
  return [...out];
}

/**
 * 按节点类型分派的访问器基类。
 * 子类定义 visitSelect(node) / visitCompare(node) … 即可；未定义类型走 visitDefault。
 *
 *   class MyVisitor extends StatementVisitor {
 *     visitColumn(node) { node.name = String(node.name).toLowerCase(); }
 *   }
 *   new MyVisitor().run(ast);
 */
class StatementVisitor {
  run(ast) {
    walk(ast, (node) => {
      const camel = String(node.type).replace(/(^|[-_])([a-z])/g, (_, __, ch) => ch.toUpperCase());
      const method = this['visit' + camel];
      if (typeof method === 'function') method.call(this, node);
      else if (typeof this.visitDefault === 'function') this.visitDefault(node);
    });
    return ast;
  }
}

module.exports = { walk, collect, find, transform, rewrite, tables, columns, StatementVisitor, isNode, cloneNode };
