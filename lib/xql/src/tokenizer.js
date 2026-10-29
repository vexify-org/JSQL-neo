'use strict';
/**
 * XQL 词法分析器
 *
 * 设计约束：只做一次扫描，产出扁平 token 数组。
 * 不分配嵌套结构、不做回溯 —— 词法层省下的每一纳秒都会在编译期还回来。
 */

const KEYWORDS = new Set([
  'FROM', 'WHERE', 'SELECT', 'ORDER', 'BY', 'LIMIT', 'OFFSET', 'SKIP',
  'GROUP', 'HAVING', 'AS', 'ASC', 'DESC', 'AND', 'OR', 'NOT', 'NULL',
  'TRUE', 'FALSE', 'IN', 'LIKE', 'BETWEEN', 'IS', 'DISTINCT', 'COUNT',
  'SUM', 'AVG', 'MIN', 'MAX', 'PIPE',
]);

const OPS = new Set([
  '=', '==', '!=', '<>', '<', '>', '<=', '>=',
  '+', '-', '*', '/', '%', '(', ')', ',', '.', '[', ']', '{', '}', ':',
  '|>', '=>',
]);

/**
 * @param {string} src
 * @returns {Array<{t:string, v:string, p:number}>} t=类型 v=值 p=起始位置
 */
function tokenize(src) {
  const out = [];
  let i = 0;
  const n = src.length;

  while (i < n) {
    const c = src[i];

    // 空白
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { i++; continue; }

    // 注释 -- 与 //
    if (c === '-' && src[i + 1] === '-') { while (i < n && src[i] !== '\n') i++; continue; }
    if (c === '/' && src[i + 1] === '/') { while (i < n && src[i] !== '\n') i++; continue; }

    // 管道 |> 必须先于 | 与 > 匹配
    if (c === '|' && src[i + 1] === '>') { out.push({ t: 'op', v: '|>', p: i }); i += 2; continue; }

    // 字符串（单引号优先，双引号亦可）
    if (c === "'" || c === '"') {
      const q = c;
      let j = i + 1;
      let s = '';
      while (j < n) {
        if (src[j] === '\\' && j + 1 < n) {
          const e = src[j + 1];
          s += ({ n: '\n', t: '\t', r: '\r', '0': '\0' })[e] !== undefined ? ({ n: '\n', t: '\t', r: '\r', '0': '\0' })[e] : e;
          j += 2;
        } else if (src[j] === q) break;
        else { s += src[j]; j++; }
      }
      if (j >= n) throw new Error(`XQL: 字符串未闭合，位置 ${i}`);
      out.push({ t: 'str', v: s, p: i });
      i = j + 1;
      continue;
    }

    // 数字（含小数与负号）
    if ((c >= '0' && c <= '9') || (c === '.' && src[i + 1] >= '0' && src[i + 1] <= '9')) {
      let j = i;
      while (j < n && ((src[j] >= '0' && src[j] <= '9') || src[j] === '.')) j++;
      // 科学计数法
      if (j < n && (src[j] === 'e' || src[j] === 'E')) {
        let k = j + 1;
        if (src[k] === '+' || src[k] === '-') k++;
        if (src[k] >= '0' && src[k] <= '9') { while (k < n && src[k] >= '0' && src[k] <= '9') k++; j = k; }
      }
      out.push({ t: 'num', v: Number(src.slice(i, j)), p: i });
      i = j;
      continue;
    }

    // 负号：前面是操作符/开头时当作数字一部分
    if (c === '-' && (src[i + 1] >= '0' && src[i + 1] <= '9')) {
      const prev = out.length ? out[out.length - 1] : null;
      if (!prev || prev.t === 'op' || (prev.t === 'kw' && prev.v !== 'TRUE' && prev.v !== 'FALSE' && prev.v !== 'NULL')) {
        let j = i + 1;
        while (j < n && ((src[j] >= '0' && src[j] <= '9') || src[j] === '.')) j++;
        out.push({ t: 'num', v: -Number(src.slice(i + 1, j)), p: i });
        i = j;
        continue;
      }
    }

    // 标识符 / 关键字（含点号路径由 parser 组装）
    if (/[A-Za-z_$@]/.test(c)) {
      let j = i;
      while (j < n && /[A-Za-z0-9_$@]/.test(src[j])) j++;
      const w = src.slice(i, j);
      const up = w.toUpperCase();
      out.push(KEYWORDS.has(up) ? { t: 'kw', v: up, p: i } : { t: 'id', v: w, p: i });
      i = j;
      continue;
    }

    // 反引号标识符
    if (c === '`') {
      let j = i + 1;
      let s = '';
      while (j < n && src[j] !== '`') { s += src[j]; j++; }
      if (j >= n) throw new Error(`XQL: 反引号标识符未闭合，位置 ${i}`);
      out.push({ t: 'id', v: s, p: i });
      i = j + 1;
      continue;
    }

    // 双字符操作符
    const two = src.slice(i, i + 2);
    if (two === '<=' || two === '>=' || two === '==' || two === '!=' || two === '<>') {
      out.push({ t: 'op', v: two === '<>' ? '!=' : two, p: i });
      i += 2;
      continue;
    }

    if (OPS.has(c)) { out.push({ t: 'op', v: c, p: i }); i++; continue; }

    throw new Error(`XQL: 无法识别的字符 '${c}'，位置 ${i}`);
  }

  out.push({ t: 'eof', v: null, p: n });
  return out;
}

module.exports = { tokenize, KEYWORDS };
