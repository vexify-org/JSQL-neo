/*
 * JSON function tests for JSQL-neo
 *   node test/json-functions.test.js
 * Covers: JSON_EXTRACT path fix, JSON_KEYS, JSON_LENGTH, JSON_MERGE,
 * JSON_MERGE_PATCH, JSON_MERGE_PRESERVE, JSON_OBJECTAGG, JSON_ARRAYAGG,
 * JSON_SET, JSON_INSERT, JSON_REMOVE, JSON_UNQUOTE, JSON_QUOTE,
 * JSON_TYPE, JSON_DEPTH, JSON_VALID, JSON_SEARCH
 */
const { executeSQL } = require('../lib/sql.js');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('[OK]', name); }
  else { fail++; console.log('[FAIL]', name, extra !== undefined ? '→ ' + JSON.stringify(extra) : ''); }
};

const engine = {
  hasTable: () => true,
  truncate: async () => {},
  flush: async () => {},
  find: async () => [],
  getTableSchema: async () => ({}),
};

// Helper: execute SQL and return first row as object
async function query(sql) {
  const r = await executeSQL(engine, sql);
  if (!r.rows || r.rows.length === 0) return null;
  const row = {};
  r.columns.forEach((col, i) => { row[col] = r.rows[0][i]; });
  return row;
}

