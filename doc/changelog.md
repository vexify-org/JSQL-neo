# 变更日志

> 当前版本：**6.6.0**（2026-11-13）
>
> 本页按版本倒序汇总**关键 / 重要变更**（安全修复、数据损坏修复、新功能、破坏性变更）。
> 逐条完整记录见根目录 [CHANGELOG.md](../CHANGELOG.md)。

## 6.6.0 — 2026-11-13 (语义变更)

### Breaking
- **日期/时间字面量改为以 UTC 为稳定基准**：不带时区标记的日期字面量
### 修改位置
- `lib/date-types.js`：`toUtcDateString` / `toUtcDateTimeString`（原 `toLocal*`）、
### Fixed
- **测试断言时区无关化**：`test/issue-71-72.test.js` 的硬编码 `1577905445`

## 6.5.34 — 2026-11-13

### Fixed
- **#73 `GROUP BY <位置索引>` 被当成常量，所有行塌成一组**：解析器把 `GROUP BY 1`
### Added
- `test/issue-73-76.test.js`：4 个 issue 的 23 条回归断言（每个 issue 覆盖正常行为、

## 6.5.33 — 2026-11-11

### Fixed
- **#69 字符串算术没有按 MySQL 规律做数值前缀转换**：`'5a' + 1` 得到 `"5a1"`
### 测试
- 新增 `test/issue-69-70.test.js`（52 项）：字符串算术、`!` 逻辑非、

## 6.5.31 — 2026-11-10

### Fixed（issue #63~#68，均先在 6.5.30 上复现再动手）
- **#63 `POSITION(substr IN str)` 解析错误**：`IN` 是关键字，通用函数参数
### 测试
- 新增 `test/issue-63-68.test.js`（30 项），Redis 部分用 mock socket 直接调

## 6.5.30 — 2026-11-10

### Fixed
- **#58 `ast.rewrite()` 无法替换根节点**：根节点 `parent === null` 时替换被
### Added
- `test/issue-59.test.js`、`test/issue-60.test.js` 回归测试（#58 测试已存在）。

## 6.5.28 — 2026-11-08

### Fixed
- **6.5.27 漏 bump 两处版本串**：README 横幅与 index.js 头注释停在 6.5.26。
### Added
- `jsql native status` / `refresh` / `verify`（`--json` 结构化输出）。
### Performance
- **结果 BigInt 收尾从通用深递归改成紧凑循环**。此前每个 SQL 结果的 rows
### 测试
- 新增 `test/result-raw.test.js`(23) / `test/native-install.test.js`(7) /
### Issue 收尾
- #45 / #46 / #47 / #48：PR #49 已合并、对应回归测试全绿（3/9/3/4），

## 6.5.27 — 2026-11-08


## 6.5.26 — 2026-11-07

### Fixed
- **`result.raw` 对计算/聚合列全部返回错值（issue #43）**：
### 测试
- 此前 README/doc 没有任何 raw 说明、测试里没有任何 `.raw` 断言 ——
### 已知问题（本版未修）
- `postinstall` 在 Windows 上 EPERM fallback 吞掉 `unlinkSync` 失败，

## 6.5.25 — 2026-11-07


## 6.5.24 — 2026-11-06

### Fixed
- **Rust/WASM/Native 绑定层 int64 精度丢失（issue #38 遗留）**：WASM 与 Native 引擎此前把 `int64` 当 `f64` 编解码，`lib/wasm_client.js` 路径插入 BigInt 会抛 JSON 序列化错误，`> 2^53` 的十进制字符串也会截断。现已与 JS 引擎（6.5.23）行为一致：

## 6.5.23 — 2026-11-06

