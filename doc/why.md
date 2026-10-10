# Why JSQL-NEO

## 项目简介

JSQL-NEO 是一个嵌入式数据库，使用 Rust 编写的核心引擎，支持 **MySQL、PostgreSQL、MongoDB、Redis** 四种协议，一个 npm 包、零运行时依赖，同时支持原生（Native）和浏览器（WASM）运行。

## 为什么选择 JSQL-NEO？

大多数嵌入式数据库迫使你在以下三点中做选择：

- **原生速度**（Native 性能）
- **可移植性**（WASM 浏览器运行）
- **熟悉协议**（兼容现有工具生态）

JSQL-NEO 让三者兼得：

| 对比维度 | JSQL-NEO | better-sqlite3 | sql.js (WASM) | LevelDB | local redis/mongo |
|---|---|---|---|---|---|
| 原生速度（Rust N-API） | ✅ | ✅ | ❌ | ✅ | ✅ |
| 浏览器运行（WASM） | ✅ | ❌ | ✅ | ❌ | ❌ |
| 零运行时依赖 | ✅ | ✅ | ✅ | ✅ | ❌ |
| MySQL 协议 | ✅ | ❌ | ❌ | ❌ | ❌ |
| PostgreSQL 协议 | ✅ | ❌ | ❌ | ❌ | ❌ |
| MongoDB Wire Protocol | ✅ | ❌ | ❌ | ❌ | ❌ |
| Redis RESP2 | ✅ | ❌ | ❌ | ❌ | ❌ |
| 一个端口，全协议 | ✅ | ❌ | ❌ | ❌ | ❌ |
| 交互式 TUI | ✅ | ❌ | ❌ | ❌ | ❌ |

核心亮点：

- **一套引擎，三种形态** — `native`（Rust N-API）、`wasm`（同一 Rust 核心编译为 WebAssembly）、`js`（纯 JS 回退）。自动降级：native → wasm → js。
- **真正的 Wire Protocol，不是模拟器** — 手写的 MySQL 4.1+、PostgreSQL Wire Protocol v3（SCRAM-SHA-256）、MongoDB OP_MSG/OP_QUERY（+ 压缩）、Redis RESP2 协议栈。
- **一个端口，连接所有客户端** — 首字节 sniffing 自动路由，MySQL / PostgreSQL / MongoDB / Redis 客户端访问**同一份数据**。
- **完整 SQL** — DDL/DML、JOIN、子查询、带保存点的事务、视图、索引、约束、89 个标量函数、窗口函数和 CTE 基础支持。
- **文档语义** — MongoDB 风格操作符（`$gt`、`$regex`、`$elemMatch` 等）、聚合管道（`$match`、`$group`、`$sort` 等）。
- **KV 语义** — 五种 Redis 数据类型、TTL、快照持久化。
- **零依赖 TUI** — 完整行编辑、持久历史、补全、CJK 友好的表格。
- **迁移工具** — 导入 `mysqldump` 输出，导出/导入 JSON 和 CSV。

## Feature Overview

### 多协议服务器（核心功能）

```
┌───────────────────────────────────────────────────────────────┐
│                    jsql serve --pg -p 5432                     │
│                     (single TCP port)                          │
│                                                                │
│  mysql2 ──┐                                                   │
│  Sequelize┤                                                   │
│  psql     ─┤   ┌─────────────────────────────────┐            │
│  pgAdmin   ─┤──►│  protocol sniffing (first bytes)│            │
│  mongosh   ─┤   └─────────────────────────────────┘            │
│  Compass    ─┤       │        │        │        │             │
│  ioredis    ─┤       ▼        ▼        ▼        ▼             │
│  redis-cli  ─┘   ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐         │
│                   │ MySQL│ │ PG   │ │ Mongo│ │ Redis│         │
│                   └──────┘ └──────┘ └──────┘ └──────┘         │
│                       └───────┬───────┘                       │
│                               ▼                               │
│                      ┌─────────────────┐                     │
│                      │  shared engine  │                     │
│                      │  (one data dir) │                     │
│                      └─────────────────┘                     │
└───────────────────────────────────────────────────────────────┘
```

用 `psql` 写入，用 `mysql2` 读取，用 `mongosh` 查询，用 `redis-cli` 缓存 — **同一端口，同一份数据**。

### 四种语义，一套引擎

| 语义 | 特性 |
|---|---|
| MySQL 语义 | `AUTO_INCREMENT`、`ON DUPLICATE KEY UPDATE`、`information_schema`、`SHOW` |
| PostgreSQL 语义 | `SERIAL`、`ILIKE`、`ON CONFLICT`、JSONB、`RETURNING`、预处理语句 |
| MongoDB 语义 | 操作符、`updateOne`/`deleteMany`、聚合管道 |
| Redis 语义 | 5 种数据类型、TTL、快照持久化 |

### 运行形态

| 形态 | 入口 | 适用场景 |
|---|---|---|
| 嵌入式（内存） | `new Database(':memory:')` | 测试、缓存 |
| 嵌入式（磁盘） | `new Database('./data/db')` | 单进程应用 |
| 服务器（4 协议） | `createMultiServer(...)` / `jsql serve --pg` | 多客户端、微服务 |
| 浏览器（WASM） | `JSQL`（lib/wasm_client） | 浏览器内查询 |
| 交互终端 | `jsql tui` | 手动管理、调试 |
