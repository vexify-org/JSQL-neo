? Language / 语言: **English** | [简体中文](cn/sql-reference.md)

# SQL Reference

> Applies to **v6.6.2**.
>
> Safety note: `executeSQL` safe mode (on by default) allows only **single** statements and
> rejects `DROP` / `TRUNCATE` / `DELETE` / `UPDATE` without a WHERE clause (including
> `WITH ... DELETE`). To write, pass `{ allowWrites: true }`, or disable safety checks
> with `{ safety: false }`. Protocol servers allow writes by default.

## DDL

```sql
-- Create a table
CREATE TABLE users (
  id INT PRIMARY KEY AUTO_INCREMENT,
  name TEXT NOT NULL,
  email TEXT UNIQUE,
  age INT DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Create a table with indexes
CREATE TABLE orders (
  id INT PRIMARY KEY,
  user_id INT,
  total DECIMAL(10,2)
);
CREATE INDEX idx_user ON orders(user_id);
CREATE UNIQUE INDEX idx_email ON orders(email);

-- Alter a table
ALTER TABLE users ADD COLUMN phone TEXT;
ALTER TABLE users RENAME COLUMN phone TO mobile;
ALTER TABLE users DROP COLUMN mobile;
ALTER TABLE orders DROP INDEX idx_user;
ALTER TABLE users RENAME TO people;

-- Truncate / drop
TRUNCATE TABLE people;
DROP TABLE IF EXISTS people;
DROP TABLE IF EXISTS orders;
```

### Identifiers and reserved words

Keywords that are **non-reserved** in MySQL can be used directly as table or column names, no backticks required:

```sql
CREATE TABLE events (
  id INT PRIMARY KEY,
  date DATE,          -- date / text / count / engine / first / after …
  text TEXT,          -- none of these are reserved
  count INT
);
SELECT date, count FROM events WHERE date = '2026-01-01';
```

Genuinely reserved words (`key` / `order` / `group` / `index` / `column` / `table` /
`case` / `when` / `end` / `select` / `from` …) still require backticks:

```sql
CREATE TABLE t (`key` TEXT, `order` INT);
SELECT `key`, `order` FROM t;
```

> Identifiers are case-sensitive: if you create `myCol`, you must write `myCol` — `mycol` will not resolve.

## DML

```sql
-- Insert
INSERT INTO users (name, age) VALUES ('Alice', 30);
INSERT INTO users (name) VALUES ('Bob'), ('Carol');
INSERT INTO users (name, age) VALUES ('Dave', 25);

-- Update
UPDATE users SET age = 31 WHERE id = 1;
UPDATE users SET age = age + 1 WHERE name = 'Alice';

-- Delete
DELETE FROM users WHERE id = 2;
DELETE FROM users WHERE age < 18;
```

## Queries

```sql
-- Basic queries
SELECT * FROM users WHERE age >= 18 ORDER BY name LIMIT 10;
SELECT id, name, email FROM users WHERE id > 5;

-- Aggregation
SELECT COUNT(*) AS total, AVG(age), SUM(salary), MAX(age), MIN(age) FROM users;
SELECT status, COUNT(*) FROM users GROUP BY status HAVING COUNT(*) > 1;

-- Predicates
SELECT * FROM users WHERE name LIKE 'A%';
SELECT * FROM users WHERE id IN (1, 2, 3);
SELECT * FROM users WHERE age BETWEEN 18 AND 65;
```

## Advanced

```sql
-- JOIN
SELECT u.name, o.total FROM users u JOIN orders o ON u.id = o.user_id;
SELECT * FROM t1 LEFT JOIN t2 ON t1.id = t2.t1_id;

-- Subqueries
SELECT * FROM users WHERE id IN (SELECT user_id FROM orders WHERE total > 100);

-- CTE (common table expressions)
WITH active_users AS (
  SELECT * FROM users WHERE status = 'active'
)
SELECT * FROM active_users WHERE age > 30;

-- Recursive CTE
WITH RECURSIVE cnt(x) AS (
  SELECT 1 UNION ALL SELECT x + 1 FROM cnt WHERE x < 10
)
SELECT x FROM cnt;

-- Window functions
SELECT name, salary,
  RANK() OVER (ORDER BY salary DESC) as rank,
  AVG(salary) OVER (PARTITION BY dept) as dept_avg
FROM employees;

-- JSON
SELECT json_extract(data, '$.name') FROM t;
SELECT data->>'$.name' FROM t;
```

## Transactions and savepoints

```sql
BEGIN;
INSERT INTO users (id, name) VALUES (1, 'a');

SAVEPOINT after_first;      -- mark a rollback point
INSERT INTO users (id, name) VALUES (2, 'b');
UPDATE users SET name = 'B' WHERE id = 1;

ROLLBACK TO SAVEPOINT after_first;   -- undo only what came after the savepoint; the transaction continues
INSERT INTO users (id, name) VALUES (3, 'c');
COMMIT;
```

`ROLLBACK TO` rolls back only to the savepoint and **keeps the transaction alive** — unlike
`ROLLBACK`, which abandons the whole transaction.