### Fixed
- **超过 2^53 的 64 位整数精度丢失（issue #38）**：`integer` / `int` / `bigint` 列此前用 `Number(v)` 归一，`> 2^53-1` 的值（number 或十进制字符串）会被静默截断成 53 位浮点；SQL 路径又因字面量解析成 BigInt 而报 1292，两条路径行为不一致且都丢精度。现已支持 BigInt：
### Notes
- 合并 `fix/i38` 时保留 6.5.22 全部修复：`mysqlNum()`（MySQL 字符串→数字强转）与 `bigintExactArith()` 并存；`test` / `test:all` 取测试集并集（含 #38、#39、#40、g4）。

## 6.5.22 — 2026-11-06

### Fixed
- **BETWEEN 数值边界退化成字典序比较（issue #39）**：`BETWEEN '9' AND '100'` 此前按字符串比较，`'9' > '100'` 导致结果为空。现在当列/边界可用数值解析时按数值比较（支持负号、小数、科学计数法），纯文本列仍保持字典序。
### Notes
- issue #38（BigInt 序列化）本次未包含，已在 [6.5.23] 中修复。

## 6.5.21 — 2026-11-05

### Fixed
- **Native 引擎 `add_column` 多行表数据损坏（issue #22）**：`Table::add_column` 用 `Vec::insert` 原地插入导致后续行 `values_start` 未同步，>1 行表添加列后首行之后所有行被静默损坏。现重建 `values` 并重算每个 `values_start`，数据不再损坏。

## [Unreleased]
## 6.5.20 — 2026-11-03

### Fixed

- **Native 引擎显式指定主键插入重复值会静默覆盖索引（数据损坏级）**：此前 `insert({ id: 已存在 })` 会插入重复行并覆盖 `pk_index`，原行被"影子化"（`findById` 再也取不到），且与纯 JS 引擎行为不一致。现在所有插入路径（`add_rows`、批量快/慢路径、磁盘加载）先检查 `pk_index`，冲突抛 `ER_DUP_ENTRY`（MySQL 1062），原生错误码映射回 `JSQL_Error`。新增 16 项双引擎回归用例。

## 6.5.19 — 2026-11-03

### Added

- **jsql 1.0.0 怀旧兼容层**：新增 `jsql-neo/compat/v1`（`compatV1`），`V1Database` 包装 `Database`，将 `createTable` / `dropTable` 变为同步、镜像 `db.<table>` 访问器、`import` 可从行推断 schema 并恢复自增主键、`export` 深拷贝。67 项断言覆盖内存/文件模式、全部 1.0.0 操作符、链式查询、约束与导出/导入往返。

## 6.5.18 — 2026-11-03

### Fixed

- **SQL 引擎正确性（F1–F15）**：`LENGTH`/`OCTET_LENGTH` 返回 UTF-8 字节数、`CHAR_LENGTH` 返回字符数；`CAST(x AS UNSIGNED)` 负数按 2^64 取模；`POWER(x, NULL)` 返回 NULL；`LEFT`/`RIGHT` 非正长度返回 `''`；`LPAD`/`RPAD` 正确循环并截断填充串。
- **破坏性 SQL 守卫**：新增 AST 级 `findDestructiveSQL()`，拦截无 WHERE 的 `DROP` / `TRUNCATE` / `DELETE` / `UPDATE`。
- **B-Tree**：`order < 4` 规范化为 4，修复重复分隔键 / 幽灵条目。
- **PRIMARY KEY 拒绝显式 NULL**，堵住唯一约束绕过路径。
- **错误消息**：`%s` 单遍替换，参数内含 `%s` 不再被吞。
- **WASM 契约**：`getTables()` / `hasTable()` 改为同步（修复 `SHOW TABLES` 报 `tables.map is not a function`）；README 更正为"单一运行时依赖 `@vexify-org/yaggs`"。
- **XQL**：修正 `require('@vexify/xql')` 为内置 `lib/xql`。

## 6.5.17 — 2026-10-31

### Fixed

