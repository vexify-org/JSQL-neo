# 开放 ISSUE 修复进度与待办清单

> 仓库：vexify-org/JSQL-neo · 统计时间：2026-11-22 · 当前版本：**v6.8.19**
>
> **共 80 个开放 ISSUE，已修复 55 个，剩余 25 个。**
>
> 说明：本仓库的 GitHub App 集成只有代码写权限，没有 ISSUE 写权限
> （`issue_write` / `add_issue_comment` 均返回 `403 Resource not accessible by integration`），
> 因此**已修复的 ISSUE 无法由机器人关闭**，只能在此文档中登记状态。
> 请维护者按此表手工关闭对应 ISSUE。

---

## 一、已修复（45 个）

| 版本 | ISSUE | 摘要 |
|---|---|---|
| v6.8.9 | #314 | Redis `LPOP`/`RPOP` 的 count 参数严格整数校验 |
| v6.8.9 | #317 | REGEXP/RLIKE 非法正则归一为 SQL 错误（1139） |
| v6.8.9 | #318 | LPAD/RPAD 填充串为 NULL 时整体返回 NULL |
| v6.8.9 | #319 | `Cache` TTL 清理定时器 `unref()` |
| v6.8.9 | #321 | legacy 文件模式自动保存定时器 `unref()` |
| v6.8.10 | #312 | Mongo `$group` 补 `$push` / `$addToSet` 累加器 |
| v6.8.10 | #313 | Redis `EXPIRE` 支持 `NX`/`XX`/`GT`/`LT` |
| v6.8.10 | #315 | Mongo `listIndexes` 对不存在集合报 `nsNotFound`(26) |
| v6.8.10 | #316 | Mongo `find` 负 `limit` 按绝对值取单批 |
| v6.8.10 | #320 | `encryptKey` 长度按字节校验（16/24/32） |
| v6.8.11 | #243 | `CAST(... AS SIGNED/UNSIGNED)` 用 BigInt 精确解析 + 支持科学计数法 |
| v6.8.11 | #245 | UNIQUE / PK / 复合 UNIQUE 统一大小写不敏感口径 |
| v6.8.11 | #246 | 父表 `RENAME TO` 后重写子表外键引用；悬空引用不再静默放行 |
| v6.8.11 | #288 | `SUBSTRING(str, 负偏移越界)` 返回空串 |
| v6.8.11 | #289 | `INSERT(str,pos,len,newstr)` 按 code point 切分（emoji 不再劈开） |
| v6.8.12 | #284 | Mongo BSON 整数编 Int32/Int64（浮点才用 Double） |
| v6.8.12 | #285 | Mongo BSON Binary 只写 1 字节 subtype，往返不再损坏 |
| v6.8.12 | #290 | 位非 `~` 改用 64 位无符号语义（`~0` = 18446744073709551615） |
| v6.8.12 | #291 | `GROUP BY` / `PARTITION BY` 键按 SQL 类型归一（`1` 与 `'1'` 同组） |
| v6.8.12 | #292 | `ORDER BY` 混合 number/string 按数值比较（`'10'/2/'1'` → 1,2,10） |
| v6.8.13 | #301 | HTTP 客户端数据请求补超时（默认 30s，可配 `timeoutMs`） |
| v6.8.13 | #302 | NeDB 兼容层补 `removeIndex` / `getIndexes`（含 callback 签名） |
| v6.8.13 | #303 | 插件钩子返回值按 `PLUGINS.md` 契约写回参数 |
| v6.8.13 | #304 | `Cache.expire` 负数报 `invalid expire time` |
| v6.8.13 | #305 | 唯一冲突错误消息统一用 `ER_DUP_ENTRY` 模板拼装 |
| v6.8.14 | #248 | 批量 `ON DUPLICATE KEY UPDATE` 同键多行按行顺序累加（1+2+3=6） |
| v6.8.14 | #249 | `UPDATE t SET col = DEFAULT` 重置为列默认值 |
| v6.8.14 | #250 | `db.updateById()` 与 `db.update()` 走同一套约束校验（不再绕过 NOT NULL） |
| v6.8.14 | #251 | JS 建表 API 的字符串 `check: 'a > 0'` 真正生效 |
| v6.8.14 | #252 | `ADD COLUMN ... NOT NULL` 给存量行填类型隐式默认值 |
| v6.8.15 | #259 | 目录模式 `wal: true` 重开时回放 WAL（崩溃前的提交不再丢失） |
| v6.8.15 | #260 | 目录模式支持 `encryptKey` 静态加密（`.jsql` 数据块 + `meta.json`） |
| v6.8.15 | #262 | 表文件损坏显式报 `ER_TABLE_CORRUPT`，不再有「幽灵表」 |
| v6.8.15 | #263 | WAL 落盘失败通过 `error` 事件暴露并记入 `_walError` |
| v6.8.15 | #264 | sqlite 兼容层 `db.exec()` 支持多语句 |
| v6.8.16 | #255 | Mongo `insert` 尊重 `ordered` 选项（冲突后中止本批） |
| v6.8.16 | #256 | `FROM_UNIXTIME(NULL)` 返回 NULL |
| v6.8.16 | #257 | `UNIX_TIMESTAMP(NULL)` 返回 NULL |
| v6.8.16 | #266 | 列级 `DECIMAL(p,s)` 标度生效（精确舍入，无浮点误差） |
| v6.8.16 | #270 | 向整型列写小数按 MySQL 语义四舍五入（`1.9→2`、`-1.5→-2`） |
| v6.8.17 | #253 | `mysql_compat` 多语句返回**全部**结果集 |
| v6.8.17 | #254 | PG `Describe`/`Close` 语句名解析 off-by-one 修正 |
| v6.8.17 | #261 | 列存快路径 WHERE 补 SQL 三值逻辑，与行存路径逐项一致 |
| v6.8.17 | #268 | `AUTO_INCREMENT` 列插 `0`/`NULL` 由引擎分配序列值 |
| v6.8.17 | #269 | `INSERT IGNORE` 把可忽略错误降级为 warning，只跳过该行 |
| v6.8.18 | #286 | Redis `SET` 同时指定 `EX`/`PX` 报 syntax error |
| v6.8.18 | #287 | Redis ZSET 原型链名成员计数/存取正确 |
| v6.8.18 | #280 | Mongo `count` 支持 `skip` |
| v6.8.18 | #281 | Mongo `listIndexes` 保留索引方向 |
| v6.8.18 | #310 | PG 密码错误回 SQLSTATE `28P01` |
| v6.8.19 | #272 | MySQL 非法 COM_INIT_DB 回 ERR_Packet |
| v6.8.19 | #274 | MySQL errno/SQLSTATE 回退映射 |
| v6.8.19 | #308 | PG DDL CommandComplete tag |
| v6.8.19 | #309 | PG 无参 Describe paramCount=0 |
| v6.8.19 | #311 | PG BOOLEAN typlen=1 |

