'use strict';
/**
 * 列存的向量化快路径 —— 纯函数，不依赖 SQLExecutor，便于单测。
 *
 * 输入是 `Table._columnar`（{ names, cols: Map<col, array[]>, rowCount }），
 * 输出是 SELECT 结果骨架；返回 null 表示「这条查询不适用快路径」，
 * 由调用方走通用行路径。
 */

/** AST 节点 → 列名；非简单列引用返回 null。 */
function colNameOf(node) {
  if (!node) return null;
  if (typeof node === 'string') return node;
  return node.type === 'column' ? node.name : null;
}

/**
 * 把 WHERE 编译成「命中行下标数组」。
 * 只支持 `列 OP 字面量` 以及它们的 AND 组合；其它（OR / LIKE / 函数 / 子查询 /
 * 列与列比较）一律返回 null，交给通用路径 —— 宁可慢，不可错。
 */
function whereIndices(statement, data) {
  const w = statement.where;
  if (!w) return null;
  const build = (node) => {
    if (!node) return null;
    if (node.type === 'and') {
      const l = build(node.left), r = build(node.right);
      if (!l || !r) return null;
      return { and: [l, r] };
    }
    if (node.type === 'or') {
      const l = build(node.left), r = build(node.right);
      if (!l || !r) return null;
      return { or: [l, r] };
    }
    if (node.type === 'compare') {
      const col = colNameOf(node.left);
      if (!col || !node.right || node.right.type !== 'value') return null;
      const arr = data.cols.get(col);
      if (!arr) return null;
      return { arr, op: node.op, val: node.right.value };
    }
    return null;
  };
  const root = build(w);
  if (!root) return null;

  const n = data.rowCount;
  const idx = new Uint32Array(n);
  let m = 0;
  const test = (x, op, v) => {
    switch (op) {
      case '=': return x === v;
      case '!=': case '<>': return x !== v;
      case '>': return x > v;
      case '>=': return x >= v;
      case '<': return x < v;
      case '<=': return x <= v;
      default: return false;
    }
  };
  const hit = (node, i) => {
    if (node.and) return hit(node.and[0], i) && hit(node.and[1], i);
    if (node.or) return hit(node.or[0], i) || hit(node.or[1], i);
    return test(node.arr[i], node.op, node.val);
  };
  for (let i = 0; i < n; i++) if (hit(root, i)) idx[m++] = i;
  return idx.subarray(0, m);
}

/**
 * 纯聚合（无 GROUP BY / HAVING / DISTINCT / LIMIT）。
 * 直接扫列数组，不构造任何行对象。
 */
function aggregate(statement, data) {
  const cols = statement.columns || [];
  if (!cols.length) return null;
  if (statement.groupBy || statement.having || statement.distinct) return null;
  if (statement.limit != null && statement.limit !== Infinity) return null;

  const indices = statement.where ? whereIndices(statement, data) : null;
  if (statement.where && !indices) return null;
  const scanLen = indices ? indices.length : data.rowCount;
  const at = (k) => (indices ? indices[k] : k);

  const outRow = [];
  const outCols = [];
  for (const c of cols) {
    if (!c || !c.aggregate) return null;
    // COUNT(DISTINCT x) / SUM(DISTINCT x) 需要去重，快路径不实现 → 退回通用路径。
    // 漏这条会让 COUNT(DISTINCT age) 直接返回行数（静默错值）。
    if (c.distinct) return null;
    const fn = String(c.aggregate).toUpperCase();
    const argNode = c.column;
    const argName = colNameOf(argNode);
    if (argNode != null && !argName) return null;
    const values = argName ? data.cols.get(argName) : null;
    if (argName && !values) return null;

    let v;
    switch (fn) {
      case 'COUNT': {
        if (!argName) { v = scanLen; break; }
        let n = 0;
        for (let k = 0; k < scanLen; k++) {
          const x = values[at(k)];
          if (x !== null && x !== undefined) n++;
        }
        v = n;
        break;
      }
      case 'SUM': {
        let s = 0, seen = false;
        for (let k = 0; k < scanLen; k++) {
          const x = values[at(k)];
          if (x === null || x === undefined) continue;
          if (typeof x !== 'number') return null;   // BigInt 等 → 通用路径
          s += x; seen = true;
        }
        v = seen ? s : null;
        break;
      }
      case 'AVG': {
        let s = 0, n = 0;
        for (let k = 0; k < scanLen; k++) {
          const x = values[at(k)];
          if (x === null || x === undefined) continue;
          if (typeof x !== 'number') return null;
          s += x; n++;
        }
        v = n ? s / n : null;
        break;
      }
      case 'MIN': case 'MAX': {
        let best, seen = false;
        for (let k = 0; k < scanLen; k++) {
          const x = values[at(k)];
          if (x === null || x === undefined) continue;
          if (typeof x !== 'number' && typeof x !== 'string') return null;
          if (!seen) { best = x; seen = true; }
          else if (fn === 'MIN' ? x < best : x > best) best = x;
        }
        v = seen ? best : null;
        break;
      }
      default: return null;
    }
    outRow.push(v);
    outCols.push(c.alias || (fn + '()'));
  }
  return { type: 'select', columns: outCols, rows: [outRow] };
}

