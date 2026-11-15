# 发版流程

> 目标形态：`6.6.x` 稳定线 → 连续多个 `6.7.0-beta.N` → `6.7.0` 正式版。

## 一条命令准备一个版本

```bash
node scripts/release.js 6.7.0-beta.2          # 预发布
node scripts/release.js 6.7.0                 # 正式版
node scripts/release.js 6.7.0-beta.3 --date 2026-11-18
```

它会原子地完成四件事（先全部校验，任一项不满足就**一个文件都不写**）：

1. `package.json` / `index.js` / `README.md` 三处版本标记；
2. 把 `CHANGELOG.md` 的 `[Unreleased]` 正文转正成本版本章节，并重置空段；
3. 横幅的 release 字样跟着版本走 —— `beta.1` → `beta release`，正式版 → `stable release`
   （预发布却写 stable 属于虚标，门禁也会拦）；
4. 打印下一步的 `git add/commit/tag/push` 命令。

**不会**自动 commit / tag / push —— 那些是外部动作，确认后手动执行。

## 必跑的门禁

```bash
npm run check:release
```

校验：三处版本标记一致、CHANGELOG 含当前版本章节、预发布未标 stable。
已接进 `npm test` / `test:all` 和 `publish.yml` 的发布前一步 ——
漏写章节或标注错误，包发不出去。

## beta → 正式版的节奏

每个 beta 都应该：

1. 有一批实质改动（新功能 / 修复 / 性能），写进 `[Unreleased]`；
2. `npm test` 与 `test:all` 全绿（`0 FAIL`、`0 FATAL`）；
3. `node scripts/release.js 6.7.0-beta.N`；
4. `npm run check:release` → PASS；
5. commit + annotated tag + push（`v6.7.0-beta.N`）。

`publish.yml` 会按 tag 名判断 dist-tag：含 `beta` → 发到 npm 的 `beta` 通道，
**不会**覆盖 `latest`。所以 beta 可以放心连发，用户装正式版不受影响。

```bash
npm i jsql-neo@beta      # 跟最新 beta
npm i jsql-neo@latest    # 只跟正式版
```

## 正式版收口条件

- 所有计划的 beta 改动已经收敛，`[Unreleased]` 只留「准备发布」的条目；
- 没有已知的静默错值类问题（结果不对但不报错的那种优先于崩溃）；
- `doc/` 里的能力描述与实现一致（尤其是「不支持 / 未实现」要写清楚）；
- 打 `v6.7.0`（不带后缀）—— `release.js` 会把横幅切回 `stable release`。

## 版本线参考

| 形态 | 示例 | npm dist-tag |
| --- | --- | --- |
| 正式版 | `6.6.6` / `6.7.0` | `latest` |
| 预发布 | `6.7.0-beta.1`、`6.7.0-rc.1` | `beta` |
