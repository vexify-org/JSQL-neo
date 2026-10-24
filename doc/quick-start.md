# 快速开始

## 安装

```bash
npm install jsql-neo
```

## 三行代码

```js
const { Database, executeSQL } = require('jsql-neo');

(async () => {
  const db = new Database(':memory:');
  await executeSQL(db, "CREATE TABLE users (id INT PRIMARY KEY AUTO_INCREMENT, name TEXT)");
  await executeSQL(db, "INSERT INTO users (name) VALUES ('Alice')");
  const { rows } = await executeSQL(db, "SELECT * FROM users");
  console.log(rows); // [[1, 'Alice']]
  db.stop();
})();
```

> CJS 里没有顶层 `await`，所以包一层 `async` IIFE；ESM 里可直接写 `await`。

## 内存模式 vs 磁盘模式

| 模式 | 用法 | 适用场景 |
|---|---|---|
| 内存 | `new Database(':memory:')` | 测试、缓存 |
| 磁盘 | `new Database('./data/app', { mode: 'disk' })` | 生产持久化 |
| 混合 | `new Database('./data', { mode: 'hybrid', autoSave: true, autoSaveInterval: 3000 })` | 平衡性能与持久化 |

## Web UI

```bash
npx jsql-neo ui --port 8080
```

然后打开 http://localhost:8080

## 多协议服务器

一个端口，同时服务 MySQL / PostgreSQL / MongoDB / Redis 客户端：

```bash
npx jsql-neo serve --port 3306
# MySQL 客户端: mysql -h 127.0.0.1 -P 3306
# PostgreSQL 客户端: psql -h 127.0.0.1 -p 3306
# MongoDB 客户端: mongosh mongodb://127.0.0.1:3306
# Redis 客户端: redis-cli -p 3306
```

## 浏览器 / WASM 模式

```js
import { JSQL } from 'jsql-neo/wasm/browser.mjs';

const db = new JSQL();
await db.start();

await db.createTable('users', {
  id: { type: 'integer', primaryKey: true },
  name: { type: 'string' },
});
await db.insert('users', { name: 'Alice' });
console.log(await db.find('users', {})); // [{ id: 1, name: 'Alice', … }]

db.stop();
```

> 浏览器里 `start()` 会自动加载同目录的 `browser_bg.wasm`；WASM 引擎提供
> `createTable` / `insert` / `find` / `findById` / `count` / `updateById` 等方法
> （没有 `executeSQL`）。

## 进阶

- 详细用法见 [API 参考](api-reference.md)
- CLI 命令见 [CLI 命令](cli.md)
- SQL 语法见 [SQL 参考](sql-reference.md)
