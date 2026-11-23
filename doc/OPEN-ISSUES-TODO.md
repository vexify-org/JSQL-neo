# 开放 ISSUE 修复进度与待办清单

> 仓库：vexify-org/JSQL-neo · 统计时间：2026-11-22 · 当前版本：**v6.8.25**
>
> **GitHub 当前开放 ISSUE 为 0。** 84 个 issue 中 82 个已修复并关闭，2 个（#242 / #244）经 MySQL 8.0 官方语义确认属“非缺陷”，已注明理由后按 not planned 关闭。
>
> 说明：2026-11-23 起机器人已具备 issue 写权限，全部已修复 ISSUE 已通过 API 关闭。

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
| v6.8.20 | #296 | sqlite columns() 声明类型 |
| v6.8.20 | #297 | sqlite 空/空白 SQL 统一 no-op |
| v6.8.20 | #306 | MySQL ColumnDefinition schema 字段 |
| v6.8.20 | #279 | Mongo $push $position/$slice |
| v6.8.20 | #282 | Mongo $unwind 标量保留 |
| v6.8.21 | #271 | MySQL 列 flags |
| v6.8.21 | #275 | PG CancelRequest |
| v6.8.21 | #276 | PG Bind 参数个数校验 |
| v6.8.21 | #278 | Mongo find batchSize/getMore |
| v6.8.21 | #283 | Mongo 未知聚合 stage 报错 |
| v6.8.22 | #265 | sqlite 嵌套事务 SAVEPOINT |
| v6.8.22 | #267 | VARCHAR 按 code point 计长 |
| v6.8.22 | #273 | MySQL prepare 列元数据 |
| v6.8.22 | #294 | WASM stop/start 清理元数据 |
| v6.8.22 | #307 | MySQL COM_FIELD_LIST |
| v6.8.23 | #258 | 标量子查询多行报 1242 |
| v6.8.23 | #293 | JSON 聚合 |
| v6.8.23 | #298 | TUI emoji 宽度 |
| v6.8.23 | #299 | TUI 转义引号 |
| v6.8.23 | #300 | TUI 历史文件 |
| v6.8.24 | #247 | WASM 回退持久化 |
| v6.8.24 | #277 | PG 二进制结果格式 |
| v6.8.24 | #295 | 默认文件锁 |
| v6.8.25 | #322 | CASE 子表达式 |
| v6.8.25 | #323 | 窗口表达式 |
| v6.8.25 | #324 | YEARWEEK 默认 mode |
| v6.8.25 | #325 | DECIMAL 负数舍入 |

---

## 二、待办（35 个）

### A. 数据正确性 / 静默错误（优先级最高）

| ISSUE | 严重度 | 摘要 | 涉及 |
|---|---|---|---|

### B. 约束 / DDL / 生命周期

| ISSUE | 严重度 | 摘要 | 涉及 |
|---|---|---|---|

### C. MySQL 线协议

| ISSUE | 严重度 | 摘要 | 涉及 |
|---|---|---|---|

### D. PostgreSQL 线协议

| ISSUE | 严重度 | 摘要 | 涉及 |
|---|---|---|---|

### E. MongoDB

| ISSUE | 严重度 | 摘要 | 涉及 |
|---|---|---|---|

### F. TUI

| ISSUE | 严重度 | 摘要 | 涉及 |
|---|---|---|---|

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
| `test/issue-279-306.test.js` | #279 #282 #296 #297 #306 |
| `test/issue-271-283.test.js` | #271 #275 #276 #278 #283 |
| `test/issue-265-307.test.js` | #265 #267 #273 #294 #307 |
| `test/issue-258-300.test.js` | #258 #293 #298 #299 #300 |
| `test/issue-247-295-277.test.js` | #247 #277 #295 |
| `test/issue-322-325.test.js` | #322 #323 #324 #325 |

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