---

## 二、待办（35 个）

### A. 数据正确性 / 静默错误（优先级最高）

| ISSUE | 严重度 | 摘要 | 涉及 |
|---|---|---|---|
| #247 | P0 | WASM/JS 回退引擎下 `new JSQL({ path, mode:'disk' })` 完全不落盘：全程内存库，`stop()` 后目录为空，重开表都不存在 | `lib/client.js` |
| #295 | P0 | 同一文件路径打开两个实例（`fileLock` 默认关闭）：后保存者用全量快照覆盖前者，已提交到磁盘的行被静默删除，无锁、无告警 | `lib/database.js` |
| #258 | P1 | 标量子查询返回多行时静默取首行，未报 `ER_SUBSELECT_NO_1_ROW`(1242) | `lib/sql.js` |
| #293 | P1 | `JSON_ARRAYAGG` / `JSON_OBJECTAGG` 未按聚合求值，每组只取代表行的单个值 | `lib/sql.js` |
| #267 | P1 | `VARCHAR(n)` 的长度限制按 UTF-16 码元计数，6 个 emoji 被判超长 1406 | `lib/table.js` |

### B. 约束 / DDL / 生命周期

| ISSUE | 严重度 | 摘要 | 涉及 |
|---|---|---|---|
| #265 | P1 | sqlite 兼容层 `db.transaction()` 嵌套未用 SAVEPOINT：内层提交提前提交外层，外层回滚撤不掉内层写入 | `lib/sqlite_compat.js` |
| #294 | P1 | WASM 引擎 `stop()` 后再次 `start()`：底层已清空表，但 JS 侧 `_tableNames`/`_schemas` 残留，`getTables()` 返回幽灵表 | `lib/wasm_engine.js` |
| #296 | P3 | sqlite 兼容层 `statement.columns()` 的 type 恒为 TEXT，不反映声明类型 | `lib/sqlite_worker.js` |
| #297 | P3 | sqlite 兼容层纯空白 SQL 静默返回 `[]`，而空串会抛错，行为自相矛盾 | `lib/sqlite_compat.js` |

