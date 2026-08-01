# JSQL-NEO v4.0.1

Rust-powered embedded database with **three engines + SQL + Redis-style storage** in one npm package.

## Engines

| Engine | Entry | Use Case |
|--------|-------|----------|
| **Native** (Rust → N-API, fastest) | `NativeJSQL` | Node.js, best performance |
| **WASM** (Rust → wasm-pack, zero native deps) | `JSQL` | Node.js / browsers, no native addon |
| **Pure JS** (local JSON file, SQLite-like) | `Database` | Local file persistence, legacy API |

All engines share the same API (`createTable` / `insert` / `findById` / `find` / `updateById` / `removeById` / `dropTable`) plus `executeSQL()`.

## SQL

```js
const jsql = require('jsql-neo');
const db = new jsql.NativeJSQL();
await db.start();

await jsql.executeSQL(db, 'CREATE TABLE users (id INTEGER PRIMARY KEY AUTO_INCREMENT, name STRING, age INTEGER)');
await jsql.executeSQL(db, "INSERT INTO users (name, age) VALUES ('Alice', 30), ('Bob', 25)");
await jsql.executeSQL(db, "INSERT INTO users VALUES (5, 'Carol', 35) ON DUPLICATE KEY UPDATE age = 30");
const r = await jsql.executeSQL(db, 'SELECT name, age FROM users WHERE age > 26 ORDER BY age DESC');
// → rows: [["Carol",35],["Alice",30]]

await jsql.executeSQL(db, 'UPDATE users SET age = 31 WHERE id = 1');
await jsql.executeSQL(db, 'DELETE FROM users WHERE id = 2');
await db.stop();
```

Supported: `CREATE/DROP TABLE`, `INSERT` (multi-row, `ON DUPLICATE KEY UPDATE`), `SELECT` (`WHERE`/`ORDER BY`/`LIMIT`/`OFFSET`/`GROUP BY`/`HAVING`/aggregates), `UPDATE`, `DELETE`, prepared statements with `?` placeholders.

## Redis-Style Storage Modes

Native and Pure JS engines support three persistence modes (Redis-compatible model: memory-first, async flush, LRU eviction, lazy reload):

```js
const db = new jsql.NativeJSQL({
  path: '/var/lib/jsql',        // storage directory (required for hybrid/disk)
  mode: 'hybrid',               // 'memory' (default) | 'hybrid' | 'disk'
  memReserveMB: 512,            // keep 512MB RAM headroom before evicting
  flushInterval: 200,           // ms between async flushes (hybrid 200 / disk 50)
  evictInterval: 1000,          // ms between memory-pressure checks
});
await db.start();
```

- **`memory`** — pure in-memory (default, no path needed)
- **`hybrid`** — writes go to memory first, async incremental flush to disk; cold tables are LRU-evicted when memory pressure exceeds `total - memReserveMB`, and lazily reloaded on next access
- **`disk`** — fast flush (50ms), memory acts as read/write cache

Data is stored per-table as `<dir>/<table>.jsql.json` + `meta.json`; writes are atomic (tmp + rename).

```js
// Pure JS engine (same options)
const db2 = new jsql.Database({ path: '/var/lib/jsql', mode: 'hybrid' });
```

## Quick Start

### Native (fastest)

```js
const { NativeJSQL } = require('jsql-neo');
const db = new NativeJSQL();
await db.start();

await db.createTable('users', {
  name: { type: 'string' },
  age:  { type: 'integer' }
});
const [id] = await db.insert('users', { name: 'Alice', age: 30 });
const user = await db.findById('users', id);
// → { id: 1, fields: { name: 'Alice', age: 30 }, created_at: '...', updated_at: '...' }
await db.stop();
```

### Pure JS (local file)

```js
const { Database } = require('jsql-neo');
const db = new Database('/tmp/mydb.json');   // or { path, mode } for hybrid/disk
const users = db.createTable('users', {
  id:   { type: 'integer', autoIncrement: true, primaryKey: true },
  name: { type: 'string', length: 32 },
  age:  { type: 'integer' }
});
const ids = users.insertMany([{ name: 'Alice', age: 30 }, { name: 'Bob', age: 25 }]);
users.updateById(ids[0], { age: 31 });
db.save();
```

## API

| Method | Native | WASM | Pure JS | Description |
|--------|--------|------|---------|-------------|
| `createTable(name, schema)` | ✅ | ✅ | ✅ | Define table with typed fields |
| `insert(table, data)` | ✅ | ✅ | ✅ | Insert row(s), returns IDs |
| `findById(table, id)` | ✅ | ✅ | ✅ | O(1) PK lookup |
| `find(table, filter?)` | ✅ | ✅ | ✅ | Filtered query with B-Tree index |
| `count(table)` | ✅ | ✅ | ✅ | Row count |
| `updateById(table, id, data)` | ✅ | ✅ | ✅ | O(1) PK update |
| `removeById(table, id)` | ✅ | ✅ | ✅ | O(1) PK delete |
| `dropTable(name)` | ✅ | ✅ | ✅ | Remove table |
| `executeSQL(db, sql, params?)` | ✅ | ✅ | ✅ | Run SQL statements |

## Schema Field Options

```js
{
  type: 'string' | 'integer' | 'float' | 'boolean',
  primaryKey: true,       // PK field (auto-indexed)
  autoIncrement: true,    // Auto-generate integer PK
  length: 32,             // Max string length
  default: 'value',       // Default value
  nullable: true          // Allow null
}
```

## Features

- Three engines: Native (N-API Rust), WASM (wasm-pack Rust), Pure JS (local JSON)
- SQL engine with prepared statements
- Redis-style hybrid/disk storage: memory-first + async flush + LRU eviction + lazy reload
- O(1) primary key hash index (`FxHashMap` / `Map`)
- B-Tree indexing for range queries
- WAL + snapshot crash recovery (server engine)
- Batch insert / update / delete
- Cursor-based pagination
- Transaction support (server engine)
