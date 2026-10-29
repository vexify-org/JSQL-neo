# JSQL Plugin & Module System

JSQL Neo 支持跨三个引擎的统一插件系统：**Native** (`NativeJSQL`), **WASM** (`JSQL`), **Pure JS** (`Database`)。

## 快速开始

```js
const { JSQL, NativeJSQL, Database, Plugin, ModuleManager } = require('jsql-neo');

// 手动注册插件
const db = new NativeJSQL();
db.use(myPlugin);

// 或自动应用已启用模块（默认开启，opts.modules: false 关闭）
const db2 = new NativeJSQL({ modules: true });
```

## 插件格式

插件可以是 **函数** 或 **对象**：

```js
db.use({
  name: 'my-plugin',
  install(db, ctx) {          // ctx = 插件上下文（见下）
    db.myFlag = true;
  },
  hooks: {
    beforeInsert(table, data) { /* modify data */ return data; },
    afterInsert(table, data, ids) {},
    beforeUpdate(table, id, data) { return true; },   // false = 中止
    afterUpdate(table, id, data, result) {},
    beforeDelete(table, id) { return true; },
    afterDelete(table, id, result) {},
    beforeFind(table, query) { return true; },
    afterFind(table, query, result) {}
  },
  onEvent(event, payload) {
    console.log(event, payload);
  }
});
```

## Hooks 参考（统一 18 个）

| Hook | 参数 | 返回值 | 支持引擎 |
|------|------|--------|---------|
| `beforeInsert` | `(table, data[])` | 修改后 data / `false` 中止 | N/W/D |
| `afterInsert` | `(table, data[], ids)` | — | N/W/D |
| `beforeUpdate` | `(table, id, data)` | `true`/`false` | N/W/D |
| `afterUpdate` | `(table, id, data, result)` | — | N/W/D |
| `beforeDelete` | `(table, id)` | `true`/`false` | N/W/D |
| `afterDelete` | `(table, id, result)` | — | N/W/D |
| `beforeFind` | `(table, query)` | `true`/`false` | N/W/D |
| `afterFind` | `(table, query, result)` | — | N/W/D |
| `beforeCreateTable` | `(name, schema)` | `true`/`false` | N/W/D |
| `afterCreateTable` | `(name, schema)` | — | N/W/D |
| `beforeDropTable` | `(name)` | `true`/`false` | N/W/D |
| `afterDropTable` | `(name)` | — | N/W/D |
| `beforeFlush` | `()` | `true`/`false` | N/W |
| `afterFlush` | `()` | — | N/W |
| `beforeCount` | `(table)` | `true`/`false` | N/W/D |
| `afterCount` | `(table, count)` | — | N/W/D |
| `onStart` | `()` | — | N/W/D |
| `onStop` | `()` | — | N/W/D |

N = Native, W = WASM, D = Pure JS Database

## 事件

| 事件 | payload |
|------|---------|
| `insert` | `{ table, count, ids }` |
| `update` | `{ table, id, data }` / `{ table, entries }` |
| `delete` | `{ table, ids }` |
| `createTable` | `{ name, schema }` |
| `dropTable` | `{ name }` |
| `start` / `stop` | `{}` |

## 插件上下文 ctx

`install(db, ctx)` 的第二个参数：

```js
{
  name,               // 插件名
  engine,             // 引擎实例
  plugin,             // 插件自身
  on(hook, fn),       // 注册 hook
  onEvent(fn),        // 注册事件
  emit(ev, data),     // 发出事件
  tables(),           // 已建表名列表
  hasTable(name),     // 表是否存在
  getTableSchema(name), // 表 schema
  table(name)         // [Pure JS] 表实例
}
```

## 统一引擎 API

四个引擎（Native/WASM/Pure JS）现在共享同一套方法：

```js
await db.start();
await db.createTable('users', { name: { type: 'string' }, age: { type: 'integer' } });
const ids = await db.insert('users', [{ name: 'Alice', age: 30 }]);
await db.flush();
const row = db.findById('users', ids[0]);          // 或 await（WASM）
const rows = db.findByIds('users', ids);
const list = await db.find('users', { age: { $gte: 18 } }, { limit: 10 });
const n = await db.count('users');
db.updateById('users', ids[0], { age: 31 });       // 或 await（WASM）
db.updateByIds('users', [[ids[0], { age: 32 }]]);
db.removeById('users', ids[0]);
db.removeByIds('users', ids);
await db.stop();
```

## xql 插件

用 XQL（eXtend Query Language）查询 JSQL 表：把 SQL 直接接到 JS 文档上，
支持等值 hash 索引与范围 range 索引，速度不低于手写 JS 循环，支持管道式语法。

```js
db.use(require('jsql-neo/lib/plugins').xql());

const rows = await db.xql('SELECT name FROM users WHERE age > 18 ORDER BY name');
const pipe = await db.xql('FROM users |> WHERE age > 18 |> SELECT name |> ORDER BY name');

db.xqlIndex('users', 'id');             // 等值 → hash 索引，O(1)
db.xqlIndex('users', 'score', 'range'); // 范围 → range 索引
```

