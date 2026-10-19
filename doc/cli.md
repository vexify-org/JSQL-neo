# CLI 命令

## 快速开始

```bash
npm install -g jsql-neo
# 或直接 npx jsql-neo <command>
```

## serve — MySQL 协议服务器

```bash
# 启动 MySQL Wire Protocol 服务器（前台运行）
jsql serve --port 3306 --data-dir ./data

# 全部选项
jsql serve --port 3306 --host 127.0.0.1 --data-dir ./data --no-auth --log
```

| 选项 | 说明 |
| --- | --- |
| `--port`, `-p` | 监听端口（默认 3306） |
| `--host` | 监听地址（默认 127.0.0.1） |
| `--data-dir` | 数据库存储目录 |
| `--no-auth` | 允许无认证连接 |
| `--log` | 把执行的查询打到 stdout |

> **范围说明（请勿照抄旧文档）**
>
> `serve` 目前**只实现 MySQL Wire Protocol**。此前文档里写的
> `--mysql` / `--pg` / `--redis` / `--mongo` 四个旗标**从未实现**，
> 传了会被 commander 当未知选项；`--password` / `--auto-save` /
> `--save-interval` 同理不存在。
>
> 「一个端口四协议」目前只在 **Node API** 层面成立（见下节），
> CLI 尚未提供对应入口。

### 多协议：Node API

PG / MongoDB / Redis 的协议栈目前以库的形式提供，需要在代码里装配，
没有对应的 `serve` 子命令：

```js
const { createPgServer } = require('jsql/lib/pg_server');
const { createMongoServer } = require('jsql/lib/mongo_server');
const { createRedisServer } = require('jsql/lib/redis_server');
// 各自监听自己的端口
```

> MongoDB 协议栈与**官方现代 driver 的握手兼容性尚未验证通过**，
> 自带的 mongo 测试当前失败。请勿用于生产。

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
