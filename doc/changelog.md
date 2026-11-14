? Language / 语言: **English** | [简体中文](cn/changelog.md)

# Changelog

> Current version: **6.6.2** (2026-11-14)
>
> This page lists **key / important changes** in reverse version order (security fixes, data-corruption fixes, new features, breaking changes).
> For the full entry-by-entry log see [CHANGELOG.md](../CHANGELOG.md) in the repository root.

## 6.6.2 — 2026-11-14 (feature)

### Added
- **Unified network access policy** (new `lib/network-policy.js`): `JSQL_OFFLINE=1|true|yes|on` disables all external network access at once; every genuinely outbound call site must carry a `NETWORK:` comment (why it cannot be done locally / what triggers it / behaviour when offline / target host), while loopback-only sites carry a single `LOCAL-ONLY` note.
- `jsql star --token-check`: queries the GitHub API with `GITHUB_TOKEN` / `gh` and writes the result back to `~/.jsqlmr` — no browser, no OAuth.

### Changed
- **The CLI startup path makes no network requests at all.** Previously every launch synchronously hit `api.github.com` to confirm star status (blocking for up to ~9.5s) just to suppress one line of output; it now reads only the local `~/.jsqlmr`, with zero outbound traffic.
- `jsql update` / `jsql plugin *` / `jsql star` / the install-time native download now short-circuit when offline: they report a readable reason instead of failing silently.

## 6.6.1 — 2026-11-14 (bugfix)

### Fixed
- **#77** SQL `WHERE` uses exact numeric comparison for `BIGINT` columns (previously string dictionary order, so `50 > 1000` was wrongly true).
- **#78** `UNION`/`INTERSECT`/`EXCEPT` dedupe keys use BigInt-safe serialization; `bigint` columns no longer throw `TypeError`.
- **#79** `Table.removeById()` now fires `beforeRemove`/`afterRemove`, so `BEFORE DELETE` triggers work when deleting by id.
- **#80** `AND`/`OR`/`XOR` follow SQL three-valued logic; `UNKNOWN` propagates correctly (no longer collapsing to `FALSE`).
- **#81** NeDB-compatible `$pull` uses the real field name plus NeDB element matching semantics (previously a hard-coded `"k"` key made it a no-op).
- **#82** `DATETIME`/`TIMESTAMP` preserve sub-second precision from string input (no longer silently truncated to whole seconds).
- **#83** `BOOLEAN` columns compare numeric string literals `'1'`/`'0'` with MySQL `BOOL` numeric semantics.
- **#84** Plugin hooks run in descending `priority` order (higher priority first; previously overridden by registration order).

## 6.6.0 — 2026-11-13 (semantics change)

### Breaking
- **Date/time literals now use UTC as the stable reference**: literals without a timezone marker
### Changed files
- `lib/date-types.js`: `toUtcDateString` / `toUtcDateTimeString` (formerly `toLocal*`),
### Fixed
- **Time-zone-independent test assertions**: hard-coded `1577905445` in `test/issue-71-72.test.js`

## 6.5.34 — 2026-11-13

