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
        let i = node.keys.length - 1;

        if (node.leaf) {
            // 查找插入位置
            while (i >= 0 && key < node.keys[i]) i--;
            i++;

            if (i > 0 && node.keys[i - 1] === key) {
                if (!node.values[i - 1].includes(rowIndex)) {
                    node.values[i - 1].push(rowIndex);
                }
                this._size--;
                return;
            }

            node.keys.splice(i, 0, key);
            node.values.splice(i, 0, [rowIndex]);
        } else {
            while (i >= 0 && key < node.keys[i]) i--;
            i++;

            if (node.children[i] && node.children[i].keys.length === this._order - 1) {
                this._splitChild(node, i);
                if (key >= node.keys[i] && i + 1 < node.children.length) i++;
            }
            this._insertNonFull(node.children[i], key, rowIndex);
        }
    }

    _splitChild(parent, index) {
        const child = parent.children[index];
        const newChild = new BTreeNode(child.leaf);
        const mid = Math.floor((this._order - 1) / 2);

        // 右半部分移到新节点
        newChild.keys = child.keys.splice(mid + 1);
        newChild.values = child.values.splice(mid + 1);

        // 中间键提升到父节点
        const midKey = child.keys[mid];
        const midVal = child.values[mid];

        // 非叶子节点：移动子节点
        if (!child.leaf) {
            newChild.children = child.children.splice(mid + 1);
        }

        // 叶子节点：维护链表
        if (child.leaf) {
            newChild.next = child.next;
            child.next = newChild;
        }

        parent.keys.splice(index, 0, midKey);
        parent.values.splice(index, 0, midVal);
        parent.children.splice(index + 1, 0, newChild);
    }

    // ============================================================
    // 查找
    // ============================================================

    /**
     * 精确查找
     * @returns {number[]} 行号数组
     */
    search(key) {
        let node = this._root;
        while (node) {
            let i = 0;
            while (i < node.keys.length && key > node.keys[i]) i++;

            if (i < node.keys.length && key === node.keys[i]) {
                return node.values[i];
            }

            if (node.leaf) break;
            node = node.children[i];
        }
        return [];
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
     * 大于查询
     */
    greaterThan(min) {
        return this.range(min, Infinity);
    }

    /**
     * 小于查询
     */
    lessThan(max) {
        return this.range(-Infinity, max);
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
        let i = 0;
        while (i < node.keys.length && key > node.keys[i]) i++;

        if (node.leaf) {
            if (i < node.keys.length && node.keys[i] === key) {
                const vals = node.values[i].filter(v => v !== rowIndex);
                if (vals.length === 0) {
                    node.keys.splice(i, 1);
                    node.values.splice(i, 1);
                } else {
                    node.values[i] = vals;
                }
                return true;
            }
            return false;
        }

        if (i < node.keys.length && node.keys[i] === key) {
            return this._removeFromInternal(node, i, rowIndex);
        }

        return this._removeFromNode(node.children[i], key, rowIndex);
    }

    _removeFromInternal(node, index, rowIndex) {
        const vals = node.values[index].filter(v => v !== rowIndex);
        if (vals.length > 0) {
            node.values[index] = vals;
            return true;
        }

        const leftChild = node.children[index];
        if (leftChild.keys.length >= this._minDegree) {
            const pred = this._getMax(leftChild);
            node.keys[index] = pred.key;
            node.values[index] = pred.value;
            this._removeFromNode(leftChild, pred.key, rowIndex);
            return true;
        }

        const rightChild = node.children[index + 1];
        if (rightChild.keys.length >= this._minDegree) {
            const succ = this._getMin(rightChild);
            node.keys[index] = succ.key;
            node.values[index] = succ.value;
            this._removeFromNode(rightChild, succ.key, rowIndex);
            return true;
        }

        const origKey = node.keys[index];
        this._mergeChildren(node, index);
        return this._removeFromNode(node.children[index], origKey, rowIndex);
    }

    _getMax(node) {
        while (!node.leaf) node = node.children[node.children.length - 1];
        const i = node.keys.length - 1;
        return { key: node.keys[i], value: node.values[i] };
    }

    _getMin(node) {
        while (!node.leaf) node = node.children[0];
        return { key: node.keys[0], value: node.values[0] };
    }

    _mergeChildren(parent, index) {
        const left = parent.children[index];
        const right = parent.children[index + 1];
        const midKey = parent.keys[index];
        const midVal = parent.values[index];

        left.keys.push(midKey);
        left.values.push(midVal);
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
     * 获取所有索引条目
     */
    entries() {
        const result = [];
        this._traverse(this._root, result);
        return result;
    }

    _traverse(node, result) {
        if (node.leaf) {
            for (let i = 0; i < node.keys.length; i++) {
                result.push({ key: node.keys[i], value: node.values[i] });
            }
        } else {
            for (let i = 0; i < node.keys.length; i++) {
                this._traverse(node.children[i], result);
                result.push({ key: node.keys[i], value: node.values[i] });
            }
            this._traverse(node.children[node.children.length - 1], result);
        }
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