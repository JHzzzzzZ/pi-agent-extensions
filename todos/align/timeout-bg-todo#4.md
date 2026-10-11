# 对齐：timeout-bg-todo#4 — 远端 job 托管能力（配套 remote-tools#12）

- 条目：`timeout-bg-todo#4` · 分支引用：`feat/remote-timeout-bg` · 日期：2026-10-11（UTC）

## 意图

远端 bash 超时后要转入后台并出现在统一 job 面，需要本扩展作为 job owner 对外提供托管端口。决策与取证全部记录在 `todos/align/remote-tools-todo#12.md`，本条目不重复。

## 范围

暴露 register/kill 的 job 托管能力（经 `pi.events` 频道，禁跨扩展 import）；远端 job 进 `/bg`、`/bg:kill`、`/bg:clear` 与状态条段；通知格式与本地一致；本地语义零回归；契约与测试同步。与 `remote-tools-todo#12` 同一变更交付，不设 dep。

## 验收标准

1. 远端 job 可注册、可列出、可 kill、可 clear，行为与本地 job 一致。
2. 未装 remote-tools 时本扩展行为逐字不变。
3. 单测全绿 + `npm run typecheck` 零错误 + 组合集成测试通过。

## 人工确认

- **确认人**：用户（本会话）· **日期**：2026-10-11（UTC）· **方式**：方案 B 与 5 条设计决策逐条 `yes`（见 `todos/align/remote-tools-todo#12.md` 的「人工确认」节）
- **开工放行**：与 #12 同批实施。
