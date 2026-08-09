# JSQL-NEO

> **One engine to rule them all** — a Rust-powered embedded database that speaks your language:
> MySQL protocol. Redis protocol. SQL. TypeScript. The browser. **And it fits in one npm package.**

![Engines](https://img.shields.io/badge/engines-Native%20%7C%20WASM%20%7C%20Pure%20JS-7ee787)
![MySQL](https://img.shields.io/badge/protocol-MySQL%20compatible-1f6feb)
![Redis](https://img.shields.io/badge/protocol-Redis%20RESP2-f03c15)
![ZERO](https://img.shields.io/badge/dependencies-ZERO-8957e5)
![WASM](https://img.shields.io/badge/runs%20in-Browser%20%28WASM%29-79c0ff)

---

## Why JSQL-NEO?

My web ： https://jsql.vexify.top/

Most embedded databases make you choose: *native speed*, *portable WASM*, or *a familiar file format*.
JSQL-NEO gives you **all three in one install** — plus drop-in compatibility with the **two most popular
database protocols in the world**.

- ⚡ **Rust core** — N-API native addon, ~2× faster than better-sqlite3 (see [Benchmark](#benchmark))
- 🧩 **WASM build** — the *same engine* runs in Node.js **and any browser**, zero native deps
- 🐘 **MySQL protocol** — Sequelize, Knex, TypeORM, mysql2, phpMyAdmin … **just work**, no plugin
- 🐇 **Redis protocol** — ioredis, node-redis, redis-cli — strings, hashes, lists, sets, TTL, snapshots
- 🌐 **Built-in Web UI** — a zero-dependency management console ships with the package
- 🗃️ **Three storage modes** — memory-first, hybrid (LRU + async flush), and disk
- 📦 **Zero runtime dependencies** — the whole world is your `node_modules`
- 🏷️ **Typed** — full TypeScript declarations for every API surface

```
            ┌─────────────────────────── JSQL-NEO ───────────────────────────┐
            │                                                               │
  Node.js ──┤  Native (Rust N-API)     Fastest path, zero deps              │
  Node.js ──┤  WASM   (Rust → wasm)    Portable, no native addon            │
  Browser ──┤  WASM   (+ IndexedDB)    Full SQL engine in your browser      │
  Anywhere ─┤  Pure JS (JSON file)     SQLite-like local persistence        │
            │                                                               │
            ├── speak MySQL ──────────► Sequelize / Knex / TypeORM / mysql2 │
            ├── speak Redis ──────────► ioredis / node-redis / redis-cli    │
            ├── speak HTTP ───────────► built-in Web UI + management APIs   │
            └── speak SQL ────────────► CREATE / SELECT / JOIN / aggregates │
                                                                             ┘
```

## 30-second Quick Start

```bash
npm install jsql-neo
```

```js
const jsql = require('jsql-neo');
const db = new jsql.NativeJSQL();          // fastest engine
await db.start();

await jsql.executeSQL(db, 'CREATE TABLE users (id INTEGER PRIMARY KEY AUTO_INCREMENT, name STRING, age INTEGER)');
await jsql.executeSQL(db, "INSERT INTO users (name, age) VALUES ('Alice', 30), ('Bob', 25), ('Carol', 35)");
const r = await jsql.executeSQL(db, 'SELECT name, age FROM users WHERE age > 26 ORDER BY age DESC');
// rows: [["Carol",35],["Alice",30]]

await db.stop();
```

Need a **MySQL server** instead?

```bash
jsql serve -p 3306 --data-dir ./data
mysql -h 127.0.0.1 -P 3306 -u root        # any MySQL client, now
```

Need a **Redis server**?

```bash
jsql redis -p 6379 --data-dir ./redis-data
redis-cli SET hello world
```

Need a **web console**?

```bash
jsql ui -p 8080 --data-dir ./data         # open http://localhost:8080
```

One package. One install. Five doors in.

---

## Engines

| Engine | Entry point | Speed | Where it runs | Best for |
|--------|-------------|-------|---------------|----------|
| **Native** | `NativeJSQL` | ⚡ fastest (Rust N-API) | Node.js | Production, hot paths |
| **WASM** | `JSQL` | fast (Rust → wasm) | Node.js **and browsers** | Portability, edge, playgrounds |
| **Pure JS** | `Database` | solid | Node.js | Local JSON files, zero-native deploys |

All three share the same API — `createTable` / `insert` / `findById` / `find` / `updateById` /
`removeById` / `dropTable` — plus a common `executeSQL()` SQL engine. **Write once, run anywhere.**

### Storage modes (Native & Pure JS)

| Mode | Behavior |
|------|----------|
| `memory` | Pure in-memory, max speed, no path needed |
| `hybrid` | Memory-first, async incremental flush, cold tables LRU-evicted under memory pressure, lazy reload |
| `disk` | Fast flush (50ms), memory as read/write cache |

```js
const db = new jsql.NativeJSQL({
  path: '/var/lib/jsql',
  mode: 'hybrid',           // 'memory' | 'hybrid' | 'disk'
  memReserveMB: 512,        // RAM headroom before LRU eviction
  flushInterval: 200,       // async flush cadence (ms)
});
```

Atomic writes (tmp + rename), per-table files, and WAL + snapshot crash recovery on the server engine.

---

## The SQL Engine

A full SQL engine with prepared statements, joins, subqueries, and MySQL-compatible column naming:

```sql
CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTO_INCREMENT, name VARCHAR(50), age INTEGER)
INSERT INTO users (name, age) VALUES ('Alice', 30), ('Bob', 25) ON DUPLICATE KEY UPDATE age = 30
SELECT name, age FROM users WHERE age > 26 ORDER BY age DESC LIMIT 10 OFFSET 5
SELECT COUNT(*), AVG(age) FROM users GROUP BY dept HAVING COUNT(*) > 2
UPDATE users SET age = 31 WHERE name = 'Bob'
DELETE FROM users WHERE id = 2
BEGIN / COMMIT / ROLLBACK
```

Scalar functions: `VERSION()`, `NOW()`, `CONCAT()`, `IFNULL()`, `COALESCE()`, `UPPER()`, `LOWER()`,
`LENGTH()`, `ROUND()`, `LAST_INSERT_ID()`, `ROW_COUNT()`, `FOUND_ROWS()`, `CONNECTION_ID()`, `DATABASE()` …
System variables: `@@version`, `@@sql_mode`, `SET @@sql_mode = 'STRICT_TRANS_TABLES'` …

---

## Speak MySQL

The MySQL wire-protocol server accepts **standard MySQL clients** — no plugins, no middleware.
Verified in CI against the real drivers used by three major ORMs:

| ORM | Version | Results |
|-----|---------|---------|
| [Sequelize](https://sequelize.org) | v6 | ✅ 10/10 — connect, authenticate, sync, create, bulkCreate, find, count, update, destroy, MAX() |
| [Knex](https://knexjs.org) | v3 | ✅ 9/9 — schema builder, insert, select, where + orderBy, count, update, delete, raw SQL |
| [TypeORM](https://typeorm.io) | v0.3 | ✅ 8/8 — initialize, synchronize, save, findOne, find, count, update, delete |

Also verified with `mysql2/promise` over the wire: prepared statements (`COM_STMT_PREPARE`/`EXECUTE`),
binary protocol result sets, `SHOW COLUMNS` / `SHOW INDEX` / `SHOW CREATE TABLE` / `SHOW VARIABLES` /
`SHOW GRANTS`, `information_schema`, `START TRANSACTION`, `TRUNCATE TABLE`, `SET` statements, and
MySQL DDL forms (`int unsigned`, `auto_increment`, `ENGINE=InnoDB`, `DEFAULT CHARSET`).

```js
const { createMysqlServer } = require('jsql-neo');
// 开发环境：本地无认证
createMysqlServer({ port: 3306, dataDir: './data', noAuth: true }).listen();

// 生产环境：用户名/密码 + 每用户数据库白名单（ACL）
createMysqlServer({
  port: 3306,
  dataDir: './data',
  auth: { app: { password: 's3cret', databases: ['app', 'analytics'] } },
}).listen();
```

`auth` 里的 `databases` 数组即该用户的数据库白名单：越权访问（跨库引用、`SHOW TABLES FROM db`、
`DROP DATABASE`）统一返回 `ER_DBACCESS_DENIED_ERROR` (1044)。省略 `databases` 时不限制库。

---

## Speak Redis

A RESP2 server that plays perfectly with `ioredis`, `node-redis`, and `redis-cli`:

```
PING ECHO SET GET SETNX DEL EXISTS KEYS TYPE EXPIRE TTL PERSIST
INCR DECR INCRBY DECRBY APPEND STRLEN
HSET HGET HGETALL HDEL HEXISTS HLEN HKEYS HVALS
LPUSH RPUSH LPOP RPOP LLEN LRANGE LINDEX LREM
SADD SREM SMEMBERS SISMEMBER SCARD
DBSIZE FLUSHALL FLUSHDB SELECT INFO AUTH QUIT
```

Snapshot persistence to `data.rdb.json` — debounced writes (500ms) plus a guaranteed flush on shutdown.

```js
const { createRedisServer } = require('jsql-neo');
// 本地无认证
createRedisServer({ port: 6379, dataDir: './redis-data' }).listen();

// 带密码：每连接独立认证，任一客户端 AUTH 成功不影响其它连接
createRedisServer({ port: 6379, dataDir: './redis-data', password: 's3cret' }).listen();
```

设置了 `password` 后，未认证连接上的命令返回 `NOAUTH Authentication required.`；认证状态按连接隔离。

---

## Toolbox — everything included

### CLI (`jsql`)

| Command | What it does |
|---------|--------------|
| `jsql serve` | Run the MySQL-compatible server in the foreground |
| `jsql server start\|stop\|status` | Background daemon with pid control |
| `jsql redis` | Run the Redis-compatible server |
| `jsql ui` | Serve the built-in web management console |
| `jsql import <dump.sql\|.json\|.csv>` | Load a mysqldump, JSON, or CSV file |
| `jsql export <table> <file>` | Dump a table to JSON or CSV |
| `jsql bench` | Insert + query benchmark against a data dir |
| `jsql mod` | Plugin registry (enable / disable / list) |
| `jsql version` | Print version |

### Web UI (`WebUI`)

A zero-dependency HTTP management console: browse databases and tables, run SQL in the browser,
see results as a table. Perfect for dev tools, admin panels, and demos.

> **安全默认值（5.1.0）**：默认只监听 `127.0.0.1`（不再暴露到所有网卡）。生产环境请设置
> `authToken`，所有 `/api/*` 请求需携带 `Authorization: Bearer <token>`，未认证返回 401。

```js
const { WebUI } = require('jsql-neo');
const ui = new WebUI({ port: 8080, dataDir: './data', authToken: 'change-me' });
await ui.start();
```

可用选项：`host`（默认 `127.0.0.1`）、`port`、`dataDir`、`readonly`、`authToken`（Bearer 认证）、
`allowOrigin`（CORS 允许的源；不设置时开启认证仅回显请求 Origin，未开启认证时为 `*`）。

### Migration tools (`migrate`)

```js
const { importDumpFile, exportToFile, importFromCSV, exportAllToJSON } = require('jsql-neo');
await importDumpFile(db, './backup.sql', { strict: true });   // real mysqldump format
await exportToFile(db, 'users', './users.csv');               // CSV round-trip
```

`importFromJSON` / `importDumpFile` 从 5.1.0 起：

- 兼容两种 JSON 形状：整库 `{ "users": { schema, rows } }` 与单表 `{ table, schema, rows }`。
- 目标表已存在时**默认抛错**，不会静默覆盖；需显式传入 `{ overwrite: true }` 才重建表。

### Browser playground

`examples/playground/` is a self-contained SQL sandbox — the **entire engine runs in your browser**
(WASM + IndexedDB persistence, no server):

```bash
cd examples/playground && npm install && npm run dev
```

### TypeScript

Full declarations ship with the package (`index.d.ts` + `wasm/browser.d.ts`), verified with
`tsc --strict`. Autocomplete your way through every engine, server, and tool.

---

## Benchmark

100,000 rows — insert / point query / range query / count / update (Linux x64, Node 24):

| Engine | Insert/s | Point query (500×) | Range query (500×) | Total |
|--------|----------|--------------------|--------------------|-------|
| **Native (Rust N-API)** | 0.66M | 930ms | 685ms | **1.77s** 🏆 |
| better-sqlite3 (WAL) | 0.40M | 3258ms | 149ms | 3.66s |
| sql.js (WASM sqlite) | 0.30M | 5852ms | 366ms | 6.57s |
| Pure JS engine | 0.38M | 11278ms | 18138ms | 29.7s |

**~2× faster than better-sqlite3. ~17× faster than a pure-JS engine.** Reproduce it yourself:

```bash
cd bench && npm install && npm run bench
```

---

## API at a glance

| Method | Native | WASM | Pure JS | Notes |
|--------|:------:|:----:|:-------:|-------|
| `createTable(name, schema)` | ✅ | ✅ | ✅ | Typed fields, indexes |
| `insert(table, data)` | ✅ | ✅ | ✅ | Batch supported, returns IDs |
| `findById(table, id)` | ✅ | ✅ | ✅ | O(1) primary-key hash lookup |
| `find(table, filter, opts)` | ✅ | ✅ | ✅ | Filter + B-Tree range scan, pagination |
| `count(table)` | ✅ | ✅ | ✅ | — |
| `updateById(table, id, data)` | ✅ | ✅ | ✅ | O(1) PK update |
| `removeById(table, id)` | ✅ | ✅ | ✅ | O(1) PK delete |
| `executeSQL(db, sql, params)` | ✅ | ✅ | ✅ | Full SQL engine, prepared statements |

```js
{
  type: 'string' | 'integer' | 'float' | 'boolean',
  primaryKey: true,       // auto-indexed
  autoIncrement: true,    // integer PK generation
  length: 32,             // string max length
  default: 'value',
  nullable: true
}
```

---

## Testing

```bash
npm test          # zero-dependency SQL engine smoke suite
npm run test:orms # ORM compatibility (start examples/orms/start-server.js first)
```

CI (`.github/workflows/ci.yml`): engine smoke tests on Node 18/20/22 + a full ORM compatibility job.

---

## License

[Apache-2.0](LICENSE) — free to use, modify, and distribute with attribution.

*JSQL-NEO: Rust-powered. Protocol-native. One package.*
