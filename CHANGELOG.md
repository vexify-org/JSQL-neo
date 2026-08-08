# Changelog

All notable changes to **JSQL-NEO** are documented here.
Format: [Keep a Changelog](https://keepachangelog.com) — **Added** / **Changed** / **Fixed** / **Breaking**.
SemVer applies: versions 0.x/3.x-beta are pre-1.0; from 4.0.0 onward the public API is stable.

## [Unreleased]

- Planned: GitHub Releases for tagged versions, coverage badge, more storage plugins.

---

## [5.0.0] — 2026-08-08

### Added

- **better-sqlite3 full API compatibility layer** (`jsql-neo/sqlite`, `lib/sqlite_compat.js`) — drop-in replacement for `better-sqlite3` backed by the JSQL-NEO engine via a worker-thread synchronous bridge:
  - `new Database(path)`, `db.exec()`, `db.pragma()` (incl. `user_version = N` setters), `db.transaction()`, `db.serialize()` / `db.deserialize()`, `db.backup()`, `db.function()`, `db.aggregate()` (functional and `{start,step,result}` forms).
  - `Statement` — `run()` / `get()` / `all()` / `raw()` / `pluck()` / `iterate()` / `columns()` / `bind()`, positional (`?`, `?N`), named (`@name`, `:name`, `$name`) parameters, `last_insert_rowid()`, `changes`.
  - Registered as subpath export `jsql-neo/sqlite`.
- Custom aggregate functions recognized in `GROUP BY` and whole-table aggregate output.
- `PRAGMA user_version = N` (and other settable pragmas) now persist per connection.

### Fixed

- `last_insert_rowid()` returned 0: worker `executeStatement` was synchronous over an async `executeSQL`, so the last-inserted id was never tracked.
- Named-parameter objects (`{name: 'y'}`) were misinterpreted as engine options; now pre-bound via `applyParams`.
- `cnt(*)` / custom aggregates with `*` failed to parse (`Expected value or column, got '*'`).
- `serialize()` Buffer was flattened to a plain object across the worker bridge; now passed through intact.
- `pragma()` returned bare scalars instead of row objects for simple pragmas.

### Changed

- License: **MIT → Apache-2.0**.

---

## [4.4.1] — 2026-08-06

Big engineering pass: protocol servers, web UI, CLI tooling, types, benchmarks, CI.

### Added

- **Redis-compatible server** (`RedisServer` / `createRedisServer`, `jsql redis`) — RESP2 wire protocol, 40+ commands (strings, hashes, lists, sets, counters, TTL, `KEYS`/`DEL`/`EXISTS`, multi-DB `SELECT`, `AUTH`, `INFO`), snapshot persistence to `data.rdb.json` (debounced 500ms + shutdown flush). Verified against `ioredis`.
- **Built-in Web UI** (`WebUI`, `jsql ui`) — zero-dependency HTTP management console: browse databases & tables, run SQL in the browser, result grids.
- **CLI suite** — `jsql export` / `import` (mysqldump, JSON, CSV) / `bench` / `serve` / `server start|stop|status` / `redis` / `ui` / `mod` / `version`.
- **Migration tools** (`lib/migrate.js`) — `importDumpFile`, `importFromJSON`, `importFromCSV`, `exportToFile`, `exportTableToJSON`, `exportAllToJSON`, `exportTableToCSV`; handles real mysqldump output (escapes, comments, `COLLATE`, `CHARACTER SET`).
- **Full TypeScript declarations** — `index.d.ts` (every public class, server, tool) + `wasm/browser.d.ts`; wired via `"types"` and `exports.types` conditions; verified with `tsc --strict`.
- **Benchmark suite** (`bench/`) — Native vs better-sqlite3 vs sql.js vs pure JS on 100k rows; Native ~2× faster than better-sqlite3 overall.
- **Browser playground** (`examples/playground/`) — full SQL engine in the browser (WASM + IndexedDB), zero server.
- **GitHub Actions CI** — engine smoke tests on Node 18/20/22 + a full ORM compatibility job (Sequelize / Knex / TypeORM).
- `NativeJSQL` storage modes documented (`memory` / `hybrid` / `disk`).
- Tests: zero-dependency smoke suite (`npm test`), ORM suites under `examples/orms/` (`npm run test:orms`).

### Fixed

- `SELECT fn()` now returns MySQL-style column names with parentheses (e.g. `version()`), fixing TypeORM `getVersion()`.
- Multi-aggregate `SELECT` returned only the last column; all columns are returned now.
- `encodeLenenc` / binary result sets hardened against `BigInt` and non-finite numbers.
- npm package slimmed (excluded `examples/browser/node_modules`, `fake-indexeddb`, native build artifacts) — 11MB → ~3.9MB.

### Changed

- Parser and scalar evaluation thread a session context through (`LAST_INSERT_ID()`, `ROW_COUNT()`, `FOUND_ROWS()`, `CONNECTION_ID()`, `DATABASE()`, `@@sysvar` state via `SET`).
- Expanded MySQL `errno` mapping (~25 codes).

### Breaking

- None. All 4.4 changes are additive.

## [4.4.0] — 2026-08-06

### Added

- Redis-compatible server, Web UI, CLI tools, benchmark suite, migration tools, TypeScript declarations, browser playground, CI workflow. *(First release shipping the full toolbox; details folded into 4.4.1, which is the recommended install.)*

### Breaking

- None.

## [4.3.0] — 2026-08-05

### Added

- TypeScript declarations for the package (`index.d.ts`, `wasm/browser.d.ts`).
- Migration tools (`migrate` module + direct function exports).
- CLI export/import commands.
- MySQL deep-compat: `LAST_INSERT_ID()`, `ROW_COUNT()`, `FOUND_ROWS()`, `CONNECTION_ID()`, `DATABASE()`, `@@` system variables, persistent `SET @@sql_mode`.
- ORM test suites in-repo (Sequelize / Knex / TypeORM) and a zero-dependency smoke suite (`npm test`).

### Fixed

- Prepared statements: double `applyParams`, binary protocol result sets, `dataRows` alias, `stripDefault`.
- `autoIncrement NOT NULL` false-positive on DDL import.
- `SELECT` multi-aggregate column loss.

### Breaking

- `SELECT fn()` column names now include parentheses (`version()`), matching MySQL. Code relying on the old bare name must use an alias (`SELECT VERSION() AS v`).

## [4.0.2] — 2026-08-03

### Added

- SQL `WHERE` equality pushdown (point-style filter on indexed columns — measured 808ms → 6ms).
- `COUNT(*)` computed via the engine.
- Bulk `INSERT` in a single batch.

### Fixed

- Explicit `id: 0` now auto-increments correctly (was treated as literal `0`, losing `fields.id`).

### Breaking

- Explicit `id: 0` previously stored literally; it now behaves like "auto-generate next id". Use a real value if you must insert id `0`.

## [4.0.1] — 2026-08-03

### Changed

- README rewritten for v4 (three engines, SQL, storage modes).

### Breaking

- None.

## [4.0.0] — 2026-08-02

### Added

- **Native engine: hybrid & disk storage** — Rust `HybridEngine` (`jsql_open` / `flush_dirty` / `evict` / `close`), Redis-style model: memory-first, async incremental flush, 0.5GB `memReserve`, LRU eviction, lazy reload, per-table `.jsql` files, atomic writes (tmp + rename).
- Ordered schema fields and explicit `id` support.
- `LICENSE` and npm `files` whitelist.

### Changed

- Unified engine API across Native / WASM / Pure JS (`createTable` / `insert` / `findById` / `find` / `updateById` / `removeById` / `dropTable` + `executeSQL`).

### Breaking

- Engine API unification: code written for older 3.x helpers should migrate to the shared engine methods.
- Hybrid/disk storage requires a `path` + `mode` option and is opt-in; default remains in-memory.

## [3.6.0-beta.11] — 2026-07

### Added

- Full SQL engine (CREATE/DROP/INSERT/SELECT/UPDATE/DELETE, `WHERE`/`ORDER BY`/`LIMIT`/`GROUP BY`/`HAVING`, aggregates, prepared `?` statements, `ON DUPLICATE KEY UPDATE`).
- MySQL protocol server (`createMysqlServer`) — prepared statements, binary result sets, `SHOW *`, `information_schema`, transactions, `TRUNCATE TABLE`, `SET`.
- NeDB-compatible layer (`Datastore`) and MySQL client compat (`mysql_compat` — `createConnection` / `createPool`, `[rows, fields]` results).

### Fixed

- beta.11 regression pass: no-column `INSERT` mapping, SQL performance, ODKU, `?` placeholders, `AS` aliases, auto primary keys, errno mapping.

### Breaking

- None beyond engine API unification (see 4.0.0).

## [3.6.0-beta.10] — 2026-07

### Added

- Plugin system (`Plugin`) and module registry (`ModuleManager`, `jsql mod`).
- Unified engine API (`lib/native_client.js`).

## [3.6.0-beta.6] — 2026-07

### Added

- Batch delete/update, compact JSON storage, swap-remove optimization.

## [3.4.0] — 2026-06

### Added

- "Amazing version" — full 3.x feature consolidation.

## [2.0.0] — 2026-06

### Added

- **B-Tree indexes** for range queries.
- **Hash JOIN** support.
- **WAL** + snapshot crash recovery.
- **Transaction isolation**.
- MySQL-style error codes.
- `JSQL-Neo vs MySQL` comparison report.

### Breaking

- Introduced storage layout v2; older 1.x data files require migration.

---

## Archive

- [v3.4.0](https://github.com/vexify-org/JSQL-neo) — 3.4.0 source tag.
- npm keeps a full history of every published version — `npm view jsql-neo versions`.

[Unreleased]: https://github.com/vexify-org/JSQL-neo
[4.4.1]: https://github.com/vexify-org/JSQL-neo/releases/tag/v4.4.1
[4.0.2]: https://github.com/vexify-org/JSQL-neo/releases/tag/v4.0.2
[4.0.1]: https://github.com/vexify-org/JSQL-neo/releases/tag/v4.0.1
[4.0.0]: https://github.com/vexify-org/JSQL-neo/releases/tag/v4.0.0
