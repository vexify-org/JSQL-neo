# Changelog

All notable changes to **JSQL-NEO** are documented here.
Format: [Keep a Changelog](https://keepachangelog.com) — **Added** / **Changed** / **Fixed** / **Breaking**.
SemVer applies: versions 0.x/3.x-beta are pre-1.0; from 4.0.0 onward the public API is stable.

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

### TODO（6.0.0-beta1 未完成项，留待后续）

- **WASM 二进制尚未用新核心重新编译**：`wasm/jsql_neo_wasm_bg.wasm` 仍是旧产物，
  模糊查询（`$like` / `$regex`）在 WASM 引擎下仍会失效；native 引擎已修复。
  工具链已就绪（`wasm32-unknown-unknown` + `wasm-bindgen 0.2.126`），
  发布前需执行：`cargo build --release --target wasm32-unknown-unknown`，
  再以 `--target nodejs`（→ `jsql_neo_wasm.js`）与 `--target web`（→ `browser_bg.mjs`）
  各生成一次并替换 `wasm/` 下的产物。
- **`Database`（JS 引擎）的 `use()` 尚未透传第二参数 `opts`**：native / WASM 已支持
  `db.use('validation', {...})`，JS 引擎暂只支持 `db.use('validation')`，需补齐签名。
- **native 引擎单行 `insert` 不触发 `afterInsert` 钩子**（既有行为）：仅在批量
  （`arr.length > 1`）分支调用，导致 `metrics` / `audit` 等插件漏记单行插入，需统一。
- **内置插件字段需显式建表**：native 引擎只落库 schema 中声明的列，
  `timestamps` 等插件写入的字段必须在 `createTable` 的 schema 里声明才会持久化。

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
