? Language / 语言: **English** | [简体中文](cn/api-reference.md)

# API Reference

## Database

```js
const { Database } = require('jsql-neo');

// In-memory
const mem = new Database(':memory:');

// On-disk (directory storage; flushed automatically on stop())
const disk = new Database('./data/app', { mode: 'disk' });

// Hybrid (LRU + asynchronous flush)
const hybrid = new Database('./data', { mode: 'hybrid', autoSave: true, autoSaveInterval: 3000 });

// Legacy single-file JSON mode (requires an explicit save() / flush() / close(); stop() does not flush)
const legacy = new Database('./data/db.json');

// The examples below all use this in-memory database
const db = new Database(':memory:');
```

### Constructor options

```ts
interface DatabaseOptions {
  mode?: 'memory' | 'hybrid' | 'disk';              // storage mode, default memory
  autoSave?: boolean;                               // legacy file mode auto-save, default true
  autoSaveInterval?: number;                        // legacy file mode auto-save interval ms, default 0 (save on every write)
  memReserveMB?: number;                            // hybrid mode reserve MB, default 512
  flushInterval?: number;                           // hybrid/disk flush interval ms, default 200 hybrid / 50 disk
  encryptKey?: string;                              // AES-256-CBC key (16/24/32 bytes)
  versioning?: boolean;                             // row version history, default false
  wal?: boolean;                                    // WAL mode, default false
  isolationLevel?: 'READ_COMMITTED' | 'REPEATABLE_READ'; // default READ_COMMITTED
  slowQueryThreshold?: number;                      // slow query threshold ms, default 100, <0 disables
  fileLock?: boolean;                               // file lock, default false
}
```

### Initialisation / shutdown

The constructor completes initialisation; there is no `init()`. All data operations return Promises.

```js
await db.stop();                    // stop (directory mode flushes automatically)
await db.flush();                   // flush manually (equivalent to save() in legacy file mode)
db.save();                          // legacy file mode: write to disk immediately
db.backup('./backup.json');         // back up all tables to a JSON file
db.close();                         // save and clear timers
```

Restoring: `db.restore('./backup.json')` only fills rows into **already existing** tables, so
call `createTable` first and then restore. For whole-database in-memory export/import use
`db.export()` / `db.import(data)`.

### Table operations

```js
await db.createTable('posts', { title: { type: 'string' } });   // create
await db.truncate('posts');                                      // empty the table (not truncateTable)
await db.renameTable('posts', 'articles');                       // rename
await db.dropTable('articles');                                  // drop

await db.getTables();                 // → string[] (not listTables)
await db.getTableSchema('users');     // → TableSchema
db.stats();                           // → { tables, views, triggers, totalRows, ... }
```

### Data operations

```js
await db.createTable('users', {
  id: { type: 'integer', primaryKey: true },
  name: { type: 'string' },
  age: { type: 'integer' },
});
await db.insertMany('users', [
  { id: 1, name: 'Alice', age: 30 },
  { id: 2, name: 'Bob', age: 17 },
]);

await db.insert('users', { id: 9, name: 'Dave', age: 25 });   // → array of primary keys
await db.find('users', { age: { $gte: 18 } }, { limit: 10 }); // → Row[]
await db.findById('users', 1);                                // → Row | null
await db.count('users', { age: { $gte: 18 } });               // → number
await db.update('users', { name: 'Dave' }, { age: 26 });
await db.updateById('users', 9, { age: 27 });
await db.removeWhere('users', { name: 'Eve' });
await db.removeById('users', 9);
```

There is no `findOne` on Database; fetch a single row with `(await db.find(table, filter))[0]` or `db.findById`.

### Executing SQL

```js
const { Database, executeSQL } = require('jsql-neo');
const db = new Database(':memory:');

await executeSQL(db, "CREATE TABLE users (id INT PRIMARY KEY AUTO_INCREMENT, name TEXT)");
await executeSQL(db, "INSERT INTO users (name) VALUES ('Alice')");

// Result envelope: { ok, rows, columns, affectedRows, rowCount, message, durationMs, ... }
const { rows, columns } = await executeSQL(db, "SELECT * FROM users WHERE id = ?", [1]);

// Shortcut on the Database instance (equivalent to executeSQL(db, ...))
const r = await db.query("SELECT name FROM users");
```

