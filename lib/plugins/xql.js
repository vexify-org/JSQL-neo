/**
 * xql —— 用 XQL（eXtend Query Language）查询 JSQL 表
 *
 * XQL 把 SQL 直接接到 JS 文档上：支持等值 hash 索引与范围 range 索引，
 * 查询速度不低于手写 JS 循环，并支持管道式语法（FROM t |> WHERE … |> LIMIT n）。
 *
 * 本插件把 JSQL 表加载成 XQL 集合（自动分页读全表），写入时标记失效、
 * 下次查询重建，从而在 JSQL 之上获得 XQL 的管道语法与索引。XQL 只读，
 * 不做写回——数据的唯一权威仍然是 JSQL 引擎本身。
 *
 * @example
 * db.use(require('jsql-neo/lib/plugins').xql());
 *
 * await db.xql('SELECT name FROM users WHERE age > 18 ORDER BY name');
 * await db.xql('FROM users |> WHERE age > 18 |> SELECT name |> ORDER BY name');
 * db.xqlIndex('users', 'id');               // 等值 → hash 索引，O(1)
 * db.xqlIndex('users', 'score', 'range');   // 范围 → range 索引
 *
 * @example 自动建索引 + 显式加载
 * db.use(require('jsql-neo/lib/plugins').xql({
 *   indexes: { users: ['id', ['score', 'range']] },
 *   pageSize: 2000,
 * }));
 * await db.xqlLoad('users');
 */
const { definePlugin } = require('../plugin');

/** 规整索引配置：'id' | ['score','range'] → ['id', null] | ['score','range'] */
function normalizeIndexSpecs(specs) {
  return (specs || []).map(s => Array.isArray(s) ? [s[0], s[1] || null] : [s, null]);
}

/** 记录索引规格（去重，按字段名） */
function recordIndexSpec(state, table, field, type) {
  const list = state.indexSpecs[table] || (state.indexSpecs[table] = []);
  const exists = list.some(s => (Array.isArray(s) ? s[0] : s) === field);
  if (!exists) list.push(type ? [field, type] : field);
}

function createXql(opts = {}) {
  const pageSize = opts.pageSize || 1000;
  const autoLoad = opts.autoLoad !== false;
  const getXql = opts.xql || (() => require('../xql'));

  return definePlugin('xql', {
    config: { pageSize, autoLoad, indexes: opts.indexes || {} },
    install(engine, ctx) {
      const state = {
        collections: new Map(),   // table -> Collection
        dirty: new Set(),         // table 需要重建
        indexSpecs: Object.assign({}, opts.indexes || {}),
      };
      ctx.store.set('xql', state);

      const load = async (table) => {
        const rows = [];
        let offset = 0;
        for (;;) {
          const batch = await engine.find(table, {}, { limit: pageSize, offset });
          if (!Array.isArray(batch) || batch.length === 0) break;
          rows.push(...batch);
          if (batch.length < pageSize) break;
          offset += batch.length;
        }
        const xql = getXql();
        const coll = new xql.Collection(table, rows);
        for (const [field, type] of normalizeIndexSpecs(state.indexSpecs[table])) {
          coll.index(field, type);
        }
        state.collections.set(table, coll);
        state.dirty.delete(table);
        return coll;
      };

      const ensure = async (table) => {
        const has = state.collections.has(table);
        if (!has && !autoLoad) {
          throw new Error(`xql: 表 '${table}' 未加载 —— 先 db.xqlLoad('${table}')`);
        }
        if (!has || state.dirty.has(table)) return load(table);
        return state.collections.get(table);
      };

      const invalidate = (table) => {
        if (state.collections.has(table)) state.dirty.add(table);
      };

      // 写入 → 缓存失效（native 只有 beforeUpdate/beforeDelete 会触发，
      // afterInsert 全引擎都有；用 before* 让三种引擎行为一致）
      ctx.on('afterInsert', (t) => invalidate(t));
      ctx.on('beforeUpdate', (t) => invalidate(t));
      ctx.on('beforeDelete', (t) => invalidate(t));
      ctx.on('afterDropTable', (t) => {
        state.collections.delete(t);
        state.dirty.delete(t);
      });
      ctx.on('onStop', () => {
        state.collections.clear();
        state.dirty.clear();
      });

      const api = {
        version: getXql().version,

        /** 用 XQL 查询（自动加载源表）。opts.table 可显式指定数据源。 */
        async query(sql, opts = {}) {
          const xql = getXql();
          const src = opts.table || xql.compile(sql).__source;
          const coll = await ensure(src);
          return coll.query(sql);
        },

        /** 显式加载一张表成 XQL 集合（含配置的索引） */
        load(table) { return load(table); },

        /** 强制重建某张表的 XQL 集合 */
        refresh(table) {
          state.dirty.add(table);
          return load(table);
        },

        /** 给表建索引（运行时）。等值不传 type → hash，传 'range' → 有序索引。 */
        index(table, field, type) {
          recordIndexSpec(state, table, field, type);
          const c = state.collections.get(table);
          if (c) c.index(field, type);
          return engine;
        },

        /** 已加载的 XQL 集合名 */
        tables() { return Array.from(state.collections.keys()); },

        /** 取某表的 XQL 集合（未加载返回 null） */
        collection(table) { return state.collections.get(table) || null; },

        /** 清空缓存（可指定表；不传清全部） */
        clear(table) {
          if (table) {
            state.collections.delete(table);
            state.dirty.delete(table);
          } else {
            state.collections.clear();
            state.dirty.clear();
          }
          return engine;
        },
      };

      ctx.expose(api);

      // 便捷方法直接挂到引擎上：db.xql / db.xqlIndex / …
      engine.xql = api.query;
      engine.xqlLoad = api.load;
      engine.xqlRefresh = api.refresh;
      engine.xqlIndex = api.index;
      engine.xqlTables = api.tables;
      engine.xqlCollection = api.collection;
      engine.xqlClear = api.clear;
    },
  });
}

module.exports = { createXql, xql: createXql };
