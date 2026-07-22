```
                                                                                                                                                                     
                                                                                                                                                                     
          JJJJJJJJJJJ   SSSSSSSSSSSSSSS      QQQQQQQQQ     LLLLLLLLLLL                                                                                               
          J:::::::::J SS:::::::::::::::S   QQ:::::::::QQ   L:::::::::L                                                                                               
          J:::::::::JS:::::SSSSSS::::::S QQ:::::::::::::QQ L:::::::::L                                                                                               
          JJ:::::::JJS:::::S     SSSSSSSQ:::::::QQQ:::::::QLL:::::::LL                                                                                               
            J:::::J  S:::::S            Q::::::O   Q::::::Q  L:::::L                                          nnnn  nnnnnnnn        eeeeeeeeeeee       ooooooooooo   
            J:::::J  S:::::S            Q:::::O     Q:::::Q  L:::::L                                          n:::nn::::::::nn    ee::::::::::::ee   oo:::::::::::oo 
            J:::::J   S::::SSSS         Q:::::O     Q:::::Q  L:::::L                                          n::::::::::::::nn  e::::::eeeee:::::eeo:::::::::::::::o
            J:::::j    SS::::::SSSSS    Q:::::O     Q:::::Q  L:::::L                     ---------------      nn:::::::::::::::ne::::::e     e:::::eo:::::ooooo:::::o
            J:::::J      SSS::::::::SS  Q:::::O     Q:::::Q  L:::::L                     -:::::::::::::-        n:::::nnnn:::::ne:::::::eeeee::::::eo::::o     o::::o
JJJJJJJ     J:::::J         SSSSSS::::S Q:::::O     Q:::::Q  L:::::L                     ---------------        n::::n    n::::ne:::::::::::::::::e o::::o     o::::o
J:::::J     J:::::J              S:::::SQ:::::O  QQQQ:::::Q  L:::::L                                            n::::n    n::::ne::::::eeeeeeeeeee  o::::o     o::::o
J::::::J   J::::::J              S:::::SQ::::::O Q::::::::Q  L:::::L         LLLLLL                             n::::n    n::::ne:::::::e           o::::o     o::::o
J:::::::JJJ:::::::J  SSSSSSS     S:::::SQ:::::::QQ::::::::QLL:::::::LLLLLLLLL:::::L                             n::::n    n::::ne::::::::e          o:::::ooooo:::::o
 JJ:::::::::::::JJ   S::::::SSSSSS:::::S QQ::::::::::::::Q L::::::::::::::::::::::L                             n::::n    n::::n e::::::::eeeeeeee  o:::::::::::::::o
   JJ:::::::::JJ     S:::::::::::::::SS    QQ:::::::::::Q  L::::::::::::::::::::::L                             n::::n    n::::n  ee:::::::::::::e   oo:::::::::::oo 
     JJJJJJJJJ        SSSSSSSSSSSSSSS        QQQQQQQQ::::QQLLLLLLLLLLLLLLLLLLLLLLLL                             nnnnnn    nnnnnn    eeeeeeeeeeeeee     ooooooooooo   
                                                     Q:::::Q                                                                                                         
                                                      QQQQQQ                                                                                                         
```

# JSQL-NEO

**Pure JavaScript Embedded Database — SQL 风格 API，零原生依赖，JSON 文件存储**