> `executeSQL` rejects SQL comments (`--`, `#`, `/* */`) by default; pass `{ safety: false }` or
> `{ allowComments: true }` when needed.
>
> Since v6.5.16, safe mode also defaults to **single statement** (`maxStatements: 1`) and rejects
> `DROP` / `TRUNCATE` / `DELETE` / `UPDATE` without a WHERE clause (including `WITH ... DELETE`).
> To write, pass `{ allowWrites: true }` explicitly (the server protocol layer already allows
> writes), or `{ safety: false }` to disable all safety checks.

### Chained queries (Query)

`Query` takes a **Table instance** (`db._tables[name]`), not a table name:

```js
const { Query } = require('jsql-neo');

const q = new Query(db._tables.users)
  .select(['id', 'name'])
  .where({ age: { $gte: 18 } })
  .orderBy('name')
  .limit(10)
  .offset(0);

q.get();      // → Row[] (executes)
q.first();    // → Row | null
q.count();    // → number
q.exists();   // → boolean
q.toSQL();    // → SQL string (for debugging)
```

The exported class is `Query`; there is no `QueryBuilder`. `db.query()` executes SQL and does not return a query builder.

### Aggregation

Use SQL `GROUP BY` / aggregate functions:

```js
await db.createTable('employees', { dept: { type: 'string' }, salary: { type: 'integer' } });
await db.insertMany('employees', [
  { dept: 'eng', salary: 5000 },
  { dept: 'eng', salary: 4000 },
  { dept: 'ops', salary: 6000 },
]);

const { rows } = await db.query(`
  SELECT dept, COUNT(*) AS headcount, SUM(salary) AS total
  FROM employees
  GROUP BY dept
  HAVING COUNT(*) > 1
  ORDER BY total DESC
  LIMIT 5
`);
```

There is no `aggregate()` method on Database.

### Transactions

```js
await db.begin();
try {
  await db.insert('accounts', { id: 1, balance: 1000 });
  await db.update('accounts', { id: 1 }, { balance: 900 });
  await db.commit();
} catch (e) {
  await db.rollback();
}
```

The methods are `begin` / `commit` / `rollback` (there is no `beginTransaction`). Savepoints:

```js
await db.begin();
await db.savepoint('sp1');
await db.rollbackTo('sp1');
await db.releaseSavepoint('sp1');
await db.listSavepoints();   // → string[]
await db.commit();
```

### Indexes

Indexes are created via SQL (Database has no `createIndex` / `dropIndex` / `listIndexes`):

```js
await db.createTable('orders', { user_id: { type: 'integer' }, email: { type: 'string' }, created_at: { type: 'string' } });

await db.query("CREATE UNIQUE INDEX idx_email ON orders(email)");
await db.query("CREATE INDEX idx_composite ON orders(user_id, created_at)");
await db.query("DROP INDEX idx_email ON orders");
```

## Table

```js
const table = db._tables.users;      // Table instance
await table.count();                 // → number
await table.findOne({ name: 'Alice' });
await table.findById(1);
await table.describe();              // → table structure
table.toJSON();                      // → Row[]
await table.createIndex('email');    // field-level index
await table.dropIndex('email');
```

## Plugins and XQL

```js
await db.use('xql');                     // enable the built-in XQL plugin (v6.5.12+)
await db.xqlIndex('users', 'id');        // hash / range index
await db.xqlRefresh('users');
const rows = await db.xql('FROM users |> WHERE id == 1 |> LIMIT 10');
await db.xqlClear();
```

Other APIs: `xqlLoad()` / `xqlTables()` / `xqlCollection()` / `xqlIndex()` / `xqlRefresh()` /
`xqlClear()`. Writes invalidate the index automatically and it is rebuilt on the next query.
Plugins can also be installed from the registry with `jsql plugin install <name>`.

## Compatibility layer (jsql 1.0.0)

```js
const { compatV1 } = require('jsql-neo/compat/v1');
const db = compatV1('./data/app');   // wraps Database
```

`V1Database` makes `createTable` / `dropTable` synchronous and mirrors `db.<table>` accessors;
`import` can infer a schema from rows and restore auto-increment keys, while `export` returns a
deep copy. The v6 `Table` / `Query` are already synchronous with signatures matching 1.0.0, so
the compat layer only adds table creation/drop and table accessors.

See the full API documentation in [README.md](../README.md).
