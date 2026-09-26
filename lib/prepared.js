/**
 * Shared prepared-statement helper for JS / native / WASM engines.
 * parse once, bind on each run. Compatible with executeSQL placeholder rules.
 */

function createPrepared(engine, sql) {
  if (typeof sql !== 'string' || sql.length === 0) {
    throw new Error('prepare() requires a SQL string');
  }
  const bound = {
    sql,
    async all(...params) {
      const values = params.length === 1 && Array.isArray(params[0]) ? params[0] : params;
      return engine.query(sql, values);
    },
    async get(...params) {
      const r = await bound.all(...params);
      if (!r) return null;
      if (Array.isArray(r.raw) && r.raw.length > 0) return r.raw[0];
      if (Array.isArray(r.rows) && r.rows.length > 0) {
        if (r.columns && Array.isArray(r.rows[0])) {
          const obj = {};
          for (let i = 0; i < r.columns.length; i++) obj[r.columns[i]] = r.rows[0][i];
          return obj;
        }
        return r.rows[0];
      }
      return null;
    },
    async run(...params) {
      return bound.all(...params);
    }
  };
  return bound;
}

module.exports = { createPrepared };
