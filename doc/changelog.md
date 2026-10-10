# 变更日志

## v6.3.6 (最新)

### Performance
- **WHERE 等值条件下推存储层，主键点查快 420 倍**（P0）
  - `SELECT * FROM t WHERE id = 12345` 从 88ms 降至 0.21ms
  - SELECT / UPDATE / DELETE 三条路径全部优化
  - 下推边界保守：仅等值、AND 链；OR/范围/IN/函数/子查询保持原样

### Fixed
- **无主键表批量删除删错行**（数据损坏级）
- **UPDATE 改主键/唯一列不校验冲突**
- **`+` 静默做字符串拼接** → 修正为 MySQL/SQLite 算术语义
- **聚合函数无法参与算术**（`SELECT SUM(sal)/COUNT(*)`）
- **`require('jsql-neo')` 真实安装时 `updateById` 约束异常漏 `await`**

## v6.3.5 — 2026-10-05

- 核心稳定性修复（真实 Linux 环境压测发现）
- 多协议服务器稳定性改进

## 早期版本

详见完整变更日志 [../CHANGELOG.md](../CHANGELOG.md)
