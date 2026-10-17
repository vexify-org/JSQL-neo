# SQL 参考

## DDL

```sql
-- 创建表
CREATE TABLE users (
  id INT PRIMARY KEY AUTO_INCREMENT,
  name TEXT NOT NULL,
  email TEXT UNIQUE,
  age INT DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 创建表（带索引）
CREATE TABLE orders (
  id INT PRIMARY KEY,
  user_id INT,
  total DECIMAL(10,2),
  INDEX idx_user (user_id),
  UNIQUE INDEX idx_email (email)
);

DROP TABLE IF EXISTS users;
TRUNCATE TABLE users;

-- 改表
ALTER TABLE users ADD COLUMN phone TEXT;
ALTER TABLE users DROP COLUMN phone;
ALTER TABLE users RENAME TO old_users;
ALTER TABLE users RENAME COLUMN phone TO mobile;
ALTER TABLE users DROP INDEX idx_user;
```

### 标识符与保留字

MySQL 里属于**非保留**的关键字可以直接当表名/列名，不必加反引号：

```sql
CREATE TABLE events (
  id INT PRIMARY KEY,
  date DATE,          -- date / text / count / engine / first / after …
  text TEXT,          -- 这些都不是保留字
  count INT
);
SELECT date, count FROM events WHERE date = '2026-01-01';
```

真正的保留字（`key` / `order` / `group` / `index` / `column` / `table` /
`case` / `when` / `end` / `select` / `from` …）仍须用反引号：

```sql
CREATE TABLE t (`key` TEXT, `order` INT);
SELECT `key`, `order` FROM t;
```

> 标识符区分大小写：建了 `myCol` 就要写 `myCol`，写 `mycol` 取不到值。

## DML

```sql
-- 插入
INSERT INTO users (name, age) VALUES ('Alice', 30);
INSERT INTO users (name) VALUES ('Bob'), ('Carol');
INSERT INTO users SET name = 'Dave', age = 25;

-- 更新
UPDATE users SET age = 31 WHERE id = 1;
UPDATE users SET age = age + 1 WHERE name = 'Alice';

-- 删除
DELETE FROM users WHERE id = 2;
DELETE FROM users WHERE age < 18;
```

## 查询

```sql
-- 基础查询
SELECT * FROM users WHERE age >= 18 ORDER BY name LIMIT 10;
SELECT id, name, email FROM users WHERE id > 5;

-- 聚合
SELECT COUNT(*) AS total, AVG(age), SUM(salary), MAX(age), MIN(age) FROM users;
SELECT status, COUNT(*) FROM users GROUP BY status HAVING COUNT(*) > 1;

-- 条件
SELECT * FROM users WHERE name LIKE 'A%';
SELECT * FROM users WHERE id IN (1, 2, 3);
SELECT * FROM users WHERE age BETWEEN 18 AND 65;
```

## 高级

```sql
-- JOIN
SELECT u.name, o.total FROM users u JOIN orders o ON u.id = o.user_id;
SELECT * FROM t1 LEFT JOIN t2 ON t1.id = t2.t1_id;

-- 子查询
SELECT * FROM users WHERE id IN (SELECT user_id FROM orders WHERE total > 100);

-- CTE（公用表表达式）
WITH active_users AS (
  SELECT * FROM users WHERE status = 'active'
)
SELECT * FROM active_users WHERE age > 30;

-- 递归 CTE
WITH RECURSIVE cnt(x) AS (
  SELECT 1 UNION ALL SELECT x + 1 FROM cnt WHERE x < 10
)
SELECT x FROM cnt;

-- 窗口函数
SELECT name, salary,
  RANK() OVER (ORDER BY salary DESC) as rank,
  AVG(salary) OVER (PARTITION BY dept) as dept_avg
FROM employees;

-- JSON
SELECT json_extract(data, '$.name');
SELECT data->>'$.name' FROM t;
```

## 事务与保存点

```sql
BEGIN;
INSERT INTO users (id, name) VALUES (1, 'a');

SAVEPOINT after_first;      -- 记一个可回滚的位置
INSERT INTO users (id, name) VALUES (2, 'b');
UPDATE users SET name = 'B' WHERE id = 1;

ROLLBACK TO SAVEPOINT after_first;   -- 只撤销保存点之后的改动，事务继续
INSERT INTO users (id, name) VALUES (3, 'c');
COMMIT;
```

`ROLLBACK TO` 只回滚到保存点，**事务本身继续有效** —— 这与 `ROLLBACK` 不同，
后者会放弃整个事务。

| 语句 | 作用 |
| --- | --- |
| `SAVEPOINT <名字>` | 建立保存点 |
| `ROLLBACK TO [SAVEPOINT] <名字>` | 回滚到保存点，事务继续；该保存点保留可再次回滚 |
| `RELEASE SAVEPOINT <名字>` | 释放保存点（含其后建立的），**不还原数据** |

几条行为约定：

- 保存点只在事务内有效，`COMMIT` / `ROLLBACK` 时全部释放
- 回滚到外层保存点会一并丢弃其内层保存点（标准 SQL 行为）
- 同名保存点会覆盖旧的，它之后的保存点一并作废
- 保存点之后新建的表，回滚时会被删掉
- 自增计数器一并回退，回滚掉的号会被下次插入重用
- 名字不区分大小写，`ROLLBACK TO SAVEPOINT` 里的 `SAVEPOINT` 可以省略

