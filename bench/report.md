# JSQL-NEO Benchmark

Rows: 100,000  |  Machine: linux x64 / Node v24.18.1

| Engine | Insert | Insert/s | Point query (500x) | Range query (500x) | Count | Update (200x) | Total |
|--------|--------|----------|--------------------|--------------------|-------|--------------|-------|
| Pure JS | 262ms | 0.38M | 11278ms | 18138ms | 1ms | 5ms | 29684ms |
| Native | 151ms | 0.66M | 930ms | 685ms | 0ms | 1ms | 1767ms |
| better-sqlite3 | 250ms | 0.40M | 3258ms | 149ms | 1ms | 0ms | 3658ms |
| sql.js | 331ms | 0.30M | 5852ms | 366ms | 3ms | 18ms | 6570ms |

Notes: Pure JS = in-memory `Database`; Native = Rust N-API addon; sqlite = better-sqlite3 (WAL); sql.js = WASM sqlite.
