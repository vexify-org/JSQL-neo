// © Vexify 2026 All Rights Reserved.
/**
 * Bug Hunt Tests — v6.4.0-beta.16
 * Tests for bugs found during code review:
 *   1. BTree _borrowFromLeft wrong parent key (leaf nodes)
 *   2. Query _applyOrderBy missing NULL handling
 *   3. BTree prefix incorrect early return for numeric keys
 *
 *   node test/bug-hunt.test.js
 */
const BTree = require('../lib/btree');
const Query = require('../lib/query');

let passed = 0, failed = 0;
function ok(name, cond, extra) {
    if (cond) { passed++; }
    else { failed++; console.log('[FAIL]', name, extra !== undefined ? '-> ' + JSON.stringify(extra) : ''); }
}

// ============================================================
// Helper: Mock Table for Query tests
// ============================================================
function createMockTable(name, rows, schema = {}) {
    const table = {
        _name: name,
        _rows: rows,
        _schema: schema,
        _btrees: {},
        _indexes: {},
        _applyFilterOptimized(rows, query) {
            return rows.filter(row => {
                for (const [field, condition] of Object.entries(query)) {
                    const value = row[field];
                    if (condition !== null && typeof condition === 'object' && !Array.isArray(condition)) {
                        for (const [op, target] of Object.entries(condition)) {
                            if (op === '$gt' && !(value > target)) return false;
                            if (op === '$gte' && !(value >= target)) return false;
                            if (op === '$lt' && !(value < target)) return false;
                            if (op === '$lte' && !(value <= target)) return false;
                            if (op === '$eq' && value !== target) return false;
                            if (op === '$ne' && value === target) return false;
                            if (op === '$in' && !target.includes(value)) return false;
                        }
                    } else {
                        if (value !== condition) return false;
                    }
                }
                return true;
            });
        },
        _applyFilter(rows, query) { return this._applyFilterOptimized(rows, query); },
        _matchRow(row, query) {
            for (const [field, condition] of Object.entries(query)) {
                const value = row[field];
                if (condition !== null && typeof condition === 'object' && !Array.isArray(condition)) {
                    for (const [op, target] of Object.entries(condition)) {
                        if (op === '$gt' && !(value > target)) return false;
                        if (op === '$gte' && !(value >= target)) return false;
                        if (op === '$lt' && !(value < target)) return false;
                        if (op === '$lte' && !(value <= target)) return false;
                        if (op === '$eq' && value !== target) return false;
                        if (op === '$ne' && value === target) return false;
                        if (op === '$in' && !target.includes(value)) return false;
                    }
                } else {
                    if (value !== condition) return false;
                }
            }
            return true;
        },
        _getVisibleRows() { return this._rows; },
        _db: {
            _logSlowQuery() {},
            _tables: {},
        },
    };
    return table;
}

// ============================================================
// Bug 1: BTree _borrowFromLeft wrong parent key
// ============================================================
console.log('\n=== Bug 1: BTree _borrowFromLeft parent key ===');

{
    const tree = new BTree(4, false);
    for (let i = 0; i < 20; i++) tree.insert(i, i);

    // Delete from the right side to trigger left borrows
    for (let i = 19; i >= 10; i--) tree.remove(i, i);

    // After deletions, search for remaining keys should work
    let allFound = true;
    for (let i = 0; i < 10; i++) {
        const result = tree.search(i);
        if (result.length === 0 || !result.includes(i)) { allFound = false; break; }
    }
    ok('Bug1: search after left borrows', allFound);

    // Range query should return correct results
    const rangeResult = tree.range(0, 9);
    ok('Bug1: range [0,9] returns 10 items', rangeResult.length === 10, { len: rangeResult.length });
}

{
    const tree = new BTree(4, false);
    for (let i = 0; i < 50; i++) tree.insert(i, i);

    // Delete every other key to force rebalancing
    for (let i = 1; i < 50; i += 2) tree.remove(i, i);

    // Verify all remaining keys are searchable
    let allEvenFound = true;
    for (let i = 0; i < 50; i += 2) {
        const result = tree.search(i);
        if (result.length === 0 || !result.includes(i)) { allEvenFound = false; break; }
    }
    ok('Bug1: even keys after heavy deletions', allEvenFound);

    // Verify deleted keys are gone
    let allOddGone = true;
    for (let i = 1; i < 50; i += 2) {
        const result = tree.search(i);
        if (result.length !== 0) { allOddGone = false; break; }
    }
    ok('Bug1: odd keys deleted', allOddGone);

    // Greater than query
    const gtResult = tree.greaterThan(25);
    ok('Bug1: greaterThan(25) finds keys', gtResult.length > 0);

    // Less than query
    const ltResult = tree.lessThan(25);
    ok('Bug1: lessThan(25) finds keys', ltResult.length > 0);
}

