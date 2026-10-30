// © Vexify 2026 All Rights Reserved.
/**
 * JSQL B-Tree 索引引擎
 * O(log n) 查找/插入/删除，支持范围查询和复合键
 */

class BTreeNode {
    constructor(leaf = true) {
        this.keys = [];       // 索引键值
        this.values = [];     // 对应的行号数组
        this.children = [];   // 子节点
        this.leaf = leaf;
        this.next = null;     // 叶子节点链表（范围查询用）
    }
}

class BTree {
    /**
     * @param {number} order - B-Tree 阶数，默认 64
     * @param {boolean} unique - 是否唯一索引
     */
    constructor(order = 64, unique = false) {
        this._order = order;
        this._unique = unique;
        this._root = new BTreeNode();
        this._size = 0;
    }

    get size() { return this._size; }

    // ============================================================
    // 插入
    // ============================================================

    insert(key, rowIndex) {
        const root = this._root;

        // 根节点满 → 分裂
        if (root.keys.length === this._order - 1) {
            const newRoot = new BTreeNode(false);
            newRoot.children.push(root);
            this._splitChild(newRoot, 0);
            this._root = newRoot;
            this._insertNonFull(newRoot, key, rowIndex);
        } else {
            this._insertNonFull(root, key, rowIndex);
        }
        this._size++;
    }

