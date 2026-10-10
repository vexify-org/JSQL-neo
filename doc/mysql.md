# MySQL 协议支持

jsql-neo 内置 MySQL 4.1+ 协议兼容，MySQL 客户端可直接连接，无需任何修改。

## 支持的客户端

| 客户端 | 类型 | 状态 |
|---|---|---|
| `mysql2` (npm) | Node.js 驱动 | ✅ 完全支持（含 Promise API） |
| `mysql` (npm) | Node.js 驱动 | ✅ 完全支持 |
| Sequelize | ORM | ✅（mysql dialect） |
| Knex | 查询构建器 | ✅（mysql2 dialect） |
| TypeORM | ORM | ✅ |
| Prisma | ORM | ✅ |
| phpMyAdmin | Web GUI | ✅ |
| HeidiSQL / DBeaver / Navicat | GUI | ✅ |
| mysql CLI | CLI | ✅ |

```js
const mysql = require('mysql2/promise');
const conn = await mysql.createConnection({
  host: '127.0.0.1', port: 3306, user: 'root', database: 'app',
});
const [rows] = await conn.query('SELECT * FROM users WHERE age > ?', [25]);
await conn.end();
```

## 握手与认证

- 协议：MySQL 4.1+ 握手（服务端 greeting 包含 version、thread id、auth plugin）
- 认证插件：`mysql_native_password`（SHA-1 挑战-响应）
- `auth: { user: { password, databases } }` — `databases` 支持 `'*'` 或列表
- `noAuth: true` 跳过认证（仅开发环境）

```js
createMysqlServer({
  port: 3306,
  auth: {
    admin:    { password: 'admin123', databases: ['*'] },
    readonly: { password: 'ro123',    databases: ['app'] },
  },
});
```

认证失败返回标准错误：`Access denied for user 'x'@'...' (using password: YES)`。

## 系统变量与元数据表

服务端响应 ORMs 和 GUI 工具连接时发送的系统探测：

- `SELECT VERSION()` → `8.0.1-jsql-neo`
- 系统变量：`@@version`、`@@version_comment`、……
- `SHOW DATABASES / SHOW TABLES / SHOW COLUMNS / SHOW CREATE TABLE`
- `information_schema.tables / columns / statistics`
- `mysql.user`（内部认证元数据）

```sql
SHOW DATABASES;
SHOW TABLES;
SHOW CREATE TABLE users;
SELECT TABLE_NAME, TABLE_ROWS FROM information_schema.tables WHERE TABLE_SCHEMA = 'app';
```

## MySQL 特有语法

| 语法 | 说明 | 示例 |
|---|---|---|
| `AUTO_INCREMENT` | 自增主键（从 1 开始，步长 1） | `id INT PRIMARY KEY AUTO_INCREMENT` |
| `ON DUPLICATE KEY UPDATE` | 冲突时更新 | `INSERT ... ON DUPLICATE KEY UPDATE cnt = cnt + 1` |
| `INSERT IGNORE` | 忽略冲突 | `INSERT IGNORE INTO t VALUES (...)` |
| `REPLACE INTO` | 冲突时删除再插入 | `REPLACE INTO t VALUES (...)` |
| `LIMIT off, n` | MySQL 分页语法 | `SELECT ... LIMIT 20, 40` |
| 反引号标识符 | `` `column` `` | `` SELECT `name` FROM `users` `` |
| 多语句批处理 | 分号分隔的批量语句 | `CREATE TABLE ...; INSERT ...; SELECT ...` |
| `IFNULL` / `GROUP_CONCAT` | MySQL 风格函数 | `SELECT GROUP_CONCAT(name) FROM users` |

## FAQ

**Q: MySQL 客户端在握手前会等待约 200ms？**
A: 多协议探测需要根据第一个字节判断协议类型或等待超时。单协议模式（`createMysqlServer` / `jsql serve`）会立即响应。

**Q: Sequelize/TypeORM 查询 `information_schema` 返回空？**
A: 表必须先存在才会返回真实元数据。用 `SHOW TABLES` 确认表状态。

**Q: 支持存储过程吗？**
A: 不支持。`CREATE PROCEDURE` / 触发器会被拒绝并返回明确错误（安全策略）。视图（VIEW）已支持。
