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

// 旧版单文件 JSON 模式（每次写入即 append 到 .wal，fsync 按窗口合并，save()/close() 只做检查点）
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
  wal?: boolean;                                    // 旧文件模式 WAL，默认 true；传 false 退回旧语义
  walCheckpointOps?: number;                        // WAL 累积多少条后自动检查点，默认 1000，0 禁用
  isolationLevel?: 'READ_COMMITTED' | 'REPEATABLE_READ'; // 默认 READ_COMMITTED
  slowQueryThreshold?: number;                      // 慢查询阈值 ms，默认 100，<0 禁用
  fileLock?: boolean;                               // 文件锁，默认 false
}
```

### 初始化 / 停止

构造函数即完成初始化，没有 `init()`；数据操作全部返回 Promise。

```js
await db.stop();                    // 停止（目录模式会自动刷盘；旧文件模式做一次检查点）
await db.flush();                   // 手动刷盘（旧文件模式等价于 save()）
db.save();                          // 旧文件模式：写快照并清空 WAL（检查点）
db.backup('./backup.json');         // 备份全部表为 JSON 文件
db.close();                         // 保存并清理定时器
```

### 持久化与 WAL

单文件模式（`new Database('./data/db.json')`）不是「内存中改完、退出时才落盘」。
每次写入都会在处理该次变更时立刻往 `<file>.wal` 追加一条 JSONL 并 `write()` 到内核，
覆盖 `insert` / `insertMany` / `update` / `updateById` / `remove` / `removeById` /
`softDelete` / `truncate`，所以进程被 `kill -9` 也不会丢已完成的写入。
`fsync` 默认按 `walSyncInterval`（20ms）窗口合并，避免逐条刷盘；传 `0` 恢复逐条同步
（最严格，约为合并模式的 1/10 吞吐）。`save()` / `close()` / `stop()` 会先补齐窗口内未刷写的数据。

- **检查点**：`save()` / `close()` / `stop()` / 目录模式 `flush()` 会把当前全量数据写成快照，
  然后清空 WAL。这只影响恢复速度，不影响数据是否已经落盘。
- **自动检查点**：WAL 累积 `walCheckpointOps` 条（默认 1000）后自动跑一次快照，防止日志无限增长；
  事务进行中会跳过。设为 `0` 关闭。
- **回放**：启动时读快照 + 按 `sequence` 顺序重放 WAL，按主键幂等覆盖，不会重复插行；
  崩溃时写了一半的尾行会被丢弃。
- **例外**：`mode: 'hybrid' | 'disk'`（目录存储）和设置了 `encryptKey` 的加密库默认**不**开 WAL
  （WAL 是明文），需要显式传 `wal: true`。传 `wal: false` 则退回旧的「内存态 + 退出时 `save()`」语义。

```js
const db = new Database('./data/db.json', { walCheckpointOps: 5000 }); // 更少快照、更长 WAL
const plain = new Database('./data/db.json', { wal: false });         // 旧语义
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
>
> 自 v6.5.16 起，安全模式默认**单语句**：一次调用的语句条数超过 `maxStatements`（默认 `1`）即拦截；需要一次执行多条语句时显式传 `{ maxStatements: <n> }`，或等价的 `{ allowStacked: true }`。同时拒绝无 WHERE 的 `DROP` / `TRUNCATE` / `DELETE` / `UPDATE`（含 `WITH ... DELETE`）。需要写入时显式传 `{ allowWrites: true }`（服务端协议层已默认放行写入），或 `{ safety: false }` 关闭全部安全检查。

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

## 插件与 XQL

```js
await db.use('xql');                     // 启用内置 XQL 插件（v6.5.12+）
await db.xqlIndex('users', 'id');        // hash / range 索引
await db.xqlRefresh('users');
const rows = await db.xql('FROM users |> WHERE id == 1 |> LIMIT 10');
await db.xqlClear();
```

其他 API：`xqlLoad()` / `xqlTables()` / `xqlCollection()` / `xqlIndex()` / `xqlRefresh()` / `xqlClear()`。写入会自动使索引失效，下次查询时重建。插件也可通过 `jsql plugin install <name>` 从注册表安装。

## 兼容层（jsql 1.0.0）

```js
const { compatV1 } = require('jsql-neo/compat/v1');
const db = compatV1('./data/app');   // 包装 Database
```

`V1Database` 把 `createTable` / `dropTable` 变为同步、镜像 `db.<table>` 访问器；`import` 可从行推断 schema 并恢复自增主键，`export` 返回深拷贝。v6 的 `Table` / `Query` 本就同步且签名与 1.0.0 一致，因此兼容层只补齐建表/删表与表访问器。

详见完整 [README.md](../README.md) 中的完整 API 文档。
