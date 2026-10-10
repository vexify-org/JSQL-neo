# PostgreSQL 协议支持

## 支持的客户端

`pg` (node-postgres)、`psql`、pgAdmin 4、DBeaver、TypeORM (postgres dialect)、Prisma、Knex、PostgREST 等。

```js
const { Client } = require('pg');
const client = new Client({ host: '127.0.0.1', port: 5432, user: 'root', database: 'app' });
await client.connect();
const res = await client.query('SELECT * FROM users WHERE age > $1', [25]);
await client.end();
```

## 认证 (SCRAM-SHA-256)

完整的 **SCRAM-SHA-256** 挑战-响应认证 (RFC 5802)：

1. 客户端发送 `SASLInitialResponse`（用户名 + client-first-message）
2. 服务器回复 `SASLContinue`（server-first-message: salt + iteration count，i=4096）
3. 客户端发送 `SASLResponse`（client-final-message 包含 Proof）
4. 服务器验证 Proof，发送 `AuthenticationOk`

同时也支持明文口令认证和 noAuth 模式。`psql` 和 `pg` 默认使用 SCRAM，无需额外配置。

```js
createPgServer({
  port: 5432,
  auth: { 'jsql-admin': { password: 's3cret', databases: ['*'] } },
});
```

## Wire protocol v3 支持范围

| 消息 | 方向 | 说明 |
|---|---|---|
| StartupMessage | C→S | protocol 3.0, user/database |
| PasswordMessage / SASL | C→S | 明文或 SCRAM 认证 |
| Query (`Q`) | C→S | 简单查询 |
| Parse/Bind/Execute (`P`/`B`/`E`) | C→S | 扩展协议（预处理语句） |
| Describe (`D`) | C→S | statement/portal 描述 |
| Sync (`S`) / Flush (`H`) | C→S | 同步 |
| Terminate (`X`) | C→S | 断开连接 |
| AuthenticationOk (`R`) | S→C | 认证成功 |
| RowDescription (`T`) | S→C | 结果列信息 |
| DataRow (`D`) | S→C | 数据行 (text/binary format) |
| CommandComplete (`C`) | S→C | `SELECT n` / `INSERT 0 n` … |
| ReadyForQuery (`I`) | S→C | 事务状态 `I`/`T`/`E` |
| ErrorResponse (`E`) | S→C | 错误（含 SQLSTATE） |
| NoticeResponse / ParameterStatus / BackendKeyData | S→C | 通知/参数/取消密钥 |

支持的功能：扩展协议端到端（`$1, $2` 参数）、二进制结果格式码、`INSERT ... RETURNING`、`ON CONFLICT DO NOTHING/UPDATE`、空查询返回 `EmptyQueryResponse`，识别 CancelRequest（忽略，引擎立即执行）。

## PostgreSQL 特有语法

| 语法 | 示例 |
|---|---|
| `SERIAL` / `BIGSERIAL` 自增 | `id SERIAL PRIMARY KEY` |
| `ILIKE` 不区分大小写匹配 | `WHERE name ILIKE '%alice%'` |
| `ON CONFLICT (col) DO UPDATE SET ...` | 可用 `EXCLUDED` |
| `ON CONFLICT (col) DO NOTHING` | 忽略冲突 |
| `RETURNING *` | 返回受影响行 |
| JSONB 的 `->` / `->>` | `SELECT data->>'name' FROM users` |
| `$1, $2` 占位符 | 预处理语句 |
| 双引号标识符 | `SELECT "Name" FROM t` |
| `::` 类型转换 | `SELECT '5'::INT` |
| `EXTRACT` / `AGE` / `TO_CHAR` | 日期函数 |

```sql
BEGIN;
CREATE TABLE IF NOT EXISTS accounts (
  id SERIAL PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  meta JSONB DEFAULT '{}'::jsonb
);
INSERT INTO accounts (email) VALUES ('a@x.com')
  ON CONFLICT (email) DO UPDATE SET meta = EXCLUDED.meta
  RETURNING *;
SELECT name, meta->>'plan' FROM accounts WHERE name ILIKE '%ali%';
COMMIT;
```

## SQLSTATE 错误映射

| SQLSTATE | 含义 | 触发场景 |
|---|---|---|
| `42P01` | undefined_table | 表不存在 |
| `42703` | undefined_column | 列不存在 |
| `23505` | unique_violation | 唯一键冲突 |
| `23502` | not_null_violation | NOT NULL 约束违反 |
| `23503` | foreign_key_violation | 外键约束违反 |
| `22007` | invalid_datetime_format | 日期格式错误 |
| `42601` | syntax_error | SQL 语法错误 |
| `23000` | integrity_constraint_violation | 通用约束违反 |
| `3D000` | invalid_catalog_name | 数据库不存在 |
| `00000` | successful_completion | 执行成功 |
| `28000` | invalid_authorization_specification | 认证失败 |
| `28P01` | invalid_password | 密码错误 |

映射逻辑位于 `lib/pg_server.js`，通过错误消息 + 错误码双重判定。未匹配的错误默认回退到 `XX000` / `42601`。

## FAQ

**Q: `psql` 提示 `no pg_hba.conf entry`？**

A: 服务端使用内置 ACL，而非 pg_hba.conf。检查 `auth` 选项或使用 `noAuth: true`。

**Q: 支持复制协议 / 流订阅吗？**

A: 不支持（`START_REPLICATION`、logical slots）。常规查询、事务和预处理语句均正常工作。

**Q: `\dt` 在 psql 中显示为空？**

A: `\dt` 依赖 `pg_class` 元数据，请直接使用 SQL：

```sql
SELECT * FROM information_schema.tables;
```