### Fixed
- **#73 `GROUP BY <positional index>` was treated as a constant, collapsing all rows into one group**: the parser handled `GROUP BY 1`
### Added
- `test/issue-73-76.test.js`: 23 regression assertions for 4 issues (each issue covers normal behaviour,

## 6.5.33 — 2026-11-11

### Fixed
- **#69 String arithmetic did not perform MySQL-style numeric prefix conversion**: `'5a' + 1` yielded `"5a1"`
### Tests
- Added `test/issue-69-70.test.js` (52 items): string arithmetic, `!` logical negation,

## 6.5.31 — 2026-11-10

### Fixed (issues #63~#68, each reproduced on 6.5.30 before any change)
- **#63 `POSITION(substr IN str)` parse error**: `IN` is a keyword, and generic function arguments
### Tests
- Added `test/issue-63-68.test.js` (30 items); the Redis part calls

## 6.5.30 — 2026-11-10

### Fixed
- **#58 `ast.rewrite()` could not replace the root node**: replacement was skipped when the root had `parent === null`
### Added
- `test/issue-59.test.js` and `test/issue-60.test.js` regression tests (#58 tests already existed).

## 6.5.28 — 2026-11-08

### Fixed
- **6.5.27 missed two version strings**: the README banner and the index.js header comment were stuck at 6.5.26.
### Added
- `jsql native status` / `refresh` / `verify` (structured `--json` output).
### Performance
- **Result BigInt finalisation moved from generic deep recursion to a compact loop.** Previously every SQL result's rows
### Tests
- Added `test/result-raw.test.js` (23) / `test/native-install.test.js` (7) /
### Issue cleanup
- #45 / #46 / #47 / #48: PR #49 merged and the corresponding regression tests are green (3/9/3/4),

## 6.5.27 — 2026-11-08


## 6.5.26 — 2026-11-07

### Fixed
- **`result.raw` returned wrong values for every computed/aggregate column (issue #43)**:
### Tests
- Neither the README nor the docs described `raw`, and no test asserted on `.raw` —
### Known issues (not fixed in this release)
- `postinstall` on Windows swallows `unlinkSync` failures in its EPERM fallback,

## 6.5.25 — 2026-11-07


## 6.5.24 — 2026-11-06

### Fixed
- **int64 precision loss in the Rust/WASM/Native binding layer (issue #38 follow-up)**: the WASM and Native engines encoded/decoded `int64` as `f64`, inserting BigInt via `lib/wasm_client.js` threw a JSON serialization error, and decimal strings `> 2^53` were truncated. Behaviour now matches the JS engine (6.5.23):

## 6.5.23 — 2026-11-06

### Fixed
- **64-bit integer precision loss above 2^53 (issue #38)**: `integer` / `int` / `bigint` columns were normalised with `Number(v)`, so values `> 2^53-1` (number or decimal string) were silently truncated to 53-bit floats; the SQL path then raised 1292 because the literal parsed as BigInt. The two paths disagreed and both lost precision. BigInt is now supported:
### Notes
- Merging `fix/i38` keeps every 6.5.22 fix: `mysqlNum()` (MySQL string→number coercion) and `bigintExactArith()` coexist; `test` / `test:all` run the union of both test sets (including #38, #39, #40, g4).

## 6.5.22 — 2026-11-06

### Fixed
- **BETWEEN numeric bounds degraded to dictionary-order comparison (issue #39)**: `BETWEEN '9' AND '100'` compared as strings, and `'9' > '100'` made the result empty. Bounds are now compared numerically when the column/bounds parse as numbers (negative signs, decimals, scientific notation supported); plain text columns keep dictionary order.
### Notes
- issue #38 (BigInt serialization) was not part of this release and is fixed in [6.5.23].

## 6.5.21 — 2026-11-05

### Fixed
- **Native engine `add_column` corrupted multi-row tables (issue #22)**: `Table::add_column` inserted in place with `Vec::insert`, leaving later rows' `values_start` unsynchronised, so every row after the first was silently corrupted when a column was added to a table with >1 row. `values` is now rebuilt with each `values_start` recomputed, and data stays intact.

## [Unreleased]
## 6.5.20 — 2026-11-03

### Fixed

- **Native engine silently overwrote the index when inserting duplicate explicit primary keys (data corruption)**: `insert({ id: existing })` inserted a duplicate row and overwrote `pk_index`, "shadowing" the original row (unreachable via `findById`) and diverging from the pure JS engine. All insert paths (`add_rows`, batch fast/slow paths, disk load) now check `pk_index` first and throw `ER_DUP_ENTRY` (MySQL 1062), with the native error code mapped back to `JSQL_Error`. 16 dual-engine regression cases added.

## 6.5.19 — 2026-11-03

### Added

- **jsql 1.0.0 nostalgia compat layer**: new `jsql-neo/compat/v1` (`compatV1`); `V1Database` wraps `Database`, making `createTable` / `dropTable` synchronous, mirroring `db.<table>` accessors, letting `import` infer a schema from rows and restore auto-increment keys, and `export` deep-copy. 67 assertions cover memory/file modes, every 1.0.0 operator, chained queries, constraints and export/import round trips.

## 6.5.18 — 2026-11-03

### Fixed

- **SQL engine correctness (F1–F15)**: `LENGTH`/`OCTET_LENGTH` return UTF-8 byte counts while `CHAR_LENGTH` returns character counts; `CAST(x AS UNSIGNED)` wraps negatives modulo 2^64; `POWER(x, NULL)` returns NULL; `LEFT`/`RIGHT` return `''` for non-positive lengths; `LPAD`/`RPAD` cycle and truncate the padding string correctly.
- **Destructive SQL guard**: new AST-level `findDestructiveSQL()` blocks `DROP` / `TRUNCATE` / `DELETE` / `UPDATE` without WHERE.
- **B-Tree**: `order < 4` normalised to 4, fixing duplicate separator keys / ghost entries.
- **PRIMARY KEY now rejects explicit NULL**, closing a unique-constraint bypass.
- **Error messages**: `%s` substitution is single-pass, so arguments containing `%s` are no longer swallowed.
- **WASM contract**: `getTables()` / `hasTable()` are now synchronous (fixing `SHOW TABLES` raising `tables.map is not a function`); the README was corrected to "a single runtime dependency `@vexify-org/yaggs`".
- **XQL**: `require('@vexify/xql')` corrected to the built-in `lib/xql`.

## 6.5.17 — 2026-10-31

### Fixed

- **Scalar function semantics (B1–B6)**: `LENGTH`/`OCTET_LENGTH` in UTF-8 bytes; `LEFT`/`RIGHT` return `''` for non-positive lengths; `LPAD`/`RPAD` cycle the padding and truncate precisely; `POWER`/`POW` return NULL if either argument is NULL; `CAST(-5 AS UNSIGNED)` = `18446744073709551611`. The regression suite grew to 90 items.

## 6.5.16 — 2026-10-31

### Security

- **Safe mode defaults to a single statement**: `executeSQL` defaults to `maxStatements=1` and rejects `DROP`/`TRUNCATE`/`DELETE`/`UPDATE` (including `WITH ... DELETE`) unless `{ allowWrites: true }` or `{ safety: false }` is passed explicitly. All statements are parsed before execution, so `SELECT 1; DROP TABLE` no longer half-executes. Protocol servers (MySQL / mysql2 / SQLite compat / web console) explicitly allow writes so clients keep working.

### Fixed

- A B-Tree test called `process.exit` before the regression cases, so they never ran; fixed, plus new deterministic insert/delete rebalancing cases (161 items).

## 6.5.15 — 2026-10-30

### Fixed

- **Correlated subquery references to outer qualifiers** (`b.id = a.id`) resolved to NULL: the outer fallback now matches bare column names.
- **`Database.updateById/updateByIds` skipped constraint validation**, allowing `UPDATE ... SET pk = NULL`; now validated.
- New v6.5.14 regression suite (60 items covering C1, H1–H6, M1–M11).

## 6.5.14 — 2026-10-30

### Fixed

- **C1: B-Tree lazy deletion lost index entries** (data corruption) — keys are checked for existence before rebalancing, fixing unique/primary-key constraint failures.
- **H1**: PG now denies by default when no auth is configured, unless `noAuth: true`.
- **H2**: NeDB `$regex` with an invalid pattern no longer matches everything.
- **H3**: Scalar/correlated subqueries in `UPDATE` are materialised per row instead of always being NULL.
- **H4**: `BETWEEN` numeric comparison.
- **H5**: Implicit `NOT NULL` on primary keys enforced on every write path (including `updateById`).
- **H6**: NULL predicates skip the B-Tree fast path.
- **M1–M12**: `%s` substitution order, row deep-copy, migration length preservation, READ_COMMITTED full transaction snapshots, XOR three-valued logic, `REGEXP BINARY`, Web UI XSS escaping, star-nag status codes, plugin hook priority, XQL NULL propagation, Mongo internal field stripping, MySQL sequence fix.

## 6.5.13 — 2026-10-29

### Fixed

- **Registry plugin auto-loading**: when a manifest `entry` was a repo-relative path (e.g. `plugins/xql/index.js`) the entry point was not matched; repo-relative / root-level / `plugins/` subdirectory layouts are all supported now.
- **`jsql plugin` crashed under an npm install**: `src/` was restored to the published manifest.

## 6.5.12 — 2026-10-29

### Added

- **XQL integration**: built-in `xql` plugin (`db.use('xql')`) supporting equality hash indexes and range indexes plus piped syntax (`FROM t |> WHERE … |> LIMIT n`). API: `db.xql()` / `xqlLoad()` / `xqlRefresh()` / `xqlIndex()` / `xqlTables()` / `xqlCollection()` / `xqlClear()`; writes invalidate automatically. No extra dependencies; also installable via `jsql plugin install xql`.

## 6.5.11 — 2026-10-28

### Fixed

- **Boolean three-valued logic**: `TRUE AND TRUE` / `NULL AND TRUE` / `NULL OR FALSE` all returned 0 before; they now follow the SQL truth table.
- **Duplicate column names in CREATE TABLE** now throw `Duplicate column name` instead of silently dropping a column.
- **Invalid JSON/JSONB values** are validated with `JSON.parse` on both engines, throwing `Truncated incorrect object value`.
- **ORDER BY on a missing column** throws `no such column` (aliases / positional indexes excluded).
- **Serialising huge integers**: BigInt is converted to string recursively, fixing `Do not know how to serialize a BigInt`.

## 6.5.10 — 2026-10-28

### Fixed

- **ORDER BY aliases / positional indexes** now sort correctly on non-grouped paths.
- **String comparison is consistent with LIKE** (case-insensitive under the default utf8mb4_general_ci); the new `BINARY expr` forces case sensitivity.
- **UPDATE ... ORDER BY ... LIMIT** implemented symmetrically with DELETE.
- **date ± INTERVAL n UNIT** parses and computes correctly (with end-of-month clamping).

## 6.5.9 — 2026-10-27

### Fixed

- **Large-table aggregation crash**: `MIN`/`MAX` no longer spread a big array with `Math.min(...arr)` (which exceeds V8's argument limit with a RangeError) and iterates instead.
- **Deep JSON stack overflow**: `JSON_DEPTH` now uses an explicit stack loop.
- More than ten large-array `push(...)` sites in Mongo `$min`/`$max`, B-tree, grouping and export were changed to `for...of`, removing the argument-limit dependency.

## 6.5.8 — 2026-10-26

### Security / Fixed

- **Protocol hardening**: length limits in Redis/PG parsing, a frame limit for Mongo wire messages; port conflicts are reported via callback instead of crashing the process.
- **Native module download**: verifies SHA256SUMS, limits redirect depth, and does not forward proxy credentials across origins; new prebuilt linux x64/arm64 musl artifacts.
- **Plugin installation**: validates plugin names and tar manifests, rejects path traversal/symlinks, and uses `execFileSync` to avoid shell injection.
- **JS sandbox**: `mod.js` and SQLite UDFs run in a restricted vm by default; host capabilities require explicit `JSQL_ALLOW_UNSAFE_*`.
- **Migration export**: `exportToFile` writes in paged streams, avoiding loading a whole table into memory.
- Fixed MySQL binary resultset NULL bitmap, PG `$n` parameter binding, and MultiServer cross-protocol shared engine correctness.

## 6.5.7 — 2026-10-24

### Fixed

- Removed the `.php` suffix from star-nag OAuth URLs (`/start.php` → `/start`, `/result.php` → `/result`).

## 6.5.6 — 2026-10-24

### Performance

- **Native primary-key point lookups / updates by PK went from O(n) to O(1)**: Rust `find_rows` / `update_by_filter` / `remove_by_filter` use the `pk_index` hash when the WHERE is "auto-increment integer PK = integer"; `_findRawById` / `_seqIdByPk` call `jsqlFindById` directly. On 200k rows, PK point lookups ×500 went **512.6ms → 6ms** and `updateById` ×200 **201.4ms → 7ms**.
- **Native bulk insert now uses a binary cross-N-API path**: homogeneous batches went **700ms → 365ms** for 200k rows and **812ms** for 500k (roughly on par with better-sqlite3); heterogeneous batches fall back to the JSON path.
- `_assertNoKeyConflictSync` no longer pulls whole tables into JS; a process `exit` hook flushes synchronously before exit, fixing lost writes when exiting right after `updateById`/`removeById`.

## 6.5.5 — 2026-10-24

### Performance

- **WASM `updateById` no longer exports the whole table**: it only checks the primary-key/UNIQUE columns actually present in `updateData` and returns early otherwise; 100k rows went **590ms → 0.8ms per call** (~740×) and 10k rows 13.6ms → 0.10ms.

## 6.5.4 — 2026-10-21

### Changed

- CLI messages (`jsql star` and the startup nag) are now short bilingual English/Chinese sentences; the OAuth callback page text is uniformly English.

## 6.5.3 — 2026-10-21

### Fixed

- **`jsql star` reported `undefined` authorisation results**: it now decides from the state file itself (`done/denied/error` are terminal states) and CLI polling only accepts a done state carrying a boolean `starred`; `callback.php` is idempotent and reuses a stored result on repeated requests.

## 6.5.1 — 2026-10-21

### Added

- **Four protocols on one port**: `jsql serve` starts the sniffing gateway by default, with MySQL / PostgreSQL / MongoDB / Redis sharing one port and one `Database`; `--mysql-only` falls back to MySQL alone.
- MongoDB `OP_MSG` supports kind 1 document sequences (`insertMany`).
- New `test/multiprotocol.test.js` (14 items: four-protocol handshakes + CLI startup, no external drivers).

### Fixed

- **The MongoDB protocol stack received no messages at all**: the message loop mistakenly called a global `process()`.
- Mongo dispatch code missed `await` on async engine methods (`find`/`insert`/`updateByIds`/`removeByIds`).
- Mongo standalone mode now picks the engine by `$db`, consistent with the multi-protocol gateway.
- `_patchRows`/`_removeRows` for collections without a primary key use deep `_rowKey` matching.
- Fixed and brought into CI the previously marked-broken `test/mongo-group.test.js`.

## 6.5.0 — 2026-10-19

### Added

- **CLI startup star prompt** and the **`jsql star` subcommand**: once starred it stays muted forever; other commands merely hint (later beta.5 removed throttling and automatic browser opening); config lives in `~/.jsqlmr`, `JSQL_NO_STAR_NAG=1` mutes it, and it never blocks a command.

### Docs

- Fixed three README claims that did not match the implementation: four protocols on one port was not implemented at the time, the `./wasm` import entry point did not exist, and the `NativeJSQL` export name was wrong.

## 6.4.9 — 2026-10-19

### Fixed

- **Pure JS and Native disagreed on schema field names (a silent correctness bug)**: with the underscored `primary_key` / `auto_increment` spellings, pure JS did not generate auto-increment ids, `findById` missed, and no error was raised. `lib/table.js` now accepts both camelCase and underscored forms.

## 6.4.8 — 2026-10-19

### Performance

- **Native `updateById` / `updateByIds` dropped from a full table scan to O(1)**: the conflict check first computes the primary-key/UNIQUE columns actually touched and returns early if none are. On 200k rows, **246–507ms → 1.52ms**.

## 6.4.7 — 2026-10-19

### Fixed

- **B-Tree structural corruption: `remove()` did not update ancestor separator-key copies**, causing duplicate separators and scrambled queries / data loss. New `_fixSeparators` rebuilds separators top-down; fixed-seed regression cases added.

## 6.4.6 — 2026-10-19

### Fixed

- B-Tree fuzzing now uses a fixed seed (`XQL_BTREE_SEED`) and records failure reasons, exposing a real bug where internal node keys were not kept ordered (structural corruption).

## 6.4.5 — 2026-10-19

### Fixed / Docs

- Fixed the many missing `await`s in `native.test.js` and `regress-5.1.0.js` that caused false failures; native tests moved back into the default `npm test`.
- Documentation corrections: the `js` engine is an explicit option rather than an automatic fallback; `serve` only implemented MySQL at the time; "four protocols" was really "one and a half".

## 6.4.4 — 2026-10-18

### Performance

- **The SQL execution path got 2–3× faster**: per-row `_prefixRow` is skipped for single-table queries without JOINs, and the ORDER BY comparator and SELECT projection are pre-parsed at compile time. `SELECT COUNT(*)` on 100k rows went 41ms → 14ms.
- **Filter predicate compilation (`_compileMatcher`)**: point lookups 13.86ms → 0.96ms (14.4×), range lookups 21.84ms → 2.02ms (10.8×), `LIKE` ×300 about 3900ms → 6ms. A 4000-query differential fuzz test showed zero deviation.

### Fixed

- `IN` lists containing NULL broke the whole predicate; `NOT IN` three-valued logic corrected.
- Window function default frames now follow the SQL standard (`ORDER BY` → cumulative RANGE frame).
- `d->>'$.name'` always returned null; `->` / `->>` support both JSONPath and plain key names.
- Completed six scalar functions that silently returned null: `ASCII` / `CHAR` / `SPACE` / `FIELD` / `ELT` / `JSON_ARRAY_LENGTH`.
- Revived `test/extra-coverage.test.js` (68 items), which had never run.

## 6.4.0 — 2026-10-17

### Added

- **`ALTER TABLE ... RENAME TO` / `RENAME COLUMN` / `DROP INDEX` actually take effect** (they previously returned `ok:true` with no operation).
- Plugin registry CLI (`jsql plugin install`), Unicode identifiers and hex literals, `SAVEPOINT` / `ROLLBACK TO` / `RELEASE`, recursive CTEs.
- Hook abort semantics (`return false` / `throw` take effect), content-based DELETE matching for tables without a primary key, protocol sniffing, supply-chain hardening (B1–B5).

### Fixed

- Fixed JSON path parsing, B-Tree `borrowFromLeft` parent keys, ORDER BY NULL, BTree numeric prefix keys, BigInt LIMIT, subquery depth limits, UPDATE safety warnings and more.

## 6.3.11 – 6.3.25 — 2026-10-12 ~ 10-13

A large batch of bug fixes (P0/P1/P2/P3), mainly covering:

- Storage / WAL: WAL recovery, live references, `updateById` constraint validation, `truncate` soft delete, file-lock TOCTOU.
- SQL: bit shifts and unary minus, non-numeric arithmetic, `SELECT *` and JOIN column handling, ALTER, DDL cache, foreign key RESTRICT, `UNION` dedupe, SELECT ordering, `STRLEN` in UTF-8 bytes.
- Redis / PG / Mongo: `WRONGTYPE`, `lrange` bounds, deleting keys for empty lists, `delete`/`dropDatabase`, lenenc `0xfe` 8 bytes, protocol-layer path traversal.
- Compat layer: MySQL connection pooling, Date overflow validation, nedb comparison, `escapeValue` double escaping.
- Performance: `insertMany` optimisation.

## 6.3.10 — 2026-10-10

- fix(mongo): completed `$group` aggregation — field-level sum/avg/min/max/first/last
- fix: resource leaks in mysql_server / redis_server / multiserver / tui
- fix: nedb_compat error swallowing, `limit=0` bounds
- fix: `mod.js` path traversal protection
- fix: MySQL binary resultset NULL row handling, column names wrapped in `String()`
- docs: the long README was split into modular `doc/` pages; jsql.vexify.top deployment notes added

## 6.3.7 – 6.3.9 — 2026-10-10

- Fixed 15 bugs (B-Tree cleanup, timer leaks, signal handling, `truncate` soft delete, `lrange` bounds, `insertMany` performance, file-lock TOCTOU, JOIN field conflicts, …)
- Added `DROP INDEX` and recursive CTEs (`WITH RECURSIVE`)

## 6.3.6 — 2026-10-05

### Performance

- **WHERE equality predicates pushed down to the storage layer, making primary-key point lookups 420× faster** (P0): `SELECT * FROM t WHERE id = 12345` went 88ms → 0.21ms; the SELECT / UPDATE / DELETE paths are all optimised. Only equality chains under AND are pushed down; OR/range/IN/function/subquery keep the old path.

### Fixed

- **Bulk delete on tables without a primary key deleted the wrong rows** (data corruption)
- **UPDATE did not validate conflicts when changing primary-key/unique columns**
- **`+` silently performed string concatenation** → corrected to MySQL/SQLite arithmetic semantics
- **Aggregate functions could not participate in arithmetic** (e.g. `SELECT SUM(sal)/COUNT(*)`)
- `updateById` constraint exceptions missed `await` on a real `require('jsql-neo')` install

## 6.3.5 — 2026-10-05

- Core stability fixes (found by stress testing on real Linux environments)
- Multi-protocol server stability improvements

## Earlier versions

See the full changelog in [../CHANGELOG.md](../CHANGELOG.md).
