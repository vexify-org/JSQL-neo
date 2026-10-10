# 快速开始

## 安装

```bash
npm install jsql-neo
```

## 三行代码

```js
const { Database, executeSQL } = require('jsql-neo');
const db = new Database(':memory:');
await executeSQL(db, "CREATE TABLE users (id INT PRIMARY KEY AUTO_INCREMENT, name TEXT)");
await executeSQL(db, "INSERT INTO users (name) VALUES ('Alice')");
const { rows } = await executeSQL(db, "SELECT * FROM users");
console.log(rows); // [[1, 'Alice']]
db.stop();
```

## 内存模式 vs 磁盘模式

| 模式 | 用法 | 适用场景 |
|---|---|---|
| 内存 | `new Database(':memory:')` | 测试、缓存 |
| 磁盘 | `new Database('./data/app')` | 生产持久化 |
| 混合 | `new Database('./data', { autoSave: true, saveInterval: 3000 })` | 平衡性能与持久化 |

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
// 需要构建好的 wasm 文件，或通过 bundler
import init, { Database } from 'jsql-neo/wasm';
await init();
const db = new Database(':memory:');
// 同上 API
```

## 进阶

- 详细用法见 [API 参考](api-reference.md)
- CLI 命令见 [CLI 命令](cli.md)
- SQL 语法见 [SQL 参考](sql-reference.md)
