? 语言 / Language: **简体中文** | [English](README.md)

# JSQL-NEO

> **一个引擎，通吃所有客户端** — Rust 驱动的嵌入式数据库，说你的语言：
> MySQL、PostgreSQL、MongoDB、Redis、SQL、TypeScript，**以及浏览器**。

> **v6.6.2** — 稳定版 · [github.com/vexify-org/JSQL-neo](https://github.com/vexify-org/JSQL-neo) · [jsql.vexify.top](https://jsql.vexify.top)

![Engines](https://img.shields.io/badge/engines-Native%20%7C%20WASM%20%7C%20Pure%20JS-7ee787)
![MySQL](https://img.shields.io/badge/protocol-MySQL%20compatible-1f6feb)
![PostgreSQL](https://img.shields.io/badge/protocol-PostgreSQL%20compatible-336791)
![Redis](https://img.shields.io/badge/protocol-Redis%20RESP2-f03c15)
![MongoDB](https://img.shields.io/badge/protocol-MongoDB%20Wire%20Protocol-589636)
![TUI](https://img.shields.io/badge/tui-zero--dependency-ff9800)
![ZERO](https://img.shields.io/badge/dependencies-ZERO-8957e5)
![WASM](https://img.shields.io/badge/runs%20in-Browser%20%28WASM%29-79c0ff)

---

## 演示

![JSQL-NEO 终端演示](doc/demo.gif)

一段真实的 `jsql tui` 会话（v6.5.25）：64 位整数精度、JOIN、NULL 语义、
保存点回滚 —— 全部在同一个内存引擎里完成，深色背景渲染。

[MP4 版本](doc/demo.mp4) · [asciinema 录像](doc/demo.cast)

---

## ? 快速开始

### 一行安装

```bash
curl -fsSL jsql.vexify.top/setup | bash
```

或在 PowerShell（Windows）中：

```powershell
irm jsql.vexify.top/setup | iex
```

### npm 安装

```bash
npm install jsql-neo
```

**JSQL-NEO** 是一个 Rust 驱动的嵌入式数据库，只有**一个运行时依赖**（`@vexify-org/yaggs`，仅 `jsql` CLI 的参数解析使用）—— 无需编译原生库，无需安装系统依赖。它可在 Node.js、CLI、Web UI 和浏览器（WASM）中运行。

- **四种 wire 协议共用一个端口** — `jsql serve` 同时接受 MySQL、PostgreSQL、MongoDB 和 Redis 客户端；`mysql2`、`pg`、`mongodb` 与 `ioredis` 可直接连接
- **几乎零依赖** — 只有 `@vexify-org/yaggs`（CLI 参数解析）；无需编译原生库，无需安装系统依赖
- **三引擎，同一套 API** — `native`（Rust N-API）、`wasm`（同一 Rust 核心）、`js`（纯 JS）
- **主键查找与更新 O(1)** — 哈希索引，无全表扫描；无索引的过滤在 Rust 侧执行

> **Wire 协议** — MySQL、PostgreSQL、MongoDB 和 Redis 共用一个监听端口
> （`jsql serve`，默认端口 3306）。服务端嗅探每个连接的首个数据包，并交给匹配的
> 协议处理器。MySQL / PostgreSQL / MongoDB 读写同一个 `Database` 引擎（同一批表），
> Redis 拥有独立的 key 命名空间。已用 `mysql2`、`pg`、`mongodb`（驱动 7.x）和
> `ioredis` 验证；传 `--mysql-only` 可只服务 MySQL 协议。

---

## 功能总览

```
JSQL-NEO: MySQL + PostgreSQL + MongoDB + Redis + SQL
  一个端口，一个引擎，所有协议 — Node.js / WASM / CLI / Web UI
```

| 特性 | 说明 |
|---|---|
| **Rust 核心** | N-API 原生插件 — 主键点查 O(1)、二进制批量插入、Rust 侧行过滤 |
| **WASM 构建** | 同一引擎可在 Node.js 和任意浏览器中运行 |
| **MySQL** | `mysql2`、Sequelize、Knex、TypeORM — 直接可用 |
| **PostgreSQL** | `pg`、`psql`、pgAdmin — SCRAM-SHA-256、JSONB、ILIKE |
| **MongoDB** | `mongodb`、mongosh、Compass — OP_MSG、BSON、聚合 |
| **Redis** | `ioredis`、`redis-cli` — 全部数据类型 + TTL |
| **一个端口** | 协议嗅探把四种客户端路由到同一份数据 |
| **零依赖 TUI** | `jsql tui` — 行编辑、历史、Tab 补全、CJK 表格 |
| **Web UI** | 管理控制台 + HTTP API，无前端框架 |
| **WASM** | 浏览器内完整引擎，无需服务端 |

---

## 快速开始

### 安装

```bash
npm install jsql-neo
```

### 三行代码

```js
const { Database, executeSQL } = require('jsql-neo');

const db = new Database(':memory:');
await executeSQL(db, "CREATE TABLE users (id INT PRIMARY KEY AUTO_INCREMENT, name TEXT)");
await executeSQL(db, "INSERT INTO users (name) VALUES ('Alice')");
const { rows } = await executeSQL(db, "SELECT * FROM users");
console.log(rows); // [[1, 'Alice']]
db.stop();
```

### Wire 协议服务器

```bash
jsql serve --port 3306 --data-dir ./data
```

四种协议共用同一个端口：

```bash
# MySQL 客户端（mysql CLI、mysql2、DBeaver、DataGrip …）
mysql -h 127.0.0.1 -P 3306 -u root

# PostgreSQL 客户端（psql、pg、pgAdmin …）
psql "host=127.0.0.1 port=3306 user=postgres dbname=app"

# MongoDB 客户端（mongosh、mongodb 驱动、Compass …）
mongosh "mongodb://127.0.0.1:3306/app?directConnection=true"

# Redis 客户端（redis-cli、ioredis …）
redis-cli -h 127.0.0.1 -p 3306 PING
```

传 `--mysql-only` 可只服务 MySQL wire 协议。

### 浏览器 / WASM

```js
import init, { JSQL } from 'jsql-neo/wasm/browser.mjs';
await init();
const db = new JSQL();
// 与 Node.js native 客户端相同的 API
```

### ? NativeJSQL

纯 Rust 原生绑定 —— 运行 JSQL-NEO 性能最高的方式：

- **低抽象开销** — 直接调用 Rust 核心
- **批量操作** — 20 万行实测约 70 万行/秒（每批 5k 行 `INSERT`）
- **智能缓存 + 自动内存管理**

**安装：**

```bash
npm install jsql-neo
```

**用法：**

```javascript
const { NativeJSQL } = require('jsql-neo');
const db = new NativeJSQL();          // :memory: — 传路径即可持久化
await db.start();
```

### 存储模式

| 模式 | 用法 | 适用场景 |
|---|---|---|
| 内存 | `new Database(':memory:')` | 测试、缓存 |
| 磁盘 | `new Database('./data/app')` | 生产持久化 |
| 混合 | `new Database('./data', { autoSave: true, saveInterval: 3000 })` | 性能 + 持久性 |

---

## 查询结果

`db.query()` / `executeSQL()` 返回**一份结果的三种形态**：

```js
const r = await db.query('SELECT city, COUNT(*) AS c FROM users GROUP BY city');
r.columns   // ['city', 'c']
r.rows      // [['LA', 1], ['NY', 2]]
r.raw       // [{ city: 'LA', c: 1 }, { city: 'NY', c: 2 }]
```

`raw` 是 `rows` 的对象形态：键恰好是 `columns`，包含计算列、聚合列和标量子查询列。
它**不是**投影前的原始行。对 SELECT 结果始终满足 `raw.length === rows.length`；
非 SELECT 语句可能不含 `raw`。

要确认当前安装实际使用的原生插件：

- `jsql native status` — tag/版本是否匹配（`0` = OK，`1` = 不匹配或未验证）
- `jsql native verify` — 用安装期记录的校验和重新哈希磁盘上的 `.node`，因此被替换或损坏的二进制也能被发现。`--json` 输出结构化结果供 CI 使用。状态：`OK` / `MISMATCH` / `CORRUPT` / `MISSING` / `UNVERIFIED` / `UNREADABLE`。
- `jsql native refresh` — 重新获取经过校验和验证的插件

## ✨ XQL 集成

用 [XQL](https://github.com/vexify-org/XQL) 查询 JSQL 表：把 SQL 直接接到文档上，
支持等值 hash 索引与范围 range 索引，速度不低于手写 JS 循环，并支持管道式语法。

```js
const { NativeJSQL } = require('jsql-neo');
const db = new NativeJSQL();
await db.start();

db.use(require('jsql-neo/lib/plugins').xql());

// 标准 SQL
const rows = await db.xql('SELECT name FROM users WHERE age > 18 ORDER BY name');
// 管道式（同样的语义）
const pipe = await db.xql('FROM users |> WHERE age > 18 |> SELECT name |> ORDER BY name');

// 索引：等值 → hash 索引 O(1)，范围 → 有序索引 O(log n + k)
db.xqlIndex('users', 'id');
db.xqlIndex('users', 'score', 'range');
```

写入（INSERT / UPDATE / DELETE）后 XQL 缓存自动失效、下次查询重建；XQL 只读，
不做写回——数据的唯一权威仍是 JSQL 引擎。详见 [PLUGINS.md](PLUGINS.md#xql-插件)。

---

## 网络访问

**CLI 启动路径完全不发起网络请求** — 查询、脚本和 `jsql serve` 全部在本地完成。
外部访问仅限于你显式调用的命令，每个此类位置在源码中都带 `NETWORK:` 注释说明为何无法本地完成：

| 命令 / 时机 | 目标 | 为何需要联网 | 如何禁用 |
| --- | --- | --- | --- |
| `jsql star` | `auth.vexify.top` + GitHub | OAuth 授权必须经过服务端 | `JSQL_OFFLINE=1` |
| `jsql star --token-check` | `api.github.com` | star 状态只存在于 GitHub 账号 | `JSQL_OFFLINE=1` |
| `jsql update` | `registry.npmjs.org` | “是否有新版本”只存在于注册表 | `JSQL_OFFLINE=1` |
| `jsql plugin list\|search\|info\|install` | `registry-beta.vexify.top` | 插件目录只存在于远端 | `JSQL_OFFLINE=1` |
| `npm install`（postinstall） | GitHub releases | 预编译 Rust `.node` 不在 npm tarball 内 | `JSQL_NO_NATIVE_DOWNLOAD=1` 或 `JSQL_OFFLINE=1` |

`JSQL_OFFLINE=1` 一次性禁用所有外部请求；受影响的命令会说明原因，而不是静默失败。
回环流量（`jsql serve` 与客户端 / Web UI 之间的 `127.0.0.1` 连接）不属于外部访问，不受影响。

## ? 文档

详细文档位于 `doc/`，中文版在 `doc/cn/`。

| 文档 | 说明 |
|---|---|
| [doc/cn/index.md](doc/cn/index.md) | 概览、架构、概念 |
| [doc/cn/why.md](doc/cn/why.md) | 为什么需要 JSQL-NEO，设计哲学 |
| [doc/cn/quick-start.md](doc/cn/quick-start.md) | 安装、API 基础、Web UI |
| [doc/cn/multiprotocol.md](doc/cn/multiprotocol.md) | 单端口多协议服务器、嗅探逻辑 |
| [doc/cn/mysql.md](doc/cn/mysql.md) | MySQL 协议：认证、系统变量、语法、FAQ |
| [doc/cn/postgresql.md](doc/cn/postgresql.md) | PostgreSQL 协议：SCRAM-SHA-256、wire v3、SQLSTATE |
| [doc/cn/mongodb.md](doc/cn/mongodb.md) | MongoDB 协议：BSON、命令、操作符、聚合 |
| [doc/cn/redis.md](doc/cn/redis.md) | Redis 协议：数据类型、命令、TTL、快照 |
| [doc/cn/api-reference.md](doc/cn/api-reference.md) | 完整 API：`Database`、`executeSQL`、配置项 |
| [doc/cn/sql-reference.md](doc/cn/sql-reference.md) | SQL：语句、数据类型、函数、操作符、索引 |
| [doc/cn/cli.md](doc/cn/cli.md) | CLI：`jsql tui`、`jsql serve`、`jsql ui` |
| [doc/cn/changelog.md](doc/cn/changelog.md) | 发布说明 |

---

## ? 贡献与许可

Apache-2.0 许可 — 欢迎贡献！

- **GitHub:** [vexify-org/JSQL-neo](https://github.com/vexify-org/JSQL-neo)
- **Issues:** [提交 issue](https://github.com/vexify-org/JSQL-neo/issues)
- **PRs:** Fork → 分支 → PR — 感谢！
- **贡献指南:** [CONTRIBUTING.md](CONTRIBUTING.md)（中文贡献者可直接用中文提 issue 或 PR）
- **开发容器:** [jsql-neo/devbox](https://github.com/jsql-neo/devbox) — 可复现的开发环境（Docker/devcontainer）
- **行为准则:** [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)
- **安全:** [SECURITY.md](SECURITY.md) — 请私下报告漏洞
