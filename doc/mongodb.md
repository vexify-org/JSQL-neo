# MongoDB 协议支持

jsql-neo 原生支持 MongoDB Wire Protocol，可直接使用 MongoDB 官方客户端和驱动连接，无需任何中间件或协议转换层。

## 支持的客户端

| Client | Type | Status |
|---|---|---|
| `mongodb` (官方 Node 驱动) | driver | ✅ full (v4/v5/v6) |
| `mongosh` | shell | ✅ full |
| MongoDB Compass | GUI | ✅ |
| `mongoose` | ODM | ✅ (CRUD + 部分聚合) |

```js
const { MongoClient } = require('mongodb');
const client = new MongoClient('mongodb://127.0.0.1:5432/app');
await client.connect();
const users = client.db('app').collection('users');
await users.insertOne({ name: 'Alice', age: 30 });
const alice = await users.findOne({ name: 'Alice' });
const all = await users.find({ age: { $gte: 18 } }).sort({ age: -1 }).toArray();
await client.close();
```

## Wire Protocol

实现遵循官方 MongoDB Wire Protocol 规范（header + opCode + payload）：

| opCode | Name | Description |
|---|---|---|
| `2004` | OP_QUERY | 遗留查询（`$query` 包装，skip/return） |
| `2005` | OP_REPLY | 响应：flags, cursorID, startingFrom, numberReturned |
| `2012` | OP_COMPRESSED | snappy/zlib 压缩载荷，解压后分发 |
| `2013` | OP_MSG | 现代格式：flags, section kind 0/1, checksum |

**握手说明：** 驱动首先发送 `hello`/`ismaster`；服务器返回 `helloOk: true`、`maxWireVersion`/`minWireVersion`、`maxBsonObjectSize`。OP_QUERY 响应通过 `{ $long: 0 }` 编码游标 ID。OP_COMPRESSED 解压（compressorId 0=snappy, 1=zlib）后正常分发。

## BSON 支持

| BSON type | code | notes |
|---|---|---|
| Double | `0x01` | 浮点数 |
| String | `0x02` | UTF-8 |
| Document | `0x03` | 嵌套文档 |
| Array | `0x04` | 嵌套数组 |
| Binary | `0x05` | generic/function/bytes |
| ObjectId | `0x07` | 12字节ID，自动生成 |
| Boolean | `0x08` | |
| Date (UTC) | `0x09` | int64 毫秒 |
| Null | `0x0A` | |
| RegExp | `0x0B` | pattern + flags |
| Int32 | `0x10` | |
| Int64 | `0x12` | `$long` / `$numberLong` |
| Decimal128 | `0x13` | decimal |
| Timestamp | `0x11` | int64 毫秒 |

编码器支持扩展 JSON 形式（`$oid`、`$numberLong`/`$long`、`$numberDecimal`、`$date`、`$regex`、`$binary`、`$timestamp`），支持任意嵌套。

## 数据库与集合映射

- URL: `mongodb://host:port/<database>`
- 每个 MongoDB 数据库映射为一个引擎实例（等同于 MySQL schema）
- **Collection = table**: `db.users` ↔ `CREATE TABLE users` — 数据互通
- 松散 schema：向不存在的 collection 插入数据时自动创建表（`_ensureTable`）
- BSON ↔ SQL 类型转换：`double→REAL`、`string→TEXT`、`int→INTEGER`、……

## 命令参考

| Command | Description |
|---|---|
| `hello` / `ismaster` / `isMaster` | 握手 |
| `ping` | 心跳检测 |
| `insert` | 插入单条/批量 |
| `find` / `findOne` | 查询（+sort/limit/skip/projection） |
| `count` / `countDocuments` | 计数（基于聚合） |
| `update` | `{ updates: [{ q, u, upsert, multi }] }` |
| `delete` | `{ deletes: [{ q, limit }] }` |
| `findAndModify` | `{ query, update, remove, new, upsert, sort, fields }` |
| `findOneAndUpdate` / `findOneAndDelete` / `findOneAndReplace` | 原子操作 |
| `distinct` | 字段去重 |
| `aggregate` | 聚合管道 |
| `create` / `createCollection` | 显式创建集合 |
| `drop` / `dropCollection` / `dropDatabase` | 删除 |
| `listCollections` / `listDatabases` | 列表 |
| `serverStatus` / `buildInfo` / `getCmdLineOpts` | 元数据 |
| `$cmd` (OP_QUERY) | 命令包装器 |

