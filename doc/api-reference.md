# API 参考

## Database

```js
const { Database } = require('jsql-neo');
// 内存模式
const db = new Database(':memory:');
// 磁盘模式
const db = new Database('./data/app');
// 混合模式（LRU + 异步刷盘）
const db = new Database('./data', { autoSave: true, saveInterval: 3000 });
```

### 构造函数选项

```ts
interface DatabaseOptions {
  autoSave?: boolean;      // 启用自动保存，默认 false
  saveInterval?: number;   // 自动保存间隔(ms)，默认 5000
  pageSize?: number;       // 页面大小，默认 4096
  cacheSize?: number;      // 缓存大小（页数），默认 1024
  wasm?: boolean;          // 强制使用 WASM 引擎，默认 false
  password?: string;       // 数据库密码
}
```

### 初始化 / 停止

```js
await db.init();      // 初始化（构造函数已自动调用）
await db.stop();      // 停止并保存数据
await db.backup('./backup.json');  // 备份
await db.restore('./backup.json'); // 恢复
```

### 表操作

```js
await db.createTable(name, schema);
await db.dropTable(name);
await db.truncateTable(name);
await db.renameTable(oldName, newName);
await db.listTables();              // → string[]
await db.getTableSchema(name);       // → TableSchema
await db.getTableStats(name);        // → { rows, size, indexes }
```

### 数据操作

```js
await db.insert(table, row);
await db.insertMany(table, rows);
await db.find(table, filter, options);
await db.findOne(table, filter);
await db.update(table, filter, changes);
await db.updateById(table, id, changes);
await db.removeWhere(table, filter);
await db.removeById(table, id);
```

### 链式查询

```js
const result = await db.query(table)
  .select(['id', 'name'])
  .where({ age: { $gte: 18 } })
  .orderBy('name')
  .limit(10)
  .offset(0)
  .run();
```

### 聚合管道

```js
await db.aggregate(table, [
  { $match: { status: 'active' } },
  { $group: { _id: '$dept', total: { $sum: '$salary' } } },
  { $sort: { total: -1 } },
  { $limit: 5 }
]);
```

### 事务

```js
await db.beginTransaction();
try {
  await db.insert('accounts', { id: 1, balance: 1000 });
  await db.update('accounts', { id: 1 }, { balance: 900 });
  await db.commit();
} catch (e) {
  await db.rollback();
}
```

### 索引

```js
await db.createIndex(table, { column: 'email', unique: true });
await db.createIndex(table, { column: 'name' });         // 普通索引
await db.createIndex(table, { columns: ['a', 'b'] });  // 联合索引
await db.dropIndex(table, 'idx_email');
await db.listIndexes(table);
```

### SQL 执行

```js
const { Database, executeSQL } = require('jsql-neo');
const db = new Database(':memory:');
await executeSQL(db, "INSERT INTO users (name) VALUES ('Alice')");
const { rows, fields } = await executeSQL(db, "SELECT * FROM users WHERE id = ?", [1]);
```

## Table

```js
const table = db.getTable('users');
await table.count();
await table.stats();
await table.exportJSON();
```

## QueryBuilder

```js
const { QueryBuilder } = require('jsql-neo');
const q = new QueryBuilder('users')
  .select(['id', 'name', 'email'])
  .where({ age: { $gte: 18, $lt: 65 } })
  .orderBy('name', 'DESC')
  .limit(20)
  .offset(0);
const sql = q.toSQL();  // → { text, values }
```

详见完整 [README.md](../README.md) 中的完整 API 文档。
