# Changelog

All notable changes to **JSQL-NEO** are documented here.
Format: [Keep a Changelog](https://keepachangelog.com) — **Added** / **Changed** / **Fixed** / **Breaking**.
SemVer applies: versions 0.x/3.x-beta are pre-1.0; from 4.0.0 onward the public API is stable.

## [6.3.4] — 2026-10-04

本轮针对一次缺陷审查逐条核对后修复。**其中两条经实测为误报，未做改动**（见文末「已核实为误报」）。

### Breaking

- **`enableMySQLCompat()` 不再劫持 `require.cache`**（P0-1）。旧实现遍历 `node_modules`，
  把 `mysql2/index.js` 与 `mysql2/promise.js` 的缓存条目替换为内存兼容层；它靠
  `process.cwd()` 猜路径，mysql2 通常尚未加载，于是被**静默替换** —— 真实 MySQL 连接
  悄悄改查内存库且不报错，表现为「本地跑通、上线全错」。
  现在默认调用**什么都不做**（仅返回兼容层）；`{ global: true }` 需同时设置
  `JSQL_NEO_ALLOW_GLOBAL_HIJACK=1` 才会执行；新增 `injectMySQLCompat(mod)` 只改写
  指定模块自身持有的引用，不污染全局。
  迁移：`require('jsql-neo').mysql2.createConnection(...)`，或
  `injectMySQLCompat(require('typeorm'))`。

### Fixed

- **WAL / 崩溃恢复是虚假宣传 —— 实测必然丢数据**（P1-1）。三重问题：
  1. `_recoverFromWAL()` 只做 `fs.unlinkSync` **删除**日志，从不回放；
  2. `insert` / `updateById` / `updateByIds` / `removeById` **完全不写 WAL**
     （只记了 DDL 和事务标记），即使回放也没有数据可恢复；
  3. 构造函数用 `fs.existsSync(dataFile)` 短路，新建库崩溃后连 WAL 都不会被读取；
     且 `.jsql` 二进制分支提前 `return`，跳过恢复。

  现在：WAL 改为 **append-only JSONL + `fsync`**（崩溃最多丢最后一条，不会损坏整个日志）；
  数据变更全部进 WAL；启动时按 sequence **真实回放**并立即检查点落盘；
  写半的尾行可容错丢弃。README 同步改为诚实描述并标注边界
  （无主键表不记录行数据、`fsync` 为 best-effort、单进程保证）。
- **native 引擎是进程级单例，同进程无法持有两个数据库**（P0-2）。`thread_local! ENGINE`
  意味着 `new Database(dirA)` 后再 `new Database(dirB)` 会把 dirA 的表**全部 `clear()`**
  （`HybridEngine::open` 无条件清空，注释里还写着这是有意设计），重入调用则直接返回
  `"engine busy (reentrant call)"`。对自称「嵌入式数据库」是硬伤。
  现在改为**句柄注册表**：`jsqlInstanceNew()` 分配句柄，所有操作走
  `jsqlXxxH(handle, ...)`；旧的 `jsqlXxx()` 走保留的默认实例 0，**向后兼容**。
  `native_client.js` 每个实例分配独立句柄并在 `stop()` 释放；加载到旧版预编译二进制时
  自动回退单实例行为。
- **B-Tree `bulkLoad()` 与 `insert` 的分隔键语义不一致**（P2-3）：已确认全仓库零调用
  （索引构建统一走 `table.js` 的 `rebuild` + `insert`），直接移除该死代码而非修复。
- **版本号三套真相**（P1-2）：`package.json` 是 6.3.3 但 README 有 9 处仍写 6.0.1、
  `index.js` 头部写 6.0.0。现统一为 6.3.4，并在 `readme-audit.test.js` 中加自动校验
  （README 横幅、所有版本声明、`index.js` 注释）防止复发。

### Changed

- **覆盖率统计不再自欺**（P3-1）：`test:coverage` 此前排除了
  `mysql_server` / `native_client` / `wasm_client` / `mysql_compat` / `nedb_compat` / `plugin`
  —— 恰是协议服务器与兼容层这些最复杂、最易出事的部分。现仅排除 `web_ui.js`。
- 新增回归测试：`test/wal-recovery.test.js`（18 项）、
  `test/mysql-compat-hijack.test.js`（14 项）、`test/native-multi-instance.test.js`（20 项）。

### 已核实为误报（未改动）

- **P2-1 `lessThan`/`lessThanEqual` 退化成全表扫描 —— 不成立。** 实测触达键数恒等于
  结果行数 +1（`max=1` 时只访问 1 个叶子），已是线性下界。原因是范围查询结果本身就有
  `k` 行，任何实现至少要访问 `k` 个键；且 B-Tree 只维护向后的 `next` 链表，
  「定位起点再向左裁剪」并不比从最左叶正向扫描更快。按建议改 `_findLeaf(max)` 属无意义改动。
- **P2-2 `_findLeaf` 与 `search` 两套下降逻辑导致起点不精确 —— 不成立。** 多级树
  （order 4/5/8/16，n 至 3000）实测定位全部精确，`greaterThan` / `range` 结果与暴力对拍
  100% 一致。`_lowerBound` 向下定位偏左是**保守安全**的方向：多扫的键会被边界过滤丢弃，
  漏查才是 bug。改为复用 `_route` 无可观测收益。

## [6.3.0] — 2026-10-02

### Fixed

- **DATE/DATETIME 列存储在东八区回退一天**（数据损坏级）：`validateDate` 用
  `toISOString().slice(0,10)` 序列化（UTC），而 `parseDateString` 用本地时区构造，
  口径不一致 → `2023-01-01` 存成 `2022-12-31`、`2024-02-29` 存成 `2024-02-28`。
  改为按本地时区序列化，且已是 `YYYY-MM-DD` 的字符串直通返回。
- **数值列与数值字符串比较退化为字典序**：`age < '10'`、`age = '09'` 失真。
  现在一端为数值、另一端为数值字符串时按数值比较。
- **HAVING 在无 GROUP BY 时完全失效**：聚合被逐行计算（`COUNT(*)` 每行都是 1），
  导致 `HAVING COUNT(*) > 2` 滤掉所有行、最终输出 0。现在整张表作为一个分组。
- **MIN/MAX 用于字符串列返回 null**：内部一律 `Number(v)` → `NaN`。
  现在数值按数值比、字符串/日期按字典序/时间序。
- **`NOT (col > x)` 对 NULL 的三值逻辑错误**：含 NULL 的比较被判为 `false`，
  取反成 `true` 后把 NULL 行错误纳入。现在比较含 NULL 返回 UNKNOWN，`NOT UNKNOWN = UNKNOWN`。
- **`LIKE` 大小写敏感，不符合 MySQL 默认**：解析器把 `ci` 写成 `isILike`（LIKE→false）。
  现在 LIKE/ILIKE 均不区分大小写，并支持 `LIKE BINARY '...'` 显式敏感（此前该语法直接解析报错）。
- **相关子查询被列校验误杀**：`EXISTS (SELECT ... WHERE b.av = a.v)` 报
  `no such column: a.v`。现在限定引用指向本层 FROM 之外的表/别名时视为外层作用域并放行。

## [6.2.0] — 2026-10-01

### Added

- **PG JSON 操作符**：`@>`（包含）、`<@`（被包含）、`#>` / `#>>`（路径取值，
  支持 `'{a,b}'` 形式与数组下标）
- **JSON 键存在操作符**：`?` / `?|` / `?&`
- **PG 正则操作符**：双目位置的 `~`（大小写敏感）、`~*`（不敏感）、`!~`、`!~*`
  （单目位置的 `~` 仍是按位取反，按上下文区分）
- **命名参数**：`executeSQL` 第三参传对象时视为命名参数（`{id: 1}` → `:id`），
  并支持 `$1` / `$2` 编号占位符
- **目录摘要脚本** `scripts/folder-checksum.js`：确定性计算整个项目目录的 sha256
  （遍历排序、POSIX 路径、排除依赖与构建产物），支持 `--out` 导出清单、
  `--verify <hex>` 校验

### Fixed

- **`JOIN` 一对多只返回一行**：`ON` 命中后只取第一个匹配的右行。现在收集全部匹配行。
- **`NOW()` / `CURDATE()` / `CURTIME()` 返回 UTC**：用 `toISOString()` 导致东八区凌晨
  整整差一天（`2024-02-29` 被存成 `2024-02-28`）。现改为本地时区；
  `UTC_TIMESTAMP()` 仍按名字保持 UTC。
- **`CURRENT_DATE` / `CURRENT_TIME` / `CURRENT_TIMESTAMP` 不在关键字表**：裸写时被当列名，
  报 `no such column: CURRENT_DATE`。现识别为零参函数（括号可省略）。
- **`NOT IN` 不取反**：`WHERE id NOT IN (1,2)` 返回 `1,2`（等同 `IN`）。现正确取反。
- **`SELECT DISTINCT *` 只剩一行**：`*` 被当列名解析成 `null`，所有行 key 相同。现按整行去重。
- **`ORDER BY 1` 未生效**：位置序号被当常量求值，排序无效果。现在按输出列位置（1-based）排序。
- **字符串内 `''` 未转义**：`'O''Brien'` 报 `Expected ) but got 'Brien'`。现按 SQL 标准
  把连续两个引号解析为一个字面量引号。
- **非主键 `UNIQUE` 约束此前不生效**：`email TEXT UNIQUE` 插入重复值不报错。
  现在默认动作下违反唯一列（含批内重复）抛出 `ER_DUP_ENTRY`；多个 `NULL` 仍允许。
  `ON CONFLICT (col)` / `ON DUPLICATE KEY UPDATE` / `INSERT IGNORE` / `REPLACE INTO`
  对唯一列冲突也按各自语义处理。
- **加速站前缀此前硬编码**：只能通过公共站下载，无法用自建加速站。

## [6.0.4] — 2026-09-29

### Fixed

- **`applyParams` 不会跳过 `--` / `#` / `/* */` 注释**：注释里随便写一个 `:name` / `@name` / `?`
  都会被当成占位符替换（或报错 "Named parameter :foo requires an object of parameters"）。
  现把行注释与块注释在参数替换前整体跳过，与 `splitStatements` 的语义对齐。
- **`tokenize` 静默吞掉未闭合的单/双引号与反引号**：`SELECT 'abc`、`SELECT "abc`、
  `SELECT \`unterminated\`` 此前会被当作合法 token 继续解析，语法错误被静默放过。
  现在 token 阶段直接抛 `Unterminated single-quoted string at position N` /
  `Unterminated backtick-quoted identifier at position N`，错误带位置。

## [6.1.0] — 2026-09-27

### Added — SQL 方言（补齐 README 契约）

- **运算符**：`DIV`（整数除法）、`XOR`（逻辑异或，优先级 `OR < XOR < AND`）、
  `&&` / `||`（`AND` / `OR` 别名）、`<=>`（NULL 安全相等）
- **PostgreSQL 后缀**：`::` 类型转换（含 `DEFAULT '{}'::jsonb`）、
  `->` / `->>` JSON 取值（可链式）
- **DDL 类型**：`SERIAL` / `BIGSERIAL`（整型 + 自增）、`JSONB` / `TIMESTAMPTZ` /
  `BYTEA` / `UUID`
- **`LIKE ... ESCAPE` 子句**：并让 `\%` / `\_` 保留反斜杠，使 LIKE 反斜杠转义可用
- **`executeSQL` 结果信封**：补齐 `columnTypes` / `rowCount` / `message` /
  `command` / `durationMs` / `warnings`
- **UPSERT 唯一列冲突判定**：`ON CONFLICT (col)` 与 `ON DUPLICATE KEY UPDATE`
  现在支持非主键的唯一列冲突，`EXCLUDED.col` / `VALUES(col)` 取本次待插入值
  （此前只认主键，会插入重复行）

### Fixed — 数据正确性

- **默认引擎 `native_client` 并发 flush 重复写（v6.0.2 漏修）**：6.0.2 只修了
  `wasm_client`，默认引擎的同款竞态被遗漏 —— `_flush()` 先遍历 `this._buffer`、
  `await` 之后才清空，期间其他协程继续 push，同一批行被多个 flush 重复写入。
  现改为**先把整个 buffer 原子取出再写入**。实测 2000 并发 insert + 50 次重叠
  flush，落库行数由 **2,003,000 降回 2000**
- **环形对象序列化崩溃**：新增 `safeJsonStringify()`，JSON 列遇循环引用给出
  带表名/列名的可读错误，避免裸 `ReferenceError`
- **未实现的操作符不再静默退化**：`@>` / `<@` / `#>` / `#>>` 此前会被吞掉、
  退化成普通比较（不报错但结果错），现在抛出明确错误

### Fixed — 引擎行为一致性

- `native_client` 与 `wasm_client` 行为对齐：补 `assertRowObject` /
  `safeStringify(表, 列)` 并做 JSON 列**行级**序列化 —— `insert(null / undefined / 42)`
  统一抛 `TypeError`，环形对象统一给出 `Cannot serialize column 'x' of table 'y'`
- `native_client` 新增 `lastFlushErrors()`：坏行不回写 buffer，改记日志供排查

### Fixed — 安全 / 资源护栏

- **`splitStatements` 无界内存消耗（CWE-770，可被一段大文本打挂进程）**：
  逐字符 `current += c` 拼接在「超长且无分号」的 SQL 上产生接近 O(n²) 的拷贝放大，
  实测 20MB 输入在 512MB 堆下直接 `FATAL ERROR: Reached heap limit` 崩溃（退出码 -6）。
  现改为**区间切片收集**（`slice` + 一次 `join`），同一 20MB 无分号输入由 OOM
  降到约 30MB 堆 / ~100ms；并新增输入体积上限 `DEFAULT_MAX_SQL_LENGTH`（默认 64 MiB，
  可用 `executeSQL(..., { maxSqlLength })` 放宽，传 `Infinity` 关闭）。
  `splitStatements` 的切分语义（引号/转义/反引号、`--` `#` `/* */` 注释、分号切分）保持不变。

### Added — 测试

- `readme-audit` 新增 28 条断言（共 95 项通过）；并发 / 校验用例改为**同时跑
  wasm 与 native** —— 此前只测 wasm，导致默认引擎的同款竞态长期漏网

### Changed — 文档

- README 与实现对齐：JSON 运算符表只保留已实现的 `->` / `->>`（`#>` `#>>`
  `@>` `<@` `?` `?|` `?&` 标注“暂不支持”）；PG 正则 `~ ~* !~ !~*` 标注暂不支持、
  示例改用 `REGEXP`；移除算术表里错误的 `^` = 幂（实现为按位异或）；`executeSQL`
  返回示例改为真实字段；运算符优先级表补充 `::` `&&` `||` 并把 `XOR` 单列一级

### Changed

- 版本号 6.0.2 → 6.1.0
- 重新编译 `native/jsql-neo-native.node`（体积优化，854,864 → 802,816 字节）

## [6.0.2] — 2026-09-27

### Fixed — 数据正确性 / 进程稳定性

- **并发 insert 重复写或丢行（最严重）**：`lib/wasm_client.js` 的 `_flush()` 先遍历
  `this._buffer` 再在 `await` 之后清空 —— 期间其他协程继续往同一个数组 push，
  同一批行被多个 flush 重复写入（曾出现并发插 200 行 count=20100）。
  现改为**先把整个 buffer 原子取出再写入**
- **flush 失败不清空 buffer，`stop()` 二次爆炸**：`_insertBatch` 抛错时坏行残留，
  `stop()` 再次 flush 抛同一个错导致进程 exit 1。现在坏行不回写 buffer，
  并记录到 `_flushErrors`（可用 `lastFlushErrors()` 查看），不再静默丢数据
- **`insert(t, null)` / `insert(t, undefined)` 直接 TypeError 且信息无意义**
  （`Cannot convert undefined or null to object`）。现在在入口校验并给出明确
  `TypeError: insert(): expected a row object, got null`
- **环形对象在 flush 时崩溃**：json/object/array 字段无脑 `JSON.stringify`，
  遇到循环引用抛裸错。现在包成带表/列名的可读错误
  （`Cannot serialize column 'meta' of table 't2': ...`）

### Fixed — 功能缺陷

- **Redis inline 命令恒为 "unknown command"**：`_parse()` 在内联分支返回的是
  **数组**（`cmd.map(...)`），而 `_handle()` 用 `switch(cmd)` 匹配字符串，永远匹配不上。
  现返回字符串
- **`*0` / `*-1` 直接崩溃**（`Cannot read properties of undefined`）。现作为空帧忽略
- **RESP 多字节 UTF-8 被截断**：`socket.setEncoding('utf8')` 后按**字符**切片，
  而 RESP 的 `$N` 是**字节**长度，中文等会解析失败/错位。现全程用 Buffer
  按字节处理；回复数组的 bulk 长度也从 `String.length` 改为 `Buffer.byteLength`
- **`SELECT nosuchcol FROM t` 静默返回 null**：调用方拿到"一列 null"往往被当成
  数据为空，比报错更难排查。现在报 `no such column: X`。
  只在实际能确定列名集合时校验（取样本行键 + SELECT 输出别名），
  不深入子查询作用域，空表不断言 —— 避免误伤 `HAVING cnt` 这类别名引用
- **`require('jsql-neo/lib/plugins')` 路径不通**：exports map 只有 `./lib/*` →
  `./lib/*.js`，目录入口解析成不存在的 `./lib/plugins.js`。已加
  `"./lib/plugins": "./lib/plugins/index.js"`

### Fixed — 文档与实际不符

- **插件沙箱说法完全错误（安全相关）**：README 写"Module files run in a VM sandbox"、
  `PLUGINS.md` 写"模块文件在 vm 沙箱中执行（不污染全局）"——
  **代码里根本不存在 vm 隔离**（`lib/mod.js` 就是普通 `require(filePath)`），
  插件与核心完全同权，可访问 `fs` / `child_process`。两处文档均已更正并加安全提示
- **README 目录树里的 `docs/` 在 GitHub 上 404**：该目录不存在，
  已改为指向真实的 `PLUGINS.md`

### Added

- 回归测试扩充到 62 项：覆盖并发 insert、`insert(null)`、环形对象、列不存在校验、
  RESP2 帧解析（含多字节与半包）、子路径导出

### Changed

- 版本号 6.0.1 → 6.0.2

## [6.0.1] — 2026-09-27

### Fixed

本次以 README 为契约做了一次全量审计（把 75 个 SQL 代码块、248 条语句逐条送进
`parseSQL`），之前有 **40 条（16%）文档示例跑不通**。现已全部修复。

- **取模与位运算完全不可用**：`SELECT 10 % 3` 报 `Unexpected character '%'`。
  根因是两层没对齐——`parseTerm()` 里写了 `%` 分支，但 `tokenize()` 的运算符
  字符集不含 `% & | ^ ~ << >>`，词法层根本不产出这些 token，那段是死代码。
  现补齐词法，并按 `| → ^ → & → << >> → + - → * / %` 的优先级新增
  `parseBitwise / parseBitXor / parseBitAnd / parseShift / parseAdditive` 层级，
  一元 `~` 走新的 `bitnot` 节点
- **函数实参不支持比较运算**：`IF(1 > 0,'yes','no')`、`SUM(IF(status='paid',amount,0))`
  全部报 `Expected ) but got '>'`。新增 `parseArgExpr()`，允许实参是完整比较/布尔表达式
  （`parseComparison` 加 `bareExprDepth` 开关，只在实参上下文放宽，WHERE 仍保持严格），
  并让 `resolveOperand` 对 `compare/and/or/not` 等布尔节点返回真值
- **`GROUP_CONCAT` 能解析但静默返回 null**：它是标识符而非保留聚合名，走了逐行标量函数分支。
  新增 `AGG_FUNCS` 集合与 `parseAggregateCall()`，把 GROUP_CONCAT / STDDEV 族 /
  VARIANCE 族 / FIRST / LAST 统一识别为聚合节点
- **`GROUP_CONCAT(... ORDER BY ...)` 排序不生效**：只拼接不排序，静默给错顺序。
  现按内部排序键先行排序再拼接
- **`WITH ROLLUP` 位置错误**（v5.6.0 引入的回归）：识别被放在 ORDER BY/LIMIT 之后，
  导致 `GROUP BY ... WITH ROLLUP HAVING ...` 报 `Unexpected token 'HAVING'`。
  已移到 GROUP BY 列表解析完的紧后面（标准顺序 `GROUP BY <list> [WITH ROLLUP] [HAVING] [ORDER BY] [LIMIT]`）
- **`COUNT(DISTINCT a, b)` 多列去重**不支持，现按元组去重
- **`CREATE INDEX` / `CREATE UNIQUE INDEX` / `DROP INDEX` 完全不支持**（README 有独立章节承诺）；
  `DEFAULT CURRENT_TIMESTAMP` 列默认值解析失败；`DELETE ... LIMIT n`；
  `ON DUPLICATE KEY UPDATE col = VALUES(col)` 的 `VALUES(col)` 引用
- **`DATE_ADD/DATE_SUB` 的 `INTERVAL n UNIT`**、`EXTRACT(unit FROM d)`、
  `SUBSTR(s FROM n FOR m)`、`TRIM([LEADING|TRAILING|BOTH] c FROM s)` 全部不支持
- **表级约束 `FOREIGN KEY ... REFERENCES`、`CHECK`、`KEY name (cols)`、
  `UNIQUE KEY name (cols)`** 会让 CREATE TABLE 解析失败
- **FROM 子查询缺别名直接报错**：README 示例本身就没写别名，现自动生成 `__subN`
- **`createPgServer` 是断掉的导出**：`index.js` 从 `lib/pg_server.js` 解构它，
  但该模块从未导出 → `jsql.createPgServer === undefined`。已补上工厂函数

### Added

- `test/readme-audit.test.js`：把 README 当契约的回归测试（39 项），已接入
  `npm test` 与 `npm run test:all`。以后文档与实现脱节能被自动发现

### Changed

- 版本号 6.0.0 → 6.0.1

## [6.0.0] — 2026-09-26

### Added

- **`db.exists(table, filter)` / `table.exists(filter)` / `query.exists()`**：只判断是否有匹配行，不物化全量结果。
- **`db.prepare(sql)`**：预编译 SQL，返回 `{ all, get, run }`，可反复绑定参数执行。JS / native / WASM 三引擎共用。
- **B-Tree `searchMany` / `prefix` / `greaterThanEqual` / `lessThanEqual`**：等值 IN、前缀 LIKE、单边范围查询走索引。

### Changed

- **仓库历史瘦身**：剔除误提交的 `nativesrc/**/target/` 构建产物与二进制，`.gitignore` 补齐 `target/`、发行产物目录。
- **查询热路径**：叶子查找改为二分；`$in` / `$like 'prefix%'` / `$gt|$gte|$lt|$lte|$between` 走 B-Tree；RIGHT JOIN 改为哈希探测；`findOne` 不再先克隆全表。
- **`Database.use(plugin, opts)`**：JS 引擎与 browser 客户端对齐 native / WASM，第二参数透传给插件工厂。
- **单行 `insert` 触发 `afterInsert`**：native / WASM / browser 不再只在批量分支发钩子。
- **`timestamps` 建表自动补列**：未声明的 `createdAt` / `updatedAt`（可配）写入 schema，native 按列持久化。

## [6.0.0-beta2] — 2026-09-26

### Added

- **`db.addColumn(table, name, def)`**：运行时向已存在的表追加列，无需重建表。
  - Rust 核心 `jsql-neo-core`：新增 `FieldSchema` 级 `add_column`（内存引擎 + HybridEngine，
    同步持久化 meta schema 并标记脏页）；
  - FFI 导出：native（napi `jsqlAddColumn`）与 WASM（wasm-bindgen `jsql_add_column`）双端提供；
  - JS 客户端层：`lib/native_client.js`、`lib/wasm_client.js`、`wasm/browser.mjs` 三处接入，
    共享同一 schema 映射与事件钩子（`addColumn` 事件）。

## [6.0.0-beta1] — 2026-09-25

### Fixed

- **native / WASM 引擎的模糊查询静默失效**：`db.find(table, { field: { $like } })`
  与 `{ $regex }` 在 Rust 引擎上此前不匹配任何行（回退为「永不匹配」）。
  现于 `jsql-neo-core` 的过滤条件解析中新增 `Cond::Like` / `Cond::Regex`，
  引入线性时间、无回溯的 `regex-lite` 引擎（无 ReDoS 风险，因此无需 JS 侧
  `isSafeRegex` 的长度拦截）：
  - `$like`：SQL 风格通配（`%`→`.*`、`_`→`.`），转义正则元字符，锚定整串，大小写不敏感；
  - `$regex`：JavaScript 风格正则，大小写敏感，值先做 `String(value)` 再匹配；
  - 模式在查询解析阶段编译一次，逐行仅匹配；非法/编译失败的模式退化为不匹配（不崩溃）。
  行为与 JS 引擎 `lib/table.js` 的语义逐一对齐。

### Added

- **可编程插件系统扩容**（`lib/plugin.js` 统一运行时，native / WASM / JS 三引擎共用）：
  - 开放四类扩展点：生命周期钩子、事件监听、插件上下文（ctx）、插件 API；
  - 插件上下文新增 `store`（按插件名隔离的私有存储）、`config`、`log`、
    `emit`、`hook`（触发自定义钩子）、`use`、`tables/hasTable/getTableSchema`、
    `expose`（运行期声明 API）；
  - 未知钩子名自动登记，插件可自定义扩展点；`on` 支持同名多次注册，按序执行；
  - 引擎新增公开方法 `db.emit()` / `db.runHook()` / `db.plugin(name)`；
  - `db.use()` 现支持字符串（内置插件名）、插件对象或函数三种形态；
  - 新增钩子 `beforeQuery` / `afterQuery`，在 native / WASM 的 `query()` 前后触发；
  - 导出 `Plugin` / `definePlugin` / `HOOKS` / `plugins`。

- **内置插件集**（`lib/plugins`）：
  - `timestamps`：自动维护 `createdAt` / `updatedAt`（字段名可配）；
  - `validation`：基于 schema 的插入/更新校验（not null、类型、maxLength、min/max、自定义校验函数）；
  - `logger`：把操作记录到自定义 logger（可按表过滤）；
  - `metrics`：统计各类操作次数，`db.plugin('metrics').snapshot()` 读取；
  - `audit`：内存环形缓冲的变更审计日志，`db.plugin('audit').entries()` 读取。

### Breaking

- 插件钩子的返回值语义收紧：**仅 `false` 有效（中止操作）**，
  不再用返回值覆盖第一个参数。此前 `args[0]` 恒为表名，覆盖它会污染表名，
  属历史遗留缺陷；需要改写数据时请在钩子内原地修改传入的数组 / 对象。

### TODO（核对于 6.0.0，2026-09-26）

已完成（不要再做）：

- **WASM 已用新核心重新编译**：`wasm/jsql_neo_wasm_bg.wasm` 已导出 `jsql_add_column`，
  并编入 `regex-lite`。`$like` / `$regex` / `addColumn` 在 WASM 上已可用。
  不要再执行 `cargo build --target wasm32-unknown-unknown` 除非改了 `nativesrc/`。
- **`exists` / `prepare` / B-Tree IN·前缀 LIKE·范围查询** 已落地（见 6.0.0）。
- **Git 历史已瘦身**：`nativesrc/*/target/`、`bin/jsql-neo-server`、`*.tgz` 已从历史剔除，
  `.git` ≈ 3.3M。不要再全量 clone 后重复 filter-repo。
- **`Database.use(plugin, opts)` 已透传第二参数**：JS / native / WASM / browser
  四处 `use()` 均把 `opts` 交给 `applyPlugin`（browser 合并进 `plugin.config`）。
- **单行 `insert` 已触发 `afterInsert`**：native / WASM / browser 在单行 flush
  后同样 `_emit('insert')` + `_runHooks('afterInsert')`，`metrics` / `audit` 不再漏记。
- **`timestamps` 建表自动补列**：`beforeCreateTable` 若 schema 未声明
  `createdAt` / `updatedAt`（字段名可配），会原地写入 `{ type: 'string' }`，
  native / WASM 按 schema 列持久化即可带上时间戳。已有同名列不覆盖。

### Verification

- native 引擎模糊查询手动验证通过：`$like`（大小写不敏感、`%`/`_` 通配、元字符转义）、
  `$regex`（大小写敏感、`(?i)` 内联标志）、与 `$gte`/`$in` 组合、非法正则不崩溃。
- 插件系统手动验证通过：`timestamps` / `metrics` / `audit` / `logger` / `validation`
  内置插件、`db.plugin(name)` 取 API、自定义钩子、`ctx` 扩展接口。
- `test/native.test.js`、`test/smoke.js`、`test/wasm.test.js` 均通过；
  `test/regress-5.1.0.js` 中 `$like` 相关用例通过（唯一失败项为环境缺失依赖
  `@vexify-org/yaggs` 导致的 CLI `--version` 检查，与本次改动无关）。

## [5.6.0] — 2026-09-19

### Fixed

- **相关子查询静默返回 null**（数据正确性问题）：README 首页示例
  `SELECT name, (SELECT COUNT(*) FROM orders o WHERE o.uid = u.id) FROM users u`
  能解析通过，但每一行的计数都是 `null`。根因是相关性支持只做在 `EXISTS` 上
  （`ctx.__outer` 逐行注入），SELECT 列表里的标量子查询与 `IN (SELECT ...)`
  走 `_materialize` 只求值一次、拿不到外层行，且 `_materialize` 会 `delete expr.select`
  使节点无法重算。现在统一为 `_collectSubqueries` + `_isCorrelated` + `_evalCorrelated`：
  只有引用了外层别名的子查询才逐行重算（非相关子查询仍只算一次），
  SELECT 列表通过新增的 `_projectRows` 做"求值一行、投影一行"交错处理
- **`WHERE (SELECT ...) > 2` 解析失败**：`parseNot` 把 `(SELECT` 当成普通括号分组，
  现在先探测 `(SELECT` 再决定是否走分组分支
- **非相关标量子查询未求值**：`statement.columns[].scalar` 从未进入 `_materialize`，
  现已纳入

### Added

- **`FULL OUTER JOIN`**（left 与 right 未匹配行都保留）
- **`RETURNING`**：用于 `INSERT` / `UPDATE` / `DELETE`，结果挂在返回对象的
  `returning: { columns, rows }` 上（同时填充 `columns` / `rows`）
- **冲突处理策略统一**：`INSERT IGNORE`、`REPLACE INTO`、
  `INSERT ... ON CONFLICT (cols) DO NOTHING | DO UPDATE SET ...`，
  与既有 `ON DUPLICATE KEY UPDATE` 归一为 `_conflictAction()` 的
  四个动作（throw / ignore / update / replace）；`ignore` 会返回 `duplicateSkipped`
- **`CREATE [OR REPLACE] VIEW` / `DROP VIEW [IF EXISTS]`**：视图定义存于
  `engine._views`，查询时由 `_expandViews()` 内联为 FROM 子查询（可嵌套，深度上限 16）
- **`EXPLAIN [ANALYZE] <stmt>`**：输出 `step` / `detail` 两列的计划结构
  （无代价模型，只展示扫描/连接/过滤/聚合/排序/限制等步骤）
- **`WITH ROLLUP`**：在分组结果末尾追加汇总行（分组列置 NULL，聚合列覆盖全部行）
- **`CAST(expr AS <type>)`**：支持 INTEGER/BIGINT/TINYINT、FLOAT/DOUBLE/DECIMAL、
  BOOLEAN、TEXT/VARCHAR/CHAR/STRING，以及 `VARCHAR(10)` 这类带长度写法
- **`ILIKE`**（PG 方言，大小写不敏感 LIKE），含 `NOT ILIKE`
- **`= ANY (SELECT ...)` / `> ALL (SELECT ...)`**（含 `SOME`）
- **`ORDER BY <表达式>`**：支持 `ORDER BY a + b DESC`、`ORDER BY UPPER(name)`；
  纯列名仍解析为字符串形态，不影响既有下游
- **`FETCH FIRST|NEXT n ROWS ONLY`**：SQL 标准的 LIMIT 写法
- **`SAVEPOINT` / `RELEASE SAVEPOINT` / `ROLLBACK TO SAVEPOINT`**：前两者解析并登记，
  **`ROLLBACK TO` 会明确报错**——引擎没有保存点/快照能力，静默假成功比报错更危险
- `test/sql-parser.test.js` 扩充到 **133 项**（新增 50 项覆盖以上全部能力）

### Changed

- 版本号升至 5.6.0
- `parseStatement` 允许「未进关键字表」的语句起始词（`EXPLAIN` / `SAVEPOINT` / `RELEASE`），
  按上下文识别；这些词刻意不进 KEYWORDS，以免影响同名标识符
- `parseFromItem` 的表别名排除表补入 `FULL` / `OUTER` / `FETCH` / `RETURNING` / `WINDOW`，
  修复 `FROM t FETCH FIRST ...` 里 FETCH 被当成别名吃掉的问题
- README 中 `SAVEPOINT` 一节改为如实说明：解析支持，但 `ROLLBACK TO` 因引擎无快照能力而不支持

## [5.5.0] — 2026-09-19

### Added

- **CTE（公用表表达式）**：`WITH [RECURSIVE] name [(cols)] AS (SELECT ...) [, ...] SELECT|INSERT|UPDATE|DELETE`。
  支持多个 CTE 串联与 CTE 引用先前 CTE；执行层以内联 FROM 子查询实现，不依赖引擎侧临时表
- **窗口函数**：`OVER (PARTITION BY ... ORDER BY ... [ROWS|RANGE BETWEEN ... PRECEDING/FOLLOWING AND ...])`
  支持 `ROW_NUMBER()`、`RANK()`、`DENSE_RANK()`、`NTILE(n)`、`LAG/LEAD(expr[, n[, default]])`、
  `FIRST_VALUE()`、`LAST_VALUE()`，以及 `SUM/AVG/MIN/MAX/COUNT() OVER (...)` 窗口聚合
- **集合运算符**：`INTERSECT [ALL|DISTINCT]` 与 `EXCEPT [ALL|DISTINCT]`（默认 DISTINCT，与 `UNION` 一致）；
  `UNION` 新增 `UNION DISTINCT` 显式写法
- **`EXISTS` / `NOT EXISTS`**：支持相关子查询（逐行求值，外层行通过 `ctx.__outer` 注入解析）
- **原生 `?` 占位符**：词法层识别 `?` / `?N` / `??`，生成 `{ type:'param' }` AST 节点；
  可通过 `executeSQL(db, sql, { params: [...] })` 绑定（原有数组入参走 `applyParams` 的路径不变）
- **`INSERT INTO t [(cols)] SELECT ...`**
- **AST 访问与改写**：新增 `lib/ast.js`，提供 `walk` / `collect` / `find` / `transform`（不可变）/
  `rewrite`（原地）/ `tables` / `columns` / `StatementVisitor`；已从 `lib/sql.js` 导出
  （`AST`、`walk`、`transform`、`visit`）
- `test/sql-parser.test.js`（82 项）纳入 `npm test` 与 `test:all`

### Fixed

- **`splitStatements` 反引号标识符被误切分**：`` SELECT `a;b` FROM t `` 中的分号曾被当作语句分隔符，
  切成两条语句。现在按 MySQL 规则处理反引号（反斜杠不是转义符，`` `` `` 才是转义反引号）
- **`RLIKE` 无法解析**：`RLIKE` 已在关键字表中，但语法层只处理了 `LIKE` / `REGEXP`。
  现 `RLIKE` 作为 `REGEXP` 的同义词，`NOT RLIKE` 同样可用
- **`TRUE` / `FALSE` 不能作为值字面量**：`WHERE a = TRUE` 曾报 “Expected value or column, got 'TRUE'”，
  而 `IS TRUE` 却可用。现在二者一致，并按 MySQL 语义让 `1 = TRUE`、`0 = FALSE` 成立
- **限定列静默回退到裸列名**：`resolveOperand` 在 `alias.col` 查不到时会回退到裸列名 `col`，
  导致相关子查询里 `e.dept` 取到内层行自己的 `dept`，`EXISTS` 恒为真。
  现在仅当行完全没有前缀键时才回退，未知限定符返回 `undefined`
- **窗口函数列取值为 null**：SELECT 最终投影走的是内联逻辑，未使用 `scalarColumnValue`，
  导致窗口列恒为 null、窗口聚合列抛 `n.includes is not a function`。现统一走 `windowColumnValue()`

### Changed

- 版本号升至 5.5.0
- 关键字表新增 `WITH` / `RECURSIVE` / `INTERSECT` / `EXCEPT`；
  `OVER` / `PARTITION` / `UNBOUNDED` / `PRECEDING` / `FOLLOWING` **刻意不加入**关键字表，
  改由语法层 `isWord()` 按上下文匹配，避免 `SELECT rank FROM t` 这类既有语句被破坏

## [5.4.0] — 2026-08-30

### Added

- **WASM 事务支持**：`jsql_begin_tx` / `jsql_commit_tx` / `jsql_rollback_tx` 绑定，
  WASM 客户端 `beginTransaction()` / `commit()` / `rollback()` 与 `NativeJSQL` 一致
- **整串简写 schema**：`createTable(name, 'id integer primary key auto_increment, name string')`
- `test/wasm.test.js`（20 项）纳入 `test:all`，`test:all` 补入 `test/join.test.js`

### Changed

- 版本号升至 5.4.0（package.json / Cargo.toml / Mongo `buildInfo` / README 同步）
- 仓库瘦身：移除 `nativesrc/*/target/`（1155 个构建产物）、`bin/jsql-neo-server`（ELF）、
  根级 `database.js`/`btree.js` 副本、`lib/compress_pool.js` / `lib/compress_worker.js`（死代码）、
  `bench/report.md`（生成产物）；`.gitignore` 补全 `bin/jsql-neo-server`

## [5.2.0-beta.1] — 2026-08-17

### Changed

- 版本号重新基线为 `5.2.0-beta.1`（package.json / Mongo `buildInfo` / README 同步）

### Added

- **WASM 事务支持**：`jsql-neo-wasm` 新增 `jsql_begin_tx` / `jsql_commit_tx` / `jsql_rollback_tx`
  绑定，`JSQL`（WASM 客户端）新增 `beginTransaction()` / `commit()` / `rollback()` 别名，
  与 `NativeJSQL` 事务行为一致
- **主键感知的 by-id CRUD**：`findById` / `findByIds` / `updateById` / `updateByIds` /
  `removeById` / `removeByIds` 在表存在主键时按主键值解析（字符串主键如
  `findById('config', 'a')` 直接可用），与 `Database._resolveId` 语义一致
- 非自增主键表 `insert` 返回值回填主键值（`insert('config', {key:'a'}) → ['a']`）
- **整串简写 schema**：`createTable(name, 'id integer primary key auto_increment, name string')`
  逗号分隔整串直接可用（原生 + WASM）
- `NativeJSQL` 新增 `beginTransaction()` / `commit()` / `rollback()` 别名（自动跟踪 txId）
- 新增 `test/wasm.test.js`（20 项：CRUD / 主键 / 主键回填 / 整串简写 / 事务），并纳入 `test:all`

### Fixed

- `findById` 返回嵌套 `{id, fields:{...}}` 结构的问题（表存在主键时）
- `examples/playground` 依赖解析指向旧版 v5.1.2 副本的问题（重新 `npm install`）

## [5.3.1] — 2026-08-12

### Fixed

- **`MysqlConnection` 未导出导致多协议服务器 MySQL 路由崩溃**：`lib/mysql_server.js` 定义了
  `MysqlConnection` 类但从未导出，而 `lib/multiserver.js` 需要 `new MysqlConnection(socket, server)`
  处理 MySQL 连接（v5.1.1 改动遗留）；现已补全导出。

### Changed

- 版本号升至 5.3.1（package.json / Mongo `buildInfo` 同步）

## [Unreleased]

- Planned: GitHub Releases for tagged versions, coverage badge, more storage plugins.

---

## [5.1.3] — 2026-08-10

### Fixed

- **SQL JOIN 未匹配行空列填充错误**：LEFT/RIGHT JOIN 未匹配行此前不补对端表的前缀 null 列，限定列名（如 `b.id`/`a.id`）会回退到未前缀副本拿到左/右表的错误值；现按对端表 schema 生成 `prefix.column` 为 null 的补齐行。
- **UPDATE/DELETE 主键定位（非 `id` 主键表）**：行 ID 不再硬编码 `id`，改用实际主键字段值（`_rowPkId`）。
- **`information_schema.*` 限定表名解析**：`.TABLES` 等关键字表名不再被误判为非法。
- **autoIncrement 批量预分配**：`insertMany` 批量插入先扫描显式提供的最大值，一次性推进计数器，再在循环内用本地序号分配，避免显式大 ID 与自动 ID 交错时的计数不连续。
- **Query builder RIGHT JOIN 未匹配行**：右表数据保留、本地表字段补 null（`_rightNullRow`）。

### Added

- `test/join.test.js`：LEFT/RIGHT/INNER JOIN 空列填充、WHERE 过滤、自连接、链式 JOIN 回归测试（11 断言）。

---

## [5.1.2] — 2026-08-09

### Fixed

- **B-Tree 删除崩溃（Issue #3 Bug #1）**：删除改为惰性叶子删除，不再操作内部节点结构，消除 `children[index + 1]` undefined 崩溃。
- **B-Tree `entries()` 乱序重复（Issue #3 Bug #2）**：`entries()` 改为只遍历叶子链表（内部分隔键是叶子副本，不再重复计入）。
- **B-Tree 唯一索引失效（Issue #3 Bug #3）**：唯一索引插入遇到重复键时不再追加 values，`search` 只返回真实叶子数据。
- **B-Tree 内部节点分裂结构错误**：`_splitChild` 分裂内部节点时错误地保留中间键，导致 `children !== keys + 1`，整棵树从一开始就结构非法；现按叶子/内部节点分别处理。
- **B-Tree 插入/删除/查找路由歧义**：新增 `_route()` 统一按左子树最大键判定分隔键副本的真实数据所在子树，避免同一键被插入到两片叶子、查找/删除落到错误子树。
- **B-Tree 多值键删除**：`_removeFromNode` 只移除目标 rowIndex；key 仍存在时不再 `_size--`（size 语义为不同 key 数）。
- **`parseFieldShorthand` 关键字回填**：各子句基于累积清理后的 type 逐项 strip，`'integer primary key auto_increment'` 不再解析出 `'integer primary key'`。

### Added

- **`test/btree.test.js`**：Issue #3 三 bug 复现 + 多阶数随机插入/删除压力 + 随机混合操作对照参考模型，151 项断言。
- **`test/regress-5.1.0.js`**：43 项回归，覆盖 5.1.0/5.1.1 全部修复项（M1–M6、H1/H3、S1–S6、N1/N2）。

---

## [5.1.1] — 2026-08-09

### Fixed

- **CLI `--version` 报告 `1.0.0`**：`yaggs()` 现在传入包的 `pkg`，`jsql --version` 输出与包版本一致。
- **WebUI 无 token 时 CORS 默认 `*`**：无 `authToken` 且未显式 `allowOrigin` 时不再输出 `Access-Control-Allow-Origin`（含预检），任意站点无法跨域读写；有 `authToken` 时保持回显 Origin，显式 `allowOrigin` 仍可跨域。

---

## [5.1.0] — 2026-08-09

### Fixed

- **B-Tree 删除后索引陈旧**：swap-pop 删除时同步维护 hash `_indexes`（`remove`/`removeById` 两处），并让 `_applyFilterOptimized` 真正利用 hash 索引做等值加速。
- **B-Tree 区间边界**：`greaterThan` / `lessThan` 改为严格开区间，不再包含边界值。
- **`removeById`/`removeByIds` 索引维护**：有主键时走 `table.removeById`（正确维护 PK/hash/BTree），无主键时删除后重建索引。
- **事务快照深拷贝**：`begin()` 的 REPEATABLE_READ 快照改为深拷贝，嵌套对象字段可正确回滚。
- **字段简写解析**：新增 `parseFieldShorthand`，正确解析 `'integer primary key'`、`'integer primary key auto_increment'`、`'string unique'`、`'string not null'`、`'string default x'`；重复主键/唯一值现在抛 `ER_DUP_ENTRY`。
- **migrate `importFromJSON`**：兼容单表 `{table, schema, rows}` 形状；默认不再静默 dropTable 覆盖已有表，需显式 `{ overwrite: true }`。
- **Redis 认证跨连接共享**：认证状态改为每连接独立，任一台 AUTH 不再放行其它连接；同时修复 `-new Error(...)` 产生 `:NaN` 响应的问题。
- **Web UI 默认暴露**：默认监听 host 收紧到 `127.0.0.1`；新增 `authToken` Bearer 认证；CORS 不再无条件 `*`，开启认证时回显请求 Origin。
- **MySQL ACL 漏洞**：`dropDatabase` 补 ACL 校验；`SHOW TABLES FROM db` 与 `db.table` 跨库引用路径补 `_canAccessDb`（errno 1044）。
- **native `encodeBatch`**：先精确计算缓冲区大小再编码，消除长字符串越界崩溃与列数截断。
- **mysql_compat 池引擎**：`_sharedEngineFor` 优先使用池的 `filename`，不再恒建 `:memory:` 丢失写入。
- **`enableMySQLCompat`**：不再覆盖已加载的真实 mysql2。

### Changed

- CLI 所有 `alias` 选项改为数组形式，修复 `--help` 崩溃。

---

## [5.0.1] — 2026-08-08

### Added

- **better-sqlite3 full API compatibility layer** (`jsql-neo/sqlite`, `lib/sqlite_compat.js`) — drop-in replacement for `better-sqlite3` backed by the JSQL-NEO engine via a worker-thread synchronous bridge:
  - `new Database(path)`, `db.exec()`, `db.pragma()` (incl. `user_version = N` setters), `db.transaction()`, `db.serialize()` / `db.deserialize()`, `db.backup()`, `db.function()`, `db.aggregate()` (functional and `{start,step,result}` forms).
  - `Statement` — `run()` / `get()` / `all()` / `raw()` / `pluck()` / `iterate()` / `columns()` / `bind()`, positional (`?`, `?N`), named (`@name`, `:name`, `$name`) parameters, `last_insert_rowid()`, `changes`.
  - Registered as subpath export `jsql-neo/sqlite`.
- Custom aggregate functions recognized in `GROUP BY` and whole-table aggregate output.
- `PRAGMA user_version = N` (and other settable pragmas) now persist per connection.

### Fixed

- `last_insert_rowid()` returned 0: worker `executeStatement` was synchronous over an async `executeSQL`, so the last-inserted id was never tracked.
- Named-parameter objects (`{name: 'y'}`) were misinterpreted as engine options; now pre-bound via `applyParams`.
- `cnt(*)` / custom aggregates with `*` failed to parse (`Expected value or column, got '*'`).
- `serialize()` Buffer was flattened to a plain object across the worker bridge; now passed through intact.
- `pragma()` returned bare scalars instead of row objects for simple pragmas.

### Changed

- License: **MIT → Apache-2.0**.

---

## [4.4.1] — 2026-08-06

Big engineering pass: protocol servers, web UI, CLI tooling, types, benchmarks, CI.

### Added

- **Redis-compatible server** (`RedisServer` / `createRedisServer`, `jsql redis`) — RESP2 wire protocol, 40+ commands (strings, hashes, lists, sets, counters, TTL, `KEYS`/`DEL`/`EXISTS`, multi-DB `SELECT`, `AUTH`, `INFO`), snapshot persistence to `data.rdb.json` (debounced 500ms + shutdown flush). Verified against `ioredis`.
- **Built-in Web UI** (`WebUI`, `jsql ui`) — zero-dependency HTTP management console: browse databases & tables, run SQL in the browser, result grids.
- **CLI suite** — `jsql export` / `import` (mysqldump, JSON, CSV) / `bench` / `serve` / `server start|stop|status` / `redis` / `ui` / `mod` / `version`.
- **Migration tools** (`lib/migrate.js`) — `importDumpFile`, `importFromJSON`, `importFromCSV`, `exportToFile`, `exportTableToJSON`, `exportAllToJSON`, `exportTableToCSV`; handles real mysqldump output (escapes, comments, `COLLATE`, `CHARACTER SET`).
- **Full TypeScript declarations** — `index.d.ts` (every public class, server, tool) + `wasm/browser.d.ts`; wired via `"types"` and `exports.types` conditions; verified with `tsc --strict`.
- **Benchmark suite** (`bench/`) — Native vs better-sqlite3 vs sql.js vs pure JS on 100k rows; Native ~2× faster than better-sqlite3 overall.
- **Browser playground** (`examples/playground/`) — full SQL engine in the browser (WASM + IndexedDB), zero server.
- **GitHub Actions CI** — engine smoke tests on Node 18/20/22 + a full ORM compatibility job (Sequelize / Knex / TypeORM).
- `NativeJSQL` storage modes documented (`memory` / `hybrid` / `disk`).
- Tests: zero-dependency smoke suite (`npm test`), ORM suites under `examples/orms/` (`npm run test:orms`).

### Fixed

- `SELECT fn()` now returns MySQL-style column names with parentheses (e.g. `version()`), fixing TypeORM `getVersion()`.
- Multi-aggregate `SELECT` returned only the last column; all columns are returned now.
- `encodeLenenc` / binary result sets hardened against `BigInt` and non-finite numbers.
- npm package slimmed (excluded `examples/browser/node_modules`, `fake-indexeddb`, native build artifacts) — 11MB → ~3.9MB.

### Changed

- Parser and scalar evaluation thread a session context through (`LAST_INSERT_ID()`, `ROW_COUNT()`, `FOUND_ROWS()`, `CONNECTION_ID()`, `DATABASE()`, `@@sysvar` state via `SET`).
- Expanded MySQL `errno` mapping (~25 codes).

### Breaking

- None. All 4.4 changes are additive.

## [4.4.0] — 2026-08-06

### Added

- Redis-compatible server, Web UI, CLI tools, benchmark suite, migration tools, TypeScript declarations, browser playground, CI workflow. *(First release shipping the full toolbox; details folded into 4.4.1, which is the recommended install.)*

### Breaking

- None.

## [4.3.0] — 2026-08-05

### Added

- TypeScript declarations for the package (`index.d.ts`, `wasm/browser.d.ts`).
- Migration tools (`migrate` module + direct function exports).
- CLI export/import commands.
- MySQL deep-compat: `LAST_INSERT_ID()`, `ROW_COUNT()`, `FOUND_ROWS()`, `CONNECTION_ID()`, `DATABASE()`, `@@` system variables, persistent `SET @@sql_mode`.
- ORM test suites in-repo (Sequelize / Knex / TypeORM) and a zero-dependency smoke suite (`npm test`).

### Fixed

- Prepared statements: double `applyParams`, binary protocol result sets, `dataRows` alias, `stripDefault`.
- `autoIncrement NOT NULL` false-positive on DDL import.
- `SELECT` multi-aggregate column loss.

### Breaking

- `SELECT fn()` column names now include parentheses (`version()`), matching MySQL. Code relying on the old bare name must use an alias (`SELECT VERSION() AS v`).

## [4.0.2] — 2026-08-03

### Added

- SQL `WHERE` equality pushdown (point-style filter on indexed columns — measured 808ms → 6ms).
- `COUNT(*)` computed via the engine.
- Bulk `INSERT` in a single batch.

### Fixed

- Explicit `id: 0` now auto-increments correctly (was treated as literal `0`, losing `fields.id`).

### Breaking

- Explicit `id: 0` previously stored literally; it now behaves like "auto-generate next id". Use a real value if you must insert id `0`.

## [4.0.1] — 2026-08-03

### Changed

- README rewritten for v4 (three engines, SQL, storage modes).

### Breaking

- None.

## [4.0.0] — 2026-08-02

### Added

- **Native engine: hybrid & disk storage** — Rust `HybridEngine` (`jsql_open` / `flush_dirty` / `evict` / `close`), Redis-style model: memory-first, async incremental flush, 0.5GB `memReserve`, LRU eviction, lazy reload, per-table `.jsql` files, atomic writes (tmp + rename).
- Ordered schema fields and explicit `id` support.
- `LICENSE` and npm `files` whitelist.

### Changed

- Unified engine API across Native / WASM / Pure JS (`createTable` / `insert` / `findById` / `find` / `updateById` / `removeById` / `dropTable` + `executeSQL`).

### Breaking

- Engine API unification: code written for older 3.x helpers should migrate to the shared engine methods.
- Hybrid/disk storage requires a `path` + `mode` option and is opt-in; default remains in-memory.

## [3.6.0-beta.11] — 2026-07

### Added

- Full SQL engine (CREATE/DROP/INSERT/SELECT/UPDATE/DELETE, `WHERE`/`ORDER BY`/`LIMIT`/`GROUP BY`/`HAVING`, aggregates, prepared `?` statements, `ON DUPLICATE KEY UPDATE`).
- MySQL protocol server (`createMysqlServer`) — prepared statements, binary result sets, `SHOW *`, `information_schema`, transactions, `TRUNCATE TABLE`, `SET`.
- NeDB-compatible layer (`Datastore`) and MySQL client compat (`mysql_compat` — `createConnection` / `createPool`, `[rows, fields]` results).

### Fixed

- beta.11 regression pass: no-column `INSERT` mapping, SQL performance, ODKU, `?` placeholders, `AS` aliases, auto primary keys, errno mapping.

### Breaking

- None beyond engine API unification (see 4.0.0).

## [3.6.0-beta.10] — 2026-07

### Added

- Plugin system (`Plugin`) and module registry (`ModuleManager`, `jsql mod`).
- Unified engine API (`lib/native_client.js`).

## [3.6.0-beta.6] — 2026-07

### Added

- Batch delete/update, compact JSON storage, swap-remove optimization.

## [3.4.0] — 2026-06

### Added

- "Amazing version" — full 3.x feature consolidation.

## [2.0.0] — 2026-06

### Added

- **B-Tree indexes** for range queries.
- **Hash JOIN** support.
- **WAL** + snapshot crash recovery.
- **Transaction isolation**.
- MySQL-style error codes.
- `JSQL-Neo vs MySQL` comparison report.

### Breaking

- Introduced storage layout v2; older 1.x data files require migration.

---

## Archive

- [v3.4.0](https://github.com/vexify-org/JSQL-neo) — 3.4.0 source tag.
- npm keeps a full history of every published version — `npm view jsql-neo versions`.

[Unreleased]: https://github.com/vexify-org/JSQL-neo
[4.4.1]: https://github.com/vexify-org/JSQL-neo/releases/tag/v4.4.1
[4.0.2]: https://github.com/vexify-org/JSQL-neo/releases/tag/v4.0.2
[4.0.1]: https://github.com/vexify-org/JSQL-neo/releases/tag/v4.0.1
[4.0.0]: https://github.com/vexify-org/JSQL-neo/releases/tag/v4.0.0
