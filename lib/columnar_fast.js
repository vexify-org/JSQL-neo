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
    if (node.type === 'in') {
      const col = colNameOf(node.operand);
      if (!col || !Array.isArray(node.list)) return null;
      // 列表里含 NULL / 非标量时语义变复杂（NULL IN (...) 是 UNKNOWN），交回通用路径。
      if (node.list.some(v => v === null || v === undefined || typeof v === 'object')) return null;
      const arr = data.cols.get(col);
      if (!arr) return null;
      return { arr, inList: node.list, not: !!node.not };
    }
    if (node.type === 'between') {
      const col = colNameOf(node.operand);
      if (!col) return null;
      const lo = node.low && node.low.type === 'value' ? node.low.value : undefined;
      const hi = node.high && node.high.type === 'value' ? node.high.value : undefined;
      if (lo === undefined || hi === undefined) return null;
      const arr = data.cols.get(col);
      if (!arr) return null;
      return { arr, between: [lo, hi], not: !!node.not };
    }
    if (node.type === 'isNull') {
      const col = colNameOf(node.operand);
      if (!col) return null;
      const arr = data.cols.get(col);
      if (!arr) return null;
      return { arr, isNull: true, not: !!node.not };
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
    const x = node.arr[i];
    if (node.inList) {
      // NULL IN (...) / NULL NOT IN (...) 都是 UNKNOWN → 不命中
      if (x === null || x === undefined) return false;
      const found = node.inList.indexOf(x) >= 0;
      return node.not ? !found : found;
    }
    if (node.between) {
      // NULL 在 BETWEEN 里是 UNKNOWN → 正向/反向都不命中
      if (x === null || x === undefined) return false;
      const okRange = x >= node.between[0] && x <= node.between[1];
      return node.not ? !okRange : okRange;
    }
    if (node.isNull) {
      const isn = x === null || x === undefined;
      return node.not ? !isn : isn;
    }
    // #261：裸比较符必须走 SQL 三值逻辑。
    // 任一操作数为 NULL 时结果是 UNKNOWN → WHERE 中不命中。
    // 此前直接 test(x, op, v)：`null !== 'a'` 为 true（NULL 行被误命中），
    // `null === null` 也会命中 —— 与行存通用路径结果不一致。
    if (x === null || x === undefined) return false;
    if (node.val === null || node.val === undefined) return false;
    return test(x, node.op, node.val);
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
  // ORDER BY 只支持单个键（多键交给通用路径，避免排序规则漂移）
  if (statement.orderBy && statement.orderBy.length !== 1) return null;
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
  const nKeys = keyArrs.length;

  // 分组容器：单列整数键且落在 [0, 65535] 时用数组桶 —— 10 万行 × 50 组的
  // 基准里，Map.get/set 的哈希开销占了 GROUP BY 的大头。多列或非整数键
  // 退回 Map，行为不变。
  let bucket = null;
  if (nKeys === 1) {
    let maxKey = -1;
    let usable = true;
    for (let k = 0; k < scanLen; k++) {
      const v = keyArrs[0][at(k)];
      if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > 65535) { usable = false; break; }
      if (v > maxKey) maxKey = v;
    }
    if (usable) bucket = new Array(maxKey + 1);
  }
  const groups = bucket ? null : new Map();

  for (let k = 0; k < scanLen; k++) {
    const i = at(k);
    let entry;
    if (bucket) {
      const key = keyArrs[0][i];
      entry = bucket[key];
      if (!entry) {
        entry = { keyVals: [key], acc: aggs.map(() => ({ n: 0, s: 0, best: undefined, seen: false })) };
        bucket[key] = entry;
      }
    } else {
      // 多列分组键：用 \u0000 拼接（SQL 字符串列不会包含 NUL），Map 里只存这个串。
      let ck = '';
      for (let q = 0; q < nKeys; q++) {
        const kv = keyArrs[q][i];
        // NULL 分组键交给通用路径：用 String(null) === 'null' 会把 NULL 组和
        // 字符串 'null' 组错误地合并成一组。
        if (kv === null || kv === undefined) return null;
        ck += (q ? '\u0000' : '') + String(kv);
      }
      entry = groups.get(ck);
      if (!entry) {
        entry = {
          keyVals: keyArrs.map(a => a[i]),
          acc: aggs.map(() => ({ n: 0, s: 0, best: undefined, seen: false })),
        };
        groups.set(ck, entry);
      }
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

  const entries = bucket ? bucket.filter(Boolean) : Array.from(groups.values());
  let outRows = [];
  for (const entry of entries) {
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
        // #233：布尔分组键与通用路径的 projectScalar 保持一致（true→1, false→0）
        const gv = entry.keyVals[gNames.indexOf(n)];
        row.push(gv === true ? 1 : gv === false ? 0 : gv);
      }
    }
    outRows.push(row);
  }
  const outCols = cols.map(c => c.alias || (c.aggregate
    ? String(c.aggregate).toUpperCase() + '()'
    : colNameOf(c.scalar || c.expr)));

  // ORDER BY：在分组结果上排序 —— 组数通常远小于行数，代价很低。
  // 只支持按输出列名 / 别名排序；找不到对应列就退回通用路径，
  // 避免两边排序规则（尤其 NULL 位置）出现分叉。
  if (statement.orderBy) {
    const o = statement.orderBy[0];
    const name = typeof o.column === 'string' ? o.column : colNameOf(o.column);
    const idx = name ? outCols.indexOf(name) : -1;
    if (idx < 0) return null;
    const dir = o.dir === 'desc' ? -1 : 1;
    outRows.sort((a, b) => {
      const av = a[idx], bv = b[idx];
      if (av === bv) return 0;
      if (av === null || av === undefined) return -1 * dir;
      if (bv === null || bv === undefined) return 1 * dir;
      const d = (typeof av === 'number' && typeof bv === 'number')
        ? (av < bv ? -1 : 1)
        : (String(av) < String(bv) ? -1 : 1);
      return d * dir;
    });
  }

  // LIMIT / OFFSET：分组后切片（与通用路径语义一致）
  if (statement.offset || statement.limit != null) {
    const off = Number(statement.offset) || 0;
    const end = statement.limit == null ? undefined : off + Number(statement.limit);
    outRows = outRows.slice(off, end);
  }
  return { type: 'select', columns: outCols, rows: outRows };
}

module.exports = { colNameOf, whereIndices, aggregate, groupBy };
