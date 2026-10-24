# API 参考

## Database

```js
const { Database } = require('jsql-neo');

// 内存模式
const mem = new Database(':memory:');

// 磁盘模式（目录存储，stop() 时自动刷盘）
const disk = new Database('./data/app', { mode: 'disk' });

// 混合模式（LRU + 异步刷盘）
const hybrid = new Database('./data', { mode: 'hybrid', autoSave: true, autoSaveInterval: 3000 });

// 旧版单文件 JSON 模式（需显式 save() / flush() / close() 落盘，stop() 不落盘）
const legacy = new Database('./data/db.json');

// 下面各节示例统一使用这个内存库
const db = new Database(':memory:');
```

### 构造函数选项

```ts
interface DatabaseOptions {
  mode?: 'memory' | 'hybrid' | 'disk';              // 存储模式，默认 memory
  autoSave?: boolean;                               // 旧文件模式自动保存，默认 true
  autoSaveInterval?: number;                        // 旧文件模式自动保存间隔 ms，默认 0（每次写立即存）
  memReserveMB?: number;                            // 混合模式预留内存 MB，默认 512
  flushInterval?: number;                           // 混合/磁盘模式刷盘间隔 ms，默认 hybrid 200 / disk 50
  encryptKey?: string;                              // AES-256-CBC 密钥（16/24/32 字节）
  versioning?: boolean;                             // 行版本历史，默认 false
  wal?: boolean;                                    // WAL 模式，默认 false
  isolationLevel?: 'READ_COMMITTED' | 'REPEATABLE_READ'; // 默认 READ_COMMITTED
  slowQueryThreshold?: number;                      // 慢查询阈值 ms，默认 100，<0 禁用
  fileLock?: boolean;                               // 文件锁，默认 false
}
```

### 初始化 / 停止

构造函数即完成初始化，没有 `init()`；数据操作全部返回 Promise。

```js
await db.stop();                    // 停止（目录模式会自动刷盘）
await db.flush();                   // 手动刷盘（旧文件模式等价于 save()）
db.save();                          // 旧文件模式立即写盘
db.backup('./backup.json');         // 备份全部表为 JSON 文件
db.close();                         // 保存并清理定时器
```

恢复数据：`db.restore('./backup.json')` 只把行灌入**已存在**的表，所以要先 `createTable` 建好结构再 restore；内存里的整体导出/导入用 `db.export()` / `db.import(data)`。

### 表操作

```js
await db.createTable('posts', { title: { type: 'string' } });   // 建表
await db.truncate('posts');                                      // 清空表（不是 truncateTable）
await db.renameTable('posts', 'articles');                       // 改名
await db.dropTable('articles');                                  // 删表

await db.getTables();                 // → string[]（不是 listTables）
await db.getTableSchema('users');     // → TableSchema
db.stats();                           // → { tables, views, triggers, totalRows, ... }
```

### 数据操作

```js
await db.createTable('users', {
  id: { type: 'integer', primaryKey: true },
  name: { type: 'string' },
  age: { type: 'integer' },
});
await db.insertMany('users', [
  { id: 1, name: 'Alice', age: 30 },
  { id: 2, name: 'Bob', age: 17 },
]);

await db.insert('users', { id: 9, name: 'Dave', age: 25 });   // → 主键数组
await db.find('users', { age: { $gte: 18 } }, { limit: 10 }); // → Row[]
await db.findById('users', 1);                                // → Row | null
await db.count('users', { age: { $gte: 18 } });               // → number
await db.update('users', { name: 'Dave' }, { age: 26 });
await db.updateById('users', 9, { age: 27 });
await db.removeWhere('users', { name: 'Eve' });
await db.removeById('users', 9);
```

Database 上没有 `findOne`，取单行用 `(await db.find(table, filter))[0]` 或 `db.findById`。

### SQL 执行

```js
const { Database, executeSQL } = require('jsql-neo');
const db = new Database(':memory:');

await executeSQL(db, "CREATE TABLE users (id INT PRIMARY KEY AUTO_INCREMENT, name TEXT)");
await executeSQL(db, "INSERT INTO users (name) VALUES ('Alice')");

// 结果信封：{ ok, rows, columns, affectedRows, rowCount, message, durationMs, ... }
const { rows, columns } = await executeSQL(db, "SELECT * FROM users WHERE id = ?", [1]);

// Database 实例上的快捷方式（等价于 executeSQL(db, ...)）
const r = await db.query("SELECT name FROM users");
```

> `executeSQL` 默认拒绝 SQL 注释（`--`、`#`、`/* */`），需要时传 `{ safety: false }` 或 `{ allowComments: true }`。

### 链式查询（Query）

`Query` 接受一个 **Table 实例**（`db._tables[name]`），不是表名：

```js
const { Query } = require('jsql-neo');

const q = new Query(db._tables.users)
  .select(['id', 'name'])
  .where({ age: { $gte: 18 } })
  .orderBy('name')
  .limit(10)
  .offset(0);

q.get();      // → Row[]（执行）
q.first();    // → Row | null
q.count();    // → number
q.exists();   // → boolean
q.toSQL();    // → SQL 字符串（调试用）
```

导出类名是 `Query`，没有 `QueryBuilder`；`db.query()` 是执行 SQL，不返回查询构造器。

### 聚合

用 SQL 的 `GROUP BY` / 聚合函数：

```js
await db.createTable('employees', { dept: { type: 'string' }, salary: { type: 'integer' } });
await db.insertMany('employees', [
  { dept: 'eng', salary: 5000 },
  { dept: 'eng', salary: 4000 },
  { dept: 'ops', salary: 6000 },
]);

const { rows } = await db.query(`
  SELECT dept, COUNT(*) AS headcount, SUM(salary) AS total
  FROM employees
  GROUP BY dept
  HAVING COUNT(*) > 1
  ORDER BY total DESC
  LIMIT 5
`);
```

Database 上没有 `aggregate()` 方法。

### 事务

```js
await db.begin();
try {
  await db.insert('accounts', { id: 1, balance: 1000 });
  await db.update('accounts', { id: 1 }, { balance: 900 });
  await db.commit();
} catch (e) {
  await db.rollback();
}
```

方法名是 `begin` / `commit` / `rollback`（没有 `beginTransaction`）。保存点：

```js
await db.begin();
await db.savepoint('sp1');
await db.rollbackTo('sp1');
await db.releaseSavepoint('sp1');
await db.listSavepoints();   // → string[]
await db.commit();
```

### 索引

索引通过 SQL 创建（Database 上没有 `createIndex` / `dropIndex` / `listIndexes`）：

```js
await db.createTable('orders', { user_id: { type: 'integer' }, email: { type: 'string' }, created_at: { type: 'string' } });

await db.query("CREATE UNIQUE INDEX idx_email ON orders(email)");
await db.query("CREATE INDEX idx_composite ON orders(user_id, created_at)");
await db.query("DROP INDEX idx_email ON orders");
```

## Table

```js
const table = db._tables.users;      // Table 实例
await table.count();                 // → number
await table.findOne({ name: 'Alice' });
await table.findById(1);
await table.describe();              // → 表结构
table.toJSON();                      // → Row[]
await table.createIndex('email');    // 字段级索引
await table.dropIndex('email');
```

详见完整 [README.md](../README.md) 中的完整 API 文档。
