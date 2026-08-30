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
- 模块文件在 vm 沙箱中执行（不污染全局），可 `require` 本地依赖
- 循环依赖会报错；disable 级联防止孤儿模块
