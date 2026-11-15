# 列存（一键转换）

> 对应版本 **v6.7.0**。列存是**进程内的查询加速视图**，不是磁盘存储格式。

## 一键转换

```js
const { Database } = require('jsql-neo');
const db = new Database('./data/app.json');
await db.loadDatabase();

db.convertToColumnar('events');
// → { table: 'events', engine: 'columnar', rows: 100000, columns: 4 }

db.convertToRow('events');       // 转回行存
db._tables.events.isColumnar();  // true / false
```

不用建索引、不用改查询：转换后同一条 `SELECT` 自动走列存。

## 快路径覆盖哪些查询

列存有三条快路径，都是「按列扫、不建行对象」。命中条件如下（全部从严设定，
任一不满足退回通用行路径 —— 快路径只允许更快，不允许改变结果）：

| 路径 | 命中条件 |
| --- | --- |
| **扫描 / 投影** | 单表；无 `WHERE` / `GROUP BY` / `HAVING` / `DISTINCT`；投影是简单列引用或 `*`；若带 `ORDER BY`，必须是**单键 + 带 LIMIT**；库里没有 `beforeFind` / `afterFind` 钩子 |
| **聚合** | 单表、无 `JOIN`；投影**全部**是 `COUNT` / `SUM` / `AVG` / `MIN` / `MAX`；无 `HAVING` / `DISTINCT` / `LIMIT` |
| **GROUP BY** | 单表；分组键 1~N 列；投影 = 分组列 + 聚合；无 `HAVING` / `DISTINCT`；`ORDER BY` 至多单键且按输出列；支持 `LIMIT` / `OFFSET` |

`WHERE` 支持 `列 OP 字面量`、`IN` / `NOT IN`、`BETWEEN` / `NOT BETWEEN`、
`IS [NOT] NULL`，及其 `AND` / `OR` 嵌套组合。参与值为 `NULL` 时按 SQL
三值逻辑处理（`NULL IN (...)`、`NULL BETWEEN` 都算不命中）。

`ORDER BY ... LIMIT` 的扫描路径只排索引数组、只物化前 K 行；同值用原始下标
决胜，等价于 `Array.prototype.sort` 的稳定语义，结果与「全排序后切片」逐字节一致。

### 会主动退回通用路径的情况

- 表里有 `NULL` 分组键 —— `String(null) === 'null'` 会把 `NULL` 组和字符串
  `'null'` 组错并成一组；
- `COUNT(DISTINCT x)` / `SUM(DISTINCT x)`；
- 非简单列引用（`SUM(a + b)`）；
- `GROUP BY ... ORDER BY` 多键、或排序键不在输出列里；
- 列存表参与 `JOIN`（整条查询走行路径）；
- 注册了 find 钩子。

## 适用场景与限制

**适合**：批量导入 → 转换 → 反复扫描 / 聚合（读多写少的 OLAP 场景、长驻服务）。

| 限制 | 原因 |
| --- | --- |
| 任何写入都会让列存失效 | `_rows` 是唯一权威数据，列存只是派生缓存。写入后自动回退行存，需要重新转换 —— 这样绝不会读到两份不一致的数据。 |
| 不落盘 | 列存不写进 `db.json`。进程重启后需要重新 `convertToColumnar`。 |
| `JOIN` 不吃红利 | 列存表参与 JOIN 时整条查询退回行路径。这是 6.7.0 的已知缺口。 |
| 有 find 钩子时扫描路径不启用 | 避免 `beforeFind` / `afterFind` 静默不触发。 |

## 基准：与 DuckDB 的真实对比

同一份 10 万行 × 4 列数据、同样的查询，各 5~10 次取均值（Windows / Node 22，单进程内）：

| 查询 | jsql 行存 | jsql 列存 | DuckDB | 对比 |
| --- | --- | --- | --- | --- |
| `SELECT id LIMIT 10` | 1.8ms | **0.1ms** | 0.6ms | 快 5.8x |
| `SELECT id`（10 万行） | 34.2ms | **26.3ms** | 70.3ms | 快 2.7x |
| `SELECT * LIMIT 10` | 3.7ms | **0.1ms** | 0.5ms | 快 6.5x |
| `SUM(score)` | 29.0ms | **2.6ms** | 0.5ms | 慢 4.7x |
| `COUNT(*) WHERE age>30` | 30.6ms | **1.0ms** | 0.5ms | 慢 2.0x |
| `GROUP BY age` | 57.6ms | **5.6ms** | 0.9ms | 慢 6.2x |
| `ORDER BY age LIMIT 10` | 32.2ms | **11.7ms** | — | 列存内部 2.7x |

**结论要分开看**：

- **小结果 / 点查**：jsql 更快（2.7~6.5x）。进程内、无 SQL 执行引擎的固定开销；
  DuckDB 每次查询都有解析与调度成本。
- **聚合 / 分组**：仍慢 **2~6x**。相比 6.7.0 之前（36~70x）已收窄一个数量级，
  但 **没有超越 DuckDB，也不宣称超越** —— 对方是原生向量化引擎。
- **JOIN 后聚合**：未优化，整条走行路径，差距比表内聚合更大。
- 剩余差距主要在分组分桶的分配与浮点循环的 JIT 效率；继续压需要更底层的实现。

复现：`npm i duckdb --no-save && node scripts/bench-columnar.js`
（duckdb 为可选依赖，未装时只报 jsql 两侧数字）。