- **标量函数语义（B1–B6）**：`LENGTH`/`OCTET_LENGTH` 按 UTF-8 字节；`LEFT`/`RIGHT` 非正长度返回 `''`；`LPAD`/`RPAD` 循环填充并精确截断；`POWER`/`POW` 任一参数 NULL 返回 NULL；`CAST(-5 AS UNSIGNED)` = `18446744073709551611`。回归套件扩至 90 项。

## 6.5.16 — 2026-10-31

### Security

- **安全模式默认单语句**：`executeSQL` 默认 `maxStatements=1`，拒绝 `DROP`/`TRUNCATE`/`DELETE`/`UPDATE`（含 `WITH ... DELETE`），除非显式传 `{ allowWrites: true }` 或 `{ safety: false }`。所有语句先解析后执行，`SELECT 1; DROP TABLE` 不再"半执行"。协议服务器（MySQL / mysql2 / sqlite 兼容 / Web 控制台）显式放行写入以保持客户端可用。

### Fixed

- B-Tree 测试在回归用例前调用 `process.exit` 导致其从未执行；修正并新增确定性插入/删除再平衡用例（161 项）。

## 6.5.15 — 2026-10-30

### Fixed

- **关联子查询外层限定引用**（`b.id = a.id`）解析为 NULL：外层回退匹配裸列名。
- **`Database.updateById/updateByIds` 漏做约束校验**，允许 `UPDATE ... SET pk = NULL`；现已校验。
- 新增 v6.5.14 回归套件（60 项，覆盖 C1、H1–H6、M1–M11）。

## 6.5.14 — 2026-10-30

### Fixed

- **C1：B-Tree 惰性删除导致丢索引项**（数据损坏级）——删除前先检查键是否存在再决定是否再平衡，修复唯一/主键约束失效。
- **H1**：PG 未配置认证时默认拒绝，除非 `noAuth: true`。
- **H2**：NeDB `$regex` 非法正则不再匹配全部。
- **H3**：`UPDATE` 中标量/关联子查询按行物化，不再恒为 NULL。
- **H4**：`BETWEEN` 数值比较。
- **H5**：主键隐式 `NOT NULL` 在所有写入路径强制生效（含 `updateById`）。
- **H6**：NULL 条件跳过 B-Tree 快路径。
- **M1–M12**：`%s` 替换顺序、行深拷贝、迁移长度保留、READ_COMMITTED 全量事务快照、XOR 三值逻辑、`REGEXP BINARY`、Web UI XSS 转义、star-nag 状态码、插件 hook 优先级、XQL NULL 传播、Mongo 内部字段剥离、MySQL sequence 修复。

## 6.5.13 — 2026-10-29

### Fixed

- **注册表插件自动加载**：manifest `entry` 为仓库相对路径（如 `plugins/xql/index.js`）时匹配不到入口，现兼容仓库相对 / 根级 / `plugins/` 子目录三种布局。
- **npm 安装下 `jsql plugin` 崩溃**：发布清单补回 `src/`。

## 6.5.12 — 2026-10-29

### Added

- **XQL 集成**：内置 `xql` 插件（`db.use('xql')`），支持等值 hash 索引与范围 range 索引、管道语法（`FROM t |> WHERE … |> LIMIT n`）。API：`db.xql()` / `xqlLoad()` / `xqlRefresh()` / `xqlIndex()` / `xqlTables()` / `xqlCollection()` / `xqlClear()`，写入自动失效。零额外依赖，也可 `jsql plugin install xql`。

## 6.5.11 — 2026-10-28

### Fixed

- **布尔三值逻辑**：`TRUE AND TRUE` / `NULL AND TRUE` / `NULL OR FALSE` 此前全返回 0，现按 SQL 三值真值表求值。
- **CREATE TABLE 重复列名** 现抛 `Duplicate column name`，不再静默丢列。
- **JSON/JSONB 非法值**两引擎均做 `JSON.parse` 校验，抛 `Truncated incorrect object value`。
- **ORDER BY 不存在列** 抛 `no such column`（别名 / 位置序号除外）。
- **超大整数序列化**：BigInt 递归转字符串，修复 `Do not know how to serialize a BigInt`。

