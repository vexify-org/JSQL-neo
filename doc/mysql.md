? Language / 语言: **English** | [简体中文](cn/mysql.md)

# MySQL protocol support

jsql-neo ships built-in MySQL 4.1+ protocol compatibility, so MySQL clients can connect unchanged.

## Supported clients

| Client | Type | Status |
|---|---|---|
| `mysql2` (npm) | Node.js driver | ✅ full support (including the Promise API) |
| `mysql` (npm) | Node.js driver | ✅ full support |
| Sequelize | ORM | ✅ (mysql dialect) |
| Knex | query builder | ✅ (mysql2 dialect) |
| TypeORM | ORM | ✅ |
| Prisma | ORM | ✅ |
| phpMyAdmin | web GUI | ✅ |
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

## Handshake and authentication

- Protocol: MySQL 4.1+ handshake (server greeting includes version, thread id, auth plugin)
- Auth plugin: `mysql_native_password` (SHA-1 challenge-response)
- `auth: { user: { password, databases } }` — `databases` accepts `'*'` or a list
- `noAuth: true` skips authentication (development only)

```js
const { createMysqlServer } = require('jsql-neo');

createMysqlServer({
  port: 3306,
  auth: {
    admin:    { password: 'admin123', databases: ['*'] },
    readonly: { password: 'ro123',    databases: ['app'] },
  },
});
```

Failed authentication returns the standard error: `Access denied for user 'x'@'...' (using password: YES)`.

## System variables and metadata tables

What the server answers when ORMs and GUI tools probe the connection:

- `SELECT VERSION()` → `8.0.1-jsql-neo`
- System variables: `@@version`, `@@version_comment`, …
- `SHOW DATABASES / SHOW TABLES / SHOW COLUMNS / SHOW CREATE TABLE`
- `information_schema.tables / columns / statistics`
- `mysql.user` (internal authentication metadata)

```sql
SHOW DATABASES;
SHOW TABLES;
SHOW CREATE TABLE users;
SELECT TABLE_NAME, TABLE_ROWS FROM information_schema.tables WHERE TABLE_SCHEMA = 'app';
```

## MySQL-specific syntax

| Syntax | Description | Example |
|---|---|---|
| `AUTO_INCREMENT` | auto-increment primary key (starts at 1, step 1) | `id INT PRIMARY KEY AUTO_INCREMENT` |
| `ON DUPLICATE KEY UPDATE` | update on conflict | `INSERT ... ON DUPLICATE KEY UPDATE cnt = cnt + 1` |
| `INSERT IGNORE` | ignore conflicts | `INSERT IGNORE INTO t VALUES (...)` |
| `REPLACE INTO` | delete then insert on conflict | `REPLACE INTO t VALUES (...)` |
| `LIMIT off, n` | MySQL pagination syntax | `SELECT ... LIMIT 20, 40` |
| backtick identifiers | `` `column` `` | `` SELECT `name` FROM `users` `` |
| multi-statement batches | semicolon-separated statements | `CREATE TABLE ...; INSERT ...; SELECT ...` |
| `IFNULL` / `GROUP_CONCAT` | MySQL-style functions | `SELECT GROUP_CONCAT(name) FROM users` |

## FAQ

**Q: Does the MySQL client wait about 200ms before the handshake?**

A: Multi-protocol sniffing needs the first byte to pick a protocol, or it waits for the timeout. Single-protocol mode (`createMysqlServer` / `jsql serve`) responds immediately.

**Q: Sequelize/TypeORM queries on `information_schema` return nothing?**

A: Tables must exist before real metadata is returned. Use `SHOW TABLES` to check table state.

**Q: Are stored procedures supported?**

A: No. `CREATE PROCEDURE` and triggers are rejected with an explicit error (security policy). Views (VIEW) are supported.
