? Language / 语言: **English** | [简体中文](cn/postgresql.md)

# PostgreSQL protocol support

## Supported clients

`pg` (node-postgres), `psql`, pgAdmin 4, DBeaver, TypeORM (postgres dialect), Prisma, Knex, PostgREST and more.

```js
const { Client } = require('pg');
const client = new Client({ host: '127.0.0.1', port: 5432, user: 'root', database: 'app' });
await client.connect();
const res = await client.query('SELECT * FROM users WHERE age > $1', [25]);
await client.end();
```

## Authentication (SCRAM-SHA-256)

Full **SCRAM-SHA-256** challenge-response authentication (RFC 5802):

1. Client sends `SASLInitialResponse` (username + client-first-message)
2. Server replies `SASLContinue` (server-first-message: salt + iteration count, i=4096)
3. Client sends `SASLResponse` (client-final-message containing the Proof)
4. Server verifies the Proof and sends `AuthenticationOk`

Plain-text password auth and noAuth mode are also supported. `psql` and `pg` use SCRAM by default, with no extra configuration needed.

```js
const { createPgServer } = require('jsql-neo');

createPgServer({
  port: 5432,
  auth: { 'jsql-admin': { password: 's3cret', databases: ['*'] } },
});
```

## Wire protocol v3 coverage

| Message | Direction | Description |
|---|---|---|
| StartupMessage | C→S | protocol 3.0, user/database |
| PasswordMessage / SASL | C→S | plain-text or SCRAM authentication |
| Query (`Q`) | C→S | simple query |
| Parse/Bind/Execute (`P`/`B`/`E`) | C→S | extended protocol (prepared statements) |
| Describe (`D`) | C→S | statement/portal description |
| Sync (`S`) / Flush (`H`) | C→S | synchronisation |
| Terminate (`X`) | C→S | disconnect |
| AuthenticationOk (`R`) | S→C | authentication succeeded |
| RowDescription (`T`) | S→C | result column info |
| DataRow (`D`) | S→C | data row (text/binary format) |
| CommandComplete (`C`) | S→C | `SELECT n` / `INSERT 0 n` … |
| ReadyForQuery (`I`) | S→C | transaction status `I`/`T`/`E` |
| ErrorResponse (`E`) | S→C | error (with SQLSTATE) |
| NoticeResponse / ParameterStatus / BackendKeyData | S→C | notice / parameter / cancel key |

Supported features: end-to-end extended protocol (`$1, $2` parameters), binary result format codes, `INSERT ... RETURNING`, `ON CONFLICT DO NOTHING/UPDATE`, `EmptyQueryResponse` for empty queries, and CancelRequest recognition (ignored — the engine executes immediately).

## PostgreSQL-specific syntax

| Syntax | Example |
|---|---|
| `SERIAL` / `BIGSERIAL` auto-increment | `id SERIAL PRIMARY KEY` |
| `ILIKE` case-insensitive match | `WHERE name ILIKE '%alice%'` |
| `ON CONFLICT (col) DO UPDATE SET ...` | `EXCLUDED` is available |
| `ON CONFLICT (col) DO NOTHING` | ignore conflicts |
| `RETURNING *` | return affected rows |
| JSONB `->` / `->>` | `SELECT data->>'name' FROM users` |
| `$1, $2` placeholders | prepared statements |
| double-quoted identifiers | `SELECT "Name" FROM t` |
| `::` casts | `SELECT '5'::INT` |
| `EXTRACT` / `AGE` / `TO_CHAR` | date functions |

```sql
BEGIN;
CREATE TABLE IF NOT EXISTS accounts (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  meta JSONB DEFAULT '{}'::jsonb
);
INSERT INTO accounts (name, email) VALUES ('Alice', 'a@x.com')
  ON CONFLICT (email) DO UPDATE SET meta = EXCLUDED.meta
  RETURNING *;
SELECT name, meta->>'plan' FROM accounts WHERE name ILIKE '%ali%';
COMMIT;
```

## SQLSTATE error mapping

| SQLSTATE | Meaning | Trigger |
|---|---|---|
| `42P01` | undefined_table | table does not exist |
| `42703` | undefined_column | column does not exist |
| `23505` | unique_violation | unique constraint violated |
| `23502` | not_null_violation | NOT NULL constraint violated |
| `23503` | foreign_key_violation | foreign key constraint violated |
| `22007` | invalid_datetime_format | malformed date |
| `42601` | syntax_error | SQL syntax error |
| `23000` | integrity_constraint_violation | generic constraint violation |
| `3D000` | invalid_catalog_name | database does not exist |
| `00000` | successful_completion | success |
| `28000` | invalid_authorization_specification | authentication failed |
| `28P01` | invalid_password | wrong password |

The mapping lives in `lib/pg_server.js` and decides using both the error message and the error code. Unmatched errors fall back to `XX000` / `42601`.

## FAQ

**Q: `psql` reports `no pg_hba.conf entry`?**

A: The server uses a built-in ACL rather than pg_hba.conf. Check the `auth` option or use `noAuth: true`.

**Q: Is the replication protocol / logical subscription supported?**

A: No (`START_REPLICATION`, logical slots). Regular queries, transactions and prepared statements all work.

**Q: Does `\dt` show nothing in psql?**

A: `\dt` relies on `pg_class` metadata. Use SQL directly:

```sql
SELECT * FROM information_schema.tables;
```
