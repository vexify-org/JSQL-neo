# JSQL-NEO 文档

> 完整的离线文档站点 · 当前版本 **v6.10.1**（2026-11-24）

## 📚 文档导航

| 文档 | 内容 |
| --- | --- |
| [快速开始](quick-start.md) | 安装、最小示例、Web UI |
| [为什么做 JSQL-NEO](why.md) | 设计取舍与定位 |
| [API 参考](api-reference.md) | `Database` / `Table` / `executeSQL` / 配置项、安全策略 |
| [SQL 参考](sql-reference.md) | DDL / DML / 类型 / 完整函数清单 / 运算符 / 索引 |
| [CLI 命令](cli.md) | `serve` / `tui` / `ui` / `native` / `star` / `update` / `plugin`、离线模式 |
| [多协议服务器](multiprotocol.md) | 单端口四协议、首包嗅探逻辑 |
| [MySQL](mysql.md) | 认证、系统变量、语法、FAQ |
| [PostgreSQL](postgresql.md) | SCRAM-SHA-256、wire v3、SQLSTATE |
| [MongoDB](mongodb.md) | BSON、命令、操作符、聚合 |
| [Redis](redis.md) | 数据类型、命令、TTL、快照 |
| [列存（一键转换）](columnar.md) | 适用场景、限制、与 DuckDB 的真实基准 |
| [变更日志](changelog.md) | 关键版本变更摘要 |
| [根目录 CHANGELOG](../CHANGELOG.md) | 逐条完整变更记录 |
| [README](../README.md) | 项目总览与快速开始 |

## ⚡ 核心特性速览

| 特性 | 说明 |
| --- | --- |
| 多协议 | MySQL / PostgreSQL / MongoDB / Redis 共用一个端口（`jsql serve`，首包嗅探） |
| 轻依赖 | 核心引擎零运行时依赖；仅 CLI 参数解析用 `@vexify-org/yaggs`（可降级） |
| 三引擎 | Native (N-API) / WASM / Pure JS |
| 存储模式 | 内存 / 混合 / 磁盘 |
| 崩溃安全 | 单文件模式一步一个 WAL：每次写入 append 到内核，fsync 按窗口合并，`save()`/`close()` 只做检查点 |
| 内置 UI | 零依赖 Web 管理界面 + HTTP API |
| TUI | 交互式终端，Tab 补全、CJK 对齐 |
| XQL 插件 | 内置 `xql`，hash / range 索引 + 管道式查询 |
| 兼容层 | `jsql-neo/compat/v1` 提供 1.0.0 怀旧 API |
| 默认离线 | CLI 启动零外网请求；`JSQL_OFFLINE=1` 一键禁用全部外部访问 |
| 发版门禁 | `npm run check:release` 阻止「漏写 CHANGELOG 章节」的包被发布 |

## 🔧 SQL 能力

SQL 函数完整清单与示例见 [SQL 参考](sql-reference.md)，包含：

- **JSON**：`JSON_EXTRACT` / `JSON_CONTAINS`（支持 path 与类型敏感）/
  `JSON_SEARCH`（大小写敏感 + LIKE 通配符）/ `JSON_SET` / `JSON_MERGE_PATCH` 等
- **日期时间**：UTC 墙上时间基准；`TO_DAYS` / `FROM_DAYS` / `TO_SECONDS` /
  `TIME_TO_SEC` / `SEC_TO_TIME` / `DATE_ADD` / `DATE_FORMAT` / 窗口日期函数
- **进制与工具**：`BIN` / `OCT` / `HEX` / `UNHEX` / `CONV` / `CRC32` /
  `QUOTE` / `FIND_IN_SET` / `INSERT` / `FORMAT` / `INET_ATON` / `INET_NTOA` /
  `MAKE_SET` / `EXPORT_SET` / `SOUNDEX`
- **精确整数**：`>2^53` 用 BigInt 保精度；整数语义的数学函数走精确路径，
  浮点函数返回 DOUBLE
- **查询结果**：`columns` / `rows` / `raw` 三种表示指向同一份结果，
  `raw` 的键恰好是 `columns`

## 🌐 在线资源

- [官网 jsql.vexify.top](https://jsql.vexify.top)
- [GitHub 仓库](https://github.com/vexify-org/JSQL-neo)
- [npm 包](https://www.npmjs.com/package/jsql-neo)
- [PLUGINS.md](../PLUGINS.md) — 插件系统
