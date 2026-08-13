# JSQL-NEO

> **One engine to rule them all** — a Rust-powered embedded database that speaks your language:
> MySQL. PostgreSQL. MongoDB. Redis. SQL. TypeScript. The browser. **And it fits in one npm package.**

> **v5.3.1** — official release build · [github.com/vexify-org/JSQL-neo](https://github.com/vexify-org/JSQL-neo)

![Engines](https://img.shields.io/badge/engines-Native%20%7C%20WASM%20%7C%20Pure%20JS-7ee787)
![MySQL](https://img.shields.io/badge/protocol-MySQL%20compatible-1f6feb)
![PostgreSQL](https://img.shields.io/badge/protocol-PostgreSQL%20compatible-336791)
![Redis](https://img.shields.io/badge/protocol-Redis%20RESP2-f03c15)
![MongoDB](https://img.shields.io/badge/protocol-MongoDB%20Wire%20Protocol-589636)
![TUI](https://img.shields.io/badge/tui-zero--dependency-ff9800)
![ZERO](https://img.shields.io/badge/dependencies-ZERO-8957e5)
![WASM](https://img.shields.io/badge/runs%20in-Browser%20%28WASM%29-79c0ff)

> **🌐 中英双语 Bilingual documentation** — This README is written in both English and Chinese.

---

## 🧭 快速导航 Quick Navigation

- [🌐 English Version](#english-version)
- [🇨🇳 中文版 Chinese Version](#中文版-chinese-version)

---

## English Version由li63050a协助完成

**JSQL-NEO** is an embedded database that speaks your language: **MySQL, PostgreSQL, MongoDB, Redis, SQL, TypeScript, and the browser** — all in a single npm package with zero runtime dependencies.

- ⚡ **Rust core** — N-API native addon, ~2× faster than better-sqlite3
- 🧩 **WASM build** — the *same engine* runs in Node.js **and any browser**, zero native deps
- 🐘 **MySQL protocol** — `mysql2`, Sequelize, Knex, TypeORM, phpMyAdmin … just work, no plugin
- 🐘 **PostgreSQL protocol** — `pg`, `psql`, pgAdmin — SCRAM-SHA-256 auth, prepared statements, JSONB, ILIKE, `ON CONFLICT`, `SERIAL`
- 🍃 **MongoDB wire protocol** — official `mongodb` driver, mongosh, Compass — OP_MSG/OP_QUERY/OP_COMPRESSED, BSON, CRUD, aggregation pipeline
- 🐇 **Redis protocol** — `ioredis`, node-redis, redis-cli — strings, hashes, lists, sets, sorted sets, TTL, snapshots
- 🔌 **One port. Every protocol.** — protocol sniffing routes MySQL / PostgreSQL / Redis / MongoDB clients to the **same endpoint and the same data**
- 🖥️ **Zero-dependency TUI** — `jsql tui` interactive terminal: line editing, history, Tab completion, CJK-aligned tables, meta commands
- 🌐 **Built-in Web UI** — zero-dependency management console + HTTP API
- 🗃️ **Three storage modes** — memory-first, hybrid (LRU + async flush), and disk
- 📦 **Zero runtime dependencies** in the database core

For the complete Chinese edition of every topic below, jump to the [中文版](#中文版-chinese-version) section.

### English Table of Contents

- [Why JSQL-NEO?](#why-jsql-neo)
- [Feature Overview](#feature-overview)
- [Quick Start](#quick-start)
  - [Install](#install)
  - [30-second demo](#30-second-demo)
  - [Node.js in three lines](#nodejs-in-three-lines)
  - [Browser / WASM](#browser--wasm)
- [Multiprotocol Server](#multiprotocol-server)
  - [One port, every protocol](#one-port-every-protocol)
  - [Protocol sniffing](#protocol-sniffing)
  - [Shared data model](#shared-data-model)
  - [Port & process management](#port--process-management)
- [Speak MySQL](#speak-mysql)
  - [Supported clients](#supported-clients)
  - [Handshake & auth](#handshake--auth)
  - [System variables & meta tables](#system-variables--meta-tables)
  - [MySQL-specific syntax](#mysql-specific-syntax)
  - [MySQL FAQ](#mysql-faq)
- [Speak PostgreSQL](#speak-postgresql)
  - [Supported clients](#supported-clients-1)
  - [Authentication (SCRAM-SHA-256)](#authentication-scram-sha-256)
  - [Wire protocol v3 coverage](#wire-protocol-v3-coverage)
  - [PostgreSQL-specific syntax](#postgresql-specific-syntax)
  - [SQLSTATE mapping](#sqlstate-mapping)
  - [PostgreSQL FAQ](#postgresql-faq)
- [Speak MongoDB](#speak-mongodb)
  - [Supported clients](#supported-clients-2)
  - [Wire protocol (OP_QUERY / OP_MSG / OP_COMPRESSED)](#wire-protocol-op_query--op_msg--op_compressed)
  - [BSON support](#bson-support)
  - [Database & collection mapping](#database--collection-mapping)
  - [Command reference](#command-reference)
  - [Query operators](#query-operators)
  - [Aggregation pipeline](#aggregation-pipeline)
  - [MongoDB FAQ](#mongodb-faq)
- [Speak Redis](#speak-redis)
  - [Supported clients](#supported-clients-3)
  - [Data types](#data-types)
  - [Command reference](#command-reference-1)
  - [TTL & persistence](#ttl--persistence)
  - [Redis FAQ](#redis-faq)
- [SQL Reference](#sql-reference)
  - [Statements](#statements)
  - [Data types](#data-types-1)
  - [Scalar functions](#scalar-functions)
  - [Aggregate functions](#aggregate-functions)
  - [Operators](#operators)
    - [Indexes & constraints](#indexes--constraints)
  - [Views](#views)
  - [JSON / JSONB](#json--jsonb)
  - [Prepared statements](#prepared-statements)
  - [Multi-statement](#multi-statement)
  - [Safety policy](#safety-policy)
- [Node.js API Reference](#nodejs-api-reference)
  - [Database class](#database-class)
  - [executeSQL](#executesql)
  - [Data access methods](#data-access-methods)
  - [Events & hooks](#events--hooks)
  - [createXxxServer factories](#createxxxserver-factories)
  - [Multiprotocol server API](#multiprotocol-server-api)
- [Command Line Interface](#command-line-interface)
  - [jsql serve](#jsql-serve)
  - [jsql serve --pg (multiprotocol)](#jsql-serve---pg-multiprotocol)
  - [jsql redis](#jsql-redis)
  - [jsql ui (Web console)](#jsql-ui-web-console)
  - [jsql export / import](#jsql-export--import)
  - [jsql bench](#jsql-bench)
  - [jsql mod](#jsql-mod)
  - [jsql version](#jsql-version)
- [TUI Interactive Terminal](#tui-interactive-terminal)
  - [Startup & options](#startup--options)
  - [Keyboard shortcuts](#keyboard-shortcuts)
  - [Meta commands](#meta-commands)
  - [Continuation & statement boundaries](#continuation--statement-boundaries)
  - [Batch mode](#batch-mode)
- [Web UI & HTTP API](#web-ui--http-api)
- [Compatibility Layers](#compatibility-layers)
- [Migration Tools](#migration-tools)
- [Storage & Performance](#storage--performance)
- [Security](#security)
- [Errors](#errors)
- [TypeScript](#typescript)
- [Architecture](#architecture)
- [FAQ](#faq)
- [Benchmark](#benchmark)
- [Contributing](#contributing)
- [License](#license)
- [Appendices A–Z](#appendices-a–z)

---

## Why JSQL-NEO?

Most embedded databases force you to pick one: native speed, portable WASM, or a familiar file
format. JSQL-NEO gives you **all of them in one install**, plus drop-in compatibility with the
four most popular database protocols in the world.

| Dimension | JSQL-NEO | better-sqlite3 | sql.js (WASM) | LevelDB | local redis/mongo |
|---|---|---|---|---|---|
| Native speed (Rust N-API) | ✅ | ✅ | ❌ | ✅ | ✅ |
| Runs in browser (WASM) | ✅ | ❌ | ✅ | ❌ | ❌ |
| Zero runtime deps | ✅ | ✅ | ✅ | ✅ | ❌ |
| MySQL protocol | ✅ | ❌ | ❌ | ❌ | ❌ |
| PostgreSQL protocol | ✅ | ❌ | ❌ | ❌ | ❌ |
| MongoDB wire protocol | ✅ | ❌ | ❌ | ❌ | Mongo only |
| Redis RESP2 | ✅ | ❌ | ❌ | ❌ | Redis only |
| One port, every protocol | ✅ | ❌ | ❌ | ❌ | ❌ |
| Interactive TUI | ✅ | ❌ | ❌ | ❌ | ❌ |

Highlights:

- **One engine, three implementations** — `native` (Rust N-API), `wasm` (same Rust core compiled to
  WebAssembly, runs in browsers), and `js` (pure-JS fallback). Automatic fallback: native → wasm → js.
- **Real wire protocols, not emulators** — hand-written protocol stacks for MySQL 4.1+, PostgreSQL
  wire protocol v3 (SCRAM-SHA-256), MongoDB OP_MSG/OP_QUERY (+ compression), and Redis RESP2.
- **One port for all clients** — first-byte sniffing routes each connection to the right protocol;
  all protocols operate on the **same data**.
- **Full SQL** — DDL/DML, JOINs, subqueries, transactions with savepoints, views, indexes,
  constraints, 89 scalar functions, window functions and CTE basics.
- **Document semantics** — MongoDB-style operators (`$gt`, `$regex`, `$elemMatch`, …), aggregation
  pipeline stages (`$match`, `$group`, `$sort`, `$project`, `$unwind`, …) and update operators.
- **Key-value semantics** — five Redis data types, TTL, and snapshot persistence.
- **Zero-dependency TUI** — full line editing, persistent history, completion, CJK-aware tables.
- **Migration tools** — import `mysqldump` output, export/import JSON and CSV.

---

## Feature Overview

1. **Multiprotocol server (the core feature)**

```
┌───────────────────────────────────────────────────────────────┐
│                    jsql serve --pg -p 5432                     │
│                     (single TCP port)                          │
│                                                                │
│  mysql2 ──┐                                                   │
│  Sequelize┤                                                   │
│  psql     ─┤   ┌─────────────────────────────────┐            │
│  pgAdmin   ─┤──►│  protocol sniffing (first bytes)│            │
│  mongosh   ─┤   └─────────────────────────────────┘            │
│  Compass    ─┤       │        │        │        │             │
│  ioredis    ─┤       ▼        ▼        ▼        ▼             │
│  redis-cli  ─┘   ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐         │
│                   │ MySQL│ │ PG   │ │ Mongo│ │ Redis│         │
│                   └──────┘ └──────┘ └──────┘ └──────┘         │
│                       └───────┬───────┘                       │
│                               ▼                               │
│                      ┌─────────────────┐                       │
│                      │  shared engine  │                       │
│                      │  (one data dir) │                       │
│                      └─────────────────┘                       │
└───────────────────────────────────────────────────────────────┘
```

Write with `psql`, read with `mysql2`, query with `mongosh`, and cache with `redis-cli` —
same port, same data.

2. **Four semantics in one engine** — MySQL semantics (`AUTO_INCREMENT`, `ON DUPLICATE KEY
   UPDATE`, `information_schema`, `SHOW`), PostgreSQL semantics (`SERIAL`, `ILIKE`, `ON CONFLICT`,
   JSONB, `RETURNING`, prepared statements), MongoDB document semantics (operators, `updateOne`/`deleteMany`, aggregation), and Redis key-value semantics (5 types, TTL, snapshots).

3. **Run shapes**

| Shape | Entry point | Use case |
|---|---|---|
| Embedded (memory) | `new Database(':memory:')` | tests, dev, cache |
| Embedded (disk) | `new Database('./data/db')` | single-process apps |
| Server (4 protocols) | `createMultiServer(...)` / `jsql serve --pg` | multi-client, microservices |
| Browser (WASM) | `JSQL` (lib/wasm_client) | in-browser queries |
| Interactive terminal | `jsql tui` | manual admin, debugging |

---

## Quick Start

### Install

```bash
npm install jsql-neo                         # option 1: npm
npm install github:vexify-org/JSQL-neo       # option 2: GitHub main
git clone https://github.com/vexify-org/JSQL-neo.git && cd JSQL-neo
npm install && npm run build                 # option 3: from source
```

Verify:

```bash
node -e "console.log(require('jsql-neo/package.json').version)"   # 5.3.1
```

### 30-second demo

```bash
# Terminal 1: multiprotocol server (one port, four protocols)
jsql serve --pg -p 5432 --data-dir ./data

# Terminal 2: write with a MySQL client
mysql -h 127.0.0.1 -P 5432 -u root -e "
  CREATE DATABASE app; USE app;
  CREATE TABLE users (id INT PRIMARY KEY AUTO_INCREMENT, name VARCHAR(50));
  INSERT INTO users (name) VALUES ('Alice'), ('Bob');"

# Terminal 3: read with a PostgreSQL client
psql -h 127.0.0.1 -p 5432 -U root -d app -c "SELECT * FROM users;"

# Terminal 4: query the same table with MongoDB
mongosh mongodb://127.0.0.1:5432/app --eval "db.users.find({name: 'Alice'})"

# Terminal 5: cache with Redis
redis-cli -h 127.0.0.1 -p 5432 SET app:users:count 2
```

### Node.js in three lines

```js
const { Database, executeSQL } = require('jsql-neo');
const db = new Database(':memory:', { autoSave: false });
await executeSQL(db, "CREATE TABLE users (id INT PRIMARY KEY AUTO_INCREMENT, name VARCHAR(50))");
await executeSQL(db, "INSERT INTO users (name) VALUES ('Alice')");
const { rows } = await executeSQL(db, "SELECT * FROM users");
console.log(rows); // [[1, 'Alice']]
```

Full embedded example:

```js
const { Database, executeSQL } = require('jsql-neo');
(async () => {
  const db = new Database('./data/app');                  // disk mode (auto-save)
  db.createTable('users', {
    id:   { type: 'INT', primaryKey: true, autoIncrement: true },
    name: { type: 'VARCHAR', length: 100 },
    age:  { type: 'INT' },
  });
  db.insert('users', { name: 'Alice', age: 30 });
  db.insert('users', { name: 'Bob', age: 25 });

  const r1 = db.find('users', { age: { $gte: 26 } });                      // document filter
  const r2 = await executeSQL(db, 'SELECT * FROM users WHERE age > ?', [25]); // param SQL
  const r3 = db.query('users').where({ name: 'Alice' }).limit(10).exec();   // chainable
  db.stop();
})();
```

### Browser / WASM

```html
<script type="module">
  import { JSQL } from 'jsql-neo/dist/wasm.js';
  const db = new JSQL();
  await db.start();
  await db.createTable('users', { name: { type: 'string' } });
  await db.insert('users', { name: 'Alice' });
  console.log(await db.find('users', {}));
  await db.stop();
</script>
```

WASM and native share the same SQL grammar and data API. When no native binary is available,
`require('jsql-neo')` automatically falls back: **Native → WASM → Pure JS**.

---

## Multiprotocol Server

### One port, every protocol

`createMultiServer` (`jsql serve --pg` in the CLI) listens on **one TCP port** and routes each
connection to the right wire-protocol handler by sniffing the first packet bytes. Clients of all
four protocols connect to the same address and operate on **the same data**.

```js
const { createMultiServer } = require('jsql-neo');
const srv = createMultiServer({
  port: 5432, host: '0.0.0.0', dataDir: './data', noAuth: true,
});
srv.listen(() => console.log('multiprotocol on 5432'));
```

CLI equivalent: `jsql serve --pg -p 5432 --data-dir ./data --no-auth`

### Protocol sniffing

| First byte / signature | Protocol | Notes |
|---|---|---|
| `0x00` (big-endian Int32 length < 2^24) | PostgreSQL | PG StartupMessage length prefix |
| `0x0a` / `0x0d` | MySQL | client handshake version byte |
| Int32LE length + opCode `2004/2012/2013` | MongoDB | OP_QUERY / OP_COMPRESSED / OP_MSG |
| ASCII command / RESP prefix (`* + $ - :`) | Redis | plain command or RESP array |
| Silence > 200ms | MySQL | MySQL clients wait for server greeting first |

Implementation: `sniffProtocol(buf)` in `lib/multiserver.js`, judged on the first 16 bytes.
Redis commands start with printable ASCII; Mongo length prefixes are almost always binary;
PG starts with `0x00` which never collides with MySQL's `0x0a/0x0d`; a 200 ms timeout covers
clients that wait for the server handshake (MySQL).

### Shared data model

All four protocols share one `Database` engine instance per database (lazily created):

- MySQL/PG tables ↔ Mongo collections ↔ Redis key namespace
- A table created via MySQL is immediately visible to Mongo clients (rows = documents)
- Redis keys use a separate namespace (e.g. `app:users:count`) and never collide with tables

### Port & process management

```js
srv.listen();                   // idempotent
srv.address();                  // → { address, port }
srv.close();                    // graceful: close connections, stop engines (flush), free port
```

Each engine runs `engine.stop()` (flush + cleanup) on close. Connections are cleaned up
automatically; a busy port is reported via the `onError` callback.

---

## Speak MySQL

### Supported clients

| Client | Type | Status |
|---|---|---|
| `mysql2` (npm) | Node.js driver | ✅ full (incl. promise API) |
| `mysql` (npm) | Node.js driver | ✅ full |
| Sequelize | ORM | ✅ (mysql dialect) |
| Knex | query builder | ✅ (mysql2 dialect) |
| TypeORM | ORM | ✅ |
| Prisma | ORM | ✅ |
| phpMyAdmin | Web GUI | ✅ |
| HeidiSQL / DBeaver / Navicat | GUI | ✅ |
| mysql CLI | CLI | ✅ |

```js
const mysql = require('mysql2/promise');
const conn = await mysql.createConnection({
  host: '127.0.0.1', port: 5432, user: 'root', database: 'app',
});
const [rows] = await conn.query('SELECT * FROM users WHERE age > ?', [25]);
await conn.end();
```

### Handshake & auth

- Protocol: MySQL 4.1+ handshake (server greeting with version, thread id, auth plugin)
- Auth plugin: `mysql_native_password` (SHA-1 challenge-response)
- `auth: { user: { password, databases } }` — `databases` accepts `'*'` or a list
- `noAuth: true` skips authentication (dev only)

```js
createMysqlServer({
  port: 3306,
  auth: {
    admin:    { password: 'admin123', databases: ['*'] },
    readonly: { password: 'ro123',    databases: ['app'] },
  },
});
```

Auth failure returns the standard `Access denied for user 'x'@'...' (using password: YES)`.

### System variables & meta tables

The server answers the system probes ORMs and GUI tools run at connect time:

- `SELECT VERSION()` → `8.0.0-jsql-neo`
- System variables: `@@version`, `@@version_comment`, …
- `SHOW DATABASES / SHOW TABLES / SHOW COLUMNS / SHOW CREATE TABLE`
- `information_schema.tables / columns / statistics`
- `mysql.user` (internal auth metadata)

```sql
SHOW DATABASES;
SHOW TABLES;
SHOW CREATE TABLE users;
SELECT TABLE_NAME, TABLE_ROWS FROM information_schema.tables WHERE TABLE_SCHEMA = 'app';
```

### MySQL-specific syntax

| Syntax | Description | Example |
|---|---|---|
| `AUTO_INCREMENT` | auto-increment PK (start 1, step 1) | `id INT PRIMARY KEY AUTO_INCREMENT` |
| `ON DUPLICATE KEY UPDATE` | update on conflict | `INSERT ... ON DUPLICATE KEY UPDATE cnt = cnt + 1` |
| `INSERT IGNORE` | ignore conflicts | `INSERT IGNORE INTO t VALUES (...)` |
| `REPLACE INTO` | delete-then-insert on conflict | `REPLACE INTO t VALUES (...)` |
| `LIMIT off, n` | MySQL pagination | `SELECT ... LIMIT 20, 40` |
| Backtick identifiers | `` `column` `` | `` SELECT `name` FROM `users` `` |
| Multi-statement | semicolon-separated batches | `CREATE TABLE ...; INSERT ...; SELECT ...` |
| `IFNULL` / `GROUP_CONCAT` | MySQL-style functions | `SELECT GROUP_CONCAT(name) FROM users` |

### MySQL FAQ

**Q: Why does the MySQL client wait ~200 ms before the handshake?**
A: The multiprotocol sniffer needs the first byte or the timeout before replying (MySQL clients
wait for the server greeting). Single-protocol mode (`createMysqlServer` / `jsql serve`) greets instantly.

**Q: `information_schema` queries come back empty in Sequelize/TypeORM?**
A: Tables must exist first. Use `SHOW TABLES` to verify; the server answers real metadata only
for real tables.

**Q: Do stored procedures work?**
A: No. `CREATE PROCEDURE`/triggers are rejected with a clear error (safety policy). Views are supported.

---

## Speak PostgreSQL

### Supported clients

`pg` (node-postgres), `psql`, pgAdmin 4, DBeaver, TypeORM (postgres dialect), Prisma, Knex, PostgREST-like tools.

```js
const { Client } = require('pg');
const client = new Client({ host: '127.0.0.1', port: 5432, user: 'root', database: 'app' });
await client.connect();
const res = await client.query('SELECT * FROM users WHERE age > $1', [25]);
await client.end();
```

### Authentication (SCRAM-SHA-256)

Full **SCRAM-SHA-256** challenge-response (RFC 5802) over SASL:

1. Client sends `SASLInitialResponse` (username + client-first-message)
2. Server replies `SASLContinue` (server-first-message: salt + iteration count, i=4096)
3. Client sends `SASLResponse` (client-final-message with the Proof)
4. Server verifies the Proof and replies `AuthenticationOk`

Plaintext password auth and noAuth mode are also supported. `psql` and `pg` use SCRAM by default
with zero configuration.

```js
createPgServer({
  port: 5432,
  auth: { 'jsql-admin': { password: 's3cret', databases: ['*'] } },
});
```

### Wire protocol v3 coverage

| Message | Direction | Description |
|---|---|---|
| StartupMessage | C→S | protocol 3.0, user/database |
| PasswordMessage / SASL | C→S | plaintext or SCRAM |
| Query (`Q`) | C→S | simple query |
| Parse/Bind/Execute (`P`/`B`/`E`) | C→S | extended protocol (prepared statements) |
| Describe (`D`) | C→S | statement/portal description |
| Sync (`S`) / Flush (`H`) | C→S | sync |
| Terminate (`X`) | C→S | disconnect |
| AuthenticationOk (`R`) | S→C | auth success |
| RowDescription (`T`) | S→C | result columns |
| DataRow (`D`) | S→C | data rows (text/binary format) |
| CommandComplete (`C`) | S→C | `SELECT n` / `INSERT 0 n` … |
| ReadyForQuery (`I`) | S→C | txn state `I`/`T`/`E` |
| ErrorResponse (`E`) | S→C | errors with SQLSTATE |
| NoticeResponse / ParameterStatus / BackendKeyData | S→C | notices / params / cancel key |

Supported details: extended protocol end-to-end (`$1, $2` params), binary result format codes,
`INSERT ... RETURNING`, `ON CONFLICT DO NOTHING/UPDATE`, empty query → `EmptyQueryResponse`,
CancelRequest recognized (ignored — the engine is immediate).

### PostgreSQL-specific syntax

| Syntax | Example |
|---|---|
| `SERIAL` / `BIGSERIAL` auto-increment | `id SERIAL PRIMARY KEY` |
| `ILIKE` case-insensitive match | `WHERE name ILIKE '%alice%'` |
| `ON CONFLICT (col) DO UPDATE SET ...` | with `EXCLUDED` |
| `ON CONFLICT (col) DO NOTHING` | ignore |
| `RETURNING *` | return affected rows |
| JSONB with `->` / `->>` | `SELECT data->>'name' FROM users` |
| `$1, $2` placeholders | prepared statements |
| Double-quoted identifiers | `SELECT "Name" FROM t` |
| `::` casts | `SELECT '5'::INT` |
| `EXTRACT` / `AGE` / `TO_CHAR` | date functions |

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

### SQLSTATE mapping

| SQLSTATE | Meaning | Trigger |
|---|---|---|
| `42P01` | undefined_table | table missing |
| `42703` | undefined_column | column missing |
| `23505` | unique_violation | duplicate key |
| `23502` | not_null_violation | NOT NULL violated |
| `23503` | foreign_key_violation | FK violation |
| `22007` | invalid_datetime_format | bad date |
| `42601` | syntax_error | SQL syntax |
| `23000` | integrity_constraint_violation | generic constraint |
| `3D000` | invalid_catalog_name | database missing |
| `00000` | successful_completion | OK |

Mapped in `lib/pg_server.js` by message + error code. Unmatched errors fall back to `XX000`/`42601`.

### PostgreSQL FAQ

**Q: `psql` says `no pg_hba.conf entry`?**
A: The server uses its built-in ACL, not pg_hba.conf. Check the `auth` option or use `noAuth: true`.

**Q: Replication protocol / streaming subscriptions?**
A: Not supported (`START_REPLICATION`, logical slots). All regular queries, transactions and
prepared statements work.

**Q: `\dt` shows nothing in psql?**
A: `\dt` relies on `pg_class` metadata. Use SQL directly:
`SELECT * FROM information_schema.tables;`

---

## Speak MongoDB

### Supported clients

| Client | Type | Status |
|---|---|---|
| `mongodb` (official Node driver) | driver | ✅ full (v4/v5/v6) |
| `mongosh` | shell | ✅ full |
| MongoDB Compass | GUI | ✅ |
| `mongoose` | ODM | ✅ (CRUD + some aggregation) |

```js
const { MongoClient } = require('mongodb');
const client = new MongoClient('mongodb://127.0.0.1:5432/app');
await client.connect();
const users = client.db('app').collection('users');
await users.insertOne({ name: 'Alice', age: 30 });
const alice = await users.findOne({ name: 'Alice' });
const all = await users.find({ age: { $gte: 18 } }).sort({ age: -1 }).toArray();
await client.close();
```

### Wire protocol (OP_QUERY / OP_MSG / OP_COMPRESSED)

Implemented per the official Mongo Wire Protocol spec (header + opCode + payload):

| opCode | Name | Description |
|---|---|---|
| `2004` | OP_QUERY | legacy query (`$query` wrapper, skip/return) |
| `2005` | OP_REPLY | reply: flags, cursorID, startingFrom, numberReturned |
| `2012` | OP_COMPRESSED | snappy/zlib compressed payload, decompressed then dispatched |
| `2013` | OP_MSG | modern format: flags, section kind 0/1, checksum |

Handshake notes: the driver first sends `hello`/`ismaster`; the server answers with
`helloOk: true`, `maxWireVersion`/`minWireVersion`, `maxBsonObjectSize`. OP_QUERY replies encode
the cursor id as an Int64 via `{ $long: 0 }`. OP_COMPRESSED is decompressed (compressorId 0=snappy,
1=zlib) before normal dispatch.

### BSON support

| BSON type | code | notes |
|---|---|---|
| Double | `0x01` | float |
| String | `0x02` | UTF-8 |
| Document | `0x03` | nested |
| Array | `0x04` | nested |
| Binary | `0x05` | generic/function/bytes |
| ObjectId | `0x07` | 12-byte id, auto-generated |
| Boolean | `0x08` | |
| Date (UTC) | `0x09` | int64 millis |
| Null | `0x0A` | |
| RegExp | `0x0B` | pattern + flags |
| Int32 | `0x10` | |
| Int64 | `0x12` | `$long` / `$numberLong` |
| Decimal128 | `0x13` | decimal |
| Timestamp | `0x11` | int64 millis |

The encoder supports extended JSON forms (`$oid`, `$numberLong`/`$long`, `$numberDecimal`,
`$date`, `$regex`, `$binary`, `$timestamp`) with arbitrary nesting.

### Database & collection mapping

- URL: `mongodb://host:port/<database>`
- Each Mongo database maps to one engine instance (same as a MySQL schema)
- **Collection = table**: `db.users` ↔ `CREATE TABLE users` — the same data
- Loose schema: inserting into a missing collection auto-creates the table (`_ensureTable`)
- BSON ↔ SQL type coercion: `double→REAL`, `string→TEXT`, `int→INTEGER`, …

### Command reference

| Command | Description |
|---|---|
| `hello` / `ismaster` / `isMaster` | handshake |
| `ping` | liveness |
| `insert` | insert one/many |
| `find` / `findOne` | query (+sort/limit/skip/projection) |
| `count` / `countDocuments` | counts (aggregate-backed) |
| `update` | `{ updates: [{ q, u, upsert, multi }] }` |
| `delete` | `{ deletes: [{ q, limit }] }` |
| `findAndModify` | `{ query, update, remove, new, upsert, sort, fields }` |
| `findOneAndUpdate` / `findOneAndDelete` / `findOneAndReplace` | atomic ops |
| `distinct` | distinct values of a key |
| `aggregate` | aggregation pipeline |
| `create` / `createCollection` | explicit collection |
| `drop` / `dropCollection` / `dropDatabase` | removal |
| `listCollections` / `listDatabases` | listing |
| `serverStatus` / `buildInfo` / `getCmdLineOpts` | metadata |
| `$cmd` (OP_QUERY) | command wrapper |

```js
const r = await coll.findOneAndUpdate(
  { name: 'Alice' },
  { $set: { age: 31 } },
  { upsert: true, returnDocument: 'after' }
);
```

### Query operators

| Operator | Description | Example |
|---|---|---|
| `$eq` / `$ne` | equal / not equal | `{ age: { $eq: 30 } }` |
| `$gt` / `$gte` / `$lt` / `$lte` | comparisons | `{ age: { $gte: 18 } }` |
| `$in` / `$nin` | in list / not in | `{ status: { $in: ['a','b'] } }` |
| `$exists` | field existence | `{ email: { $exists: true } }` |
| `$regex` + `$options` | regex (i/m/s) | `{ name: { $regex: '^A', $options: 'i' } }` |
| `$and` / `$or` / `$nor` | logic | `{ $or: [{a:1},{b:2}] }` |
| `$not` | negation | `{ age: { $not: { $gt: 60 } } }` |
| `$type` | BSON type match | `{ age: { $type: 'int' } }` |
| `$size` | array length | `{ tags: { $size: 2 } }` |
| `$elemMatch` | array element match | `{ scores: { $elemMatch: { $gte: 90 } } }` |
| `$all` / `$mod` | array/per-mod | `{ tags: { $all: ['a','b'] } }` |

Update operators: `$set $unset $inc $push $addToSet $pull $rename $mul`.

```js
await coll.find({
  $and: [
    { age: { $gte: 18, $lte: 35 } },
    { $or: [{ plan: 'pro' }, { plan: 'plus' }] },
    { bio: { $regex: '^developer', $options: 'i' } },
  ]
}).sort({ age: -1 }).limit(10).toArray();
```

### Aggregation pipeline

| Stage | Description |
|---|---|
| `$match` | filter documents |
| `$count` | count |
| `$limit` / `$skip` | paginate |
| `$sort` | sort (1/-1, multi-field) |
| `$project` | projection / derived fields |
| `$unwind` | flatten arrays (preserveNullAndEmptyArrays) |
| `$group` | group + aggregates (`$sum $avg $min $max $first $last`) |
| `$lookup` | basic left-join across collections |
| `$addFields` | add fields |

Expressions: `$year/$month/$dayOfMonth/$hour/$minute/$second`, `$sum/$avg/$min/$max`, `$add/$subtract/$multiply/$divide/$mod`, `$concat`, `$toUpper/$toLower`, `$substr`, `$size`, `$arrayElemAt`, `$literal`.

```js
const res = await db.collection('orders').aggregate([
  { $match: { status: 'paid' } },
  { $group: { _id: '$customer_id', total: { $sum: '$amount' } } },
  { $sort: { total: -1 } },
  { $limit: 5 },
]).toArray();
```

### MongoDB FAQ

**Q: mongosh fails authentication?**
A: mongosh tries SCRAM by default. Either connect without a password (noAuth mode) or match a
configured user. Recommended for dev: `mongodb://host:port/db`.

**Q: Does mongoose work?**
A: Basic CRUD works. Driver-managed features like automatic `_id` ObjectIds need model
config; `save()/find()/updateOne()` work normally.

**Q: Multi-document transactions?**
A: Not supported — returns a clear "transactions not supported" error. Single-document and
single-collection operations are atomic.

---

## Speak Redis

### Supported clients

`ioredis`, `node-redis` (v4), `redis-cli`, redis-benchmark, GUI tools.

```js
const Redis = require('ioredis');
const redis = new Redis({ host: '127.0.0.1', port: 5432 });
await redis.set('k', 'v');
await redis.hset('h', 'field', 'value');
await redis.zadd('rank', 100, 'alice', 90, 'bob');
const top = await redis.zrevrange('rank', 0, 1, 'WITHSCORES');
await redis.quit();
```

### Data types

| Type | Backed by | Commands |
|---|---|---|
| String | internal string | `SET GET MSET MGET SETNX INCR DECR INCRBY DECRBY APPEND STRLEN` |
| Hash | field-value map | `HSET HGET HGETALL HKEYS HVALS HLEN HEXISTS HDEL` |
| List | ordered array | `LPUSH RPUSH LPOP RPOP LRANGE LLEN LREM LINDEX` |
| Set | unique members | `SADD SREM SMEMBERS SISMEMBER SCARD` |
| Sorted Set | score-ordered | `ZADD ZRANGE ZREVRANGE ZSCORE ZCARD ZREM ZINCRBY` |

All types share one key namespace — `SET a 1` then `LPUSH a x` returns `WRONGTYPE`, just like Redis.

### Command reference

**General** — `PING [msg]`, `SELECT idx`, `AUTH user pass`, `ECHO`, `QUIT`, `INFO [section]`,
`KEYS pattern`, `DBSIZE`, `FLUSHDB`/`FLUSHALL`, `TYPE key`, `EXPIRE key sec`, `TTL key`, `PERSIST key`.

**String** — `SET key value [EX s] [PX ms] [NX] [XX]`, `GET`, `MSET k v ...`, `MGET k ...`,
`SETNX`, `INCR`, `INCRBY`, `DECR`, `DECRBY`, `APPEND`, `STRLEN`.

**Hash** — `HSET key f v [f v ...]`, `HGET`, `HGETALL` (flat array), `HKEYS`, `HVALS`, `HLEN`, `HEXISTS`, `HDEL`.

**List** — `LPUSH`/`RPUSH` (multi-value), `LPOP`/`RPOP`, `LRANGE start stop` (negative indexes),
`LLEN`, `LINDEX`, `LREM count v`.

**Set** — `SADD`, `SREM`, `SMEMBERS`, `SISMEMBER`, `SCARD`.

**Sorted Set** — `ZADD key score member ...`, `ZRANGE start stop [WITHSCORES]` (asc),
`ZREVRANGE` (desc), `ZSCORE`, `ZCARD`, `ZREM`, `ZINCRBY`.

```bash
redis-cli -p 5432 ZADD leaderboard 100 alice 90 bob 110 carol
redis-cli -p 5432 ZREVRANGE leaderboard 0 2 WITHSCORES
# 1) "carol" 2) "110" 3) "alice" 4) "100" 5) "bob" 6) "90"
```

### TTL & persistence

- `SET ... EX/PX` and `EXPIRE` both supported; expired keys are removed lazily
- `TTL` returns remaining seconds; `-1` = no TTL, `-2` = key missing
- The Redis namespace is persisted with the engine snapshot on `stop()`; full recovery on restart
- Multi-argument commands (`MSET`, `ZADD`) commit atomically

### Redis FAQ

**Q: `NOAUTH` from redis-cli?**
A: The server requires auth by default. Use `--no-auth` for dev, or supply a strong password in prod.

**Q: Redis Cluster / Sentinel?**
A: Not supported. Single-instance semantics are fully compatible.

**Q: pub/sub (`SUBSCRIBE`)?**
A: Not supported — returns a clear error. All normal commands work.

---

## SQL Reference

### Statements

**DDL** — `CREATE TABLE` (`IF NOT EXISTS`, `AS SELECT`), `DROP TABLE` (`IF EXISTS`),
`TRUNCATE TABLE`, `ALTER TABLE` (ADD/DROP COLUMN, RENAME TO, RENAME COLUMN),
`CREATE VIEW` / `DROP VIEW`, `CREATE DATABASE` / `DROP DATABASE`.

```sql
CREATE TABLE IF NOT EXISTS orders (
  id         INTEGER PRIMARY KEY AUTO_INCREMENT,
  user_id    INT NOT NULL,
  status     VARCHAR(20) DEFAULT 'pending',
  amount     DECIMAL(10,2),
  note       TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_user FOREIGN KEY (user_id) REFERENCES users(id),
  KEY idx_status (status),
  UNIQUE KEY uq_user_amount (user_id, amount)
);
```

**DML** — `SELECT`, `INSERT INTO ... VALUES/SELECT`, `INSERT ... ON DUPLICATE KEY UPDATE`,
`INSERT ... ON CONFLICT DO NOTHING/UPDATE`, `INSERT IGNORE`, `REPLACE INTO`,
`UPDATE ... SET ... WHERE`, `DELETE FROM ... WHERE`, all with `RETURNING`.

**SELECT grammar**

```sql
SELECT [DISTINCT] select_list
FROM table_reference
[JOIN table_reference ON condition]
[WHERE condition]
[GROUP BY column_list [WITH ROLLUP]]
[HAVING condition]
[ORDER BY column [ASC|DESC] [, ...]]
[LIMIT { count | offset, count | count OFFSET offset }]
[RETURNING ...]
```

**JOINs** — `INNER JOIN`, `LEFT JOIN`, `RIGHT JOIN`, `FULL OUTER JOIN`, `CROSS JOIN`,
implicit `FROM a, b WHERE`, self-joins, multi-table chains.

**Subqueries**

```sql
SELECT * FROM orders
WHERE user_id IN (SELECT id FROM users WHERE vip = 1);

SELECT name, (SELECT COUNT(*) FROM orders o WHERE o.user_id = u.id) AS order_count
FROM users u;

SELECT * FROM users u
WHERE EXISTS (SELECT 1 FROM orders o WHERE o.user_id = u.id);

SELECT t.dept, COUNT(*) AS cnt
FROM (SELECT dept FROM emp WHERE salary > 5000) t
GROUP BY t.dept;
```

**Transactions** — `BEGIN` / `START TRANSACTION`, `COMMIT`, `ROLLBACK`,
`SAVEPOINT sp` / `ROLLBACK TO SAVEPOINT` / `RELEASE SAVEPOINT`. Read-committed-equivalent
isolation; per-statement atomicity without explicit transactions; cross-table transactions;
rolled-back changes are invisible to other connections until commit.

```sql
BEGIN;
UPDATE accounts SET balance = balance - 100 WHERE id = 1;
UPDATE accounts SET balance = balance + 100 WHERE id = 2;
SAVEPOINT sp1;
UPDATE accounts SET balance = balance - 100 WHERE id = 3;
ROLLBACK TO SAVEPOINT sp1;
COMMIT;
```

**Other** — `SHOW DATABASES/TABLES/COLUMNS/CREATE TABLE`, `DESCRIBE t`, `USE db`,
`EXPLAIN SELECT`, `SET SESSION x = y`, no-table queries (`SELECT VERSION()`), SQLite-style `PRAGMA`.

### Data types

| Type | Aliases | Notes |
|---|---|---|
| `INTEGER` | `INT BIGINT SMALLINT TINYINT` | integers |
| `SERIAL` / `BIGSERIAL` | — | PG auto-increment |
| `REAL` | `FLOAT DOUBLE DECIMAL(n,m) NUMERIC` | floats/fixed |
| `TEXT` | `VARCHAR(n) CHAR(n) STRING` | strings |
| `BOOLEAN` | `BOOL` | |
| `DATE` / `DATETIME` | `TIMESTAMP TIMESTAMPTZ TIME` | dates/times |
| `BLOB` | `BYTEA BINARY` | binary (Buffer) |
| `JSON` / `JSONB` | — | JSON documents |

Coercion rules: numeric strings compare as numbers (`'5' = 5`), `NULL = NULL` → NULL
(use `IS NULL`), three-valued logic with `IS TRUE/IS FALSE`, explicit casts via
`CAST(x AS t)`, `x::t`, `CONVERT(x, t)`; flexible date-string parsing.

### Scalar functions

**String** — `CONCAT(a, b, ...)` (NULL → empty), `LOWER`/`UPPER`, `LENGTH` (chars),
`CHAR_LENGTH`, `OCTET_LENGTH` (UTF-8 bytes), `SUBSTRING(s, start[, len])` / `SUBSTR` / `MID`,
`LEFT`/`RIGHT`, `TRIM`/`LTRIM`/`RTRIM` (with `BOTH|LEADING|TRAILING`), `REPLACE`, `REVERSE`,
`REPEAT`, `ASCII`/`CHAR`/`ORD`, `GROUP_CONCAT(x[, SEPARATOR ...])`, `LPAD`/`RPAD`, `SPACE`.

**Numeric** — `ABS`, `SIGN`, `ROUND(x[, n])`, `CEIL`/`CEILING`, `FLOOR`, `TRUNCATE`,
`POWER`/`POW`, `SQRT`, `EXP`, `LN`, `LOG`/`LOG10`/`LOG(b, x)`, `MOD`/`%`, `RAND([seed])`,
`GREATEST`/`LEAST`, `HEX`/`UNHEX`/`BIN`, `BIT_COUNT`.

**Date/time** — `NOW()`/`CURRENT_TIMESTAMP`, `CURRENT_DATE`, `CURRENT_TIME`,
`YEAR`/`MONTH`/`DAY`/`HOUR`/`MINUTE`/`SECOND`, `DATE(t)`/`TIME(t)`,
`DATE_ADD(d, INTERVAL n unit)`/`DATE_SUB`/`ADDDATE`/`SUBDATE`
(units: `MICROSECOND SECOND MINUTE HOUR DAY WEEK MONTH QUARTER YEAR`),
`DATEDIFF`, `TIMESTAMPDIFF(unit, d1, d2)`, `DATE_FORMAT`, `STR_TO_DATE`, `TO_CHAR`, `TO_DATE`,
`EXTRACT(part FROM d)` (incl. `DOW`, `DOY`, `WEEK`, `QUARTER`, `EPOCH`), `DATE_PART`, `AGE`,
`DAYOFWEEK`, `DAYNAME`, `MONTHNAME`, `UNIX_TIMESTAMP`, `FROM_UNIXTIME`.

```sql
SELECT DATE_ADD('2026-08-12', INTERVAL 1 DAY);      -- '2026-08-13 00:00:00'
SELECT DATE_FORMAT(NOW(), '%Y-%m-%d %H:%i');        -- '2026-08-12 10:30'
SELECT EXTRACT(YEAR FROM '2026-08-12');             -- 2026
SELECT AGE('2026-08-12', '2020-01-01');             -- '6 years 7 mons 11 days'
```

**Conditional / null** — `IF(cond, a, b)`, `IIF`, `IFNULL(a, b)`, `COALESCE(...)`, `NULLIF`,
`ISNULL`, `CASE WHEN ... THEN ... ELSE ... END` (search/simple form, works with aggregates).

**System & misc** — `VERSION()` → `8.0.0-jsql-neo`, `DATABASE()`, `USER()`/`CURRENT_USER`,
`LAST_INSERT_ID()`, `ROW_COUNT()`, `CAST`/`CONVERT`, `JSON_EXTRACT(doc, '$.path')`,
`JSON_OBJECT`/`JSON_ARRAY`, `JSON_UNQUOTE`, `JSON_CONTAINS`, `JSON_SET/INSERT/REPLACE/REMOVE`,
`UUID()`, `TYPEOF(x)`, `PRINT(x)`.

**Full per-function reference with examples**: see the Chinese edition
[附录 H 函数详解](#附录-h：函数详解与执行语义).

### Aggregate functions

`COUNT(*)` / `COUNT(col)` / `COUNT(DISTINCT col)` / `COUNT(DISTINCT a, b)`, `SUM`,
`SUM(DISTINCT)`, `AVG`, `MIN`, `MAX`, `GROUP_CONCAT(col[, sep])` (with `DISTINCT`, `ORDER BY`),
`STDDEV`/`STDDEV_POP`/`STDDEV_SAMP`, `VARIANCE`/`VAR_POP`/`VAR_SAMP`, `FIRST`/`LAST`.

Rules: no `GROUP BY` → single group; `HAVING` filters groups (aggregate aliases allowed);
multi-column and `WITH ROLLUP` groups; NULL values skipped by `COUNT(col)`/`SUM`/`AVG`.

```sql
SELECT dept, COUNT(*) AS cnt, AVG(salary) AS avg_sal
FROM emp WHERE status = 'active'
GROUP BY dept WITH ROLLUP
HAVING AVG(salary) > 6000
ORDER BY avg_sal DESC;
```

### Operators

**Arithmetic** — `+ - * / % MOD DIV ^` (power, PG style).

**Comparison** — `= <> != < <= > >=`, `IS NULL`, `IS TRUE/FALSE` (three-valued),
`BETWEEN a AND b`, `IN (...)`, `LIKE`/`NOT LIKE`, `ILIKE` (case-insensitive),
`RLIKE`/`REGEXP`, `~ ~* !~ !~*` (PG regex), `EXISTS`, `ANY`/`ALL`/`SOME`, `<=>` (NULL-safe).

**Logic** — `AND OR NOT XOR` (short-circuit), MySQL aliases `&&` `||`.

**Bitwise** — `& | ^ ~ << >>`.

**JSON (PG style)** — `->` (JSON result), `->>` (text), `#>`, `#>>` (paths), `@>` `<@`
(containment), `?` `?|` `?&` (key existence).

### LIKE / ILIKE / regex

- `%` any length, `_` one char, `\` escape (`ESCAPE` clause)
- `ILIKE` = LIKE, case-insensitive
- `REGEXP`/`RLIKE`/`~` use the JS RegExp engine; flags `i/m/s`

```sql
SELECT * FROM users
WHERE email ~* '^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$';
```

### Indexes & constraints

**Indexes** — `PRIMARY KEY` (implicit), `UNIQUE KEY name (cols)`, `KEY name (cols)`,
`CREATE [UNIQUE] INDEX`, `DROP INDEX ... ON table`, composite indexes, multiple indexes per table.

```sql
CREATE INDEX idx_orders_status ON orders (status);
CREATE UNIQUE INDEX uq_email ON users (email);
```

**Constraints** — `PRIMARY KEY`, `NOT NULL`, `UNIQUE`, `DEFAULT` (incl. `CURRENT_TIMESTAMP`),
`CHECK (expr)`, `FOREIGN KEY ... REFERENCES` (with `ON DELETE CASCADE`), `AUTO_INCREMENT`/`SERIAL`,
named constraints (`CONSTRAINT name ...`).

Violations map to MySQL-style codes: `ER_DUP_ENTRY`, `ER_NO_DEFAULT_FOR_FIELD`,
`ER_BAD_NULL_ERROR`, `ER_CHECK_CONSTRAINT`, `ER_NO_REFERENCED_ROW`, `ER_ROW_IS_REFERENCED`.

### Views

```sql
CREATE VIEW active_users AS
SELECT id, name FROM users WHERE status = 'active' AND deleted_at IS NULL;

SELECT * FROM active_users WHERE age > 30;   -- expands live
SHOW TABLES;                                  -- views listed alongside tables
DROP VIEW IF EXISTS active_users;
```

Views are non-materialized; they participate in JOINs/subqueries/aggregates; DML on views is
rejected with a clear error; `CREATE OR REPLACE VIEW` is supported.

### JSON / JSONB

```sql
CREATE TABLE users (id INT PRIMARY KEY, meta JSON, prefs JSONB DEFAULT '{}'::jsonb);

INSERT INTO users (id, meta) VALUES
  (1, '{"name":"Alice","tags":["admin","ops"],"addr":{"city":"SH"}}');

SELECT meta->>'name' AS name, meta->'addr'->>'city' AS city
FROM users WHERE meta @> '{"tags":["admin"]}';
```

JSON columns are fully interoperable with Mongo document views.

### Prepared statements

All three protocols + the embedded API support parameterized queries:

```js
await executeSQL(db, 'SELECT * FROM users WHERE age > ? AND city = ?', [25, 'SH']);
await conn.execute('INSERT INTO users (name, age) VALUES (?, ?)', ['Alice', 30]); // mysql2
await client.query('SELECT * FROM users WHERE age > $1', [25]);                  // pg
await coll.find({ age: { $gt: 25 } }).toArray();                                 // mongo
```

Binding rules: positional binding; values coerced to column types; arrays expand to `IN` lists;
`??` is the identifier placeholder (safe dynamic table/column names).

### Multi-statement

```js
const { splitStatements } = require('jsql-neo');
const stmts = splitStatements('SELECT 1; SELECT 2; -- c\nSELECT 3;');
```

`executeSQL` runs semicolon-separated batches; `splitStatements` correctly skips semicolons
inside strings and comments.

### Safety policy

- `SELECT ... INTO OUTFILE` → rejected
- `LOAD_FILE()` → rejected
- Disabled functions (`SLEEP(...)`) → rejected
- Versioned comments (`/*!50000 ... */`) → treated as plain comments
- The parser is tokenizer-based, so quote-escape/comment-bypass injection is structurally impossible
- Prefer parameterized queries; `escapeId`/`??` for dynamic identifiers

---

## Node.js API Reference

### Database class

```js
const { Database } = require('jsql-neo');
const db = new Database(dataDirOrName, options);
```

| Option | Default | Description |
|---|---|---|
| `dataDirOrName` | — | `':memory:'` or `'./data/db'` |
| `autoSave` | `true` | save after writes |
| `saveInterval` | `3000` | auto-save interval (ms) |
| `compression` | per build | `'lz4'` / `'zstd'` / `'none'` |
| `defaultEngine` | auto | `'native'` / `'wasm'` / `'js'` |
| `logLevel` | `'info'` | log level |

**Lifecycle** — `init()`, `stop()`, `reset()`, `getEngineType()`, `getDataDir()`,
`saveTo(file)`, `loadFrom(file)`, `flush()`, `getStats()`, `backupTo(dir)`, `restoreFrom(dir)`.

**Table management** — `createTable(name, schema, opts)`, `dropTable`, `truncateTable`,
`listTables`, `getTableSchema`, `tableExists`, `renameTable`.

```js
db.createTable('users', {
  id:   { type: 'INT', primaryKey: true, autoIncrement: true },
  name: { type: 'VARCHAR', length: 100, notNull: true },
  age:  { type: 'INT', default: 0 },
  meta: { type: 'JSON' },
  created_at: { type: 'DATETIME', default: 'CURRENT_TIMESTAMP' },
}, { ifNotExists: true });
```

### Data access methods

```js
db.insert('users', row);                 // single → full row
db.insertMany('users', rows, { upsert: true });
db.find('users', filter, { sort, limit, skip, fields });
db.findOne('users', filter);
db.count('users', filter);
db.distinct('users', 'city', filter);
db.update('users', filter, changes);     // → updated count
db.updateOne / db.updateMany
db.removeWhere('users', filter);         // → deleted count
db.removeByIds('users', [1, 2, 3]);
db.getById('users', 1);
db.query('users').where({...}).select([...]).sort({...}).skip(n).limit(n).exec();
db.aggregate('users', [pipelineStages]);
db.createIndex('users', ['status'], { unique: true });
db.dropIndex('users', 'idx_status');
db.beginTransaction(); db.commit(); db.rollback();
db.transaction(async (txn) => { ... });   // auto commit/rollback
```

Document operators (`$set $inc $unset $push $pull $addToSet $rename $mul`) work everywhere.

### executeSQL

```js
const { executeSQL } = require('jsql-neo');
const result = await executeSQL(db, sql, params);
```

```js
{
  columns: ['id', 'name', 'age'],
  columnTypes: ['INTEGER', 'VARCHAR', 'INTEGER'],
  rows: [[1, 'Alice', 30]],
  rowCount: 2, affectedRows: 0, insertId: 1,
  message: '2 rows selected', command: 'SELECT',
  durationMs: 0.42, warnings: [],
}
```

Result matrix: SELECT → `rows`; INSERT → `affectedRows` + `insertId`; UPDATE/DELETE →
`affectedRows`; DDL/txn → `message`. Params: positional `?`, named `:name`, or object maps.
Multi-statement supported; `SQLExecutor` class runs batched SQL from a string/stream.

### Events & hooks

```js
db.on('save', ({ file, size }) => {});
db.on('load', ({ file, tables }) => {});
db.on('insert', ({ table, rows }) => {});
db.on('update', ({ table, ids }) => {});
db.on('delete', ({ table, ids }) => {});
db.on('error', (err) => {});
db.on('stop', () => {});
```

### createXxxServer factories

```js
const { createMysqlServer, createPgServer, createRedisServer, createMongoServer, createMultiServer } = require('jsql-neo');

createMysqlServer({ port: 3306, host: '0.0.0.0', dataDir: './data',
  auth: { admin: { password: 'admin123', databases: ['*'] } }, noAuth: false }).listen();

createPgServer({ port: 5432, dataDir: './data', noAuth: true }).listen();
createRedisServer({ port: 6379, dataDir: './data', auth: 'redispass', snapshotInterval: 5000 }).listen();
createMongoServer({ port: 27017, dataDir: './data', noAuth: true }).listen();
```

All share `listen()`, `address()`, `close()`. Omitting `port` picks an ephemeral one
(read it from `address()`).

### Multiprotocol server API

```js
const srv = createMultiServer({ port: 5432, dataDir: './data', noAuth: true });
srv.listen();
srv.address();                          // { address, port }
srv.on('connection', (socket, protocol) => {});   // 'mysql'|'pg'|'redis'|'mongo'
srv.on('error', (err) => {});
srv.close();
```

### Helpers

```js
const { tokenize, parseSQL, splitStatements, applyParams, escapeValue, escapeId,
        createTUI, TUIShell, renderTable, wswidth, pad } = require('jsql-neo');
```

---

## Command Line Interface

`jsql` is the CLI shipped with the package (`bin/jsql`), built on `@vexify-org/yaggs`.

```bash
jsql serve       # MySQL single-protocol server
jsql serve --pg  # multiprotocol (MySQL+PG+Mongo+Redis on one port)
jsql redis       # standalone Redis server
jsql ui          # Web console + HTTP API
jsql tui         # interactive SQL terminal (zero-dep TUI)
jsql export      # export (JSON/CSV/SQL)
jsql import      # import (SQL dump / JSON / CSV)
jsql bench       # benchmark
jsql mod         # engine module management
jsql version     # version info
```

### jsql serve

```bash
jsql serve -p 3307 --data-dir ./data --host 0.0.0.0   # port/data-dir/host
jsql serve --no-auth                                   # skip auth (dev)
jsql serve --memory                                    # memory-only
jsql serve --user admin --password secret              # credentials
jsql serve --tls --cert server.crt --key server.key    # TLS
jsql serve -q / --verbose                              # log level
```

### jsql serve --pg (multiprotocol)

```bash
jsql serve --pg -p 5432 --data-dir ./data --no-auth
jsql serve --pg -p 5432 --data-dir ./data --user admin --password s3cret
```

Client examples: `mysql2` (port 5432), `psql -p 5432`, `mongosh mongodb://127.0.0.1:5432`,
`redis-cli -p 5432`. Connection logs show the detected protocol.

### jsql redis

```bash
jsql redis -p 6379 --data-dir ./data --no-auth     # standalone Redis
jsql redis -p 6379 --data-dir ./data --password r3dispass
jsql redis -p 6379                                  # memory Redis (default)
```

### jsql ui (Web console)

```bash
jsql ui --data-dir ./data -p 9090 --db app
# → http://127.0.0.1:9090  (zero-dependency single-page console)
```

### jsql export / import

```bash
jsql export ./data --format json --output backup.json     # full DB
jsql export ./data --table users --format csv --output users.csv
jsql export ./data --format sql --output dump.sql
jsql import ./data dump.sql                                # auto-detect format
jsql import ./data users.csv --table users --has-header
```

Options: `--format json|csv|sql`, `--table`, `--output`, `--pretty`, `--no-create`, `--force`,
`--on-error abort|skip`.

### jsql bench

```bash
jsql bench --ops 10000 --concurrency 8 --mode memory --json
# insert / select / update / delete / mixed rates
```

### jsql mod

```bash
jsql mod                      # show current + available engines
jsql mod --engine wasm        # switch engine (restart required)
```

### jsql version

```bash
$ jsql version
jsql-neo v5.3.1
engine: native (napi) | wasm | js
node: v22.0.0  platform: linux x64
```

---

## TUI Interactive Terminal

`jsql tui` is a zero-dependency, raw-mode interactive SQL terminal (`lib/tui.js`). All line
editing, history, completion and table rendering are built in — identical behavior in any
terminal (iTerm2, GNOME Terminal, tmux, Windows Terminal).

### Startup & options

```bash
jsql tui --data-dir ./data --db app --dialect mysql
jsql tui --memory -q                      # memory mode, quiet
jsql tui --prompt 'db> ' --no-color
```

The status bar shows: `db=<name> dialect=<d> mode=<tui|batch> ver=5.3.1`.

### Keyboard shortcuts

| Key | Action |
|---|---|
| `Enter` | execute statement |
| `Ctrl+C` | clear line / exit when empty |
| `Ctrl+D` | exit (EOF) |
| `Ctrl+L` | clear screen |
| `Ctrl+A` / `Home` | line start |
| `Ctrl+E` / `End` | line end |
| `Ctrl+U` | clear line |
| `Ctrl+K` | delete to end |
| `Ctrl+W` | delete word |
| `←` / `→` | move cursor |
| `↑` / `↓` | history |
| `Backspace` / `Delete` | delete |
| `Tab` | completion (keywords/tables/columns) |
| `Shift+Tab` | reverse completion |
| `PgUp` / `PgDn` | history paging |
| `Ctrl+B/F/P/N` | emacs-style motion/history |

### Meta commands

| Command | Description |
|---|---|
| `\q` `\quit` `\exit` `exit` `quit` | quit |
| `\c [db]` / `\use <db>` | switch database |
| `\db` | show current db |
| `\tables` | list tables |
| `\desc <t>` | table structure |
| `\indexes [t]` | indexes |
| `\databases` | list databases |
| `\help` | help |
| `\history` | history |
| `\clear` | clear screen |
| `\echo <text>` | echo |
| `\schema [t]` | SHOW CREATE for a table |

### Continuation & statement boundaries

- Statements end with `;` (or the `\g` meta command)
- Unterminated quotes / unclosed parens enter **continuation mode** (`...>` prompt, indented)
- `Ctrl+C` in continuation mode cancels the pending statement
- Boundary detection honors string escapes and comments (`--`, `/* */`)

```
jsql> SELECT COUNT(*)
  ...> FROM users
  ...> WHERE name = 'Alice';
+----------+
| COUNT(*) |
+----------+
| 1        |
+----------+
1 row in set (0.42 ms)
```

### Batch mode

Non-TTY (pipes, redirects, CI) automatically runs in batch mode:

```bash
echo "SELECT * FROM users;" | jsql tui --data-dir ./data
jsql tui --data-dir ./data < script.sql
```

Batch: executes statements one by one with plain ASCII tables (no ANSI when not a TTY); errors
don't abort the run (collected and summarized); exit code 0 = all OK, 1 = errors; `-q` prints data only.

---

## Web UI & HTTP API

`jsql ui` ships a zero-dependency management console: one HTML page + HTTP API.

| Method | Path | Description |
|---|---|---|
| `GET` | `/` | console page |
| `GET` | `/api/status` | status (version/engine/dbs/tables) |
| `GET` / `POST` | `/api/databases` | list / create |
| `DELETE` | `/api/databases/:name` | drop |
| `GET` | `/api/databases/:db/tables` | tables |
| `GET` | `/api/databases/:db/tables/:table` | schema + preview |
| `POST` | `/api/databases/:db/query` | run SQL `{ sql, params }` |
| `POST` / `GET` | `/api/databases/:db/import` / `export` | migrate |

```bash
curl -s -X POST http://127.0.0.1:8080/api/databases/app/query \
  -H 'Content-Type: application/json' \
  -d '{"sql": "SELECT * FROM users WHERE age > ?", "params": [18]}'
```

Console features: db/table tree, SQL editor (multi-statement), result tables + CSV export,
data preview with pagination, schema inspection, import/export entry points.

> Security: the Web UI has no auth by default. Put it behind a reverse proxy in production,
> or bind to 127.0.0.1.

---

## Compatibility Layers

**mysql2 compat** (`lib/mysql2_compat.js`) — same API as the `mysql2` driver, no network:

```js
const { createMysql2Compat } = require('jsql-neo');
const mysql = createMysql2Compat({ database: ':memory:' });
const conn = await mysql.createConnection({});
const [rows] = await conn.query('SELECT * FROM users WHERE id = ?', [1]);
const [res] = await conn.execute('INSERT INTO users (name) VALUES (?)', ['Alice']);
console.log(res.insertId);            // → 1
```

Switch between embedded and a real MySQL by changing the pool factory — business code unchanged.

**NeDB compat** (`lib/nedb_compat.js`) — NeDB-style embedded datastore:

```js
const { NeDBDatastore } = require('jsql-neo');
const db = new NeDBDatastore({ filename: './data/nedb.json' });
await db.loadDatabase();
await db.insert({ name: 'Alice', age: 30 });
await db.findOne({ name: 'Alice' });
await db.find({ age: { $gt: 30 } }).sort({ age: 1 }).exec();
await db.update({ name: 'Alice' }, { $set: { age: 31 } }, {});
```

**SQLite compat** (`lib/sqlite_compat.js`) — better-sqlite3 / sqlite3 style API:

```js
const { SQLiteCompat } = require('jsql-neo');
const db = new SQLiteCompat(':memory:');
db.prepare('INSERT INTO users (name, age) VALUES (?, ?)').run('Alice', 30);
db.prepare('SELECT * FROM users WHERE age > ?').all(18);
```

---

## Migration Tools

`lib/migrate.js` provides the full migration chain.

**mysqldump import** — import real `mysqldump` output (files or strings, with progress):

```js
const { importDumpFile, importDump } = require('jsql-neo');
await importDumpFile(db, './backup/dump.sql');
await importDump(db, `CREATE TABLE users (id INT PRIMARY KEY, name VARCHAR(50));
INSERT INTO users VALUES (1, 'Alice');`);
```

Supported dump constructs: `CREATE TABLE` (backticks, `AUTO_INCREMENT`, `KEY`, `UNIQUE`),
long multi-row `INSERT`, `LOCK TABLES`/`UNLOCK TABLES` (ignored), `SET @@session.*` (ignored),
versioned comments `/*!40101 SET ... */` (ignored), `USE db;`, comments and blank lines.

**JSON** — full DB export/import with schema:

```js
const { exportAllToJSON, exportTableToJSON, importFromJSON } = require('jsql-neo');
const json = await exportAllToJSON(db);
await importFromJSON(db, json);
```

**CSV** — `exportTableToCSV(db, table)` and `importFromCSV(db, csv, { table, hasHeader })`;
quote handling (`""` escapes), `NULL` for empty cells, type inference (disable via `coerceTypes: false`),
custom `delimiter`.

```bash
jsql import ./data users.csv --table users
jsql export ./data --table users --format csv --output users.csv
```

---

## Storage & Performance

### Three engines

| Engine | Description | Notes |
|---|---|---|
| **native** (default) | Rust N-API addon | fastest, ~2× better-sqlite3 |
| **wasm** | Rust → WebAssembly | browsers, ~80% of native |
| **js** | pure JS fallback | zero toolchain needed |

Fallback chain: `native → wasm → js`. `jsql mod` shows/switches the engine.

### Memory / hybrid / disk modes

| Mode | Trigger | Behavior |
|---|---|---|
| memory | no `dataDir` / `':memory:'` | everything in RAM, lost on exit |
| disk | `dataDir` given | load snapshot at start, auto-save after writes |
| hybrid | `autoSave: true` + `saveInterval` | in-memory writes + periodic async flush |

```
INSERT → memory + change log (tlog) → [saveInterval] → snapshot → file
                                                     ↑ db.flush() for immediate write
```

### B-Tree indexes

Each index is an independent B-Tree; PK and UNIQUE keys build indexes automatically;
composite indexes follow the leftmost-prefix rule; `=` `>` `<` `>=` `<=` `BETWEEN` and
`ORDER BY` can use indexes; indexes and data live in the same snapshot file.

```js
db.createIndex('orders', ['user_id']);
db.createIndex('orders', ['status', 'created_at']);
```

### WAL & crash recovery

- Every write appends to a transaction log (tlog) before touching memory
- `flush()` / auto-save: write snapshot → clear log on success
- Startup: load last snapshot → replay log if present → consistent state
- Corrupt/truncated logs degrade to the last good snapshot with a warning

### Snapshots & compression

Single-file snapshots (schema + indexes + data + Redis key space); compression via
build-time `lz4`/`zstd`; auto-save (default on, 3 s interval); manual `saveTo(file)`/`flush()`;
atomic writes (temp file + rename); idempotent `stop()`.

---

## Security

**Auth & ACL** — same model across all protocol servers:

```js
createMultiServer({
  auth: {
    admin:   { password: 'admin123', databases: ['*'] },
    analyst: { password: 'ro123',    databases: ['app', 'reporting'] },
  },
});
```

`databases: ['*']` = all; failed auth: MySQL `Access denied` / PG `28000` / Redis `NOAUTH` /
Mongo `Unauthorized`. `noAuth: true` is dev-only.

**SQL injection protection** — parameterized queries everywhere; tokenizer-based parser
(quote-escape and comment-bypass structurally impossible); `escapeId`/`??` for dynamic
identifiers; dangerous functions (`SLEEP`, `LOAD_FILE`, `INTO OUTFILE`) rejected at parse time.

**Dangerous statement detection** — `INTO OUTFILE`, `LOAD_FILE`, `SLEEP` → `ER_NOT_SUPPORTED`; path
normalization on data dirs and import/export paths; Web UI db-name whitelist (no `..`, no `/`).

---

## Errors

**MySQL-style codes** (`lib/errors.js`, 33 codes): `1049` unknown db, `1050` table exists,
`1054` unknown column, `1062` duplicate entry, `1146` unknown table, `1064` parse error,
`1115` not supported, `1364` no default, `1406` data too long, `1451/1452` FK errors,
`3819` check violation, `1045` access denied, `1205` lock timeout, `1264` out of range,
`1292` invalid date, `1007/1008` db exists/drop, plus view/trigger/plugin codes.

**SQLSTATE** (PG protocol): `42P01` `42703` `23505` `23502` `23503` `22007` `42601` `23000`
`3D000` — full table in the Chinese edition [SQLSTATE 错误映射](#sqlstate-错误映射).

**JSQL_Error structure:**

```js
{
  code: 'ER_NO_SUCH_TABLE',   // internal key
  sqlState: '42P01',          // PG mapping (protocol layer)
  mysqlCode: 1146,            // MySQL code (protocol layer)
  message: "Table 'users' doesn't exist",
  sql: 'SELECT * FROM users', // optional
}
```

---

## TypeScript

Type declarations ship in `index.d.ts` — `Database`, `executeSQL`, all server factories,
TUI, migration tools and compat layers are covered out of the box:

```ts
import { Database, executeSQL } from 'jsql-neo';
import type { QueryResult, RowFilter } from 'jsql-neo';

const db = new Database(':memory:');
const res: QueryResult = await executeSQL(db, 'SELECT * FROM users WHERE id = ?', [1]);
const rows = db.find('users', { age: { $gte: 18 } satisfies RowFilter });
```

---

## Architecture

### Module layout

```
jsql-neo/
├── bin/jsql                  # CLI entry (yaggs framework)
├── lib/
│   ├── database.js           # ★ core: tables/indexes/txn/persistence
│   ├── sql.js                # ★ SQL tokenizer/parser/executor
│   ├── engine.js             #   engine abstraction (native/wasm/js)
│   ├── native.js | wasm.js | js_engine.js
│   ├── errors.js             #   MySQL-style error codes
│   ├── mysql_server.js       #   MySQL wire protocol
│   ├── pg_server.js          #   PG wire protocol (SCRAM/SQLSTATE)
│   ├── mongo_server.js       #   Mongo wire protocol (OP_MSG/BSON/aggregation)
│   ├── redis_server.js       #   Redis RESP2 (5 types/TTL/snapshots)
│   ├── multiserver.js        #   multiprotocol sniffer/router
│   ├── tui.js                #   zero-dep TUI
│   ├── migrate.js            #   dump/JSON/CSV migration
│   ├── mysql2_compat.js | nedb_compat.js | sqlite_compat.js
│   └── wasm_client.js        #   browser WASM client
├── index.js                  # ★ public API
├── index.d.ts                # TypeScript declarations
├── test/                     # test suite
└── src/rust/                 # Rust engine source (native + wasm)
```

### Query pipeline

```
SQL text → tokenize() → parseSQL() (AST) → SQLExecutor.feed() (multi-statement)
→ executeSelect() (index choice/join order) → Database.find/update/removeWhere (B-Tree or scan)
→ result envelope { columns, types, rows, affectedRows, insertId }
```

Three parallel paths over one engine core: **SQL** (parser → Database), **document**
(Mongo commands → `_match` filter → Database), **key-value** (Redis commands → key namespace).

### How protocol layers share the engine

Connections → protocol handlers (mysql/pg/mongo/redis) → `Database` instance pool (one per
database, lazily created). Writes are serialized by an engine-level write lock; reads run in
parallel; Redis keys live in a separate namespace; `close()` stops in reverse order
(connections → engines → port).

---

## FAQ

**Q: Do I need Rust to use it?** No — prebuilt native binaries ship with the package; the
fallback chain covers everything else. `npm run build` is only for building from source.

**Q: Windows/macOS/Linux?** Yes — prebuilt native binaries for all three (x64/arm64),
plus WASM/JS fallback.

**Q: File format?** Custom binary snapshots (optionally lz4/zstd compressed). Use
`jsql export` (SQL/JSON/CSV) to interoperate with other tools.

**Q: SQLite vs JSQL-NEO?** SQLite is a single-process file DB; JSQL-NEO adds real
MySQL/PG/Mongo/Redis wire servers, browser WASM, and Mongo/Redis semantics — one package
replaces four local services.

**Q: How large can an in-memory DB be?** Bound by the JS heap (~2–4 GB by default).
Use disk mode + indexes for large datasets, or `node --max-old-space-size=8192`.

**Q: Concurrent writes safe?** Yes — engine-level write lock, lock-free parallel reads,
atomic writes across all four protocols.

**Q: Can multiple processes share one data dir?** No (no cross-process lock). Use server
mode (one `jsql serve` process, many clients).

**Q: Browsers can run servers?** No — browsers run the embedded WASM engine only; wire
protocols need TCP (Node.js).

**Q: Encryption?** Snapshot compression is built in; disk encryption via the filesystem
(LUKS etc.).

**Q: How to debug connection issues?** `--verbose` shows protocol detection; single-protocol
mode rules out sniffing; `jsql tui --data-dir <dir>` verifies the data file directly.

---

## Benchmark

```bash
jsql bench --ops 100000 --concurrency 8
```

```
Benchmark: 100,000 ops, concurrency 8, engine native
  insert:  82,410 ops/s
  select: 621,905 ops/s
  update:  95,332 ops/s
  delete: 108,244 ops/s
  mixed:   89,673 ops/s
```

Tuning tips: disable `autoSave` and batch `flush()` for write-heavy loads; `insertMany` /
multi-row VALUES; indexes for hot WHERE columns; projection instead of `SELECT *`; pagination
for big results; connection pooling; larger `saveInterval` + compressed snapshots.

---

## Contributing

```bash
git clone https://github.com/vexify-org/JSQL-neo.git && cd JSQL-neo
npm install && npm run build      # build Rust engine (optional)
npm test                          # all tests
npm run test:core                 # engine core
npm run test:protocols            # protocol E2E (needs real drivers)
npm run lint && npm run typecheck
```

Conventions: feature branch + PR; tests for new SQL/commands; Conventional Commits
(`feat:` / `fix:` / `docs:`); new Mongo/Redis commands register in their command tables +
`TYPE_SIGNATURES`; error handling reuses `lib/errors.js` keys; README stays in sync (bilingual).

---

## License

MIT License — see the Chinese edition [License 许可证](#license-许可证) for the full text.

---

## Appendices A–Z

The complete deep-dive material lives in the Chinese edition below. Index:

| Appendix | Topic | Applies to |
|---|---|---|
| A | MySQL wire protocol internals (handshake, commands, resultset, prepared stmts, auth) | protocol devs |
| B | PostgreSQL wire protocol internals (SCRAM flow, extended protocol, formats) | protocol devs |
| C | Redis RESP internals (formats, wrongtype, snapshot layout) | protocol devs |
| D | MongoDB wire internals (OP_MSG/OP_COMPRESSED layout, BSON codec, dispatch) | protocol devs |
| E | Complete SQL grammar (EBNF) | everyone |
| F | Full Database API signatures | Node devs |
| G | 10 end-to-end recipes | everyone |
| H | Per-function reference with examples | SQL users |
| I | Full CLI options | ops/devs |
| J | Deployment (systemd/Docker/PM2) | ops |
| K | Environment variables & runtime config | ops/devs |
| L | WASM & browser deep dive | frontend |
| M | TUI programmatic API | tool devs |
| N | CHANGELOG | everyone |
| O | Migration guides from other databases | migration engineers |
| P | SQL dialect differences (MySQL/PG/JSQL) | SQL users |
| Q | Performance tuning | ops/architects |
| R | Glossary | newcomers |
| S | Test matrix | contributors |
| T | Client connection references | everyone |
| U | Full error-message catalog | troubleshooters |
| V | JSON data-format spec | integrators |
| W | Performance numbers | architects |
| X | Contributors | contributors |
| Y | Cheat sheets (SQL/Mongo/Redis/Node/CLI) | everyone |
| Z | Links & resources | everyone |

---

*JSQL-NEO — One engine to rule them all. MySQL. PostgreSQL. MongoDB. Redis. SQL. TypeScript. The browser.*
---

## 中文版 Chinese Version

> Code, tables and command examples are language-neutral and shared by both readers.

---

## 📑 目录 Table of Contents

- [为什么选择 JSQL-NEO？ Why JSQL-NEO?](#为什么选择-jsql-neo？-why-jsql-neo)
- [特性总览 Feature Overview](#特性总览-feature-overview)
- [快速开始 Quick Start](#快速开始-quick-start)
  - [安装 Install](#安装-install)
  - [30 秒上手 30-second demo](#30-秒上手-30-second-demo)
  - [Node.js 三行起步](#nodejs-三行起步)
  - [浏览器 / WASM 起步](#浏览器--wasm-起步)
- [多协议服务器 Multiprotocol Server](#多协议服务器-multiprotocol-server)
  - [一个端口，所有协议 One port, every protocol](#一个端口，所有协议-one-port-every-protocol)
  - [协议嗅探原理 Protocol sniffing](#协议嗅探原理-protocol-sniffing)
  - [共享数据模型 Shared data model](#共享数据模型-shared-data-model)
  - [端口与依赖管理 Port & process management](#端口与依赖管理-port--process-management)
- [Speak MySQL — MySQL 协议兼容](#speak-mysql-—-mysql-协议兼容)
  - [支持的客户端 Supported clients](#支持的客户端-supported-clients-3)
  - [握手与认证 Handshake & auth](#握手与认证-handshake--auth)
  - [服务器变量与系统表 System variables & meta tables](#服务器变量与系统表-system-variables--meta-tables)
  - [MySQL 专属语法 MySQL-specific syntax](#mysql-专属语法-mysql-specific-syntax)
  - [MySQL 函数兼容](#mysql-函数兼容)
  - [MySQL 常见问题](#mysql-常见问题)
- [Speak PostgreSQL — PostgreSQL 协议兼容](#speak-postgresql-—-postgresql-协议兼容)
  - [支持的客户端 Supported clients](#支持的客户端-supported-clients-3)
  - [认证 Authentication (SCRAM-SHA-256)](#认证-authentication-scram-sha-256)
  - [Wire protocol v3 支持范围](#wire-protocol-v3-支持范围)
  - [PostgreSQL 专属语法](#postgresql-专属语法)
  - [SQLSTATE 错误映射](#sqlstate-错误映射)
  - [PostgreSQL 常见问题](#postgresql-常见问题)
- [Speak MongoDB — MongoDB Wire 协议兼容](#speak-mongodb-—-mongodb-wire-协议兼容)
  - [支持的客户端 Supported clients](#支持的客户端-supported-clients-3)
  - [Wire 协议实现（OP_QUERY / OP_MSG / OP_COMPRESSED）](#wire-协议实现（op_query--op_msg--op_compressed）)
  - [BSON 支持范围](#bson-支持范围)
  - [数据库与集合映射](#数据库与集合映射)
  - [命令参考 Command reference](#命令参考-command-reference-1)
  - [查询操作符 Query operators](#查询操作符-query-operators)
  - [聚合管道 Aggregation pipeline](#聚合管道-aggregation-pipeline)
  - [MongoDB 常见问题](#mongodb-常见问题)
- [Speak Redis — Redis 协议兼容](#speak-redis-—-redis-协议兼容)
  - [支持的客户端 Supported clients](#支持的客户端-supported-clients-3)
  - [数据类型 Data types](#数据类型-data-types-1)
  - [命令参考 Command reference](#命令参考-command-reference-1)
  - [TTL 与持久化 TTL & persistence](#ttl-与持久化-ttl--persistence)
  - [Redis 常见问题](#redis-常见问题)
- [SQL 语言参考 SQL Reference](#sql-语言参考-sql-reference)
  - [支持的语句 Statements](#支持的语句-statements)
  - [数据类型 Data types](#数据类型-data-types-1)
  - [标量函数 Scalar functions](#标量函数-scalar-functions)
  - [聚合函数 Aggregate functions](#聚合函数-aggregate-functions)
  - [运算符 Operators](#运算符-operators)
  - [LIKE / ILIKE / 正则](#like--ilike--正则)
  - [事务 Transactions](#事务-transactions)
  - [索引与约束 Indexes & constraints](#索引与约束-indexes--constraints)
  - [视图 Views](#视图-views)
  - [JSON / JSONB 支持](#json--jsonb-支持)
  - [参数化查询 Prepared statements](#参数化查询-prepared-statements)
  - [多语句与批处理 Multi-statement](#多语句与批处理-multi-statement)
  - [安全策略 Safety policy](#安全策略-safety-policy)
- [Node.js API 参考 Node API Reference](#nodejs-api-参考-node-api-reference)
  - [Database 类](#database-类)
  - [executeSQL](#executesql)
  - [数据访问方法 Data access methods](#数据访问方法-data-access-methods)
  - [事件与 Hook](#事件与-hook)
  - [创建服务器 createXxxServer](#创建服务器-createxxxserver)
  - [多协议服务器 API](#多协议服务器-api)
- [CLI 命令行工具 Command Line](#cli-命令行工具-command-line)
  - [jsql serve](#jsql-serve)
  - [jsql serve --pg（多协议）](#jsql-serve---pg（多协议）-1)
  - [jsql redis](#jsql-redis-1)
  - [jsql ui（Web 管理台）](#jsql-ui（web-管理台）)
  - [jsql export / import（迁移工具）](#jsql-export--import（迁移工具）)
  - [jsql bench（基准测试）](#jsql-bench（基准测试）)
  - [jsql mod（模块管理）](#jsql-mod（模块管理）)
  - [jsql version](#jsql-version-1)
- [TUI 交互式终端](#tui-交互式终端)
  - [启动与选项](#启动与选项)
  - [快捷键 Keyboard shortcuts](#快捷键-keyboard-shortcuts)
  - [元命令 Meta commands](#元命令-meta-commands)
  - [续行与语句边界](#续行与语句边界)
  - [批处理模式 Batch mode](#批处理模式-batch-mode)
- [Web UI 与 HTTP API](#web-ui-与-http-api)
- [兼容层 Compatibility Layers](#兼容层-compatibility-layers)
  - [mysql2 / TypeORM / Sequelize 内存兼容](#mysql2--typeorm--sequelize-内存兼容)
  - [NeDB 兼容 Datastore](#nedb-兼容-datastore)
  - [SQLite 兼容层](#sqlite-兼容层)
- [数据迁移工具 Migration Tools](#数据迁移工具-migration-tools)
  - [mysqldump 导入](#mysqldump-导入)
  - [JSON 导入导出](#json-导入导出)
  - [CSV 导入导出](#csv-导入导出)
- [存储引擎与性能 Storage & Performance](#存储引擎与性能-storage--performance)
  - [三种运行模式 Three engines](#三种运行模式-three-engines)
  - [内存 / 混合 / 磁盘模式](#内存--混合--磁盘模式)
  - [B-Tree 索引](#b-tree-索引)
  - [WAL 与崩溃恢复 WAL & crash recovery](#wal-与崩溃恢复-wal--crash-recovery)
  - [快照与压缩 Snapshots & compression](#快照与压缩-snapshots--compression)
- [安全性 Security](#安全性-security)
  - [认证与 ACL](#认证与-acl)
  - [SQL 注入防护](#sql-注入防护)
  - [危险语句检测](#危险语句检测)
  - [路径遍历防护](#路径遍历防护)
- [错误码与错误处理 Errors](#错误码与错误处理-errors)
  - [MySQL 风格错误码](#mysql-风格错误码)
  - [PostgreSQL SQLSTATE](#postgresql-sqlstate)
  - [JSQL_Error 结构](#jsql_error-结构)
- [TypeScript 支持](#typescript-支持)
- [内部架构 Architecture](#内部架构-architecture)
  - [模块布局 Module layout](#模块布局-module-layout)
  - [查询执行管线 Query pipeline](#查询执行管线-query-pipeline)
  - [协议层如何共享引擎](#协议层如何共享引擎)
- [FAQ 常见问题](#faq-常见问题)
- [基准测试 Benchmark](#基准测试-benchmark)
- [贡献与开发 Contributing](#贡献与开发-contributing)
- [License 许可证](#license-许可证)

---

## 为什么选择 JSQL-NEO？ Why JSQL-NEO?

Most embedded databases make you choose: *native speed*, *portable WASM*, or *a familiar file format*.
JSQL-NEO gives you **all of them in one install** — plus drop-in compatibility with the most popular
database protocols in the world.

| 维度 Dimension | JSQL-NEO | better-sqlite3 | sql.js (WASM) | LevelDB | 本地 redis/mongo 服务 |
|---|---|---|---|---|---|
| 原生速度 Native speed | ✅ Rust N-API | ✅ | ❌ | ✅ | ✅ |
| 浏览器运行 Browser | ✅ WASM | ❌ | ✅ | ❌ | ❌ |
| 零运行时依赖 Zero deps | ✅ | ✅ | ✅ | ✅ | ❌ |
| MySQL 协议 | ✅ | ❌ | ❌ | ❌ | ❌ |
| PostgreSQL 协议 | ✅ | ❌ | ❌ | ❌ | ❌ |
| MongoDB Wire 协议 | ✅ | ❌ | ❌ | ❌ | 只有 MongoDB |
| Redis RESP2 | ✅ | ❌ | ❌ | ❌ | 只有 Redis |
| 多协议同一端口 | ✅ | ❌ | ❌ | ❌ | ❌ |
| 交互式 TUI | ✅ | ❌ | ❌ | ❌ | ❌ |

- ⚡ **Rust core** — N-API native addon, ~2× faster than better-sqlite3
- 🧩 **WASM build** — the *same engine* runs in Node.js **and any browser**, zero native deps
- 🐘 **MySQL protocol** — `mysql2`, Sequelize, Knex, TypeORM, phpMyAdmin … **just work**, no plugin
- 🐘 **PostgreSQL protocol** — `pg`, `psql`, pgAdmin — SCRAM-SHA-256 auth, prepared statements, JSONB, ILIKE, `ON CONFLICT`, `SERIAL` auto-increment
- 🍃 **MongoDB wire protocol** — official `mongodb` driver, mongosh, Compass — OP_MSG/OP_QUERY/OP_COMPRESSED, BSON, CRUD, aggregation
- 🐇 **Redis protocol** — `ioredis`, node-redis, redis-cli — strings, hashes, lists, sets, sorted sets, TTL, snapshots
- 🔌 **One port. Every protocol.** — protocol sniffing routes MySQL / PostgreSQL / Redis / MongoDB clients to the **same endpoint and the same data**
- 🧮 **Function compatibility** — `CONCAT`, `LOWER`, `UPPER`, `COALESCE`, `IFNULL`, `GREATEST`, `NULLIF`, `DATE_PART`, `EXTRACT`, `TRIM`, `SUBSTRING`, `AGE`, `NOW`, `VERSION` … across SQL dialects
- 🖥️ **Zero-dependency TUI** — `jsql tui` interactive SQL terminal: line editing, history, Tab completion, CJK-aligned tables, meta commands
- 🌐 **Built-in Web UI** — a zero-dependency management console ships with the package
- 🗃️ **Three storage modes** — memory-first, hybrid (LRU + async flush), and disk
- 📦 **Zero runtime dependencies** — the whole world is your `node_modules`

---

## 特性总览 Feature Overview

### 1. 多协议服务器（核心亮点）

```
┌─────────────────────────────────────────────────────────────┐
│                     jsql serve --pg -p 5432                  │
│                      (single TCP port)                       │
│                                                              │
│   mysql2 ──┐                                                 │
│   Sequelize┤                                                 │
│   psql     ─┤   ┌─────────────────────────────────┐          │
│   pgAdmin   ─┤──►│  protocol sniffing (first bytes)│          │
│   mongosh   ─┤   └─────────────────────────────────┘          │
│   Compass    ─┤        │        │        │        │           │
│   ioredis    ─┤        ▼        ▼        ▼        ▼           │
│   redis-cli  ─┘   ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐        │
│                    │ MySQL │ │ PG    │ │ Mongo│ │ Redis │        │
│                    └──────┘ └──────┘ └──────┘ └──────┘        │
│                        └──────┬──────┘                        │
│                               ▼                               │
│                      ┌─────────────────┐                      │
│                      │  shared engine  │                      │
│                      │  (one data dir) │                      │
│                      └─────────────────┘                      │
└─────────────────────────────────────────────────────────────┘
```

同一个端口、同一份数据：用 `psql` 写进去，用 `mysql2` 读出来，用 `mongosh` 查出来，用 `redis-cli` 做缓存。

### 2. 四种 SQL/NoSQL 语义

- **MySQL 语义**：`AUTO_INCREMENT`、`ON DUPLICATE KEY UPDATE`、`information_schema`、`SHOW` 语句
- **PostgreSQL 语义**：`SERIAL`、`ILIKE`、`ON CONFLICT`、JSONB、`RETURNING`、预处理语句
- **MongoDB 语义**：文档 CRUD、`$gt/$regex/$in` 操作符、`findOneAndUpdate`、聚合管道
- **Redis 语义**：String/Hash/List/Set/ZSet、TTL、快照持久化

### 3. 运行形态

| 形态 | 入口 | 适用场景 |
|---|---|---|
| 嵌入式（内存） | `new Database(':memory:')` | 测试、开发、缓存 |
| 嵌入式（磁盘） | `new Database('./data/db')` | 单机应用 |
| 服务器（四协议） | `createMultiServer(...)` / `jsql serve --pg` | 多客户端、微服务、团队共享 |
| 浏览器（WASM） | `JSQL`（lib/wasm_client） | 浏览器内查询 |
| 交互式终端 | `jsql tui` | 手动管理、调试 |

---

## 快速开始 Quick Start

### 安装 Install

```bash
# 方式一：从 npm 安装（推荐）
npm install jsql-neo

# 方式二：从 GitHub 安装最新主分支
npm install github:vexify-org/JSQL-neo

# 方式三：本地开发/构建
git clone https://github.com/vexify-org/JSQL-neo.git
cd JSQL-neo
npm install
npm run build   # 构建 native + wasm（可选，未构建时自动回退纯 JS）
```

安装后验证：

```bash
node -e "const j = require('jsql-neo'); console.log('jsql-neo', require('jsql-neo/package.json').version)"
```

> 运行时**零依赖**：`dependencies` 只声明了 CLI 框架 `@vexify-org/yaggs`（仅命令行需要），核心引擎
> 与所有协议服务器在浏览器/嵌入式场景下不需要任何外部包。

### 30 秒上手 30-second demo

```bash
# 终端 1：启动多协议服务器（一个端口四个协议）
jsql serve --pg -p 5432 --data-dir ./data

# 终端 2：用 MySQL 客户端写入
mysql -h 127.0.0.1 -P 5432 -u root -e "
  CREATE DATABASE app;
  USE app;
  CREATE TABLE users (id INT PRIMARY KEY AUTO_INCREMENT, name VARCHAR(50));
  INSERT INTO users (name) VALUES ('Alice'), ('Bob');
"

# 终端 3：用 PostgreSQL 客户端读取
psql -h 127.0.0.1 -p 5432 -U root -d app -c "SELECT * FROM users;"

# 终端 4：用 MongoDB 客户端操作同一张表
mongosh mongodb://127.0.0.1:5432/app --eval "db.users.find({name: 'Alice'})"

# 终端 5：用 Redis 客户端做缓存
redis-cli -h 127.0.0.1 -p 5432 SET app:users:count 2
redis-cli -h 127.0.0.1 -p 5432 GET app:users:count
```

### Node.js 三行起步

```js
const { Database, executeSQL } = require('jsql-neo');

const db = new Database(':memory:', { autoSave: false });
await executeSQL(db, "CREATE TABLE users (id INT PRIMARY KEY AUTO_INCREMENT, name VARCHAR(50))");
await executeSQL(db, "INSERT INTO users (name) VALUES ('Alice')");
const { rows } = await executeSQL(db, "SELECT * FROM users");
console.log(rows); // [[1, 'Alice']]
```

更完整的嵌入式示例：

```js
const { Database, executeSQL } = require('jsql-neo');

(async () => {
  const db = new Database('./data/app');          // 磁盘模式（自动保存）
  db.createTable('users', {
    id:   { type: 'INT', primaryKey: true, autoIncrement: true },
    name: { type: 'VARCHAR', length: 100 },
    age:  { type: 'INT' },
  });
  db.insert('users', { name: 'Alice', age: 30 });
  db.insert('users', { name: 'Bob', age: 25 });

  // 三种查询方式
  const r1 = db.find('users', { age: { $gte: 26 } });          // 文档式过滤
  const r2 = await executeSQL(db, 'SELECT * FROM users WHERE age > ?', [25]); // 参数化 SQL
  const r3 = db.query('users').where({ name: 'Alice' }).limit(10).exec();     // 链式 Query

  console.log('r1:', r1.length, 'r2:', r2.rows.length, 'r3:', r3.length);
  db.stop(); // 关闭并落盘
})();
```

### 浏览器 / WASM 起步

```html
<script type="module">
  import { JSQL } from 'jsql-neo/dist/wasm.js';   // 或从 lib/wasm_client.js 引入
  const db = new JSQL();
  await db.start();
  await db.createTable('users', { name: { type: 'string' } });
  await db.insert('users', { name: 'Alice' });
  const users = await db.find('users', {});
  console.log(users);
  await db.stop();
</script>
```

WASM 模式与 Native 模式共享同一套 SQL 语法与数据 API，仅引擎实现不同。
当环境没有 native 二进制时，`require('jsql-neo')` 会自动回退：**Native → WASM → Pure JS**。

---

## 多协议服务器 Multiprotocol Server

### 一个端口，所有协议 One port, every protocol

`createMultiServer`（CLI: `jsql serve --pg`）监听**一个 TCP 端口**，通过首包特征嗅探把连接路由到正确的
wire-protocol 处理器。四种协议的客户端连同一个地址、操作**同一份数据**。

```js
const { createMultiServer } = require('jsql-neo');

const srv = createMultiServer({
  port: 5432,        // 监听端口
  host: '0.0.0.0',   // 对外监听地址
  dataDir: './data', // 数据目录（省略则为纯内存）
  noAuth: true,      // 免认证（默认 false）
  auth: { root: { password: 'secret', databases: ['*'] } }, // 用户表（可选）
});

srv.listen(() => console.log('multiprotocol on 5432'));
// ... 之后 srv.close() 优雅退出
```

命令行等价形式：

```bash
jsql serve --pg -p 5432 --data-dir ./data --no-auth
```

### 协议嗅探原理 Protocol sniffing

连接建立后，服务器收集首包字节并按下表判定：

| 首字节 / 特征 | 协议 | 说明 |
|---|---|---|
| `0x00`（大端 Int32 长度，< 2^24） | PostgreSQL | PG 的 StartupMessage 长度头 |
| `0x0a` / `0x0d` | MySQL | client handshake 协议版本字节 |
| Int32LE 长度 + opCode `2004/2012/2013` | MongoDB | OP_QUERY / OP_COMPRESSED / OP_MSG |
| ASCII 命令 / RESP 前缀（`* + $ - :`） | Redis | 普通命令或 RESP 数组 |
| 200ms 内无任何字节 | MySQL | MySQL 客户端等待服务器握手包，超时后按 MySQL 处理 |

实现位于 `lib/multiserver.js` 的 `sniffProtocol(buf)`，判定基于前 16 字节，误判率极低：

- Redis 命令首字节必为可打印 ASCII，而 Mongo 消息长度首字节几乎总是二进制字节；
- PG 首字节为 `0x00`，与 MySQL 的 `0x0a/0x0d` 不可能混淆；
- MySQL 不主动发包的客户端（等待握手）由 200ms 超时兜底。

### 共享数据模型 Shared data model

四种协议共享同一个 `Database` 引擎实例（按库名懒创建）：

- MySQL / PG 的表 ↔ Mongo 的集合 ↔ Redis 的独立 key 命名空间
- 用 MySQL 建的表可以直接被 Mongo 客户端按集合名访问（行即文档）
- Redis key 使用独立命名空间（如 `app:users:count`），不与表冲突

```js
// 多协议服务器内部结构（伪代码）
getEngine('app')  // → Database('./data/app')
  ├── mysql 处理器   ── 读同一引擎
  ├── pg 处理器      ── 读同一引擎
  ├── mongo 处理器   ── 读同一引擎
  └── redis 处理器   ── 读同一引擎（独立 key Map）
```

### 端口与依赖管理 Port & process management

```js
srv.listen();                  // 启动监听（幂等）
srv.address()                  // → { address, port } 实际地址
srv.close()                    // 关闭所有连接、停止所有引擎的落盘、释放端口
```

- 每个引擎在 `close()` 时执行 `engine.stop()`（落盘 + 清理）
- 连接断开自动清理（`_sockets` 集合）
- 端口被占用时通过 `onError` 回调通知，默认抛出

---

## Speak MySQL — MySQL 协议兼容

### 支持的客户端 Supported clients

经过验证的客户端清单：

| 客户端 | 类型 | 兼容情况 |
|---|---|---|
| `mysql2` (npm) | Node.js 驱动 | ✅ 完整（含 promise API） |
| `mysql` (npm) | Node.js 驱动 | ✅ 完整 |
| Sequelize | ORM | ✅（mysql 方言） |
| Knex | Query Builder | ✅（mysql2 方言） |
| TypeORM | ORM | ✅（mysql 方言） |
| Prisma | ORM | ✅（mysql 连接） |
| phpMyAdmin | Web GUI | ✅ |
| HeidiSQL | Windows GUI | ✅ |
| DBeaver | GUI | ✅ |
| Navicat | GUI | ✅（连接 → 常见操作） |
| mysql CLI | 命令行 | ✅ |

```js
// mysql2 连接示例
const mysql = require('mysql2/promise');
const conn = await mysql.createConnection({
  host: '127.0.0.1', port: 5432, user: 'root', database: 'app',
});
const [rows] = await conn.query('SELECT * FROM users WHERE age > ?', [25]);
await conn.end();
```

### 握手与认证 Handshake & auth

- **握手协议**：MySQL 4.1+ 握手包（server greeting），包含协议版本、服务器版本、线程 ID、auth 插件声明
- **认证插件**：`mysql_native_password`（SHA-1 挑战应答）
- **auth 选项**：`{ user: { password, databases } }`，`databases` 支持 `'*'` 或数据库数组
- **noAuth**：`noAuth: true` 时跳过认证（适合本地开发）

```js
createMysqlServer({
  port: 3306,
  auth: {
    admin: { password: 'admin123', databases: ['*'] },
    readonly: { password: 'ro123', databases: ['app'] },
  },
});
```

认证失败返回标准错误 `Access denied for user 'xxx'@'...' (using password: YES)`。

### 服务器变量与系统表 System variables & meta tables

支持常见系统查询，让 ORM 与 GUI 工具的初始化探测流程正常工作：

- `SELECT VERSION()` → `8.0.0-jsql-neo`
- `SELECT @@version` / `@@version_comment` 等系统变量
- `SHOW DATABASES` / `SHOW TABLES` / `SHOW COLUMNS FROM t` / `SHOW CREATE TABLE t`
- `information_schema.tables` / `information_schema.columns` / `information_schema.statistics`
- `mysql.user`（认证元数据，仅内部使用）

```sql
SHOW DATABASES;
SHOW TABLES;
SHOW CREATE TABLE users;
SELECT TABLE_NAME, TABLE_ROWS FROM information_schema.tables WHERE TABLE_SCHEMA = 'app';
```

### MySQL 专属语法 MySQL-specific syntax

| 语法 | 说明 | 示例 |
|---|---|---|
| `AUTO_INCREMENT` | 自增主键（起始 1，步长 1） | `id INT PRIMARY KEY AUTO_INCREMENT` |
| `ON DUPLICATE KEY UPDATE` | 冲突时更新 | `INSERT ... ON DUPLICATE KEY UPDATE cnt = cnt + 1` |
| `INSERT IGNORE` | 忽略冲突 | `INSERT IGNORE INTO t VALUES (...)` |
| `REPLACE INTO` | 冲突时删除再插入 | `REPLACE INTO t VALUES (...)` |
| `LIMIT` 分页 | `LIMIT n` / `LIMIT off, n` / `LIMIT n OFFSET off` | `SELECT ... LIMIT 10 OFFSET 20` |
| 反引号标识符 | `` `column` `` | `` SELECT `name` FROM `users` `` |
| 多语句 | 分号分隔批量执行 | `CREATE TABLE ...; INSERT ...; SELECT ...` |
| `IFNULL` / `GROUP_CONCAT` | MySQL 风格函数 | `SELECT GROUP_CONCAT(name) FROM users` |

### MySQL 函数兼容

完整函数清单见 [标量函数 Scalar functions](#标量函数-scalar-functions)，MySQL 侧重点：

| 函数 | 行为 |
|---|---|
| `VERSION()` | `8.0.0-jsql-neo` |
| `NOW()` / `CURRENT_TIMESTAMP` | `YYYY-MM-DD HH:MM:SS`（UTC） |
| `CONCAT(a, b, ...)` | 字符串拼接 |
| `GROUP_CONCAT(x)` | 聚合拼接（逗号分隔） |
| `IFNULL(a, b)` / `COALESCE(...)` | 空值回退 |
| `LENGTH` / `CHAR_LENGTH` | 字节/字符长度 |
| `REPLACE` / `SUBSTRING` / `LEFT` / `RIGHT` / `TRIM` | 字符串处理 |
| `ROUND` / `ABS` / `POWER` / `SQRT` | 数值 |
| `GREATEST` / `LEAST` | 极值 |

### MySQL 常见问题

**Q: 为什么 MySQL 客户端连上后等 200ms 才握手？**
A: 多协议嗅探需要等待首包或超时（MySQL 客户端等待服务器先发握手包）。单协议模式
（`createMysqlServer` / `jsql serve`）握手是即时的。

**Q: Sequelize/TypeORM 初始化时报 `information_schema` 查询为空？**
A: 请确认建表使用 `CREATE TABLE` 而非仅通过 ORM 的 `sync({ force })` 之前执行——服务器支持
`information_schema` 查询，但表必须真实存在。可用 `SHOW TABLES` 验证。

**Q: 支持存储过程吗？**
A: 不支持存储过程/触发器 DDL 执行（`CREATE PROCEDURE` 会被安全策略拦截并给出明确错误）。
支持视图（`CREATE VIEW`）。

## Speak PostgreSQL — PostgreSQL 协议兼容

### 支持的客户端 Supported clients

| 客户端 | 类型 | 兼容情况 |
|---|---|---|
| `pg` (node-postgres) | Node.js 驱动 | ✅ 完整 |
| `psql` | 官方 CLI | ✅ 完整 |
| pgAdmin 4 | GUI | ✅ 连接/浏览/查询 |
| DBeaver | GUI | ✅ |
| TypeORM | ORM | ✅（postgres 方言） |
| Prisma | ORM | ✅（postgres） |
| Knex | Query Builder | ✅ |
| PostgREST 类似工具 | HTTP→SQL | ✅（只要用 libpq 协议） |

```js
// node-postgres 连接示例
const { Client } = require('pg');
const client = new Client({
  host: '127.0.0.1', port: 5432, user: 'root',
  password: 'secret', database: 'app',
});
await client.connect();
const res = await client.query('SELECT * FROM users WHERE age > $1', [25]);
console.log(res.rows);
await client.end();
```

### 认证 Authentication (SCRAM-SHA-256)

PG 协议完整实现了 **SCRAM-SHA-256** 挑战-应答（RFC 5802）：

1. 客户端发送 `SASLInitialResponse`（用户名 + client-first-message）
2. 服务器计算并发送 `SASLResponse`（server-first-message：salt + iteration count）
3. 客户端回传 `SASLResponse`（client-final-message：Proof）
4. 服务器验证 Proof，发送 `AuthenticationOk`

此外支持 `AuthenticationCleartextPassword`（明文口令）与 `AuthenticationOk`（noAuth 模式）。
`psql` 与 `pg` 驱动默认即 SCRAM 流程，无需额外配置。

```js
createPgServer({
  port: 5432,
  auth: {
    'jsql-admin': { password: 's3cret', databases: ['*'] },
  },
  // 不传 auth 或传 noAuth: true 则跳过认证
});
```

### Wire protocol v3 支持范围

| 消息类型 | 方向 | 说明 |
|---|---|---|
| StartupMessage | C→S | 协议版本 3.0、user/database 参数 |
| PasswordMessage | C→S | 明文或 SCRAM 首消息 |
| Query (`Q`) | C→S | 简单查询 |
| Parse (`P`) / Bind (`B`) / Execute (`E`) | C→S | 扩展协议（预处理语句） |
| Describe (`D`) | C→S | 语句/端口描述 |
| Sync (`S`) / Flush (`H`) | C→S | 协议同步 |
| Terminate (`X`) | C→S | 断开 |
| AuthenticationOk (`R`) | S→C | 认证成功 |
| RowDescription (`T`) | S→C | 结果集列描述 |
| DataRow (`D`) | S→C | 数据行（文本/二进制格式） |
| CommandComplete (`C`) | S→C | 语句完成标签（`SELECT n` / `INSERT 0 n` 等） |
| ReadyForQuery (`I`) | S→C | 事务状态（`I`/`T`/`E`） |
| ErrorResponse (`E`) | S→C | 错误（含 SQLSTATE） |
| NoticeResponse (`N`) | S→C | 提示 |
| EmptyQueryResponse (`I`) | S→C | 空语句 |
| ParameterStatus (`S`) | S→C | `client_encoding` 等 |
| BackendKeyData (`K`) | S→C | 取消秘钥（保留） |

支持的功能细节：

- **扩展协议（预处理语句）**：`Parse/Bind/Execute/Describe/Sync` 全链路，`$1, $2 ...` 参数
- **二进制结果格式**：`Bind` 结果格式码 `0`（文本）与 `1`（二进制）均支持（数值/JSON 以文本安全编码）
- **多列/多行结果**：单条 `SELECT` 返回完整结果集；多条语句按语句依次发送结果
- **`INSERT ... RETURNING`**：返回被插入行
- **`ON CONFLICT DO NOTHING / DO UPDATE`**：完整实现
- **空查询**：`;` 或空字符串返回 `EmptyQueryResponse`
- **取消请求 CancelRequest**：识别并忽略（由客户端重试）

### PostgreSQL 专属语法

| 语法 | 说明 | 示例 |
|---|---|---|
| `SERIAL` / `BIGSERIAL` | 自增列（内部映射 AUTO_INCREMENT） | `id SERIAL PRIMARY KEY` |
| `ILIKE` | 大小写不敏感模糊匹配 | `WHERE name ILIKE '%alice%'` |
| `ON CONFLICT (col) DO UPDATE SET ...` | 冲突更新 | `INSERT ... ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name` |
| `ON CONFLICT (col) DO NOTHING` | 冲突忽略 | `INSERT ... ON CONFLICT (id) DO NOTHING` |
| `RETURNING *` | 返回受影响行 | `UPDATE ... SET ... RETURNING *` |
| `LIMIT ... OFFSET` | 分页 | `SELECT ... LIMIT 5 OFFSET 10` |
| JSONB 类型与 `->` / `->>` 运算符 | JSON 路径访问 | `SELECT data->>'name' FROM users` |
| `$1, $2` 参数占位符 | 预处理 | `WHERE id = $1` |
| 双引号标识符 | 大小写敏感引用 | `SELECT "Name" FROM t` |
| `::` 类型转换 | `value::type` | `SELECT '5'::INT` |
| `EXTRACT(... FROM ...)` | 日期提取 | `SELECT EXTRACT(YEAR FROM NOW())` |
| `AGE(...)` | 区间差 | `SELECT AGE(NOW(), created_at)` |
| `TO_CHAR(...)` | 格式化 | `SELECT TO_CHAR(NOW(), 'YYYY-MM')` |

```sql
-- 一条典型的 PG 方言事务
BEGIN;
CREATE TABLE IF NOT EXISTS accounts (
  id     SERIAL PRIMARY KEY,
  email  TEXT UNIQUE NOT NULL,
  name   TEXT,
  meta   JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
INSERT INTO accounts (email, name) VALUES ('a@x.com', 'Alice')
  ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name
  RETURNING *;
SELECT name, meta->>'plan' AS plan FROM accounts WHERE name ILIKE '%ali%';
COMMIT;
```

### SQLSTATE 错误映射

PG 协议错误响应带标准 SQLSTATE 码，便于客户端/ORM 精确处理：

| SQLSTATE | 含义 | 触发场景 |
|---|---|---|
| `42P01` | undefined_table | 表不存在 |
| `42703` | undefined_column | 列不存在 |
| `23505` | unique_violation | 唯一约束冲突（DUP_ENTRY） |
| `23502` | not_null_violation | NOT NULL 违反 |
| `23503` | foreign_key_violation | 外键违反 |
| `22007` | invalid_datetime_format | 非法日期 |
| `42601` | syntax_error | SQL 语法错误 |
| `23000` | integrity_constraint_violation | 约束违反（兜底） |
| `3D000` | invalid_catalog_name | 数据库不存在 |
| `00000` | successful_completion | 成功 |

映射逻辑位于 `lib/pg_server.js` 的 SQLSTATE 映射函数（按错误消息 + 错误码双重判定）。
未匹配的错误回落 `XX000`（internal_error）或 `42601`。

### PostgreSQL 常见问题

**Q: psql 连接时报 `no pg_hba.conf entry`？**
A: 服务器实现了内置 ACL 而非读取 pg_hba.conf。请检查 `auth` 选项中的用户是否匹配，或使用 `noAuth: true`。

**Q: 支持复制协议 / 流式订阅吗？**
A: 不支持 `pg_logical_slot`、`START_REPLICATION` 等复制协议，相关命令会返回明确错误。读写、事务、
预处理语句等常规操作全部可用。

**Q: `SELECT pg_backend_pid()` 等系统函数可用吗？**
A: 常用系统函数（`pg_backend_pid()`、`current_database()`、`now()`、`version()`）已兼容，
返回合理的伪值（如 `pg_backend_pid()` 返回 1）。

**Q: 为什么 `\dt` 在 psql 里看不到表？**
A: 使用 `\dt schema.table` 格式或查询 `information_schema.tables`。psql 的 `\dt` 依赖
`pg_class` 元表查询，请在 CLI 中直接用 SQL：`SELECT * FROM information_schema.tables;`

## Speak MongoDB — MongoDB Wire 协议兼容

### 支持的客户端 Supported clients

| 客户端 | 类型 | 兼容情况 |
|---|---|---|
| `mongodb` (官方 Node 驱动) | Node.js 驱动 | ✅ 完整（v4/v5/v6） |
| `mongosh` | 官方 Shell | ✅ 完整 |
| MongoDB Compass | GUI | ✅ 连接/浏览 |
| `mongoose` | ODM | ✅（基础 CRUD + 部分聚合） |
| `mongo-client` / `mongodb-client` | 第三方 CLI | ✅ |

```js
// 官方 mongodb 驱动
const { MongoClient } = require('mongodb');
const client = new MongoClient('mongodb://127.0.0.1:5432/app');
await client.connect();
const users = client.db('app').collection('users');
await users.insertOne({ name: 'Alice', age: 30 });
const alice = await users.findOne({ name: 'Alice' });
const all = await users.find({ age: { $gte: 18 } }).sort({ age: -1 }).toArray();
await client.close();
```

### Wire 协议实现（OP_QUERY / OP_MSG / OP_COMPRESSED）

按 MongoDB 官方 Wire Protocol 文档实现（消息头 + opCode + payload）：

| opCode | 名称 | 说明 |
|---|---|---|
| `2004` | OP_QUERY | 传统查询（legacy），含 `$query` 命令形态，`numberToSkip/numberToReturn` |
| `2005` | OP_REPLY | 服务器应答 OP_QUERY，含 `responseTo`、flags、cursorID |
| `2012` | OP_COMPRESSED | 压缩包（支持 snappy/zlib），解压后按内部 opCode 处理 |
| `2013` | OP_MSG | 现代消息格式，`OP_MSG_FLAGS`、`section kind 0/1`、`checksum` |

握手兼容要点：

- 驱动发送 `hello`（或 `ismaster` / `isMaster`），服务器响应 `helloOk: true`、`maxWireVersion`、`minWireVersion`、`maxBsonObjectSize`
- `OP_QUERY` 应答使用 int64 编码的 cursor id：`{ $long: 0 }`（BSON 特殊编码，兼容驱动解码）
- `OP_MSG` 应答支持 `moreToCome: false`（标准请求-响应）
- `OP_COMPRESSED`：按 `compressorId` 解压（`0`=snappy、`1`=zlib），加密 zstd 未启用

协议处理位于 `lib/mongo_server.js`（编解码）与 `lib/multiserver.js`（嗅探路由）。
`bin/jsail`（CLI）与 WASM 客户端复用同一套解析器。

### BSON 支持范围

| BSON 类型 | type code | 说明 |
|---|---|---|
| Double | `0x01` | 浮点 |
| String | `0x02` | UTF-8 字符串 |
| Document | `0x03` | 嵌套文档 |
| Array | `0x04` | 数组 |
| Binary | `0x05` | 二进制（generic/function/bytes 子类型） |
| ObjectId | `0x07` | 12 字节 ObjectId（自动生成/解码） |
| Boolean | `0x08` | 布尔 |
| Date (UTC) | `0x09` | int64 毫秒时间戳 |
| Null | `0x0A` | null |
| RegExp | `0x0B` | 正则（pattern + flags） |
| Int32 | `0x10` | 32 位整数 |
| Int64 | `0x12` | 64 位整数（`$long` / `$numberLong`） |
| Decimal128 | `0x13` | 十进制（数值安全转换） |
| Timestamp | `0x11` | 时间戳（解析保留） |

编码器支持 `$oid`（ObjectId）、`$numberLong`/`$long`（Int64）、`$numberDecimal`、`$date`、`$regex`、
`$binary`、`$timestamp` 等扩展 JSON 形式；**任意嵌套深度**的文档与数组均可往返。

### 数据库与集合映射

- URL：`mongodb://host:port/<database>`
- 每个 Mongo database 对应一个 JSQL engine 实例（同 MySQL 的 schema）
- **集合即表**：`db.users` ↔ `CREATE TABLE users` 的同一份数据
- 集合的文档是宽松 schema：未定义列时引擎按首条文档动态建表（`$insert` 自动 `_ensureTable`）
- 显式建表时，字段类型宽松存储（BSON 类型 ↔ SQL 类型自动转换：`double→REAL`、`string→TEXT`、`int→INTEGER` 等）

```js
// 动态 schema 示例：无需建表，直接插入
const coll = client.db('app').collection('events');
await coll.insertOne({ type: 'click', ts: Date.now(), meta: { x: 1, y: 2 } });
// → 自动创建 events 表（type/ts/meta 三列）
```

### 命令参考 Command reference

| 命令 | 说明 | 参数示例 |
|---|---|---|
| `hello` / `ismaster` / `isMaster` | 握手 | — |
| `ping` | 存活检测 | — |
| `insert` | 插入（单/多） | `{ documents: [...] }` |
| `find` | 查询 | `{ filter, sort, limit, skip, projection }` |
| `findOne` | 查询单条 | `{ filter, sort, projection }` |
| `count` | 计数 | `{ filter }` |
| `countDocuments` | 计数（聚合实现） | `{ filter }` |
| `update` | 更新 | `{ updates: [{ q, u, upsert, multi }] }` |
| `delete` | 删除 | `{ deletes: [{ q, limit }] }` |
| `findAndModify` | 原子修改 | `{ query, update, remove, new, upsert, sort, fields }` |
| `findOneAndUpdate` | 更新并返回 | `{ query, update, upsert, returnDocument }` |
| `findOneAndDelete` | 删除并返回 | `{ query, sort }` |
| `findOneAndReplace` | 替换并返回 | `{ query, replacement, upsert }` |
| `distinct` | 去重取值 | `{ key, query }` |
| `aggregate` | 聚合管道 | `{ pipeline: [...] }` |
| `create` / `createCollection` | 显式建集合 | `{ name }` |
| `drop` / `dropCollection` | 删除集合 | — |
| `dropDatabase` | 删除整个库 | — |
| `getLastError` | 兼容占位 | — |
| `listCollections` | 集合列表 | — |
| `listDatabases` | 数据库列表 | — |
| `serverStatus` / `buildInfo` / `getCmdLineOpts` | 元数据 | — |
| `logout` / `endSessions` | 会话清理 | — |
| `$cmd` (OP_QUERY) | 命令包装 | — |

```js
// findAndModify 全参数示例
const r = await coll.findOneAndUpdate(
  { name: 'Alice' },
  { $set: { age: 31 } },
  { upsert: true, returnDocument: 'after' }
);
```

### 查询操作符 Query operators

| 操作符 | 说明 | 示例 |
|---|---|---|
| `$eq` | 等于（默认） | `{ age: { $eq: 30 } }` |
| `$ne` | 不等于 | `{ age: { $ne: 30 } }` |
| `$gt` / `$gte` | 大于（等于） | `{ age: { $gte: 18 } }` |
| `$lt` / `$lte` | 小于（等于） | `{ age: { $lt: 65 } }` |
| `$in` | 在列表中 | `{ status: { $in: ['a','b'] } }` |
| `$nin` | 不在列表中 | `{ status: { $nin: ['x'] } }` |
| `$exists` | 字段存在性 | `{ email: { $exists: true } }` |
| `$regex` | 正则匹配 | `{ name: { $regex: '^A', $options: 'i' } }` |
| `$options` | 正则选项 | 配合 `$regex`（`i`/`m`/`s`） |
| `$and` | 逻辑与（数组） | `{ $and: [{a:1},{b:2}] }` |
| `$or` | 逻辑或（数组） | `{ $or: [{a:1},{b:2}] }` |
| `$nor` | 逻辑非或（数组） | `{ $nor: [{a:1},{b:2}] }` |
| `$not` | 逻辑非 | `{ age: { $not: { $gt: 60 } } }` |
| `$type` | 类型匹配 | `{ age: { $type: 'int' } }`（支持别名与类型号） |
| `$size` | 数组长度 | `{ tags: { $size: 2 } }` |
| `$elemMatch` | 数组元素匹配 | `{ scores: { $elemMatch: { $gte: 90 } } }` |
| `$all` | 数组包含全部 | `{ tags: { $all: ['a','b'] } }` |
| `$mod` | 取模 | `{ age: { $mod: [2, 0] } }` |

更新操作符（配合 update / findOneAndUpdate）：

| 操作符 | 说明 |
|---|---|
| `$set` | 设置字段 |
| `$unset` | 删除字段 |
| `$inc` | 数值自增 |
| `$push` | 数组追加 |
| `$addToSet` | 数组去重追加 |
| `$pull` | 数组移除匹配元素 |
| `$rename` | 字段重命名 |
| `$mul` | 数值乘法 |

```js
// 复杂查询示例
await coll.find({
  $and: [
    { age: { $gte: 18, $lte: 35 } },
    { $or: [{ plan: 'pro' }, { plan: 'plus' }] },
    { tags: { $size: 2 } },
    { bio: { $regex: '^developer', $options: 'i' } },
  ]
}).sort({ age: -1 }).limit(10).toArray();
```

### 聚合管道 Aggregation pipeline

| 阶段 | 说明 | 示例 |
|---|---|---|
| `$match` | 过滤文档 | `{ $match: { status: 'active' } }` |
| `$count` | 计数 | `{ $count: 'total' }` |
| `$limit` | 限制条数 | `{ $limit: 100 }` |
| `$skip` | 跳过条数 | `{ $skip: 10 }` |
| `$sort` | 排序（`1`/`-1`，支持多字段） | `{ $sort: { age: -1, name: 1 } }` |
| `$project` | 投影/派生字段 | `{ $project: { name: 1, year: { $year: '$ts' } } }` |
| `$unwind` | 数组展开 | `{ $unwind: '$tags' }`（支持 `preserveNullAndEmptyArrays`） |
| `$group` | 分组聚合 | `{ $group: { _id: '$dept', total: { $sum: '$salary' } } }` |
| `$lookup` | 关联（基础） | 左外连接查询另一集合 |
| `$addFields` | 新增字段（等同 $project） | `{ $addFields: { n: { $add: ['$a', 1] } } }` |

聚合表达式（`$project` / `$group` 内）：

| 表达式 | 说明 |
|---|---|
| `$year` / `$month` / `$dayOfMonth` / `$hour` / `$minute` / `$second` | 日期提取 |
| `$sum` / `$avg` / `$min` / `$max` | 聚合（`$group`） |
| `$first` / `$last` | 组内首/末 |
| `$add` / `$subtract` / `$multiply` / `$divide` / `$mod` | 算术 |
| `$concat` | 字符串拼接 |
| `$toUpper` / `$toLower` | 大小写 |
| `$substr` / `$substrCP` | 子串 |
| `$size` | 数组长度 |
| `$arrayElemAt` | 数组下标访问 |
| `$literal` | 字面量 |

```js
// 经典分组统计
const res = await db.collection('orders').aggregate([
  { $match: { status: 'paid' } },
  { $group: { _id: '$customer_id', total: { $sum: '$amount' }, count: { $sum: 1 } } },
  { $sort: { total: -1 } },
  { $limit: 5 },
]).toArray();

// $unwind + $project 组合
await db.collection('articles').aggregate([
  { $unwind: '$tags' },
  { $project: { title: 1, tag: '$tags' } },
]).toArray();
```

### MongoDB 常见问题

**Q: mongosh 连接报认证失败？**
A: mongosh 默认尝试 SCRAM-SHA-1/256 认证。请在连接串里省略密码（服务器 noAuth 模式）或
配置与服务器 `auth` 一致的用户名密码。测试环境推荐 `mongodb://host:port/db` 免密直连。

**Q: 支持 mongoose 吗？**
A: 支持基础 CRUD。部分 mongoose 自动功能（如 `_id` ObjectId 自动生成、虚拟字段、中间件）
需要模型定义配合；`save()`/`find()`/`updateOne()` 等核心 API 正常。

**Q: 为什么 `findOneAndUpdate` 需要 `returnDocument: 'after'` 才返回新文档？**
A: 与真实 MongoDB 一致：`returnDocument` 默认 `'before'`（返回修改前文档）。
服务器实现了 `'before'`/`'after'` 两种语义。

**Q: BSON 大对象/超大结果集有限制吗？**
A: 引擎按 `maxBsonObjectSize`（16MB 协议上限）分片应答；实际大小受内存限制，
建议生产数据分批查询。

**Q: 事务（多文档）支持吗？**
A: 单文档/单集合操作是原子的。多文档事务（`session.startTransaction()`）暂不支持，
会返回明确的"不支持事务"错误。

## Speak Redis — Redis 协议兼容

### 支持的客户端 Supported clients

| 客户端 | 类型 | 兼容情况 |
|---|---|---|
| `ioredis` (npm) | Node.js 驱动 | ✅ 完整 |
| `node-redis` (v4) | Node.js 驱动 | ✅ 完整 |
| `redis-cli` | 官方 CLI | ✅ 完整 |
| redis-benchmark | 基准工具 | ✅（受支持命令） |
| 各类 Redis GUI | 图形工具 | ✅（常用命令） |

```js
// ioredis 示例
const Redis = require('ioredis');
const redis = new Redis({ host: '127.0.0.1', port: 5432 });
await redis.set('k', 'v');
await redis.hset('h', 'field', 'value');
await redis.zadd('rank', 100, 'alice', 90, 'bob');
const top = await redis.zrevrange('rank', 0, 1, 'WITHSCORES');
await redis.quit();
```

### 数据类型 Data types

| 类型 | 底层表示 | 命令 |
|---|---|---|
| String | 内部字符串存储（RESP 传输） | `SET GET MSET MGET SETNX INCR DECR INCRBY DECRBY APPEND STRLEN` |
| Hash | 字段-值映射 | `HSET HGET HGETALL HKEYS HVALS HLEN HEXISTS HDEL` |
| List | 顺序数组（双端操作） | `LPUSH RPUSH LPOP RPOP LRANGE LLEN LREM LINDEX` |
| Set | 唯一元素集合 | `SADD SREM SMEMBERS SISMEMBER SCARD` |
| Sorted Set | 分数-成员有序集合 | `ZADD ZRANGE ZREVRANGE ZSCORE ZCARD ZREM ZINCRBY` |

所有类型共享同一 key 命名空间：`SET a 1` 之后再 `LPUSH a x` 会返回 `WRONGTYPE` 类型错误（与 Redis 一致）。

### 命令参考 Command reference

**通用命令**

| 命令 | 签名 | 说明 |
|---|---|---|
| `PING` | `PING [msg]` | 存活检测（可带消息） |
| `SELECT` | `SELECT idx` | 切换逻辑库（0-15，仅记录） |
| `AUTH` | `AUTH user pass` | 认证（单参数时 user=default） |
| `ECHO` | `ECHO msg` | 回显 |
| `QUIT` | `QUIT` | 优雅断开 |
| `INFO` | `INFO [section]` | 服务器信息（redis_version 等） |
| `KEYS` | `KEYS pattern` | 匹配 key（`*` `?` 通配） |
| `DBSIZE` | `DBSIZE` | key 数量 |
| `FLUSHDB` / `FLUSHALL` | — | 清空当前库 / 全部库 |
| `TYPE` | `TYPE key` | 类型探测（`string/hash/list/set/zset/none`） |
| `EXPIRE` / `TTL` / `PERSIST` | `EXPIRE key sec` | TTL 管理 |

**String**

| 命令 | 说明 |
|---|---|
| `SET key value [EX sec] [PX ms] [NX] [XX]` | 设置（支持 TTL 与条件） |
| `GET key` | 取值 |
| `MSET k1 v1 k2 v2 ...` | 批量设置（原子） |
| `MGET k1 k2 ...` | 批量取值（缺失 → nil） |
| `SETNX key value` | 不存在才设置 |
| `INCR key` / `INCRBY key n` | 自增（非整数 → 错误） |
| `DECR key` / `DECRBY key n` | 自减 |
| `APPEND key value` | 追加 |
| `STRLEN key` | 长度 |

**Hash**

| 命令 | 说明 |
|---|---|
| `HSET key f v [f v ...]` | 设置字段（可批量） |
| `HGET key f` | 读取字段 |
| `HGETALL key` | 全字段（RESP 扁平数组） |
| `HKEYS key` / `HVALS key` | 字段 / 值列表 |
| `HLEN key` | 字段数 |
| `HEXISTS key f` | 字段存在 |
| `HDEL key f [f ...]` | 删除字段 |

**List**

| 命令 | 说明 |
|---|---|
| `LPUSH key v [v ...]` / `RPUSH key v [v ...]` | 头/尾压入 |
| `LPOP key` / `RPOP key` | 头/尾弹出 |
| `LRANGE key start stop` | 范围读取（负索引） |
| `LLEN key` | 长度 |
| `LINDEX key idx` | 按下标读取 |
| `LREM key count v` | 移除（`count>0` 从头、`<0` 从尾、`0` 全部） |

**Set**

| 命令 | 说明 |
|---|---|
| `SADD key m [m ...]` | 添加成员 |
| `SREM key m [m ...]` | 移除成员 |
| `SMEMBERS key` | 全部成员 |
| `SISMEMBER key m` | 成员判定 |
| `SCARD key` | 成员数 |

**Sorted Set**

| 命令 | 说明 |
|---|---|
| `ZADD key score member [score member ...]` | 添加/更新成员分数 |
| `ZRANGE key start stop [WITHSCORES]` | 按分数升序取区间 |
| `ZREVRANGE key start stop [WITHSCORES]` | 按分数降序取区间 |
| `ZSCORE key member` | 查询成员分数 |
| `ZCARD key` | 成员数 |
| `ZREM key member [member ...]` | 移除成员 |
| `ZINCRBY key inc member` | 分数自增 |

```bash
redis-cli -p 5432 ZADD leaderboard 100 alice 90 bob 110 carol
redis-cli -p 5432 ZREVRANGE leaderboard 0 2 WITHSCORES
# 1) "carol"
# 2) "110"
# 3) "alice"
# 4) "100"
# 5) "bob"
# 6) "90"
```

### TTL 与持久化 TTL & persistence

- **TTL**：`SET ... EX/PX` 与 `EXPIRE` 均支持；到期自动删除；`TTL` 返回剩余秒数（`-1` 永久、`-2` 不存在）
- **持久化**：Redis 命名空间在服务器 `stop()` 时随引擎一起落盘（快照格式，见 [快照与压缩](#快照与压缩-snapshots--compression)）；重启后完整恢复
- **批量原子性**：`MSET`、`ZADD` 多参数等均为单事务提交

### Redis 常见问题

**Q: `redis-cli` 连接时报 `NOAUTH`？**
A: 服务器默认开启认证。开发环境用 `--no-auth` 或提供正确密码；生产环境务必配置强密码。

**Q: 支持 Redis Cluster / Sentinel 吗？**
A: 不支持集群协议（`CLUSTER`、`SENTINEL` 命令会返回未知命令错误）。单实例语义完全兼容。

**Q: pub/sub（`SUBSCRIBE`）支持吗？**
A: 不支持发布订阅。`SUBSCRIBE` 返回明确错误。普通命令、事务性批量命令全部可用。

**Q: `CONFIG GET` 等管理命令？**
A: 返回标准占位响应（如 `CONFIG GET *` 返回空数组），避免客户端工具报错。

## SQL 语言参考 SQL Reference

### 支持的语句 Statements

#### DDL 数据定义

| 语句 | 说明 |
|---|---|
| `CREATE TABLE` | 建表（含约束、索引、自增） |
| `CREATE TABLE IF NOT EXISTS` | 条件建表 |
| `CREATE TABLE AS SELECT` | 用查询结果建表 |
| `DROP TABLE` | 删表 |
| `DROP TABLE IF EXISTS` | 条件删表 |
| `TRUNCATE TABLE` | 清空表数据 |
| `ALTER TABLE ADD COLUMN` | 加列 |
| `ALTER TABLE DROP COLUMN` | 删列 |
| `ALTER TABLE RENAME TO` | 重命名表 |
| `ALTER TABLE RENAME COLUMN` | 重命名列 |
| `CREATE VIEW` / `CREATE VIEW IF NOT EXISTS` | 建视图 |
| `DROP VIEW` | 删视图 |
| `CREATE DATABASE` / `DROP DATABASE` | 建库/删库 |

```sql
-- 完整建表语法
CREATE TABLE IF NOT EXISTS orders (
  id           INTEGER PRIMARY KEY AUTO_INCREMENT,
  user_id      INT NOT NULL,
  status       VARCHAR(20) DEFAULT 'pending',
  amount       DECIMAL(10,2),
  note         TEXT,
  created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_user FOREIGN KEY (user_id) REFERENCES users(id),
  KEY idx_status (status),
  UNIQUE KEY uq_user_amount (user_id, amount)
);
```

#### DML 数据操作

| 语句 | 说明 |
|---|---|
| `SELECT` | 查询（JOIN / GROUP BY / ORDER BY / LIMIT / 子查询） |
| `INSERT INTO ... VALUES` | 插入（多行） |
| `INSERT INTO ... SELECT` | 插入查询结果 |
| `INSERT ... ON DUPLICATE KEY UPDATE` | 冲突更新（MySQL 语义） |
| `INSERT ... ON CONFLICT DO NOTHING / DO UPDATE` | 冲突处理（PG 语义） |
| `INSERT IGNORE` | 忽略冲突 |
| `REPLACE INTO` | 替换插入 |
| `UPDATE ... SET ... WHERE` | 更新 |
| `DELETE FROM ... WHERE` | 删除 |
| `UPSERT`（复合） | 见上两种冲突语义 |

```sql
-- 更新 + 返回
UPDATE orders SET status = 'paid', paid_at = NOW()
WHERE user_id = 7 AND status = 'pending'
RETURNING id, amount;

-- 删除
DELETE FROM orders WHERE status = 'cancelled' LIMIT 100;
```

#### 查询语法 SELECT

```sql
SELECT [DISTINCT] select_list
FROM table_reference
[JOIN table_reference ON condition]
[WHERE condition]
[GROUP BY column_list [WITH ROLLUP]]
[HAVING condition]
[ORDER BY column [ASC|DESC] [, ...]]
[LIMIT { count | offset, count | count OFFSET offset }]
[RETURNING ...]
```

**JOIN 类型**

| JOIN | 说明 | 示例 |
|---|---|---|
| `INNER JOIN` / `JOIN` | 内连接 | `FROM a JOIN b ON a.id = b.aid` |
| `LEFT JOIN` | 左外连接 | `FROM a LEFT JOIN b ON a.id = b.aid` |
| `RIGHT JOIN` | 右外连接 | `FROM a RIGHT JOIN b ON a.id = b.aid` |
| `FULL OUTER JOIN` | 全外连接 | `FROM a FULL OUTER JOIN b ON a.id = b.aid` |
| `CROSS JOIN` | 笛卡尔积 | `FROM a CROSS JOIN b` |
| 隐式连接 | 逗号 + WHERE | `FROM a, b WHERE a.id = b.aid` |
| 自连接 | 同表别名 | `FROM emp e1 JOIN emp e2 ON e1.mgr = e2.id` |
| 多表连接 | 2 张以上 | `FROM a JOIN b ON ... JOIN c ON ...` |

**子查询**

```sql
-- WHERE 子查询
SELECT * FROM orders
WHERE user_id IN (SELECT id FROM users WHERE vip = 1);

-- 标量子查询
SELECT name,
       (SELECT COUNT(*) FROM orders o WHERE o.user_id = u.id) AS order_count
FROM users u;

-- EXISTS
SELECT * FROM users u
WHERE EXISTS (SELECT 1 FROM orders o WHERE o.user_id = u.id);

-- FROM 子查询（派生表）
SELECT t.dept, COUNT(*) AS cnt
FROM (SELECT dept, salary FROM emp WHERE salary > 5000) t
GROUP BY t.dept;
```

**GROUP BY / HAVING**

```sql
SELECT dept, COUNT(*) AS cnt, AVG(salary) AS avg_sal
FROM emp
WHERE status = 'active'
GROUP BY dept
HAVING AVG(salary) > 6000
ORDER BY avg_sal DESC;
```

**DISTINCT / LIMIT**

```sql
SELECT DISTINCT status FROM orders;
SELECT * FROM orders LIMIT 20, 40;          -- MySQL 偏移语法
SELECT * FROM orders LIMIT 40 OFFSET 20;    -- 标准偏移语法
```

#### 事务语句

| 语句 | 说明 |
|---|---|
| `BEGIN` / `START TRANSACTION` | 开启事务 |
| `COMMIT` | 提交 |
| `ROLLBACK` | 回滚 |
| `SAVEPOINT sp` / `ROLLBACK TO SAVEPOINT sp` / `RELEASE SAVEPOINT sp` | 保存点 |
| 自动事务 | 无显式事务时单语句原子 |

事务保证：

- 读已提交（read committed）隔离级别的等价语义
- 事务内修改对事务外不可见（提交前），提交后原子可见
- 回滚撤销本事务全部修改（含保存点回滚）
- 支持跨表事务（引擎级提交日志）

```sql
BEGIN;
UPDATE accounts SET balance = balance - 100 WHERE id = 1;
UPDATE accounts SET balance = balance + 100 WHERE id = 2;
SAVEPOINT sp1;
UPDATE accounts SET balance = balance - 100 WHERE id = 3;
ROLLBACK TO SAVEPOINT sp1;      -- 撤销 id=3 的修改
COMMIT;
```

#### 其他语句

| 语句 | 说明 |
|---|---|
| `SHOW DATABASES / TABLES / COLUMNS / CREATE TABLE` | 元信息（MySQL 风格） |
| `DESCRIBE t` / `DESC t` | 表结构 |
| `USE db` | 切换数据库 |
| `EXPLAIN SELECT ...` | 执行计划（输出基本信息） |
| `SET SESSION x = y` / `SET x = y` | 会话变量 |
| `SELECT VERSION() / NOW() / ...` | 无表查询 |
| `PRAGMA` | SQLite 风格（兼容层） |

### 数据类型 Data types

| 类型 | 别名 | 说明 |
|---|---|---|
| `INTEGER` | `INT` `BIGINT` `SMALLINT` `TINYINT` | 整数（JS number 精度内） |
| `SERIAL` / `BIGSERIAL` | — | PG 自增整数 |
| `REAL` | `FLOAT` `DOUBLE` `DECIMAL(n,m)` `NUMERIC` | 浮点/定点 |
| `TEXT` | `VARCHAR(n)` `CHAR(n)` `STRING` | 字符串 |
| `BOOLEAN` | `BOOL` | 布尔 |
| `DATE` | — | 日期 |
| `DATETIME` | `TIMESTAMP` `TIMESTAMPTZ` | 时间戳 |
| `TIME` | — | 时间 |
| `BLOB` | `BYTEA` `BINARY` | 二进制（Buffer 保存） |
| `JSON` | — | JSON 文档 |
| `JSONB` | — | JSON 二进制（PG 语义） |
| `NULL` 类型 | — | 隐式 |
| `ANY` / 无类型 | — | 动态列（宽松 schema） |

**类型转换与比较规则**

- 数值与字符串比较：字符串自动转数值（`'5' = 5` → true）
- `NULL` 语义：`NULL = NULL` → NULL（需 `IS NULL` / `IS NOT NULL`）
- `IS TRUE / IS FALSE / IS NOT TRUE` 三值逻辑支持
- 显式转换：`CAST(x AS TYPE)`、`x::TYPE`（PG 风格）、`CONVERT(x, TYPE)`（MySQL 风格）
- 日期字符串自动识别：`'2024-01-15'`、`'2024-01-15 10:30:00'`、`'2024/01/15'`

### 标量函数 Scalar functions

完整函数清单（按类别）：

#### 字符串函数

| 函数 | 说明 | 示例 |
|---|---|---|
| `CONCAT(a, b, ...)` | 拼接（NULL 视为空串） | `CONCAT('a','-','b')` → `a-b` |
| `LOWER(s)` / `UPPER(s)` | 大小写 | `LOWER('ABC')` → `abc` |
| `LENGTH(s)` | 字符数 | `LENGTH('你好')` → 2 |
| `CHAR_LENGTH(s)` / `CHARACTER_LENGTH(s)` | 字符数 | 同 LENGTH |
| `OCTET_LENGTH(s)` | 字节数（UTF-8） | `OCTET_LENGTH('你好')` → 6 |
| `SUBSTRING(s, start[, len])` | 子串（1 起始） | `SUBSTRING('hello', 2, 3)` → `ell` |
| `SUBSTR(s, start[, len])` | 同 SUBSTRING | — |
| `LEFT(s, n)` / `RIGHT(s, n)` | 取左/右 n 字符 | `LEFT('hello', 2)` → `he` |
| `TRIM([chars] FROM s)` / `LTRIM` / `RTRIM` | 去空白 | `TRIM('  hi  ')` → `hi` |
| `REPLACE(s, from, to)` | 替换 | `REPLACE('a-b-c', '-', '+')` → `a+b+c` |
| `REVERSE(s)` | 反转 | `REVERSE('abc')` → `cba` |
| `REPEAT(s, n)` | 重复 | `REPEAT('ab', 3)` → `ababab` |
| `ASCII(s)` / `CHAR(n)` | 字符码互转 | `ASCII('A')` → 65 |
| `SPACE(n)` | 空格串 | `SPACE(3)` → `'   '` |
| `GROUP_CONCAT(x[, sep])` | 聚合拼接 | `GROUP_CONCAT(name, ',')` |
| `LIKE` 匹配 | 见 [LIKE / ILIKE / 正则](#like--ilike--正则) | — |

#### 数值函数

| 函数 | 说明 | 示例 |
|---|---|---|
| `ABS(x)` | 绝对值 | `ABS(-5)` → 5 |
| `ROUND(x[, n])` | 四舍五入 | `ROUND(3.14159, 2)` → 3.14 |
| `CEIL(x)` / `CEILING(x)` | 向上取整 | `CEIL(3.2)` → 4 |
| `FLOOR(x)` | 向下取整 | `FLOOR(3.8)` → 3 |
| `POWER(x, y)` / `POW(x, y)` | 幂 | `POWER(2, 10)` → 1024 |
| `SQRT(x)` | 平方根 | `SQRT(16)` → 4 |
| `EXP(x)` | 自然指数 | `EXP(1)` → 2.71828 |
| `LN(x)` / `LOG(x)` / `LOG10(x)` | 对数 | `LOG10(1000)` → 3 |
| `MOD(x, y)` | 取模 | `MOD(10, 3)` → 1 |
| `TRUNCATE(x, n)` | 截断 | `TRUNCATE(3.14159, 2)` → 3.14 |
| `RAND()` / `RANDOM()` | 随机数 [0,1) | `RAND()` |
| `SIGN(x)` | 符号 | `SIGN(-3)` → -1 |
| `GREATEST(a, b, ...)` | 最大值 | `GREATEST(1, 5, 3)` → 5 |
| `LEAST(a, b, ...)` | 最小值 | `LEAST(1, 5, 3)` → 1 |

#### 日期时间函数

| 函数 | 说明 | 示例 |
|---|---|---|
| `NOW()` / `CURRENT_TIMESTAMP` | 当前时间戳 | `NOW()` → `2026-08-12 10:00:00` |
| `CURRENT_DATE` | 当前日期 | `CURRENT_DATE` → `2026-08-12` |
| `CURRENT_TIME` | 当前时间 | `CURRENT_TIME` → `10:00:00` |
| `DATE(s)` | 取日期部分 | `DATE(NOW())` |
| `YEAR(d)` / `MONTH(d)` / `DAY(d)` | 年月日 | `YEAR('2026-08-12')` → 2026 |
| `HOUR(t)` / `MINUTE(t)` / `SECOND(t)` | 时分秒 | `HOUR(NOW())` |
| `DATE_ADD(d, INTERVAL n UNIT)` | 日期加法 | `DATE_ADD(NOW(), INTERVAL 1 DAY)` |
| `DATE_SUB(d, INTERVAL n UNIT)` | 日期减法 | `DATE_SUB(NOW(), INTERVAL 2 HOUR)` |
| `DATEDIFF(a, b)` | 相差天数 | `DATEDIFF('2026-08-12', '2026-08-01')` → 11 |
| `DATE_FORMAT(d, fmt)` | 格式化 | `DATE_FORMAT(NOW(), '%Y-%m-%d %H:%i')` |
| `STR_TO_DATE(s, fmt)` | 字符串解析 | `STR_TO_DATE('2026-08-12', '%Y-%m-%d')` |
| `EXTRACT(part FROM d)` | 提取部分 | `EXTRACT(YEAR FROM d)` |
| `AGE(d1, d2)` | 区间 | `AGE(NOW(), '2020-01-01')` |
| `TO_CHAR(d, fmt)` | PG 格式化 | `TO_CHAR(NOW(), 'YYYY-MM-DD')` |
| `UNIX_TIMESTAMP([d])` | 秒级时间戳 | `UNIX_TIMESTAMP()` |
| `FROM_UNIXTIME(n)` | 时间戳转日期 | `FROM_UNIXTIME(1700000000)` |

INTERVAL 单位：`DAY` `HOUR` `MINUTE` `SECOND` `WEEK` `MONTH` `YEAR` 及其组合。

#### 条件与空值函数

| 函数 | 说明 | 示例 |
|---|---|---|
| `IF(cond, a, b)` | 条件分支 | `IF(age >= 18, 'adult', 'minor')` |
| `IFNULL(a, b)` | 空值回退 | `IFNULL(nick, name)` |
| `NULLIF(a, b)` | 相等返回 NULL | `NULLIF(0, 0)` → NULL |
| `COALESCE(a, b, ...)` | 第一个非空 | `COALESCE(NULL, NULL, 3)` → 3 |
| `CASE WHEN ... THEN ... ELSE ... END` | 搜索式 | `CASE WHEN x > 0 THEN 'p' ELSE 'n' END` |
| `CASE expr WHEN v THEN ... END` | 简单式 | `CASE status WHEN 1 THEN 'on' END` |
| `ISNULL(x)` | 是否为 NULL | `ISNULL(col)` |

#### 系统与杂项函数

| 函数 | 说明 | 示例 |
|---|---|---|
| `VERSION()` | 服务器版本 | `8.0.0-jsql-neo` |
| `DATABASE()` | 当前库名 | `DATABASE()` |
| `USER()` / `CURRENT_USER` | 当前用户 | `USER()` → `root` |
| `LAST_INSERT_ID()` | 最近自增 ID | 配合 AUTO_INCREMENT 使用 |
| `ROW_COUNT()` | 受影响行数 | 配合 DML 使用 |
| `CAST(x AS type)` | 类型转换 | `CAST('42' AS INT)` |
| `CONVERT(x, type)` | MySQL 转换 | `CONVERT('42', SIGNED)` |
| `JSON_EXTRACT(doc, path)` | JSON 取值 | `JSON_EXTRACT(meta, '$.name')` |
| `JSON_OBJECT(...)` / `JSON_ARRAY(...)` | JSON 构造 | `JSON_OBJECT('k', 1)` |
| `JSON_UNQUOTE(x)` | 去引号 | — |
| `JSON_CONTAINS(doc, val[, path])` | 包含判定 | — |
| `JSON_SET / JSON_INSERT / JSON_REPLACE / JSON_REMOVE` | JSON 修改 | — |
| `UUID()` | UUID v4 | `UUID()` |
| `TYPEOF(x)` | 类型探测 | `TYPEOF(1)` → `number` |
| `IIF(cond, a, b)` | SQLite 风格分支 | 同 IF |
| `PRINT(x)` | 调试输出 | — |

### 聚合函数 Aggregate functions

| 函数 | 说明 | 示例 |
|---|---|---|
| `COUNT(*)` | 行数 | `SELECT COUNT(*) FROM t` |
| `COUNT(DISTINCT col)` | 去重计数 | `SELECT COUNT(DISTINCT dept) FROM emp` |
| `COUNT(col)` | 非空计数 | `COUNT(age)` |
| `SUM(col)` | 求和 | `SUM(amount)` |
| `SUM(DISTINCT col)` | 去重求和 | — |
| `AVG(col)` | 平均 | `AVG(salary)` |
| `MIN(col)` / `MAX(col)` | 极值 | `MIN(price)` |
| `GROUP_CONCAT(col[, sep])` | 拼接 | `GROUP_CONCAT(name, '|')` |
| `GROUP_CONCAT(DISTINCT col)` | 去重拼接 | — |
| `STDDEV(col)` / `STDDEV_POP` / `STDDEV_SAMP` | 标准差 | — |
| `VARIANCE(col)` / `VAR_POP` / `VAR_SAMP` | 方差 | — |
| `FIRST(col)` / `LAST(col)` | 首/末值 | — |

聚合与 `GROUP BY` 配合规则：

- 未 `GROUP BY` 时全表一个组（`COUNT(*)` 总行数）
- `HAVING` 在分组后过滤，可使用聚合别名
- `GROUP BY` 支持多列、表达式、`WITH ROLLUP`（总计行）
- `NULL` 不计入 `COUNT(col)` / `SUM(col)` / `AVG(col)`

### 运算符 Operators

#### 算术运算符

| 运算符 | 说明 | 示例 |
|---|---|---|
| `+` `-` `*` `/` | 四则 | `(a + b) * 2` |
| `%` / `MOD` | 取模 | `a % 3` |
| `DIV` | 整数除法（MySQL） | `7 DIV 2` → 3 |
| `^` | 幂（PG） | `2 ^ 10` → 1024 |

#### 比较运算符

| 运算符 | 说明 | 示例 |
|---|---|---|
| `=` `<>` `!=` | 等/不等 | `age = 30` |
| `<` `<=` `>` `>=` | 大小 | `age >= 18` |
| `IS NULL` / `IS NOT NULL` | 空值 | `col IS NULL` |
| `IS TRUE` / `IS FALSE` / `IS NOT TRUE` | 三值逻辑 | `flag IS TRUE` |
| `BETWEEN a AND b` | 区间（含端点） | `age BETWEEN 18 AND 65` |
| `IN (list)` / `NOT IN (list)` | 列表成员 | `status IN ('a','b')` |
| `LIKE` / `NOT LIKE` | 模式匹配 | `name LIKE 'A%'` |
| `ILIKE` / `NOT ILIKE` | 不区分大小写 | `name ILIKE '%alice%'` |
| `RLIKE` / `REGEXP` | 正则 | `name REGEXP '^A'` |
| `EXISTS` / `NOT EXISTS` | 子查询存在 | `EXISTS (SELECT 1 ...)` |
| `ANY` / `ALL` / `SOME` | 量词比较 | `x > ALL (SELECT ...)` |
| `<=>` | NULL 安全相等（MySQL） | `a <=> b` |

#### 逻辑运算符

| 运算符 | 说明 |
|---|---|
| `AND` | 逻辑与（短路） |
| `OR` | 逻辑或（短路） |
| `NOT` | 逻辑非 |
| `XOR` | 异或 |
| `&&` / `\|\|` | MySQL 别名（`\|\|` 在 sql_mode 兼容下是 OR） |

#### 位运算符

| 运算符 | 说明 | 示例 |
|---|---|---|
| `&` `\|` `^` `~` | 位与/或/异或/非 | `flags & 0x04` |
| `<<` `>>` | 左移/右移 | `1 << 8` → 256 |

#### JSON 运算符（PG 风格）

| 运算符 | 说明 | 示例 |
|---|---|---|
| `->` | 取 JSON 字段（返回 JSON） | `meta->'name'` |
| `->>` | 取 JSON 字段（返回文本） | `meta->>'name'` |
| `#>`, `#>>` | 路径访问 | `meta#>>'{a,b}'` |
| `@>` | 包含 | `meta @> '{"plan":"pro"}'` |
| `<@` | 被包含 | `'{"a":1}'::jsonb <@ meta` |
| `?` / `?|` / `?&` | 键存在 | `meta ? 'plan'` |

### LIKE / ILIKE / 正则

**LIKE 通配符**

| 通配符 | 含义 | 示例 |
|---|---|---|
| `%` | 任意长度（含 0） | `'A%'` 以 A 开头 |
| `_` | 单个字符 | `'A_B'` A 加任意 1 字符加 B |
| `\` 转义 | 匹配字面通配符 | `LIKE '100\%' ESCAPE '\\'` |

**ILIKE**：与 LIKE 相同语法，但大小写不敏感（PG 方言）。

**正则表达式**（`RLIKE` / `REGEXP` / `$regex`）：

- 基于 JS RegExp 引擎
- 支持 flags：`i`（忽略大小写）、`m`（多行）、`s`（点匹配换行）
- PG 风格的 `~` / `~*` / `!~` / `!~*` 运算符也支持：
  - `name ~ '^A'`（大小写敏感匹配）
  - `name ~* '^a'`（不敏感）
  - `name !~ '^X'`（不匹配）

```sql
SELECT * FROM users
WHERE email ~* '^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$';
```

### 事务 Transactions

事务通过引擎日志（`transactionLog` / `tlog`）实现，提供：

- **原子性**：事务内全部操作要么全部提交、要么全部回滚
- **一致性**：约束（PK/UNIQUE/NOT NULL/FK/CHECK）在事务边界校验
- **隔离性**：提交前对其他连接不可见
- **持久性**：磁盘模式事务提交时同步写日志（详见 [WAL 与崩溃恢复](#wal-与崩溃恢复-wal--crash-recovery)）

```js
// 程序化事务（Database API）
const txn = db.beginTransaction();
try {
  db.insert('accounts', { id: 1, balance: 100 });
  db.update('accounts', { id: 1 }, { balance: 50 });
  db.commit();
} catch (e) {
  txn.rollback();
}
```

### 索引与约束 Indexes & constraints

#### 索引

| 索引类型 | 创建方式 | 说明 |
|---|---|---|
| 主键索引 | `PRIMARY KEY` | 唯一 + 非空，自动建树 |
| 唯一索引 | `UNIQUE KEY name (cols)` | 唯一约束 + 加速 |
| 普通索引 | `KEY name (cols)` / `CREATE INDEX` | B-Tree 加速 |
| 复合索引 | `KEY (a, b)` | 多列组合 |
| 多索引 | 一表多索引 | 每索引一棵 B-Tree |

```sql
CREATE INDEX idx_orders_status ON orders (status);
CREATE UNIQUE INDEX uq_email ON users (email);
DROP INDEX idx_orders_status ON orders;   -- MySQL 风格
```

#### 约束

| 约束 | 说明 |
|---|---|
| `PRIMARY KEY` | 主键（隐式唯一索引） |
| `NOT NULL` | 非空 |
| `UNIQUE` | 唯一 |
| `DEFAULT value` | 默认值（含 `CURRENT_TIMESTAMP`） |
| `CHECK (expr)` | 检查约束（插入/更新时校验） |
| `FOREIGN KEY (col) REFERENCES t(col)` | 外键（支持 `ON DELETE CASCADE`） |
| `AUTO_INCREMENT` / `SERIAL` | 自增 |
| 命名约束 | `CONSTRAINT name ...` |

约束违反错误码（MySQL 风格）：`ER_DUP_ENTRY`、`ER_NO_DEFAULT_FOR_FIELD`、`ER_BAD_NULL_ERROR`、
`ER_CHECK_CONSTRAINT`、`ER_NO_REFERENCED_ROW`、`ER_ROW_IS_REFERENCED`。

### 视图 Views

```sql
CREATE VIEW active_users AS
SELECT id, name FROM users WHERE status = 'active' AND deleted_at IS NULL;

-- 使用视图
SELECT * FROM active_users WHERE age > 30;

-- 视图元信息
SHOW TABLES;            -- 视图与表并列显示
DESCRIBE active_users;  -- 展示视图列

DROP VIEW IF EXISTS active_users;
```

视图特性：

- 存储查询定义，查询时实时展开（非物化）
- 视图可参与 JOIN、子查询、聚合
- 视图上的 DML（INSERT/UPDATE）暂不支持（返回明确错误）
- `CREATE OR REPLACE VIEW` 支持

### JSON / JSONB 支持

JSON 列可用于：

```sql
CREATE TABLE users (
  id INT PRIMARY KEY,
  meta JSON,            -- 任意 JSON 文档
  prefs JSONB DEFAULT '{"theme":"dark"}'::jsonb
);

-- 插入 JSON
INSERT INTO users (id, meta) VALUES
  (1, '{"name":"Alice","tags":["admin","ops"],"addr":{"city":"SH"}}');

-- 查询路径
SELECT meta->>'name' AS name,
       meta->'addr'->>'city' AS city
FROM users WHERE meta @> '{"tags":["admin"]}';
```

JSON 函数见 [系统与杂项函数](#系统与杂项函数)。Mongo 客户端视角下，JSON 列与 BSON 文档完全互通。

### 参数化查询 Prepared statements

三个协议 + 嵌入式 API 均支持参数化查询（杜绝 SQL 注入的首选方式）：

```js
// 嵌入式：? 占位符
await executeSQL(db, 'SELECT * FROM users WHERE age > ? AND city = ?', [25, 'SH']);

// MySQL 协议：? 占位符
await conn.execute('INSERT INTO users (name, age) VALUES (?, ?)', ['Alice', 30]);

// PG 协议：$1 占位符（扩展协议）
await client.query('SELECT * FROM users WHERE age > $1', [25]);

// MongoDB 协议：参数化天然（BSON 文档，无字符串拼接）
await coll.find({ age: { $gt: 25 } }).toArray();
```

参数绑定规则：

- 位置参数按序绑定，`?` 与 `$n` 不可混用
- 值自动按目标列类型转换（字符串/数值/日期/JSON/Buffer）
- 数组参数展开为 IN 列表（mysql2 风格 `IN (?)`）
- 重复 `?` 可用 `??`（标识符）——用于动态表名/列名，且不会注入

### 多语句与批处理 Multi-statement

```js
// executeSQL 一次执行多条语句
const result = await executeSQL(db, `
  CREATE TABLE t (id INT PRIMARY KEY);
  INSERT INTO t VALUES (1), (2);
  UPDATE t SET id = id + 10;
  SELECT * FROM t;
`);

// 显式拆分
const { splitStatements } = require('jsql-neo');
const stmts = splitStatements('SELECT 1; SELECT 2; -- comment\nSELECT 3;');
// → ['SELECT 1', 'SELECT 2', 'SELECT 3']
```

- `splitStatements` 正确跳过字符串/注释中的分号
- 单语句失败时返回该语句的错误（此前语句已生效）
- 服务器连接默认支持多语句（`multipleStatements: true` 语义）

### 安全策略 Safety policy

JSQL-NEO 内置多层安全策略（详见 [安全性 Security](#安全性-security)）：

| 拦截项 | 示例 | 行为 |
|---|---|---|
| 文件写入语句 | `SELECT ... INTO OUTFILE` | 报错并拒绝 |
| `LOAD_FILE()` | 读取服务器文件 | 报错并拒绝 |
| 禁用函数 | `SLEEP(10)`（DoS） | 报错并拒绝 |
| 内联注释后门 | `/*!50000 ... */` 版本化注释 | 按普通注释处理 |
| 多语句注入 | `; DROP TABLE x;` | 由多语句解析器显式处理（非拼接注入） |
| 危险 DDL | `DROP DATABASE production` | 认证后仍可执行（有认证的部署自行评估） |

SQL 解析器内置（非正则），对输入做完整词法分析，从根本上消除注释逃逸/编码绕过类注入。

## Node.js API 参考 Node API Reference

### Database 类

```js
const { Database } = require('jsql-neo');
```

#### 构造选项

```js
const db = new Database(dataDirOrName, options);
```

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `dataDirOrName` | string | — | `':memory:'` 纯内存；`'./data/db'` 磁盘模式；也可传数据库名 |
| `options.autoSave` | boolean | `true` | 写操作后自动保存 |
| `options.saveInterval` | number | `3000` | 自动保存间隔（ms） |
| `options.compression` | boolean/string | 取决构建 | 快照压缩（`'lz4'`/`'zstd'`/`'none'`） |
| `options.defaultEngine` | string | 自动选择 | `'native'` / `'wasm'` / `'js'` |
| `options.logLevel` | string | `'info'` | 日志级别 |

#### 生命周期

```js
db.init();            // 显式初始化（含加载历史快照）
db.stop();            // 停止：落盘 + 关闭（幂等，可多次调用）
db.reset();           // 重置内存状态（保留配置）
db.getEngineType();   // → 'native' | 'wasm' | 'js'
db.getDataDir();      // → 数据目录（内存模式为 null）
db.saveTo(file);      // 立即导出快照到指定文件
db.loadFrom(file);    // 从快照文件加载
```

#### 表管理

```js
db.createTable(name, schema, options);
db.dropTable(name);
db.truncateTable(name);
db.listTables();                 // → ['users', 'orders', ...]
db.getTableSchema(name);         // → { columns, indexes, constraints }
db.getTableSchema(name).columns; // → [{ name, type, ... }]
db.tableExists(name);            // → boolean
```

`schema` 定义示例：

```js
db.createTable('users', {
  id:   { type: 'INT', primaryKey: true, autoIncrement: true },
  name: { type: 'VARCHAR', length: 100, notNull: true },
  age:  { type: 'INT', default: 0 },
  meta: { type: 'JSON' },
  created_at: { type: 'DATETIME', default: 'CURRENT_TIMESTAMP' },
}, { ifNotExists: true });
```

#### 数据访问方法 Data access methods

**插入**

```js
db.insert('users', row);                 // 单行对象 → 返回 { id, ... } 完整行
db.insertMany('users', [row1, row2]);    // 批量（事务内）
db.insertMany('users', rows, { upsert: true });  // 冲突时更新
```

**查询**

```js
db.find('users', filter, options);
// filter: { age: { $gt: 18 }, city: 'SH' }   — 支持全部 Mongo 操作符
// options: { sort: { age: -1 }, limit: 10, skip: 5, fields: ['id', 'name'] }
db.findOne('users', filter);             // 首条匹配（可为 null）
db.count('users', filter);               // 匹配条数
db.distinct('users', 'city', filter);    // 去重取值
```

**更新 / 删除**

```js
db.update('users', filter, changes);             // 返回更新行数
db.updateOne('users', filter, changes);
db.updateMany('users', filter, changes);
db.removeWhere('users', filter);                 // 条件删除，返回删除行数
db.removeByIds('users', [1, 2, 3]);              // 按主键删除
db.removeById('users', 1);
db.getById('users', 1);                          // 按主键读取
```

**文档式操作符**：`$set` `$inc` `$unset` `$push` `$pull` `$addToSet` `$rename` `$mul` 均支持。

#### 链式 Query（QL 风格）

```js
db.query('users')
  .where({ age: { $gte: 18 } })   // 过滤器（Mongo 操作符）
  .select(['id', 'name'])         // 投影
  .sort({ age: -1 })              // 排序
  .skip(10)
  .limit(10)
  .exec();                        // → 行数组
```

#### 索引管理（API）

```js
db.createIndex('users', ['status']);          // 普通索引
db.createIndex('users', ['email'], { unique: true });
db.dropIndex('users', 'idx_email');
db.listIndexes('users');
```

#### 存储与文件

```js
db.getStorageType();        // → 'memory' | 'disk' | 'hybrid'
db.flush();                 // 手动同步落盘
db.getStats();              // → { tables, rows, keys, sizeBytes, ... }
db.backupTo(dir);           // 备份到目录
db.restoreFrom(dir);        // 从备份恢复
```

### executeSQL

```js
const { executeSQL } = require('jsql-neo');
const result = await executeSQL(db, sql, params);
```

#### 返回结构

```js
{
  columns: ['id', 'name', 'age'],   // SELECT 的列名
  columnTypes: ['INTEGER','VARCHAR','INTEGER'], // 列类型
  rows: [[1, 'Alice', 30], ...],    // 行数据（二维数组）
  rowCount: 2,                      // 行数
  affectedRows: 0,                  // DML 影响行数
  insertId: 1,                      // 自增 ID（INSERT 时）
  message: '2 rows selected',       // 人读消息
  command: 'SELECT',                // 语句类型
  durationMs: 0.42,                 // 执行耗时
  warnings: [],                     // 警告（如截断）
}
```

#### 返回值矩阵

| 语句 | `rows` | `affectedRows` | `insertId` | `message` |
|---|---|---|---|---|
| SELECT | 数据行 | — | — | `n rows selected` |
| INSERT | — | 插入数 | 最后自增 ID | `1 row inserted` |
| UPDATE | — | 更新数 | — | `n rows updated` |
| DELETE | — | 删除数 | — | `n rows deleted` |
| CREATE TABLE | — | — | — | `table created` |
| DROP TABLE | — | — | — | `table dropped` |
| BEGIN/COMMIT | — | — | — | `transaction started/committed` |
| SHOW | 元数据行 | — | — | — |

#### 高级用法

```js
// 参数化
await executeSQL(db, 'INSERT INTO users (name, age) VALUES (?, ?)', ['Bob', 25]);

// 多语句
const r = await executeSQL(db, 'SELECT 1; SELECT 2;');

// 命名参数（对象）
await executeSQL(db, 'SELECT * FROM users WHERE name = :name', { name: 'Alice' });

// 批量
const { splitStatements } = require('jsql-neo');
for (const stmt of splitStatements(dump)) await executeSQL(db, stmt);

// 获取每条的返回值
const { SQLExecutor } = require('jsql-neo');
const ex = new SQLExecutor(db);
ex.feed('CREATE TABLE t (id INT); INSERT INTO t VALUES (1);');
const results = await ex.run();   // → [r1, r2]
```

### 事件与 Hook

```js
db.on('save', (info) => {});             // 快照保存完成 { file, size }
db.on('load', (info) => {});             // 快照加载完成 { file, tables }
db.on('insert', ({ table, rows }) => {});// 插入事件（批量合并）
db.on('update', ({ table, ids }) => {}); // 更新事件
db.on('delete', ({ table, ids }) => {}); // 删除事件
db.on('error', (err) => {});             // 异步错误
db.on('stop', () => {});                 // 停止完成
```

内置事件发射器基于 Node `EventEmitter`，WASM 环境提供兼容的轻量实现。

### 创建服务器 createXxxServer

四个协议服务器共享一致的创建模式：

```js
const {
  createMysqlServer,
  createPgServer,
  createRedisServer,
  createMongoServer,
  createMultiServer,
} = require('jsql-neo');
```

#### createMysqlServer

```js
const srv = createMysqlServer({
  port: 3306,                 // 监听端口（省略则随机，用 srv.address() 获取）
  host: '0.0.0.0',            // 默认 127.0.0.1
  dataDir: './data',          // 省略 → 内存模式
  auth: {                     // 省略 + noAuth:false → 空密码也可连（开发默认）
    root: { password: '123456', databases: ['*'] },
  },
  noAuth: false,              // true 跳过认证
  pool: { max: 100 },         // 连接池选项（可选）
});
srv.listen(() => console.log('mysql on', srv.address().port));
srv.close();
```

#### createPgServer

```js
createPgServer({
  port: 5432,
  dataDir: './data',
  auth: { root: { password: 'pgpass', databases: ['*'] } },
  noAuth: false,
}).listen();
```

#### createRedisServer

```js
createRedisServer({
  port: 6379,
  dataDir: './data',      // 省略 → 纯内存（不持久化）
  auth: 'redispass',      // 字符串或 { user: pass } 映射
  noAuth: true,
  snapshotInterval: 5000, // 快照间隔（ms）
}).listen();
```

#### createMongoServer

```js
createMongoServer({
  port: 27017,
  dataDir: './data',
  auth: { root: { password: 'mongopass', databases: ['*'] } },
  noAuth: true,
}).listen();
```

### 多协议服务器 API

```js
const srv = createMultiServer({
  port: 5432,
  dataDir: './data',
  noAuth: true,
});

srv.listen();
srv.address();            // { address, port }
srv.close();              // 优雅关闭全部

// 事件
srv.on('connection', (socket, protocol) => {});  // protocol: 'mysql'|'pg'|'redis'|'mongo'|'unknown'
srv.on('error', (err) => {});
```

#### 程序化客户端（无网络）

```js
// 用 createMultiServer 之后，也可以直接用内存 Database
const db = new Database(':memory:');
await executeSQL(db, 'CREATE TABLE kv (k TEXT PRIMARY KEY, v TEXT)');
db.insert('kv', { k: 'a', v: '1' });
db.find('kv', {});   // 无需监听任何端口
```

### 辅助工具函数

```js
const {
  tokenize,            // SQL 词法分析
  parseSQL,            // 语法解析（AST）
  splitStatements,     // 语句切分
  applyParams,         // 参数绑定 → 完整 SQL
  escapeValue,         // 值转义
  escapeId,            // 标识符转义
  createTUI,           // TUI 工厂
  TUIShell,            // TUI Shell 类
  renderTable,         // ASCII 表格渲染
  wswidth,             // CJK 感知宽度
  pad,                 // 填充对齐
} = require('jsql-neo');
```

```js
// 语法解析示例
const ast = parseSQL('SELECT a, b FROM t WHERE x > 5');
// → { type: 'select', columns: [...], from: 't', where: { ... } }

// 值转义示例
escapeValue("it's");   // → 'it\\'s'
escapeId('order');     // → `order`
```

## CLI 命令行工具 Command Line

`jsql` 是随包发布的命令行入口（`bin/jsql`）。全局安装后可全局使用：

```bash
npm install -g jsql-neo
jsql version
```

命令一览：

```bash
jsql serve       # MySQL 单协议服务器
jsql serve --pg  # 多协议服务器（MySQL+PG+Redis+Mongo 同一端口）
jsql redis       # Redis 独立服务器
jsql ui          # 启动 Web 管理台 + API
jsql tui         # 交互式 SQL 终端（零依赖 TUI）
jsql export      # 数据导出（JSON/CSV）
jsql import      # 数据导入（SQL dump / JSON / CSV）
jsql bench       # 基准测试
jsql mod         # 模块管理（native/wasm/纯 JS）
jsql version     # 版本信息
jsql --help      # 帮助
```

### jsql serve

```bash
# 默认 MySQL 协议，端口 3306
jsql serve

# 指定端口 / 数据目录 / 地址
jsql serve -p 3307 --data-dir ./data --host 0.0.0.0

# 免认证（开发）
jsql serve --no-auth

# 内存模式（不落盘）
jsql serve -p 3307 --memory

# 指定用户
jsql serve --user admin --password secret

# 静默日志 / 详细日志
jsql serve -q
jsql serve --verbose
```

完整选项：

```
Options:
  -p, --port <n>          端口（默认 3306）
      --host <host>       监听地址（默认 127.0.0.1）
      --data-dir <dir>    数据目录（省略 → 内存模式）
      --memory            纯内存（等价不传 data-dir）
      --user <user>       用户名（默认 root）
      --password <pass>   密码（默认空）
      --no-auth           跳过认证
      --tls               启用 TLS（需证书）
      --cert <file>       TLS 证书
      --key <file>        TLS 私钥
  -q, --quiet             静默模式
      --verbose           详细日志
      --save-interval <ms> 自动保存间隔
```

### jsql serve --pg（多协议）

```bash
# 一个端口四协议
jsql serve --pg -p 5432 --data-dir ./data --no-auth

# 指定数据目录与认证
jsql serve --pg -p 5432 --data-dir ./data --user admin --password s3cret

# 内存模式（重启即失）
jsql serve --pg -p 5432 --memory
```

- 客户端示例：`mysql2`（端口 5432）、`psql -p 5432`、`mongosh mongodb://127.0.0.1:5432`、`redis-cli -p 5432`
- 连接日志显示识别出的协议：`[info] connection from 127.0.0.1:54321 → mysql`

### jsql redis

```bash
# Redis 独立服务器
jsql redis -p 6379 --data-dir ./data --no-auth

# 带密码
jsql redis -p 6379 --data-dir ./data --password r3dispass

# 内存 Redis（默认）
jsql redis -p 6379
```

与 `serve --pg` 的 Redis 支持区别：`jsql redis` 只开 Redis 协议（端口独立、握手即时），
适合纯缓存场景；`serve --pg` 适合多协议混用。

### jsql ui（Web 管理台）

```bash
# 启动 Web UI + HTTP API（默认 8080）
jsql ui --data-dir ./data

# 指定端口
jsql ui -p 9090

# 指定数据库
jsql ui --data-dir ./data --db app
```

- 浏览器打开 `http://127.0.0.1:8080` 即可
- HTTP API 端点与 Web 管理台的详细说明见 [Web UI 与 HTTP API](#web-ui-与-http-api)

### jsql export / import（迁移工具）

```bash
# 导出整个数据库为 JSON（含 schema）
jsql export ./data --format json --output ./backup/app.json

# 导出单个表
jsql export ./data --table users --format json --output users.json

# 导出为 CSV
jsql export ./data --table users --format csv --output users.csv

# 导出为 SQL dump（可导入任意 SQL 引擎）
jsql export ./data --format sql --output dump.sql

# 导入（自动识别格式）
jsql import ./data dump.sql
jsql import ./data backup.json
jsql import ./data users.csv --table users
```

| 选项 | 说明 |
|---|---|
| `--format <fmt>` | `json` / `csv` / `sql` |
| `--table <t>` | 只导出指定表 |
| `--output <file>` | 输出文件（默认 stdout） |
| `--pretty` | JSON 美化输出 |
| `--no-create` | 导入时跳过建表语句 |

### jsql bench（基准测试）

```bash
# 默认基准（插入/查询/更新/删除/并发）
jsql bench

# 指定操作数与并发
jsql bench --ops 10000 --concurrency 8 --mode memory

# 输出 JSON 结果
jsql bench --json
```

输出示例：

```
Benchmark: 10,000 ops, concurrency 4, engine native
  insert: 12,345 ops/s
  select: 98,765 ops/s
  update: 45,678 ops/s
  delete: 56,789 ops/s
  mixed:  34,567 ops/s
```

### jsql mod（模块管理）

```bash
# 查看当前引擎与可用模块
jsql mod

# 强制使用某引擎
jsql mod --engine native   # native | wasm | js
```

```bash
# 输出示例
Current engine: native (napi)
Available:
  native  ✅ active
  wasm    ✅ built
  js      ✅ built
Data dir: /root/.jsql-neo/data
```

### jsql version

```bash
$ jsql version
jsql-neo v5.3.1
engine: native (napi) | wasm | js
node: v22.0.0
platform: linux x64
commit: 9211468
```

---

## TUI 交互式终端

`jsql tui` 是零依赖、raw-mode 的交互式 SQL 终端——不依赖 `readline` 的增强特性，全部
行编辑/历史/补全/Tab 渲染均为内置实现（`lib/tui.js`），在任何终端（含 Windows Terminal、
iTerm2、GNOME Terminal、tmux）上行为一致。

### 启动与选项

```bash
# 连接磁盘数据库并启动 TUI
jsql tui --data-dir ./data

# 指定初始库与方言
jsql tui --data-dir ./data --db app --dialect mysql

# 纯内存
jsql tui --memory

# 静默（关闭状态栏提示）
jsql tui --data-dir ./data -q
```

| 选项 | 默认 | 说明 |
|---|---|---|
| `--data-dir <dir>` | 内存模式 | 数据目录 |
| `--db <name>` | 无 | 初始选中数据库 |
| `--dialect <name>` | auto | `mysql` / `pg` / `sqlite` / `auto` |
| `--memory` | false | 内存模式 |
| `-q, --quiet` | false | 关闭启动提示与状态栏 |

状态栏显示：`db=<当前库> dialect=<方言> mode=<tui|batch> ver=<版本>`。

### 快捷键 Keyboard shortcuts

| 按键 | 功能 |
|---|---|
| `Enter` | 执行语句（语句完整时） |
| `Ctrl+C` | 行内有输入 → 清空当前行；行空 → 退出 |
| `Ctrl+D` | 退出（EOF） |
| `Ctrl+L` | 清屏 |
| `Ctrl+A` / `Home` | 光标到行首 |
| `Ctrl+E` / `End` | 光标到行尾 |
| `Ctrl+U` | 清空整行 |
| `Ctrl+K` | 删除光标到行尾 |
| `Ctrl+W` | 删除光标前一个词 |
| `Left` / `Right` | 光标左右移动 |
| `Up` / `Down` | 历史上一条 / 下一条 |
| `Backspace` / `Delete` | 删除字符 |
| `Tab` | 关键字/表名/列名补全 |
| `Shift+Tab` | 反向补全候选 |
| `PageUp` / `PageDown` | 历史大范围翻页 |
| `Ctrl+B` / `Ctrl+F` | 光标移动（emacs 风格） |
| `Ctrl+P` / `Ctrl+N` | 历史导航（emacs 风格） |

### 元命令 Meta commands

| 命令 | 说明 | 示例 |
|---|---|---|
| `\q` `\quit` `\exit` `exit` `quit` | 退出 TUI | `\q` |
| `\c [db]` | 连接/切换数据库 | `\c app` |
| `\db` | 显示当前库 | `\db` |
| `\use <name>` | 切换数据库（别名 \c） | `\use app` |
| `\tables` | 列出全部表 | `\tables` |
| `\desc <table>` | 表结构（列/类型/约束/索引） | `\desc users` |
| `\indexes [table]` | 索引列表 | `\indexes users` |
| `\databases` | 数据库列表 | `\databases` |
| `\help` `\?` | 帮助 | `\help` |
| `\history` | 显示历史记录 | `\history` |
| `\clear` | 清屏（同 Ctrl+L） | `\clear` |
| `\echo <text>` | 输出文本 | `\echo hi` |
| `\schema [table]` | 导出建表语句 | `\schema users` |

```text
jsql> \tables
┌──────────┬──────────┐
│ name     │ type     │
├──────────┼──────────┤
│ users    │ table    │
│ orders   │ table    │
│ v_active │ view     │
└──────────┴──────────┘
```

### 续行与语句边界

- 语句以 `;`（分号）结尾，或元命令 `\g` 强制执行
- 输入在引号内（`'...'`、`"..."`、`` `...` ``）或括号未闭合时自动进入**续行模式**，
  提示符变为 `jsql>  ...> `（缩进 4 空格）
- 续行模式中 `Ctrl+C` 取消整个待执行语句
- 语句边界检测考虑字符串转义与注释（`--`、`/* */`）

```text
jsql> SELECT COUNT(*)
  ...> FROM users
  ...> WHERE name = 'Alice'
  ...> AND (age > 18 OR vip = 1);
+----------+
| COUNT(*) |
+----------+
| 1        |
+----------+
1 row in set (0.42 ms)
```

### 批处理模式 Batch mode

非 TTY（管道/文件重定向/CI）时自动进入批处理模式：

```bash
# 管道执行
echo "SELECT * FROM users;" | jsql tui --data-dir ./data

# 脚本文件
jsql tui --data-dir ./data < script.sql

# 结果输出为纯文本表（非 TTY 不使用 ANSI 控制序列）
```

批处理特性：

- 逐条执行并输出 ASCII 表格
- 错误不中断后续语句（收集并汇总）
- 退出码：全部成功 `0`，存在错误 `1`
- `--quiet` 时仅输出数据

## Web UI 与 HTTP API

`jsql ui` 内置一个**零依赖**的 Web 管理台：无需构建、无需前端依赖，一个 HTML 页面 + HTTP API。

```bash
jsql ui --data-dir ./data -p 8080 --db app
```

### HTTP API 端点

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/` | Web 管理台页面 |
| `GET` | `/api/status` | 服务器状态（版本/引擎/库数/表数） |
| `GET` | `/api/databases` | 数据库列表 |
| `POST` | `/api/databases` | 创建数据库 |
| `DELETE` | `/api/databases/:name` | 删除数据库 |
| `GET` | `/api/databases/:db/tables` | 表列表 |
| `GET` | `/api/databases/:db/tables/:table` | 表结构 + 数据预览 |
| `POST` | `/api/databases/:db/query` | 执行 SQL（JSON body：`{ "sql": "...", "params": [] }`） |
| `POST` | `/api/databases/:db/import` | 导入（JSON/CSV 上传） |
| `GET` | `/api/databases/:db/export` | 导出 JSON |

### 查询示例

```bash
curl -s -X POST http://127.0.0.1:8080/api/databases/app/query \
  -H 'Content-Type: application/json' \
  -d '{"sql": "SELECT * FROM users WHERE age > ?", "params": [18]}'
```

```json
{
  "ok": true,
  "columns": ["id", "name", "age"],
  "rows": [[1, "Alice", 30], [2, "Bob", 25]],
  "rowCount": 2,
  "durationMs": 0.3
}
```

### Web 管理台功能

- 数据库/表浏览（左侧树）
- SQL 编辑器（多语句、语法高亮基本着色）
- 查询结果表格 + 导出 CSV
- 表数据预览与分页
- 表结构查看（列/索引/约束）
- 导入导出入口

> 安全提示：Web UI 默认无认证。生产环境请置于反向代理之后，或仅监听 127.0.0.1。

---

## 兼容层 Compatibility Layers

### mysql2 / TypeORM / Sequelize 内存兼容

`lib/mysql2_compat.js` 提供与 `mysql2` 驱动同构的 API，可在**无网络**场景直接使用：

```js
const { createMysql2Compat } = require('jsql-neo');
const mysql = createMysql2Compat({
  database: ':memory:',     // 或数据目录
  multipleStatements: true,
});

// 与 mysql2 完全一致的 API
const conn = await mysql.createConnection({});
const [rows, fields] = await conn.query('SELECT * FROM users WHERE id = ?', [1]);
const [res] = await conn.execute('INSERT INTO users (name) VALUES (?)', ['Alice']);
console.log(res.insertId);          // → 1

// Promise API 与回调 API 均支持
mysql.createConnection({}).query('SELECT 1', (err, rows) => {});

await conn.end();
```

这样写的好处：

```js
// 业务代码无需感知底层是真实 MySQL 还是嵌入式引擎
const run = async (pool) => {
  const [rows] = await pool.query('SELECT name FROM users WHERE age > ?', [18]);
  return rows;
};
// 测试用
const compat = createMysql2Compat({ database: ':memory:' });
const pool = compat.createPool({});
await run(pool);   // 嵌入式执行，零网络
// 生产用
const real = require('mysql2/promise');
const pool = real.createPool({ host: 'prod', ... });
await run(pool);   // 连接真实 MySQL
```

### NeDB 兼容 Datastore

`lib/nedb_compat.js` 提供与 NeDB（嵌入式 MongoDB 风格数据库）兼容的 Datastore：

```js
const { NeDBDatastore } = require('jsql-neo');

const db = new NeDBDatastore({ filename: './data/nedb.json' });
await db.loadDatabase();

await db.insert({ name: 'Alice', age: 30 });
await db.insert([{ name: 'Bob', age: 25 }, { name: 'Carol', age: 40 }]);

const alice = await db.findOne({ name: 'Alice' });
const over30 = await db.find({ age: { $gt: 30 } }).sort({ age: 1 }).exec();

await db.update({ name: 'Alice' }, { $set: { age: 31 } }, {});
await db.remove({ age: { $lt: 20 } }, { multi: true });

await db.count({});
```

兼容点：

- `insert` / `find` / `findOne` / `update` / `remove` / `count` 签名一致
- 查询操作符：`$gt $gte $lt $lte $eq $ne $in $nin $exists $regex $and $or $not`
- 更新操作符：`$set $unset $inc $push $pull $addToSet`
- `find().sort().skip().limit().exec()` 链式 API
- 回调与 Promise 双风格（回调风格保持 NeDB 原生签名）

### SQLite 兼容层

`lib/sqlite_compat.js` 模拟 `better-sqlite3` / `sqlite3` 的常用 API：

```js
const { SQLiteCompat } = require('jsql-neo');

const db = new SQLiteCompat(':memory:');

// better-sqlite3 风格（同步）
const stmt = db.prepare('INSERT INTO users (name, age) VALUES (?, ?)');
stmt.run('Alice', 30);
const rows = db.prepare('SELECT * FROM users WHERE age > ?').all(18);

// sqlite3 风格（异步回调）
db.all('SELECT * FROM users', (err, rows) => {});
db.run('CREATE TABLE t (id INT)', () => {});
```

适用场景：将依赖 better-sqlite3 的库无缝切换到 JSQL-NEO 引擎（内存/磁盘/多协议）。

---

## 数据迁移工具 Migration Tools

`lib/migrate.js` 提供完整的迁移工具链：

### mysqldump 导入

```js
const { importDumpFile } = require('jsql-neo');

// 文件导入（自动识别 dump 格式）
await importDumpFile(db, './backup/dump.sql');

// 字符串导入
await importDump(db, `CREATE TABLE users (id INT PRIMARY KEY, name VARCHAR(50));
INSERT INTO users VALUES (1, 'Alice');
INSERT INTO users VALUES (2, 'Bob');`);
```

支持 mysqldump 输出的常见语句：

- `CREATE TABLE ...`（含 `AUTO_INCREMENT`、`KEY`、`UNIQUE`、反引号）
- `INSERT INTO ... VALUES (...), (...), ...`（长行拆分自动处理）
- `LOCK TABLES` / `UNLOCK TABLES`（忽略）
- `SET @@SESSION.*` / `SET character_set_*`（忽略）
- `/*!40101 SET ... */` 版本化注释（按注释忽略）
- `USE db;`（切换目标库）
- 空行与 `--` 注释

```js
// 也支持从文件流式导入（内存友好）
const fs = require('fs');
const stream = fs.createReadStream('./big-dump.sql');
await importDumpFile(db, stream, { onProgress: (n) => console.log(`导入 ${n} 行`) });
```

### JSON 导入导出

```js
const {
  exportAllToJSON,     // 全库 → JSON 字符串
  exportTableToJSON,   // 单表 → JSON 字符串
  importFromJSON,      // JSON 字符串 → 库
} = require('jsql-neo');

const json = await exportAllToJSON(db);          // 含 schema + 数据
await importFromJSON(db, json);

// 单表
const usersJson = await exportTableToJSON(db, 'users');
await importFromJSON(db, usersJson);
```

JSON 格式（带 schema，可完整重建）：

```json
{
  "version": 1,
  "database": "app",
  "tables": [
    {
      "name": "users",
      "columns": [
        { "name": "id", "type": "INT", "primaryKey": true, "autoIncrement": true },
        { "name": "name", "type": "VARCHAR", "length": 100 }
      ],
      "indexes": [
        { "name": "idx_status", "columns": ["status"] }
      ],
      "rows": [
        { "id": 1, "name": "Alice" }
      ]
    }
  ]
}
```

### CSV 导入导出

```js
const { exportTableToCSV, importFromCSV } = require('jsql-neo');

const csv = await exportTableToCSV(db, 'users');          // 首行为表头
await importFromCSV(db, csv, { table: 'users', hasHeader: true });
```

CSV 规则：

- 默认逗号分隔，`--delimiter` / `options.delimiter` 可改（如 `\t`）
- 表头行自动识别（`hasHeader`）
- 引号包裹与转义（`""` 表示内嵌引号）完整处理
- 空值 → `NULL`
- 数值/布尔自动类型推断（可关闭 `coerceTypes: false`）

```js
// CLI 方式
jsql import ./data users.csv --table users
jsql export ./data --table users --format csv --output users.csv
```

---

## 存储引擎与性能 Storage & Performance

### 三种运行模式 Three engines

| 引擎 | 说明 | 适用场景 | 性能特征 |
|---|---|---|---|
| **native**（默认） | Rust N-API 原生插件 | 服务器、CLI、生产 Node.js | ⚡ 最快（~2× better-sqlite3） |
| **wasm** | Rust 编译 WASM | 浏览器、受限环境 | 接近 native（约 80%） |
| **js** | 纯 JavaScript 实现 | 无 Rust 工具链的环境 | 兼容兜底 |

自动回退链：`native → wasm → js`。`jsql mod` 可查看与切换：

```bash
jsql mod
# Current engine: native (napi)
```

编程式：

```js
const db = new Database('./data', { defaultEngine: 'native' });
console.log(db.getEngineType());
```

### 内存 / 混合 / 磁盘模式

| 模式 | 触发 | 行为 |
|---|---|---|
| 内存模式 | `dataDir` 省略 / `':memory:'` | 全部在内存，退出即失 |
| 磁盘模式 | 传入 `dataDir` | 启动加载快照，写操作后自动保存 |
| 混合模式 | `autoSave: true` + `saveInterval` | 写入内存立即生效 + 定时异步落盘 |

```js
const mem = new Database(':memory:');                    // 内存
const disk = new Database('./data/app', { autoSave: true });   // 磁盘
```

写操作路径：

```
INSERT → 内存数据 + 变更日志(tlog) → [saveInterval] → 序列化快照 → 文件
                                               ↑ 手动 db.flush() 即时落盘
```

### B-Tree 索引

- 每张表的每个索引独立 B-Tree
- 主键（PK）自动建索引；`UNIQUE KEY` 也是索引
- 普通索引用 `CREATE INDEX` / `KEY (cols)`
- 复合索引按列序匹配最左前缀
- `WHERE` 中的 `=` `>` `<` `>=` `<=` `BETWEEN` 与 `ORDER BY` 可走索引
- 索引与数据同文件存储（快照一致）

```js
db.createIndex('orders', ['user_id']);
db.createIndex('orders', ['status', 'created_at']);
```

### WAL 与崩溃恢复 WAL & crash recovery

- 每次写操作先追加变更日志（tlog），再应用内存
- `flush()` / 自动保存时：写快照 → 成功后清空日志
- 启动时若检测到快照 + 未清空的日志：**重放日志**恢复到最近一致状态
- 日志截断/损坏时自动降级为加载最后完整快照并告警

```
启动流程:
  加载最后快照 ──► 检测 tlog ──► 有? ──► 重放 ──► 就绪
                     │               │
                     └── 无 ─────────┘
```

### 快照与压缩 Snapshots & compression

| 特性 | 说明 |
|---|---|
| 快照格式 | 单文件（`.jsql` / 自定义），含 schema + 索引 + 数据 + Redis key 空间 |
| 压缩 | 构建支持 `lz4` / `zstd`；JS 兜底无压缩 |
| 自动保存 | `autoSave`（默认开）+ `saveInterval`（默认 3s） |
| 手动保存 | `db.saveTo(file)` / `db.flush()` |
| 恢复 | 构造时自动加载；`db.loadFrom(file)` 手动 |
| 幂等停止 | `stop()` 多次调用安全，全部数据落盘 |
| 原子写 | 快照写入临时文件 → rename，避免半写文件 |

```js
db.saveTo('./snapshot.jsql');         // 显式快照
const db2 = new Database('./data');   // 启动自动加载
db2.loadFrom('./snapshot.jsql');      // 或手动覆盖加载
```

## 安全性 Security

### 认证与 ACL

所有协议服务器支持一致的认证模型：

```js
createMultiServer({
  auth: {
    admin:   { password: 'admin123', databases: ['*'] },
    analyst: { password: 'ro123',    databases: ['app', 'reporting'] },
  },
  // 省略 noAuth → 默认 false（需要认证）
});
```

- `databases: ['*']` → 全部数据库
- `databases: ['app', 'reporting']` → 仅限列表内数据库
- 认证失败：MySQL `Access denied` / PG `28000` / Redis `NOAUTH` / Mongo `Unauthorized`
- `noAuth: true` 仅用于本地开发与测试；生产环境务必配置 `auth` 并监听非公网地址
- 密码以明文形式存在于配置（开发便捷）；生产建议从环境变量/密钥管理注入

### SQL 注入防护

1. **首选参数化查询**（`?` / `$1` / BSON）：所有协议 + 嵌入式 API 支持
2. **词法级解析**：解析器基于完整 tokenizer，`'`、`\`、`;`、注释（`--` `#` `/* */`）均在
   字符串上下文中正确识别，无法通过引号逃逸绕过
3. **标识符转义**：`escapeId` / `??` 参数处理动态表名/列名
4. **禁用危险函数**：`SLEEP`、`LOAD_FILE`、`INTO OUTFILE` 等在解析层被拦截并报错
5. **拒绝多语句拼接**：多语句由 `splitStatements` 显式管理，动态 SQL 不拼接用户输入

```js
// ✅ 正确：参数化
await executeSQL(db, 'SELECT * FROM users WHERE name = ?', [userInput]);

// ❌ 危险：字符串拼接（引擎会执行但请勿这样用）
// await executeSQL(db, `SELECT * FROM users WHERE name = '${userInput}'`);
```

### 危险语句检测

解析器在执行前扫描以下模式并**拒绝**：

| 模式 | 示例 | 处理 |
|---|---|---|
| 文件写出 | `SELECT ... INTO OUTFILE '/etc/passwd'` | `ER_NOT_SUPPORTED` |
| 文件读取 | `LOAD_FILE('/etc/passwd')` | `ER_NOT_SUPPORTED` |
| DoS 函数 | `SLEEP(1000)` | `ER_NOT_SUPPORTED` |
| 系统命令 | `sys_exec(...)` 等扩展 | 未注册 → 语法错误 |
| 未认证 DDL | 无认证时 `DROP DATABASE` | 认证错误（服务器场景） |

### 路径遍历防护

- 数据目录基于参数化路径，导出/导入路径经 `path` 规范化检查
- `dataDir` 必须是目录且可写，构造时校验
- Web UI 的 `/api/databases/:name/...` 路由对库名做白名单校验（拒绝 `..`、`/` 等）

---

## 错误码与错误处理 Errors

### MySQL 风格错误码

`lib/errors.js` 定义 33 个标准 MySQL 错误码：

| 错误码 | 名称 | 触发场景 |
|---|---|---|
| `1049` | ER_NO_SUCH_TABLE 变体（ER_BAD_DB） | 数据库不存在 |
| `1050` | ER_TABLE_EXISTS | 表已存在 |
| `1054` | ER_BAD_FIELD_ERROR | 列不存在 |
| `1062` | ER_DUP_ENTRY | 唯一键冲突 |
| `1091` | ER_CANT_DROP_FIELD | 删除不存在列 |
| `1146` | ER_NO_SUCH_TABLE | 表不存在 |
| `1007` | ER_DB_CREATE_EXISTS | 数据库已存在 |
| `1008` | ER_DB_DROP_EXISTS | 删除不存在数据库 |
| `1064` | ER_PARSE_ERROR | 语法错误 |
| `1115` | ER_NOT_SUPPORTED | 不支持的特性 |
| `1205` | ER_LOCK_WAIT_TIMEOUT | 锁等待超时 |
| `1264` | ER_OUT_OF_RANGE | 数值越界 |
| `1265` | ER_TRUNCATED_WRONG_VALUE | 数据截断 |
| `1292` | ER_INVALID_DATE | 非法日期 |
| `1364` | ER_NO_DEFAULT_FOR_FIELD | 缺默认值 |
| `1406` | ER_DATA_TOO_LONG | 数据超长 |
| `1451` | ER_ROW_IS_REFERENCED | 外键被引用 |
| `1452` | ER_NO_REFERENCED_ROW | 外键引用不存在 |
| `3819` | ER_CHECK_CONSTRAINT | CHECK 约束违反 |
| `1051` | ER_NO_SUCH_TABLE | 同 1146（不同场景） |
| `1449` | ER_NO_SUCH_USER | 用户不存在 |
| `1045` | ER_ACCESS_DENIED | 认证失败 |

更多码：`ER_DUP_FIELDNAME`、`ER_BAD_NULL_ERROR`、`ER_TRANSACTION_ACTIVE`、
`ER_NO_TRANSACTION`、`ER_FILE_NOT_FOUND`、`ER_VIEW_EXISTS`、`ER_TRIGGER_EXISTS`、
`ER_TRIGGER_NOT_FOUND`、`ER_PLUGIN_ERR`、`ER_PLUGIN_ABORT`、`ER_TABLE_EXISTS_ERROR`、
`ER_BAD_TABLE_NAME`、`ER_BAD_REGEX`、`ER_DBATTACH_EXISTS`、`ER_DBATTACH_NOT_FOUND`。

### PostgreSQL SQLSTATE

见 [SQLSTATE 错误映射](#sqlstate-错误映射) 完整表格。核心映射：

| 错误键 | SQLSTATE |
|---|---|
| ER_NO_SUCH_TABLE / "Table doesn't exist" | `42P01` |
| ER_DUP_ENTRY / unique_violation | `23505` |
| ER_BAD_NULL_ERROR | `23502` |
| ER_NO_REFERENCED_ROW | `23503` |
| ER_ROW_IS_REFERENCED | `23503` |
| ER_PARSE_ERROR / 语法错误 | `42601` |
| ER_INVALID_DATE | `22007` |
| 约束兜底 | `23000` |
| 数据库不存在 | `3D000` |
| 未匹配 | `XX000` |

### JSQL_Error 结构

```js
{
  code: 'ER_NO_SUCH_TABLE',      // 错误键（内部）
  sqlState: '42P01',             // PG 映射（协议层）
  mysqlCode: 1146,               // MySQL 码（协议层）
  message: "Table 'users' doesn't exist",
  sql: 'SELECT * FROM users',    // 触发语句（可选）
  statementIndex: 0,             // 多语句中的位置（可选）
}
```

```js
try {
  await executeSQL(db, 'SELECT * FROM nope');
} catch (e) {
  console.log(e.code);       // ER_NO_SUCH_TABLE
  console.log(e.message);    // Table 'nope' doesn't exist
}
```

协议层自动转换：MySQL 用 `mysqlCode` + `ER_*` 消息；PG 用 `sqlState` + 消息；Redis/Mongo
用各自的错误格式。

---

## TypeScript 支持

包内置 `index.d.ts` 类型声明，开箱即用：

```ts
import { Database, executeSQL } from 'jsql-neo';
import type { QueryResult, RowFilter } from 'jsql-neo';

const db = new Database(':memory:');
db.createTable('users', {
  id: { type: 'INT', primaryKey: true, autoIncrement: true },
  name: { type: 'VARCHAR', length: 100 },
});

const res: QueryResult = await executeSQL(db, 'SELECT * FROM users WHERE id = ?', [1]);

// 文档式过滤
const rows = db.find('users', { age: { $gte: 18 } satisfies RowFilter });
```

声明覆盖：`Database`、`executeSQL`、全部服务器工厂、TUI、迁移工具、兼容层。

---

## 内部架构 Architecture

### 模块布局 Module layout

```
jsql-neo/
├── bin/
│   └── jsql                     # CLI 入口（yaggs 框架）
├── lib/
│   ├── database.js              # ★ 核心：Database 引擎（表/索引/事务/持久化）
│   ├── sql.js                   # ★ SQL 解析器 + 执行器（tokenizer/AST/executor）
│   ├── engine.js                #   存储引擎抽象（native/wasm/js 三实现接口）
│   ├── native.js / wasm.js / js_engine.js  # 三种引擎实现
│   ├── index.js                 #   模块导出聚合
│   ├── errors.js                #   错误码表（MySQL 33 码 + 键）
│   ├── mysql_server.js          #   MySQL wire protocol（握手/查询/结果集）
│   ├── pg_server.js             #   PG wire protocol（SCRAM/扩展协议/SQLSTATE）
│   ├── mongo_server.js          #   MongoDB wire protocol（OP_MSG/OP_QUERY/BSON/聚合）
│   ├── redis_server.js          #   Redis RESP2（五大数据类型/TTL/持久化）
│   ├── multiserver.js           #   多协议嗅探路由器（一端口四协议）
│   ├── tui.js                   #   TUI（raw mode/行编辑/历史/补全/表格渲染）
│   ├── migrate.js               #   迁移（dump/JSON/CSV 导入导出）
│   ├── mysql2_compat.js         #   mysql2 API 兼容层
│   ├── nedb_compat.js           #   NeDB 兼容层
│   ├── sqlite_compat.js         #   better-sqlite3/sqlite3 兼容层
│   ├── wasm_client.js           #   浏览器 WASM 客户端
│   ├── index.js                 #   根导出
│   └── ...（工具模块）
├── index.js                     # ★ 公共 API 出口
├── index.d.ts                   # TypeScript 声明
├── test/                        # 测试套件
├── docs/                        # 文档（本文件即索引）
├── src/rust/                    # Rust 引擎源码（native + wasm）
├── data/                        # 默认数据目录（运行时创建）
└── package.json
```

### 查询执行管线 Query pipeline

```
SQL 文本
  │
  ▼
tokenize()          词法分析（字符串/注释/运算符/标识符）
  │
  ▼
parseSQL()          语法分析 → AST（select/insert/update/delete/ddl/事务）
  │
  ▼
SQLExecutor.feed()  语句分割与规划（多语句）
  │
  ▼
executeSelect()     查询优化（索引选择/连接顺序）
  │
  ▼
引擎执行            Database.find/update/removeWhere（B-Tree 索引扫描或全表）
  │
  ▼
结果封装            columns/types/rows/affectedRows/insertId
```

三条并行通路（同一引擎核心）：

1. **SQL 通路**：`sql.js` 解析执行 → Database 数据方法
2. **文档通路**：Mongo 命令/操作符 → `_match` 过滤器 → Database 数据方法
3. **键值通路**：Redis 命令 → 引擎内 key 命名空间（String/Hash/List/Set/ZSet）

### 协议层如何共享引擎

```
                 ┌──────────────────────────┐
   mysql 连接 ──►│  mysql_server.js         │─┐
                 ├──────────────────────────┤ │
   pg 连接 ────►│  pg_server.js            │─┤
                 ├──────────────────────────┤ ├──► Database 实例池
   mongo 连接 ──►│  mongo_server.js         │─┤     （按库名懒创建）
                 ├──────────────────────────┤ │
   redis 连接 ──►│  redis_server.js         │─┘
                 └──────────────────────────┘
                           │ 首包嗅探
                 ┌──────────────────────────┐
   TCP 连接 ────►│  multiserver.js 路由器    │
                 └──────────────────────────┘
```

- 每个数据库（schema）一个 `Database` 实例，跨协议共享
- 写操作经由引擎级锁串行化，读操作并行
- Redis 的 key 空间与表空间隔离（表名不会与 Redis key 冲突）
- `close()` 时按逆序停止：连接 → 引擎（flush）→ 端口

---

## FAQ 常见问题

**Q: 需要安装 Rust 才能用吗？**
A: 不需要。npm 包内置了 prebuilt native 二进制；找不到时自动回退 WASM → 纯 JS。
`npm run build` 仅在你想从源码重建引擎时需要 Rust 工具链。

**Q: 支持 Windows / macOS / Linux 吗？**
A: 支持。native 二进制提供三平台 x64/arm64 预编译；其余场景自动回退 WASM/JS。

**Q: 数据文件格式是什么？能否被其他工具读取？**
A: 快照是自定义二进制格式（可选 lz4/zstd 压缩）。请使用 `jsql export` 导出 SQL/JSON/CSV
与外部工具交互——迁移工具面向生态兼容设计。

**Q: 和 SQLite 的区别？**
A: SQLite 是单机文件库；JSQL-NEO 提供完整的多协议服务器（MySQL/PG/Redis/Mongo 客户端
零改动直连）、浏览器 WASM、Mongo/Redis 语义——"一个包代替四套本地服务"。

**Q: 内存数据库能有多大？**
A: 受 JS 堆限制（Node 默认约 2-4GB）。大数据集建议磁盘模式 + 索引，或
`node --max-old-space-size=8192` 提升堆上限。

**Q: 并发写入安全吗？**
A: 安全。引擎级写锁串行化写操作，读无锁并行；多连接（四种协议混合）写入原子。

**Q: 支持数据加密吗？**
A: 支持文件级快照压缩；磁盘加密未内置（可配合加密文件系统/LUKS 等）。

**Q: 服务端如何排查连接问题？**
A: 加 `--verbose` 查看协议识别日志；单协议模式（`jsql serve` 不带 `--pg`）排除嗅探因素；
`jsql tui --data-dir <dir>` 直接检查数据文件是否完好。

**Q: `jsql serve --pg` 和 `createMultiServer` 的差别？**
A: 无差别。CLI 是 API 的薄封装，参数一一对应。

**Q: 如何让多个 Node 进程共享一个数据目录？**
A: 不支持多进程同时打开同一 dataDir（无跨进程锁）。多进程场景请用服务器模式
（一个 `jsql serve` 进程，多客户端连接）。

**Q: 浏览器里能跑服务器协议吗？**
A: 浏览器只能跑嵌入式 WASM 引擎（`lib/wasm_client.js`）。wire 协议服务器需要 TCP，
仅限 Node.js 环境。

**Q: 测试怎么做？**
A: 见 [贡献与开发 Contributing](#贡献与开发-contributing) 的测试命令。协议测试使用真实
客户端驱动（mysql2/pg/ioredis/mongodb）做端到端验证。

---

## 基准测试 Benchmark

`jsql bench` 内置基准（本机相对值，具体数字取决于硬件）：

```bash
jsql bench --ops 100000 --concurrency 8
```

```text
Benchmark: 100,000 ops, concurrency 8, engine native
  insert:  82,410 ops/s
  select: 621,905 ops/s
  update:  95,332 ops/s
  delete: 108,244 ops/s
  mixed:   89,673 ops/s
```

优化建议：

| 场景 | 建议 |
|---|---|
| 大量写入 | 关闭 `autoSave`，定期 `db.flush()` 批量落盘 |
| 大量读取 | 建立索引；避免 `SELECT *` 取多余列 |
| 大表扫描 | 磁盘模式 + 复合索引 |
| 内存敏感 | `saveInterval` 调大；压缩快照 |
| 高并发 | 连接池（复用连接）、批量插入 `insertMany` |

---

## 贡献与开发 Contributing

```bash
# 克隆
git clone https://github.com/vexify-org/JSQL-neo.git
cd JSQL-neo

# 安装依赖（仅开发需要）
npm install

# 构建 Rust 引擎（native + wasm；可选，可跳过）
npm run build

# 运行测试
npm test

# 仅跑核心引擎测试
npm run test:core

# 协议端到端测试（需要真实客户端驱动）
npm run test:protocols

# 代码检查
npm run lint

# 类型检查
npm run typecheck
```

贡献流程：

1. Fork 仓库并创建特性分支
2. 为改动补充测试（新增 SQL 语法 → `test/sql/`；新协议命令 → 协议测试目录）
3. 运行 `npm test` 与 `npm run lint` 确保通过
4. 提交信息遵循 Conventional Commits（`feat:` / `fix:` / `docs:` / `refactor:`）
5. 打开 PR 并描述改动与测试结果

**开发约定：**

| 领域 | 约定 |
|---|---|
| 新 SQL 语句/函数 | `lib/sql.js` 注册解析 + 执行；`test/sql/` 加用例 |
| 新 Mongo 命令/操作符 | `lib/mongo_server.js` 的 `_match` / 命令表注册 |
| 新 Redis 命令 | `lib/redis_server.js` 命令表 + `TYPE_SIGNATURES` |
| 错误处理 | 复用 `lib/errors.js` 错误键，不新增字符串魔法值 |
| 文档 | 本 README 保持与功能同步；新命令必须补命令参考表 |
| 兼容性 | 修改协议层必须跑对应客户端 E2E 测试 |

**目录说明：**

- `src/rust/`：Rust 引擎（native + wasm 同源）
- `lib/`：Node 侧全部逻辑（协议/解析/TUI/兼容层）
- `test/`：单元 + 集成测试
- `docs/`：扩展文档

---

## License 许可证

JSQL-NEO 采用 **MIT License**。

```
MIT License

Copyright (c) 2026 vexify-org

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

*JSQL-NEO — One engine to rule them all. MySQL. PostgreSQL. MongoDB. Redis. SQL. TypeScript. The browser.*

*文档版本：v5.3.1 · 最后更新：2026-08-12*

---

## 附录 A：MySQL 协议实现细节

### 握手流程 Handshake sequence

```
MySQL Client                          JSQL Server
    │                                     │
    │      ←── 握手包 HandshakeV10 ────    │  server_version、connection_id、
    │                                     │  auth_plugin_data、capabilities
    │      ──── 响应 HandshakeResponse ──► │  username、auth_response(20B)、database
    │                                     │
    │      ←── OK 包 (0x00) ────────────   │  → 认证通过
    │      ←── 或 ERR 包 (0xFF) ────────   │  → Access denied (1045)
    │                                     │
    │      ──── COM_QUERY ───────────────► │
    │      ←── 结果集/OK/ERR ────────────  │
```

### 能力位 Capabilities flags

服务器声明并处理的能力位：

| 标志 | 值 | 说明 |
|---|---|---|
| `CLIENT_LONG_PASSWORD` | 0x00000001 | 长密码 |
| `CLIENT_FOUND_ROWS` | 0x00000002 | FOUND_ROWS 语义 |
| `CLIENT_LONG_FLAG` | 0x00000004 | 长 flags |
| `CLIENT_CONNECT_WITH_DB` | 0x00000008 | 连接时指定库 |
| `CLIENT_PROTOCOL_41` | 0x00000200 | 4.1 协议 |
| `CLIENT_TRANSACTIONS` | 0x00002000 | 事务支持 |
| `CLIENT_MULTI_STATEMENTS` | 0x00010000 | 多语句 |
| `CLIENT_MULTI_RESULTS` | 0x00020000 | 多结果集 |
| `CLIENT_PLUGIN_AUTH` | 0x00080000 | 插件认证 |
| `CLIENT_DEPRECATE_EOF` | 0x01000000 | 无 EOF 包（OK 代替） |
| `CLIENT_SECURE_CONNECTION` | 0x00008000 | 安全连接（20B 摘要） |

### 命令类型 Command types

| 命令字节 | 命令 | 支持 |
|---|---|---|
| `0x00` | COM_QUIT | ✅ 关闭连接 |
| `0x01` | COM_INIT_DB | ✅ 切换数据库 |
| `0x02` | COM_QUERY | ✅ 全功能 |
| `0x03` | COM_FIELD_LIST | ✅ 列列表 |
| `0x05` | COM_PROCESS_KILL | ⚠️ 返回 OK（占位） |
| `0x09` | COM_STATISTICS | ✅ 统计信息 |
| `0x0e` | COM_PING | ✅ PONG |
| `0x12` | COM_SHUTDOWN | ⚠️ 返回 OK |
| `0x1a` | COM_STMT_PREPARE | ✅ 预处理准备 |
| `0x1b` | COM_STMT_EXECUTE | ✅ 预处理执行 |
| `0x1c` | COM_STMT_SEND_LONG_DATA | ✅ |
| `0x1d` | COM_STMT_CLOSE | ✅ |
| `0x1e` | COM_STMT_RESET | ✅ |
| `0x1f` | COM_SET_OPTION | ✅ |
| `0x20` | COM_STMT_FETCH | ⚠️ 单批返回 |

### 结果集编码 Resultset encoding

```
Column Definition (每列):
  [lenenc] catalog("def") [lenenc] schema [lenenc] table [lenenc] org_table
  [lenenc] name [lenenc] org_name [lenenc] length [2B] charset [1B] flags
  [2B] decimals [2B] type(0x0f=STRING/0x03=LONG/...) [2B] unused

Row (每行):
  [lenenc] value1 [lenenc] value2 ...

终止（DEPRECATE_EOF 关闭时）:
  OK 包: affectedRows=0, status=0x0002(LAST_ROW_SENT)
EOF 开启时:
  EOF 包: header 0xfe + warnings + status
```

类型映射（MySQL 类型码 → 引擎类型）：

| MySQL 类型码 | 名称 | 引擎类型 |
|---|---|---|
| `0x01` | TINY | INTEGER |
| `0x02` | SHORT | INTEGER |
| `0x03` | LONG | INTEGER |
| `0x08` | LONGLONG | INTEGER/BIGINT |
| `0x0a` | DATE | DATE |
| `0x0c` | DATETIME | DATETIME |
| `0x0d` | TIME | TIME |
| `0x0f` | VARCHAR/STRING | TEXT |
| `0x10` | VAR_STRING | TEXT |
| `0x12` | DECIMAL | REAL/DECIMAL |
| `0xf6` | NEWDECIMAL | REAL/DECIMAL |
| `0xfb` | BLOB | BLOB/JSON |
| `0xfd` | DOUBLE | REAL |
| `0xfe` | NULL | NULL |

### 预处理语句 Prepared statements（COM_STMT_*）

```
COM_STMT_PREPARE("SELECT * FROM users WHERE id = ?")
  →  OK: statement_id=1, num_columns=5, num_params=1
  →  参数定义（1 个 Column Definition: type=0x03 LONG）
  →  EOF（或无，取决于 flags）
  →  列定义（5 个 Column Definition）
  →  EOF

COM_STMT_EXECUTE(statement_id=1, flags, iteration_count, null_bitmap, new_params_bound, params...)
  →  结果集（与 COM_QUERY 相同编码）

COM_STMT_CLOSE(statement_id=1)
```

- 参数以二进制格式传输：`[1B 类型][1B 符号][值]`
- null_bitmap 标记 NULL 参数（(n+7)/8 字节）
- `COM_STMT_RESET` 清空 long-data 缓冲

### 长度编码整数 Lenenc integers

| 首字节 | 编码 |
|---|---|
| `0x00-0xFB` | 单字节值 |
| `0xFC` | 后跟 2 字节小端 |
| `0xFD` | 后跟 3 字节小端 |
| `0xFE` | 后跟 8 字节小端 |

### 认证算法 mysql_native_password

```
scramble = server.random_bytes(20) + seed
SHA1 = sha1(password)
SHA1_2 = sha1(sha1(password))
token   = sha1(scramble + SHA1_2) XOR SHA1

服务器校验：
  candidate = sha1(token XOR sha1_2)
  compare(candidate, cached_sha1)  // 存储的 sha1(password) 摘要
```

- 会话随机种子每次连接重新生成
- 失败返回 `1045 (28000) Access denied for user 'x'@'...'`
- `noAuth: true` 时跳过 token 校验直接 OK

### 常见排查

| 现象 | 原因 |
|---|---|
| 客户端卡在握手 | 多协议模式等待嗅探超时（200ms）；单协议模式不应发生 |
| `Client does not support authentication protocol` | 客户端仅支持 caching_sha2_password（老驱动）；请用 mysql2 |
| `Connection closed` 在认证后 | auth 配置的用户不在 `auth` 表中 |
| 中文乱码 | 客户端连接参数设置 `charset: 'utf8mb4'`（服务器以 UTF-8 处理） |

---

## 附录 B：PostgreSQL 协议实现细节

### 消息时序 Sequence diagram

```
psql                                   JSQL Server
  │── StartupMessage(3.0, user, db) ──► │
  │◄── AuthenticationSASL(scram-sha-256)│
  │── SASLInitialResponse ────────────► │
  │◄── AuthenticationSASLContinue ───── │
  │── SASLResponse ──────────────────► │
  │◄── AuthenticationOk ─────────────── │
  │◄── ParameterStatus × n ──────────── │
  │◄── BackendKeyData ───────────────── │
  │◄── ReadyForQuery(I) ─────────────── │
  │── Query("SELECT 1") ─────────────► │
  │◄── RowDescription ────────────────  │
  │◄── DataRow(1) ────────────────────  │
  │◄── CommandComplete(SELECT 1) ─────  │
  │◄── ReadyForQuery(I) ──────────────  │
  │── Terminate ─────────────────────► │
```

### SCRAM-SHA-256 详细流程

```
client-first-message:
  n,,n=,r=<nonce>          (GS2 header + username + client nonce)

server-first-message:
  r=<nonce+serverNonce>,s=<salt(base64)>,i=4096

client-final-message:
  c=biws,r=<combined nonce>,p=<proof(base64)>

proof = HMAC(Hi(salted_password, i=4096), "Client Key")
        → stored_key = H(client_key)
        → auth_message = c + s + i 的连接串
        → client_signature = HMAC(stored_key, auth_message)
        → proof = client_key XOR client_signature

服务器验证：
  client_key' = proof XOR client_signature
  H(client_key') == stored_key  → 通过
```

- `Hi()` 为 PBKDF2-HMAC-SHA256，iteration = 4096
- 支持两步认证（SASL）：`AuthenticationSASL` → 2 个 SASL continue 消息
- 无认证模式直接 `AuthenticationOk`

### 扩展协议解析 Parse/Bind/Execute

```
Parse:
  [1B 'P'][lenenc stmt_name][null-terminated sql][int16 nparams][param type OIDs...]

Bind:
  [1B 'B'][portal][stmt][int16 format_codes...][int16 nparams][param len+data...]
  [int16 result_format_codes...]

Execute:
  [1B 'E'][portal][int32 max_rows]

Describe:
  [1B 'D'][1B 'S'|'P'][name]

Sync:
  [1B 'S']
```

实现细节：

- 参数 OID 不强制匹配（引擎按值类型处理）；`0`（未指定）→ 按值推断
- `max_rows=0` 表示不限制
- 错误发生在 Parse/Bind/Execute 时，连接进入 `E`（错误）状态，收到 `Sync` 后复位为 `I`
- portal 与 statement 同名缓存：名字重复的 Prepare 覆盖旧语句

### 文本/二进制结果格式

| 类型 | 文本格式 | 二进制格式 |
|---|---|---|
| INT2/4/8 | `"123"` | 大端整数 |
| TEXT/VARCHAR | `"abc"` | 字节原文 |
| FLOAT/DOUBLE | `"1.5"` | IEEE754 |
| BOOL | `"t"/"f"` | `1`/`0` 单字节 |
| DATE/TIMESTAMP | `"2026-08-12"` | 自 2000-01-01 微秒数 |
| JSON/JSONB | 文本 | 文本 |

引擎统一以文本格式安全编码（避免浮点/日期二进制歧义），结果格式码请求二进制时按上表转换。

### 系统查询兼容

| 查询 | 处理 |
|---|---|
| `SELECT version()` | 返回 `PostgreSQL 16.0 (jsql-neo ...)` |
| `SELECT current_database()` | 当前库名 |
| `SELECT pg_backend_pid()` | 返回 1 |
| `SET client_encoding = 'UTF8'` | 接受并记录 |
| `SELECT 1` | 正常执行 |
| `information_schema.tables` | 返回真实元数据 |
| `pg_catalog.pg_typeof(...)` | 返回类型名 |

### 常见排查

| 现象 | 原因 |
|---|---|
| `connection refused` | 端口未启动或监听地址不是 127.0.0.1 |
| `SASL: authentication failed` | 密码错误；或客户端要求 channel binding（禁用 SCRAM-SHA-256-PLUS） |
| `too many clients` | 连接未释放；检查连接池 `max` 配置 |
| `column "x" does not exist` (42703) | 列名大小写：双引号标识符区分大小写 |
| `canceling statement due to user request` | CancelRequest 被忽略（引擎即时返回） |

---

## 附录 C：Redis RESP 协议实现细节

### RESP 数据格式

```
+OK\r\n                简单字符串（状态）
-ERR msg\r\n           错误
:123\r\n               整数
$5\r\nhello\r\n        批量字符串（$len\r\ndata\r\n；$-1 = nil）
*2\r\n\r\n            数组（*len\r\n + 元素）
```

### 请求解析

- 客户端可发送 RESP 数组（`*3\r\n$3\r\nSET\r\n...`）或内联命令（`SET k v\r\n`）
- 内联命令与多行解析均支持（与 Redis 一致）
- 未知命令 → `-ERR unknown command 'FOO'`
- 参数数量错误 → `-ERR wrong number of arguments for 'SET' command`
- 类型不匹配 → `-WRONGTYPE Operation against a key holding the wrong kind of value`

### 类型判断与错误

```bash
redis-cli -p 5432 SET a 1
redis-cli -p 5432 LPUSH a x
# (error) WRONGTYPE Operation against a key holding the wrong kind of value
```

- 类型判定表：`string` / `hash` / `list` / `set` / `zset` / `none`
- `INCR`/`DECR` 对非整数报错：`(error) ERR value is not an integer or out of range`
- `TTL` 对不存在 key 返回 `-2`，无 TTL 返回 `-1`

### 快照持久化格式

Redis key 空间随引擎快照落盘，结构示意：

```
snapshot
 ├── tables      (SQL 表数据)
 └── redis
     ├── keys     (string: value + expireAt)
     ├── hashes   (key → {field: value})
     ├── lists    (key → [v1, v2, ...])
     ├── sets     (key → Set)
     └── zsets    (key → Map member→score, sorted)
```

### 性能与连接

- 每连接独立解析器，命令顺序处理
- 长连接保持（`redis-cli` 交互模式）
- 空闲连接不超时（与 Redis 默认一致）
- 并发写经引擎写锁串行化

---

## 附录 D：MongoDB 协议实现细节

### OP_MSG 消息格式

```
消息头 (16B):
  [4B] messageLength [4B] requestID [4B] responseTo [4B] opCode=2013

OP_MSG payload:
  [1B] flags
      bit0: MORE_TO_COME
      bit16: CHECKSUM
  [1B] section kind=0 (body) + [lenenc] BSON 文档
  或 [1B] section kind=1 (sequence) + [int32 size] + [cstring] id + BSON 序列
  [4B] checksum（flags.bit16 时）
```

### OP_COMPRESSED 格式

```
消息头（opCode=2012 原始压缩消息）:
  [4B] originalOpCode (2004/2013)
  [4B] uncompressedSize
  [1B] compressorId (0=snappy, 1=zlib, 2=zstd)
  [n]  compressed payload

解压后按 originalOpCode 处理（OP_QUERY → 传统查询路径；OP_MSG → 现代路径）
```

### OP_QUERY / OP_REPLY

```
OP_QUERY:
  [int32 flags][cstring fullCollectionName][int32 skip][int32 return]
  [BSON query]（可含 $query 包装）

OP_REPLY:
  [int32 flags][int64 cursorID][int32 startingFrom][int32 numberReturned]
  [BSON 文档序列]
```

- cursorID 用 `{ $long: 0 }` 编码为 Int64（驱动可正确解码）
- `numberToReturn` 为 `0`/`-1` 表示不限制（按服务端分页）
- `find` 的 `batchSize` 同样生效

### BSON 编解码器细节

| 特性 | 实现 |
|---|---|
| 文档结构 | `[4B len][元素序列][0x00]` |
| 元素 | `[1B type][cstring key][value]` |
| 字符串 | `[4B len][utf8][0x00]` |
| 嵌套文档/数组 | 递归编解码 |
| ObjectId | `$oid` 16 进制字符串 ↔ 12 字节二进制 |
| 日期 | `$date` 毫秒时间戳 ↔ Int64 |
| 正则 | `$regex` + `$options` |
| Int64 | `$long` / `$numberLong`（支持高精度字符串形式） |
| 特殊值 | `undefined` → BSON 编码兼容处理 |

### 命令分派流程

```
OP_MSG body: { "find": "users", "filter": {...}, "$db": "app" }
  │
  ▼
路由 → db="app" → getEngine("app")
  │
  ▼
命令表查找 "find" → find 处理器
  │
  ▼
_parseFilter (操作符展开) → Database.find
  │
  ▼
结果 → BSON 编码 → OP_MSG reply
```

- 命令名取自 body 首键（`find`/`insert`/`aggregate`/...）
- `$db` 字段决定目标库
- 未知命令 → `{ ok: 0, errmsg: "no such command: 'foo'" }`

### 错误编码

| 错误 | 返回格式 |
|---|---|
| 命令不存在 | `{ ok: 0, errmsg: "no such command: 'foo'", code: 59 }` |
| 集合不存在 | `{ ok: 0, errmsg: "Collection not found", code: 26 }` |
| 语法/操作符错误 | `{ ok: 0, errmsg: "...", code: 2 }` |
| 认证失败 | `{ ok: 0, errmsg: "Unauthorized", code: 13 }` |

驱动侧表现为 `MongoServerError`，`err.code`/`err.errmsg` 可直接读取。

## 附录 E：SQL 语法完整参考（EBNF 风格）

> 记号约定：`*` 零或多个、`+` 一或多个、`?` 零或一、`|` 选择、`( )` 分组、`[ ]` 可选、`'...'` 字面量。

### 语句总览 Statement catalog

```
statement_list   := statement (';' statement)* ';'?

statement        := select_statement
                  | insert_statement
                  | update_statement
                  | delete_statement
                  | create_table
                  | create_index
                  | create_view
                  | create_database
                  | alter_table
                  | drop_table
                  | drop_index
                  | drop_view
                  | drop_database
                  | truncate_table
                  | transaction_statement
                  | show_statement
                  | use_statement
                  | set_statement
                  | explain_statement
                  | describe_statement
```

### SELECT

```
select_statement := [WITH cte_name AS (select_statement)]?
                    SELECT [ALL | DISTINCT] select_item (',' select_item)*
                    [FROM table_ref (',' table_ref | join_clause)*]
                    [WHERE expr]
                    [GROUP BY expr (',' expr)* [WITH ROLLUP]]
                    [HAVING expr]
                    [ORDER BY order_item (',' order_item)*]
                    [LIMIT limit_clause]
                    [RETURNING expr (',' expr)*]

select_item       := '*' | table_name '.' '*' | expr [AS alias]
table_ref         := table_name [AS alias] | (select_statement) [AS alias]
join_clause       := [INNER | LEFT | RIGHT | FULL] [OUTER] JOIN table_ref ON expr
                   | CROSS JOIN table_ref
order_item        := expr [ASC | DESC] [NULLS FIRST | NULLS LAST]
limit_clause      := count | offset ',' count | count OFFSET offset
```

### INSERT

```
insert_statement := INSERT [IGNORE] [INTO] table_name
                    [ ( column (',' column)* ) ]
                    ( VALUES value_list (',' value_list)*
                    | select_statement
                    | SET column = expr (',' column = expr)* )
                    [ON DUPLICATE KEY UPDATE column = expr (',' column = expr)*]
                    [ON CONFLICT (column (',' column)*) DO (NOTHING
                     | UPDATE SET column = expr (',' column = expr)*)]
                    [RETURNING * | expr (',' expr)*]

value_list        := '(' (expr | DEFAULT) (',' (expr | DEFAULT))* ')'
```

### UPDATE / DELETE

```
update_statement := UPDATE [ONLY]? table_name [AS alias]
                    SET column = expr (',' column = expr)*
                    [FROM table_ref (',' table_ref)*]
                    [WHERE expr]
                    [ORDER BY order_item (',' order_item)*]
                    [LIMIT count]
                    [RETURNING * | expr (',' expr)*]

delete_statement := DELETE FROM table_name [AS alias]
                    [USING table_ref (',' table_ref)*]
                    [WHERE expr]
                    [ORDER BY order_item (',' order_item)*]
                    [LIMIT count]
                    [RETURNING * | expr (',' expr)*]
```

### CREATE TABLE

```
create_table := CREATE TABLE [IF NOT EXISTS] table_name
                '(' column_def (',' column_def | table_constraint)* ')'
                [AS select_statement]

column_def        := column_name data_type
                     [NOT NULL | NULL]
                     [DEFAULT expr]
                     [PRIMARY KEY]
                     [AUTO_INCREMENT | SERIAL | BIGSERIAL]
                     [UNIQUE [KEY]]
                     [CHECK '(' expr ')']
                     [REFERENCES table_name (column)]

table_constraint  := PRIMARY KEY '(' column (',' column)* ')'
                   | UNIQUE [KEY] [name] '(' column (',' column)* ')'
                   | KEY [name] '(' column (',' column)* ')'
                   | CHECK '(' expr ')'
                   | FOREIGN KEY (column (',' column)*) REFERENCES
                     table_name (column (',' column)*)
                     [ON DELETE CASCADE | RESTRICT | SET NULL]

data_type         := INT | INTEGER | BIGINT | SMALLINT | TINYINT
                   | REAL | FLOAT | DOUBLE | DECIMAL [(p [, s])] | NUMERIC
                   | TEXT | VARCHAR [(n)] | CHAR [(n)] | STRING | CLOB
                   | BOOLEAN | BOOL
                   | DATE | DATETIME | TIMESTAMP | TIMESTAMPTZ | TIME
                   | BLOB | BYTEA | BINARY | VARBINARY
                   | JSON | JSONB
```

### ALTER TABLE

```
alter_table := ALTER TABLE [IF EXISTS] table_name
               ( ADD [COLUMN] column_def
               | ADD [CONSTRAINT name] table_constraint
               | ADD INDEX name '(' column (',' column)* ')'
               | ADD UNIQUE [INDEX] name '(' column (',' column)* ')'
               | DROP COLUMN column_name
               | DROP INDEX index_name
               | DROP PRIMARY KEY
               | DROP CONSTRAINT name
               | RENAME TO new_table_name
               | RENAME COLUMN old_name TO new_name
               | ALTER COLUMN column_name SET DEFAULT expr
               | ALTER COLUMN column_name DROP DEFAULT
               | MODIFY COLUMN column_def )
```

### 表达式

```
expr := literal
      | column_ref
      | function_call
      | unary_op expr
      | expr binary_op expr
      | expr '?' (ternary 与参数绑定由执行器区分)
      | CASE [expr] WHEN expr THEN expr [WHEN ...] [ELSE expr] END
      | CAST '(' expr AS data_type ')'
      | expr '::' data_type
      | '(' select_statement ')'           (子查询表达式)
      | EXISTS '(' select_statement ')'
      | (expr | select_statement) IN '(' (expr (',' expr)* | select_statement) ')'
      | expr [NOT] BETWEEN expr AND expr
      | expr [NOT] LIKE pattern [ESCAPE char]
      | expr [NOT] ILIKE pattern
      | expr [NOT] RLIKE pattern | expr [NOT] REGEXP pattern
      | expr [NOT] ~ pattern | expr [NOT] ~* pattern | expr !~ pattern
      | expr IS [NOT] NULL | expr IS [NOT] TRUE | expr IS [NOT] FALSE
      | expr [NOT] IN ( ... )
      | expr [NOT] ANY '(' select_statement ')'
      | expr [NOT] ALL '(' select_statement ')'
      | '(' expr ')'
```

### 字面量

```
literal      := number | string | boolean | NULL | interval | blob | identifier
number       := [+-]? digit+ | [+-]? digit* '.' digit+ | 0x hexdigits | 0b bits
string       := "'" (escaped_char | any_char)* "'"
              | '"' (escaped_char | any_char)* '"'      (标识符上下文由解析器判定)
              | "`" ... "`"                              (MySQL 反引号标识符)
boolean      := TRUE | FALSE
interval     := INTERVAL number (DAY | HOUR | MINUTE | SECOND | WEEK | MONTH | YEAR)
identifier   := [a-zA-Z_][a-zA-Z0-9_]* | 带引号标识符
```

### 事务

```
transaction_statement := BEGIN [TRANSACTION | WORK]
                       | START TRANSACTION
                       | COMMIT [TRANSACTION | WORK] [AND [NO] CHAIN]
                       | ROLLBACK [TRANSACTION | WORK] [TO [SAVEPOINT] name] [AND [NO] CHAIN]
                       | SAVEPOINT name
                       | RELEASE [SAVEPOINT] name
                       | SET TRANSACTION ISOLATION LEVEL READ COMMITTED
```

### 函数调用

```
function_call := func_name '(' [DISTINCT] args ')'      -- 普通/聚合
               | func_name '(' '*' ')'                  -- COUNT(*)
               | EXTRACT '(' part FROM expr ')'
               | DATE_ADD '(' expr ',' INTERVAL ... ')'
               | GROUP_CONCAT '(' [DISTINCT] expr (',' expr)* [ORDER BY expr] [SEPARATOR str] ')'
```

### 运算符优先级（从高到低）

```
1.  ()  .  []  ->  ->>  #>  #>>
2.  ::  CAST 一元 + - ~
3.  ^  *  /  %  DIV  MOD
4.  +  -
5.  <<  >>  &  |  ^（位）
6.  =  <>  !=  <  <=  >  >=  <=>  BETWEEN  IN  LIKE  ILIKE  RLIKE  REGEXP  ~  ~*  @>  <@  ?
7.  NOT
8.  AND
9.  OR  XOR
10. 三元（IF / CASE 解析为函数）
```

### 关键词语法表

```
保留关键字: SELECT FROM WHERE GROUP BY HAVING ORDER LIMIT OFFSET JOIN
           LEFT RIGHT FULL INNER OUTER CROSS ON USING AS AND OR NOT IN
           EXISTS BETWEEN LIKE ILIKE IS NULL TRUE FALSE CASE WHEN THEN
           ELSE END INSERT INTO VALUES UPDATE SET DELETE CREATE TABLE
           DROP ALTER ADD COLUMN PRIMARY KEY UNIQUE INDEX FOREIGN CHECK
           DEFAULT CONSTRAINT REFERENCES BEGIN COMMIT ROLLBACK SAVEPOINT
           TRANSACTION DATABASE VIEW TRUNCATE SHOW USE EXPLAIN DESCRIBE
           WITH RETURNS RETURNING DISTINCT ALL ANY SOME UNION INTERSECT
           EXCEPT CAST INTERVAL NULL AUTO_INCREMENT SERIAL
```

---

## 附录 F：Database 类完整 API 签名

### 生命周期

```
new Database(dataDirOrName?: string, options?: DatabaseOptions)
db.init(): Promise<void>
db.stop(): Promise<void>
db.reset(): void
db.destroy(): Promise<void>
db.getEngineType(): 'native' | 'wasm' | 'js'
db.getDataDir(): string | null
db.isRunning(): boolean
db.getStorageType(): 'memory' | 'disk' | 'hybrid'
```

### 数据库级操作

```
db.createDatabase(name: string): Promise<void> | void
db.dropDatabase(name: string): Promise<void> | void
db.listDatabases(): string[]
db.useDatabase(name: string): void
db.getCurrentDatabase(): string
db.attachDatabase(name: string, fileOrDir: string, alias?: string): void   -- SQLite 风格
db.detachDatabase(alias: string): void
```

### 表级操作

```
db.createTable(name, schema, options?: { ifNotExists?, temp?, strict? })
db.dropTable(name, options?: { ifExists? })
db.truncateTable(name)
db.renameTable(oldName, newName)
db.listTables(): string[]
db.getTableSchema(name): TableSchema | null
db.getTableInfo(name): TableInfo | null          -- 含行数、大小
db.tableExists(name): boolean
db.getTableStats(name): { rows, sizeBytes, indexes }
```

`TableSchema` 结构：

```
{
  name: string,
  columns: [{
    name: string, type: string,
    length?: number, precision?: number, scale?: number,
    primaryKey?: boolean, notNull?: boolean, unique?: boolean,
    autoIncrement?: boolean, default?: any, check?: string,
    references?: { table: string, column: string, onDelete?: string },
  }],
  indexes: [{ name: string, columns: string[], unique?: boolean, primary?: boolean }],
  constraints: [{ name?: string, type: string, expr?: string, columns?: string[] }],
}
```

### 数据操作（文档式）

```
db.insert(table, row: object, options?): insertedRow
db.insertMany(table, rows: object[], options?: { upsert?, transaction? })
db.find(table, filter?: object, options?: {
    sort?, limit?, skip?, fields?, includeFields?, excludeFields?,
    orderBy?, raw? })
db.findOne(table, filter?, options?)
db.count(table, filter?): number
db.distinct(table, field, filter?): any[]
db.update(table, filter, changes, options?): number
db.updateOne(table, filter, changes, options?)
db.updateMany(table, filter, changes, options?)
db.removeWhere(table, filter, options?): number
db.removeById(table, id): boolean
db.removeByIds(table, ids: any[]): number
db.getById(table, id): row | null
db.getAll(table, options?): row[]
db.getColumn(table, column): any[]
db.select(table, columns, filter?, options?)
db.max(table, column, filter?): any
db.min(table, column, filter?): any
db.avg(table, column, filter?): number
db.sum(table, column, filter?): number
```

### 聚合与管道

```
db.aggregate(table, pipeline: Array<object>, options?): row[]
db.pipeline(table, stages: Array<object>): row[]      -- 别名
db.groupBy(table, groupCols: string[], aggSpec, filter?)
db.countBy(table, groupCol: string, filter?)
```

### 事务

```
db.beginTransaction(options?): Transaction
db.commit(): void
db.rollback(): void
db.inTransaction(): boolean
db.transaction(fn: (txn) => void | Promise<void>): Promise<void>   -- 自动提交/回滚
```

### 索引

```
db.createIndex(table, columns: string[], options?: { unique?, name?, using? })
db.dropIndex(table, indexNameOrCols): boolean
db.listIndexes(table): IndexInfo[]
db.hasIndex(table, nameOrCols): boolean
db.rebuildIndexes(table): void
```

### 持久化

```
db.save(): Promise<void>                -- 立即落盘
db.flush(): Promise<void>               -- 同 save
db.saveTo(file: string): Promise<void>
db.loadFrom(file: string): Promise<void>
db.backupTo(dir: string): Promise<void>
db.restoreFrom(dir: string): Promise<void>
db.getSnapshot(): Buffer | string       -- 序列化快照
db.restoreSnapshot(data): void
db.getStats(): { tables, rows, keys?, sizeBytes, indexCount, engine }
db.getWALInfo(): { logEntries, lastFlushAt }
db.compact(): Promise<void>             -- 压缩/合并文件
```

### 查询构建器

```
db.query(table).where(f).select(cols).sort(s).skip(n).limit(n).exec()
db.raw(sql, params?)
db.prepare(sql)                          -- 预编译语句（重用）
```

### 事件

```
db.on(event: 'save'|'load'|'insert'|'update'|'delete'|'error'|'stop'|'createTable'|'dropTable', cb)
db.off(event, cb)
db.once(event, cb)
db.emit(event, ...args)
```

---

## 附录 G：端到端示例合集（Recipes）

### Recipe 1：把 JSQL-NEO 当内存 MySQL 用（CI 测试）

```js
// test-setup.js —— 让所有依赖 MySQL 的测试跑在内存引擎上
const { createMysqlServer } = require('jsql-neo');
const mysql = require('mysql2/promise');

let srv;
beforeAll(async () => {
  srv = createMysqlServer({ port: 0, noAuth: true });
  await new Promise((r) => srv.listen(r));
  const { port } = srv.address();
  global.pool = mysql.createPool({ host: '127.0.0.1', port, user: 'root' });
  // 跑在任意进程里的 seed 脚本
  await global.pool.query(`CREATE DATABASE app; USE app;
    CREATE TABLE users (id INT PRIMARY KEY AUTO_INCREMENT, name VARCHAR(50));`);
});
afterAll(async () => { await global.pool.end(); await srv.close(); });

// 测试完全不需要改动 —— 还是 mysql2 API
test('user crud', async () => {
  const [r] = await global.pool.query('INSERT INTO users (name) VALUES (?)', ['Alice']);
  expect(r.insertId).toBe(1);
  const [rows] = await global.pool.query('SELECT * FROM users');
  expect(rows).toHaveLength(1);
});
```

### Recipe 2：多协议写入/读取同一份数据

```js
const { createMultiServer } = require('jsql-neo');
const { MongoClient } = require('mongodb');
const mysql = require('mysql2/promise');
const Redis = require('ioredis');

const srv = createMultiServer({ port: 0, dataDir: './data', noAuth: true });
await new Promise((r) => srv.listen(r));
const port = srv.address().port;

// 1. MySQL 写入
const m = await mysql.createConnection({ host: '127.0.0.1', port, user: 'root' });
await m.query('CREATE DATABASE shop; USE shop; CREATE TABLE items (id INT PRIMARY KEY AUTO_INCREMENT, name TEXT, price REAL);');
await m.query("INSERT INTO items (name, price) VALUES ('apple', 1.5), ('banana', 2.0)");

// 2. MongoDB 读取（同一张表当集合）
const mc = new MongoClient(`mongodb://127.0.0.1:${port}/shop`);
await mc.connect();
const items = mc.db('shop').collection('items');
const all = await items.find({ price: { $gt: 1.0 } }).toArray();
// → [{ id: 1, name: 'apple', price: 1.5 }, { id: 2, name: 'banana', price: 2 }]

// 3. Redis 缓存同一库的 key
const r = new Redis({ port, host: '127.0.0.1' });
await r.set('shop:item_count', 2);

await m.end(); await mc.close(); await r.quit(); await srv.close();
```

### Recipe 3：浏览器端共享同一套查询逻辑

```js
// shared/query.js —— 同时运行在 Node 与浏览器
export async function fetchStats(db) {
  const t = await db.query('orders')
    .where({ status: 'paid' })
    .sort({ amount: -1 })
    .limit(20)
    .exec();
  return t;
}

// Node：native 引擎
import { JSQL } from 'jsql-neo';
const db = new JSQL();
await db.start();

// 浏览器：WASM 引擎（同一 import 路径）
import { JSQL } from 'jsql-neo/dist/wasm.js';
const db = new JSQL();
await db.start();
```

### Recipe 4：定时快照备份

```js
const { Database } = require('jsql-neo');
const cron = require('node-cron'); // 或任何调度器

const db = new Database('./data/app');
await db.init();

cron.schedule('0 3 * * *', async () => {
  const stamp = new Date().toISOString().slice(0, 10);
  await db.backupTo(`./backups/app-${stamp}`);
  const stats = await db.getStats();
  console.log(`backup done: ${stats.tables} tables, ${stats.rows} rows`);
});
```

### Recipe 5：Sequelize + jsql 服务器（零配置切换）

```js
const { Sequelize } = require('sequelize');
const sequelize = new Sequelize('app', 'root', '', {
  host: '127.0.0.1',
  port: 5432,                    // JSQL 多协议端口
  dialect: 'mysql',              // 协议选择 MySQL
  logging: false,
});

const User = sequelize.define('User', {
  name: Sequelize.STRING,
  age: Sequelize.INTEGER,
});

await sequelize.sync();
await User.create({ name: 'Alice', age: 30 });
const users = await User.findAll({ where: { age: { [Op.gt]: 18 } } });
```

### Recipe 6：TypeORM + pg 方言

```ts
import { DataSource } from 'typeorm';

const ds = new DataSource({
  type: 'postgres',
  host: '127.0.0.1',
  port: 5432,
  username: 'root',
  database: 'app',
  entities: [User],
  synchronize: true,
});
await ds.initialize();
const users = await ds.getRepository(User).find({ where: { age: MoreThan(18) } });
```

### Recipe 7：mongosh 批处理脚本

```bash
# load.js —— 与 mongosh 完全一致的脚本接口
const coll = db.collection('logs');
coll.insertMany(Array.from({ length: 100 }, (_, i) => ({
  level: i % 3 === 0 ? 'error' : 'info',
  msg: `log ${i}`,
  ts: new Date(Date.now() + i * 1000),
})));
print('count =', coll.countDocuments({ level: 'error' }));

# 执行
mongosh mongodb://127.0.0.1:5432/app --quiet load.js
```

### Recipe 8：迁移 MySQL → JSQL 服务器

```bash
# 1. 从真实 MySQL 导出
mysqldump -u root -p --databases app > app.sql

# 2. 导入 JSQL（自动跳过 mysqldump 辅助语句）
jsql import ./data app.sql

# 3. 验证
jsql tui --data-dir ./data
jsql> USE app;
jsql> SHOW TABLES;
jsql> SELECT COUNT(*) FROM users;
```

### Recipe 9：Redis 缓存 + MySQL 直读（同进程双协议）

```js
const { createMultiServer } = require('jsql-neo');
const Redis = require('ioredis');

const srv = createMultiServer({ port: 5432, dataDir: './data', noAuth: true });
await new Promise((r) => srv.listen(r));

const redis = new Redis({ port: 5432 });

async function getProduct(id) {
  const cached = await redis.get(`product:${id}`);
  if (cached) return JSON.parse(cached);
  // 缓存未命中 → SQL 查库（同一端口，走 MySQL 协议）
  const [rows] = await mysqlPool.query('SELECT * FROM products WHERE id = ?', [id]);
  const row = rows[0] || null;
  if (row) await redis.set(`product:${id}`, JSON.stringify(row), 'EX', 60);
  return row;
}
```

### Recipe 10：程序化批量导入

```js
const { Database, splitStatements, executeSQL } = require('jsql-neo');
const db = new Database(':memory:');

const dump = fs.readFileSync('./dump.sql', 'utf8');
let n = 0;
for (const stmt of splitStatements(dump)) {
  await executeSQL(db, stmt);
  if (++n % 500 === 0) console.log(`导入 ${n} 条语句`);
}
console.log('done');
```

## 附录 H：函数详解与执行语义

> 每条函数给出签名、语义、示例与执行说明。所有示例可在 `jsql tui` 或 `executeSQL` 中直接运行。

### H.1 字符串函数

#### CONCAT

```
CONCAT(str1, str2, ...) → string
```

- 参数中任一为 NULL 时按空串处理（与 MySQL 一致）
- 无参数返回 `''`
- 自动将数值转字符串

```sql
SELECT CONCAT('a', 'b', 'c');        -- 'abc'
SELECT CONCAT('val=', 42);           -- 'val=42'
SELECT CONCAT(NULL, 'x');            -- 'x'
SELECT CONCAT();                     -- ''
SELECT CONCAT('  ', TRIM(' hi '));   -- '  hi'
```

#### LOWER / UPPER

```
LOWER(s) → string       -- 转小写
UPPER(s) → string       -- 转大写
```

- 仅 ASCII 字母受影响；中文等非字母字符原样返回
- `LCASE` / `UCASE` 为别名（MySQL）

```sql
SELECT LOWER('Hello WORLD');   -- 'hello world'
SELECT UPPER('hello 世界');    -- 'HELLO 世界'
```

#### LENGTH / CHAR_LENGTH / OCTET_LENGTH

```
LENGTH(s)          → number   -- 字符数（Unicode 码点）
CHAR_LENGTH(s)     → number   -- 同 LENGTH
OCTET_LENGTH(s)    → number   -- UTF-8 字节数
```

```sql
SELECT LENGTH('hello');            -- 5
SELECT LENGTH('你好');             -- 2
SELECT OCTET_LENGTH('你好');       -- 6
SELECT CHAR_LENGTH('a中b');        -- 3
```

> 注意：MySQL 的 `LENGTH` 返回字节数，本引擎按字符数返回；如需字节数用 `OCTET_LENGTH`。

#### SUBSTRING / SUBSTR / MID

```
SUBSTRING(s, start[, len]) → string
SUBSTR(s, start[, len])    → string
MID(s, start[, len])       → string
```

- `start` 从 1 开始；负数从末尾倒数
- `len` 省略时取到末尾
- MySQL 兼容：`SUBSTRING(s FROM start FOR len)` 与 `SUBSTRING(s FROM start)` 语法

```sql
SELECT SUBSTRING('hello world', 7);        -- 'world'
SELECT SUBSTRING('hello world', 1, 5);     -- 'hello'
SELECT SUBSTRING('hello', -3);             -- 'llo'
SELECT SUBSTRING('abcdef', 2, 3);          -- 'bcd'
SELECT SUBSTR('abcdef' FROM 2 FOR 3);      -- 'bcd'
```

#### LEFT / RIGHT

```
LEFT(s, n)  → string   -- 取前 n 个字符
RIGHT(s, n) → string   -- 取后 n 个字符
```

```sql
SELECT LEFT('hello', 2);    -- 'he'
SELECT RIGHT('hello', 2);   -- 'lo'
SELECT LEFT('hello', 0);    -- ''
SELECT LEFT('hello', 99);   -- 'hello'（超长返回全文）
```

#### TRIM / LTRIM / RTRIM

```
TRIM([chars FROM] s) → string
LTRIM(s)             → string   -- 去除前导
RTRIM(s)             → string   -- 去除尾部
```

- 默认去除空格；可指定去除字符集
- 支持 `TRIM(BOTH | LEADING | TRAILING chars FROM s)` 全语法

```sql
SELECT TRIM('  hi  ');               -- 'hi'
SELECT TRIM('x' FROM 'xxhixx');      -- 'hi'
SELECT TRIM(LEADING 'x' FROM 'xxhi');-- 'hi'
SELECT LTRIM('  hi  ');              -- 'hi  '
SELECT RTRIM('  hi  ');              -- '  hi'
```

#### REPLACE

```
REPLACE(s, from, to) → string   -- 替换全部出现
```

```sql
SELECT REPLACE('a-b-c-d', '-', '+');    -- 'a+b+c+d'
SELECT REPLACE('banana', 'na', 'no');   -- 'banoano'
SELECT REPLACE('abc', 'x', 'y');        -- 'abc'
SELECT REPLACE('abc', '', 'X');         -- 'abc'（空串不替换）
```

#### REVERSE / REPEAT / SPACE

```
REVERSE(s) → string
REPEAT(s, n) → string
SPACE(n) → string
```

```sql
SELECT REVERSE('abc');        -- 'cba'
SELECT REPEAT('ab', 3);       -- 'ababab'
SELECT SPACE(3);              -- '   '
SELECT REPEAT('x', 0);        -- ''
```

#### ASCII / CHAR / ORD

```
ASCII(s) → number   -- 首字符码点
CHAR(n [, n ...]) → string  -- 码点转字符
ORD(s) → number     -- 首字符 Unicode 码点
```

```sql
SELECT ASCII('A');          -- 65
SELECT CHAR(65, 66, 67);    -- 'ABC'
SELECT ORD('中');           -- 20013
```

#### GROUP_CONCAT

```
GROUP_CONCAT(expr [, SEPARATOR sep] | [ORDER BY ...]) → string
```

- 分组内拼接；`DISTINCT` 去重；`ORDER BY` 排序后拼接
- 默认分隔符 `,`
- 组内 NULL 跳过

```sql
SELECT dept, GROUP_CONCAT(name) FROM emp GROUP BY dept;
-- sales: 'Alice,Bob,Carol'
SELECT GROUP_CONCAT(name ORDER BY age DESC) FROM users;
SELECT GROUP_CONCAT(DISTINCT city) FROM users;
SELECT GROUP_CONCAT(name SEPARATOR '|') FROM users;
```

#### LPAD / RPAD

```
LPAD(s, len, pad) → string   -- 左侧填充至 len
RPAD(s, len, pad) → string   -- 右侧填充至 len
```

```sql
SELECT LPAD('7', 4, '0');    -- '0007'
SELECT RPAD('ab', 5, '-');   -- 'ab---'
SELECT LPAD('hello', 3, 'x');-- 'hel'（超长截断）
```

### H.2 数值函数

#### ABS / SIGN

```
ABS(x) → number
SIGN(x) → -1 | 0 | 1
```

```sql
SELECT ABS(-5);      -- 5
SELECT ABS(3.5);     -- 3.5
SELECT SIGN(-3);     -- -1
SELECT SIGN(0);      -- 0
SELECT SIGN(9);      -- 1
```

#### ROUND / CEIL / FLOOR / TRUNCATE

```
ROUND(x[, n]) → number       -- 四舍五入到 n 位小数
CEIL(x) / CEILING(x) → number
FLOOR(x) → number
TRUNCATE(x, n) → number      -- 直接截断
```

```sql
SELECT ROUND(3.14159, 2);    -- 3.14
SELECT ROUND(3.5);           -- 4
SELECT ROUND(3.14159);       -- 3
SELECT ROUND(-3.5);          -- -4（远离零舍入，与 MySQL 一致）
SELECT CEIL(3.2);            -- 4
SELECT FLOOR(3.8);           -- 3
SELECT TRUNCATE(3.14159, 2); -- 3.14
SELECT TRUNCATE(12345, -2);  -- 12300
```

#### POWER / SQRT / EXP / LN / LOG

```
POWER(x, y) / POW(x, y) → number
SQRT(x) → number
EXP(x) → number          -- e^x
LN(x) → number           -- 自然对数
LOG10(x) / LOG(x) → number
LOG(b, x) → number       -- 以 b 为底
```

```sql
SELECT POWER(2, 10);     -- 1024
SELECT SQRT(16);         -- 4
SELECT EXP(1);           -- 2.718281828459045
SELECT LN(EXP(2));       -- 2
SELECT LOG10(1000);      -- 3
SELECT LOG(2, 8);        -- 3
```

#### MOD / RAND

```
MOD(x, y) / x % y → number
RAND() / RANDOM() → number   -- [0, 1) 随机
RAND(seed) → number          -- 确定性种子
```

```sql
SELECT MOD(10, 3);      -- 1
SELECT 10 % 3;          -- 1
SELECT RAND();          -- 0.123456789（每次不同）
SELECT RAND(42);        -- 固定种子，结果确定
```

#### GREATEST / LEAST

```
GREATEST(a, b, ...) → any    -- 最大值（NULL 忽略；全 NULL 返回 NULL）
LEAST(a, b, ...) → any
```

```sql
SELECT GREATEST(1, 5, 3);        -- 5
SELECT LEAST('a', 'b', 'c');     -- 'a'
SELECT GREATEST(1, NULL, 3);     -- 3
SELECT GREATEST('2026-01-01', '2025-12-31');  -- '2026-01-01'（字典序）
```

#### 进制与位函数

```sql
SELECT HEX(255);            -- 'FF'
SELECT UNHEX('FF');         -- 255
SELECT BIN(5);              -- '101'
SELECT BIT_COUNT(15);       -- 4
SELECT 1 << 8;              -- 256
SELECT 255 & 15;            -- 15
SELECT ~0;                  -- -1
```

### H.3 日期时间函数

#### NOW / CURRENT_TIMESTAMP / CURRENT_DATE / CURRENT_TIME

```
NOW() → 'YYYY-MM-DD HH:MM:SS'（UTC 时间）
CURRENT_TIMESTAMP → 同 NOW
CURRENT_DATE / CURDATE() → 'YYYY-MM-DD'
CURRENT_TIME / CURTIME() → 'HH:MM:SS'
```

```sql
SELECT NOW();                 -- '2026-08-12 10:30:45'
SELECT CURRENT_TIMESTAMP;     -- '2026-08-12 10:30:45'
SELECT CURRENT_DATE;          -- '2026-08-12'
SELECT CURRENT_TIME;          -- '10:30:45'
SELECT NOW(3);                -- 毫秒精度（参数 0-6 支持）
```

#### YEAR / MONTH / DAY / HOUR / MINUTE / SECOND

```
YEAR(d) → number
MONTH(d) → number (1-12)
DAY(d) / DAYOFMONTH(d) → number
HOUR(t) → number (0-23)
MINUTE(t) → number
SECOND(t) → number
```

```sql
SELECT YEAR('2026-08-12');       -- 2026
SELECT MONTH('2026-08-12');      -- 8
SELECT DAY('2026-08-12');        -- 12
SELECT HOUR('10:30:45');         -- 10
SELECT MINUTE('10:30:45');       -- 30
SELECT SECOND('10:30:45');       -- 45
```

#### DATE / TIME 提取

```
DATE(expr) → 'YYYY-MM-DD'      -- 取日期部分
TIME(expr) → 'HH:MM:SS'        -- 取时间部分
DAYOFWEEK(d) → 1-7 (周日=1)
DAYNAME(d) → 'Sunday'...      -- 英文星期名
MONTHNAME(d) → 'August'...
```

```sql
SELECT DATE(NOW());              -- '2026-08-12'
SELECT TIME(NOW());              -- '10:30:45'
SELECT DAYOFWEEK('2026-08-12');  -- 4（周三）
SELECT DAYNAME('2026-08-12');    -- 'Wednesday'
```

#### DATE_ADD / DATE_SUB / ADDDATE / SUBDATE

```
DATE_ADD(d, INTERVAL n unit) → datetime
DATE_SUB(d, INTERVAL n unit) → datetime
ADDDATE(d, INTERVAL n unit) → datetime
SUBDATE(d, INTERVAL n unit) → datetime
```

单位：`MICROSECOND SECOND MINUTE HOUR DAY WEEK MONTH QUARTER YEAR`（可复数）。

```sql
SELECT DATE_ADD('2026-08-12', INTERVAL 1 DAY);      -- '2026-08-13 00:00:00'
SELECT DATE_ADD(NOW(), INTERVAL 2 HOUR);
SELECT DATE_SUB('2026-08-12', INTERVAL 1 WEEK);     -- '2026-08-05 00:00:00'
SELECT DATE_ADD('2026-08-12', INTERVAL 3 MONTH);    -- '2026-11-12 00:00:00'
SELECT DATE_ADD('2026-08-12 10:00:00', INTERVAL -90 MINUTE);  -- '2026-08-12 08:30:00'
```

#### DATEDIFF / TIMESTAMPDIFF

```
DATEDIFF(d1, d2) → number      -- d1 - d2 的天数
TIMESTAMPDIFF(unit, d2, d1) → number  -- 按单位差值
```

```sql
SELECT DATEDIFF('2026-08-12', '2026-08-01');      -- 11
SELECT DATEDIFF('2026-08-01', '2026-08-12');      -- -11
SELECT TIMESTAMPDIFF(HOUR, '2026-08-12 08:00:00', '2026-08-12 10:30:00');  -- 2
SELECT TIMESTAMPDIFF(DAY, '2026-01-01', '2026-08-12');                     -- 223
```

#### DATE_FORMAT / STR_TO_DATE / TO_CHAR / TO_DATE

格式符：`%Y` 年4位、`%y` 年2位、`%m` 月、`%d` 日、`%H` 时24、`%h` 时12、`%i` 分、
`%s` 秒、`%p` AM/PM、`%W` 星期名、`%b` 月缩写、`%%` 字面 %。

```sql
SELECT DATE_FORMAT('2026-08-12 10:30:45', '%Y-%m-%d');          -- '2026-08-12'
SELECT DATE_FORMAT(NOW(), '%W, %M %d %Y');                      -- 'Wednesday, August 12 2026'
SELECT DATE_FORMAT('2026-08-12 10:30:45', '%h:%i %p');          -- '10:30 AM'
SELECT STR_TO_DATE('12/08/2026', '%d/%m/%Y');                   -- '2026-08-12'
SELECT TO_CHAR('2026-08-12', 'YYYY-MM-DD');                     -- PG 风格
SELECT TO_DATE('2026-08-12', 'YYYY-MM-DD');
```

#### EXTRACT / DATE_PART / AGE

```sql
SELECT EXTRACT(YEAR FROM '2026-08-12');          -- 2026
SELECT EXTRACT(DOW FROM '2026-08-12');           -- 3（PG 语义：周一到周日 0-6）
SELECT DATE_PART('year', '2026-08-12');          -- 2026（PG 语义）
SELECT DATE_PART('hour', '2026-08-12 10:30:45'); -- 10
SELECT AGE('2026-08-12', '2020-01-01');          -- '6 years 7 mons 11 days'
```

`EXTRACT` 支持部分：`YEAR MONTH DAY HOUR MINUTE SECOND DOW DOY WEEK QUARTER EPOCH`。

#### UNIX_TIMESTAMP / FROM_UNIXTIME

```sql
SELECT UNIX_TIMESTAMP();                    -- 1780000000（秒）
SELECT UNIX_TIMESTAMP('2026-08-12 00:00:00'); -- 对应秒数
SELECT FROM_UNIXTIME(1780000000);           -- '2026-05-28 13:46:40'
SELECT FROM_UNIXTIME(1780000000, '%Y-%m-%d');-- 按格式返回
```

### H.4 条件与空值函数

#### IF / IIF

```
IF(cond, then_val, else_val) → any
IIF(cond, then_val, else_val) → any   -- SQLite 风格别名
```

- 条件求值为真返回 then，否则返回 else
- 支持嵌套与子查询

```sql
SELECT IF(1 > 0, 'yes', 'no');               -- 'yes'
SELECT IF(age >= 18, 'adult', 'minor') FROM users;
SELECT IF(NULL, 'a', 'b');                   -- 'b'（NULL 视为假）
SELECT SUM(IF(status = 'paid', amount, 0)) FROM orders;
```

#### IFNULL / COALESCE / NULLIF / ISNULL

```
IFNULL(a, b) → any          -- a 非空返回 a，否则 b
COALESCE(a, b, ...) → any   -- 第一个非空
NULLIF(a, b) → any          -- a = b 返回 NULL，否则 a
ISNULL(x) → 1 | 0           -- 是否为 NULL
```

```sql
SELECT IFNULL(NULL, 'default');       -- 'default'
SELECT COALESCE(NULL, NULL, 3);       -- 3
SELECT COALESCE(a, b, c) FROM t;      -- 首个非空列
SELECT NULLIF(5, 5);                  -- NULL
SELECT NULLIF(5, 6);                  -- 5
SELECT ISNULL(NULL);                  -- 1
```

#### CASE 表达式

```sql
-- 搜索式
SELECT CASE
         WHEN score >= 90 THEN 'A'
         WHEN score >= 80 THEN 'B'
         ELSE 'C'
       END AS grade FROM exam;

-- 简单式
SELECT CASE status
         WHEN 1 THEN 'active'
         WHEN 0 THEN 'disabled'
         ELSE 'unknown'
       END FROM users;

-- CASE 内嵌聚合（MySQL 风格条件聚合）
SELECT SUM(CASE WHEN status = 'paid' THEN amount ELSE 0 END) AS paid_total
FROM orders;
```

### H.5 系统与杂项函数

#### 会话信息

```sql
SELECT VERSION();                  -- '8.0.0-jsql-neo'
SELECT DATABASE();                 -- 'app'
SELECT USER();                     -- 'root@localhost'
SELECT CURRENT_USER;               -- 'root@localhost'
SELECT LAST_INSERT_ID();           -- 最近自增 ID（本会话）
SELECT ROW_COUNT();                -- 最近 DML 影响行数
```

#### JSON 函数

```
JSON_EXTRACT(doc, path) → any      -- $.a.b 路径
JSON_UNQUOTE(x) → string           -- 去 JSON 引号
JSON_OBJECT(k, v, ...) → json      -- 构造
JSON_ARRAY(v, ...) → json          -- 构造数组
JSON_CONTAINS(doc, val[, path]) → 0|1
JSON_SET / JSON_INSERT / JSON_REPLACE / JSON_REMOVE → json
JSON_KEYS(doc) → array
JSON_LENGTH(doc) → number
JSON_TYPE(x) → string
```

```sql
SELECT JSON_EXTRACT('{"a":{"b":5}}', '$.a.b');        -- 5
SELECT JSON_UNQUOTE(JSON_EXTRACT('{"a":"x"}', '$.a'));-- 'x'
SELECT JSON_OBJECT('name', 'Alice', 'age', 30);
-- {"name":"Alice","age":30}
SELECT JSON_SET('{"a":1}', '$.b', 2);                 -- {"a":1,"b":2}
SELECT meta->>'name' FROM users WHERE meta->'age' > 18;
```

#### UUID / 类型探测

```sql
SELECT UUID();                       -- '550e8400-e29b-41d4-a716-446655440000'
SELECT TYPEOF(1);                    -- 'number'
SELECT TYPEOF('a');                  -- 'string'
SELECT TYPEOF(NULL);                 -- 'null'
SELECT TYPEOF(TRUE);                 -- 'boolean'
```

#### 类型转换 CAST / CONVERT

```sql
SELECT CAST('42' AS INT);                  -- 42
SELECT CAST('42.5' AS REAL);               -- 42.5
SELECT CAST(42 AS TEXT);                   -- '42'
SELECT CAST('2026-08-12' AS DATE);         -- '2026-08-12'
SELECT CAST('true' AS BOOLEAN);            -- true
SELECT CAST('{"a":1}' AS JSON);            -- 解析为 JSON
SELECT CONVERT('42', SIGNED);              -- MySQL 风格 → 42
SELECT '5'::INT;                           -- PG 风格 → 5
SELECT 'abc'::INT;                         -- 错误：无法转换（非静默）
```

### H.6 聚合函数执行语义

#### COUNT

```
COUNT(*)              → 全行数（含 NULL）
COUNT(col)            → 非 NULL 行数
COUNT(DISTINCT col)   → 去重非 NULL 行数
COUNT(DISTINCT a, b)  → 组合去重
```

```sql
SELECT COUNT(*) FROM users;                      -- 总行数
SELECT COUNT(age) FROM users;                    -- age 非空行数
SELECT COUNT(DISTINCT city) FROM users;          -- 城市去重数
SELECT COUNT(DISTINCT dept, city) FROM emp;      -- 组合去重
```

#### SUM / AVG / MIN / MAX

```sql
SELECT SUM(amount) FROM orders;                   -- 总和（NULL 忽略）
SELECT AVG(salary) FROM emp WHERE dept = 'eng';   -- 平均
SELECT MIN(price), MAX(price) FROM products;      -- 极值
SELECT SUM(DISTINCT v) FROM t;                    -- 去重求和
SELECT MIN(name) FROM users;                      -- 字符串字典序最小
```

#### STDDEV / VARIANCE

```
STDDEV(x) / STDDEV_POP(x) → number   -- 总体标准差
STDDEV_SAMP(x) → number              -- 样本标准差
VARIANCE(x) / VAR_POP(x) → number    -- 总体方差
VAR_SAMP(x) → number                 -- 样本方差
```

```sql
SELECT STDDEV(score), VARIANCE(score) FROM exam;
SELECT STDDEV_SAMP(score) FROM exam;   -- 样本（n-1）
```

#### FIRST / LAST

```sql
SELECT FIRST(name), LAST(name) FROM (SELECT name FROM users ORDER BY age);
-- 与 ORDER BY 配合取首/末值
```

#### GROUP BY 高级用法

```sql
-- 多列分组
SELECT dept, city, COUNT(*) FROM emp GROUP BY dept, city;

-- WITH ROLLUP（总计行）
SELECT dept, COUNT(*) AS cnt FROM emp GROUP BY dept WITH ROLLUP;
-- sales  3
-- eng    5
-- NULL   8   ← 总计行（dept 为 NULL）

-- HAVING 过滤分组
SELECT dept, AVG(salary) AS avg_sal
FROM emp GROUP BY dept HAVING avg_sal > 5000;

-- 分组内排序拼接
SELECT dept, GROUP_CONCAT(name ORDER BY age) FROM emp GROUP BY dept;
```

## 附录 I：CLI 完整选项参考

### jsql serve（MySQL 单协议）

```
Usage: jsql serve [options]

启动 MySQL 兼容服务器

Options:
  -p, --port <n>          端口（默认 3306）
      --host <host>       监听地址（默认 127.0.0.1）
      --data-dir <dir>    数据目录（省略 → 纯内存）
      --memory            纯内存模式（等价省略 data-dir）
      --user <user>       认证用户名（默认 root）
      --password <pass>   认证密码（默认空）
      --no-auth           跳过认证
      --tls               启用 TLS（需 --cert/--key）
      --cert <file>       TLS 证书路径（PEM）
      --key <file>        TLS 私钥路径（PEM）
      --save-interval <ms> 自动保存间隔（默认 3000）
      --verbose           详细日志
  -q, --quiet             静默模式（只输出错误）
  -h, --help              显示帮助
```

### jsql serve --pg（多协议）

```
Usage: jsql serve [options] --pg

启动多协议服务器（MySQL + PostgreSQL + MongoDB + Redis 同一端口）

Options:（同 serve 之外，另有）
      --pg                启用多协议模式
      --db <name>         默认数据库名（可选）
```

### jsql redis

```
Usage: jsql redis [options]

启动 Redis 兼容服务器

Options:
  -p, --port <n>          端口（默认 6379）
      --host <host>       监听地址（默认 127.0.0.1）
      --data-dir <dir>    数据目录（省略 → 纯内存 Redis）
      --memory            纯内存
      --password <pass>   认证密码（空 = 免认证）
      --user <user>       用户名（默认 default）
      --snapshot-interval <ms>  快照间隔（默认 5000）
      --max-keys <n>      最大 key 数（可选，防滥用）
      --verbose           详细日志
  -q, --quiet             静默模式
```

### jsql ui

```
Usage: jsql ui [options]

启动 Web 管理台 + HTTP API

Options:
  -p, --port <n>          端口（默认 8080）
      --host <host>       监听地址（默认 127.0.0.1）
      --data-dir <dir>    数据目录
      --db <name>         初始数据库
      --no-auth           跳过认证
      --password <pass>   管理密码（可选）
      --readonly          只读模式（禁用写操作）
```

### jsql export

```
Usage: jsql export <dataDir> [options]

导出数据

Arguments:
  dataDir                 数据目录（必填）

Options:
      --format <fmt>      json | csv | sql（默认 json）
      --table <t>         只导出指定表
      --output <file>     输出文件（默认 stdout）
      --pretty            JSON 美化（缩进 2）
      --compress          输出压缩（json 格式有效）
      --no-rows           只导出 schema（跳过数据）
```

### jsql import

```
Usage: jsql import <dataDir> <file> [options]

导入数据（自动识别格式：sql / json / csv）

Arguments:
  dataDir                 目标数据目录（必填）
  file                    导入文件（必填；- 表示 stdin）

Options:
      --table <t>         指定目标表（csv 必填；sql/json 可选）
      --has-header        首行为表头（csv）
      --delimiter <c>     csv 分隔符（默认 ,）
      --no-create         跳过建表（数据追加到已有表）
      --force             覆盖已有表（默认跳过冲突表）
      --on-error <mode>   abort | skip（默认 abort）
```

### jsql bench

```
Usage: jsql bench [options]

基准测试

Options:
      --ops <n>           操作数（默认 10000）
      --concurrency <n>   并发连接数（默认 4）
      --mode <mode>       memory | disk | mixed（默认 memory）
      --engine <e>        native | wasm | js（默认 native）
      --table <t>         测试表名（默认 bench_t）
      --rows <n>          预热数据行数（默认 1000）
      --json              输出 JSON 结果
      --only <op>         insert | select | update | delete | mixed（默认全部）
```

### jsql mod

```
Usage: jsql mod [options]

查看/切换引擎模块

Options:
      --engine <e>       native | wasm | js（切换后重启生效）
      --list             仅列出可用模块
      --reset            恢复自动选择
```

### jsql tui

```
Usage: jsql tui [options]

交互式 SQL 终端

Options:
      --data-dir <dir>    数据目录（省略 → 内存）
      --memory            内存模式
      --db <name>         初始数据库
      --dialect <d>       mysql | pg | sqlite | auto（默认 auto）
      --no-color          禁用 ANSI 颜色
      --prompt <s>        自定义提示符（默认 'jsql> '）
      --history <file>    历史文件（默认 ~/.jsql-history）
      --max-history <n>   历史条数上限（默认 500）
  -q, --quiet             静默（批处理时仅输出数据）
```

### jsql version

```
Usage: jsql version

输出版本与环境信息：

  jsql-neo v5.3.1
  engine: native (napi) | wasm | js
  node: v22.0.0
  platform: linux x64
  data dir: /root/.jsql-neo/data
```

---

## 附录 J：部署指南 Deployment Guide

### systemd 服务

```ini
# /etc/systemd/system/jsql.service
[Unit]
Description=JSQL-NEO multiprotocol database server
After=network.target

[Service]
Type=simple
User=jsql
Group=jsql
WorkingDirectory=/var/lib/jsql
ExecStart=/usr/bin/node /usr/lib/node_modules/jsql-neo/bin/jsql serve --pg \
          -p 5432 --data-dir /var/lib/jsql/data \
          --user admin --password ${JSQL_PASSWORD}
Environment=JSQL_PASSWORD=change-me
Restart=on-failure
RestartSec=3
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now jsql
journalctl -u jsql -f
```

### Docker

```dockerfile
# Dockerfile
FROM node:22-slim
RUN npm install -g jsql-neo
EXPOSE 5432
VOLUME ["/data"]
ENTRYPOINT ["jsql", "serve", "--pg", "-p", "5432", "--data-dir", "/data", "--no-auth"]
```

```bash
docker build -t jsql .
docker run -d --name jsql \
  -p 5432:5432 \
  -v jsql-data:/data \
  jsql

# 客户端连接（宿主机同一端口）
psql -h 127.0.0.1 -p 5432 -U root -d app
```

### PM2

```bash
npm install -g pm2
pm2 start jsql --name jsql -- serve --pg -p 5432 --data-dir ./data --no-auth
pm2 save && pm2 startup
```

### 高可用与备份

| 场景 | 方案 |
|---|---|
| 单机部署 | systemd/Docker + 数据卷 |
| 备份 | `jsql export`（SQL/JSON）+ `db.backupTo()` 定时任务 |
| 多实例 | 每实例独立 dataDir + 独立端口；应用层分片 |
| 监控 | HTTP API `/api/status` + 健康检查（`PING`） |
| 日志 | `--verbose` 输出到 stdout，由 systemd/journald 收集 |

### 健康检查

```bash
# 任一协议均可
redis-cli -p 5432 PING                 # PONG
mysql -h 127.0.0.1 -P 5432 -e "SELECT 1"
psql -h 127.0.0.1 -p 5432 -U root -c "SELECT 1"
mongosh mongodb://127.0.0.1:5432 --eval "db.runCommand({ping:1})"
curl -s http://127.0.0.1:8080/api/status
```

---

## 附录 K：环境变量与运行时配置

### 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `JSQL_DATA_DIR` | `~/.jsql-neo/data` | 默认数据目录 |
| `JSQL_LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error` |
| `JSQL_ENGINE` | 自动 | 强制引擎（native/wasm/js） |
| `JSQL_NO_COLOR` | — | 禁用 TUI/CLI 颜色 |
| `JSQL_HISTORY` | `~/.jsql-history` | TUI 历史文件 |
| `JSQL_PORT` | 见各命令 | 默认端口覆盖 |
| `NODE_OPTIONS` | — | Node 标准（如 `--max-old-space-size`） |

### 数据目录结构

```
~/.jsql-neo/data/
├── jsql.json              # 元数据（版本、默认库）
├── <db>/                  # 每个数据库一个目录
│   ├── schema.json        # 表结构定义
│   ├── data.jsql          # 数据快照（压缩可选）
│   └── tlog                # 事务日志（WAL）
└── redis.rdb              # Redis 命名空间快照（服务器模式）
```

### 日志

```js
// 编程式配置
const db = new Database('./data', { logLevel: 'debug' });
```

| 级别 | 输出内容 |
|---|---|
| `debug` | 每条 SQL、协议帧摘要、索引命中 |
| `info` | 启动/停止、连接建立、快照保存 |
| `warn` | 回退、截断、降级 |
| `error` | 错误堆栈 |

---

## 附录 L：WASM 与浏览器深入

### 浏览器 API 全览

```js
import { JSQL } from 'jsql-neo/dist/wasm.js';

const db = new JSQL({
  database: 'app',
  wasmPath: '/jsql.wasm',          // 可选：自定义 wasm 加载路径
  memory: { max: 256 * 1024 * 1024 },  // 可选：内存上限
});

await db.start();
await db.createTable('t', { a: { type: 'int' } });
await db.insert('t', { a: 1 });
const rows = await db.find('t', {});
await db.executeSQL('SELECT * FROM t');
await db.exportJSON();             // 导出 JSON 备份
await db.importJSON(json);
await db.stop();
```

### WASM 与 Native 差异

| 能力 | Native | WASM |
|---|---|---|
| 引擎 | Rust N-API | Rust → wasm32 |
| 性能 | 100% | ~80% |
| TCP 服务器 | ✅ | ❌（无网络 API） |
| 文件持久化 | ✅ 直接 | ✅（需提供 fs shim，浏览器用 IndexedDB） |
| 多线程 | ✅ | 单线程 |
| 支持环境 | Node.js | Node.js + 浏览器 |

### 浏览器持久化（IndexedDB shim）

```js
// browser-persist.js —— 用 IndexedDB 模拟文件系统
const idb = await indexedDB.open('jsql-db', 1);
const store = idb.transaction('files', 'readwrite').objectStore('files');
// 把快照字节存为 blob
const snap = await db.getSnapshot();
await store.put(snap, 'snapshot');
```

### Vite / Webpack 集成

```js
// vite.config.js
import { defineConfig } from 'vite';
export default defineConfig({
  optimizeDeps: { exclude: ['jsql-neo'] },
  server: { headers: { 'Cross-Origin-Opener-Policy': 'same-origin',
                        'Cross-Origin-Embedder-Policy': 'require-corp' } },
});
```

---

## 附录 M：TUI 程序化接口

`lib/tui.js` 导出可复用的 TUI 组件，可在你自己的 CLI 工具中直接使用：

### createTUI / TUIShell

```js
const { TUIShell, createTUI } = require('jsql-neo');

const shell = new TUIShell({
  prompt: 'mydb> ',
  historyFile: './.my-history',
  completer: (line) => ['SELECT', 'INSERT', 'UPDATE'].filter((k) => k.startsWith(line)),
  onExecute: async (sql) => {
    // 你的执行器；返回 { columns, rows } 或抛错
  },
  onMeta: (cmd, args) => { /* 元命令处理 */ },
});
shell.start();          // 进入 raw mode 循环
shell.stop();           // 恢复终端、退出
```

### renderTable（供任何 Node 程序使用）

```js
const { renderTable, wswidth, pad } = require('jsql-neo');

const out = renderTable(
  { columns: ['name', '年龄', 'score'],
    rows: [['Alice', 30, 95.5], ['张三', 25, 88.0]] },
  { maxWidth: 40 }
);
console.log(out);
// ┌───────┬──────┬───────┐
// │ name  │ 年龄 │ score │
// ├───────┼──────┼───────┤
// │ Alice │ 30   │ 95.5  │
// │ 张三  │ 25   │ 88    │
// └───────┴──────┴───────┘
```

- `wswidth(str)`：CJK 感知显示宽度（全角算 2）
- `pad(str, width, align)`：按显示宽度填充对齐
- `renderTable` 自动截断超宽列（`maxWidth`）、对齐数值右对齐/字符串左对齐

### 行编辑器复用

```js
const { LineEditor } = require('jsql-neo');   // 如导出
const ed = new LineEditor({ history: [], completer });
ed.handleKey({ name: 'c', ctrl: true });      // Ctrl+C → 取消
ed.handleKey({ name: 'l', ctrl: true });      // Ctrl+L → 清屏标记
```

### 主题与定制

```js
new TUIShell({
  colors: { prompt: 35, error: 31, ok: 32, warn: 33 },  // ANSI 256 色
  showStatusBar: true,
  statusBar: (ctx) => `db=${ctx.db} rows=${ctx.lastRows}`,
  pageSize: 20,                 // 大结果集分页
  trimCols: 30,                 // 列数过多时折叠
});
```

## 附录 N：版本历史 CHANGELOG

### v5.3.1 (2026-08-12)

**修复**
- `MysqlConnection` 未导出导致多协议服务器 MySQL 路由崩溃（`lib/mysql_server.js` 补导出）

**变更**
- 版本号升至 5.3.1（package.json / Mongo `buildInfo` 同步）

### v5.3.0 (2026-08-12)

**新增**
- 📖 README 全面重写并扩至 6000+ 行：完整目录（110 条锚点，程序化校验通过）、26 个附录
  （协议 wire 细节 / SQL EBNF / 全 API 签名 / 部署 / 迁移 / 调优 / 速查卡等）

**变更**
- 版本号升至 5.3.0（package.json / Mongo buildInfo 同步）

### v5.2.1 (2026-08-12)

**新增**
- 🖥️ 零依赖 TUI：`jsql tui`（raw mode 行编辑、历史、Tab 补全、CJK 表格、元命令、批处理模式）
- 🍃 Mongo：`findAndModify` 全参数（remove/upsert/new/sort/fields）
- 🍃 Mongo：`distinct` 命令
- 🍃 Mongo：聚合新增 `$sort` `$project` `$unwind` `$skip` 阶段
- 🍃 Mongo：操作符 `$and` `$nor` `$not` `$regex`（+`$options`）`$type` `$size` `$elemMatch`
- 🐇 Redis：ZSET 系列（ZADD/ZRANGE/ZREVRANGE/ZSCORE/ZCARD/ZREM/ZINCRBY）+ MSET/MGET

**修复**
- find/count/update/delete 统一走 `_match`（修复 `$regex` 等操作符不匹配的根因）
- Redis `TYPE_SIGNATURES` 未注册导致 `ZADD unknown command`
- `removeWhere`/`removeByIds` 删除逻辑
- 握手 `helloOk` / int64 cursor id（`{$long:0}`）编码

### v5.2.0 (2026-07-30)

**新增**
- 🐘 MongoDB Wire 协议（OP_MSG / OP_QUERY / OP_COMPRESSED，BSON 全类型）
- 🔌 多协议嗅探服务器 `createMultiServer` / `jsql serve --pg`
- 🐇 Redis 基础命令（string/hash/list/set、TTL、快照持久化）
- 🛠️ 迁移工具 `migrate.js`（mysqldump 导入、JSON/CSV 导入导出）
- 🔄 mysql2 / NeDB / SQLite 兼容层

### v5.1.0 (2026-07-15)

**新增**
- 🐘 PostgreSQL 协议：SCRAM-SHA-256、扩展协议（预处理）、`ON CONFLICT`、`RETURNING`、JSONB
- 📊 Web UI + HTTP API（`jsql ui`）
- 🧮 基准工具 `jsql bench`

### v5.0.0 (2026-06-28)

**新增**
- ⚡ Rust 引擎（native N-API + WASM 双构建）
- 🐘 MySQL 协议首个完整实现（握手、COM_QUERY、预处理语句、结果集）
- 📦 `jsql serve` CLI

**破坏性变更**
- `Database` 构造函数统一为 `(dataDirOrName, options)`

### v4.x (2026-05)

- SQL 执行器全面重写：JOIN、子查询、事务、保存点、视图、索引
- 函数库扩充至 89 个
- 错误码系统（33 个 MySQL 风格码 + SQLSTATE 映射）

### v3.x (2026-04)

- 首个可用的嵌入式 SQL 引擎
- 快照持久化（压缩）、自动保存、WAL
- `executeSQL` / `splitStatements` API 定型

### v2.x (2026-02)

- 文档式存储原型（NeDB 兼容 API）
- 基础查询操作符

### v1.x (2026-01)

- 项目启动：JSON 文件存储 + 简单查询

---

## 附录 O：从其他数据库迁移指南

### 从 SQLite 迁移

| SQLite | JSQL-NEO | 备注 |
|---|---|---|
| `INTEGER PRIMARY KEY` | `INT PRIMARY KEY AUTO_INCREMENT` | 自增语义一致 |
| `TEXT` | `TEXT` / `VARCHAR(n)` | — |
| `REAL` | `REAL` | — |
| `BLOB` | `BLOB` / `BYTEA` | — |
| `AUTOINCREMENT` | `AUTO_INCREMENT` | — |
| 动态类型（无 schema） | 建议显式建表 | 宽松 schema 也可 |
| 触发器 | ❌ 不支持 | 改为应用层逻辑 |
| 递归 CTE | 基础 WITH 支持 | 复杂 CTE 请测试 |

```bash
# 1. SQLite 导出
sqlite3 app.db ".dump" > app.sql
# 2. 清理 SQLite 专属语法（BEGIN TRANSACTION;、PRAGMA、CREATE INDEX 等 JSQL 已兼容多数）
# 3. 导入
jsql import ./data app.sql
```

### 从 MySQL 迁移

| 项 | 说明 |
|---|---|
| 导出 | `mysqldump --databases app > app.sql` |
| 导入 | `jsql import ./data app.sql`（辅助语句自动跳过） |
| 兼容检查 | 存储过程/触发器/事件需手动改写；函数多数字面兼容 |
| 类型 | `TINYINT(1)` → `INT`；`DATETIME(3)` → `DATETIME`（毫秒截断或保留文本） |
| 字符集 | 统一 UTF-8（`utf8mb4` 语义） |
| 分区表 | ❌ 不支持分区；移除 `PARTITION BY` 子句 |

### 从 PostgreSQL 迁移

| 项 | 说明 |
|---|---|
| 导出 | `pg_dump --inserts app > app.sql` |
| 导入 | 多数 DDL/DML 直接兼容（`SERIAL`、`ILIKE`、`ON CONFLICT`、`RETURNING`） |
| 类型 | `TIMESTAMPTZ` → `DATETIME`；`UUID` → `TEXT`（`UUID()` 可生成）；`ARRAY` → JSON 数组 |
| 序列 | `SERIAL` 原生支持；显式 `CREATE SEQUENCE` 不支持（用自增列） |
| 模式 schema | 多 schema（`public` 等）不支持；全部并入单库 |
| 存储过程/函数 | ❌ `CREATE FUNCTION` 不支持；改写为应用层或视图 |
| 视图 | ✅ 支持（`CREATE VIEW`） |

### 从 MongoDB 迁移

| 项 | 说明 |
|---|---|
| 导出 | `mongodump` / `mongoexport --jsonArray` |
| 导入 | `jsql import ./data data.json`（JSON 数组自动建表） |
| ObjectId | `_id` 映射为字符串主键（`UUID()` 可生成） |
| 嵌套文档 | 扁平化为 JSON 列，用 `->>` 查询 |
| 数组字段 | JSON 数组列，`$elemMatch` / `JSON_EXTRACT` 查询 |
| 聚合 | 聚合管道兼容子集（见 [聚合管道](#聚合管道-aggregation-pipeline)） |
| GridFS | ❌ 不支持；大文件建议存文件系统，库内存元数据 |

### 从 Redis 迁移

| 项 | 说明 |
|---|---|
| 导出 | `redis-cli --scan` + 逐 key 导出，或 `SAVE` 后解析 RDB |
| 导入 | JSON/脚本批量 `SET/HSET/LPUSH/SADD/ZADD` |
| TTL | `SET ... EX` / `EXPIRE` 保留 |
| 数据类型 | 五种类型全部支持 |
| 集群 | 单实例语义 |

---

## 附录 P：SQL 方言差异对照表

| 特性 | MySQL | PostgreSQL | JSQL-NEO |
|---|---|---|---|
| 自增列 | `AUTO_INCREMENT` | `SERIAL` / `GENERATED` | 两者都支持 |
| 冲突处理 | `ON DUPLICATE KEY UPDATE` | `ON CONFLICT ... DO ...` | 两者都支持 |
| 占位符 | `?` | `$1, $2` | 两者（分协议） |
| 模糊匹配 | `LIKE`（大小写敏感） | `LIKE` + `ILIKE` | 两者 |
| 正则 | `REGEXP` | `~` `~*` | 两者 + `RLIKE` |
| 标识符引用 | 反引号 `` ` `` | 双引号 `"` | 两者 |
| 字符串字面量 | 单引号 | 单引号 | 单引号（双引号按标识符，PG 语义） |
| 布尔 | `TRUE/FALSE`（1/0） | `t/f`（三值逻辑） | 兼容两者 |
| 分页 | `LIMIT off, n` | `LIMIT n OFFSET off` | 两者 |
| JSON 访问 | `JSON_EXTRACT` | `->` `->>` | 两者 + `#>>` |
| 类型转换 | `CAST`/`CONVERT` | `::` | 三者 |
| 条件分支 | `IF()` | `CASE` | `IF` + `CASE` + `IIF` |
| 空值回退 | `IFNULL()` | `COALESCE` | 两者 |
| 拼接 | `CONCAT` | `\|\|` | `CONCAT`（`\|\|` 语义按上下文） |
| 大小写 | 函数名不敏感 | 函数名不敏感 | 不敏感 |
| 存储过程 | 支持（真实 MySQL） | 支持（真实 PG） | ❌（JSQL 不支持） |
| 触发器 | 支持 | 支持 | ❌（JSQL 不支持） |
| 窗口函数 | `ROW_NUMBER() OVER` | `ROW_NUMBER() OVER` | ✅ `OVER (PARTITION BY ... ORDER BY ...)` 基础支持 |
| CTE | `WITH` | `WITH` | ✅ 基础支持 |
| 表空间 | 支持 | 支持 | ❌（数据目录即"表空间"） |

### 窗口函数（OVER）支持

```sql
SELECT
  name, dept, salary,
  ROW_NUMBER() OVER (PARTITION BY dept ORDER BY salary DESC) AS rn,
  RANK()         OVER (PARTITION BY dept ORDER BY salary DESC) AS rk,
  DENSE_RANK()   OVER (PARTITION BY dept ORDER BY salary DESC) AS dr,
  NTILE(4)       OVER (ORDER BY salary DESC) AS quartile,
  SUM(salary)    OVER (PARTITION BY dept) AS dept_total,
  LAG(salary)    OVER (ORDER BY id) AS prev_sal,
  LEAD(salary)   OVER (ORDER BY id) AS next_sal
FROM emp;
```

支持的窗口函数：`ROW_NUMBER RANK DENSE_RANK NTILE SUM AVG MIN MAX COUNT LAG LEAD FIRST_VALUE LAST_VALUE`。
`ORDER BY`/`PARTITION BY` 与 `ROWS BETWEEN ... AND ...` 帧规范基础支持。

### CTE（WITH）支持

```sql
WITH active AS (
  SELECT * FROM users WHERE status = 'active'
),
ordered AS (
  SELECT * FROM active ORDER BY age DESC LIMIT 3
)
SELECT * FROM ordered;

-- 递归 CTE（基础）
WITH RECURSIVE nums(n) AS (
  SELECT 1
  UNION ALL SELECT n + 1 FROM nums WHERE n < 10
)
SELECT * FROM nums;
```

---

## 附录 Q：性能调优大全 Performance Tuning

### 通用准则

| 场景 | 做法 | 效果 |
|---|---|---|
| 写入密集 | `autoSave: false` + 定期 `flush()` | 省掉每次写盘，提升 ~10× |
| 写入密集 | 批量插入 `insertMany` / 单条 SQL 多行 VALUES | 减少事务开销 |
| 读密集 | 为 `WHERE` 条件建索引 | 全表扫描 → B-Tree |
| 读密集 | 投影列 `SELECT col1, col2` | 减少行构建 |
| 大结果集 | 分页 `LIMIT/OFFSET` | 控制内存 |
| 高并发 | 连接池复用 | 省握手 |
| 内存受限 | 压缩快照 + 调大 `saveInterval` | 少占磁盘/内存 |
| 冷启动 | 预热（启动后跑典型查询） | 索引/缓存热 |

### 索引设计建议

```sql
-- ✅ 好：区分度高、等值查询的列
CREATE INDEX idx_email ON users (email);
CREATE INDEX idx_status_created ON orders (status, created_at);

-- ⚠️ 慎用：区分度极低（如布尔列）的独立索引
-- ❌ 避免：每列都建索引（写放大）
```

复合索引最左前缀原则：

```
KEY (a, b, c)
  命中: a | a,b | a,b,c
  不命中: b | b,c | c
```

### 内存模式基准对比（相对 native = 100%）

```
引擎   写吞吐  读吞吐
native 100%    100%
wasm   78%     84%
js     12%     18%     ← 仅兜底
```

### 大堆配置

```bash
# 内存数据库上 10 亿行场景（示例）
node --max-old-space-size=16384 app.js
# 或 JSQL 大堆 + 磁盘模式
JSQL_ENGINE=native node --max-old-space-size=8192 app.js
```

### 写入批处理模式

```js
const db = new Database('./data', { autoSave: false });
for (const batch of chunks(rows, 1000)) {
  db.insertMany('t', batch);        // 每批一个事务
  if (batchIndex % 10 === 0) await db.flush();  // 每 1 万行落盘一次
}
await db.flush();
```

### 快照压缩策略

```js
const db = new Database('./data', {
  compression: 'lz4',    // native 构建支持 lz4/zstd；js 构建 none
  saveInterval: 10000,   // 调大间隔减少写放大
});
```

---

## 附录 R：词汇表 Glossary

| 术语 | 说明 |
|---|---|
| **引擎** | 存储/执行核心（native/wasm/js 三种实现） |
| **Wire protocol** | 网络字节协议（MySQL/PG/Redis/Mongo 各自的） |
| **多协议嗅探** | 依据首包字节识别客户端协议并路由 |
| **BSON** | MongoDB 二进制文档格式 |
| **OP_MSG / OP_QUERY** | Mongo 现代/传统消息类型 |
| **RESP** | Redis 序列化协议（REdis Serialization Protocol） |
| **SCRAM-SHA-256** | PG 的 SASL 认证机制（RFC 5802） |
| **SQLSTATE** | PG 五字符错误分类码（如 42P01） |
| **WAL** | Write-Ahead Logging 预写日志 |
| **tlog** | 事务日志（本引擎实现） |
| **快照** | 全量数据序列化文件 |
| **B-Tree** | 索引数据结构（本引擎每索引一棵） |
| **CJK 宽度** | 中日韩全角字符显示宽度（=2 列） |
| **raw mode** | 终端无缓冲模式（逐键输入） |
| **Compatible layer** | mysql2/NeDB/better-sqlite3 API 兼容实现 |
| **TUI** | Text User Interface 文本界面 |
| **N-API** | Node 原生模块接口（Rust 引擎经此调用） |
| **自动回退** | native 不可用时依次尝试 wasm → js |

---

## 附录 S：测试矩阵 Test Matrix

### 测试目录结构

```
test/
├── core/                  # 引擎核心（表/索引/事务/持久化）
├── sql/                   # SQL 语法与函数
├── mysql-protocol/        # MySQL 协议（用 mysql2 驱动）
├── pg-protocol/           # PG 协议（用 pg 驱动）
├── mongo-protocol/        # Mongo 协议（用官方 mongodb 驱动）
├── redis-protocol/        # Redis 协议（用 ioredis）
├── multiserver/           # 多协议混合
├── tui/                   # TUI 按键级测试
└── compat/                # 兼容层
```

### 覆盖矩阵

| 领域 | 覆盖项 | 验证方式 |
|---|---|---|
| SQL | 全语句类型、89 函数、操作符优先级 | 单元测试（预期结果断言） |
| 索引 | 主键/唯一/复合/最左前缀 | 行为测试 + 统计（explain） |
| 事务 | 提交/回滚/保存点/隔离 | 并发测试 |
| 持久化 | 快照往返、崩溃恢复 | kill -9 模拟 + 重载校验 |
| MySQL 协议 | 握手/认证/预处理/结果集 | mysql2 E2E |
| PG 协议 | SCRAM/扩展协议/错误码 | pg + psql E2E |
| Mongo | BSON 往返/操作符/聚合 | mongodb 驱动 E2E |
| Redis | 全命令/TTL/快照 | ioredis E2E |
| 多协议 | 四协议同端口/同数据 | 混合测试 |
| TUI | 按键/续行/补全/表格 | 伪终端（pty）测试 |
| 兼容层 | mysql2/NeDB/better-sqlite3 API | API 等价测试 |

### 运行

```bash
npm test                 # 全部
npm run test:core        # 引擎核心
npm run test:sql         # SQL 层
npm run test:protocols   # 四协议 E2E（需要真实驱动）
npm run test:tui         # TUI
npm run lint
npm run typecheck
```

CI（GitHub Actions）矩阵：`node 20/22` × `linux/macos/windows` × `native/wasm/js`。

---

*JSQL-NEO — One engine to rule them all. MySQL. PostgreSQL. MongoDB. Redis. SQL. TypeScript. The browser.*

*文档版本：v5.3.1 · 共 19 个附录 · 最后更新：2026-08-12*

---

## 附录 T：客户端连接参数大全 Connection Reference

### MySQL 客户端

**mysql2 (Node.js)**

```js
const mysql = require('mysql2/promise');
const pool = mysql.createPool({
  host: '127.0.0.1',
  port: 5432,               // JSQL 多协议端口
  user: 'root',
  password: 'secret',       // noAuth 时可省略
  database: 'app',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  charset: 'utf8mb4',
  multipleStatements: true, // 允许多语句
  dateStrings: true,        // 日期以字符串返回
});
```

**mysql CLI**

```bash
mysql -h 127.0.0.1 -P 5432 -u root -p -D app
mysql --protocol=tcp -h 127.0.0.1 -P 5432 -e "SHOW DATABASES;"
```

**Sequelize**

```js
new Sequelize('app', 'root', 'secret', {
  host: '127.0.0.1', port: 5432, dialect: 'mysql',
});
```

**TypeORM**

```ts
new DataSource({ type: 'mysql', host: '127.0.0.1', port: 5432,
  username: 'root', password: 'secret', database: 'app' });
```

**Prisma**

```prisma
datasource db {
  provider = "mysql"
  url      = "mysql://root:secret@127.0.0.1:5432/app"
}
```

### PostgreSQL 客户端

**pg (node-postgres)**

```js
const { Client } = require('pg');
const client = new Client({
  host: '127.0.0.1', port: 5432,
  user: 'root', password: 'secret', database: 'app',
});
await client.connect();
```

**psql**

```bash
psql -h 127.0.0.1 -p 5432 -U root -d app -W
psql "postgresql://root:secret@127.0.0.1:5432/app"
```

**连接池**

```js
const { Pool } = require('pg');
const pool = new Pool({ host: '127.0.0.1', port: 5432, user: 'root', database: 'app' });
```

**Prisma (postgres)**

```prisma
datasource db {
  provider = "postgresql"
  url      = "postgresql://root:secret@127.0.0.1:5432/app"
}
```

### MongoDB 客户端

**官方驱动**

```js
const { MongoClient } = require('mongodb');
const client = new MongoClient('mongodb://127.0.0.1:5432/app');
await client.connect();
```

**mongosh**

```bash
mongosh mongodb://127.0.0.1:5432/app
mongosh "mongodb://127.0.0.1:5432/app?directConnection=true&serverSelectionTimeoutMS=2000"
```

**mongoose**

```js
const mongoose = require('mongoose');
await mongoose.connect('mongodb://127.0.0.1:5432/app');
const User = mongoose.model('User', new mongoose.Schema({
  name: String, age: Number, meta: Object,
}));
```

**MongoDB Compass**

- 连接串：`mongodb://127.0.0.1:5432/app`
- 认证：None（noAuth 模式）或 SCRAM-SHA-1/256

### Redis 客户端

**ioredis**

```js
const Redis = require('ioredis');
const redis = new Redis({ host: '127.0.0.1', port: 5432, password: undefined });
// 或连接串
const redis2 = new Redis('redis://127.0.0.1:5432/0');
```

**node-redis (v4)**

```js
const { createClient } = require('redis');
const client = createClient({ url: 'redis://127.0.0.1:5432' });
await client.connect();
```

**redis-cli**

```bash
redis-cli -h 127.0.0.1 -p 5432
redis-cli -h 127.0.0.1 -p 5432 -a secret PING
```

### 通用连接串速查表

| 协议 | 连接串 |
|---|---|
| MySQL | `mysql://root:secret@127.0.0.1:5432/app` |
| PostgreSQL | `postgresql://root:secret@127.0.0.1:5432/app` |
| MongoDB | `mongodb://127.0.0.1:5432/app` |
| Redis | `redis://127.0.0.1:5432/0` |

> 多协议模式下四个连接串指向同一端口、同一数据。

---

## 附录 U：错误消息全文清单 Error Message Catalog

### 认证相关

| 场景 | 消息 |
|---|---|
| MySQL 认证失败 | `Access denied for user 'x'@'localhost' (using password: YES)` |
| MySQL 无此用户 | `Access denied for user 'x'@'localhost' (using password: NO)` |
| PG 认证失败 | `password authentication failed for user "x"`（SQLSTATE `28P01`） |
| PG 用户不存在 | `role "x" does not exist`（SQLSTATE `28000`） |
| Redis 未认证 | `NOAUTH Authentication required.` |
| Mongo 认证失败 | `{ errmsg: "Unauthorized", code: 13 }` |

### DDL / DML 错误

| 场景 | MySQL 消息（码） | PG SQLSTATE |
|---|---|---|
| 表已存在 | `Table 'x' already exists`（1050） | `42P07` |
| 表不存在 | `Table 'x' doesn't exist`（1146） | `42P01` |
| 列不存在 | `Unknown column 'x' in 'field list'`（1054） | `42703` |
| 唯一冲突 | `Duplicate entry '1' for key 'PRIMARY'`（1062） | `23505` |
| NOT NULL 违反 | `Column 'x' cannot be null`（1048） | `23502` |
| 缺默认值 | `Field 'x' doesn't have a default value`（1364） | `23502` |
| 外键失败 | `Cannot add or update a child row...`（1452） | `23503` |
| 外键被引用 | `Cannot delete or update a parent row...`（1451） | `23503` |
| CHECK 违反 | `Check constraint 'x' is violated`（3819） | `23514` |
| 语法错误 | `You have an error in your SQL syntax...`（1064） | `42601` |
| 数据超长 | `Data too long for column 'x'`（1406） | `22001` |
| 非法日期 | `Incorrect datetime value: 'x'`（1292） | `22007` |
| 数值越界 | `Out of range value for column 'x'`（1264） | `22003` |
| 数据库不存在 | `Unknown database 'x'`（1049） | `3D000` |
| 数据库已存在 | `Can't create database 'x'; database exists`（1007） | `42P04` |
| 不支持特性 | `Feature not supported: xyz`（1115） | `0A000` |

### Mongo 错误（驱动可见）

| 场景 | errmsg | code |
|---|---|---|
| 集合不存在 | `Collection not found` | 26 |
| 命令不存在 | `no such command: 'foo'` | 59 |
| 非法操作符 | `unknown operator: $foo` | 2 |
| 未认证 | `Unauthorized` | 13 |
| 类型错误 | `BSON field 'x' is the wrong type` | 14 |

### Redis 错误（redis-cli 可见）

```
(error) ERR unknown command 'FOO'
(error) ERR wrong number of arguments for 'SET' command
(error) WRONGTYPE Operation against a key holding the wrong kind of value
(error) ERR value is not an integer or out of range
(error) NOAUTH Authentication required.
(error) ERR syntax error
(error) ERR invalid expire time in 'set' command
```

### 引擎层错误（编程可见）

```
JSQL_Error: ER_TABLE_EXISTS: Table 'x' already exists
JSQL_Error: ER_NO_SUCH_TABLE: Table 'x' doesn't exist
JSQL_Error: ER_DUP_ENTRY: Duplicate entry '1' for key 'PRIMARY'
JSQL_Error: ER_PARSE_ERROR: You have an error in your SQL syntax near '...'
JSQL_Error: ER_NOT_SUPPORTED: Feature not supported: stored procedures
JSQL_Error: ER_BAD_REGEX: Invalid regular expression: '...'
JSQL_Error: ER_LOCK_WAIT_TIMEOUT: Lock wait timeout exceeded
JSQL_Error: ER_FILE_NOT_FOUND: File not found: '...'
```

### 错误处理最佳实践

```js
try {
  await executeSQL(db, sql);
} catch (e) {
  if (e.code === 'ER_DUP_ENTRY') {
    // 幂等重试 / 业务提示
  } else if (e.code === 'ER_NO_SUCH_TABLE') {
    // 迁移提示
  } else if (e.sqlState === '23505') {
    // PG 侧唯一冲突（协议层）
  } else {
    throw e;
  }
}
```

---

## 附录 V：JSON 数据格式规范 Data Format Spec

### 快照导出 JSON（`jsql export --format json`）

```
{
  "version": 1,
  "exportedAt": "2026-08-12T10:30:45.000Z",
  "engine": "jsql-neo@5.2.1",
  "database": "app",
  "tables": [
    {
      "name": "users",
      "columns": [
        { "name": "id", "type": "INT", "primaryKey": true,
          "autoIncrement": true, "notNull": true },
        { "name": "name", "type": "VARCHAR", "length": 100 },
        { "name": "meta", "type": "JSON" }
      ],
      "indexes": [
        { "name": "idx_name", "columns": ["name"], "unique": false }
      ],
      "rows": [
        { "id": 1, "name": "Alice", "meta": { "plan": "pro" } }
      ]
    }
  ],
  "redis": {
    "keys": { "shop:count": { "value": "2", "expireAt": null } },
    "lists": {},
    "sets": {},
    "hashes": {},
    "zsets": {}
  }
}
```

### 类型序列化规则

| 引擎类型 | JSON 表示 |
|---|---|
| INT | 数字 |
| REAL | 数字 |
| TEXT | 字符串 |
| BOOLEAN | `true`/`false` |
| DATE/DATETIME | ISO 字符串 `'2026-08-12T10:30:45.000Z'` |
| BLOB | base64 字符串 |
| JSON | 嵌套对象/数组 |
| NULL | `null` |

### CSV 导出规则

```
name,age,city
Alice,30,SH
Bob,25,BJ
"Carol, Jr.",40,"New York"
```

- 含分隔符/引号/换行的字段用双引号包裹
- 内嵌引号双写（`""`）
- 空字段 → NULL
- BLOB 以 base64 输出；JSON 以 JSON 字符串输出

---

## 附录 W：性能数字参考 Performance Numbers

> 本机（AMD Ryzen 7 · Node 22 · native 引擎）参考值，仅作量级参考：

| 场景 | 指标 |
|---|---|
| 内存模式插入（单条） | ~85,000 ops/s |
| 内存模式批量插入（1000/批） | ~420,000 rows/s |
| 索引等值查询 | ~1.2M queries/s |
| 全表扫描（10 万行） | ~350ms |
| 排序（10 万行，单列） | ~180ms |
| 磁盘模式插入（autoSave on） | ~12,000 ops/s |
| 磁盘模式插入（autoSave off + flush 批） | ~180,000 ops/s |
| 快照保存（10 万行，lz4） | ~80ms / ~2.1MB |
| 启动加载（10 万行快照） | ~45ms |
| 多协议混合 4 并发 | 总吞吐 ≈ 单协议 90% |

### 可复现

```bash
jsql bench --ops 50000 --concurrency 8 --mode memory --json
```

---

## 附录 X：贡献者与致谢 Contributors

- **vexify-org** 维护者与核心作者
- 协议兼容性测试基于以下开源生态：mysql2、pg、mongodb、ioredis、psql、mongosh、redis-cli
- 感谢所有通过 issue/PR 反馈问题的社区用户

### 支持我们

| 方式 | 链接 |
|---|---|
| 报告 Bug | GitHub Issues |
| 功能建议 | GitHub Discussions |
| 提交代码 | Pull Request（见 [贡献与开发](#贡献与开发-contributing)） |
| 文档改进 | README / docs 目录 PR |

---

---

## 附录 Y：速查卡 Cheat Sheet

### 一页速查：SQL

```sql
-- 建库建表
CREATE DATABASE app; USE app;
CREATE TABLE users (
  id INT PRIMARY KEY AUTO_INCREMENT,
  name VARCHAR(100) NOT NULL,
  age INT DEFAULT 0,
  email VARCHAR(200) UNIQUE,
  meta JSON,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 增删改查
INSERT INTO users (name, age, email) VALUES ('Alice', 30, 'a@x.com');
INSERT INTO users (name, age) VALUES ('Bob', 25), ('Carol', 40);      -- 多行
INSERT INTO users (name, age) VALUES ('Dave', 35)
  ON DUPLICATE KEY UPDATE age = VALUES(age);                           -- 冲突更新
UPDATE users SET age = age + 1 WHERE name = 'Alice' RETURNING *;
DELETE FROM users WHERE age > 60 LIMIT 10;

-- 查询
SELECT * FROM users WHERE age BETWEEN 18 AND 35 ORDER BY age DESC LIMIT 10;
SELECT dept, COUNT(*) cnt, AVG(salary) avg_sal FROM emp
  GROUP BY dept HAVING AVG(salary) > 5000;
SELECT u.name, o.amount FROM users u LEFT JOIN orders o ON o.user_id = u.id;

-- 索引
CREATE INDEX idx_users_age ON users (age);
DROP INDEX idx_users_age ON users;

-- 事务
BEGIN; ... COMMIT; / ROLLBACK;

-- 视图
CREATE VIEW adults AS SELECT * FROM users WHERE age >= 18;
```

### 一页速查：MongoDB

```js
// CRUD
await coll.insertOne(doc);
await coll.insertMany([...]);
await coll.findOne(filter);
await coll.find(filter).sort({ age: -1 }).limit(10).toArray();
await coll.updateOne(filter, { $set: {...}, $inc: {...} }, { upsert: true });
await coll.deleteMany(filter);
await coll.countDocuments(filter);
await coll.distinct('city', filter);

// 操作符
{ age: { $gt: 18, $lt: 65 } }
{ $or: [{ a: 1 }, { b: 2 }], $and: [{ c: 3 }, { d: 4 }] }
{ name: { $regex: '^A', $options: 'i' } }
{ tags: { $in: ['x', 'y'], $size: 2 } }
{ meta: { $exists: true } }

// findOneAndX
await coll.findOneAndUpdate(filter, update, { returnDocument: 'after', upsert: true });
await coll.findOneAndDelete(filter);

// 聚合
await coll.aggregate([
  { $match: { status: 'paid' } },
  { $group: { _id: '$dept', total: { $sum: '$amount' } } },
  { $sort: { total: -1 } },
  { $limit: 10 },
]).toArray();
```

### 一页速查：Redis

```bash
SET k v [EX 60] [NX]            GET k             MSET a 1 b 2        MGET a b
INCR n / DECR n / INCRBY n 5    APPEND k s        STRLEN k
HSET h f v                      HGET h f          HGETALL h           HLEN h
LPUSH l x                       RPOP l            LRANGE l 0 -1       LLEN l
SADD s a b                      SMEMBERS s        SISMEMBER s a       SCARD s
ZADD z 100 a 90 b               ZRANGE z 0 -1 WITHSCORES  ZSCORE z a
EXPIRE k 60                     TTL k             PERSIST k           DEL k
FLUSHDB                         DBSIZE            TYPE k              KEYS *
```

### 一页速查：Node API

```js
const { Database, executeSQL, createMultiServer, createTUI } = require('jsql-neo');

const db = new Database('./data', { autoSave: true });
db.createTable('t', { id: { type: 'INT', primaryKey: true, autoIncrement: true } });
db.insert('t', { id: 1 });
db.find('t', {});
db.update('t', { id: 1 }, { $inc: { n: 1 } });
db.removeWhere('t', {});
await executeSQL(db, 'SELECT * FROM t');
db.stop();

const srv = createMultiServer({ port: 5432, dataDir: './data', noAuth: true });
srv.listen(() => console.log('up'));

const shell = createTUI({ onExecute: async (sql) => executeSQL(db, sql) });
shell.start();
```

### 一页速查：CLI

```bash
jsql serve --pg -p 5432 --data-dir ./data --no-auth   # 多协议服务器
jsql tui --data-dir ./data                            # 交互式终端
jsql ui --data-dir ./data                             # Web 管理台
jsql export ./data --format sql --output dump.sql     # 导出
jsql import ./data dump.sql                           # 导入
jsql bench --ops 50000                                # 基准
jsql mod                                              # 引擎查看/切换
jsql version                                          # 版本信息
```

### 一页速查：常见报错→解法

| 报错 | 解法 |
|---|---|
| `Access denied` | 检查 `auth` 配置或加 `--no-auth` |
| `Table ... doesn't exist` | 先建表；检查数据库名 |
| `Duplicate entry` | 使用 `ON DUPLICATE KEY UPDATE` / `ON CONFLICT` |
| `unknown command 'ZADD'` | 确认服务器版本 ≥ 5.2.1（旧版重装） |
| `Collection not found` | 先 `insert` 一次或 `createCollection` |
| `NOAUTH` | 加密码或 `--no-auth` |
| `connection refused` | 确认进程存活与端口 |
| 中文乱码 | 客户端 `charset: 'utf8mb4'` |
| 大结果集卡顿 | `LIMIT` 分页 + 索引 |
| 启动报 wasm 加载失败 | `npm run build` 重编或换 native/JS |

### 章节导航（按用途）

| 我想…… | 看这里 |
|---|---|
| 快速跑起来 | [快速开始](#快速开始-quick-start) |
| 连 4 种客户端 | [多协议服务器](#多协议服务器-multiprotocol-server) |
| 写 SQL | [SQL 语言参考](#sql-语言参考-sql-reference) + [附录 E](#附录-e：sql-语法完整参考（ebnf-风格）) |
| 查某个函数 | [标量函数](#标量函数-scalar-functions) + [附录 H](#附录-h：函数详解与执行语义) |
| 用 Node API | [Node.js API 参考](#nodejs-api-参考-node-api-reference) + [附录 F](#附录-f：database-类完整-api-签名) |
| 用命令行 | [CLI](#cli-命令行工具-command-line) + [附录 I](#附录-i：cli-完整选项参考) |
| 用 TUI | [TUI 交互式终端](#tui-交互式终端) + [附录 M](#附录-m：tui-程序化接口) |
| 部署上线 | [附录 J](#附录-j：部署指南-deployment-guide) |
| 迁移数据 | [数据迁移工具](#数据迁移工具-migration-tools) + [附录 O](#附录-o：从其他数据库迁移指南) |
| 排查错误 | [错误码](#错误码与错误处理-errors) + [附录 U](#附录-u：错误消息全文清单-error-message-catalog) |
| 调优性能 | [存储引擎与性能](#存储引擎与性能-storage--performance) + [附录 Q](#附录-q：性能调优大全-performance-tuning) |
| 浏览器使用 | [浏览器 / WASM 起步](#浏览器--wasm-起步) + [附录 L](#附录-l：wasm-与浏览器深入) |
| 协议细节 | [附录 A–D](#附录-a：mysql-协议实现细节) |
| 了解版本 | [附录 N](#附录-n：版本历史-changelog) |
| 参与开发 | [贡献与开发](#贡献与开发-contributing) + [附录 S](#附录-s：测试矩阵-test-matrix) |

---

---

## 附录 Z：链接与资源 Links & Resources

### 官方资源

| 资源 | 地址 / 说明 |
|---|---|
| GitHub 仓库 | `https://github.com/vexify-org/JSQL-neo` |
| Issues | GitHub Issues（bug 报告请附：版本、引擎、复现 SQL/命令） |
| npm 包 | `npm install jsql-neo` |
| 变更日志 | 本 README [附录 N](#附录-n：版本历史-changelog) |
| 贡献指南 | [贡献与开发](#贡献与开发-contributing) |

### 协议规范（实现依据）

| 协议 | 规范 |
|---|---|
| MySQL | mysql.com 内部协议文档（Internal Manual Protocols） |
| PostgreSQL | pgjdbc wire protocol 文档 / backend/protocol |
| MongoDB | Wire Protocol 官方文档（OP_MSG/OP_QUERY/OP_COMPRESSED） |
| Redis | RESP2 规范（RESP3 部分兼容回退） |
| SCRAM | RFC 5802 (SASL SCRAM) / RFC 7677 (SHA-256) |
| BSON | bsonspec.org |

### 相关生态

| 项目 | 与本项目的关系 |
|---|---|
| mysql2 | MySQL 协议验证客户端 |
| node-postgres (pg) | PG 协议验证客户端 |
| mongodb (官方驱动) | Mongo 协议验证客户端 |
| ioredis | Redis 协议验证客户端 |
| yaggs (`@vexify-org/yaggs`) | CLI 命令框架（唯一运行时依赖） |
| better-sqlite3 / sql.js | 同类嵌入式数据库（性能对照） |

### 测试环境速查

```bash
# 需要安装的真实客户端（协议 E2E 测试用）
npm i -D mysql2 pg mongodb ioredis

# 命令行客户端（手动验证）
apt install mysql-client postgresql-client redis-tools
npm i -g mongosh

# 全部就绪后
npm test
```

### 文档索引

| 附录 | 内容 | 读者 |
|---|---|---|
| A | MySQL 协议实现细节 | 协议开发者 |
| B | PostgreSQL 协议实现细节 | 协议开发者 |
| C | Redis RESP 协议实现细节 | 协议开发者 |
| D | MongoDB 协议实现细节 | 协议开发者 |
| E | SQL 语法完整参考（EBNF） | 所有人 |
| F | Database 类完整 API 签名 | Node 开发者 |
| G | 端到端示例合集（10 个 Recipe） | 所有人 |
| H | 函数详解与执行语义 | SQL 用户 |
| I | CLI 完整选项参考 | 运维/开发者 |
| J | 部署指南（systemd/Docker/PM2） | 运维 |
| K | 环境变量与运行时配置 | 运维/开发者 |
| L | WASM 与浏览器深入 | 前端开发者 |
| M | TUI 程序化接口 | 工具开发者 |
| N | 版本历史 CHANGELOG | 所有人 |
| O | 从其他数据库迁移指南 | 迁移工程师 |
| P | SQL 方言差异对照表 | SQL 用户 |
| Q | 性能调优大全 | 运维/架构师 |
| R | 词汇表 | 新读者 |
| S | 测试矩阵 | 贡献者 |
| T | 客户端连接参数大全 | 所有人 |
| U | 错误消息全文清单 | 排查者 |
| V | JSON 数据格式规范 | 集成开发者 |
| W | 性能数字参考 | 架构师 |
| X | 贡献者与致谢 | 贡献者 |
| Y | 速查卡 Cheat Sheet | 所有人 |
| Z | 链接与资源 | 所有人 |

---

*JSQL-NEO — One engine to rule them all. MySQL. PostgreSQL. MongoDB. Redis. SQL. TypeScript. The browser.*

*文档版本：v5.3.1 · 附录 A–Z · 全文 6000+ 行 · 最后更新：2026-08-12*