```js
const r = await coll.findOneAndUpdate(
  { name: 'Alice' },
  { $set: { age: 31 } },
  { upsert: true, returnDocument: 'after' }
);
```

## 查询操作符

| Operator | Description | Example |
|---|---|---|
| `$eq` / `$ne` | 等于 / 不等于 | `{ age: { $eq: 30 } }` |
| `$gt` / `$gte` / `$lt` / `$lte` | 比较 | `{ age: { $gte: 18 } }` |
| `$in` / `$nin` | 列表包含 / 不包含 | `{ status: { $in: ['a','b'] } }` |
| `$exists` | 字段存在性 | `{ email: { $exists: true } }` |
| `$regex` + `$options` | 正则（i/m/s） | `{ name: { $regex: '^A', $options: 'i' } }` |
| `$and` / `$or` / `$nor` | 逻辑组合 | `{ $or: [{a:1},{b:2}] }` |
| `$not` | 取反 | `{ age: { $not: { $gt: 60 } } }` |
| `$type` | BSON 类型匹配 | `{ age: { $type: 'int' } }` |
| `$size` | 数组长度 | `{ tags: { $size: 2 } }` |
| `$elemMatch` | 数组元素匹配 | `{ scores: { $elemMatch: { $gte: 90 } } }` |
| `$all` / `$mod` | 数组包含 / 取模 | `{ tags: { $all: ['a','b'] } }` |

**更新操作符：** `$set` `$unset` `$inc` `$push` `$addToSet` `$pull` `$rename` `$mul`

```js
await coll.find({
  $and: [
    { age: { $gte: 18, $lte: 35 } },
    { $or: [{ plan: 'pro' }, { plan: 'plus' }] },
    { bio: { $regex: '^developer', $options: 'i' } },
  ]
}).sort({ age: -1 }).limit(10).toArray();
```

## 聚合管道

| Stage | Description |
|---|---|
| `$match` | 过滤文档 |
| `$count` | 计数 |
| `$limit` / `$skip` | 分页 |
| `$sort` | 排序（1/-1，多字段） |
| `$project` | 投影 / 派生字段 |
| `$unwind` | 展开数组（preserveNullAndEmptyArrays） |
| `$group` | 分组聚合（`$sum $avg $min $max $first $last`） |
| `$lookup` | 跨集合 left-join |
| `$addFields` | 添加字段 |

**表达式：** `$year/$month/$dayOfMonth/$hour/$minute/$second`、`$sum/$avg/$min/$max`、`$add/$subtract/$multiply/$divide/$mod`、`$concat`、`$toUpper/$toLower`、`$substr`、`$size`、`$arrayElemAt`、`$literal`

```js
const res = await db.collection('orders').aggregate([
  { $match: { status: 'paid' } },
  { $group: { _id: '$customer_id', total: { $sum: '$amount' } } },
  { $sort: { total: -1 } },
  { $limit: 5 },
]).toArray();
```

## 常见问题

**Q: mongosh 认证失败？**

A: mongosh 默认尝试 SCRAM 认证。建议开发环境使用无密码连接 `mongodb://host:port/db`，或配置匹配的用户凭证。

**Q: mongoose 是否支持？**

A: 基本 CRUD 可用。驱动管理的特性（如自动 `_id` ObjectId）需模型配置；`save()/find()/updateOne()` 均正常工作。

**Q: 多文档事务？**

A: 不支持 — 返回明确的 "transactions not supported" 错误。单文档和单集合操作是原子的。
