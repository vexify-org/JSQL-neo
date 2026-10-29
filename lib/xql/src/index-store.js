'use strict';
/**
 * XQL 索引
 *
 * 全表扫是「比手写更快」的终点 —— 0.91x 已经贴着理论下限了。
 * 要再快只能**不看那些行**，这就是索引的作用。
 *
 * 两种：
 *   HashIndex   —— 等值查找，O(1)
 *   RangeIndex  —— 范围 / 有序，O(log n + k)
 *
 * 关键约定：**索引只负责给候选，最终判定仍由 WHERE 谓词做**。
 * 所以索引可以是「粗」的（多给候选、少给候选由谓词兜底），
 * 绝不会因为索引有偏差而算错结果。
 */

/** 归一化键：让 1 和 '1'、true 和 'true' 能对上，同时保证可稳定排序 */
function keyOf(v) {
  if (v === null || v === undefined) return v === null ? '\u0000null' : undefined;
  const t = typeof v;
  if (t === 'number' || t === 'string' || t === 'boolean') {
    return t[0] + ':' + String(v);      // 带类型前缀，避免 1 与 '1' 混淆
  }
  return undefined;                     // 对象/数组不建索引
}

function unkey(k) {
  if (k === undefined) return undefined;
  if (k === '\u0000null') return null;
  return k.slice(2);
}

class HashIndex {
  constructor(field) {
    this.field = field;
    this.type = 'hash';
    this.map = new Map();
  }

  build(rows) {
    this.map.clear();
    for (let i = 0; i < rows.length; i++) {
      const k = keyOf(rows[i][this.field]);
      if (k === undefined) continue;
      let a = this.map.get(k);
      if (!a) { a = []; this.map.set(k, a); }
      a.push(i);
    }
    this._builtLen = rows.length;
    return this;
  }

  /** 返回候选行下标；没有索引值时返回 null（调用方退回全扫） */
  candidates(op, value) {
    if (op !== '=' && op !== '!=') return null;
    const a = this.map.get(keyOf(value));
    if (a) return a;
    // `!=` 时索引帮不上：候选应是「不在这些下标里的」，逻辑交给谓词
    return op === '=' ? [] : null;
  }
}

class RangeIndex {
  constructor(field) {
    this.field = field;
    this.type = 'range';
    this.vals = [];        // 原始值，升序（直接按它比，不用字符串键）
    this.idx = [];         // 对应的行下标
  }

  build(rows) {
    const pairs = [];
    for (let i = 0; i < rows.length; i++) {
      const v = rows[i][this.field];
      const k = keyOf(v);
      if (k === undefined) continue;
      pairs.push([v, i]);
    }
    // **必须按原始值排序**：字符串键 "number:5" > "number:48"（字典序），
    // 会把 48 排到 5 后面，范围查询直接给出错误结果。
    pairs.sort(cmpValue);
    this.vals = pairs.map(p => p[0]);
    this.idx = pairs.map(p => p[1]);
    this._builtLen = rows.length;
    return this;
  }

  /** 二分找第一个 >= target 的位置 */
  lowerBound(target) {
    const v = this.vals;
    let lo = 0, hi = v.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cmpScalar(v[mid], target) < 0) lo = mid + 1; else hi = mid;
    }
    return lo;
  }

  /**
   * 返回候选行下标（**按原行号升序**）；用不上索引时返回 null。
   *
   * 命中面太大时不走索引 —— 切片的分配 + 二次遍历比一次扫更贵。
   */
  candidates(op, value) {
    if (keyOf(value) === undefined) return null;
    const n = this.vals.length;
    if (!n) return [];
    let start = 0, end = n;
    if (op === '=') { start = this.lowerBound(value); end = start; while (end < n && cmpScalar(this.vals[end], value) === 0) end++; }
    else if (op === '>') { start = this.lowerBound(value); while (start < n && cmpScalar(this.vals[start], value) === 0) start++; }
    else if (op === '>=') { start = this.lowerBound(value); }
    else if (op === '<') { end = this.lowerBound(value); }
    else if (op === '<=') {
      // 等于 value 的元素在 lowerBound **之后**（它找的是第一个 >= value），
      // 所以要向前扩。此前写成向后扫，`age <= 21` 只会返回 age=20 那一半。
      end = this.lowerBound(value);
      while (end < n && cmpScalar(this.vals[end], value) === 0) end++;
    }
    else return null;
    // 候选超过全表 25% 就不如直接扫：切片的分配 + 二次遍历比一次扫更贵
    if (end - start > n * 0.25) return null;
    const out = this.idx.slice(start, end);
    // 索引是按字段值排的，全扫是按原行序 —— 不还原的话同一查询
    // 「有索引」和「无索引」会给出不同的行序（SQL 里无 ORDER BY 本无序，
    // 但这里必须一致，否则测试和调用方的 diff 都会莫名其妙地变）。
    out.sort((a, b) => a - b);
    return out;
  }
}

/**
 * 无分配的值比较。
 *
 * 之前用 cmpValue([x,0],[y,0]) —— **每次比较都新建两个数组**，
 * 2000 个候选的等值扫描就是 4000 次分配，实测占掉整个查询的一半时间。
 */
function cmpScalar(x, y) {
  if (x === y) return 0;
  const xn = x === null || x === undefined;
  const yn = y === null || y === undefined;
  if (xn || yn) return xn ? (yn ? 0 : -1) : 1;
  const tx = typeof x, ty = typeof y;
  if (tx === 'number' && ty === 'number') return x < y ? -1 : 1;
  if (tx === 'boolean' && ty === 'boolean') return x ? 1 : -1;
  const sx = String(x), sy = String(y);
  return sx === sy ? 0 : (sx < sy ? -1 : 1);
}

/** 带平局裁决的比较器（排序时保证稳定且与 cmpScalar 同序） */
function cmpValue(a, b) {
  const c = cmpScalar(a[0], b[0]);
  return c !== 0 ? c : a[1] - b[1];
}

function createIndex(field) {
  return field === '' ? new RangeIndex(field) : new HashIndex(field);
}

/**
 * 从 WHERE 里挑一个能用索引的合取项。
 * 只看最外层的 AND 链：`(a AND b)` 里的 a/b 算合取；OR / NOT 不碰。
 * @returns {{field, op, value}|null}
 */
function pickIndexableConjunct(where) {
  if (!where) return null;
  const conjs = [];
  (function walk(n) {
    if (!n) return;
    if (n.k === 'log' && n.op === 'and') { walk(n.l); walk(n.r); return; }
    conjs.push(n);
  })(where);

  for (const c of conjs) {
    if (c.k !== 'bin') continue;
    if (!['=', '!=', '>', '>=', '<', '<='].includes(c.op)) continue;
    // field 必须是裸路径（无点号嵌套），value 必须是常量
    const isPlainPath = c.l && c.l.k === 'path' && !c.l.base && c.l.segs.length === 1;
    const isConst = c.r && c.r.k === 'lit';
    if (isPlainPath && isConst) {
      return { field: c.l.segs[0], op: c.op, value: c.r.v };
    }
  }
  return null;
}

module.exports = { HashIndex, RangeIndex, createIndex, pickIndexableConjunct, keyOf, unkey };