## 6.5.10 — 2026-10-28

### Fixed

- **ORDER BY 别名 / 位置序号**（非分组路径）现正确排序。
- **字符串比较与 LIKE 保持一致**（默认 utf8mb4_general_ci 大小写不敏感）；新增 `BINARY expr` 强制大小写敏感。
- **UPDATE ... ORDER BY ... LIMIT** 与 DELETE 对称实现。
- **date ± INTERVAL n UNIT** 语法可解析并正确计算（月末钳制）。

## 6.5.9 — 2026-10-27

### Fixed

- **大表聚合崩溃**：`MIN`/`MAX` 不再用 `Math.min(...arr)` 展开大数组（超 V8 参数上限 RangeError），改循环求值。
- **深 JSON 栈溢出**：`JSON_DEPTH` 改为显式栈迭代。
- Mongo `$min`/`$max`、B-tree、分组、导出等 10 余处大数组 `push(...)` 改为 `for...of`，消除参数上限依赖。

## 6.5.8 — 2026-10-26

### Security / Fixed

- **协议层加固**：Redis/PG 解析长度上限、Mongo wire frame 限长；端口占用通过回调报告，不再崩进程。
- **原生模块下载**：校验 SHA256SUMS、限制重定向深度、跨域重定向不转发代理鉴权；新增 linux x64/arm64 musl 预编译产物。
- **插件安装**：校验插件名与 tar 清单，拒绝路径穿越/链接，改用 `execFileSync` 避免 shell 注入。
- **JS 沙箱**：`mod.js` 与 SQLite UDF 默认运行在受限 vm，需显式 `JSQL_ALLOW_UNSAFE_*` 才开放宿主能力。
- **迁移导出**：`exportToFile` 分页流式写入，避免整表读入内存。
- 修复 MySQL binary resultset NULL bitmap、PG `$n` 参数绑定、MultiServer 跨协议共享引擎等正确性问题。

## 6.5.7 — 2026-10-24

### Fixed

- 移除 star-nag OAuth URL 的 `.php` 后缀（`/start.php` → `/start`，`/result.php` → `/result`）。

## 6.5.6 — 2026-10-24

### Performance

- **Native 主键点查 / 按主键更新从 O(n) 降到 O(1)**：Rust `find_rows` / `update_by_filter` / `remove_by_filter` 遇「自增整型主键 = 整数」走 `pk_index` 哈希；`_findRawById` / `_seqIdByPk` 直接调 `jsqlFindById`。20 万行实测 PK 点查 ×500 **512.6ms → 6ms**、`updateById` ×200 **201.4ms → 7ms**。
- **Native 批量插入改走二进制跨 N-API 路径**：同构批次 20 万行 **700ms → 365ms**、50 万行 **812ms**（与 better-sqlite3 基本持平）；异构批次回退 JSON 路径。
- `_assertNoKeyConflictSync` 不再整表拉入 JS；注册进程 `exit` 钩子，退出前同步 flush，修复 `updateById`/`removeById` 直接退出丢写。

## 6.5.5 — 2026-10-24

### Performance

- **WASM `updateById` 不再整表导出**：只检查 updateData 中实际出现的主键/UNIQUE 列，未触碰则直接返回；10 万行 **590ms → 0.8ms/次**（约 740×），1 万行 13.6ms → 0.10ms。

## 6.5.4 — 2026-10-21

### Changed

- CLI 提示（`jsql star` 与启动 nag）改为短句中英双语；OAuth 回调页文案统一为英文。

## 6.5.3 — 2026-10-21

### Fixed

- **`jsql star` 误报 `undefined` 授权结果**：改为按 state 文件自身状态判定（`done/denied/error` 才终态），CLI 轮询只接受带布尔 `starred` 的 done；`callback.php` 增加幂等，重复请求复用已存结果。

## 6.5.1 — 2026-10-21

### Added

