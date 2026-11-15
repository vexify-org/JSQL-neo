# CLI 命令

> 对应版本 **v6.6.6**。命令以 `jsql` 表示；本地开发可用 `node bin/jsql`。

## 快速开始

```bash
npm install -g jsql-neo
# 或直接 npx jsql-neo <command>
```

## 离线模式（默认行为）

**CLI 启动路径不发起任何网络请求**，查询、脚本、`jsql serve` 全部本地完成。
只有用户显式执行的少数命令才会访问外网：

| 命令 | 访问目标 | 为什么必须联网 | 关闭方式 |
| --- | --- | --- | --- |
| `jsql star` | `auth.vexify.top` + GitHub | OAuth 授权需经服务端换 token | `JSQL_OFFLINE=1` |
| `jsql star --token-check` | `api.github.com` | star 状态只存在于 GitHub 账号侧 | `JSQL_OFFLINE=1` |
| `jsql update` | `registry.npmjs.org` | 「是否有新版本」只存在于 registry | `JSQL_OFFLINE=1` |
| `jsql plugin list\|search\|info\|install` | `registry-beta.vexify.top` | 插件目录只在远端 | `JSQL_OFFLINE=1` |
| `npm install`（postinstall） | GitHub releases | 预编译的 Rust `.node` 不在 npm tarball 里 | `JSQL_NO_NATIVE_DOWNLOAD=1` 或 `JSQL_OFFLINE=1` |

```bash
export JSQL_OFFLINE=1        # 1 / true / yes / on 均可
jsql native status           # 仍可用：纯本地检查
jsql update                  # 给出可读的离线原因，不发请求
```

只连 `127.0.0.1` 的本地回环（`jsql serve` 与客户端 / Web UI 之间的通信）
不算外部网络，离线模式下照常工作。各出网点在源码里都有 `NETWORK:` 注释
说明原因与触发条件，约定见 `lib/network-policy.js`。

## native — 本地 addon 状态

```bash
jsql native                  # 等同于 status
jsql native status           # tag / 版本是否匹配（exit 0=OK，1=错配或未记录）
jsql native verify           # 重算 .node 的 SHA256 与安装记录比对
jsql native verify --json    # 结构化输出，便于 CI 消费
jsql native refresh          # 重新拉取校验过的 addon，随后报一次状态
```

| 状态 | 含义 |
| --- | --- |
| `OK` | 当前 `.node` 与包版本、安装校验和都匹配 |
| `MISMATCH` | 版本 tag 不符 |
| `CORRUPT` | 文件内容与安装时的 SHA256 不符（`status` 看不到这个） |
| `MISSING` / `UNVERIFIED` / `UNREADABLE` | 文件缺失 / 无安装元数据 / 无法读取 |

`verify --json` 输出 `packageVersion` / `expectedTag` / `installedTag` /
`present` / `size` / `expectedSha256` / `actualSha256` / `state`。

> `status` 只看元数据 tag；文件被替换但元数据没动时仍会报 OK，
> 这种场景要用 `verify`。

## star / update

```bash
jsql star                    # 浏览器 OAuth 授权确认 star
jsql star --token-check      # 用 GITHUB_TOKEN / gh 直接查 API，不开浏览器
jsql star --reset            # 清除已确认状态
jsql update                  # 检查/安装新版本
jsql update --check          # 只看不装
jsql update --dry-run        # 打印将要执行的命令
```

是否 star 过只以本地 `~/.jsqlmr` 为准（可用 `JSQL_MR_PATH` 覆盖）。
`JSQL_NO_STAR_NAG=1` 可静音启动提示；提示本身不联网。

## serve — 单端口多协议服务器

```bash
jsql serve --port 3306 --data-dir ./data
jsql serve --port 3306 --host 127.0.0.1 --data-dir ./data --no-auth --log
jsql serve --port 3306 --mysql-only      # 只提供 MySQL 协议（旧行为）
```

| 选项 | 说明 |
| --- | --- |
| `--port`, `-p` | 监听端口（默认 3306） |
| `--host` | 监听地址（默认 127.0.0.1） |
| `--data-dir` | 数据库存储目录 |
| `--no-auth` | 允许无认证连接 |
| `--log` | 把执行的查询打到 stdout |
| `--mysql-only` | 只启动 MySQL Wire Protocol，不做协议嗅探 |

```bash
mysql -h 127.0.0.1 -P 3306 -u root
psql "host=127.0.0.1 port=3306 user=postgres dbname=app"
mongosh "mongodb://127.0.0.1:3306/app?directConnection=true"
redis-cli -h 127.0.0.1 -p 3306 PING
```

协议按连接首包嗅探：OP_MSG/OP_QUERY → MongoDB，`0x00` → PostgreSQL，
`0x0a/0x0d` → MySQL，其余按 Redis 处理。MySQL 客户端等服务器先发握手包，
因此 200ms 内没有字节的连接默认按 MySQL 处理（可用 `idleProtocol` 改成
`redis` / `pg` / `mongo`）。

> 旧文档里的 `--mysql` / `--pg` / `--redis` / `--mongo` 四个旗标从未实现，
> 现在统一由协议嗅探处理；`--password` / `--auto-save` / `--save-interval`
> 同样不存在。

### 多协议：Node API

```js
const { createMultiServer } = require('jsql-neo');
const srv = createMultiServer({ port: 3306, host: '0.0.0.0', dataDir: './data', noAuth: true });
srv.listen(() => console.log('listening on', srv.address.port));
```

也可按需单独启动某个协议栈（`createPgServer` / `createMongoServer` /
`createRedisServer`），各自监听独立端口。

## ui / tui / redis / bench

```bash
jsql ui --port 8080                         # Web 管理界面 + HTTP API
jsql tui --data-dir ./data                  # 交互式 SQL 终端（历史、Tab、CJK 对齐）
jsql redis --port 6379 --data-dir ./data    # 独立 Redis 协议服务器
jsql bench --rows 10000 --iterations 100    # 内置基准
```

## export / import — 数据迁移

```bash
jsql export users backup.json
jsql export orders orders.csv --db ./data/app.json
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
这组命令访问远端 registry，离线时给出明确原因。

## version

```bash
jsql version
# jsql-neo v6.6.6
# engine: native
# node: v22.x.x
```

## 通用选项

| 选项 | 说明 |
|---|---|
| `--port, -p` | 端口号（`serve` / `ui` / `redis` / `tui` 可用） |
| `--host` | 监听地址（默认 127.0.0.1） |
| `--data-dir, -d` | 数据目录 |
| `--no-auth` | 允许无认证连接（仅本地开发） |
| `--log` | 把执行的查询 / 命令打到 stdout |
| `--json` | 以 JSON 输出（export / import / bench / plugin / native verify） |

> 不存在 `--password` / `--auto-save` / `--save-interval` / `--verbose` 这些旧
> 文档中的旗标；认证请用 `--auth`（`redis` / `server`）或 `--auth-token`（`ui`）。

## 维护者：发版门禁

```bash
npm run check:release
```

校验三处版本标记一致，并要求 CHANGELOG 含当前版本章节。已接进
`npm test` / `test:all` 与 `publish.yml` 发布前 —— 漏写 CHANGELOG 就发不了版。
纯本地静态检查，不联网；`[Unreleased]` 有内容只给 WARN，不阻碍日常开发。
