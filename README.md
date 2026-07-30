# JSQL-NEO v3.4.3

Rust-powered embedded database with **three engines** in one npm package.

## Engines

| Engine | Entry | Use Case | Speed |
|--------|-------|----------|-------|
| **WASM** (Rust → wasm-pack) | `JSQL` | Zero native deps, Node.js | 1.4M rows/sec insert |
| **HTTP** (Rust actix-web) | `HttpJSQL` | Multi-process / remote | 340K rows/sec insert |
| **Pure JS** (Database class) | `Database` | Local JSON file, SQLite-like | 617K rows/sec insert |

## Quick Start

### WASM (no server, zero deps)

```js
const { JSQL } = require('jsql-neo');

const db = new JSQL();
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

### Pure JS (local file, SQLite-like)

```js
const { Database } = require('jsql-neo');

const db = new Database('/tmp/mydb.json');
const users = db.createTable('users', {
  id:   { type: 'integer', autoIncrement: true, primaryKey: true },
  name: { type: 'string', length: 32 },
  age:  { type: 'integer' }
});

const ids = users.insertMany([{ name: 'Alice', age: 30 }, { name: 'Bob', age: 25 }]);
users.updateById(ids[0], { age: 31 });
const user = users.findById(ids[0]);
db.save();
```

### HTTP Server

```bash
JSQL_DATA_DIR=/tmp/jsql-neo npx jsql-neo
```

```js
const { HttpJSQL } = require('jsql-neo');

const db = new HttpJSQL({ host: '127.0.0.1', port: 6379 });
await db.start();

await db.createTable('users', { name: { type: 'string' }, age: { type: 'integer' } });
const [id] = await db.insert('users', { name: 'Alice', age: 30 });
const user = await db.findById('users', id);

await db.stop();
```

## API

| Method | WASM | HTTP | Pure JS | Description |
|--------|------|------|---------|-------------|
| `createTable(name, schema)` | ✅ | ✅ | ✅ | Define table with typed fields |
| `insert(table, data)` | ✅ | ✅ | ✅ | Insert row(s), returns IDs |
| `findById(table, id)` | ✅ | ✅ | ✅ | O(1) PK lookup |
| `find(table, filter?)` | ✅ | ✅ | ✅ | Filtered query with B-Tree index |
| `count(table)` | ✅ | ✅ | ✅ | Row count |
| `updateById(table, id, data)` | ✅ | ✅ | ✅ | O(1) PK update |
| `removeById(table, id)` | ✅ | ✅ | ✅ | O(1) PK delete |
| `dropTable(name)` | ✅ | ✅ | ✅ | Remove table |

All engines share the same async API for CRUD operations.

## Performance (Pure JS, 100K rows)

| Operation | Time | Rate |
|-----------|------|------|
| Insert 100K | 128 ms | 781K rows/sec |
| findById × 10,000 | 3 ms | 0.3 μs each |
| updateById × 10,000 | 82 ms | 8.2 μs each (O(1) hash index) |
| count × 100 | 0 ms | — |
| findAll × 5 | 16 ms | — |
| Filtered query × 100 | 407 ms | — |

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

- Three engines: WASM (native Rust), HTTP (actix-web), Pure JS (local JSON)
- O(1) primary key hash index (`FxHashMap` / `Map`)
- B-Tree indexing for range queries
- WAL + snapshot crash recovery (HTTP engine)
- Strings Pool for memory-efficient storage
- Batch insert / update / delete
- Cursor-based pagination
- Transaction support (HTTP engine)
