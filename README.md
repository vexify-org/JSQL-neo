# JSQL-NEO

> **One engine to rule them all** — a Rust-powered embedded database that speaks your language:
> MySQL, PostgreSQL, MongoDB, Redis, SQL, TypeScript, **and the browser**.

> **v6.3.6** — official release build · [github.com/vexify-org/JSQL-neo](https://github.com/vexify-org/JSQL-neo)

![Engines](https://img.shields.io/badge/engines-Native%20%7C%20WASM%20%7C%20Pure%20JS-7ee787)
![MySQL](https://img.shields.io/badge/protocol-MySQL%20compatible-1f6feb)
![PostgreSQL](https://img.shields.io/badge/protocol-PostgreSQL%20compatible-336791)
![Redis](https://img.shields.io/badge/protocol-Redis%20RESP2-f03c15)
![MongoDB](https://img.shields.io/badge/protocol-MongoDB%20Wire%20Protocol-589636)
![TUI](https://img.shields.io/badge/tui-zero--dependency-ff9800)
![ZERO](https://img.shields.io/badge/dependencies-ZERO-8957e5)
![WASM](https://img.shields.io/badge/runs%20in-Browser%20%28WASM%29-79c0ff)

---

## 🧭 Quick Navigation

- [Why JSQL-NEO?](#why-jsql-neo)
- [Feature Overview](#feature-overview)
- [Quick Start](#quick-start)
- [Detailed Docs](#-documentation)
- [Contributing & License](#-contributing--license)

---

## Why JSQL-NEO?

> `jsql-neo` 是一个 Rust 编写的嵌入式数据库，**零运行时依赖**，同时支持 MySQL / PostgreSQL / MongoDB / Redis 四种协议，
> 可在 Node.js、CLI、Web UI 和浏览器 (WASM) 中运行。

**JSQL-NEO** speaks every protocol on the same engine.

- **Same data, any client** — MySQL, PostgreSQL, MongoDB, Redis tools — all connect on **one port**
- **Zero dependencies** — no native deps to compile, no system libs to install
- **Runs everywhere** — Node.js native addon, pure JS fallback, WASM for the browser
- **~2× faster than better-sqlite3** (Rust core, N-API)

---

## Feature Overview

```
JSQL-NEO: MySQL + PostgreSQL + MongoDB + Redis + SQL
  One port, one engine, all protocols — Node.js / WASM / CLI / Web UI
```

| Feature | Detail |
|---|---|
| **Rust Core** | N-API native addon, ~2× faster than better-sqlite3 |
| **WASM Build** | Same engine runs in Node.js and any browser |
| **MySQL** | `mysql2`, Sequelize, Knex, TypeORM — just work |
| **PostgreSQL** | `pg`, `psql`, pgAdmin — SCRAM-SHA-256, JSONB, ILIKE |
| **MongoDB** | `mongodb`, mongosh, Compass — OP_MSG, BSON, aggregation |
| **Redis** | `ioredis`, `redis-cli` — all data types + TTL |
| **One Port** | Protocol sniffing routes all four clients to the same data |
| **Zero-Dep TUI** | `jsql tui` — line editing, history, Tab, CJK tables |
| **Web UI** | Zero-dependency management console + HTTP API |
| **WASM** | Full engine in browser, no server needed |

---

## Quick Start

### Install

```bash
npm install jsql-neo
```

### Three lines of code

```js
const { Database, executeSQL } = require('jsql-neo');

const db = new Database(':memory:');
await executeSQL(db, "CREATE TABLE users (id INT PRIMARY KEY AUTO_INCREMENT, name TEXT)");
await executeSQL(db, "INSERT INTO users (name) VALUES ('Alice')");
const { rows } = await executeSQL(db, "SELECT * FROM users");
console.log(rows); // [[1, 'Alice']]
db.stop();
```

### One port, four protocols

```bash
npx jsql-neo serve --port 3306
```

```bash
# MySQL    mysql -h 127.0.0.1 -P 3306
# PostgreSQL psql -h 127.0.0.1 -p 3306
# MongoDB  mongosh mongodb://127.0.0.1:3306
# Redis    redis-cli -p 3306
```

All four clients connect to the **same database** on the same port.

### Browser / WASM

```js
import init, { Database } from 'jsql-neo/wasm';
await init();
const db = new Database(':memory:');
// same API as Node.js
```

### Storage modes

| Mode | Usage | Use Case |
|---|---|---|
| Memory | `new Database(':memory:')` | Testing, caching |
| Disk | `new Database('./data/app')` | Production persistence |
| Hybrid | `new Database('./data', { autoSave: true, saveInterval: 3000 })` | Performance + durability |

---

## 📖 Documentation

Detailed docs live in `doc/` — click to read.

| Document | Description |
|---|---|
| [doc/index.md](doc/index.md) | Overview, architecture, concepts |
| [doc/why.md](doc/why.md) | Why JSQL-NEO exists, design philosophy |
| [doc/quick-start.md](doc/quick-start.md) | Install, API basics, Web UI |
| [doc/multiprotocol.md](doc/multiprotocol.md) | One-port multi-protocol server, sniffing logic |
| [doc/mysql.md](doc/mysql.md) | MySQL protocol: auth, system vars, syntax, FAQ |
| [doc/postgresql.md](doc/postgresql.md) | PostgreSQL protocol: SCRAM-SHA-256, wire v3, SQLSTATE |
| [doc/mongodb.md](doc/mongodb.md) | MongoDB protocol: BSON, commands, operators, aggregation |
| [doc/redis.md](doc/redis.md) | Redis protocol: data types, commands, TTL, snapshots |
| [doc/api-reference.md](doc/api-reference.md) | Full API: `Database`, `executeSQL`, config options |
| [doc/sql-reference.md](doc/sql-reference.md) | SQL: statements, data types, functions, operators, indexes |
| [doc/cli.md](doc/cli.md) | CLI: `jsql tui`, `jsql serve`, `jsql ui` |
| [doc/changelog.md](doc/changelog.md) | Release notes |

---

## 🤝 Contributing & License

MIT License — contributions welcome!

- **GitHub:** [vexify-org/JSQL-neo](https://github.com/vexify-org/JSQL-neo)
- **Issues:** [Open an issue](https://github.com/vexify-org/JSQL-neo/issues)
- **PRs:** Fork → branch → PR — thank you!
