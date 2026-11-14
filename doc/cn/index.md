🌐 Language / 语言: [English](../index.md) | 简体中文

# JSQL-NEO 文档

> 完整的离线文档站点 · 当前版本 **v6.6.2**

## 📚 文档导航

- [快速开始](quick-start.md) — 3 分钟上手
- [API 参考](api-reference.md) — Database / Table / Query 类
- [SQL 参考](sql-reference.md) — DDL / DML / 函数 / 索引
- [CLI 命令](cli.md) — jsql serve / tui / bench / export
- [变更日志](changelog.md) — 版本历史

## 🌐 在线资源

- [官网 jsql.vexify.top](https://jsql.vexify.top)

- [README 完整版](../../README.md)
- [GitHub 仓库](https://github.com/vexify-org/JSQL-neo)
- [npm 包](https://www.npmjs.com/package/jsql-neo)
- [PLUGINS.md](../../PLUGINS.md) — 插件系统

## ⚡ 核心特性速览

| 特性 | 说明 |
|---|---|
| 多协议 | MySQL / PostgreSQL / MongoDB / Redis 一端口同时服务（`jsql serve`） |
| 轻依赖 | 核心引擎零运行时依赖；仅 CLI 参数解析用 `@vexify-org/yaggs` |
| 三引擎 | Native (N-API) / WASM / Pure JS |
| 存储模式 | 内存模式 / 混合模式 / 磁盘模式 |
| 内置 UI | 零依赖 Web 管理界面 + HTTP API |
| TUI | 交互式终端，Tab 补全、CJK 对齐 |
| XQL 插件 | 内置 `xql`，hash / range 索引 + 管道式查询 |
| 兼容层 | `jsql-neo/compat/v1` 提供 jsql 1.0.0 怀旧 API |