### C. MySQL 线协议

| ISSUE | 严重度 | 摘要 | 涉及 |
|---|---|---|---|
| #271 | P1 | `ColumnDefinition41` 的 flags 恒为 `0x0000`：PRIMARY KEY / NOT NULL / UNSIGNED / AUTO_INCREMENT 位全部未通告 | `lib/mysql_server.js` |
| #306 | P1 | `ColumnDefinition41` 的 schema（库名）字段被填成表名 | `lib/mysql_server.js` |
| #273 | P2 | `COM_STMT_PREPARE` 的列/参数元数据是占位：列名 `col1/col2`、参数名 `?`、类型全 VAR_STRING(253) | `lib/mysql_server.js` |

### D. PostgreSQL 线协议

| ISSUE | 严重度 | 摘要 | 涉及 |
|---|---|---|---|
| #307 | P2 | `COM_FIELD_LIST`(0x04) 未实现，回 `1105 Unsupported command: 4` | `lib/pg_server.js` |
| #275 | P2 | PostgreSQL CancelRequest（80877102）被当成非法协议版本，回 0A000 ErrorResponse | `lib/pg_server.js` |
| #276 | P2 | PG Bind 不校验参数个数与 `$n` 占位符数量，0 参数绑定含 `$1` 的语句不回 08P01 | `lib/pg_server.js` |
| #277 | P2 | PG Bind 尾部结果格式码段未解析：请求二进制结果仍回文本（RowDescription format=0） | `lib/pg_server.js` |

### E. MongoDB

| ISSUE | 严重度 | 摘要 | 涉及 |
|---|---|---|---|
| #278 | P2 | `find` 忽略 `batchSize`：firstBatch 全量返回、游标 id 恒 0，`getMore` 恒空批 | `lib/mongo_server.js` |
| #279 | P2 | `$push` 只认 `$each`：`$slice` 截断与 `$position` 插入位置被静默忽略 | `lib/mongo_server.js` |
| #282 | P2 | `$unwind` 把非数组的标量字段文档直接丢弃（官方语义应按单元素数组展开保留） | `lib/mongo_server.js` |
| #283 | P2 | 聚合管道未识别的 stage（如 `$addFields`）被静默跳过，文档原样透传不报错 | `lib/mongo_server.js` |

### F. TUI

| ISSUE | 严重度 | 摘要 | 涉及 |
|---|---|---|---|
| #298 | P3 | 宽度计算 `wswidth` 不覆盖 emoji 与宽符号，表格错位 | `lib/tui*.js` |
| #299 | P3 | 语句完整性检查不识别 `\'` 转义引号，平衡语句被判未闭合卡在续行 | `lib/tui*.js` |
| #300 | P3 | 历史文件名内嵌 pid，跨会话读不回且退出后残留 | `lib/tui*.js` |

