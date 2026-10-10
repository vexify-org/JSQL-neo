# Redis 协议支持

JSQL-NEO 内置完整的 Redis RESP2 协议兼容层，支持主流 Redis 客户端直连，数据与其他协议（MySQL / PostgreSQL / MongoDB）共享同一个引擎实例。

---

## 支持的客户端

| 客户端 | 类型 | 状态 |
|---|---|---|
| `ioredis` | Node.js driver | ✅ 完整支持 |
| `node-redis` (v4) | Node.js driver | ✅ 完整支持 |
| `redis-cli` | CLI | ✅ 完整支持 |
| `redis-benchmark` | 压测工具 | ✅ 完整支持 |
| RedisInsight / Another Redis Desktop Manager | GUI 工具 | ✅ 完整支持 |

> JSQL-NEO 的 Redis 兼容基于 RESP2，所有标准 Redis 客户端均可直连，无需任何修改。

**快速示例：**

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

## 支持的数据类型

| 类型 | 内部实现 | 支持的命令 |
|---|---|---|
| **String** | 内部字符串 | `SET GET MSET MGET SETNX INCR DECR INCRBY DECRBY APPEND STRLEN` |
| **Hash** | 字段值映射 | `HSET HGET HGETALL HKEYS HVALS HLEN HEXISTS HDEL` |
| **List** | 有序数组 | `LPUSH RPUSH LPOP RPOP LRANGE LLEN LREM LINDEX` |
| **Set** | 无序去重集合 | `SADD SREM SMEMBERS SISMEMBER SCARD` |
| **Sorted Set** | 分值排序 | `ZADD ZRANGE ZREVRANGE ZSCORE ZCARD ZREM ZINCRBY` |

所有数据类型共享同一个键命名空间 — 先执行 `SET a 1` 再执行 `LPUSH a x` 会返回 `WRONGTYPE` 错误（与标准 Redis 行为一致）。

---

## 命令参考

### 通用命令

`PING [msg]`、`SELECT idx`、`AUTH user pass`、`ECHO msg`、`QUIT`、`INFO [section]`、`KEYS pattern`、`DBSIZE`、`FLUSHDB`/`FLUSHALL`、`TYPE key`、`EXPIRE key sec`、`TTL key`、`PERSIST key`。

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
HGETALL key          # 返回扁平数组 [field, value, ...]
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
LRANGE key start stop      # 支持负索引，如 LRANGE key 0 -1
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
ZRANGE key start stop [WITHSCORES]     # 升序
ZREVRANGE key start stop [WITHSCORES]  # 降序
ZSCORE key member
ZCARD key
ZREM key member [member ...]
ZINCRBY key increment member
```

**示例 — 排行榜：**

```bash
redis-cli -p 5432 ZADD leaderboard 100 alice 90 bob 110 carol
redis-cli -p 5432 ZREVRANGE leaderboard 0 2 WITHSCORES
# 1) "carol" 2) "110" 3) "alice" 4) "100" 5) "bob" 6) "90"
```

---

## TTL 与持久化

- `SET ... EX/PX` 和 `EXPIRE` 命令均支持；过期键采用惰性删除（访问时清理）
- `TTL key` 返回剩余秒数；`-1` = 无过期时间，`-2` = 键不存在
- Redis 命名空间随引擎快照一起持久化（`stop()` 时保存，重启后完整恢复）
- 多参数命令（`MSET`、`ZADD` 等）原子提交

---

## FAQ

**Q: `redis-cli` 报 `NOAUTH` 错误？**

A：服务器默认需要认证。开发环境使用 `--no-auth` 启动，生产环境请配置强密码。

**Q: 支持 Redis Cluster 或 Sentinel 吗？**

A：不支持。JSQL-NEO 是单实例数据库，所有标准命令均完全兼容。如需分布式，请自行在上层实现分片。

**Q: 支持 pub/sub（`SUBSCRIBE`）吗？**

A：不支持，`SUBSCRIBE` 会返回明确错误提示。普通读写命令均正常工作。

**Q: Redis 数据与 MySQL/PostgreSQL/MongoDB 数据是隔离的吗？**

A：Redis 键（如 `app:users:count`）与 SQL 表（`CREATE TABLE users`）使用独立的命名空间，不会互相覆盖，但都存储在同一个数据文件中。
