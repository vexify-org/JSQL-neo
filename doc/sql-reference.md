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
ALTER TABLE users ADD COLUMN phone TEXT;
ALTER TABLE users DROP COLUMN phone;
ALTER TABLE users RENAME TO old_users;
```

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
