? Language / 语言: **English** | [简体中文](cn/mongodb.md)

# MongoDB protocol support

jsql-neo natively supports the MongoDB Wire Protocol, so the official MongoDB clients and drivers connect directly — no middleware or protocol translation layer required.

## Supported clients

| Client | Type | Status |
|---|---|---|
| `mongodb` (official Node driver) | driver | ✅ full (v4/v5/v6) |
| `mongosh` | shell | ✅ full |
| MongoDB Compass | GUI | ✅ |
| `mongoose` | ODM | ✅ (CRUD + part of aggregation) |

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

## Wire protocol

The implementation follows the official MongoDB Wire Protocol specification (header + opCode + payload):

| opCode | Name | Description |
|---|---|---|
| `2004` | OP_QUERY | legacy query (`$query` wrapper, skip/return) |
| `2005` | OP_REPLY | response: flags, cursorID, startingFrom, numberReturned |
| `2012` | OP_COMPRESSED | snappy/zlib compressed payload, decompressed and dispatched |
| `2013` | OP_MSG | modern format: flags, section kind 0/1, checksum |

**Handshake notes:** the driver first sends `hello`/`ismaster`; the server returns `helloOk: true`, `maxWireVersion`/`minWireVersion`, and `maxBsonObjectSize`. OP_QUERY responses encode the cursor ID via `{ $long: 0 }`. OP_COMPRESSED payloads are decompressed (compressorId 0=snappy, 1=zlib) and dispatched normally.

## BSON support

| BSON type | code | notes |
|---|---|---|
| Double | `0x01` | floating point |
| String | `0x02` | UTF-8 |
| Document | `0x03` | nested document |
| Array | `0x04` | nested array |
| Binary | `0x05` | generic/function/bytes |
| ObjectId | `0x07` | 12-byte ID, generated automatically |
| Boolean | `0x08` | |
| Date (UTC) | `0x09` | int64 milliseconds |
| Null | `0x0A` | |
| RegExp | `0x0B` | pattern + flags |
| Int32 | `0x10` | |
| Int64 | `0x12` | `$long` / `$numberLong` |
| Decimal128 | `0x13` | decimal |
| Timestamp | `0x11` | int64 milliseconds |

The encoder supports extended JSON forms (`$oid`, `$numberLong`/`$long`, `$numberDecimal`, `$date`, `$regex`, `$binary`, `$timestamp`) with arbitrary nesting.

## Database and collection mapping

- URL: `mongodb://host:port/<database>`
- Each MongoDB database maps to one engine instance (equivalent to a MySQL schema)
- **Collection = table**: `db.users` ↔ `CREATE TABLE users` — the data is shared
- Schemaless: inserting into a non-existent collection creates the table automatically (`_ensureTable`)
- BSON ↔ SQL type mapping: `double→REAL`, `string→TEXT`, `int→INTEGER`, …

## Command reference

| Command | Description |
|---|---|
| `hello` / `ismaster` / `isMaster` | handshake |
| `ping` | heartbeat |
| `insert` | single/bulk insert |
| `find` / `findOne` | query (+sort/limit/skip/projection) |
| `count` / `countDocuments` | count (aggregation-based) |
| `update` | `{ updates: [{ q, u, upsert, multi }] }` |
| `delete` | `{ deletes: [{ q, limit }] }` |
| `findAndModify` | `{ query, update, remove, new, upsert, sort, fields }` |
| `findOneAndUpdate` / `findOneAndDelete` / `findOneAndReplace` | atomic operations |
| `distinct` | distinct field values |
| `aggregate` | aggregation pipeline |
| `create` / `createCollection` | create a collection explicitly |
| `drop` / `dropCollection` / `dropDatabase` | drop |
| `listCollections` / `listDatabases` | listing |
| `serverStatus` / `buildInfo` / `getCmdLineOpts` | metadata |
| `$cmd` (OP_QUERY) | command wrapper |

```js
const r = await coll.findOneAndUpdate(
  { name: 'Alice' },
  { $set: { age: 31 } },
  { upsert: true, returnDocument: 'after' }
);
```

## Query operators

| Operator | Description | Example |
|---|---|---|
| `$eq` / `$ne` | equal / not equal | `{ age: { $eq: 30 } }` |
| `$gt` / `$gte` / `$lt` / `$lte` | comparison | `{ age: { $gte: 18 } }` |
| `$in` / `$nin` | in / not in a list | `{ status: { $in: ['a','b'] } }` |
| `$exists` | field existence | `{ email: { $exists: true } }` |
| `$regex` + `$options` | regular expression (i/m/s) | `{ name: { $regex: '^A', $options: 'i' } }` |
| `$and` / `$or` / `$nor` | logical combination | `{ $or: [{a:1},{b:2}] }` |
| `$not` | negation | `{ age: { $not: { $gt: 60 } } }` |
| `$type` | BSON type match | `{ age: { $type: 'int' } }` |
| `$size` | array length | `{ tags: { $size: 2 } }` |
| `$elemMatch` | array element match | `{ scores: { $elemMatch: { $gte: 90 } } }` |
| `$all` / `$mod` | array containment / modulo | `{ tags: { $all: ['a','b'] } }` |

**Update operators:** `$set` `$unset` `$inc` `$push` `$addToSet` `$pull` `$rename` `$mul`

```js
await coll.find({
  $and: [
    { age: { $gte: 18, $lte: 35 } },
    { $or: [{ plan: 'pro' }, { plan: 'plus' }] },
    { bio: { $regex: '^developer', $options: 'i' } },
  ]
}).sort({ age: -1 }).limit(10).toArray();
```

## Aggregation pipeline

| Stage | Description |
|---|---|
| `$match` | filter documents |
| `$count` | count |
| `$limit` / `$skip` | pagination |
| `$sort` | sort (1/-1, multiple fields) |
| `$project` | projection / derived fields |
| `$unwind` | expand arrays (preserveNullAndEmptyArrays) |
| `$group` | grouped aggregation (`$sum $avg $min $max $first $last`) |
| `$lookup` | cross-collection left join |
| `$addFields` | add fields |

**Expressions:** `$year/$month/$dayOfMonth/$hour/$minute/$second`, `$sum/$avg/$min/$max`, `$add/$subtract/$multiply/$divide/$mod`, `$concat`, `$toUpper/$toLower`, `$substr`, `$size`, `$arrayElemAt`, `$literal`

```js
const res = await db.collection('orders').aggregate([
  { $match: { status: 'paid' } },
  { $group: { _id: '$customer_id', total: { $sum: '$amount' } } },
  { $sort: { total: -1 } },
  { $limit: 5 },
]).toArray();
```

## FAQ

**Q: mongosh authentication fails?**

A: mongosh attempts SCRAM authentication by default. For development, connect without credentials (`mongodb://host:port/db`), or configure matching user credentials.

**Q: Is mongoose supported?**

A: Basic CRUD works. Driver-managed features (such as automatic `_id` ObjectId) need model configuration; `save()/find()/updateOne()` all work.

**Q: Multi-document transactions?**

A: Not supported — an explicit "transactions not supported" error is returned. Single-document and single-collection operations are atomic.
