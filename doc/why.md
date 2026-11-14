🌐 Language / 语言: **English** | [简体中文](cn/why.md)

# Why JSQL-NEO

## What it is

JSQL-NEO is an embedded database whose core engine is written in Rust. It speaks **MySQL, PostgreSQL, MongoDB and Redis** — one npm package, zero runtime dependencies in the core engine (only CLI argument parsing uses `@vexify-org/yaggs`), and it runs both natively and in the browser (WASM).

## Why JSQL-NEO?

Most embedded databases force you to pick two out of three:

- **Native speed**
- **Portability** (WASM in the browser)
- **Familiar protocols** (compatibility with the existing tool ecosystem)

JSQL-NEO gives you all three:

| Dimension | JSQL-NEO | better-sqlite3 | sql.js (WASM) | LevelDB | local redis/mongo |
|---|---|---|---|---|---|
| Native speed (Rust N-API) | ✅ | ✅ | ❌ | ✅ | ✅ |
| Runs in browser (WASM) | ✅ | ❌ | ✅ | ❌ | ❌ |
| Zero runtime dependencies | ✅ (core) | ✅ | ✅ | ✅ | ❌ |
| MySQL protocol | ✅ | ❌ | ❌ | ❌ | ❌ |
| PostgreSQL protocol | ✅ | ❌ | ❌ | ❌ | ❌ |
| MongoDB Wire Protocol | ✅ | ❌ | ❌ | ❌ | ❌ |
| Redis RESP2 | ✅ | ❌ | ❌ | ❌ | ❌ |
| One port, all protocols | ✅ | ❌ | ❌ | ❌ | ❌ |
| Interactive TUI | ✅ | ❌ | ❌ | ❌ | ❌ |

Key highlights:

- **One engine, three shapes** — `native` (Rust N-API), `wasm` (the same Rust core compiled to WebAssembly), and `js` (pure JS). The three are feature-equivalent, **but there is no automatic fallback**: the engine must be chosen explicitly at construction time via `new Database(path, { engine: 'native' | 'wasm' | 'js' })`. Requiring `./lib/native_client` directly on a machine without a prebuilt `.node` binary **throws** — it does not silently degrade to pure JS. This is a deliberate choice: silent degradation makes "why did it suddenly get 10× slower" impossible to diagnose. In environments without the native module, explicitly use `lib/database` with `engine: 'js'`.
- **A wire-protocol stack, not an emulator** — hand-written MySQL 4.1+, PostgreSQL wire protocol v3 (SCRAM-SHA-256), MongoDB OP_MSG/OP_QUERY, and Redis RESP2. Since v6.5.1, `jsql serve` serves all four client types on a single port via first-packet sniffing; the MongoDB official driver's handshake and `insertMany` already work end to end. The MySQL path has been battle-tested the longest; PG / Redis / Mongo are newer paths but covered by end-to-end tests (`test/multiprotocol.test.js`).
- **One port, four protocols** — `jsql serve --port 3306` starts the `lib/multiserver.js` sniffing gateway by default: MySQL / PostgreSQL / MongoDB / Redis clients share one port and read/write the same `Database` (Redis keeps its own key namespace); `--mysql-only` falls back to serving MySQL alone. You can also assemble it in code with `createMultiServer(...)`.
- **Full SQL** — DDL/DML, JOINs, subqueries, transactions with savepoints, views, indexes, constraints, 89 scalar functions, window functions, and basic CTE support.
- **Document semantics** — MongoDB-style operators (`$gt`, `$regex`, `$elemMatch`, …) and aggregation pipelines (`$match`, `$group`, `$sort`, …).
- **KV semantics** — five Redis data types, TTL, snapshot persistence.
- **Zero-dependency TUI** — full line editing, persistent history, completion, CJK-friendly tables.
- **Migration tooling** — import `mysqldump` output; export/import JSON and CSV.

## Feature overview

### Multi-protocol server (core feature)

```
┌───────────────────────────────────────────────────────────────┐
│                    jsql serve --port 3306                       │
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
│                      ┌─────────────────┐                     │
│                      │  shared engine  │                     │
│                      │  (one data dir) │                     │
│                      └─────────────────┘                     │
└───────────────────────────────────────────────────────────────┘
```

Write with `psql`, read with `mysql2`, query with `mongosh`, cache with `redis-cli` — **one port, one dataset**.

### Four semantics, one engine

| Semantics | Features |
|---|---|
| MySQL | `AUTO_INCREMENT`, `ON DUPLICATE KEY UPDATE`, `information_schema`, `SHOW` |
| PostgreSQL | `SERIAL`, `ILIKE`, `ON CONFLICT`, JSONB, `RETURNING`, prepared statements |
| MongoDB | operators, `updateOne`/`deleteMany`, aggregation pipeline |
| Redis | 5 data types, TTL, snapshot persistence |

### Runtime shapes

| Shape | Entry point | When to use |
|---|---|---|
| Embedded (memory) | `new Database(':memory:')` | Testing, caching |
| Embedded (disk) | `new Database('./data/db')` | Single-process apps |
| Server (4 protocols) | `createMultiServer(...)` / `jsql serve` | Multiple clients, microservices |
| Browser (WASM) | `JSQL` (lib/wasm_client) | In-browser queries |
| Interactive terminal | `jsql tui` | Manual management, debugging |
