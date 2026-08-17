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
        this._minKeys = Math.floor(order / 2) - 1;
        this._minDegree = Math.ceil(order / 2);
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

    _insertNonFull(node, key, rowIndex) {
        if (node.leaf) {
            // 查找插入位置
            let i = node.keys.length - 1;
            while (i >= 0 && key < node.keys[i]) i--;
            i++;

            if (i > 0 && node.keys[i - 1] === key) {
                if (this._unique) {
                    this._size--;
                    return;
                }
                if (!node.values[i - 1].includes(rowIndex)) {
                    node.values[i - 1].push(rowIndex);
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
        let i = 0;
        while (i < node.keys.length && key > node.keys[i]) i++;
        if (i < node.keys.length && node.keys[i] === key) {
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
        const i = node.keys.indexOf(key);
        return i === -1 ? [] : node.values[i];
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
                    result.push(...node.values[i]);
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
                if (node.keys[i] > min) result.push(...node.values[i]);
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
                if (node.keys[i] < max) result.push(...node.values[i]);
                else return result;
            }
            node = node.next;
        }
        return result;
    }

    _findLeaf(key) {
        let node = this._root;
        while (!node.leaf) {
            let i = 0;
            while (i < node.keys.length && key > node.keys[i]) i++;
            node = node.children[i];
        }
        return node;
    }

    // ============================================================
    // 删除
    // ============================================================

    remove(key, rowIndex) {
        if (!this._root) return false;
        const removed = this._removeFromNode(this._root, key, rowIndex);
        if (removed) this._size--;
        if (this._root.keys.length === 0 && !this._root.leaf && this._root.children.length > 0) {
            this._root = this._root.children[0];
        }
        return removed;
    }

    _removeFromNode(node, key, rowIndex) {
        if (node.leaf) {
            const i = node.keys.indexOf(key);
            if (i === -1) return false;
            if (!node.values[i].includes(rowIndex)) return false;
            const vals = node.values[i].filter(v => v !== rowIndex);
            if (vals.length === 0) {
                node.keys.splice(i, 1);
                node.values.splice(i, 1);
                return true;
            }
            node.values[i] = vals;
            return false;
        }

        let i = this._route(node, key);

        // 下降前确保子节点有足够键，避免欠满子节点
        const child = node.children[i];
        if (child.keys.length <= this._minKeys) {
            i = this._rebalanceChild(node, i);
        }
        return this._removeFromNode(node.children[i], key, rowIndex);
    }

    _rebalanceChild(parent, i) {
        if (i > 0 && parent.children[i - 1].keys.length > this._minKeys) {
            this._borrowFromLeft(parent, i);
            return i;
        }
        if (i + 1 < parent.children.length && parent.children[i + 1].keys.length > this._minKeys) {
            this._borrowFromRight(parent, i);
            return i;
        }
        if (i > 0) {
            this._mergeChildren(parent, i - 1);
            return i - 1;
        }
        this._mergeChildren(parent, i);
        return i;
    }

    _borrowFromLeft(parent, i) {
        const left = parent.children[i - 1];
        const right = parent.children[i];
        if (right.leaf) {
            // 叶子节点：分隔键是叶子的副本，用被移动的键而非旧分隔键，避免重复
            const k = left.keys.pop();
            const v = left.values.pop();
            right.keys.unshift(k);
            right.values.unshift(v);
            parent.keys[i - 1] = k;
            parent.values[i - 1] = v;
        } else {
            right.keys.unshift(parent.keys[i - 1]);
            right.values.unshift(parent.values[i - 1]);
            parent.keys[i - 1] = left.keys.pop();
            parent.values[i - 1] = left.values.pop();
            right.children.unshift(left.children.pop());
        }
    }

    _borrowFromRight(parent, i) {
        const left = parent.children[i];
        const right = parent.children[i + 1];
        if (left.leaf) {
            // 叶子节点：用被移动的键而非旧分隔键，避免重复
            const k = right.keys.shift();
            const v = right.values.shift();
            left.keys.push(k);
            left.values.push(v);
            parent.keys[i] = k;
            parent.values[i] = v;
        } else {
            left.keys.push(parent.keys[i]);
            left.values.push(parent.values[i]);
            parent.keys[i] = right.keys.shift();
            parent.values[i] = right.values.shift();
            left.children.push(right.children.shift());
        }
    }

    _getMax(node) {
        while (!node.leaf) node = node.children[node.children.length - 1];
        const i = node.keys.length - 1;
        return { key: node.keys[i], value: node.values[i] };
    }

    _mergeChildren(parent, index) {
        const left = parent.children[index];
        const right = parent.children[index + 1];
        const midKey = parent.keys[index];
        const midVal = parent.values[index];

        // 叶子节点：分隔键是叶子的副本（已在 left 或 right 中），不能重复压入
        if (!left.leaf) {
            left.keys.push(midKey);
            left.values.push(midVal);
        }
        left.keys.push(...right.keys);
        left.values.push(...right.values);
        if (!left.leaf) left.children.push(...right.children);
        if (left.leaf) left.next = right.next;

        parent.keys.splice(index, 1);
        parent.values.splice(index, 1);
        parent.children.splice(index + 1, 1);
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
     */
    bulkLoad(sortedPairs) {
        if (sortedPairs.length === 0) { this.clear(); return; }
        const order = this._order;
        // 第一层：构建叶子节点
        const leaves = [];
        let i = 0;
        while (i < sortedPairs.length) {
            const node = new BTreeNode(true);
            const end = Math.min(i + order - 1, sortedPairs.length);
            for (; i < end; i++) {
                const [key, val] = sortedPairs[i];
                node.keys.push(key);
                node.values.push(Array.isArray(val) ? val : [val]);
            }
            leaves.push(node);
        }
        for (let i = 0; i < leaves.length - 1; i++) leaves[i].next = leaves[i + 1];
        if (leaves.length === 1) { this._root = leaves[0]; this._size = sortedPairs.length; return; }
        // 逐层向上构建内部节点
        let currentLevel = leaves;
        while (currentLevel.length > 1) {
            const parents = [];
            let j = 0;
            while (j < currentLevel.length) {
                const node = new BTreeNode(false);
                const end = Math.min(j + order, currentLevel.length);
                for (; j < end; j++) {
                    if (node.children.length > 0) {
                        const child = currentLevel[j];
                        node.keys.push(child.keys[0]);
                        node.values.push(child.values[0]);
                    }
                    node.children.push(currentLevel[j]);
                }
                parents.push(node);
            }
            currentLevel = parents;
        }
        this._root = currentLevel[0];
        this._size = sortedPairs.length;
    }
}

module.exports = BTree;