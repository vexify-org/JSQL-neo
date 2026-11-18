// © Vexify 2026 All Rights Reserved.
/**
 * 行级懒加载缓存（hybrid / disk 目录模式）
 *
 * 目标：大表不再整表常驻内存。`Table._rows` 仍是「类数组」，但元素来自
 * 磁盘上的 `{block, off}` 定位符 —— 只有真正被访问的行才 decode 进内存，
 * 内存紧张时由 Database 按 LRU 逐行回退成定位符。
 *
 * 设计要点：
 *   • 用 Proxy 包住一个真实数组，数字下标命中定位符时才读盘；
 *   • 数组方法（filter/map/find/push/pop/splice…）都以 proxy 为 this，
 *     逐元素走 get/set，语义与普通数组一致；
 *   • 脏行（尚未刷盘）永远 pin 在内存里，避免「改了但被淘汰」丢数据；
 *   • 淘汰只由 Database 在两次同步操作之间触发。同步操作内部不会发生
 *     淘汰，因此 `_rows.indexOf(row)` 这类依赖对象标识的逻辑仍然成立。
 */

const INDEX_RE = /^(?:0|[1-9]\d*)$/;

function toIndex(prop) {
  return INDEX_RE.test(prop) ? Number(prop) : -1;
}

function isLocator(v) {
  return v !== null && typeof v === 'object' && v.__loc === true;
}

function makeLocator(loc) {
  return { __loc: true, block: loc.block, off: loc.off };
}

/**
 * @param {object} table - 所属 Table（用于查询脏行、判断 pin）
 * @param {Array<{block:number, off:number}>} locators - 有效行的物理位置
 * @param {(block:number, off:number) => object} loader - 单行读取函数
 * @param {Function} [onClose] - 缓存被丢弃时关闭底层句柄
 */
function createRowCache(table, locators, loader, onClose) {
  const target = new Array(locators.length);
  const locs = new Array(locators.length);   // 下标 -> 磁盘位置（null = 无磁盘来源）
  let rowIndex = new WeakMap();              // 行对象 -> 下标
  const lru = new Map();                     // 下标 -> true（Map 保持访问顺序）

  for (let i = 0; i < locators.length; i++) {
    const loc = locators[i];
    target[i] = makeLocator(loc);
    locs[i] = { block: loc.block, off: loc.off };
  }

  function touch(i) {
    lru.delete(i);
    lru.set(i, true);
  }

  function untouch(i) {
    lru.delete(i);
  }

  function dropMappings(i, value) {
    if (value && typeof value === 'object' && !isLocator(value)) rowIndex.delete(value);
    untouch(i);
  }

  function load(i) {
    const loc = locs[i];
    if (!loc) return undefined;
    const row = loader(loc.block, loc.off);
    if (row && typeof row === 'object') {
      target[i] = row;
      rowIndex.set(row, i);
      touch(i);
    }
    return row;
  }

  const handler = {
    get(t, prop, receiver) {
      if (typeof prop === 'string') {
        const i = toIndex(prop);
        if (i >= 0) {
          const v = t[i];
          if (isLocator(v)) return load(i);
          if (v !== undefined) touch(i);
          return v;
        }
      }
      return Reflect.get(t, prop, receiver);
    },

    set(t, prop, value) {
      if (typeof prop === 'string') {
        const i = toIndex(prop);
        if (i >= 0) {
          const old = t[i];
          if (old !== value) {
            if (value && typeof value === 'object' && !isLocator(value)) {
              const src = rowIndex.get(value);
              if (src !== undefined) {
                // 删除时「用尾行填补空位」：locator 跟着行一起搬
                if (src !== i) {
                  locs[i] = locs[src];
                  locs[src] = null;
                  untouch(src);
                }
              } else {
                locs[i] = null;   // 新插入的行，没有磁盘位置
              }
            } else {
              locs[i] = null;
            }
            dropMappings(i, old);
          }
          t[i] = value;
          if (value && typeof value === 'object' && !isLocator(value)) {
            rowIndex.set(value, i);
            touch(i);
          }
          return true;
        }
        if (prop === 'length') {
          const n = value >>> 0;
          const oldLen = t.length;
          if (n < oldLen) {
            for (let j = n; j < oldLen; j++) dropMappings(j, t[j]);
          }
          t.length = n;
          locs.length = n;
          return true;
        }
      }
      return Reflect.set(t, prop, value);
    },

    deleteProperty(t, prop) {
      const i = toIndex(prop);
      if (i >= 0) {
        dropMappings(i, t[i]);
        locs[i] = null;
        delete t[i];
        return true;
      }
      return Reflect.deleteProperty(t, prop);
    }
  };

  const rows = new Proxy(target, handler);

  /** 顺序扫描全部磁盘行，逐行回调；扫描结果不留在缓存里。 */
  function scan(fn) {
    for (let i = 0; i < locs.length; i++) {
      const cur = target[i];
      let row;
      if (!isLocator(cur) && cur !== undefined) row = cur;
      else if (locs[i]) row = loader(locs[i].block, locs[i].off);
      if (row !== undefined && row !== null) fn(row, i);
    }
  }

  /** 按 LRU 顺序把最多 max 行回退成定位符；脏行始终保留。 */
  function evict(max) {
    if (max <= 0) return 0;
    let removed = 0;
    const keys = [...lru.keys()];
    for (const i of keys) {
      if (removed >= max) break;
      const v = target[i];
      if (!v || isLocator(v) || typeof v !== 'object') { untouch(i); continue; }
      if (table && table._dirtyUpserts && table._dirtyUpserts.has(v)) continue;
      const loc = locs[i];
      if (!loc) continue;   // 新插入、尚未落盘的行无法回退
      rowIndex.delete(v);
      target[i] = makeLocator(loc);
      untouch(i);
      removed++;
    }
    return removed;
  }

  /** 整表重写/刷新后重置全部定位符（行顺序必须与原来一致）。 */
  function reset(newLocs) {
    target.length = 0;
    locs.length = 0;
    lru.clear();
    rowIndex = new WeakMap();
    for (let i = 0; i < newLocs.length; i++) {
      target[i] = makeLocator(newLocs[i]);
      locs[i] = { block: newLocs[i].block, off: newLocs[i].off };
    }
  }

  /** 刷盘后更新个别已落盘行的定位符。 */
  function applyLocators(rowList, newLocs) {
    if (!rowList || !newLocs) return;
    const n = Math.min(rowList.length, newLocs.length);
    for (let k = 0; k < n; k++) {
      const row = rowList[k];
      const i = rowIndex.get(row);
      if (i === undefined || target[i] !== row) continue;
      locs[i] = { block: newLocs[k].block, off: newLocs[k].off };
      touch(i);
    }
  }

  function size() { return lru.size; }

  function close() {
    if (typeof onClose === 'function') {
      try { onClose(); } catch (e) { /* 关闭句柄失败不影响数据 */ }
    }
  }

  return { rows, scan, evict, reset, applyLocators, size, close };
}

module.exports = { createRowCache };
