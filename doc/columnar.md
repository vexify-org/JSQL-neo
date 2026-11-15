# 列存（一键转换）

> 对应版本 **v6.6.6+**。列存是**进程内的查询加速视图**，不是磁盘存储格式。

## 一键转换

```js
const { Database } = require('jsql-neo');
const db = new Database('./data/app.json');
await db.loadDatabase();

// 一键：按字段拆成「每列一个数组」
db.convertToColumnar('events');
// → { table: 'events', engine: 'columnar', rows: 100000, columns: 4 }

db.convertToRow('events');   // 转回行存
db._tables.events.isColumnar();  // true / false
```

不需要建索引、不需要改查询：转换后同一条 `SELECT` 自动走列存路径。

## 它到底加速了什么

列存快路径只在同时满足以下条件时启用：

- 表已转换；
- 单表、无 `WHERE` / `JOIN` / `GROUP BY` / `HAVING` / `ORDER BY` / `DISTINCT`；
- 投影是**简单列引用**（`SELECT a, b` 或 `SELECT *`，不含表达式 / 聚合 / 窗口）；
- 该库没有注册 `beforeFind` / `afterFind` 钩子（否则列存路径会绕过它们）。

命中时直接按列取值，**跳过未选中的列**，也避开 `find()` 对整行对象的全量克隆。

## 适用场景与限制

**适合**：批量导入 → 转换 → 反复扫描 / 点查（读多写少的 OLAP 场景、长驻服务）。

**限制（都是刻意取舍，不是遗漏）**：

| 限制 | 原因 |
| --- | --- |
| 任何写入都会让列存失效 | `_rows` 是唯一权威数据，列存只是派生缓存。写入后自动回退行存，需要重新转换 —— 这样绝不会读到两份不一致的数据。 |
| 不落盘 | 列存不写进 `db.json`。进程重启后需要重新 `convertToColumnar`。 |
| 聚合不吃列存红利 | `SUM` / `COUNT` / `GROUP BY` 仍走通用行路径，只享受不到「跳过未选中列」。见下面的基准。 |
| 有 find 钩子时不启用 | 避免 `beforeFind` / `afterFind` 静默不触发。 |

## 基准：与 DuckDB 的真实对比

同一份 10 万行 × 4 列数据，同样的查询，各跑 5 次取均值（Windows / Node 22，单进程内）：

| 查询 | jsql 行存 | jsql 列存 | DuckDB | 对比 |
| --- | --- | --- | --- | --- |
| `SELECT id LIMIT 10` | 2.5ms | **0.1ms** | 0.5ms | 快 3.9x |
| `SELECT id`（10 万行） | 35.3ms | **25.8ms** | 70.3ms | 快 2.7x |
| `SELECT * LIMIT 10` | 1.7ms | **0.1ms** | 0.4ms | 快 6.4x |
| `SUM(score)` | 26.7ms | 29.4ms | **0.8ms** | 慢 36x |
| `COUNT(*) WHERE age>30` | 27.3ms | 30.1ms | **0.6ms** | 慢 53x |
| `GROUP BY age` | 64.1ms | 51.0ms | **0.7ms** | 慢 70x |

**结论要分开看**：

- **小结果 / 点查**：jsql 更快（2.7~6.4x）。原因是进程内、无 SQL 执行引擎的固定开销；DuckDB 每次查询都有解析与调度成本。
- **全表聚合 / 分组**：jsql 慢 36~70x。DuckDB 是向量化执行的原生引擎，这一项**短期内追不上**，也不该宣称能追上。
- 列存的聚合数字（29.4 / 30.1 / 51.0）目前**不比行存快** —— 因为聚合还没接列路径，只是多了一层判定。这是已知待办，不当作成果。

复现：`node scripts/bench-columnar.js`（需先 `npm i duckdb --no-save`；缺失时脚本只报 jsql 数字）。
