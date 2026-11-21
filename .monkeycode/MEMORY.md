# User Instruction Memory

This file records user instructions, preferences, and teachings for reference in future interactions.

## Format

### User Instruction Entry
User instruction entries should follow this format:

[User Instruction Summary]
- Date: [YYYY-MM-DD]
- Context: [Mentioned scenario or time]
- Instructions:
  - [Content of user teaching or instruction, described line by line]

### Project Knowledge Entry
Entries discovered by the Agent during task execution should follow this format:

[Project Knowledge Summary]
- Date: [YYYY-MM-DD]
- Context: Discovered by Agent while performing [specific task description]
- Category: [Operations & Deployment|Build Methods|Testing Methods|Troubleshooting & Debugging|Workflow & Collaboration|Environment Configuration]
- Instructions:
  - [Specific knowledge points, described line by line]

## Deduplication Strategy
- Before adding a new entry, check for similar or identical instructions.
- If a duplicate is found, skip the new entry or merge it with the existing one.
- When merging, update the context or date information.
- This helps avoid redundant entries and keeps the memory file tidy.

## Entries

[User Instruction Summary]
- Date: 2026-11-21
- Context: 用户要求简化提交与发布流程
- Instructions:
  - 以后完成修改后直接 push 到 main 分支，不再新建分支或走 PR 流程。

[Project Knowledge Summary]
- Date: 2026-11-21
- Context: Discovered by Agent while fixing issues #162-#179
- Category: Environment Configuration
- Instructions:
  - 本环境未预装 node/npm/git/gpg/curl，需通过 apt-get 安装；Node 版本为 v22。
  - 原生模块在 `native/jsql-neo-native.node`，缺失时可用 `JSQL_NATIVE_DOWNLOAD=1 node postinstall.js` 从 GitHub Release 下载并通过 SHA256 校验。
  - `npm test` 依赖 curl（star-nag 测试）和原生模块；完整测试应在这两项就绪后运行。
