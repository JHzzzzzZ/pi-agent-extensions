# 对齐：remote-tools-todo#19 — 远端 bash 支持「直接转后台」（配套 timeout-bg#5）

- 条目：`remote-tools-todo#19`（tags: `功能`,`超时`,`组合`）· 分支引用：`feat/direct-background`
- 日期：2026-10-15（UTC）· 参与：用户（明确要求远端也支持）+ agent（接缝取证）
- 状态：**用户已确认**（2026-10-15；决策与取证全部记录在 `todos/align/timeout-bg-todo#5.md`，本文件不重复）
- 配套：`timeout-bg-todo#5`（参数 owner 与 job owner 半边，同一变更交付，不设 dep）

## 意图

用户要求「remote 也要支持转后台」：远端 bash 收到 `run_in_background: true` 时不再等超时——ssh 一启动即转入后台语义。
今天的远端转后台只在超时命中时发生（`ops.ts` 的 `execHosted` 定时器回调里 `host.register(...)`），
想「立即」没有参数可用（传极小 timeout 会在文案与体验上变成事故，见配套文档）。

## 范围

**做什么**

1. **`execHosted` 增加立即托管路径**：`run_in_background === true` ⇒ ssh 启动后立即 `host.register({...})`（不等 `timeoutMs` 定时器），
   输出继续写既有 job 日志、`settle` 走既有 ssh 退出回调；`terminate` 钩子复用（尽力杀远端进程组 + 断本地 ssh）；远端 pid 文件照常在命令启动前写好（`/bg:kill` 依赖它）。
2. **参数剥离**：`stripRemoteFields` 必须同时剔掉 `run_in_background`——不能透传给宿主内置 bash 定义（未知参数会静默忽略，等于悄悄退化成前台）。
3. **对端不支持 ⇒ fail-closed**：拿不到 job 托管端口（未装 timeout-bg）/ 端口形状是旧版（不认识「主动后台」来源）时，报结构化错误码 + 可见提示，**不静默按前台跑**。
4. **契约同步**：`docs/cross/shell-tool-capability.md` 与本扩展卡片、README 同步（新参数、两种来源的登记、能力可见性）。
5. **测试**：本扩展单测（立即登记 / 参数剥离 / 缺托管时 fail-closed / 零回归）+ 与 timeout-bg 的跨扩展组合集成测试 + opt-in 真机用例（远端命令不被杀、`/bg:kill` 生效）。

**明确不做什么**

- 不改远端超时转后台的既有语义与文案（零回归）。
- 不做远端 powershell。
- 不新增远端专用参数名（与本地同一个 `run_in_background`，由 timeout-bg 在合并 schema 里声明）。
- 不在本机兜底执行远端意图的命令（既有安全口径：`isRemoteCall` 抛错 ⇒ fail-closed）。

## 验收标准

1. `bash` 传 `remote` + `run_in_background: true`（命令 `sleep 20; echo REMOTE-DONE`）⇒ **立即**返回（< 1s）、结果含 jobId + 本地日志路径、不含「超时」字样。
2. 该 job 出现在 `/bg`（展示 `remote <host>`），输出持续写入日志，结束时收到与本地同格式的 followUp 通知。
3. `/bg:kill <jobId>` 后远端进程确实终止（远端 `ps` 无残留 / 标记文件不再生成）。
4. 未装 timeout-bg（拿不到托管端口）时该参数调用报结构化错误，**不静默前台等待**、不在本机执行。
5. 零回归：现有远端测试全绿，远端超时转后台链路行为与文案逐字不变。
6. `npm run typecheck` 零错误 + 全仓测试门绿 + 跨厂商评审到无新意见（红线 11，T3 口径）。

## 人工确认

- **确认人**：用户（本会话）· **日期**：2026-10-15（UTC）· **方式**：与 `timeout-bg-todo#5` 同批确认（Q1–Q6 见该文档「人工确认」节，用户一次回复全部采纳）
- **开工放行**：与 `timeout-bg-todo#5` 同一变更（worktree `feat/direct-background`）实施。