> **引擎支持**：保存点需要引擎做行级快照。内置的 `Database` 引擎
> （`require('jsql-neo').Database`）完整支持；`JSQL`（wasm）与 `NativeJSQL`
> 的事务在 Rust 侧，目前还没有保存点 —— 那两个引擎上执行保存点语句会
> 明确报错，不会假装成功。

## 函数

### 字符串

```sql
SELECT UPPER('aB'), LOWER('aB');            -- 'AB'  'ab'
SELECT LENGTH('中文'), CHAR_LENGTH('中文');  -- 2  2
SELECT TRIM('  x  '), REVERSE('abc');       -- 'x'  'cba'
SELECT SUBSTRING('abcdef', 2, 2);           -- 'bc'
SELECT LEFT('abcdef', 3), RIGHT('abcdef', 3);  -- 'abc'  'def'
SELECT REPLACE('aXbXc', 'X', '-');          -- 'a-b-c'
SELECT INSTR('abcabc', 'b');                -- 2
SELECT LOCATE('b', 'abcabc');               -- 2
SELECT LPAD('7', 3, '0'), RPAD('7', 3, '0');   -- '007'  '700'
SELECT REPEAT('ab', 3), SPACE(3);           -- 'ababab'  '   '
SELECT ASCII('A'), CHAR(65);                -- 65  'A'
SELECT FIELD('b', 'a', 'b', 'c');           -- 2（找不到为 0）
SELECT ELT(2, 'a', 'b', 'c');               -- 'b'
SELECT CONCAT('a', 'b');                    -- 'ab'
SELECT CONCAT_WS('-', 'a', NULL, 'b');      -- 'a-b'（跳过 NULL）
```

**NULL 传播**：所有标量函数遇到 NULL 一律返回 NULL —— 包括 `CONCAT`
（`CONCAT('a', NULL)` 是 NULL，不是 `'a'`）。`CONCAT_WS` 是例外：它跳过
值为 NULL 的参数，但分隔符为 NULL 时整体返回 NULL。

### 数值

```sql
SELECT ABS(-7), SIGN(-5);                   -- 7  -1
SELECT ROUND(2.5), ROUND(2.345, 2);         -- 3  2.35
SELECT CEIL(2.1), FLOOR(2.9);               -- 3  2
SELECT TRUNCATE(2.789, 2);                  -- 2.78（截断，不四舍五入）
SELECT MOD(7, 3), POWER(2, 10), SQRT(16);   -- 1  1024  4
```

### NULL 处理

```sql
SELECT COALESCE(NULL, NULL, 3);   -- 3；全为 NULL 时返回 NULL
SELECT IFNULL(NULL, 5);           -- 5
SELECT NULLIF(1, 1);              -- NULL
SELECT GREATEST(3, 1, 2);         -- 3
SELECT LEAST(3, 1, 2);            -- 1
```

`GREATEST` / `LEAST` 任一参数为 NULL 即返回 NULL（MySQL 语义）。
`COALESCE` 全部取不到值时返回 NULL，不会返回 `undefined`。

### 日期

```sql
SELECT YEAR('2026-03-04'), MONTH('2026-03-04'), DAY('2026-03-04');  -- 2026 3 4
SELECT DATEDIFF('2026-03-10', '2026-03-04');                        -- 6
SELECT DATE_ADD('2026-01-31', INTERVAL 1 MONTH);                    -- '2026-02-28'
SELECT LAST_DAY('2026-02-10');                                      -- '2026-02-28'
SELECT DATE_FORMAT('2026-03-04', '%Y/%m/%d');                       -- '2026/03/04'
SELECT TIMESTAMPDIFF(HOUR, '2026-01-01 00:00:00', '2026-01-01 05:00:00');  -- 5
```

### JSON

```sql
SELECT JSON_EXTRACT('{"a":{"b":2}}', '$.a.b');   -- 2
SELECT JSON_UNQUOTE('"hi"');                     -- 'hi'
SELECT JSON_TYPE('{"a":1}');                     -- 'object'
SELECT JSON_VALID('{bad');                       -- 0
SELECT JSON_ARRAY_LENGTH('[1,2,3]');             -- 3
```

`->` / `->>` 同时支持两种路径写法：

```sql
-- JSONPath（MySQL 风格）
SELECT d->>'$.name' FROM t;        -- 取文本
SELECT d->'$.addr.city' FROM t;    -- 取原值
SELECT d->>'$.arr[1]' FROM t;      -- 数组下标

-- 纯键名（Postgres 风格），可链式
SELECT d->>'name' FROM t;
SELECT d->'addr'->>'city' FROM t;
```

### 条件与比较

`IN` 遵循三值逻辑：列表里含 NULL 时，**只要有一个元素匹配就成立**；
没匹配上才是 UNKNOWN（在 `WHERE` 里被过滤掉）。

```sql
SELECT 10 IN (10, NULL);      -- 1（TRUE）
SELECT 99 IN (10, NULL);      -- NULL（UNKNOWN）
SELECT 99 NOT IN (10, NULL);  -- NULL（UNKNOWN，所以 WHERE 里一行都不返回）
```

## 索引

```sql
CREATE INDEX idx_name ON users(name);
CREATE UNIQUE INDEX idx_email ON users(email);
CREATE INDEX idx_composite ON orders(user_id, created_at DESC);
DROP INDEX idx_name ON users;

-- 索引提示
SELECT * FROM users USE INDEX (idx_name) WHERE name = 'Alice';
SELECT * FROM users FORCE INDEX (idx_name) WHERE age > 18;
```

详见完整 [README.md](../README.md)。
