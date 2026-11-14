# CLI 命令

## 快速开始

```bash
npm install -g jsql-neo
# 或直接 npx jsql-neo <command>
```

## serve — 单端口多协议服务器

```bash
# 启动多协议服务器（前台运行）：同一端口接受 MySQL / PostgreSQL / MongoDB / Redis
jsql serve --port 3306 --data-dir ./data

# 全部选项
jsql serve --port 3306 --host 127.0.0.1 --data-dir ./data --no-auth --log

# 只提供 MySQL 协议（旧行为）
jsql serve --port 3306 --mysql-only
```

| 选项 | 说明 |
| --- | --- |
| `--port`, `-p` | 监听端口（默认 3306） |
| `--host` | 监听地址（默认 127.0.0.1） |
| `--data-dir` | 数据库存储目录 |
| `--no-auth` | 允许无认证连接 |
| `--log` | 把执行的查询打到 stdout |
| `--mysql-only` | 只启动 MySQL Wire Protocol，不做协议嗅探 |

连接方式：

```bash
mysql -h 127.0.0.1 -P 3306 -u root
psql "host=127.0.0.1 port=3306 user=postgres dbname=app"
mongosh "mongodb://127.0.0.1:3306/app?directConnection=true"
redis-cli -h 127.0.0.1 -p 3306 PING
```

协议按连接首包嗅探：`0x00` → PostgreSQL，`0x0a/0x0d` → MySQL，
OP_MSG/OP_QUERY → MongoDB，其余按 Redis 处理。MySQL 客户端等服务器先发
握手包，因此 200ms 内没有字节的连接默认按 MySQL 处理（可用
`idleProtocol` 改成 `redis` / `pg` / `mongo`）。

> 此前文档里的 `--mysql` / `--pg` / `--redis` / `--mongo` 四个旗标从未实现，
> 现在统一由协议嗅探处理；`--password` / `--auto-save` / `--save-interval`
> 同样不存在。

### 多协议：Node API

在代码里直接装配同一个监听端口：

```js
const { createMultiServer } = require('jsql-neo');

const srv = createMultiServer({
  port: 3306,
  host: '0.0.0.0',
  dataDir: './data',
  noAuth: true,
});
srv.listen(() => console.log('listening on', srv.address.port));
```

也可以按需单独启动某一个协议栈（`createPgServer` / `createMongoServer` /
`createRedisServer`），各自监听独立端口。

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
# 导出单表（JSON 或 CSV；流式写入，不整表读入内存）
jsql export users backup.json
jsql export orders orders.csv --db ./data/app.json

# 导入（自动识别 .sql / .json / .csv）
jsql import dump.sql --db ./data/app.json
jsql import data.json --db ./data/app.json
jsql import data.csv --table users --db ./data/app.json
```

| 选项 | 说明 |
|---|---|
| `--db` | 目标数据库文件（默认 `./db.json`） |
| `--table` | CSV 导入的目标表（必需） |
| `--strict` | 导入遇错即中止 |
| `--json` | 输出机器可读结果 |

## plugin — 插件注册表

```bash
jsql plugin list
jsql plugin search <keyword>
jsql plugin install <name>
jsql plugin uninstall <name>
jsql plugin info <name>
```

安装的插件（如 `xql`）会在 `new Database()` 时自动加载，也可在代码里 `db.use('xql')`。

## version — 版本信息

```bash
jsql version
# jsql-neo v6.6.1
# engine: native
# node: v22.10.0
```

## 通用选项

| 选项 | 说明 |
|---|---|
| `--port, -p` | 端口号（`serve` / `ui` / `redis` / `tui` 可用） |
| `--host` | 监听地址（默认 127.0.0.1） |
| `--data-dir, -d` | 数据目录 |
| `--no-auth` | 允许无认证连接（仅本地开发） |
| `--log` | 把执行的查询 / 命令打到 stdout |
| `--json` | 以 JSON 输出（export / import / bench / plugin 等） |

> 不存在 `--password` / `--auto-save` / `--save-interval` / `--verbose` 这些旧文档中的旗标；认证请用 `--auth`（`redis` / `server`）或 `--auth-token`（`ui`）。
