# JSQL-NEO v3.1.0

Rust-powered embedded database. Runs via **WASM** (zero native deps) or as a standalone **HTTP server**.

## Quick Start (WASM — no server needed)

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
console.log(user);
```

## HTTP Server

```bash
# Start the server
JSQL_DATA_DIR=/tmp/jsql-neo npx jsql-neo

# Connect from JS
const { HttpJSQL } = require('jsql-neo');
const db = new HttpJSQL({ host: '127.0.0.1', port: 6379 });
```

## Features

- In-memory or persistent (WAL + snapshot) storage
- B-Tree indexing + HashMap O(1) PK lookups
- Strings Pool for memory-efficient string storage
- Batch insert / update / delete
- Cursor-based pagination
- Transaction support
- WASM — zero native dependencies, runs in Node.js and browsers
