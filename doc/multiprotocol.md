? Language / 语言: **English** | [简体中文](cn/multiprotocol.md)

# Multi-protocol server

> One TCP port serving MySQL / PostgreSQL / MongoDB / Redis clients against the same data.

## Quick start

```js
const { createMultiServer } = require('jsql-neo');

const srv = createMultiServer({
  port: 3306,        // listening port
  host: '0.0.0.0',   // bind address
  dataDir: './data', // data directory (omit for pure in-memory)
  noAuth: true,      // disable auth (default false)
  auth: { root: { password: 'secret', databases: ['*'] } }, // user table (optional)
  idleProtocol: 'mysql', // protocol assumed when no bytes arrive within 200ms
  sniffTimeout: 200,
});

srv.listen(() => console.log('multiprotocol on', srv.address.port));
// ... later srv.close() to shut down gracefully
```

The equivalent from the command line:

```bash
jsql serve -p 3306 --data-dir ./data --no-auth
```

`jsql serve` is multi-protocol by default; add `--mysql-only` to serve MySQL alone.

## How sniffing works

Once a connection is established, the server collects the first packet and decides using this table:

| First byte / signature | Protocol | Notes |
|---|---|---|
| `0x00` (big-endian Int32 length, < 2^24) | PostgreSQL | PG StartupMessage length header |
| `0x0a` / `0x0d` | MySQL | client handshake protocol version byte |
| Int32LE length + opCode `2004/2012/2013` | MongoDB | OP_QUERY / OP_COMPRESSED / OP_MSG |
| ASCII command / RESP prefix (`* + $ - :`) | Redis | plain command or RESP array |
| No bytes within 200ms | `idleProtocol` (default MySQL) | MySQL clients wait for the server greeting; idle Redis connections also send nothing — adjust with `idleProtocol` |

The implementation lives in `sniffProtocol(buf)` in `lib/multiserver.js` and decides from the first 16 bytes, so misclassification is very unlikely:

- A Redis command always starts with printable ASCII, whereas a Mongo message length almost always starts with a binary byte
- A PG first byte is `0x00`, which cannot be confused with MySQL's `0x0a/0x0d`
- MySQL clients that do not send first (they wait for the greeting) are covered by `sniffTimeout`
- MongoDB OP_MSG supports both kind 0 (command body) and kind 1 (document sequence, the path `insertMany` takes)

## Shared data model

All four SQL / document protocols share a single `Database` engine instance (created lazily per database name):

- MySQL / PG tables ↔ Mongo collections (a row is a document; `_id` maps to the primary key or the whole row)
- A table created via MySQL can be accessed by a Mongo client under the same collection name
- Redis uses its own key namespace (e.g. `app:users:count`) and does not collide with tables

```text
// Internal structure of the multi-protocol server (pseudo-code)
getEngine('app')  // → Database('./data/app')
  ├── mysql handler   ── reads the same engine
  ├── pg handler      ── reads the same engine
  ├── mongo handler   ── reads the same engine
  └── redis handler   ── separate key store
```

## Port and lifecycle management

```js
srv.listen();                  // start listening (idempotent)
srv.address                    // → { address, port } actual address (getter)
srv.close()                    // close all connections, flush all engines, release the port
```

- Each engine runs `engine.stop()` on `close()` (flush + cleanup)
- Disconnected sockets are cleaned up automatically (the `_sockets` set)
- When the port is in use, `onError` is called; by default the error is thrown