| Statement | Effect |
| --- | --- |
| `SAVEPOINT <name>` | create a savepoint |
| `ROLLBACK TO [SAVEPOINT] <name>` | roll back to the savepoint and continue; the savepoint remains available |
| `RELEASE SAVEPOINT <name>` | release the savepoint (and any created after it), **without restoring data** |

Behavioural notes:

- Savepoints are valid only inside a transaction; all are released on `COMMIT` / `ROLLBACK`
- Rolling back to an outer savepoint discards the inner savepoints with it (standard SQL behaviour)
- A savepoint with the same name replaces the old one, and any savepoints after it are invalidated
- Tables created after a savepoint are dropped when you roll back to it
- Auto-increment counters roll back too; the discarded numbers are reused by the next insert
- Names are case-insensitive, and the `SAVEPOINT` keyword in `ROLLBACK TO SAVEPOINT` may be omitted

> **Engine support**: savepoints require row-level snapshots. The built-in `Database` engine
> (`require('jsql-neo').Database`) fully supports them; `JSQL` (wasm) and `NativeJSQL` keep
> transactions on the Rust side and do not yet have savepoints — on those engines savepoint
> statements fail explicitly rather than pretending to succeed.

## Functions

### Strings

```sql
SELECT UPPER('aB'), LOWER('aB');            -- 'AB'  'ab'
SELECT LENGTH('中文'), CHAR_LENGTH('中文');  -- 6  2 (LENGTH/OCTET_LENGTH are UTF-8 byte counts)
SELECT TRIM('  x  '), REVERSE('abc');       -- 'x'  'cba'
SELECT SUBSTRING('abcdef', 2, 2);           -- 'bc'
SELECT LEFT('abcdef', 3), RIGHT('abcdef', 3);  -- 'abc'  'def'
SELECT REPLACE('aXbXc', 'X', '-');          -- 'a-b-c'
SELECT INSTR('abcabc', 'b');                -- 2
SELECT LOCATE('b', 'abcabc');               -- 2
SELECT LPAD('7', 3, '0'), RPAD('7', 3, '0');   -- '007'  '700'
SELECT REPEAT('ab', 3), SPACE(3);           -- 'ababab'  '   '
SELECT ASCII('A'), CHAR(65);                -- 65  'A'
SELECT FIELD('b', 'a', 'b', 'c');           -- 2 (0 when not found)
SELECT ELT(2, 'a', 'b', 'c');               -- 'b'
SELECT CONCAT('a', 'b');                    -- 'ab'
SELECT CONCAT_WS('-', 'a', NULL, 'b');      -- 'a-b' (NULLs skipped)
```

**NULL propagation**: all scalar functions return NULL when given NULL — including `CONCAT`
(`CONCAT('a', NULL)` is NULL, not `'a'`). `CONCAT_WS` is the exception: it skips NULL
arguments, but returns NULL as a whole if the separator is NULL.

### Numbers

```sql
SELECT ABS(-7), SIGN(-5);                   -- 7  -1
SELECT ROUND(2.5), ROUND(2.345, 2);         -- 3  2.35
SELECT CEIL(2.1), FLOOR(2.9);               -- 3  2
SELECT TRUNCATE(2.789, 2);                  -- 2.78 (truncated, not rounded)
SELECT MOD(7, 3), POWER(2, 10), SQRT(16);   -- 1  1024  4
```

### NULL handling

```sql
SELECT COALESCE(NULL, NULL, 3);   -- 3; NULL when every argument is NULL
SELECT IFNULL(NULL, 5);           -- 5
SELECT NULLIF(1, 1);              -- NULL
SELECT GREATEST(3, 1, 2);         -- 3
SELECT LEAST(3, 1, 2);            -- 1
```

`GREATEST` / `LEAST` return NULL if any argument is NULL (MySQL semantics). `COALESCE`
returns NULL when no argument yields a value — never `undefined`.

### Dates

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

`->` / `->>` accept both path styles:

```sql
-- JSONPath (MySQL style)
SELECT d->>'$.name' FROM t;        -- text value
SELECT d->'$.addr.city' FROM t;    -- raw value
SELECT d->>'$.arr[1]' FROM t;      -- array index

-- Plain key names (Postgres style), chainable
SELECT d->>'name' FROM t;
SELECT d->'addr'->>'city' FROM t;
```

### Predicates and comparison

`IN` follows three-valued logic: when the list contains NULL, the result is TRUE if any
element matches; only when nothing matches is it UNKNOWN (filtered out in `WHERE`).

```sql
SELECT 10 IN (10, NULL);      -- 1 (TRUE)
SELECT 99 IN (10, NULL);      -- NULL (UNKNOWN)
SELECT 99 NOT IN (10, NULL);  -- NULL (UNKNOWN, so a WHERE clause returns no rows)
```

## Indexes

```sql
CREATE INDEX idx_name ON users(name);
CREATE UNIQUE INDEX idx_email ON users(email);
CREATE INDEX idx_composite ON orders(user_id, created_at);
DROP INDEX idx_name ON users;
```

> Indexes are built in ascending column order only; `(col DESC)` is not supported, nor are
> `USE INDEX` / `FORCE INDEX` hints. The optimizer picks the query plan automatically; use
> `EXPLAIN SELECT ...` to inspect it.

See the full [README.md](../README.md) for more.
