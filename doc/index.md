🌐 Language / 语言: **English** | [简体中文](cn/index.md)

# JSQL-NEO Documentation

> Complete offline documentation site · Current version **v6.6.2**

## 📚 Documentation

- [Quick Start](quick-start.md) — up and running in 3 minutes
- [API Reference](api-reference.md) — Database / Table / Query classes
- [SQL Reference](sql-reference.md) — DDL / DML / functions / indexes
- [CLI Commands](cli.md) — jsql serve / tui / bench / export
- [Changelog](changelog.md) — release history

## 🌐 Online resources

- [Official site: jsql.vexify.top](https://jsql.vexify.top)

- [Full README](../README.md)
- [GitHub repository](https://github.com/vexify-org/JSQL-neo)
- [npm package](https://www.npmjs.com/package/jsql-neo)
- [PLUGINS.md](../PLUGINS.md) — plugin system

## ⚡ Feature highlights

| Feature | Description |
|---|---|
| Multi-protocol | MySQL / PostgreSQL / MongoDB / Redis served simultaneously on one port (`jsql serve`) |
| Light dependencies | Zero runtime dependencies in the core engine; only CLI argument parsing uses `@vexify-org/yaggs` |
| Three engines | Native (N-API) / WASM / Pure JS |
| Storage modes | In-memory / hybrid / on-disk |
| Built-in UI | Zero-dependency web management UI + HTTP API |
| TUI | Interactive terminal with Tab completion and CJK-friendly tables |
| XQL plugin | Built-in `xql`: hash / range indexes + piped queries |
| Compat layer | `jsql-neo/compat/v1` provides the nostalgic jsql 1.0.0 API |