(async () => {
  // ===== Bug 1: JSON_EXTRACT path parsing =====
  {
    const r1 = await query('SELECT JSON_EXTRACT(\'{"name":"test"}\', \'$.name\') AS val');
    ok('JSON_EXTRACT $.name returns "test"', r1 && r1.val === 'test', r1 && r1.val);

    const r2 = await query('SELECT JSON_EXTRACT(\'{"a":{"b":42}}\', \'$.a.b\') AS val');
    ok('JSON_EXTRACT $.a.b returns 42', r2 && r2.val === 42, r2 && r2.val);

    const r3 = await query('SELECT JSON_EXTRACT(\'{"items":[10,20,30]}\', \'$.items[1]\') AS val');
    ok('JSON_EXTRACT $.items[1] returns 20', r3 && r3.val === 20, r3 && r3.val);

    const r4 = await query('SELECT JSON_EXTRACT(\'{"name":"test"}\', \'$\') AS val');
    ok('JSON_EXTRACT $ returns whole object', r4 && typeof r4.val === 'object' && r4.val.name === 'test', r4 && r4.val);

    const r5 = await query('SELECT JSON_EXTRACT(\'{"name":"test"}\', \'$.nonexistent\') AS val');
    ok('JSON_EXTRACT $.nonexistent returns null', r5 && (r5.val === null || r5.val === undefined), r5 && r5.val);
  }

  // ===== JSON_KEYS =====
  {
    const r = await query('SELECT JSON_KEYS(\'{"a":1,"b":2,"c":3}\') AS val');
    ok('JSON_KEYS returns all keys', r && Array.isArray(r.val) && r.val.length === 3 && r.val.includes('a') && r.val.includes('b') && r.val.includes('c'), r && r.val);
  }

  // ===== JSON_LENGTH =====
  {
    const r1 = await query('SELECT JSON_LENGTH(\'{"a":1,"b":2,"c":3}\') AS val');
    ok('JSON_LENGTH object returns 3', r1 && r1.val === 3, r1 && r1.val);

    const r2 = await query('SELECT JSON_LENGTH(\'[1,2,3,4,5]\') AS val');
    ok('JSON_LENGTH array returns 5', r2 && r2.val === 5, r2 && r2.val);

    const r3 = await query('SELECT JSON_LENGTH(\'{"a":{"b":1,"c":2}}\', \'$.a\') AS val');
    ok('JSON_LENGTH with path returns 2', r3 && r3.val === 2, r3 && r3.val);
  }

  // ===== JSON_MERGE_PRESERVE =====
  {
    const r = await query('SELECT JSON_MERGE_PRESERVE(\'{"a":1}\', \'{"b":2}\') AS val');
    ok('JSON_MERGE_PRESERVE merges objects', r && typeof r.val === 'object' && r.val.a === 1 && r.val.b === 2, r && r.val);
  }

  // ===== JSON_MERGE_PATCH =====
  {
    const r = await query('SELECT JSON_MERGE_PATCH(\'{"a":1,"b":2}\', \'{"b":99,"c":3}\') AS val');
    ok('JSON_MERGE_PATCH patches objects', r && typeof r.val === 'object' && r.val.a === 1 && r.val.b === 99 && r.val.c === 3, r && r.val);
  }

  // ===== JSON_OBJECTAGG =====
  {
    const r = await query('SELECT JSON_OBJECTAGG(\'key\', \'value\') AS val');
    ok('JSON_OBJECTAGG creates object', r && typeof r.val === 'object' && r.val.key === 'value', r && r.val);
  }

  // ===== JSON_ARRAYAGG =====
  {
    const r = await query('SELECT JSON_ARRAYAGG(42) AS val');
    ok('JSON_ARRAYAGG creates array', r && Array.isArray(r.val) && r.val.length === 1 && r.val[0] === 42, r && r.val);
  }

  // ===== JSON_SET =====
  {
    const r = await query('SELECT JSON_SET(\'{"a":1}\', \'$.b\', 2) AS val');
    ok('JSON_SET adds new key', r && typeof r.val === 'object' && r.val.a === 1 && r.val.b === 2, r && r.val);

    const r2 = await query('SELECT JSON_SET(\'{"a":1}\', \'$.a\', 99) AS val');
    ok('JSON_SET updates existing key', r2 && typeof r2.val === 'object' && r2.val.a === 99, r2 && r2.val);
  }

  // ===== JSON_INSERT =====
  {
    const r = await query('SELECT JSON_INSERT(\'{"a":1}\', \'$.b\', 2) AS val');
    ok('JSON_INSERT adds new key', r && typeof r.val === 'object' && r.val.a === 1 && r.val.b === 2, r && r.val);

    const r2 = await query('SELECT JSON_INSERT(\'{"a":1}\', \'$.a\', 99) AS val');
    ok('JSON_INSERT does not overwrite existing', r2 && typeof r2.val === 'object' && r2.val.a === 1, r2 && r2.val);
  }

  // ===== JSON_REMOVE =====
  {
    const r = await query('SELECT JSON_REMOVE(\'{"a":1,"b":2}\', \'$.b\') AS val');
    ok('JSON_REMOVE deletes key', r && typeof r.val === 'object' && r.val.a === 1 && !('b' in r.val), r && r.val);
  }

  // ===== JSON_UNQUOTE =====
  {
    const r = await query('SELECT JSON_UNQUOTE(\'"hello"\') AS val');
    ok('JSON_UNQUOTE removes quotes', r && r.val === 'hello', r && r.val);
  }

  // ===== JSON_QUOTE =====
  {
    const r = await query('SELECT JSON_QUOTE(\'hello\') AS val');
    ok('JSON_QUOTE adds quotes', r && r.val === '"hello"', r && r.val);
  }

  // ===== JSON_TYPE =====
  {
    const r1 = await query('SELECT JSON_TYPE(\'{"a":1}\') AS val');
    ok('JSON_TYPE object returns "object"', r1 && r1.val === 'object', r1 && r1.val);

    const r2 = await query('SELECT JSON_TYPE(\'[1,2,3]\') AS val');
    ok('JSON_TYPE array returns "array"', r2 && r2.val === 'array', r2 && r2.val);

    const r3 = await query('SELECT JSON_TYPE(\'"hello"\') AS val');
    ok('JSON_TYPE string returns "string"', r3 && r3.val === 'string', r3 && r3.val);

    const r4 = await query('SELECT JSON_TYPE(\'42\') AS val');
    ok('JSON_TYPE integer returns "integer"', r4 && r4.val === 'integer', r4 && r4.val);
  }

  // ===== JSON_DEPTH =====
  {
    const r1 = await query('SELECT JSON_DEPTH(\'{"a":1}\') AS val');
    ok('JSON_DEPTH flat object returns 1', r1 && r1.val === 1, r1 && r1.val);

    const r2 = await query('SELECT JSON_DEPTH(\'{"a":{"b":1}}\') AS val');
    ok('JSON_DEPTH nested object returns 2', r2 && r2.val === 2, r2 && r2.val);
  }

  // ===== JSON_VALID =====
  {
    const r1 = await query('SELECT JSON_VALID(\'{"a":1}\') AS val');
    ok('JSON_VALID valid JSON returns 1', r1 && r1.val === 1, r1 && r1.val);

    const r2 = await query('SELECT JSON_VALID(\'not json\') AS val');
    ok('JSON_VALID invalid JSON returns 0', r2 && r2.val === 0, r2 && r2.val);
  }

  // ===== JSON_SEARCH =====
  {
    const r = await query('SELECT JSON_SEARCH(\'{"name":"test","desc":"hello world"}\', \'all\', \'test\') AS val');
    ok('JSON_SEARCH finds matching value', r && Array.isArray(r.val) && r.val.length > 0, r && r.val);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
})();