- **单端口四协议**：`jsql serve` 默认启动协议嗅探网关，MySQL / PostgreSQL / MongoDB / Redis 共用一个端口、同一份 `Database`；`--mysql-only` 可退回只服务 MySQL。
- MongoDB `OP_MSG` 支持 kind 1 文档序列（`insertMany`）。
- 新增 `test/multiprotocol.test.js`（14 项，四协议握手 + CLI 启动，不依赖外部驱动）。

### Fixed

- **MongoDB 协议栈完全收不到消息**：消息循环误调全局 `process()`。
- Mongo 调度代码漏 `await` 异步引擎方法（`find`/`insert`/`updateByIds`/`removeByIds`）。
- Mongo 独立模式按 `$db` 取引擎，与多协议网关一致。
- 无主键集合 `_patchRows`/`_removeRows` 改走 `_rowKey` 深度匹配。
- 修复并纳入 CI 原先标记损坏的 `test/mongo-group.test.js`。

## 6.5.0 — 2026-10-19

### Added

- **CLI 启动 star 提示** 与 **`jsql star` 子命令**：star 过即永久静音，其余命令提示（后续 beta.5 取消节流与自动弹浏览器）；配置 `~/.jsqlmr`，`JSQL_NO_STAR_NAG=1` 静音，绝不阻塞命令。

### Docs

- 修正 README 三处与实现不符：单端口四协议尚未实现（当时）、`./wasm` 导入入口不存在、`NativeJSQL` 导出名写错。

## 6.4.9 — 2026-10-19

### Fixed

- **纯 JS 与 Native 对 schema 字段名识别不一致（静默正确性 bug）**：`primary_key` / `auto_increment` 下划线写法在纯 JS 下自增 id 不生成、`findById` 失配且不报错。`lib/table.js` 现同时接受驼峰与下划线。

## 6.4.8 — 2026-10-19

### Performance

- **Native `updateById` / `updateByIds` 从全表扫描降为 O(1)**：冲突检查先算出实际触碰的主键/UNIQUE 列，未触碰则直接返回。20 万行 **246–507ms → 1.52ms**。

## 6.4.7 — 2026-10-19

### Fixed

- **B-Tree 结构损坏：`remove()` 不更新祖先分隔键副本**，可导致重复分隔键、查询错乱/数据丢失。新增 `_fixSeparators` 自顶向下重建分隔键；固定种子回归用例。

## 6.4.6 — 2026-10-19

### Fixed

- B-Tree 模糊测试改为固定种子（`XQL_BTREE_SEED`）并记录失败原因，暴露内部节点键未保持有序（结构损坏）的真实 bug。

## 6.4.5 — 2026-10-19

### Fixed / Docs

- 修正 `native.test.js` 与 `regress-5.1.0.js` 大量漏 `await` 导致的假失败；native 测试挪回默认 `npm test`。
- 文档更正：`js` 引擎不是自动降级而是显式选项；`serve` 当时只实现 MySQL；"四协议"实际为"一个半"。

## 6.4.4 — 2026-10-18

### Performance

- **SQL 执行路径快 2–3 倍**：单表无 JOIN 时跳过逐行 `_prefixRow`；ORDER BY 比较器与 SELECT 投影改为编译期预解析。10 万行 `SELECT COUNT(*)` 41ms → 14ms。
- **过滤谓词编译（`_compileMatcher`）**：点查 13.86ms → 0.96ms（14.4×），范围查 21.84ms → 2.02ms（10.8×），`LIKE` ×300 约 3900ms → 6ms。差分模糊测试 4000 查询零偏差。

### Fixed

- `IN` 列表含 NULL 时整体失效；`NOT IN` 三值逻辑修正。
- 窗口函数默认帧按 SQL 标准实现（`ORDER BY` → 累计 RANGE 帧）。
- `d->>'$.name'` 恒返回 null；`->` / `->>` 支持 JSONPath 与纯键名两种写法。
- 补全 6 个静默返回 null 的标量函数：`ASCII` / `CHAR` / `SPACE` / `FIELD` / `ELT` / `JSON_ARRAY_LENGTH`。
- 救活从未运行过的 `test/extra-coverage.test.js`（68 项）。

