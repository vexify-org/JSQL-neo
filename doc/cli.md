? Language / 语言: **English** | [简体中文](cn/cli.md)

# CLI Commands

## Quick start

```bash
npm install -g jsql-neo
# or use npx directly
npx jsql-neo <command>
```

## serve — single-port multi-protocol server

```bash
# Start the multi-protocol server (foreground): one port accepts MySQL / PostgreSQL / MongoDB / Redis
jsql serve --port 3306 --data-dir ./data

# All options
jsql serve --port 3306 --host 127.0.0.1 --data-dir ./data --no-auth --log

# Serve the MySQL protocol only (legacy behaviour)
jsql serve --port 3306 --mysql-only
```

| Option | Description |
| --- | --- |
| `--port`, `-p` | Listening port (default 3306) |
| `--host` | Bind address (default 127.0.0.1) |
| `--data-dir` | Data directory |
| `--no-auth` | Allow unauthenticated connections |
| `--log` | Print executed queries to stdout |
| `--mysql-only` | Start the MySQL wire protocol only, no sniffing |

Connecting:

```bash
mysql -h 127.0.0.1 -P 3306 -u root
psql "host=127.0.0.1 port=3306 user=postgres dbname=app"
mongosh "mongodb://127.0.0.1:3306/app?directConnection=true"
redis-cli -h 127.0.0.1 -p 3306 PING
```

Protocols are sniffed from the first packet of each connection: `0x00` → PostgreSQL,
`0x0a/0x0d` → MySQL, OP_MSG/OP_QUERY → MongoDB, anything else is treated as Redis.
MySQL clients wait for the server greeting to arrive first, so a connection that
sends nothing within 200ms is treated as MySQL by default (change this with
`idleProtocol` set to `redis` / `pg` / `mongo`).

> The `--mysql` / `--pg` / `--redis` / `--mongo` flags that used to appear in the docs
> were never implemented; protocol sniffing handles all of them now. `--password` /
> `--auto-save` / `--save-interval` likewise do not exist.

### Multi-protocol: Node API

Assemble the same listener in code:

```js
const { createMultiServer } = require('jsql-neo');

const srv = createMultiServer({
  port: 3306,
  host: '0.0.0.0',
  dataDir: './data',
  noAuth: true,
});
srv.listen(() => console.log('listening on', srv.address.port));
```

You can also start a single protocol stack on its own port
(`createPgServer` / `createMongoServer` / `createRedisServer`).

## ui — Web UI

```bash
# Start the web management UI
jsql ui --port 8080
jsql ui --port 8080 --data-dir ./data
```

Open http://localhost:8080 in your browser.

## tui — interactive terminal

```bash
# Interactive SQL terminal
jsql tui
jsql tui --data-dir ./data
```

Features: line editing, history, Tab completion, CJK character alignment, meta commands (`.tables`, `.schema`, …).

## redis — Redis protocol server

```bash
jsql redis --port 6379 --data-dir ./data
```

## bench — benchmarks

```bash
# Built-in benchmark
jsql bench
jsql bench --rows 10000 --iterations 100
```

## export / import — data migration

```bash
# Export a single table (JSON or CSV; streamed, not loaded fully into memory)
jsql export users backup.json
jsql export orders orders.csv --db ./data/app.json

# Import (auto-detects .sql / .json / .csv)
jsql import dump.sql --db ./data/app.json
jsql import data.json --db ./data/app.json
jsql import data.csv --table users --db ./data/app.json
```

| Option | Description |
| --- | --- |
| `--db` | Target database file (default `./db.json`) |
| `--table` | Target table for CSV import (required) |
| `--strict` | Abort on the first import error |
| `--json` | Emit machine-readable output |

## plugin — plugin registry

```bash
jsql plugin list
jsql plugin search <keyword>
jsql plugin install <name>
jsql plugin uninstall <name>
jsql plugin info <name>
```

Installed plugins (such as `xql`) load automatically on `new Database()`; you can also call `db.use('xql')` in code.

## version — version info

```bash
jsql version
# jsql-neo v6.6.2
# engine: native
# node: v22.10.0
```

## Common options

| Option | Description |
| --- | --- |
| `--port, -p` | Port number (available for `serve` / `ui` / `redis` / `tui`) |
| `--host` | Bind address (default 127.0.0.1) |
| `--data-dir, -d` | Data directory |
| `--no-auth` | Allow unauthenticated connections (local development only) |
| `--log` | Print executed queries / commands to stdout |
| `--json` | JSON output (export / import / bench / plugin, etc.) |

> The `--password` / `--auto-save` / `--save-interval` / `--verbose` flags from older
> docs do not exist. For authentication use `--auth` (`redis` / `server`) or
> `--auth-token` (`ui`).