{
    const tree = new BTree(4, true);
    for (let i = 0; i < 30; i++) tree.insert(i * 10, i);

    // Delete from the right half to trigger left borrows
    for (let i = 29; i >= 15; i--) tree.remove(i * 10, i);

    // Verify remaining keys
    let allFound = true;
    for (let i = 0; i < 15; i++) {
        const result = tree.search(i * 10);
        if (result.length !== 1 || result[0] !== i) { allFound = false; break; }
    }
    ok('Bug1: unique index with left borrows', allFound);
}

// ============================================================
// Bug 2: Query _applyOrderBy missing NULL handling
// ============================================================
console.log('\n=== Bug 2: Query _applyOrderBy NULL handling ===');

{
    const rows = [
        { id: 1, name: 'Alice', age: 30 },
        { id: 2, name: 'Bob', age: null },
        { id: 3, name: 'Charlie', age: 25 },
        { id: 4, name: 'Dave', age: null },
    ];
    const table = createMockTable('users', rows);
    const query = new Query(table);
    query.orderBy('age', 'asc');
    const result = query.get();

    ok('Bug2: ASC nulls first (1st)', result[0].age === null);
    ok('Bug2: ASC nulls first (2nd)', result[1].age === null);
    ok('Bug2: ASC 25 before 30', result[2].age === 25);
    ok('Bug2: ASC 30 last', result[3].age === 30);
}

{
    const rows = [
        { id: 1, name: 'Alice', age: 30 },
        { id: 2, name: 'Bob', age: null },
        { id: 3, name: 'Charlie', age: 25 },
        { id: 4, name: 'Dave', age: null },
    ];
    const table = createMockTable('users', rows);
    const query = new Query(table);
    query.orderBy('age', 'desc');
    const result = query.get();

    ok('Bug2: DESC nulls last (1st=30)', result[0].age === 30);
    ok('Bug2: DESC nulls last (2nd=25)', result[1].age === 25);
    ok('Bug2: DESC nulls last (3rd=null)', result[2].age === null);
    ok('Bug2: DESC nulls last (4th=null)', result[3].age === null);
}

{
    const rows = [
        { id: 1, name: 'Alice', age: null },
        { id: 2, name: 'Bob', age: null },
        { id: 3, name: 'Charlie', age: null },
    ];
    const table = createMockTable('users', rows);
    const query = new Query(table);
    query.orderBy('age', 'asc');
    const result = query.get();

    ok('Bug2: all nulls ASC', result.length === 3 && result.every(r => r.age === null));
}

{
    const rows = [
        { id: 1, name: 'Alice', score: 85 },
        { id: 2, name: 'Bob' }, // score is undefined
        { id: 3, name: 'Charlie', score: null },
        { id: 4, name: 'Dave', score: 90 },
    ];
    const table = createMockTable('users', rows);
    const query = new Query(table);
    query.orderBy('score', 'asc');
    const result = query.get();

    // Both null and undefined sort as null; stable sort preserves original order
    // Bob (undefined) was at index 1, Charlie (null) at index 2
    ok('Bug2: mixed null/undefined ASC (1st=null/undefined)', result[0].score == null);
    ok('Bug2: mixed null/undefined ASC (2nd=null/undefined)', result[1].score == null);
    ok('Bug2: mixed null/undefined ASC (3rd=85)', result[2].score === 85);
    ok('Bug2: mixed null/undefined ASC (4th=90)', result[3].score === 90);
}

{
    const rows = [
        { id: 1, department: 'Engineering', salary: 5000 },
        { id: 2, department: 'Engineering', salary: null },
        { id: 3, department: 'Sales', salary: 4000 },
        { id: 4, department: 'Sales', salary: null },
        { id: 5, department: 'Engineering', salary: 6000 },
    ];
    const table = createMockTable('employees', rows);
    const query = new Query(table);
    query.orderBy('department', 'asc').orderBy('salary', 'asc');
    const result = query.get();

    ok('Bug2: multi-field orderBy', result.length === 5);
    ok('Bug2: Eng null salary first', result[0].department === 'Engineering' && result[0].salary === null);
    ok('Bug2: Eng 5000 second', result[1].department === 'Engineering' && result[1].salary === 5000);
    ok('Bug2: Eng 6000 third', result[2].department === 'Engineering' && result[2].salary === 6000);
    ok('Bug2: Sales null salary fourth', result[3].department === 'Sales' && result[3].salary === null);
    ok('Bug2: Sales 4000 fifth', result[4].department === 'Sales' && result[4].salary === 4000);
}