---

## 三、已确认**不修改**（issue 描述与 MySQL 官方语义冲突）

这两条 issue 的「期望」与 MySQL 8.0 官方定义相反，现有实现符合官方语义，改动会引入回归。
建议在 GitHub 上关闭并注明依据。

| ISSUE | issue 的期望 | MySQL 8.0 官方定义 | 现有实现 |
|---|---|---|---|
| #242 | `LOG(100,10)` = 2（`LOG(X, B)`） | `LOG(B, X)` —— 首个参数是**底数**。`LOG(2,65536)` = 16 | `log(args[1]) / log(args[0])`，即 `LOG(B,X)`，**符合官方** |
| #244 | `INSERT('abc',0,2,'X')` = `'X'` | 「pos 不在字符串长度范围内时返回原串」，`pos=0` 返回 `'abc'` | `p < 1` 时返回原串，**符合官方** |

依据：
- MySQL 8.0 Reference Manual — 12.8.2 Mathematical Functions（`LOG(X)` / `LOG(B, X)`）
- MySQL 8.0 Reference Manual — 13.6.4 String Functions（`INSERT(str,pos,len,newstr)`）

---

## 四、修复节奏与工程约定

### 发版节奏
每 5 个 ISSUE 一批，每批：
1. 修复 + 补回归测试（`test/issue-<范围>.test.js`）
2. 跑全量 `npm test`（当前基线：**1713 项 0 失败**）
3. `node scripts/release.js <版本>` + `npm run check:release` + commit + tag + push

### 新增回归测试文件
| 文件 | 覆盖 ISSUE |
|---|---|
| `test/issue-314-321.test.js` | #314 #317 #318 #319 #321 |
| `test/issue-312-320.test.js` | #312 #313 #315 #316 #320 |
| `test/issue-243-289.test.js` | #243 #245 #246 #288 #289 |
| `test/issue-284-292.test.js` | #284 #285 #290 #291 #292 |
| `test/issue-301-305.test.js` | #301 #302 #303 #304 #305 |
| `test/issue-248-252.test.js` | #248 #249 #250 #251 #252 |
| `test/issue-259-264.test.js` | #259 #260 #262 #263 #264 |
| `test/issue-255-270.test.js` | #255 #256 #257 #266 #270 |
| `test/issue-253-269.test.js` | #253 #254 #261 #268 #269 |
| `test/issue-280-310.test.js` | #280 #281 #286 #287 #310 |
| `test/issue-272-311.test.js` | #272 #274 #308 #309 #311 |

### 编码约定（踩坑记录）
- **工作区是 CRLF**（`core.autocrlf=true`）：用字面量 `'\n'` 匹配文件内容的替换会静默失配。
  正则一律写 `\r?\n`；构造失败时必须显式抛错，不能让「反例没构造出来 → 断言假绿」。
- **`const` 有 TDZ**：模块级常量若被文件前部的函数引用，必须提前声明。
- **BigInt 返回类型**：CAST / 位运算改用 BigInt 后，小值会变成字符串，需在安全整数范围内转回 `Number`。
- **插件钩子写回**：返回值写回时，若原参数是数组而返回值是标量，会把数组参数替换成标量
  → 调用方 `arr.map` 崩溃。写回规则必须是「原参数是数组 → 只接受数组返回值」。
- **错误码形态**：`JSQL_Error.code` 是**数字** errno（如 3819），不是字符串 `ER_XXX`；
  判定可忽略错误时两种形态都要兼容。

### 原则
- 绝不静默降级：能修就修；不能修就显式报错 / 发事件，绝不静默吞掉。
- 约束口径统一：唯一性、等值比较必须用同一套折叠键（`uniqueCompareKey`）。
- 类型归一统一：分组键、排序键、比较器共用 `sqlNumericCoerce` / `sqlGroupKeyNormalize`。
