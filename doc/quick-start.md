🌐 Language / 语言: **English** | [简体中文](cn/quick-start.md)

# Quick Start

> Applies to **v6.6.2**.

## Installation

```bash
npm install jsql-neo
npx jsql-neo --version   # jsql-neo v6.6.2
```

## Three lines of code

```js
const { Database, executeSQL } = require('jsql-neo');

(async () => {
  const db = new Database(':memory:');
  await executeSQL(db, "CREATE TABLE users (id INT PRIMARY KEY AUTO_INCREMENT, name TEXT)");
  await executeSQL(db, "INSERT INTO users (name) VALUES ('Alice')");
  const { rows } = await executeSQL(db, "SELECT * FROM users");
  console.log(rows); // [[1, 'Alice']]
  db.stop();
})();
```

> CommonJS has no top-level `await`, hence the async IIFE wrapper; in ESM you can use `await` directly.

## In-memory vs on-disk

| Mode | Usage | When to use |
|---|---|---|
| Memory | `new Database(':memory:')` | Testing, caching |
| Disk | `new Database('./data/app', { mode: 'disk' })` | Production persistence |
| Hybrid | `new Database('./data', { mode: 'hybrid', autoSave: true, autoSaveInterval: 3000 })` | Balance of speed and durability |

## Web UI

```bash
npx jsql-neo ui --port 8080
```

Then open http://localhost:8080

## Multi-protocol server

One port, serving MySQL / PostgreSQL / MongoDB / Redis clients at the same time:

```bash
npx jsql-neo serve --port 3306
# MySQL clients: mysql -h 127.0.0.1 -P 3306
# PostgreSQL clients: psql -h 127.0.0.1 -p 3306
# MongoDB clients: mongosh mongodb://127.0.0.1:3306
# Redis clients: redis-cli -p 3306
```

## Browser / WASM

```js
import { JSQL } from 'jsql-neo/wasm/browser.mjs';

const db = new JSQL();
await db.start();

await db.createTable('users', {
  id: { type: 'integer', primaryKey: true },
  name: { type: 'string' },
});
await db.insert('users', { name: 'Alice' });
console.log(await db.find('users', {})); // [{ id: 1, name: 'Alice', … }]

db.stop();
```

> In the browser, `start()` automatically loads `browser_bg.wasm` from the same directory; the WASM engine exposes `createTable` / `insert` / `find` / `findById` / `count` / `updateById` and more (there is no `executeSQL`).

## Going further

- Detailed usage: [API Reference](api-reference.md)
- CLI commands: [CLI Commands](cli.md)
- SQL syntax: [SQL Reference](sql-reference.md)
