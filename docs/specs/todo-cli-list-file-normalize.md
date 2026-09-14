# 规格：list --file 短名归一（todo-cli）

> 来源：`todos/todo-cli-todo.json` #12（2026-09-12 实测登记，2026-09-14 领取）
> 对齐：2026-09-14 用户对 4 个决策点全部同意（归一口径 / 明确报错不倒向空结果 / core 侧修 / 测试与范围）
> 状态：已实现

## 问题陈述

`node tools/todo.mjs list --file general` 返回 0 行且退出码 0——沉默错误；只有写全 `<名>-todo` 才正确。

根因：`core.ts` 的 `runList` 把 `resolveTodoPath` 的解析结果只用于文件存在性检查，传给 `applyEntryFilter` 的仍是原始 `opts.file`（如 `general`）；而 `entry.file` 是规范名（`general-todo`），两者精确比较永不相等 → 过滤为空。`query.ts` 头部注释声称「core 负责从 `--file` 归一」，该归一从未实现。

影响面：`docs/tools/todo-cli.md` 与 CLI `USAGE` 都把 `--file <name>` 写成短名可用；agent 用短名盘点插件待办时，会把「有 N 条」误读为「没有」。

## 方案

归一放在 core 侧，不把文件系统知识漏进纯函数层：

1. `resolveTodoPath(opts.file)` 解析（沿用已文档化的四写法归一 `x` / `x-todo` / `x-todo.json` / 旧写法 `x-todo.md`，拒绝路径穿越）。
2. 到已载入的 docs 里查规范名；查不到 → `找不到 todo 文件：<原样输入>` + exit 1。
3. 用 docs 里的**真实文件名**回填 `filter.file`，docs 子集取自同一次查找。
4. 不做大小写不敏感匹配（两文件仅大小写不同时会产生歧义）；Windows 上大小写不符落进第 2 步的明确报错，不再静默空结果。

## 用户故事

- 作为 agent，我用 `list --file general --status open` 一条命令盘点某插件的未领取条目，得到与 `--file general-todo` 逐字节一致的结果。
- 作为人，我写错文件名时得到明确报错，而不是被空结果误导。

## 实现决策

- 改点唯一：`todo-cli/core.ts` 的 `runList`（filter 归一 + docs 子集复用同一次查找）。
- `query.ts` 纯函数层不动：只收已归一的 name，本轮不新增 query 层口径。
- 错误消息沿用既有静态模板「找不到 todo 文件：」，退出码 1 不变。

## 测试决策

- 单测（`test/todo-cli.test.ts`）：四写法输出逐字节一致；与 `--status` / `--json` 组合仍生效；不得混入其它文件条目；不存在文件 exit 1。
- 进程边界 E2E：真实仓库上 `list --file general` 与 `--file general-todo` 输出相等且非空——本 bug 的直接回归锁（修前必红）。
- 必跑：`npm run test:todo` + `node tools/todo.mjs lint`。

## 范围外

- 不改 `add` / `claim` / `complete` 的 `--file` 行为（它们本来就正确）。
- `--file` 不加多值 / glob / 大小写不敏感匹配。
- 不动 `applyEntryFilter` 语义与 `--json` 输出结构。
- 不加根级 typecheck 门（仓库现状，见 `docs/tools/todo-cli.md` 已知坑）。