写入（INSERT / UPDATE / DELETE）后缓存自动失效，下次查询重建；XQL 只读，
不做写回，数据的唯一权威仍是 JSQL 引擎。

配置项：

| 选项 | 默认 | 说明 |
|------|------|------|
| `indexes` | `{}` | 自动建索引：`{ users: ['id', ['score', 'range']] }` |
| `pageSize` | `1000` | 读表分页大小（`find` 有默认 limit） |
| `autoLoad` | `true` | 首次查询自动加载源表 |

API（也可用 `db.plugin('xql')` 取同一套）：

| API | 说明 |
|-----|------|
| `db.xql(sql, { table })` | 用 XQL 查询（自动加载源表；`opts.table` 可指定数据源） |
| `db.xqlLoad(table)` | 显式加载一张表成 XQL 集合 |
| `db.xqlRefresh(table)` | 强制重建某表 |
| `db.xqlIndex(table, field, type)` | 运行时建索引（`type` 缺省按字段类型猜） |
| `db.xqlTables()` | 已加载集合名列表 |
| `db.xqlCollection(table)` | 取 XQL 集合（未加载返回 `null`） |
| `db.xqlClear(table?)` | 清缓存（不传清全部） |

> XQL 源码以 `lib/xql/` 内置（vendored from `vexify-org/XQL` v0.3.0），
> 因此 `db.use('xql')` 无需额外安装依赖。

## 模块系统（CLI + 代码）

### CLI

```
jsql mod add --address /path/mod.js     # 注册模块（-a 简写）
jsql mod enable <name>                   # 启用（自动启用依赖）
jsql mod disable <name>                  # 禁用（级联禁用依赖它的模块）
jsql mod remove <name>                   # 移除注册
jsql mod list | ls [--json]              # 列表
```

配置持久化在 `~/.config/jsql/mod.config`（可用环境变量 `JSQL_MOD_CONFIG` 覆盖）。

### 模块文件格式

```js
jsql.mod.nameset('timestamp');           // 模块名（缺省 = 文件名去后缀）
jsql.mod.priority(1);                    // 安装顺序（小 → 大，默认 0）
jsql.mod.depends('base');                // 依赖：enable 时自动启用，disable 时级联禁用
jsql.mod.api({ version: '1.0' });        // 暴露 API 给其他模块 (manager.api(name))
jsql.mod.on('beforeInsert', (t, d) => d);
jsql.mod.onEvent((ev, p) => {});
jsql.mod.install((db, ctx) => {});       // 或 module.exports = plugin 对象
```

### 代码 API

```js
const { ModuleManager } = require('jsql-neo');
const mgr = new ModuleManager();

mgr.add('/path/mod.js');        // 注册
mgr.enable('name');             // 启用（含依赖）
mgr.disable('name');            // 禁用（级联）
mgr.enableAll();  mgr.disableAll();
mgr.applyTo(db);                // 应用所有已启用模块到实例
mgr.get('name');                // 加载插件对象
mgr.api('name');                // 获取模块公开的 api
mgr.list();                     // 列表
```

**自动应用**：`new NativeJSQL()` / `new JSQL()` 构造时自动把已启用模块应用到实例（按 priority + depends 排序）；`{ modules: false }` 关闭。

## Plugin 辅助类

```js
const { Plugin } = require('jsql-neo');

const timestampPlugin = new Plugin('timestamp')
  .on('beforeInsert', (table, data) => {
    data.forEach(r => r.created_at = new Date().toISOString());
    return data;
  })
  .onEvent((ev, payload) => console.log(ev))
  .install((db, ctx) => {})
  .build();

db.use(timestampPlugin);
```

## 注意事项

- `before*` hooks 返回 `false` 中止操作
- `beforeInsert`/`beforeUpdate` 可修改数据（返回修改值）
- Hook 内 `throw` 传播给调用方；`onEvent` 错误静默忽略
- 循环依赖会报错；disable 级联防止孤儿模块

## 关于沙箱（重要）

**插件与模块都没有沙箱隔离**，请不要装载不可信来源的插件：

| 装载方式 | 实际行为 |
|---|---|
| `db.use(plugin)` | 插件对象直接挂进核心，与核心同权 |
| `jsql mod add <dir>` | 模块文件走普通 `require()`，与核心同权 |

也就是说插件代码能访问 `fs`、`child_process` 等全部 Node API，也能改核心内部状态。
模块文件可 `require` 本地依赖，但**不会被隔离**。

> 本文档此前写"模块文件在 vm 沙箱中执行（不污染全局）"——代码中并不存在 vm 隔离，
> 已更正。需要隔离请在进程级解决（容器 / 子进程 / 限制运行用户与权限）。
