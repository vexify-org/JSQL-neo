? Language / 语言: **English** | [简体中文](cn/redis.md)

# Redis protocol support

JSQL-NEO ships a complete Redis RESP2 compatibility layer. Mainstream Redis clients connect directly, and Redis data shares the same engine instance as the other protocols (MySQL / PostgreSQL / MongoDB).

---

## Supported clients

| Client | Type | Status |
|---|---|---|
| `ioredis` | Node.js driver | ✅ full support |
| `node-redis` (v4) | Node.js driver | ✅ full support |
| `redis-cli` | CLI | ✅ full support |
| `redis-benchmark` | load testing tool | ✅ full support |
| RedisInsight / Another Redis Desktop Manager | GUI tools | ✅ full support |

> JSQL-NEO's Redis compatibility is built on RESP2, so any standard Redis client connects unchanged.

**Quick example:**

```js
const Redis = require('ioredis');
const redis = new Redis({ host: '127.0.0.1', port: 5432 });

await redis.set('k', 'v');
await redis.hset('h', 'field', 'value');
await redis.zadd('rank', 100, 'alice', 90, 'bob');
const top = await redis.zrevrange('rank', 0, 1, 'WITHSCORES');
console.log(top);
// [ 'alice', '100', 'bob', '90' ]

await redis.quit();
```

---

## Supported data types

| Type | Internal representation | Supported commands |
|---|---|---|
| **String** | plain string | `SET GET MSET MGET SETNX INCR DECR INCRBY DECRBY APPEND STRLEN` |
| **Hash** | field-value map | `HSET HGET HGETALL HKEYS HVALS HLEN HEXISTS HDEL` |
| **List** | ordered array | `LPUSH RPUSH LPOP RPOP LRANGE LLEN LREM LINDEX` |
| **Set** | unordered unique set | `SADD SREM SMEMBERS SISMEMBER SCARD` |
| **Sorted Set** | score-ordered set | `ZADD ZRANGE ZREVRANGE ZSCORE ZCARD ZREM ZINCRBY` |

All data types share one key namespace — running `SET a 1` and then `LPUSH a x` returns a `WRONGTYPE` error, matching standard Redis behaviour.

---

## Command reference

### General commands

`PING [msg]`, `SELECT idx`, `AUTH user pass`, `ECHO msg`, `QUIT`, `INFO [section]`, `KEYS pattern`, `DBSIZE`, `FLUSHDB`/`FLUSHALL`, `TYPE key`, `EXPIRE key sec`, `TTL key`, `PERSIST key`.

### String

```bash
SET key value [EX seconds] [PX milliseconds] [NX] [XX]
GET key
MSET k1 v1 [k2 v2 ...]
MGET k1 [k2 ...]
SETNX key value
INCR / INCRBY key [n]
DECR / DECRBY key [n]
APPEND key value
STRLEN key
```

### Hash

```bash
HSET key field value [field value ...]
HGET key field
HGETALL key          # returns a flat array [field, value, ...]
HKEYS key
HVALS key
HLEN key
HEXISTS key field
HDEL key field [field ...]
```

### List

```bash
LPUSH key value [value ...]
RPUSH key value [value ...]
LPOP key
RPOP key
LRANGE key start stop      # negative indexes supported, e.g. LRANGE key 0 -1
LLEN key
LINDEX key index
LREM key count value
```

### Set

```bash
SADD key member [member ...]
SREM key member [member ...]
SMEMBERS key
SISMEMBER key member
SCARD key
```

### Sorted Set

```bash
ZADD key score member [score member ...]
ZRANGE key start stop [WITHSCORES]     # ascending
ZREVRANGE key start stop [WITHSCORES]  # descending
ZSCORE key member
ZCARD key
ZREM key member [member ...]
ZINCRBY key increment member
```

**Example — a leaderboard:**

```bash
redis-cli -p 5432 ZADD leaderboard 100 alice 90 bob 110 carol
redis-cli -p 5432 ZREVRANGE leaderboard 0 2 WITHSCORES
# 1) "carol" 2) "110" 3) "alice" 4) "100" 5) "bob" 6) "90"
```

---

## TTL and persistence

- `SET ... EX/PX` and `EXPIRE` are both supported; expired keys are removed lazily (on access)
- `TTL key` returns the remaining seconds; `-1` = no expiry, `-2` = key does not exist
- The Redis namespace is persisted with the engine snapshot (saved on `stop()`, fully restored on restart)
- Multi-argument commands (`MSET`, `ZADD`, …) commit atomically

---

## FAQ

**Q: `redis-cli` reports `NOAUTH`?**

A: The server requires authentication by default. Use `--no-auth` in development and configure strong passwords in production.

**Q: Are Redis Cluster or Sentinel supported?**

A: No. JSQL-NEO is a single-instance database; all standard commands are fully compatible. For distribution, shard at the application layer.

**Q: Is pub/sub (`SUBSCRIBE`) supported?**

A: No — `SUBSCRIBE` returns an explicit error. Regular read/write commands all work.

**Q: Is Redis data isolated from MySQL/PostgreSQL/MongoDB data?**

A: Redis keys (e.g. `app:users:count`) and SQL tables (`CREATE TABLE users`) use separate namespaces and never overwrite each other, but both live in the same data file.