[![npm version](https://img.shields.io/npm/v/jsql-neo.svg)](https://www.npmjs.com/package/jsql-neo)
[![license](https://img.shields.io/npm/l/jsql-neo.svg)](https://github.com/vexify-org/jsql-neo/blob/main/LICENSE)
[![node](https://img.shields.io/node/v/jsql-neo.svg)](https://nodejs.org/)

> **v2.0.0** — B-Tree 索引、哈希 JOIN、WAL 日志、事务隔离、MySQL 风格错误码

---

## 快速开始

```bash
npm install jsql-neo
```

```javascript
const jsql = require('jsql-neo');

// 内存模式
const db = new jsql.Database(':memory:');

// 文件模式（带 WAL + 文件锁）
const db = new jsql.Database('mydb.json', {
  wal: true,
  fileLock: true,
  isolationLevel: 'REPEATABLE_READ',
  slowQueryThreshold: 100
});

// 创建表（自动为 primaryKey 和 unique 字段建 B-Tree 索引）
db.createTable('users', {
  id: { type: 'integer', primaryKey: true, autoIncrement: true },
  name: { type: 'string', required: true, length: 50 },
  email: { type: 'string', unique: true },
  age: { type: 'integer', min: 0, max: 150 },
  createdAt: { type: 'datetime', default: 'CURRENT_TIMESTAMP' }
});

// 插入
db.users.insert({ name: 'Alice', email: 'alice@example.com', age: 25 });

// 主键查询（B-Tree 加速，O(log n)）
db.users.findById(1);

// 链式查询
db.users.where({ age: { $gte: 18 } })
  .orderBy('name')
  .limit(10)
  .get();
```

---

## v2.0.0 核心特性

### 🔴 B-Tree 索引引擎

自动为 `primaryKey` 和 `unique` 字段创建 B-Tree 索引，查询复杂度从 O(n) 降至 O(log n)。

```javascript
// 自动 B-Tree（无需手动创建）
db.createTable('users', {
  id: { type: 'integer', primaryKey: true, autoIncrement: true },
  email: { type: 'string', unique: true }
});
// → 自动为 id 和 email 字段建 B-Tree

// 手动创建 B-Tree 索引
db.users.createBTreeIndex('name');

// 范围查询（B-Tree 加速）
db.users.where({ age: { $gte: 18, $lte: 60 } }).get();
```

### 🔴 事务隔离

支持 `READ_COMMITTED` 和 `REPEATABLE_READ` 两级隔离。

```javascript
// REPEATABLE_READ：快照隔离
db.begin('REPEATABLE_READ');
db.users.insert({ name: 'Tx', email: 'tx@test.com' });
// ... 其他操作看到的是事务开始时的快照
db.rollback(); // 回滚所有变更

// READ_COMMITTED（默认）
db.begin();
db.users.insert({ name: 'Tx2', email: 'tx2@test.com' });
db.commit();

// 动态切换隔离级别
db.setIsolationLevel('REPEATABLE_READ');
```

### 🔴 文件锁 + WAL

```javascript
const db = new jsql.Database('mydb.json', {
  wal: true,       // Write-Ahead Logging，崩溃恢复
  fileLock: true   // 防止多进程同时写入
});
```

### 🟡 哈希 JOIN 优化

数据量 > 100 行时自动使用哈希 JOIN（O(n+m)），小数据量自动退化为嵌套循环。

```javascript
// JOIN 支持字符串表名（v2.0 新增）
db.posts.where({})
  .join('users', 'userId', 'id', 'author')
  .get();

// LEFT JOIN
db.posts.where({})
  .leftJoin('users', 'userId', 'id', 'author')
  .get();

// 手动指定 JOIN 策略
db.posts.where({})
  .useHashJoin()    // 强制哈希 JOIN
  .join('users', 'userId', 'id', 'author')
  .get();
```

### 🟡 外键约束

```javascript
db.createTable('posts', {
  id: { type: 'integer', primaryKey: true, autoIncrement: true },
  title: { type: 'string' },
  userId: { type: 'integer', foreignKey: {
    table: 'users',
    field: 'id',
    onDelete: 'cascade'   // cascade | set null | restrict
  } }
});

// 删除用户时自动级联删除其帖子
db.users.remove({ id: 1 });
```

### 🟡 MySQL 风格错误码

```javascript
try {
  db.users.insert({ email: 'alice@example.com' }); // 重复
} catch (e) {
  e.code;    // 1062 (ER_DUP_ENTRY)
  e.message; // "Duplicate entry 'alice@example.com' for key 'email'"
  e.toJSON(); // { error: true, code: 1062, message: '...', details: {...} }
}
```

错误码速查：

| 错误码 | 名称 | 含义 |
|--------|------|------|
| 1048 | ER_BAD_NULL_ERROR | 列不能为 NULL |
| 1062 | ER_DUP_ENTRY | 唯一键冲突 |
| 1216 | ER_NO_REFERENCED_ROW | 外键约束失败 |
| 1292 | ER_TRUNCATED_WRONG_VALUE | 数据类型错误 |
| 1406 | ER_DATA_TOO_LONG | 数据超长 |
| 3819 | ER_CHECK_CONSTRAINT | CHECK 约束违反 |
| 1568 | ER_TRANSACTION_ACTIVE | 事务已在进行中 |
| 1569 | ER_NO_TRANSACTION | 无活跃事务 |

### 🟡 日期类型

```javascript
db.createTable('events', {
  id: { type: 'integer', primaryKey: true, autoIncrement: true },
  eventDate: { type: 'date' },         // YYYY-MM-DD
  eventTime: { type: 'datetime' },     // YYYY-MM-DD HH:MM:SS
  timestamp: { type: 'timestamp' },    // Unix 时间戳
  duration: { type: 'time' }           // HH:MM:SS
});
```

### 🟢 慢查询日志

```javascript
const db = new jsql.Database('mydb.json', { slowQueryThreshold: 50 });
// 所有 > 50ms 的查询自动记录

// 查看慢查询
db.getSlowQueries(20);  // 最近 20 条

// 清空日志
db.clearSlowQueries();

// 动态调整阈值
db.setSlowQueryThreshold(200);
```

---

## 完整 API

### Database

```javascript
const db = new jsql.Database(filePath, options);
```

| 选项 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `autoSave` | boolean | true | 自动保存 |
| `autoSaveInterval` | number | 0 | 自动保存间隔（ms） |
| `pretty` | boolean | true | JSON 格式化 |
| `encryptKey` | string | null | AES-256-CBC 加密密钥 |
| `versioning` | boolean | false | 版本历史 |
| `wal` | boolean | false | WAL 模式 |
| `fileLock` | boolean | false | 文件锁 |
| `isolationLevel` | string | 'READ_COMMITTED' | 事务隔离级别 |
| `slowQueryThreshold` | number | 100 | 慢查询阈值（ms），0 禁用 |

#### 表管理

```javascript
db.createTable(name, schema)     // 创建表
db.dropTable(name)               // 删除表
db.hasTable(name)                // 是否存在
db.getTables()                   // 获取所有表名
```

#### 事务

```javascript
db.begin(isolationLevel?)        // 开始事务
db.commit()                      // 提交
db.rollback()                    // 回滚
db.inTransaction()               // 是否在事务中
db.getIsolationLevel()           // 获取隔离级别
db.setIsolationLevel(level)      // 设置隔离级别
```

#### 视图

```javascript
db.createView('adults', db => db.users.where({ age: { $gte: 18 } }));
db.dropView('adults');
db.getViews();
```

#### 触发器

```javascript
db.createTrigger('log_insert', {
  event: 'insert',
  table: 'users',
  timing: 'after'
}, (data) => { console.log('New user:', data); });

db.dropTrigger('log_insert');
db.getTriggers();
```

#### 备份 / 恢复

```javascript
db.backup('backup.json')         // 备份到文件
db.restore('backup.json')        // 从文件恢复
db.export()                      // 导出为 JSON 对象
db.import(data)                  // 导入 JSON 对象
```

#### 统计 & 监控

```javascript
db.stats()                       // 数据库统计
db.getSlowQueries()              // 慢查询日志
db.clearSlowQueries()            // 清空慢查询日志
db.setSlowQueryThreshold(ms)     // 设置慢查询阈值
```

#### 插件 & 迁移

```javascript
db.use(plugin)                   // 注册插件
db.addMigration({ version, name, up, down })  // 注册迁移
db.migrate(version)              // 执行迁移
```

#### 变更监听

```javascript
const unsubscribe = db.onChange(event => {
  console.log(event.type, event.table, event.data);
});

// 变更流（异步迭代器）
const stream = db.createChangeStream();
for await (const event of stream) { /* ... */ }
stream.close();
```

#### 多数据库

```javascript
db.attach('other', otherDb)      // 附加数据库
db.detach('other')               // 分离
db.getAttached()                 // 查看已附加的数据库
```

### Table

```javascript
// 插入
table.insert(data)               // 插入单行
table.insertMany([data, ...])    // 批量插入
table.upsert(data)               // 存在则更新，否则插入

// 查询
table.find(query)                // 条件查询
table.findOne(query)             // 查单条
table.findById(id)               // 主键查询（B-Tree 加速）
table.findAll()                  // 全表查询
table.count(query)               // 计数
table.where(conditions)          // 返回 Query 链式构建器

// 更新
table.update(query, updates)     // 条件更新
table.updateById(id, updates)    // 主键更新

// 删除
table.remove(query)              // 条件删除

// 索引
table.createBTreeIndex(field)    // 创建 B-Tree 索引
table.createIndex(field)         // 创建 Hash 索引
table.dropIndex(field)           // 删除索引

// Schema
table.addColumn(name, def)       // 添加列
table.dropColumn(name)           // 删除列
table.renameColumn(old, new)     // 重命名列

// 钩子
table.on('beforeInsert', fn)     // 注册钩子
table.off('beforeInsert', fn)    // 移除钩子
```

### Query

```javascript
db.users.where({ age: { $gte: 18 } })  // 条件
  .select(['name', 'age'])              // 字段选择
  .orderBy('name')                      // 排序
  .orderByDesc('age')                   // 降序
  .limit(10)                            // 限制行数
  .offset(20)                           // 偏移
  .distinct('age')                      // 去重
  .groupBy('city')                      // 分组
  .having({ count: { $gt: 5 } })        // 分组过滤
  .join('posts', 'id', 'userId')        // INNER JOIN
  .leftJoin('posts', 'id', 'userId')    // LEFT JOIN
  .rightJoin('posts', 'id', 'userId')   // RIGHT JOIN
  .union(otherQuery)                    // UNION
  .window('rowNumber', 'name')          // 窗口函数
  .case([{ when: { age: { $lt: 18 } }, then: 'minor' }], 'adult')
    .as('ageGroup')                     // CASE WHEN
  .cache(30000)                          // 查询缓存
  .explain()                            // 执行计划
  .toSQL()                              // 导出 SQL 字符串
  .useHashJoin()                        // 强制哈希 JOIN
  .useNestedLoop()                      // 强制嵌套循环

  // 执行
  .get()                                // 获取结果
  .first()                              // 第一条
  .count()                              // 计数
  .sum('age')                           // 求和
  .avg('age')                           // 平均
  .min('age')                           // 最小
  .max('age')                           // 最大
  .groupStats('age')                    // 分组统计
  .paginate(1, 20)                      // 分页
  .update({ name: 'New' })              // 条件更新
  .remove()                             // 条件删除
  .invalidateCache()                    // 清除缓存
```

### Schema 定义

```javascript
{
  fieldName: {
    type: 'integer' | 'string' | 'number' | 'boolean' | 'array' | 'object' |
          'date' | 'datetime' | 'timestamp' | 'time' | 'any',
    primaryKey: true,
    autoIncrement: true,
    required: true,
    unique: true,
    default: '默认值',
    length: 50,              // 字符串最大长度
    min: 0,                  // 数值最小值
    max: 150,                // 数值最大值
    check: v => v >= 18,     // 自定义校验函数
    foreignKey: {
      table: 'users',
      field: 'id',
      onDelete: 'cascade',   // cascade | set null | restrict
      onUpdate: 'restrict'
    },
    computed: row => `prefix_${row.id}`  // 计算字段
  }
}
```

### 操作符

| 操作符 | 说明 | 示例 |
|--------|------|------|
| `$eq` | 等于 | `{ age: { $eq: 25 } }` |
| `$ne` | 不等于 | `{ age: { $ne: 25 } }` |
| `$gt` | 大于 | `{ age: { $gt: 18 } }` |
| `$gte` | 大于等于 | `{ age: { $gte: 18 } }` |
| `$lt` | 小于 | `{ age: { $lt: 60 } }` |
| `$lte` | 小于等于 | `{ age: { $lte: 60 } }` |
| `$in` | 在列表中 | `{ status: { $in: ['a', 'b'] } }` |
| `$nin` | 不在列表中 | `{ status: { $nin: ['x', 'y'] } }` |
| `$like` | 模糊匹配 | `{ name: { $like: 'Ali' } }` |
| `$regex` | 正则匹配 | `{ email: { $regex: /@gmail\.com$/ } }` |
| `$between` | 区间 | `{ age: { $between: [18, 60] } }` |
| `$null` | 是否为 null | `{ deletedAt: { $null: true } }` |
| `$notNull` | 是否非 null | `{ name: { $notNull: true } }` |
| `$or` | 或 | `{ $or: [{age: 18}, {age: 21}] }` |
| `$and` | 且 | `{ $and: [{age: {$gte: 18}}, {age: {$lte: 60}}] }` |
| `$inSub` | 子查询 IN | `{ $inSub: { query: q, field: 'id' } }` |
| `$notInSub` | 子查询 NOT IN | `{ $notInSub: { query: q, field: 'id' } }` |
| `$expr` | 表达式 | `{ $expr: row => row.a > row.b }` |

### EXPLAIN 输出示例

```javascript
db.users.where({ id: 3 }).explain().get();
// {
//   table: 'users',
//   totalRows: 5000,
//   filteredRows: 1,
//   selectivity: '0.02%',
//   hasBTree: true,
//   indexUsed: 'id',
//   btreeIndexes: ['id', 'email'],
//   estimatedCost: 0.05,
//   joins: []
// }
```

---

## 内存模式 vs 文件模式

| 特性 | 内存模式 | 文件模式 |
|------|----------|----------|
| 初始化 | `new Database(':memory:')` | `new Database('db.json')` |
| 持久化 | 无 | 自动保存 |
| B-Tree 索引 | ✅ | ✅ |
| 事务隔离 | ✅ | ✅ |
| WAL | ❌（自动禁用） | ✅ |
| 文件锁 | ❌（自动禁用） | ✅ |
| 加密存储 | ❌ | ✅ |
| 慢查询日志 | ✅ | ✅ |

---

## 与 MySQL 对比

| 特性 | JSQL-NEO v2.0 | MySQL 8.0 |
|------|---------------|-----------|
| 索引 | B-Tree（O(log n)） | B-Tree（O(log n)） |
| 事务隔离 | READ_COMMITTED / REPEATABLE_READ | 4 级 |
| 并发控制 | 文件锁 | MVCC + 锁 |
| 外键 | CASCADE / SET NULL / RESTRICT | ✅ |
| 错误码 | 25+ MySQL 兼容 | 完整 |
| JOIN | 哈希 / 嵌套循环 | 基于代价 |
| 子查询 | ✅ | ✅ |
| 窗口函数 | ROW_NUMBER / RANK / DENSE_RANK | 完整 |
| 存储引擎 | JSON 文件 | InnoDB / MyISAM |
| 零依赖 | ✅ | ❌ |
| 嵌入 Node.js | ✅ | ❌（需驱动） |

---

## 许可

Apache License 2.0 — © Vexify 2026