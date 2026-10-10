# 多协议服务器

> 一个 TCP 端口，同时服务 MySQL / PostgreSQL / MongoDB / Redis 客户端，操作同一份数据。

## 快速开始

```js
const { createMultiServer } = require('jsql-neo');

const srv = createMultiServer({
  port: 5432,        // 监听端口
  host: '0.0.0.0',   // 对外监听地址
  dataDir: './data', // 数据目录（省略则为纯内存）
  noAuth: true,      // 免认证（默认 false）
  auth: { root: { password: 'secret', databases: ['*'] } }, // 用户表（可选）
});

srv.listen(() => console.log('multiprotocol on 5432'));
// ... 之后 srv.close() 优雅退出
```

命令行等价形式：

```bash
jsql serve --pg -p 5432 --data-dir ./data --no-auth
```

## 协议嗅探原理

连接建立后，服务器收集首包字节并按下表判定：

| 首字节 / 特征 | 协议 | 说明 |
|---|---|---|
| `0x00`（大端 Int32 长度，< 2^24） | PostgreSQL | PG 的 StartupMessage 长度头 |
| `0x0a` / `0x0d` | MySQL | client handshake 协议版本字节 |
| Int32LE 长度 + opCode `2004/2012/2013` | MongoDB | OP_QUERY / OP_COMPRESSED / OP_MSG |
| ASCII 命令 / RESP 前缀（`* + $ - :`） | Redis | 普通命令或 RESP 数组 |
| 200ms 内无任何字节 | MySQL | MySQL 客户端等待服务器握手包，超时后按 MySQL 处理 |

实现位于 `lib/multiserver.js` 的 `sniffProtocol(buf)`，判定基于前 16 字节，误判率极低：

- Redis 命令首字节必为可打印 ASCII，而 Mongo 消息长度首字节几乎总是二进制字节
- PG 首字节为 `0x00`，与 MySQL 的 `0x0a/0x0d` 不可能混淆
- MySQL 不主动发包的客户端（等待握手）由 200ms 超时兜底

## 共享数据模型

四种协议共享同一个 `Database` 引擎实例（按库名懒创建）：

- MySQL / PG 的表 ↔ Mongo 的集合 ↔ Redis 的独立 key 命名空间
- 用 MySQL 建的表可以直接被 Mongo 客户端按集合名访问（行即文档）
- Redis key 使用独立命名空间（如 `app:users:count`），不与表冲突

```js
// 多协议服务器内部结构（伪代码）
getEngine('app')  // → Database('./data/app')
  ├── mysql 处理器   ── 读同一引擎
  ├── pg 处理器      ── 读同一引擎
  ├── mongo 处理器   ── 读同一引擎
  └── redis 处理器   ── 读同一引擎（独立 key Map）
```

## 端口与进程管理

```js
srv.listen();                  // 启动监听（幂等）
srv.address()                  // → { address, port } 实际地址
srv.close()                    // 关闭所有连接、停止所有引擎的落盘、释放端口
```

- 每个引擎在 `close()` 时执行 `engine.stop()`（落盘 + 清理）
- 连接断开自动清理（`_sockets` 集合）
- 端口被占用时通过 `onError` 回调通知，默认抛出