// ============================================================
// Bug 3: BTree prefix incorrect early return for numeric keys
// ============================================================
console.log('\n=== Bug 3: BTree prefix with numeric keys ===');

{
    const tree = new BTree(64, false);
    const keys = [1, 2, 10, 20, 100, 200, 1000, 2000];
    for (const key of keys) tree.insert(key, key);

    const result = tree.prefix('1');
    ok('Bug3: prefix "1" finds 1', result.includes(1));
    ok('Bug3: prefix "1" finds 10', result.includes(10));
    ok('Bug3: prefix "1" finds 100', result.includes(100));
    ok('Bug3: prefix "1" finds 1000', result.includes(1000));
    ok('Bug3: prefix "1" excludes 2', !result.includes(2));
    ok('Bug3: prefix "1" excludes 20', !result.includes(20));
    ok('Bug3: prefix "1" excludes 200', !result.includes(200));
    ok('Bug3: prefix "1" excludes 2000', !result.includes(2000));
}

{
    const tree = new BTree(64, false);
    const keys = [2, 20, 200, 2000, 3, 30, 300];
    for (const key of keys) tree.insert(key, key);

    const result = tree.prefix('2');
    ok('Bug3: prefix "2" finds 2', result.includes(2));
    ok('Bug3: prefix "2" finds 20', result.includes(20));
    ok('Bug3: prefix "2" finds 200', result.includes(200));
    ok('Bug3: prefix "2" finds 2000', result.includes(2000));
    ok('Bug3: prefix "2" excludes 3', !result.includes(3));
}

{
    const tree = new BTree(64, false);
    const keys = ['apple', 'application', 'apply', 'banana', 'cherry'];
    for (const key of keys) tree.insert(key, key);

    const result = tree.prefix('app');
    ok('Bug3: string prefix finds apple', result.includes('apple'));
    ok('Bug3: string prefix finds application', result.includes('application'));
    ok('Bug3: string prefix finds apply', result.includes('apply'));
    ok('Bug3: string prefix excludes banana', !result.includes('banana'));
}

{
    const tree = new BTree(4, false);
    for (let i = 1; i <= 100; i++) tree.insert(i, i);

    // Prefix '1' should match: 1, 10-19, 100
    const result = tree.prefix('1');
    ok('Bug3: multi-leaf prefix "1" finds 1', result.includes(1));
    ok('Bug3: multi-leaf prefix "1" finds 10', result.includes(10));
    ok('Bug3: multi-leaf prefix "1" finds 11', result.includes(11));
    ok('Bug3: multi-leaf prefix "1" finds 19', result.includes(19));
    ok('Bug3: multi-leaf prefix "1" finds 100', result.includes(100));

    // Prefix '9' should match: 9, 90-99
    const result9 = tree.prefix('9');
    ok('Bug3: multi-leaf prefix "9" finds 9', result9.includes(9));
    ok('Bug3: multi-leaf prefix "9" finds 90', result9.includes(90));
    ok('Bug3: multi-leaf prefix "9" finds 99', result9.includes(99));
}

{
    const tree = new BTree(64, false);
    tree.insert(1, 1);
    tree.insert(2, 2);
    tree.insert(3, 3);

    const result = tree.prefix('9');
    ok('Bug3: non-matching prefix returns empty', result.length === 0);
}

{
    const tree = new BTree(64, false);
    tree.insert('a.b', 1);
    tree.insert('a*b', 2);
    tree.insert('a+b', 3);
    tree.insert('abc', 4);

    const result = tree.prefix('a');
    ok('Bug3: special chars prefix finds a.b', result.includes(1));
    ok('Bug3: special chars prefix finds a*b', result.includes(2));
    ok('Bug3: special chars prefix finds a+b', result.includes(3));
    ok('Bug3: special chars prefix finds abc', result.includes(4));
}

// ============================================================
// Summary
// ============================================================
console.log('\n========================================');
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
else console.log('All tests passed!');
