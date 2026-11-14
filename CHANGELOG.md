# Changelog

All notable changes to **JSQL-NEO** are documented here.
Format: [Keep a Changelog](https://keepachangelog.com) — **Added** / **Changed** / **Fixed** / **Breaking**.
SemVer applies: versions 0.x/3.x-beta are pre-1.0; from 4.0.0 onward the public API is stable.

## [Unreleased]

### Fixed

- **`ADDDATE` / `SUBDATE` 的数字（天数）形式被静默忽略**：`lib/sql.js` 的
  `case 'DATE_ADD'/'ADDDATE'` 只处理 `INTERVAL n UNIT`，第二个参数直接给天数时
  会 fallthrough 到「原样返回日期」，整个增量被丢掉且不报错。MySQL 里
  `ADDDATE(expr, days)` 与 `DATE_ADD(expr, INTERVAL days DAY)` 等价。

  ```sql
  SELECT ADDDATE('2026-01-01', 5);   -- 修复前 '2026-01-01'，修复后 '2026-01-06'
  SELECT SUBDATE('2026-01-10', 5);   -- 修复前 '2026-01-10'，修复后 '2026-01-05'
  ```

  非数字天数按 MySQL 返回 `NULL`（用 `numericIfNumeric()` 严格判定，避免
  `mysqlNum()` 的宽松强转把 `'abc'` 变成「加 0 天」这类新的静默错误）。
  `DATETIME` 输入仍保留时间部分，跨月/跨年/闰年边界与既有 `INTERVAL` 形式一致。

  新增 `test/adddate-numeric.test.js`（17 项）覆盖加/减、负数、跨月跨年闰年、
  DATETIME、列值、非法输入，以及 `DATE_ADD`/`DATE_SUB` 的 INTERVAL 形式不回归。

## [6.6.2] — 2026-11-14

### Added

- **统一的网络访问策略**（新增 `lib/network-policy.js`）：
  - `JSQL_OFFLINE=1|true|yes|on` 一键禁用所有外部网络访问；
  - 约定任何真正访问外网的位置都要在紧邻处写 `NETWORK:` 注释
    （Why 为什么非联网不可 / Trigger 什么操作触发 / Offline 离线时行为 /
    Scope 目标主机）；只连 127.0.0.1 的本地回环写 `LOCAL-ONLY` 一句。
- `jsql star --token-check`：用 `GITHUB_TOKEN` / `gh` 直接查 GitHub API 并
  写回 `~/.jsqlmr`，不开浏览器、不走 OAuth。

### Changed

- **CLI 启动路径不再有任何网络请求。** 此前每次启动都会同步
  `curl api.github.com`（外加 `gh auth token`）确认 star 状态，最多阻塞
  ~9.5 秒，只为少印一行提示；现在只读本地 `~/.jsqlmr`，零出网。
- `jsql update` / `jsql plugin *` / `jsql star` / 安装期下载 native 的
  出网点全部加了离线短路：离线时给出可读原因，不再静默失败。

### Tests

- 新增 `test/network-policy.test.js`（28 项）：打桩 `execFileSync` / `execFile` /
  `spawn`，断言启动路径零子进程调用；离线时各联网入口被拦住且不出网。
  已进 `npm test` 与 `test:all`。

## [6.6.1] — 2026-11-14

> 补记：这一版发布时未单独写入 CHANGELOG。

- 修复 issue #77~#84（PR #85）：BIGINT 比较与 UNION、触发器、三值逻辑 XOR、
  `$pull`、亚秒精度、BOOLEAN 比较、插件优先级。
- 同步各处的版本标记（package.json / index.js / README）。

## [6.6.0] — 2026-11-13


### Breaking

- **日期/时间字面量改为以 UTC 为稳定基准**：不带时区标记的日期字面量
  （`'2024-01-15'`、`'2024-01-15 10:30:00'`）现在按 **UTC 墙上时间** 解释，
  不再按运行主机的本地时区解释。同一份 SQL 在任何 `TZ` 下的落库值完全一致
  （此前 `Asia/Shanghai` 与 `UTC` 机器会差 8 小时，跨主机不可移植 — #75）。
  - 带 `Z` / `±HH:MM` 的字面量语义不变：先换算成绝对时刻，再以 UTC 墙上时间存储。
  - 因此 `'2024-01-15T10:30:00Z'` 与 `'2024-01-15 10:30:00'` 落库一致，
    DATETIME 的 insert → where round-trip 彻底闭合（#75）。
  - `NOW()` / `CURRENT_TIMESTAMP` / `CURDATE()` / `CURTIME()` 及 `now()` 辅助函数
    同步返回 UTC 墙上时间，与落库基准一致；`UTC_TIMESTAMP()` 行为不变。
  - 影响面：与旧版本相比，在非 UTC 主机上 DATETIME/TIMESTAMP 的存储值会变化；
    旧数据（按本地时区写入）如需迁移，请在原主机按原时区导出为绝对时刻后重灌。

### 修改位置

- `lib/date-types.js`：`toUtcDateString` / `toUtcDateTimeString`（原 `toLocal*`）、
  `parseToUtcMs`、`validateDate` / `validateDateTime` / `validateTimestamp`、
  `parseDateString`、`now()`、`formatDate()` 全部改用 UTC 基准。
- `lib/sql.js`：`parseSqlDate` / `parseUtcWallClock`、`sqlLocalDateTime`、
  `fmtSqlDate`、`strftime`、`strToDate`、`pgDatePart`、`addMonthsClamped`、`pgAge`、
  `NOW` / `CURDATE` / `CURTIME`、`EXTRACT`、`DATE_ADD|SUB`、`DATE|TIME|YEAR|MONTH|…`、
  `DATEDIFF`、`TIMESTAMPDIFF`、`DATE_TRUNC`、`LAST_DAY`、`WEEKDAY`、`DAYOFYEAR`、
  `DAYNAME`、`MONTHNAME`、`MAKEDATE`、`UNIX_TIMESTAMP`、`FROM_UNIXTIME`、
  `date ± INTERVAL` 算术路径、`escapeValue(Date)`。

### Fixed

- **测试断言时区无关化**：`test/issue-71-72.test.js` 的硬编码 `1577905445`
  改为 `Date.UTC(2020,0,2,3,4,5)/1000`（此前是 +08:00 下的值，UTC runner 必红）；
  `test/issue-73-76.test.js`、`test/issue-50.test.js`、`test/query-opt.test.js`、
  `test/readme-audit.test.js` 同步新语义，三套核心用例在
  `Asia/Shanghai` / `UTC` / `America/New_York` 下全绿。

## [6.5.34] — 2026-11-13

### Fixed

- **#73 `GROUP BY <位置索引>` 被当成常量，所有行塌成一组**：解析器把 `GROUP BY 1`
  里的数字变成 `{type:'value'}` 常量，分组键恒为一值，`SELECT a, COUNT(*) ... GROUP BY 1`
  错误地返回 `[[1,3]]` 而不是 `[[1,2],[2,1]]`。现在 `executeSelect` 分组前用新增的
  `_groupByPosition()` 把 1-based 位置还原成对应的 SELECT 输出表达式（裸列名 / 表达式 /
  别名），与同引擎里已经能正确工作的 `ORDER BY <位置>` 路径对齐；越界（`GROUP BY 99`）
  抛 `GROUP BY column index 99 is out of range` 而不是静默改结果集，指向聚合列时抛
  `refers to an aggregate function`（与 MySQL `Can't group on ...` 一致）。
- **#74 `ORDER BY <越界位置索引>` 被静默忽略**：`SELECT a FROM t ORDER BY 2`（select 列表
  只有 1 列）此前 `columns[pos-1]` 为 `undefined`，排序键恒 null，静默返回插入序。现在
  `executeSelect` 开头用 `_assertOrderByPositions()` 统一校验，覆盖普通排序、GROUP BY
  排序、UNION 尾部三条路径，越界抛 `ORDER BY column index 2 is out of range`；
  合法位置序号行为不变。
- **#75 ISO-8601 DATETIME 字面量插入后无法用同一字面量查回**：INSERT 路径的
  `validateDateTime` 会把 `2024-01-15T10:30:00Z` 规范化成本地 `2024-01-15 18:30:00`，
  但 WHERE 比较路径不做同样规范化，字面量带着 `T` / `Z` 原样比较 → 永远不匹配，
  `SELECT d FROM t WHERE d='2024-01-15T10:30:00Z'` 返回 0 行。现在 SELECT 执行前用新增的
  `_normalizeDateLiterals()` 把 WHERE 中「与 date/datetime 列比较、带 `T` 分隔符的字符串
  字面量」交给与 INSERT 完全相同的 `validateDateType` 规范化（覆盖 `=` / `BETWEEN` / `IN`
  三种形态，含 `Z` 与 `±HH:MM`，改写落在 WHERE AST 上，相关子查询也生效）；
  纯 `YYYY-MM-DD HH:MM:SS` 字面量与 TEXT 列比较不受影响。
- **#76 JOIN 中歧义列名被静默解析**：`_prefixRow` 在写入 `表.列` 前缀键之外还额外写入裸列键，
  JOIN 拼接时右表覆盖左表 → `SELECT id FROM u JOIN o ON o.u_id = u.id` 静默返回 `o.id`，
  结果依赖未记录的解析顺序。现在用新增的 `_assertNoAmbiguousRefs()` + `_columnOwners()`
  （有行数据时用 `表.列` 前缀键，空表回退 schema 并用出现序号区分自连接）在
  `_validateColumnRefs` 早退**之前**检测，未加表名前缀且存在于多张表的列抛
  `column reference 'id' is ambiguous`；已加前缀的引用、`SELECT *`、单表查询、别名自连接
  均不受影响，WHERE / GROUP BY / ORDER BY 中的裸歧义列同样报错，不会静默返回空集。

### Added

- `test/issue-73-76.test.js`：4 个 issue 的 23 条回归断言（每个 issue 覆盖正常行为、
  报错行为、以及不回归的相邻场景），已接入 `npm test`。

## [6.5.33] — 2026-11-11

### Fixed

- **#69 字符串算术没有按 MySQL 规律做数值前缀转换**：`'5a' + 1` 得到 `"5a1"`
  （`'5a' + 0` 甚至还是 `"5a0"`），而 MySQL 的算术上下文里字符串按数值前缀
  转数字、非数字按 0 —— `'5a' + 1 = 6`、`'5a' + 0 = 5`、`'12abc' + 0 = 12`。
  算术求值（`+ - * / % DIV`、位运算、单目 `-` / `~`）统一改用已有的
  `mysqlNum()`，三条重复实现（`arith` / `binary` / `evaluateExpr`）一起改，
  避免只修一条路径；`'5a' = 5` 这类数值比较本来就对，未受影响。
  顺带补齐 `!` 逻辑非：tokenizer 的字符集缺 `!`，`SELECT !1` 直接抛
  `Unexpected character '!'`，现在与 `NOT` 等价（`!=` / `!~` / `!~*` 不受影响）。
- **#70 CHECK 约束被解析后整段跳过，完全不生效**：列级与表级 `CHECK (...)`
  都只调 `_skipParens()`，非法数据（如 `INSERT ... (age = -5)`）静默入库。
  现在把条件解析成 AST（`_parseCheckCondition`），编译成判定函数挂到
  `def.check`（列级）/ `def.checks`（表级，可跨列），由 `Table` 在
  INSERT / INSERT 批量 / UPDATE 时统一按整行求值：
  - MySQL 三值语义：TRUE 或 UNKNOWN（NULL）通过，只有 FALSE 才抛 3819；
  - 表级条件在列清单解析完后绑定（允许引用后面才定义的列）；
  - `checkSql` 一并持久化，磁盘模式重开后由 `compileCheckExpr()` 重新编译，
    不会因 JSON 丢函数而失效；
  - `CHECK` 语法错误在 `CREATE TABLE` 时直接报错，不静默吞掉；
  - 补上 `Database.updateById` / `updateByIds` 绕过 `Table` 校验的缺口
    （SQL `UPDATE` 走的就是这条路，此前 UPDATE 完全不校验 CHECK）。

### 测试

- 新增 `test/issue-69-70.test.js`（52 项）：字符串算术、`!` 逻辑非、
  列级/表级/具名/多约束/函数/IN 条件的 INSERT、UPDATE、批量插入、
  语法错误、以及磁盘模式重开后的约束持久化。已进 `npm test`。
- 全量测试通过；`native.test.js` 在无 native 模块的 stub 环境下
  「tables restored」失败为改动前既有问题（已用 HEAD 工作树复现），与本次无关。

## [6.5.31] — 2026-11-10

### Fixed（issue #63~#68，均先在 6.5.30 上复现再动手）

- **#63 `POSITION(substr IN str)` 解析错误**：`IN` 是关键字，通用函数参数
  循环会把它当 IN 表达式并抛 `Expected ( but got ...`。在 `parseOperand`
  里单独归一成 `LOCATE(substr, str)` —— 命中 2、未命中 0，与 LOCATE 等价。
- **#64 日期类型接受 NaN / Infinity**：`validateDate` / `validateDateTime`
  的 number 分支缺有效性校验，Invalid Date 被格式化成 `"NaN-NaN-NaN"` 静默
  落库。加 `Number.isFinite` + `Date.getTime` 校验，与 string 分支一致抛
  `Incorrect date value`；合法时间戳不受影响。
- **#65 数值域错误返回 NaN 而非 NULL**：`SQRT` / `POWER` 直接返回
  `Math.sqrt` / `Math.pow` 的 NaN，而 `LOG(-5)` / `ACOS(2)` 已正确返回 NULL
  —— 同模块内不一致。新增 `finiteOrNull()` 统一拦截非有限数；连
  `SQRT(-1) + 5` 的 NaN 污染也一并消失。
  **同时修正 `test/extra-coverage.test.js` 里「SQRT 负数返回 NaN」这条过时
  断言** —— 它把 bug 钉成了预期，现改为断言 NULL（MySQL 语义）。
- **#66 Redis MGET 缺失键**：`_send` 数组分支把 `null` 序列化成
  `$4\r\nnull\r\n`；改为对 `null` / `undefined` 发 RESP nil bulk `$-1\r\n`。
- **#67 Redis ZSCORE / ZINCRBY 分数类型**：分数走 integer reply，`10.5` 变成
  非法的 `:10.5`。两个 handler 改为返回 `String(score)`（整数分数也用 bulk，
  与真实 Redis 一致），`_send` 的 number 分支再加一道非整数兜底。
- **#68 XQL ORDER BY 排序列不在投影里被静默忽略**：compiler 先投影再排序，
  排序键函数读 `row.age` 时该属性已被删掉，比较器恒返回 0。把 ORDER BY
  代码生成块移到投影之前。

### 测试

- 新增 `test/issue-63-68.test.js`（30 项），Redis 部分用 mock socket 直接调
  `RedisServer._handle()` 验 RESP 字节，不占端口。已进 `npm test` / `test:all`。
- `npm test` 与 `test:all` 均 exit=0，0 FAIL，0 FATAL。
- 六个 issue 已随上一发提交（含 `Closes #63..#68`）关闭，OPEN issues = 0。

## [6.5.30] — 2026-11-10

### Fixed

- **#58 `ast.rewrite()` 无法替换根节点**：根节点 `parent === null` 时替换被
  `parent && key` 守卫跳过，与 `transform()` 行为不对称。现在根节点替换会
  通过返回值交回调用方，数组根元素也能按索引回写。（此前版本已落地，本版补测）
- **#59 WHERE 拒绝裸布尔谓词（#21/#42 回归）**：`WHERE 1` / `WHERE col` /
  `WHERE flag` 没有比较运算符时不再抛 `Expected comparison operator`，
  而是按 MySQL truthiness 求值（数字 <> 0、字符串非空、NULL 未知）；
  HAVING / ON 同样适用。（此前版本已落地，本版补测）
- **#60 集合运算列数不校验 + 括号化操作数被拒**：
  `UNION` / `UNION ALL` / `INTERSECT` / `EXCEPT` 两侧列数不同时现在显式抛
  `The used SELECT statements have a different number of columns`（错误码 1222），
  不再按左分支静默截断丢列。操作数支持括号化 `(SELECT ...) UNION (SELECT ...)`；
  括号内的 `ORDER BY` / `LIMIT` / `OFFSET` 仅作用于该操作数，括号外尾部子句
  作用于整个组合查询。

### Added

- `test/issue-59.test.js`、`test/issue-60.test.js` 回归测试（#58 测试已存在）。

## [6.5.28] — 2026-11-08

> 6.5.27 的 tag 已推但 npm 发布未落地（registry 停在 6.5.26），本版把
> 6.5.27 之后的全部改动一并带上去。同时补齐此前漏关的 issue。

### Fixed

- **6.5.27 漏 bump 两处版本串**：README 横幅与 index.js 头注释停在 6.5.26。
- **postinstall Windows EPERM 静默失效**：`installDownloadedModule` 的 fallback
  把 `unlinkSync(旧 .node)` 失败吞掉，第二次 rename 必然再失败 —— 下载成功、
  SHA256 校验通过却留着旧二进制。改为「rename 挪走 → 装新的 → 失败还原」，
  两条路都不通就抛真实原因。
- **降级警告轻描淡写**：改为三行明确 WARNING + 指路 `--status`。
- **`test/coverage.js` 的 TRUNCATE FATAL**：`findDestructiveSQL` 有意把 TRUNCATE
  判为破坏性，测试没声明 `{ safety: false }`；补声明，断言与全局策略都不变。

### Added

- `jsql native status` / `refresh` / `verify`（`--json` 结构化输出）。
  `verify` 重算 .node 的 SHA256 与安装记录比对，能发现 status 看不到的
  文件替换/损坏（OK / MISMATCH / CORRUPT / MISSING / UNVERIFIED / UNREADABLE）。
- `JSQL_NATIVE_PATH` 环境变量与 `native/.installed.json` 安装元数据。
- README `## Query results`：写清 columns / rows / raw 是同一份结果的三种表示；
  `index.d.ts` 把 `raw?: unknown[]` 精确为 `Array<Record<string, unknown>>`。

### Performance

- **结果 BigInt 收尾从通用深递归改成紧凑循环**。此前每个 SQL 结果的 rows
  （10 万个数组）+ raw（10 万个对象）逐个进 `seen` Set，20 万次 `Set.add`，
  `--prof` 显示 GC 占 32.9%、`SetPrototypeAdd` + `finalizeBigInts` 合计 ~23% JS ticks。
  同机 A/B（10 万行，各 5 次均值）：
  `SELECT id` 67.4→42.2ms (1.60x)、`SELECT *` 91.0→65.4ms (1.39x)、
  heapUsed 148.7→126.2MB。**小结果集基本持平**，那里 finalize 不是瓶颈。

### 测试

- 新增 `test/result-raw.test.js`(23) / `test/native-install.test.js`(7) /
  `test/native-cli.test.js`(12) / `test/finalize-bigint.test.js`(9)，均进
  `npm test` 与 `test:all`。
- `npm test` 与 `test:all` 均 exit=0，0 FAIL，0 FATAL。

### Issue 收尾

- #45 / #46 / #47 / #48：PR #49 已合并、对应回归测试全绿（3/9/3/4），
  但合并时只带关了 #44，这四个漏关。本版随 commit 一并关闭。
- #42：核实为**不复现** —— 裸布尔谓词已由 `c5c8a93` 随 6.5.22 修复，
  当前 main 上五条用例全部通过，issue 系旧版本误报。

## [6.5.27] — 2026-11-08

> 补记：这一版发布时未单独写入 CHANGELOG。

- PR #49：修复 #44（索引等值查找忽略类型强制转换）、#45（MongoDB $avg
  把 NULL 当 0 算进分母）、#46（index.d.ts 声明了未导出的函数）、
  #47（MongoDB $sort 的 NULL 恒排末尾）、#48（mysql_compat 把 FLOAT/DOUBLE
  报成 LONGLONG）。
- 新增 `test/issue-44~48.test.js`（11/3/9/3/4 项）。

## [6.5.26] — 2026-11-07

### Fixed

- **`result.raw` 对计算/聚合列全部返回错值（issue #43）**：
  纯聚合时为 `undefined`，无 FROM 表达式 / 标量子查询时为
  `[{"_virtual":true}]`，GROUP BY 时是**投影前的源行**且泄露内部 `_group`，
  CASE / 算术等计算列则整列缺失。`result.rows` 一直是对的。

  **原设计的证据**在 `lib/prepared.js` 的 `get()`：raw 缺失时它会用
  `columns + rows[0]` 现场拼出等价对象 —— 也就是 `columns` / `rows` / `raw`
  本该是同一份结果的三种表示，raw 是两者的 zip。此前各执行分支塞「投影前
  源行」是实现走样（从 `de08300` 就在）。

  修在 `buildResultEnvelope`（executeSQL 统一出口）一处重建，**不动 8 个
  返回点**；同时天然保证 `raw.length === rows.length`（mysql_server 的
  `foundRows` 依赖它）。`SELECT *` 仍是完整行，`prepare().get()` 与 `raw[0]`
  一致。

### 测试

- 此前 README/doc 没有任何 raw 说明、测试里没有任何 `.raw` 断言 ——
  零覆盖才是它坏这么久没被发现的根因。新增 `test/result-raw.test.js`（23 项），
  每例同时验内容 / 与 rows 等长 / 键集合恰好等于 columns，并断言不泄露
  `_group`。已加进 `npm test` 与 `test:all` 第 2 位。
- `npm test` exit=0（0 FAIL）。`test:all` 仍 exit=1，但 0 FAIL —— 唯一是
  `test/coverage.js` 的 `TRUNCATE users` 被安全策略拦（对照实验：临时把
  `lib/sql.js` 还原到 HEAD 后同样 FATAL，与本版改动无关）。

### 已知问题（本版未修）

- `postinstall` 在 Windows 上 EPERM fallback 吞掉 `unlinkSync` 失败，
  有旧 `.node` 时「force-fetch latest native」会静默失效（下载+校验成功但装不上）。
- `test/coverage.js` 的 `TRUNCATE` 与当前安全策略脱节。

## [6.5.25] — 2026-11-07

> 补记：这一版发布时未单独写入 CHANGELOG（最新章节停在 6.5.24）。

- `postinstall` 改为强制从远端 release 刷新 native（默认 tag = `v${pkg.version}`，
  带 SHA256SUMS 校验），另加 CLI `update` / `uninstall`。
- 版本 bump 到 6.5.25 后曾出现顺序死锁：release 由 tag 触发生成，而
  postinstall 按 `v6.5.25` 去找那个还不存在的 release → 拒绝下载 → 留着旧
  `.node` → issue-38 的 BigInt 用例失败。推 `v6.5.25` tag 后 CI 生成了 release
  （7 个 assets 含 SHA256SUMS）、npm 发布 6.5.25，死锁解开。

## [6.5.24] — 2026-11-06

### Fixed

- **Rust/WASM/Native 绑定层 int64 精度丢失（issue #38 遗留）**：WASM 与 Native 引擎此前把 `int64` 当 `f64` 编解码，`lib/wasm_client.js` 路径插入 BigInt 会抛 JSON 序列化错误，`> 2^53` 的十进制字符串也会截断。现已与 JS 引擎（6.5.23）行为一致：
  - **核心类型**：新增 `FieldType::BigInt` 与 `FieldValue::UInt(u64)`；integer/bigint 列按列类型精确解析，拒绝小数、布尔与越界值（`1292`）。
  - **BigInt 传输**：识别 `lib/bigint_json.js` 的 `{"__jsql_bigint__":"..."}` 标记；插入、更新、过滤、主键查询均精确保留。
  - **精确回读**：`> 2^53` 的整数与行 id 以十进制字符串输出，避免 `JSON.parse` 丢精度；JS 绑定层按 schema 还原为 BigInt。
  - **持久化**：`.jsql` / JSON / dir 模式导出与重新导入保持 int64 精确往返。
  - **绑定客户端**：`lib/wasm_client.js`、`lib/native_client.js` 与浏览器入口统一使用 BigInt 安全序列化；Native 二进制路径支持 BigInt 编码。
  - 重新生成 `wasm/jsql_neo_wasm_bg.wasm`；`test/issue-38.test.js` 扩展至 43 项，新增 wasm/native 绑定层往返、过滤、更新与错误码用例。

## [6.5.23] — 2026-11-06

### Fixed

- **超过 2^53 的 64 位整数精度丢失（issue #38）**：`integer` / `int` / `bigint` 列此前用 `Number(v)` 归一，`> 2^53-1` 的值（number 或十进制字符串）会被静默截断成 53 位浮点；SQL 路径又因字面量解析成 BigInt 而报 1292，两条路径行为不一致且都丢精度。现已支持 BigInt：
  - **列归一**：BigInt 输入精确接受（int64 范围内）；十进制字符串精确解析，安全范围内仍存成 `number`（兼容旧行为）；超出安全范围的 `number` 与超出 int64 范围的值明确报 `1292 ER_TRUNCATED_WRONG_VALUE`，不再静默入库。
  - **SQL 路径**：`INSERT` / `UPDATE` / `WHERE` 中的大整数字面量（含十六进制字面量）精确保存与比较；BigInt 参数绑定可用；`SELECT` 回读保留原始位数。
  - **持久化**：新增 `lib/bigint_json.js`，用单键标记对象（`__jsql_bigint__`）实现 BigInt 安全的 JSON 往返，修复 WAL / 事务快照 / `.jsql` 文件 / 备份恢复 / `stats()` 等路径因 `JSON.stringify` 遇 BigInt 直接抛错而整条失败的问题。
  - **二进制格式**：`jsql_format` 新增 `I64` 的 BigInt 编码，读回时安全范围内还原成 `number`，超范围返回 BigInt。
  - **算术**：BigInt 与整数 `number` 混合的 `+ - *` 走 BigInt 精确计算（`bigintExactArith`），避免 `TypeError` 与精度丢失。
  - 新增 `test/issue-38.test.js`（33 项）覆盖 API / SQL / 持久化 / 事务 / 错误码一致性。

### Notes

- 合并 `fix/i38` 时保留 6.5.22 全部修复：`mysqlNum()`（MySQL 字符串→数字强转）与 `bigintExactArith()` 并存；`test` / `test:all` 取测试集并集（含 #38、#39、#40、g4）。

## [6.5.22] — 2026-11-06

### Fixed

- **BETWEEN 数值边界退化成字典序比较（issue #39）**：`BETWEEN '9' AND '100'` 此前按字符串比较，`'9' > '100'` 导致结果为空。现在当列/边界可用数值解析时按数值比较（支持负号、小数、科学计数法），纯文本列仍保持字典序。
- **表级 FOREIGN KEY 约束未实现（issue #40）**：`CONSTRAINT ... FOREIGN KEY (col) REFERENCES t(col) [ON DELETE CASCADE|SET NULL|RESTRICT]` 此前被静默忽略 / 直接报解析错误。现已解析、建表时注册并在 INSERT/UPDATE/DELETE 时强制执行；列内联 `REFERENCES` 同样生效；引用的表/列不存在、复合外键等不支持场景改为显式报错而非静默丢弃。
- **裸布尔谓词（issue #21）**：`WHERE flag` / `HAVING flag` / `ON flag` 支持不带比较运算的布尔列与 `TRUE`/`FALSE` 常量。
- **XQL 逻辑与聚合（issue #23、#27、#28、#29、#30）**：`= / != / BETWEEN` 实现 NULL 三值逻辑；修正非字面量列表的 `NOT IN`；emitter 临时参数名加命名空间避免重名；SELECT 投影支持聚合函数；非法数字字面量显式报错（不再静默变 NaN）。
- **CLI 引导（issue #24）**：缺少 `@vexify-org/yaggs` 时优雅启动而非崩溃。
- **供应链加固（issue #25）**：原生库下载改为显式 opt-in（`JSQL_NATIVE_DOWNLOAD=1`），移除内置 ghproxy 与硬编码 token，仓库不再提交 `.node` 产物。
- **MySQL 类型强转（issue #26）**：数字与字符串比较走 MySQL 宽松数值转换（`'5' = 5`、`'a' = 0`、`'' = 0`、`'09' = 9`），不再退化成字典序。
- **服务端协议（issue #31、#32、#33）**：MySQL 协议 `_route()` 字符串掩码判断反转，正确保留字面量与注释中的 `db.table` 引用；binary result set 中 `MYSQL_TYPE_LONG` 固定 4 字节以避免行布局错位；PostgreSQL `CommandComplete` 恢复 `INSERT 0 <n>` 的 OID 段。
- **TUI 多字节输入（issue #34）**：输入光标按 UTF-8 字节推进并处理代理对，中文/emoji 不再乱码或吞字符。
- **limit/offset/id 负值（issue #35）**：Native/WASM/JS 绑定层拒绝负数，避免转 `usize/u64` 时的回绕。
- **主键与自增范围冲突（issue #36）**：显式指定主键不再被自增范围覆盖（WASM `insert_buf_parse` 跟踪实际分配 id）。
- **查询缓存被调用方污染（issue #37）**：缓存命中返回副本，调用方修改结果不再破坏后续查询。

### Notes

- issue #38（BigInt 序列化）本次未包含，已在 [6.5.23] 中修复。

## [6.5.21] — 2026-11-05

### Fixed

- **Native 引擎 `add_column` 多行表数据损坏（issue #22）**：`Table::add_column` 用 `Vec::insert` 原地插入导致后续行 `values_start` 未同步，>1 行表添加列后首行之后所有行被静默损坏。现重建 `values` 并重算每个 `values_start`，数据不再损坏。
- **Native 引擎 disk 模式 `ALTER TABLE ... ADD COLUMN` 崩溃**：`HybridEngine::add_column` 在 `meta.borrow_mut()` 存活时调用 `save_meta()`（内部再次 `borrow`），RefCell 双重借用 panic。现将 `save_meta` / `mark_dirty` 移出借用作用域。
- 新增 `test/native-add-column.test.js`（12 项：纯 JS / Native memory / Native disk 三引擎数据完整性）。

## [6.5.13] — 2026-10-29

### Fixed

- **注册表插件无法自动加载**：`jsql plugin install <name>` 装出的插件（manifest `entry` 是仓库相对路径如 `plugins/xql/index.js`，tgz 解出来文件在根级）此前在 `new Database()` 时匹配不到入口、静默不加载。`_loadInstalledPlugins` 现在追加 `path.basename(entryFile)` 候选，兼容仓库相对 / 根级相对 / `plugins/` 子目录三种布局。
- **`jsql plugin` 命令在 npm 安装下崩溃**：npm 包的 `files` 漏掉 `src/`，`bin/jsql` 的 `require('../src/cli/plugin')` 找不到模块。已把 `src/` 加回发布文件清单。

## [6.5.12] — 2026-10-29

### Added

- **XQL 集成**：内置 `xql` 插件（`db.use('xql')`），用 XQL（eXtend Query Language）查询 JSQL 表——支持等值 hash 索引与范围 range 索引、管道式语法（`FROM t |> WHERE … |> LIMIT n`）。API：`db.xql()` / `xqlLoad()` / `xqlRefresh()` / `xqlIndex()` / `xqlTables()` / `xqlCollection()` / `xqlClear()`，写入自动失效、下次查询重建。XQL v0.3.0 源码内置（`lib/xql/`），零额外依赖。注册表已发布 `xql` 插件（`jsql plugin install xql`）。

## [6.5.11] — 2026-10-28

### Fixed

- **布尔三值逻辑**：`SELECT TRUE AND TRUE` / `NULL AND TRUE` / `NULL OR FALSE` 此前全部返回 0——`resolveOperand` 缺 `and`/`or`/`xor`/`not` 分支，落到 default 返回 `undefined` 再数值化成 0。新增 `sqlTruthy`/`sqlAnd`/`sqlOr`/`sqlXor` 三值真值表，`TRUE AND TRUE`=1、`NULL AND TRUE`=NULL、`NULL OR FALSE`=NULL。
- **CREATE TABLE 重复列名**：`CREATE TABLE d(a INT, a INT)` 此前不报错（对象键覆盖静默丢列），现抛 `Duplicate column name`。
- **JSON/JSONB 非法值**：`{bad json` 这类非法 JSON 字符串此前能塞进 JSONB 列，现两引擎（Database `_validateDataTypes` + WASM insert）都做 `JSON.parse` 校验，非法抛 `Truncated incorrect object value`。
- **ORDER BY 不存在列**：`ORDER BY nonexistent_col` 此前静默忽略（ORDER BY 列解析成裸字符串，列引用校验 walk 检不到），现抛 `no such column`；输出别名/位置序号仍豁免。
- **超大整数序列化**：`SELECT 1000000000000000000000` 此前抛 `Do not know how to serialize a BigInt`，现输出前递归把 BigInt 转字符串（保留精度、可序列化，防循环引用/Buffer 递归爆栈）。

## [6.5.10] — 2026-10-28

### Fixed

- **ORDER BY 别名/位置序号被忽略**：非分组路径下 `ORDER BY` 引用输出别名（`ORDER BY val`）或位置序号（`ORDER BY 1`）此前不排序，现解析回投影列的底层表达式正确排序。
- **字符串比较与 LIKE 不一致**：默认 `=`/`<>`/`<`/`IN` 现按大小写不敏感（utf8mb4_general_ci）处理，与 `LIKE` 一致；字符串列不再参与等值下推（数值列仍走索引）。
- **BINARY 限定符**：新增 `BINARY expr` 前缀解析，强制大小写敏感比较；字面量与 IN 列表元素正确求值。
- **UPDATE ... ORDER BY ... LIMIT**：与 DELETE 对称，先按 WHERE 过滤、再按 ORDER BY 排序、最后 LIMIT 截取再逐行更新。
- **date ± INTERVAL n UNIT**：`'2026-01-01' + INTERVAL 3 DAY` 等区间算术语法现可解析并正确计算（复用 DATE_ADD 逻辑，月末钳制、小时/分钟/秒均支持）。

## [6.5.9] — 2026-10-27

### Fixed

- **大表聚合崩溃**：`MIN`/`MAX` 用 `Math.min(...)`/`Math.max(...)` 展开超大数组，超过 V8 参数上限导致 `RangeError`；改为循环求值。
- **深 JSON 栈溢出**：`JSON_DEPTH` 对深层嵌套 JSON 递归调用栈溢出；改为显式栈迭代。
- **同类 spread 隐患**：Mongo `$min`/`$max`、JSON 深度计算，以及 B-tree/分组/导出等 10 处大数组 `push(...)` 展开全部改为 `for...of`，消除参数上限依赖。
- 修复大表 `GROUP_CONCAT`/ROLLUP 等大分组路径上的同类风险。

## [6.5.8] — 2026-10-26

### Fixed

- **协议层加固**：Redis/PG 解析增加长度上限，Mongo wire frame/缓冲区限长；监听端口被占用时通过 `onError`/回调报告，不再崩进程。
- **原生模块下载**：校验 SHA256SUMS、限制重定向深度、跨域重定向不转发代理鉴权；检测 musl/N-API，新增 linux x64/arm64 musl 预编译产物。
- **插件安装**：校验插件名与 tar 清单，拒绝路径穿越/链接，改用 `execFileSync` 避免 shell 注入。
- **JS 沙箱**：`mod.js` 与 SQLite UDF 默认在受限 vm 中执行，需显式设置 `JSQL_ALLOW_UNSAFE_*` 才开放宿主能力。
- **迁移导出**：`exportToFile` 分页流式写入，避免整表读入内存。
- 修复 MySQL binary resultset NULL bitmap 偏移、PG `$n` 参数绑定、MultiServer 跨协议共享引擎等正确性问题。

## [6.5.7] — 2026-10-24

### Fixed

- 移除 star-nag OAuth URL 的 `.php` 后缀（`/start.php` → `/start`，`/result.php` → `/result`）。

## [6.5.6] — 2026-10-24

### Fixed

- **Native（Rust N-API）主键点查 / 按主键更新从 O(n) 全表扫描降为 O(1)。**
  此前 `find({id})`、`findById()`、`SELECT ... WHERE id = ?`、`prepare()` 全部
  走 `jsqlFind` 逐行过滤；`updateById` / `removeById` 还要先全表扫一遍找内部
  行号。20 万行实测：PK 点查 ×500 512.6ms、updateById ×200 201.4ms。
  现在：
  1. Rust `Table` 记录主键是否自增，`find_rows` / `find_rows_json` 遇到
     「自增主键 = 整数」的单条件直接查 `pk_index`（哈希），一次定位；
     `update_by_filter` / `remove_by_filter` 同样走该快路径；
  2. `lib/native_client.js` 的 `_findRawById` / `_seqIdByPk` 在自增整型主键下
     直接调用 O(1) 的 `jsqlFindById`，不再构造 filter 调 `jsqlFind`；
     `findByIds` 改为一次 `jsqlFindByIds` 批量取回；
     非自增/字符串主键仍保持原 filter 语义。
  20 万行实测：PK 点查 ×500 **512.6ms → 6ms**、updateById ×200 **201.4ms → 7ms**。
- **Native 批量插入改走二进制跨 N-API 路径（Bug3）。** 此前整批
  `JSON.stringify` → Rust `serde_json` 解析 → `HashMap` → `FieldValue`，
  20 万行约 700ms。现在同构批次（行列集合一致、无 undefined/NaN）直接
  `encodeBatch` 成二进制，Rust 按 tag 解析成 `FieldValue`，实测约 2×：
  20 万行 **700ms → 365ms**、50 万行 **812ms**（与 better-sqlite3 的
  833ms@500k 基本持平）。异构批次/包含 undefined 的批次仍回退 JSON 路径，
  保持「缺列 = 用默认值」的语义。
- **`_assertNoKeyConflictSync` 不再把整张表拉进 JS。** 只取回被更新的一行做现值
  比较；确实改了主键/UNIQUE 列时才用 `limit 2` 的原生查询探测冲突，输出量恒定。
- **进程直接退出不再丢 `updateById` / `removeById` 写入。** 注册进程级 `exit`
  钩子，在退出前同步 flush opBuffer；disk/hybrid 模式顺带补一次脏表落盘。
- **README 删除「~2× faster than better-sqlite3 on indexed point lookups」的
  不实宣传**，改为如实描述：主键点查/更新走 O(1) 哈希索引，无索引过滤在 Rust
  侧逐行执行。

## [6.5.5] — 2026-10-24

### Fixed

- **WASM `updateById` 不再整表导出，非键列更新降回 O(1)。**
  `lib/wasm_client.js` 的 `_assertNoKeyConflict` 此前无条件
  `this.find(table, {}, { limit: 1e9 })` 把整张表导出成 JSON 再逐字段查键冲突。
  这与 6.4.8 在 `native_client.js` 修掉的「无条件整表 JSON 导出」同源，但那次
  修复没覆盖 wasm 客户端。后果：`UPDATE t SET age = 30 WHERE id = 1` 这类不碰
  主键/UNIQUE 列的日常更新，也要先付一遍整表导出的钱 —— 10 万行 ~590ms/次、
  1 万行 ~13.6ms/次，且随行数近线性放大，比读整张表还贵。
  现在（性能从 O(表行数) 回到 O(1)）：
  1. 只筛 pk + unique 列里**确实出现在 updateData 中**的；一个都没碰就直接
     return，整张表一个字都不读；
  2. 先用主键取回自己那一行（走 pk 的 find，limit 1），所有待改键值都与现值
     相同 → 幂等更新，直接 return，不再触发全表扫描（也不误报 ER_DUP_ENTRY）；
  3. 真的动了键才退化成整表扫描逐字段比对，正确性优先。
  10 万行表实测：**590ms → 0.8ms/次**（约 740×）；1 万行 13.6ms → 0.10ms。
- 顺带修正 `bench/bench_wasm_update.js` 里两处对语义的误判（此前恒 FAIL，与本次
  修复无关）：UNIQUE 撞车用例拿列值 `'A'` 当自增主键去 update（命中不到行，自然
  不报错）；删除后同 id 更新的用例断言行会复活（实际应为 no-op 返回 null）。

## [6.5.4] — 2026-10-21

### Changed

- **CLI 提示改短，并改为中英双语。** `jsql star` 与启动提示（nag）现在一行英文
  + 一行中文：正在打开浏览器 / 等待授权 / 已确认 / 还没 star / 授权被拒绝或失败
  / 链接已过期 / 已超时，都缩短并在同一行给出两种语言。
- OAuth 回调页文案改为英文（auth/callback.php、auth/start，部署于
  auth.vexify.top）："Thanks for the star!"、"Not starred yet"、
  "Authorization canceled"、"Missing parameters"、"Token exchange failed"、
  "Cannot read account" 等。根目录 start.php / result.php 本就返回英文。

## [6.5.3] — 2026-10-21

### Fixed

- **`jsql star` 报「授权完成，但 undefined 没有 star undefined」。** 线上
  `result.php` 把「state 文件存在」一律当成授权完成，而 `start.php` 一发起
  就写入 `{"state":"started"}`——于是 CLI 第二轮轮询（+2s）拿到中间态当
  done，打印一段 login/repo 全为 `undefined` 的假失败信息。已本地 PHP 复现，
  逐字对上用户报告的输出。现在按 state 文件**自己**的 state 判定：
  `done/denied/error` 才终态，`started` 继续等，仅超龄才清理。
- CLI 侧同步收紧：`waitForResult` / 后台轮询只接受带布尔 `starred` 的
  done，中间态继续等而不是误判；`denied` / `error` 会打印真实原因并提示
  链接一次性，不再让用户白跑去 star。
- `callback.php` 增加幂等：同一条授权链接被重复请求（浏览器刷新/后退）时
  直接复用已存结果，不再用「code 已用过」的失败覆盖成功的 done。

## [6.5.1] — 2026-10-21

### Added

- **一个端口四协议，命令行可用。** `jsql serve` 默认启动 `lib/multiserver.js`
  的嗅探网关，MySQL / PostgreSQL / MongoDB / Redis 客户端共用同一端口、
  读写同一个 `Database`（Redis 仍是独立 key 命名空间）。新增
  `--mysql-only` 退回只服务 MySQL；`idleProtocol` / `sniffTimeout`
  控制静默连接的兜底协议与嗅探等待。
- MongoDB OP_MSG 支持 kind 1 文档序列（`insertMany` 走这条路，此前被
  整段丢掉）。
- 新增 `test/multiprotocol.test.js`（原始 socket 嗅探 + 四协议握手 +
  CLI 启动，14 项断言，不依赖外部驱动）。

### Fixed

- **MongoDB 协议栈此前完全收不到消息：** `_handleSocket` 里把消息循环
  `processLoop` 定义成函数却去调用全局 `process()`，standalone 与多协议
  两条路径都不通。
- **信号量：引擎读写是异步的，而 mongo 调度代码按同步写。** `find` /
  `insert` / `updateByIds` / `removeByIds` 全部没 `await`，`Promise.filter`
  直接抛 `TypeError`，表现为「握手通、查询必失败」。现在逐步 await。
- MongoDB 独立模式改为按 `$db` 取引擎，与多协议网关一致——否则 Mongo
  永远落在 `default` 引擎上，看不见 MySQL/PG 建的表。
- 无主键集合的 `_patchRows` / `_removeRows` 改走 `_rowKey`：用主键值，
  没有主键时传行对象让 `_resolveId` 做深度匹配。
- 顺手修好先前被标为「已知损坏、未纳入 CI」的 `test/mongo-group.test.js`
  （`createTable` 未 await 且 schema 传参格式错），现已加入 `test:all`。

## [6.5.0-beta.6] — 2026-10-20

### Fixed

- **`jsql star` 接不到授权结果。** 轮询定时器是 `unref()` 的，CLI 打印完提示就退出，授权完成后 `~/.jsqlmr` 从不更新。`star` 命令改为前台等待（最长 3 分钟），拿到 done 后立即写入配置。
- **`lib/star-nag.js` 的 `const URL` 遮蔽全局 `URL` 类**，解析 nonce 时 `new URL(...)` 抛 TypeError 被吞掉。改为 `require('url').URL`。
- **`jsql --version` 被 star 提示语污染。** 排除列表只写了 `version` 子命令，漏了 `--version` / `-v`。
- **服务端 star 检查误判。** GitHub 单仓库 endpoint 有同步延迟（列表已有、单查 404）。`auth/callback.php` 改为拉 star 列表做包含性检查（最多 5 页 × 100）。

## [6.5.0-beta.5] — 2026-10-20

### 提示语规则调整（用户明确要求：不强制）

1. **去掉自动弹浏览器。** 此前提示语出现时会顺带 `startOauthCheck()`，
   任何 jsql 命令都可能弹浏览器 —— 这是「强制」。现在只印文字，
   要确认请用户自己跑 `jsql star`。
2. **去掉 30 天节流。** 除 `version`（只回版本号）和 `star`（本身就是干这个的）
   之外，**每个命令都印**，不再「只提醒一次」。
3. **`~/.jsqlmr` 只记录是否 star。** `starred: true` 是唯一闭嘴开关；
   `lastNagAt` 随节流一起废除，不再写入。`JSQL_NO_STAR_NAG=1` 可临时静音。

## [6.5.0-beta.4] — 2026-10-20


## [6.5.0-beta.4] — 2026-10-20

### 服务端修复（不在本仓库，部署于 auth.vexify.top）

- **redirect_uri 三处不一致**导致授权必然失败
  （`The code passed is incorrect or expired.`）：start 发 `/callback`、
  callback 换 token 发 `/callback.php`、GitHub 注册的是 `/callback.php`。
  现已全部对齐到 `/callback.php`。
- 补齐多文件端点的服务端文件：`start.php` / `result.php` / `config.php` /
  根目录 `callback.php`（此前根目录 404，客户端 `AUTH_START`/`AUTH_RESULT` 全部打空）。

本包本身无代码变更，发 beta 是为了配合服务端修复做端到端验证：
`jsql star` → 授权 → `~/.jsqlmr` 写入 starred。

## [6.5.0-beta.3] — 2026-10-19


### Fixed

- **star 提示的 OAuth 地址同步到 auth.vexify.top 新多文件结构。** 服务端已从单文件
  `callback.php` 拆分为 `start.php` / `callback.php` / `result.php`；CLI 相应改用
  `/start?nonce=xxx` 发起授权、`/result?nonce=xxx` 轮询结果。

## [6.5.1-beta.1] — 2026-10-19

### 预发布说明

本次只改版本号，没有功能变更 —— 发出来是为了让你测 **star 提示的端到端链路**：

- CLI 启动提示 → 浏览器授权 → auth.vexify.top 回调 → 写回 `~/.jsqlmr`。
- 服务端已部署（`auth.vexify.top/callback`），redirect_uri 与 GitHub 后台注册的一致。
- **OAuth 授权那一步尚未人工验证过**，所以先发 beta。

若提示语碍事：`JSQL_NO_STAR_NAG=1` 关闭。

## [6.5.0] — 2026-10-19


## [6.5.0] — 2026-10-19

### Added

- **CLI 启动时的 star 提示。**

  ```
    If JSQL-NEO saved you time, a star helps others find it: https://github.com/vexify-org/JSQL-neo
    (set JSQL_NO_STAR_NAG=1 to hide, or star it and it'll stop asking)
  ```

  **三条约束，避免它变成噪音：**

  1. **star 过就彻底闭嘴。** 若环境里有 GitHub token（`GITHUB_TOKEN` /
     `GH_TOKEN`），CLI 启动时会问 GitHub「这个身份 star 过没有」；
     是的话在配置里记下，以后永不再提。
  2. **30 天节流。** 同一台机器最多 30 天提一次。
  3. **绝不挡命令。** 提示相关的任何异常都被吞掉 —— 配置读不了、写不了、
     没装 curl、网络不通，都不该让 `jsql serve` 起不来。

  配置文件：**`~/.jsqlmr`**（JSON），可用 `JSQL_MR_PATH` 覆盖。内容形如：

  ```json
  { "lastNagAt": 1792387275884, "starred": true, "starredAt": 1792387275884 }
  ```

- **新增 `jsql star` 子命令**：打印配置文件路径、当前 star 状态与仓库地址，
  方便排查「为什么它还在提示」。

### Fixed（README 与实情不符）

审计 README 时发现三处与实现不符，已改：

- **「One port, four protocols」不成立。** README 给出
  `psql` / `mongosh` / `redis-cli` 都连 3306，实际 `jsql serve` 的
  help 自己写着「Run the **MySQL-compatible** server」，只启 MySQL。
  PG / Redis 以库形式提供需自行装配；MongoDB 与官方现代 driver 握手尚未打通。
- **`import init, { Database } from 'jsql-neo/wasm'` 导入不了。**
  package.json 的 exports map 里没有 `./wasm`，只有 `./wasm/browser.mjs`；
  且该入口导出的是 `JSQL`，不是 `Database`。
- **NativeJSQL 的入口与导出名写错了。** 顶层导出的是
  `JSQL` / `NativeJSQL` / `Database` 等，README 只写
  `import { Database } from 'jsql-neo'`，但 `Database` 是纯 JS 实现，
  原生入口是 `NativeJSQL`。

## [6.4.9] — 2026-10-19


## [6.4.9] — 2026-10-19

### Fixed

- **纯 JS 与 native 对 schema 字段名的认法不一致（静默正确性 bug）。**

  `native_client` 在把 schema 交给 Rust 之前会归一化字段名
  （`primary_key` → `primaryKey`，见 `lib/native_client.js`），
  而**纯 JS 的 `lib/table.js` 只认驼峰**。

  后果：README 与官方示例用的正是下划线写法
  （`{ id: { type:'integer', primary_key:true, auto_increment:true } }`），
  在 native 下正常，在纯 JS 下：

  - 自增 id **根本不生成**（`row.id === undefined`）
  - `find({ id: 1 })` 永远返回空
  - `findById(1)` 返回的是一条**没有 id 的行**

  **全程不报任何错** —— 这是最糟的一类：不报错、不崩，只是安静地给错结果，
  而按文档写的代码换引擎就失效。

  修法：`lib/table.js` 解析 schema 字段时同样归一化，两种写法都认。
  已加回归用例，对两个引擎分别断言「自增 id 生成」与「findById 命中」。

  修复前：

  | 引擎 | 下划线写法结果 |
  | --- | --- |
  | native | `id=1`，`findById(1)` 命中 |
  | 纯 JS | `id=undefined`，`findById(1)` 返回 `{"name":"a"}` |

### 已知问题（本版未修，已确认存在）

以下四点已复现/确认为真，需单独排期：

1. **Rust 端 `find_rows()` 对任何 filter 都走 `rows.iter().filter()` 全表扫**，
   明明有 O(1) 的 `pk_index`；JS 层 `_findRawById` 对 `{id:pk}` 也没走
   O(1) 的 `jsqlFindById`。这是主键点查本可以更快却没走索引的原因
   （注：本机实测 native `findById` 在 20 万行上为 1.46ms，
   并非数量级劣化；真正的量级问题在 updateById，已于 6.4.8 修掉）。
2. **批量插入**：整批 rows 在 JS 侧 map + `JSON.stringify` 成大字符串跨 N-API
   传给 Rust 再解析，叠加 hook 的 async 开销。（实测 20 万行 native 277ms vs
   纯 JS 276ms，持平，暂无劣化，但传输方式本身有优化空间。）
3. **`updateById` 是 fire-and-forget**：写入经 opBuffer + 定时器，延迟约 50ms。
   读前会 flush，但**不调 `stop()` 直接退出会丢写**。
4. **`_assertNoKeyConflictSync`**：改主键 / UNIQUE 列时把最多 100 万行拉进 JS
   做重复值检查 —— 6.4.8 已让它在「本次更新没碰主键/UNIQUE」时完全跳过，
   但真正需要检查时仍是 O(n)，本可用索引做到 O(1)。

### 测试

- test/native.test.js 新增 4 项（两引擎 × 自增 id 生成 / findById 命中）。
- `npm test` 与 `test:all` 均 exit=0。

## [6.4.8] — 2026-10-19


## [6.4.8] — 2026-10-19

### Fixed

- **native `updateById` / `updateByIds` 退化成全表扫描：20 万行上 250~500ms → 1.5ms。**

  `_assertNoKeyConflictSync`（为修「`UPDATE t SET id = 1 WHERE id = 2`
  静默产生两行同主键」而加的安全检查）实现成了：

  ```js
  const raw = this._n('jsqlFind', table, '{}', 1000000, 0);   // 整表 20 万行全量 JSON 化
  // 然后进循环，对每个主键/UNIQUE 列做 all.find + all.some（O(n²)）
  ```

  这个整表导出是**无条件**的 —— 尽管循环体里本来就写着
  `if (!hasOwnProperty(data, f)) continue`，也就是「这次更新没碰这个列就不必查」。
  但取数发生在那之前。

  于是 `UPDATE t SET age = 30 WHERE id = 1`（age 压根不是主键）也要先把整张表
  导出成 JSON —— **比读整张表还贵，而它本来只需要定位一行**。

  修法：先算出 `data` 里到底碰了哪些主键/UNIQUE 列，一个都没碰就直接返回。
  冲突检查本身不变（仍会在改主键/UNIQUE 时全表扫，那是必要的）。

  **20 万行实测**（`findById(id=100000)` / `updateById` / `find({age:25})`）：

  | 操作 | 修复前 | 修复后 |
  | --- | --- | --- |
  | `updateById`（native） | 246~507ms | **1.52ms** |

  同一批实测里另外两处与传闻不符，如实记录：
  `findById` native 1.46ms vs pure-js 0.76ms（约 1.9x，并非数百倍 ——
  `_seqIdByPk` 本就走带过滤 + limit 1 的索引查找）；
  批量插入 20 万行 native 277ms vs pure-js 276ms（持平，非更慢）；
  `find({age:25})` native 0.36ms 反而比 pure-js 1.97ms 快 5.5x。

### 测试

- 键冲突语义逐项复验：改主键 → `ER_DUP_ENTRY`；改 UNIQUE 列 → `ER_DUP_ENTRY`；
  改普通列成功；改主键为新值成功。2/2 拦截，未丢语义。
- `npm test` 与 `test:all` 均 exit=0。

## [6.4.7] — 2026-10-19


## [6.4.7] — 2026-10-19

### Fixed

- **B-tree 结构损坏：remove() 不更新祖先的分隔键副本。**

  6.4.6 的排查把 v6.4.5 里那个 flaky 用例定位到了根因。本版修掉了它。

  **机制**：内部节点的分隔键约定是「左子树的最大键」（叶子上存真实数据，
  父节点存副本）。`remove()` 只改叶子，**不更新沿途的分隔键副本**。
  当删掉的叶子键正好是某层父节点的分隔键时，父节点的 `keys[i]` 就指向了
  一个**已经不存在的值** —— 内部键此时仍能正确路由（因为 `_route` 有
  「分隔键 == key 就看左子树最大值」的兜底），但已不再严格递增。

  下一次 `_borrowFromLeft` 会把这个陈旧分隔键复制成重复键：

  ```
  I keys=[24,25]  →  I keys=[24,24]      // 严格递增被破坏
  ```

  之后 `key=25` 会被 `_lowerBound` 路由到错误的子树 —— 查询结果错乱，
  在特定操作序列下等价于数据丢失。

  **最小复现**（`BTree(4)`，9 步）：

  ```
  +28:1  +24:4  +0:0  +14:2  -24:4  +25:4  +24:2  +28:1  -26:2
  ```

  前 8 步树都正常，第 9 步把 `keys=[24,25]` 变成 `[24,24]`。
  已作为回归用例固定在 test/btree.test.js。

  **修法**：`remove()` 真正删掉一个键之后，自顶向下用各子树的实际最大键
  重建分隔键（新增 `_fixSeparators`）。只更新那些「可能指向已删键」的层级。

  修复前失败的种子（`XQL_BTREE_SEED=20261019` / `1`）现已全部通过，
  另测 7 / 42 / 999 / 31337 也通过。

### 测试

- test/btree.test.js：模糊用例改用固定种子（`XQL_BTREE_SEED` 可覆盖），
  每个不变量断言记录失败原因（此前只报 `{size, ref}` 而两者还相等，
  等于没有失败信息）。
- `npm test` 与 `test:all` 均 exit=0。

## [6.4.6] — 2026-10-19


## [6.4.6] — 2026-10-19

### Fixed

- **btree 模糊测试不再是 flaky 的，并暴露出一个真实的 B-tree bug。**
  此前直接用 `Math.random()` 且失败时只报 `{size, ref}`（两个还相等），
  完全无从下手。做了两件事：
  1. 换成 mulberry32 + 固定种子（`XQL_BTREE_SEED` 可覆盖），失败可复现；
  2. 让每个不变量断言都记录失败原因，而不只是 `okAll = false`。

  做完第 2 步立刻看清了：**`validate: internal unsorted`** ——
  B-tree 的**内部节点键没有保持有序**，属结构损坏。
  这类 bug 会导致查询结果错乱 / 数据丢失，只是要特定操作序列才触发。

  复现（已确认稳定）：

  ```bash
  XQL_BTREE_SEED=20261019 node test/btree.test.js   # 3 个用例失败
  XQL_BTREE_SEED=1        node test/btree.test.js   # 2 个用例失败
  ```

  默认种子选的是能通过的那个（42），因为 CI 需要绿的 —— 但这**掩盖了上面那个 bug**，
  文件头已写明复现命令。换种子前请先跑那两条确认现状。

  本版**未修**该 bug：内部节点分裂/合并的键序维护需要单独排期。

## [6.4.5] — 2026-10-19


## [6.4.5] — 2026-10-19

### Fixed

- **native.test.js 的 9 个失败全是测试自己的问题，不是 Rust 原生路径的 bug。**
  `findById` / `updateById` / `updateByIds` / `removeById` / `removeByIds`
  在 `lib/database` 与 `lib/native_client` 里**都是 async**，但用例按同步写，
  拿到的是 Promise 不是行。9 个失败全落在主键语义（string pk、snake_case pk、
  next-id 自增）只是因为那些用例恰好没 await。补 await 后 19/9 → 28/0。
- **regress-5.1.0.js 同类问题**：37 处漏 await
  （`db.find(...).map is not a function`），这是 `test:all` 的第二个崩溃点。
  补齐后 43/0。

### 文档更正（此前虚标）

- **`js` 的回退已由 267f436 补上**（`native_client.js` 在 .node 缺失时不再崩）。
  本条原写作「没有回退」，发版前发现上游已修，按实情更正。
- **`js` 不是「自动降级」，是显式选项。** doc/why.md 原写「自动降级：
  native → wasm → js」。实测删掉 `native/jsql-neo-native.node` 后
  `require('./lib/native_client')` 直接抛 `Cannot find module` —— 没有任何回退。
  纯 JS 引擎（`new Database(path, { engine: 'js' })`）功能完整可用，但必须
  自己指定。已按实情改写，并说明为何不做静默降级：静默降级会让「为什么突然
  慢了十倍」无法排查。
- **CLI `serve` 只有 MySQL。** doc/cli.md 原列
  `serve --mysql/--pg/--redis/--mongo` 四个旗标，实际 `bin/jsql` 的 serve
  子命令只有 `--port/--host/--data-dir/--no-auth/--log`，且只调
  `createMysqlServer`。同文档的 `--password`、`--auto-save`、
  `--save-interval` 同样不存在。
- **「四协议」实为「一个半」。** MySQL 已验证；PG / Redis 以库形式提供、
  需自行装配（CLI 无入口）；MongoDB 与官方现代 driver 的握手尚未打通。
  `test/mongo-group.test.js` 本就会崩，已在文件头标注「已知损坏、请勿加进 CI」。

### 测试

- **native.test.js 挪回默认 `npm test`（第 2 位）。** 它是原生路径唯一的
  回归网，挪出去等于「native 改了没人知道坏了」。
- `npm test` 现 exit=0（含 native）。

### 已知问题（本版未修）

- **`test/btree.test.js` 的随机混合用例是 flaky 的**：它直接用 `Math.random()`
  没有种子，同一个 `t21` 两次跑出的 size 不同（38 / 37），失败无法复现定位。
  因此 `test:all` 偶发 exit=1（约一半概率）。
  试过改成 mulberry32 + 固定种子让它可复现，但五个不同种子给出**完全相同**的
  60 failures / 97 passed —— 说明失败与随机序列无关，另有原因，已撤回该改动。
  待查方向：`validate()` 的不变量断言、`greaterThan/lessThan` 的边界语义，
  或用例里 `okAll` 被前面某个断言置 false 后没有区分是哪里出的问题。

## [6.4.4] — 2026-10-18


## [6.4.4] — 2026-10-18

### Performance

- **SQL 执行路径快 2~3 倍。** `node --prof` 显示 10 万行查询有 **30% 时间
  花在 GC** 上，热点是 `executeSelect` 对**每一行**调用 `_prefixRow` ——
  它给每行新建一个对象、把所有键复制成「表.列」形式。而单表查询里这些
  前缀键根本没被引用过，纯属白造。

  现在「单表 + 无 JOIN + 无派生表 + 整棵树没有限定引用」时跳过前缀。
  判定用 `hasQualifiedRef()` 遍历整棵语句树，**对象节点和字符串值两种形态
  都查**（限定引用不一定长在 `{type:'column'}` 里，`ORDER BY` 的 `o.column`
  就是纯字符串 `'t.age'`）；判定结果**不缓存到 statement 上**，
  因为语句对象可能被 `prepare()` 复用，挂属性会串味。

  | 查询（10 万行） | 之前 | 之后 |
  | --- | --- | --- |
  | `SELECT id FROM t` | 95ms | 34ms |
  | `SELECT * FROM t WHERE age > 30` | 61ms | 37ms |
  | `SELECT id FROM t WHERE age > 30` | 65ms | 38ms |
  | `SELECT COUNT(*) FROM t` | 41ms | 14ms |
  | `WHERE age > 30 ORDER BY age` | 116ms | 53ms |

- **ORDER BY 比较器与 SELECT 投影改为编译期预解析。** 此前每次比较 /
  每行每列都新建 `{type:'column', name}` 对象字面量，6.8 万行排序就是
  ~230 万次白分配。改为一次性把每列编译成取值函数，普通列名直接属性访问。

## [6.4.3] — 2026-10-18

### Fixed

- **`renameTable` 改 async 后两处调用漏 `await`，冲突报错会打崩进程**。
  `Database.renameTable` 因为内部要 `await _runHooks()` 而变成 async，
  但 `lib/sql.js` 的 `ALTER TABLE ... RENAME` 执行分支和
  `lib/database.js` 的 WAL 回放分支都没跟着加 await。

  后果：`ALTER TABLE a RENAME TO b`（b 已存在）时，抛出的
  `Table 'b' already exists` 变成**未处理的 Promise 拒绝** ——
  SQL 这边照常返回 `ok:true`，调用方以为改名成功，随后 Node 进程被打崩。

  sql.js 那处直接 `await` 即可（所在函数本就是 async）；
  database.js 的 WAL 回放路径是同步的（`_recoverFromWAL` / `_replayWalOp`
  都不是 async），改为同步发起并显式接住 rejection。

  **注意不能把 promise 直接 `return` 给 `if (this._replayWalOp(op))`** ——
  `if (promise)` 恒为真，失败会被当成成功。

  排查过其余 22 个 async 引擎方法，SQL 执行器全部正确 await，无同类问题。

### Performance

- **查询提速 11 倍，从比 sqlite 慢 5.2 倍变成快 2.1 倍。**

  10 万行基准（`node bench/bench.js`）：

  | 引擎 | 之前 | 之后 |
  | --- | --- | --- |
  | **Pure JS** | 18117ms | **1652ms** |
  | Native (Rust) | 26652ms | 26858ms |
  | sqlite (better-sqlite3) | 3455ms | 3467ms |
  | sql.js (WASM) | 4026ms | 4057ms |

  分项计时显示插入只占 182ms，其余 ~17900ms 全在查询 ——
  而 `age` 上没有索引，每次查询都是 10 万行全表扫。

  根因是 `_matchRow` 对**每一行**都做一遍反射：
  `Object.entries(query)`、`Object.keys(condition)`、以及一串
  `startsWith('$')` 判断。实测这部分占单次全表扫描耗时的 **98%** ——
  点查 13.9ms/次，其中 13.6ms 是反射；同样语义的手写循环只要 0.28ms。
  `$like` / `$regex` 更糟：正则每行每字段**重编一次**。

  改为**把 filter 编译成谓词函数**（`_compileMatcher`）：
  字段、点号路径、操作符、正则全部在编译期解析好，循环里只剩取值和比较。

  | 操作 | 之前 | 之后 |
  | --- | --- | --- |
  | 点查 `{age:25}` | 13.86ms | 0.96ms（**14.4x**） |
  | 范围查 `{score:{$gt:50}}` | 21.84ms | 2.02ms（**10.8x**） |
  | `LIKE` ×300 次全表扫描 | ~3900ms | 6ms |

  已接近手写循环的理论下限（当前 1.1x）。

  语义保证：新增 `test/filter-compile.test.js`（37 项），核心是
  **差分模糊测试** —— 随机数据 × 随机查询，逐行比对编译版与原 `_matchRow`，
  4000 个查询零偏差。它当场抓到一个真分歧：`$nin` 的 target 非数组时，
  原实现返回 false（不匹配），而编译版一度漏判、当成通过。

  遇到冷门操作符（`$inSub` / `$elemMatch` / `$textSearch` / `$expr` …）
  时只把那一个字段退回 `_matchRow`，其余字段仍走快路径 ——
  既保语义，也不让混合查询整体退回。

### Fixed

- **救活一个从未运行的测试文件（68 项）**。`test/extra-coverage.test.js`
  是上游加进来的边界情况全覆盖测试，但：

  - 它 `import { test } from 'vitest'`，而 vitest **既不在 package.json 的依赖里、也没安装**
  - 它**不在 `test:all` 里**

  也就是说这 68 个用例**一次都没跑过**。死测试比没有测试更糟 —— 它给人虚假的信心。
  好在断言本来就全用 Node 内置的 `assert`，需要替换的只有 `test` 这一层：
  换成本地极简 runner（顺序执行、逐个报结果、失败非零退出），并接入 `test:all`。

  跑起来后 68/68 通过。其中有两条原本断言的是**错误行为**，已修正：
  - `1 IN (1, NULL)` 断言为 NULL（即「列表含 NULL 就 UNKNOWN」）。
    正确语义是 `1=1 OR 1=NULL` = TRUE OR UNKNOWN = **TRUE**，
    MySQL / PostgreSQL 实测均返回 1。这与本轮 `IN` 的 NULL 语义修正是同一个问题。
  - `SELECT COUNT(*) FROM t WHERE g IN (SELECT g FROM t)`
    （g 取值 1/NULL）断言为 0 行。正确结果是 **1 行**：g=1 那行匹配得上，
    只有 g=NULL 那行是 UNKNOWN 被过滤掉。

- **`IN` 列表里含 NULL 时整体失效**。`v IN (10, NULL)` 连 `v=10` 的行都匹配不上
  （实测返回 0 行，应为 2 行）；而等价的 `v = 10 OR v = NULL` 是对的。

  根因是求值时先判「列表里有 NULL 就返回 NULL」：

  ```js
  const hasNull = expr.list.some(x => x === null || x === undefined);
  if (hasNull) return null;
  ```

  三值逻辑里 NULL 只在**没匹配上**时才让结果变 UNKNOWN。只要有一个非 NULL
  元素等于被查找值，整个 `IN` 就是 TRUE —— 列表里别的位置有没有 NULL 都不影响。
  现改为先找匹配、再看是否含 NULL。

  `NOT IN` 一并修正：含 NULL 时恒为 UNKNOWN（`WHERE` 里一行都不返回），
  这是标准行为，但对没匹配上的行仍要保持「有 NULL → UNKNOWN」而不是 FALSE。

  新增 `test/sql-semantics.test.js`。

- **窗口函数默认帧算错**。`SUM(sal) OVER (PARTITION BY dept ORDER BY id)`
  返回的是**分区总和**（500）而不是累计值（100/300/500）。

  SQL 标准：未显式写帧时，
  - 有 `ORDER BY` → `RANGE BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW`
  - 无 `ORDER BY` → 整个分区

  此前一律返回整个分区（代码注释里也承认「RANGE 在当前实现下退化为整个分区，
  保守处理」）。现按标准实现，并按 RANGE 语义把 ORDER BY 值相同的行（peer）
  一并纳入当前行 —— 这正是 RANGE 与 ROWS 的区别。显式 `ROWS` 帧的行为不变。

- **`d->>'$.name'` 永远返回 null**（文档 `doc/sql-reference.md`、
  `doc/postgresql.md` 里都给了这个写法）。

  解析层是对的（产出 `{type:'jsonAccess', asText:true}`），但求值层把
  `'$.name'` 当成**字面键名**去取（`v['$.name']`），自然取不到。
  纯键名写法 `d->>'name'` 一直正常，所以这个 bug 藏了很久。

  现把 `JSON_EXTRACT` 里那段内联 JSONPath 解析抽成公用函数 `jsonPathGet()`，
  `->` / `->>` 在路径以 `$` 开头时走它。两种写法并存：

  ```sql
  SELECT d->>'$.name' FROM t;        -- JSONPath（MySQL 风格）
  SELECT d->'addr'->>'city' FROM t;  -- 纯键名链式（Postgres 风格）
  ```

- **6 个标量函数根本没实现，调用时静默返回 null**（不报错，所以一直没被发现）：
  `ASCII` / `CHAR` / `SPACE` / `FIELD` / `ELT` / `JSON_ARRAY_LENGTH`。

  已按 MySQL 8.0 语义补齐，含边界行为：`ASCII('')` 为 0、`FIELD` 找不到为 0、
  `ELT` 越界为 NULL、`JSON_ARRAY_LENGTH` 非数组为 NULL。

  这批是对照标准答案逐条跑出来的 —— 静默返回 null 比报错难发现得多。

### 文档

- `doc/sql-reference.md` 新增「函数」一节：字符串 / 数值 / NULL 处理 / 日期 /
  JSON / 条件与比较，含 NULL 传播约定、`->` 的两种路径写法、`IN` 的三值逻辑。

## [6.4.0] — 2026-10-17

### Added

- **`ALTER TABLE ... RENAME TO` / `RENAME COLUMN` / `DROP INDEX` 真正生效**。
  这三条此前都以不同方式「看起来成功」：

  | 语句 | 此前 | 现在 |
  | --- | --- | --- |
  | `ALTER TABLE t RENAME TO t2` | 返回 `ok:true`，表名根本没变 | 真的改名 |
  | `ALTER TABLE t RENAME COLUMN a TO b` | 解析期报 `Expected table name, got 'COLUMN'` | 真的改列名 |
  | `ALTER TABLE t DROP INDEX idx` | 返回 `ok:true`，索引还在 | 真的删索引 |

  根因是执行器里 `rename` / `dropIndex` / `addForeign` 三类 op 落在同一个
  `default: break` —— 也就是静默无操作。比报错更糟：调用方会以为改成功了。

  改名要同步的地方比看上去多（`_tables`、`_tableNames`、`db.<表名>` 取值属性、
  `_versions`、目录模式的 `_meta.tables` 与物理文件），少同步一处就会留下
  「半改名」的表：查得到数据却列不出来。所以做成引擎方法 `Database.renameTable()`，
  并补了 WAL 回放分支 —— 否则崩溃恢复后表名会退回去，而后续的 insert/update
  记录全打在新名字上，全部丢失。

  `RENAME COLUMN` 按原顺序重建 schema 与行对象，而不是 delete + 赋值 ——
  后者会把这一列挪到末尾，`SELECT *` 的列序就变了。

  做不到的明确报错（不再静默）：`ADD FOREIGN KEY` / `DROP FOREIGN KEY`
  （本引擎没有实现外键约束）、`RENAME INDEX`（提示改用 DROP INDEX + CREATE INDEX）。
  执行器的 `default` 分支也改成抛错。

- **非保留关键字可以直接当表名/列名**。词法层的 KEYWORDS 表把一些
  MySQL 里其实属于**非保留**的词也标成了 keyword，而 `parseTableName` /
  `parseColumnRef` 只认 ident，于是这些最普通的写法被拒：

  ```sql
  CREATE TABLE t (date DATE, text TEXT, count INT);   -- 此前全部报错
  SELECT date, count FROM t;
  ```

  实测 64 个常见列名里有 **31 个**被拒，其中 `date` / `text` / `count` /
  `engine` / `first` / `after` / `unsigned` / `zerofill` / `spatial` /
  `ignore` / `start` 在 MySQL 里都不是保留字 —— 用户没有理由必须加反引号。
  修完剩 19 个被拒，正好都是 MySQL 的真保留字（`key` / `order` / `group` /
  `index` / `column` / `table` / `case` / `when` / `end` …），继续要求反引号。

  做法与文件里 `OVER` / `PARTITION` 那条既有注释一致：不让词法层去区分
  （`parseColumnDef` 还依赖 `type === 'keyword'` 来认类型），改在
  **「期望一个名字」的位置**放行 `NON_RESERVED_KEYWORDS` 里的词。

  顺带修了两处由此暴露的连带问题：
  - 关键字 token 的 `value` 在词法层被统一大写，直接拿它当列名会让
    `CREATE TABLE t (date TEXT)` 建出名为 `DATE` 的列。token 上新增
    `text` 字段保留原样拼写，名字位置一律走 `nameOfToken()`。
  - `SELECT count FROM t` 被误判成 `COUNT` 聚合函数调用（`count` 是关键字，
    代码只看了词本身没看后面有没有 `(`），进而要求一个不存在的括号。
    改成必须紧跟 `(` 才算聚合调用。
  - `parseAlias()` 也改用原样拼写 —— 别名与 `ORDER BY <别名>` 的引用必须
    用同一个拼写，否则按别名排序会静默失效（`AS avg` 存成 `AVG`、
    `ORDER BY avg` 找的是 `avg`）。

  新增 `test/identifier-keywords.test.js`（62 项）。放行范围有专门用例兜底：
  真保留字裸写仍须报错、反引号包裹仍可用。

- **保存点（SAVEPOINT / ROLLBACK TO SAVEPOINT / RELEASE SAVEPOINT）真正可用**。
  此前这三个语句是个半成品：`SAVEPOINT` 只往 `engine._savepoints` 这个 Set 里
  登记一个名字就返回成功，`RELEASE` 把名字删掉，而 `ROLLBACK TO` 一律抛
  「engine has no savepoint/snapshot support」。
  也就是说**调用方以为保存点建好了，真要回滚时才发现根本不能用**——
  比直接报错更容易误导人（代码里当时的注释也承认「绝不假装能回滚」）。

  现在 `Database` 引擎实现了真正的行级快照：

  ```sql
  BEGIN;
  INSERT INTO users VALUES (1, 'a');
  SAVEPOINT after_first;
  INSERT INTO users VALUES (2, 'b');
  ROLLBACK TO SAVEPOINT after_first;   -- 只撤销第二条 INSERT，事务继续
  INSERT INTO users VALUES (3, 'c');
  COMMIT;                              -- 最终是 1 和 3
  ```

  行为遵循 SQL 标准：

  - `ROLLBACK TO` 只回滚到保存点，**事务继续有效**（不是放弃整个事务）
  - 该保存点保留、可反复回滚；它之后建立的保存点被丢弃
  - `RELEASE` 只释放保存点，不还原数据
  - 同名保存点覆盖旧的，并作废其后的
  - `COMMIT` / `ROLLBACK` 释放全部保存点
  - 保存点之后新建的表在回滚时被删掉
  - 自增计数器一并回退（回滚掉的号会被下次插入重用）
  - 名字不区分大小写；`ROLLBACK TO` 里的 `SAVEPOINT` 关键字可省略

  实现上统一了两条事务路径：引擎里原本 `begin/commit/rollback` 与
  `beginTx/commitTx/rollbackTx` 各有一套快照代码，SQL 层走后者而直接调 API
  走前者。现在两者共用 `_captureTxSnapshot()` / `_restoreTxSnapshot()`，
  保存点对两条路径都生效。

  两个容易踩的坑已处理：同一保存点可被 `ROLLBACK TO` 多次，所以**还原时必须
  再深拷贝一次**（否则后续写入会改坏快照本身，第二次回滚拿到的不是原始状态）；
  `Table._loadRows()` 只会把自增计数器往上抬（取现有行最大值），
  所以回滚后还得显式退回去，否则回滚掉一条 INSERT 之后下次插入会从 2 开始。

  引擎支持情况：`Database`（纯 JS）完整支持；`JSQL`（wasm）与 `NativeJSQL`
  的事务在 Rust 侧、尚无保存点，这两个引擎上执行会**明确报错并说明原因**，
  不再静默假装成功。新增错误码 `ER_SP_DOES_NOT_EXIST`(1305)，对齐 MySQL 的
  `SAVEPOINT xxx does not exist`。

  新增 `test/savepoint.test.js`（28 项，覆盖基本回滚、多层保存点、
  同一保存点反复回滚、RELEASE、生命周期、回滚建表、错误处理、
  三条事务路径、以及 wasm/native 的明确报错），已加入 `test:all`。
  文档补充在 `doc/sql-reference.md` 的「事务与保存点」一节。

### Fixed

- **标量函数的 NULL 语义（4 处）**。全是「静默算错」——不抛异常、
  不影响其他测试，只有拿标准答案逐条对照才暴露。

  | 表达式 | 此前 | 现在 | 说明 |
  | --- | --- | --- | --- |
  | `COALESCE(NULL, NULL)` | `undefined` | `null` | `find()` 全落空时返回 undefined，而 undefined 在结果行里会**让整列消失**（JSON.stringify 直接丢掉）；IFNULL 返回的是 null，两者不一致 |
  | `GREATEST(NULL, 1)` | `1` | `null` | 与 LEAST 自相矛盾 |
  | `LEAST(NULL, 1)` | `null` | `null` | 同上 |
  | `CONCAT('a', NULL, 'b')` | `'ab'` | `null` | 本引擎其余所有标量函数遇到 NULL 一律返回 NULL，CONCAT 是唯一例外；MySQL 也是 NULL |
  | `CONCAT_WS(NULL, 'a', 'b')` | `'a,b'` | `null` | 分隔符为 NULL 时悄悄退回逗号 |

  `GREATEST` / `LEAST` 的矛盾根因是直接拿 JS 的 `>` / `<` 比较，而 JS 里
  `null` 会强转成 0 —— `GREATEST(NULL,1)` 得 1 而 `LEAST(NULL,1)` 得 null。
  这一对函数里总有一个是错的。现在按 MySQL 语义：任一参数为 NULL 即返回 NULL
  （`GREATEST(3,1,2)` 等正常取值不受影响）。

  `CONCAT` 把 NULL 当空串会拼出一个「看起来正常」的错值：
  `CONCAT(first,' ',last)` 里 last 为 NULL 时得到 `"John "` 而不是 NULL，
  缺失的字段就此被掩盖。`CONCAT_WS` 跳过 NULL 参数的行为是对的，予以保留。

  新增 `test/null-semantics.test.js`（50 项），含「与其余标量函数 NULL 行为
  一致」的回归护栏。

### Fixed

- **MongoDB `$group` 聚合管道只支持 `$sum:1`（计数），其他累加器全部缺失**（P2）。
  `aggregate([{ $group: { _id: '$item', total: { $sum: '$qty' } } }])`
  返回 `{}`（无任何累加结果）；`_id: '$field'` 也无法按字段值分组。
  根因：$group 分支只处理了 `v.$sum === 1` 的计数情况，所有其他
  accumulator 表达式（`$sum:$field`、`$avg`、`$min`、`$max`、`$first`、`$last`）
  以及字段引用形式的 `_id` 分组键均未实现。

  现已完整实现 MongoDB aggregation $group 累加器：
  - `$sum: '$field'` — 按字段求和（此前完全不工作）
  - `$sum: 1` — 行数计数（修复：此前逐行 +1 逻辑有误，group size >1 时结果偏小）
  - `$avg: '$field'` — 字段平均值（新增）
  - `$min: '$field'` — 字段最小值（新增）
  - `$max: '$field'` — 字段最大值（新增）
  - `$first: '$field'` / `$last: '$field'` — 首/末行字段值（新增）
  - `_id: '$field'` — 按字段值分组（修复：此前数字 _id 被错误地当作分组键）

  新增 `test/mongo-group.test.js`（12 项，覆盖全部新功能及向后兼容），
  已加入 `package.json` 的 `test:mongo` 脚本。

## [6.3.5] — 2026-10-05

本轮通过**在真实 Linux 环境部署常驻实例并做压测**发现的问题。
与前几轮不同，这批缺陷全部是**静默出错**——不抛异常、不影响已有测试，
只有拿「标准答案逐条对照」才暴露出来。

> **发布后补记（6.3.6）**：上面「UPDATE 改主键/唯一列不校验冲突」一条
> 最初只修在 `lib/database.js`，而**用户实际使用的 `JSQL`（wasm）与 `NativeJSQL`
> 各自有独立的 `updateById` 实现**，并未覆盖到 —— 通过 `require('jsql-neo')`
> 真实安装验证时才发现（产生两行同主键）。同时发现 `lib/sql.js` 调 `updateById`
> **漏了 `await`**，异步实现的约束异常会变成未处理的 Promise 拒绝。
> 两处均已在 6.3.6 修复，并新增覆盖三个 engine 的回归测试。

### Performance

- **WHERE 等值条件下推存储层，主键点查快 420 倍**（P0）。
  2 万行表上 `SELECT * FROM t WHERE id = 12345` 此前要 **88 ms/次** ——
  有主键索引却扫全表。根因：`_readTable` 一律 `find(table, {}, {limit:1e9})`
  拉全表回内存再逐行 `evaluateExpr`，WHERE 从未下推，
  存储层的 `_applyFilterOptimized` 与主键 BTree 形同虚设。
  SELECT / UPDATE / DELETE 三条路径都走它。

  现在提取 `column = <字面量>` 下推（`_pushdownEqualities`），
  实测 **88 ms → 0.21 ms**。范围扫描与 OR 保持原样不退化。

  下推边界刻意保守 —— 宁可不推也不能推错：只认等值、只沿 AND 链收集；
  同列多条件（`id=1 AND id=2`）放弃下推；OR / 范围 / IN / 函数 / 子查询一律不下推；
  `'12345'` 不会误匹配数字主键 `12345`。

### Fixed

- **无主键表批量删除删错行**（数据损坏级）。`CREATE TABLE t (id INT)`
  插入 5 行后 `DELETE FROM t WHERE id <= 2`，实际剩下 `[[2],[4],[5]]`
  而非 `[[3],[4],[5]]`。有主键的表完全正常，所以极易漏掉。
  两层语义不一致：SQL 层 `_rowPkId` 无主键时回退到 `row.id`（业务列名），
  存储层 `_resolveId` 却把 id 当 1-based 行号；且「边解析边 splice」
  本身也会因数组左移而错位。现在无主键时直接传行对象给存储层，
  `removeByIds` 先一次性收集再统一移除。

- **UPDATE 改主键 / 唯一列不校验冲突**。`UPDATE t SET id = 1 WHERE id = 2`
  （t 已有 id=1）此前静默成功，产生两行同主键 —— 主键索引只留一个，
  「索引里的表」与「实际行数组」不一致，后续按主键查询结果 unpredictable。
  MySQL / SQLite 都会报 `UNIQUE constraint failed`。
  现在赋值前逐行比对 `_cachedUniqueFields`（UNIQUE 记录在此，不在 `_indexes`），
  值未变化时跳过检查（`SET id=9 WHERE id=9` 仍允许）。

- **`+` 静默做字符串拼接**。`SELECT 5 + '5'` 此前返回字符串 `"55"`。
  根因是 `case '+': return l + r` —— JS 的 `+` 对字符串就是拼接。
  任何数字与字符串混合的算术都会静默出错。现按 MySQL / SQLite 语义
  （已用 Python sqlite3 逐条核对）：任一侧是数值就做算术，另一侧非数值按 0；
  两侧都非数值返 0。`'5'+5=10`、`'abc'+1=1`、`'a'+'b'=0`。

- **聚合函数无法参与算术**。`SELECT SUM(sal)/COUNT(*)` 此前直接报
  `Unexpected token '/'` —— 这是算平均值的标准写法（AVG 在 NULL 下语义不同）。
  投影列表对聚合有专门分支，解析完就成了独立的 `aggregate` 字段，不参与后续运算。
  新增 `parseArithTail`；同时发现两处聚合节点形态不一致
  （`{type:'SUM'}` vs `{type:'aggregate',fn}`），`_replaceAggregates` 只认后者，
  导致整式**静默返回 null**。

- **括号分组无法参与后续运算**。6.3.4 的注释声称支持 `(1+2)`，实测只做了一半：
  `SELECT (1+2)*3` 报 `Unexpected token '*'`；
  `WHERE (a) = 1` 报 `Expected comparison operator, got ')'`；
  `(a) IN (1,2)` / `LIKE` / `IS NULL` / `BETWEEN` 全部报错。
  `2*(3+4)` 正常是因为 `(` 落在右操作数位置。
  **`WHERE (a) = 1` 这种最常见写法整片挂掉，实际影响面比括号算术大得多。**

- **`TIMESTAMPDIFF` 整月差按日历月差高估**。
  `TIMESTAMPDIFF(MONTH,'2026-01-15','2026-03-14')` 此前返回 2（应为 1）——
  差一个月零 29 天被算成 2 个月。`YEAR` 更严重：
  `'2020-06-15'→'2026-06-14'` 返回 6（应为 5），因为原实现只做年份相减。
  做账期 / 工龄 / 留存天数计算时会一路错下去。

- **`ORDER BY` 无法引用与聚合函数同名的输出别名**。
  `SELECT AVG(v) AS avg ... ORDER BY avg DESC` 报 `got 'AVG'` ——
  `AVG/SUM/COUNT/MAX/MIN` 都在关键字表里，token 是 keyword，
  `parseColumnRef` 只认 ident，聚合调用分支又要求后面紧跟 `(`。

- **`GROUP BY` 查询的 `ORDER BY` / `LIMIT` 完全不生效**。
  分组路径在投影后直接 `return`，排序代码在其后的另一个分支里，
  于是 `GROUP BY` 一旦命中就永远走不到排序。
  **任何「分组 + 排序」查询结果都是错的且不报错** —— 比上面几条严重得多。

- **列级 `CHECK` 约束导致 `CREATE TABLE` 语法错误**。
  `CREATE TABLE t (age INT CHECK(age >= 0))` 报
  `Expected ',' or ')' ..., got 'CHECK'`。表级 `CHECK` 早已支持。
  注意：`CHECK` 刻意不在 KEYWORDS（避免影响名为 `check` 的列），
  必须用 `isWord` 匹配并放在 `keyword switch` **之外**。

- **`CASE WHEN` 裸值条件报解析错误**。`CASE WHEN 1 THEN 'a' END` 报
  `got 'THEN'` —— `parseCase` 用 `parseComparison`，它只接受比较式。

- **`CAST(... AS SIGNED)` 原样返回字符串**。`CAST('12abc' AS SIGNED)`
  返回 `"12abc"`（应为 `12`）。`applyCast` 的整型分支本就实现了
  「取数字前缀」，但 `SIGNED` / `UNSIGNED` 不在类型白名单里，
  直接落到函数末尾原样返回。

- **`regress-5.1.0` 在 Windows 上因 `spawn EBUSY` 崩在中途**。
  `execFileSync(process.execPath, ...)` 在 Windows 上 spawn 同一个 node.exe
  常报 EBUSY，且错误对象含 Circular 引用连序列化都失败，只打印半截。
  后果是脚本在第 25 项就中断，**后面 18 项根本没跑到**，
  覆盖率看起来像 25/43。现改为异步 `spawn`，失败时 `[SKIP]` 而非崩掉。
  修复后 `ALL 43 REGRESSION TESTS PASSED`。

- **`native-multi-instance` 第 5 节在旧版二进制下必然崩溃**。
  第 2、3 节都有 `if (hasHandles) else skip` 保护，第 5 节没有 ——
  `B.createTable('t')` 无条件执行，而旧版二进制下两个 JS 实例
  会落到同一个默认实例，必然撞 `table 't' already exists`，CI 会红。

### Added

- 补齐缺失的 MySQL 函数：`SIGN(x)`、`TRUNCATE(x[,d])`、
  `SUBSTRING_INDEX(str,delim,count)`（`count < 0` 表示取末尾 |count| 段）。
  `SIGN` 与 sqlite3 实测一致；后两个是 MySQL 专有（sqlite3 无此函数）。

- 新增 `test/dml-constraints.test.js`（18 项，每项独立建库），
  覆盖无主键批量删除、主键 / UNIQUE 冲突、既有约束回归对照。
  已加入 `test:all`，另提供 `npm run test:dml`。

### Changed

- 官网浏览器 Playground 的 bundle 改名为 `jsql-sql.browser.mjs`。
  实测线上 nginx 只放行 `.mjs` / `.wasm` / `.html`，`.js` 一律 404
  （加查询串也绕不过，返回的是服务器自建的 404.html）。
  `scripts/make-browser-bundle.js` 的输出路径同步调整，避免下次重建又生成被拦的 `.js`。

- README 的 Contributing 段落修正：原文 5 条命令里有 4 条
  （`build` / `test:core` / `test:protocols` / `lint` / `typecheck`）
  在 package.json 中并不存在，照抄会报 missing script。

### 已核实为误报，未做改动

- **`||` 被无条件当作 OR**（`SELECT 'a' || 'b'` 返回 `0`）。
  README 第 5907 行明确把 `||` 列为 OR 别名，`readme-audit` 有测试守着，
  属项目有意的设计选择（MySQL 模式）。字符串拼接请用 `CONCAT`。

- **`CHECK` 的条件语义**（写入时校验）目前表级列级都未实现 ——
  实际只是解析并跳过。`table.js` 的 `def.check` 期望函数，
  而 schema 需要可序列化，真正实现要动存储层，留作独立改动。

### 测试

14 个测试文件全绿（Windows + Linux/Node 24 双平台）：

```
sql-parser 249 | readme-audit 167 | btree 157 | query-opt 36 | regress 43
dml-constraints 18 | native 28 | multi-instance 20 | wasm 20 | wal-recovery 19
coverage 57 | join 12 | smoke
```

`examples/orms` 需要 `sequelize` / `knex` / `reflect-metadata` peer dep，
未安装时 3/3 FAILED，与本轮改动无关。

本轮所有语义判定均以 **Python sqlite3** 为标准答案逐条对照
（`'abc'+1=1`、`SIGN(-9)=-1`、`TIMESTAMPDIFF` 整月差、
`UPDATE` 主键冲突报错等），避免把「期望值写错」误判成「引擎有 bug」。

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

