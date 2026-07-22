const jsql = require('./index');

let db;

function reset() {
    db = new jsql.Database(':memory:');
}

let passed = 0;
let failed = 0;

function assert(condition, message) {
    const result = typeof condition === 'function' ? condition() : condition;
    if (result) {
        console.log('✅', message);
        passed++;
    } else {
        console.log('❌', message);
        failed++;
    }
}

function assertThrows(fn, message) {
    try {
        fn();
        console.log('❌', message);
        failed++;
    } catch (e) {
        console.log('✅', message);
        passed++;
    }
}

console.log('========================================');
console.log('jsql-neo Bug 修复验证测试');
console.log('========================================\n');

console.log('=== Bug 2: NOT NULL 检查 ===');
reset();
db.createTable('users', { 
    id: { type: 'integer', primaryKey: true },
    name: { type: 'string', required: true },
    email: { type: 'string' }
});

assertThrows(() => db.users.insert({}), '插入缺少必填字段 name 应该报错');
assertThrows(() => db.users.insert({ name: null }), '插入 null 作为必填字段应该报错');
assertThrows(() => db.users.insert({ name: undefined }), '插入 undefined 作为必填字段应该报错');
assert(() => db.users.insert({ name: 'Alice' }).name === 'Alice', '插入包含必填字段的数据应该成功');
assert(() => db.users.count() === 1, '记录数应为 1');

console.log('\n=== Bug 3: UNIQUE 约束 ===');
reset();
db.createTable('users', { 
    id: { type: 'integer', primaryKey: true, autoIncrement: true },
    email: { type: 'string', unique: true }
});

assert(() => db.users.insert({ email: 'a@b.com' }).email === 'a@b.com', '第一次插入唯一字段应该成功');
assertThrows(() => db.users.insert({ email: 'a@b.com' }), '插入重复的唯一字段应该报错');
assert(() => db.users.count() === 1, '记录数应为 1');

console.log('\n=== Bug 4: DISTINCT 实现 ===');
reset();
db.createTable('users', { name: { type: 'string' }, age: { type: 'integer' } });
db.users.insert({ name: 'Alice', age: 25 });
db.users.insert({ name: 'Bob', age: 30 });
db.users.insert({ name: 'Alice', age: 25 });
db.users.insert({ name: 'Charlie', age: 25 });

assert(() => db.users.where().distinct().get().length === 3, 'distinct() 不传参数应去重完整行');
assert(() => db.users.where().distinct('age').get().length === 2, 'distinct("age") 按年龄去重');
assert(() => db.users.where().distinct('name').get().length === 3, 'distinct("name") 按名字去重');
assert(() => db.users.where().select('age').distinct().get().length === 2, 'select + distinct() 不传参数');
assert(() => db.users.where().select('age').distinct('age').get().length === 2, 'select + distinct(field)');

console.log('\n=== Bug 5: JOIN 字符串参数 ===');
reset();
db.createTable('posts', { 
    id: { type: 'integer', primaryKey: true }, 
    userId: { type: 'integer' },
    title: { type: 'string' }
});
db.createTable('authors', { 
    id: { type: 'integer', primaryKey: true }, 
    name: { type: 'string' }
});
db.posts.insert({ userId: 1, title: 'Post 1' });
db.posts.insert({ userId: 2, title: 'Post 2' });
db.posts.insert({ userId: 1, title: 'Post 3' });
db.authors.insert({ id: 1, name: 'Alice' });
db.authors.insert({ id: 3, name: 'Charlie' });

const innerJoinResult = db.posts.where().join('authors', 'userId', 'id', 'author').get();
assert(() => innerJoinResult.length === 2, 'INNER JOIN 字符串参数');
assert(() => innerJoinResult[0].author_name === 'Alice', 'JOIN 结果应包含别名字段');

const leftJoinResult = db.posts.where().leftJoin('authors', 'userId', 'id', 'author').get();
assert(() => leftJoinResult.length === 3, 'LEFT JOIN 字符串参数');
assert(() => leftJoinResult[1].author_name === null, 'LEFT JOIN 应包含未匹配的行');

const rightJoinResult = db.posts.where().rightJoin('authors', 'userId', 'id', 'author').get();
assert(() => rightJoinResult.length === 3, 'RIGHT JOIN 字符串参数');

assertThrows(() => db.posts.where().join('nonexistent', 'userId', 'id', 'author').get(), 'JOIN 不存在的表应该报错');

console.log('\n=== 原有的 Table 对象参数 JOIN 仍然有效 ===');
reset();
db.createTable('posts', { id: { type: 'integer', primaryKey: true }, userId: { type: 'integer' } });
db.createTable('users', { id: { type: 'integer', primaryKey: true }, name: { type: 'string' } });
db.posts.insert({ userId: 1 });
db.users.insert({ id: 1, name: 'Alice' });

const tableObjResult = db.posts.where().join(db.users, 'userId', 'id', 'author').get();
assert(() => tableObjResult.length === 1, '使用 Table 对象 JOIN');
assert(() => tableObjResult[0].author_name === 'Alice', 'JOIN 结果正确');

console.log('\n=== 额外测试：UPDATE 签名（Bug 1 参考） ===');
reset();
db.createTable('users', { id: { type: 'integer', primaryKey: true }, name: { type: 'string' }, age: { type: 'integer' } });
db.users.insert({ id: 1, name: 'Alice', age: 25 });
db.users.insert({ id: 2, name: 'Bob', age: 30 });
db.users.insert({ id: 3, name: 'Alice', age: 35 });

const updated = db.users.update({ name: 'Alice' }, { age: 26 });
assert(() => updated === 2, '条件更新应返回受影响行数');
assert(() => db.users.findById(1).age === 26, '第一条记录年龄已更新');
assert(() => db.users.findById(3).age === 26, '第三条记录年龄已更新');
assert(() => db.users.findById(2).age === 30, '第二条记录未被更新');

const queryUpdate = db.users.where({ name: 'Bob' }).update({ age: 31 });
assert(() => queryUpdate === 1, '链式查询更新应返回受影响行数');
assert(() => db.users.findById(2).age === 31, '链式查询更新成功');

console.log('\n=== 额外测试：CHECK 约束 ===');
reset();
db.createTable('users', { 
    id: { type: 'integer', primaryKey: true },
    age: { type: 'integer', check: v => v >= 0 && v <= 150 }
});

assert(() => db.users.insert({ age: 25 }).age === 25, '合法年龄应该插入成功');
assertThrows(() => db.users.insert({ age: -1 }), '负数年龄应该报错');
assertThrows(() => db.users.insert({ age: 200 }), '超过150岁应该报错');

console.log('\n========================================');
console.log(`测试结果: ${passed} 个通过, ${failed} 个失败`);
console.log('========================================');

if (failed > 0) {
    process.exit(1);
}