/**
 * 单列 GROUP BY + 聚合。
 *
 * 条件：GROUP BY 恰好一列、投影 = 该分组列 + COUNT/SUM/AVG/MIN/MAX、
 * 无 HAVING / DISTINCT / LIMIT。命中时扫一遍分组列建桶，再输出每组的聚合值，
 * 全程不构造行对象。
 *
 * 注意输出顺序是「分组值首次出现的顺序」，不保证与通用路径一致 ——
 * 需要确定性顺序请加 ORDER BY（那样会退回通用路径）。
 */
function groupBy(statement, data) {
  const g = statement.groupBy;
  if (!Array.isArray(g) || !g.length) return null;
  if (statement.having || statement.distinct) return null;
  if (statement.limit != null) return null;
  const gNames = g.map(colNameOf);
  if (gNames.some(n => !n)) return null;
  const keyArrs = gNames.map(n => data.cols.get(n));
  if (keyArrs.some(a => !a)) return null;

  const cols = statement.columns || [];
  if (!cols.length) return null;
  const aggs = [];
  let sawGroupCol = false;
  for (const c of cols) {
    if (c && c.aggregate) {
      // 同 aggregate：DISTINCT 聚合不适用快路径
      if (c.distinct) return null;
      const fn = String(c.aggregate).toUpperCase();
      if (!['COUNT', 'SUM', 'AVG', 'MIN', 'MAX'].includes(fn)) return null;
      const argName = colNameOf(c.column);
      if (c.column != null && !argName) return null;
      const arr = argName ? data.cols.get(argName) : null;
      if (argName && !arr) return null;
      aggs.push({ c, fn, argName, arr });
      continue;
    }
    const n = colNameOf(c && (c.scalar || c.expr));
    if (!gNames.includes(n)) return null;
    sawGroupCol = true;
  }
  if (!sawGroupCol) return null;

  const indices = statement.where ? whereIndices(statement, data) : null;
  if (statement.where && !indices) return null;
  const scanLen = indices ? indices.length : data.rowCount;
  const at = (k) => (indices ? indices[k] : k);

  // 分组的键多数是数字或短字符串，用 Map 即可；每组一个累加器数组。
  const groups = new Map();
  const nKeys = keyArrs.length;
  for (let k = 0; k < scanLen; k++) {
    const i = at(k);
    // 多列分组键：用 \u0000 拼接（SQL 字符串列不会包含 NUL），Map 里只存这个串。
    let ck = '';
    for (let q = 0; q < nKeys; q++) ck += (q ? '\u0000' : '') + String(keyArrs[q][i]);
    let entry = groups.get(ck);
    if (!entry) {
      entry = {
        keyVals: keyArrs.map(a => a[i]),
        acc: aggs.map(() => ({ n: 0, s: 0, best: undefined, seen: false })),
      };
      groups.set(ck, entry);
    }
    const acc = entry.acc;
    for (let j = 0; j < aggs.length; j++) {
      const a = aggs[j], st = acc[j];
      if (a.fn === 'COUNT') {
        if (!a.argName) { st.n++; continue; }
        const x = a.arr[i];
        if (x !== null && x !== undefined) st.n++;
        continue;
      }
      const x = a.arr[i];
      if (x === null || x === undefined) continue;
      if (typeof x !== 'number') return null;   // BigInt 等 → 通用路径
      st.n++; st.s += x;
      if (!st.seen) { st.best = x; st.seen = true; }
      else if (a.fn === 'MIN' ? x < st.best : x > st.best) st.best = x;
    }
  }

  const outRows = [];
  for (const [, entry] of groups) {
    const row = [];
    for (const c of cols) {
      if (c.aggregate) {
        const j = aggs.findIndex(a => a.c === c);
        const st = entry.acc[j];
        const fn = String(c.aggregate).toUpperCase();
        if (fn === 'COUNT') row.push(st.n);
        else if (fn === 'SUM') row.push(st.seen ? st.s : null);
        else if (fn === 'AVG') row.push(st.n ? st.s / st.n : null);
        else row.push(st.seen ? st.best : null);
      } else {
        const n = colNameOf(c.scalar || c.expr);
        row.push(entry.keyVals[gNames.indexOf(n)]);
      }
    }
    outRows.push(row);
  }
  const outCols = cols.map(c => c.alias || (c.aggregate
    ? String(c.aggregate).toUpperCase() + '()'
    : colNameOf(c.scalar || c.expr)));
  return { type: 'select', columns: outCols, rows: outRows };
}

module.exports = { colNameOf, whereIndices, aggregate, groupBy };
