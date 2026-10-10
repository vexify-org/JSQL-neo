# CLI 命令

## 快速开始

```bash
npm install -g jsql-neo
# 或直接 npx jsql-neo <command>
```

## serve — 多协议服务器

```bash
# 启动多协议服务器（一个端口，MySQL/PG/MongoDB/Redis 同时支持）
jsql serve --port 3306 --data-dir ./data

# 指定协议
jsql serve --mysql --port 3306
jsql serve --pg --port 5432
jsql serve --redis --port 6379
jsql serve --mongo --port 27017

# 带密码
jsql serve --port 3306 --password mysecret

# 自定义配置
jsql serve --port 3306 --auto-save --save-interval 3000
```

## ui — Web UI

```bash
# 启动 Web 管理界面
jsql ui --port 8080
jsql ui --port 8080 --data-dir ./data
```

打开浏览器访问 http://localhost:8080

## tui — 交互式终端

```bash
# 交互式 SQL 终端
jsql tui
jsql tui --data-dir ./data
```

功能：行编辑、历史记录、Tab 补全、CJK 字符对齐、元命令（`.tables`、`.schema` 等）

## redis — Redis 协议服务器

```bash
jsql redis --port 6379 --data-dir ./data
```

## bench — 性能测试

```bash
# 内置基准测试
jsql bench
jsql bench --rows 10000 --iterations 100
```

## export / import — 数据迁移

```bash
# 导出
jsql export --output backup.json
jsql export --output backup.json --tables users,orders

# 导入
jsql import backup.json
jsql import backup.json --overwrite
```

## backup / restore — 备份恢复

```bash
jsql backup ./data --output backup-$(date +%Y%m%d).json
jsql restore backup-20261010.json
```

## version — 版本信息

```bash
jsql version
# jsql-neo v6.3.6
# engine: native
# node: v22.10.0
```

## 通用选项

| 选项 | 说明 |
|---|---|
| `--port, -p` | 端口号 |
| `--data-dir, -d` | 数据目录 |
| `--password` | 数据库密码 |
| `--auto-save` | 启用自动保存 |
| `--save-interval` | 自动保存间隔(ms) |
| `--verbose, -v` | 输出详细日志 |