    _lowerBound(keys, key) {
        let lo = 0, hi = keys.length;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (keys[mid] < key) lo = mid + 1;
            else hi = mid;
        }
        return lo;
    }

    _insertNonFull(node, key, rowIndex) {
        if (node.leaf) {
            const i = this._lowerBound(node.keys, key);

            if (i < node.keys.length && node.keys[i] === key) {
                if (this._unique) {
                    this._size--;
                    return;
                }
                if (!node.values[i].includes(rowIndex)) {
                    node.values[i].push(rowIndex);
                }
                this._size--;
                return;
            }

            node.keys.splice(i, 0, key);
            node.values.splice(i, 0, [rowIndex]);
        } else {
            let i = this._route(node, key);
            if (node.children[i] && node.children[i].keys.length === this._order - 1) {
                this._splitChild(node, i);
                i = this._route(node, key);
            }
            this._insertNonFull(node.children[i], key, rowIndex);
        }
    }

    _splitChild(parent, index) {
        const child = parent.children[index];
        const newChild = new BTreeNode(child.leaf);
        const mid = Math.floor((this._order - 1) / 2);

        const midKey = child.keys[mid];
        const midVal = child.values[mid];

        if (child.leaf) {
            // 叶子：右半移到新节点；分隔键保留在左叶（它是真实数据键），父节点只存副本
            newChild.keys = child.keys.splice(mid + 1);
            newChild.values = child.values.splice(mid + 1);
            newChild.next = child.next;
            child.next = newChild;
        } else {
            // 内部：分隔键提升到父节点并从子节点移除，保持 children = keys + 1
            newChild.keys = child.keys.splice(mid + 1);
            newChild.values = child.values.splice(mid + 1);
            child.keys.splice(mid, 1);
            child.values.splice(mid, 1);
            newChild.children = child.children.splice(mid + 1);
        }

        parent.keys.splice(index, 0, midKey);
        parent.values.splice(index, 0, midVal);
        parent.children.splice(index + 1, 0, newChild);
    }

    // ============================================================
    // 查找
    // ============================================================

    /**
     * 内部节点路由：返回 key 应下降到的子节点下标。
     * 命中分隔键副本时，根据左子树最大键判定真实数据所在子树
     * （分隔键副本可能在左子树作为最大值，或在右子树作为最小值）。
     */
    _route(node, key) {
        let i = this._lowerBound(node.keys, key);
        // 叶子节点没有子节点可路由（children[i] 为 undefined），直接返回下界，避免崩溃。
        if (i < node.keys.length && node.keys[i] === key && node.children[i]) {
            return this._getMax(node.children[i]).key === key ? i : i + 1;
        }
        return i;
    }

    /**
     * 精确查找（始终下探到叶子取真实数据；内部分隔键只是叶子的副本，仅用于导航）
     * @returns {number[]} 行号数组；未找到时返回空数组
     */
    search(key) {
        let node = this._root;
        while (!node.leaf) node = node.children[this._route(node, key)];
        const i = this._lowerBound(node.keys, key);
        return (i < node.keys.length && node.keys[i] === key) ? node.values[i] : [];
    }

    searchMany(keys) {
        if (!keys || keys.length === 0) return [];
        const out = [];
        const seen = new Set();
        for (let i = 0; i < keys.length; i++) {
            const hits = this.search(keys[i]);
            for (let j = 0; j < hits.length; j++) {
                const idx = hits[j];
                if (!seen.has(idx)) {
                    seen.add(idx);
                    out.push(idx);
                }
            }
        }
        return out;
    }

    prefix(prefix) {
        if (prefix === undefined || prefix === null) return [];
        const p = String(prefix);
        const result = [];
        let node = this._findLeaf(p);
        while (node) {
            for (let i = 0; i < node.keys.length; i++) {
                const k = node.keys[i];
                const s = k === undefined || k === null ? '' : String(k);
                // 不能假设键按字典序排序（数字键按数值序），必须检查所有键
                if (s.startsWith(p)) {
                    for (const __e of node.values[i]) result.push(__e);
                }
            }
            node = node.next;
        }
        return result;
    }

    /**
     * 范围查询 [min, max]
     */
    range(min, max) {
        const result = [];
        let node = this._findLeaf(min);

        while (node) {
            for (let i = 0; i < node.keys.length; i++) {
                const k = node.keys[i];
                if (k > max) return result;
                if (k >= min) {
                    for (const __e of node.values[i]) result.push(__e);
                }
            }
            node = node.next;
        }
        return result;
    }

    /**
     * 大于查询（严格开区间，不含 min 本身）
     */
    greaterThan(min) {
        const result = [];
        let node = this._findLeaf(min);
        while (node) {
            for (let i = 0; i < node.keys.length; i++) {
                if (node.keys[i] > min) for (const __e of node.values[i]) result.push(__e);
            }
            node = node.next;
        }
        return result;
    }

    greaterThanEqual(min) {
        const result = [];
        let node = this._findLeaf(min);
        while (node) {
            for (let i = 0; i < node.keys.length; i++) {
                if (node.keys[i] >= min) for (const __e of node.values[i]) result.push(__e);
            }
            node = node.next;
        }
        return result;
    }

    /**
     * 小于查询（严格开区间，不含 max 本身）
     */
    lessThan(max) {
        const result = [];
        let node = this._root;
        while (!node.leaf) node = node.children[0];
        while (node) {
            for (let i = 0; i < node.keys.length; i++) {
                if (node.keys[i] < max) for (const __e of node.values[i]) result.push(__e);
                else return result;
            }
            node = node.next;
        }
        return result;
    }

    lessThanEqual(max) {
        const result = [];
        let node = this._root;
        while (!node.leaf) node = node.children[0];
        while (node) {
            for (let i = 0; i < node.keys.length; i++) {
                if (node.keys[i] <= max) for (const __e of node.values[i]) result.push(__e);
                else return result;
            }
            node = node.next;
        }
        return result;
    }

    _findLeaf(key) {
        let node = this._root;
        while (!node.leaf) {
            node = node.children[this._lowerBound(node.keys, key)];
        }
        return node;
    }

    // ============================================================
    // 删除
    // ============================================================

    remove(key, rowIndex) {
        if (!this._root) return false;
        const res = this._removeFromNode(this._root, key, rowIndex);
        if (!res.found) return false;
        if (!res.remaining) this._size--;
        // 只做惰性删除 + 分隔键归一：不再在下降途中借用/合并。
        // 旧实现先对路由到的子节点做 borrow/merge 再检查键是否存在，
        // 删除一个不存在的键（或 rowIndex 不匹配）也会重构整棵树，
        // 合并时丢掉的分隔键副本可能正好是仍然存活的数据键 —— 条目静默丢失。
        this._normalize();
        return !res.remaining;
    }

    _removeFromNode(node, key, rowIndex) {
        if (node.leaf) {
            const i = this._lowerBound(node.keys, key);
            if (i >= node.keys.length || node.keys[i] !== key) return { found: false };
            const pos = node.values[i].indexOf(rowIndex);
            if (pos === -1) return { found: false };
            const vals = node.values[i].filter(v => v !== rowIndex);
            if (vals.length === 0) {
                node.keys.splice(i, 1);
                node.values.splice(i, 1);
                return { found: true, remaining: false };
            }
            node.values[i] = vals;
            return { found: true, remaining: true };
        }

        const i = this._route(node, key);
        const child = node.children[i];
        if (!child) return { found: false };
        return this._removeFromNode(child, key, rowIndex);
    }

    /**
     * 惰性回收：删掉节点里空的叶子/空子树，折叠只剩一个孩子的内部节点，
     * 并按「分隔键 = 左子树最大键」的约定重算所有内部键，最后重建叶子链表。
     * 节点欠满不影响正确性（插入时仍然按满则分裂），因此无需借用/合并。
     */
    _normalize() {
        const root = this._cleanNode(this._root);
        this._root = root || new BTreeNode();
        this._relinkLeaves();
    }

    _cleanNode(node) {
        if (node.leaf) return node.keys.length === 0 ? null : node;
        const kids = [];
        for (const c of node.children) {
            const kept = this._cleanNode(c);
            if (kept) kids.push(kept);
        }
        node.children = kids;
        if (kids.length === 0) return null;
        if (kids.length === 1) return kids[0];
        node.keys = [];
        node.values = [];
        for (let i = 0; i < kids.length - 1; i++) {
            const m = this._getMax(kids[i]);
            node.keys.push(m.key);
            node.values.push(m.value);
        }
        return node;
    }

    _relinkLeaves() {
        let head = this._root;
        while (head && !head.leaf) head = head.children[0];
        let prev = null;
        let node = head;
        while (node) {
            if (prev) prev.next = node;
            prev = node;
            node = node.next;
        }
        if (prev) prev.next = null;
    }

    _getMax(node) {
        while (!node.leaf) node = node.children[node.children.length - 1];
        const i = node.keys.length - 1;
        return { key: node.keys[i], value: node.values[i] };
    }

    // ============================================================
    // 遍历
    // ============================================================

    /**
     * 获取所有索引条目（仅叶子数据，分隔键为内部副本，不重复计入）
     */
    entries() {
        const result = [];
        let node = this._root;
        while (node && !node.leaf) node = node.children[0];
        while (node) {
            for (let i = 0; i < node.keys.length; i++) {
                result.push({ key: node.keys[i], value: node.values[i] });
            }
            node = node.next;
        }
        return result;
    }

    /**
     * 清空索引
     */
    clear() {
        this._root = new BTreeNode();
        this._size = 0;
    }

    /**
     * 重建索引（从数据行批量构建）
     */
    rebuild(rows, getKey) {
        this.clear();
        for (let i = 0; i < rows.length; i++) {
            const key = getKey(rows[i]);
            if (key !== undefined && key !== null) {
                this.insert(key, i);
            }
        }
    }

    /**
     * 批量加载：从已排序的 [key, rowIndex] 数组底部向上构建
     * O(n) 时间，适合大数据量批量构建
     *
     * @deprecated 已移除（6.3.4）。原因：本方法用 `child.keys[0]` 作为内部分隔键，
     * 而 insert/_splitChild 路径的分隔键是「左叶最大键的副本」，两者语义不一致。
     * 混用会导致 search/range 漏查或错查。当前索引构建统一走 insert()
     * （见 table.js 的 rebuild 路径），本方法无任何调用方，故直接移除而非修复。
     */
}

module.exports = BTree;