## 6.4.0 — 2026-10-17

### Added

- **`ALTER TABLE ... RENAME TO` / `RENAME COLUMN` / `DROP INDEX` 真正生效**（此前静默返回 `ok:true` 但无操作）。
- 插件注册表 CLI（`jsql plugin install`）、Unicode 标识符与 16 进制字面量、`SAVEPOINT` / `ROLLBACK TO` / `RELEASE`、递归 CTE。
- hook 中止语义（`return false` / `throw` 生效）、无主键表 DELETE 按内容匹配、协议嗅探、供应链安全加固（B1–B5）。

### Fixed

- 修复 JSON 路径解析、B-Tree `borrowFromLeft` 父键、ORDER BY NULL、BTree 前缀数字键、BigInt LIMIT、子查询深度限制、UPDATE 安全警告等一批问题。

## 6.3.11 – 6.3.25 — 2026-10-12 ~ 10-13

大批量 bug 修复（P0/P1/P2/P3），主要覆盖：

- 存储 / WAL：WAL 恢复、活引用、`updateById` 约束校验、`truncate` 软删除、文件锁 TOCTOU。
- SQL：位移与一元负号、非数字算术、`SELECT *` 与 JOIN 列处理、ALTER、DDL 缓存、外键 RESTRICT、`UNION` 去重、SELECT 顺序、`STRLEN` 按 UTF-8 字节。
- Redis / PG / Mongo：`WRONGTYPE`、`lrange` 边界、空列表删 key、`delete`/`dropDatabase`、lenenc `0xfe` 8 字节、协议层 path traversal。
- 兼容层：MySQL 连接池、Date 溢出校验、nedb 比较、`escapeValue` 双重转义。
- 性能：`insertMany` 优化。

## 6.3.10 — 2026-10-10

- fix(mongo)：补全 `$group` 聚合 —— 字段级 sum/avg/min/max/first/last
- fix：mysql_server / redis_server / multiserver / tui 资源泄漏
- fix：nedb_compat 错误吞没、`limit=0` 边界
- fix：`mod.js` 路径穿越防护
- fix：MySQL binary 结果集 NULL 行处理、列名 `String()` 包装
- docs：长 README 拆分为模块化 `doc/` 页面；新增 jsql.vexify.top 部署说明

## 6.3.7 – 6.3.9 — 2026-10-10

- 修复 15 个 bug（B-Tree 清理、定时器泄漏、信号处理、`truncate` 软删除、`lrange` 边界、`insertMany` 性能、文件锁 TOCTOU、JOIN 字段冲突等）
- 新增 `DROP INDEX`、递归 CTE（`WITH RECURSIVE`）

## 6.3.6 — 2026-10-05

### Performance

- **WHERE 等值条件下推存储层，主键点查快 420 倍**（P0）：`SELECT * FROM t WHERE id = 12345` 88ms → 0.21ms；SELECT / UPDATE / DELETE 三条路径全部优化。仅等值、AND 链下推；OR/范围/IN/函数/子查询保持原样。

### Fixed

- **无主键表批量删除删错行**（数据损坏级）
- **UPDATE 改主键/唯一列不校验冲突**
- **`+` 静默做字符串拼接** → 修正为 MySQL/SQLite 算术语义
- **聚合函数无法参与算术**（如 `SELECT SUM(sal)/COUNT(*)`）
- `require('jsql-neo')` 真实安装时 `updateById` 约束异常漏 `await`

## 6.3.5 — 2026-10-05

- 核心稳定性修复（真实 Linux 环境压测发现）
- 多协议服务器稳定性改进

## 更早版本

详见完整变更日志 [../CHANGELOG.md](../CHANGELOG.md)。
