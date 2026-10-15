# shell 工具「直接转后台」（run_in_background，本地 + 远端）— 规格

> 来源：`todos/timeout-bg-todo#5` + 配套 `todos/remote-tools-todo#19`（对齐文档 `todos/align/timeout-bg-todo#5.md`，2026-10-15 用户逐条确认）。T3（改模型可见参数面 + 横切契约）。

## 问题陈述

今天的「转后台」只在**超时命中**时发生。想立刻让路只能传一个极小 `timeout`：白等 N 秒（宿主最小单位是秒），而且结果文案是「⏱ 命令超时（N 秒）」——像是出了事故，不是「我主动要后台」。长任务（构建 / 全量测试 / 下载 / 长轮询）因此总要先占住主线程。远端同理（remote-tools 只在超时回调里登记 job）。

## 方案

`bash` / `powershell` 增一个显式参数 **`run_in_background?: boolean`**：为真时进程一启动就登记进 job 注册表（本地与远端同语义），本次 tool call 立即结束，其余全部复用既有转后台设施——同一日志文件、`/bg` 列表、`/bg:kill`、`/bg:clear`、footer 状态条段 `⏱ N bg`、结束时同格式 followUp 通知。

不用 `timeout` 哨兵（0 / -1）：`PI_TIMEOUT_BG_DEFAULT=0` 在本插件里已是「关闭默认超时、不限时」，同词反义；宿主 `resolveTimeoutMs` 对 ≤0 也直接抛 `Invalid timeout`，其它消费者（远端转发、宿主自身）照此拒绝。

| 面 | 行为 |
| --- | --- |
| 参数归属 | timeout-bg 单源声明（合并后的 bash schema）；remote-tools 单独生效时不声明该参数（不装 owner 就没有后台能力，不给假装支持的空承诺） |
| 与 `timeout` 同时给 | 后台优先，`timeout` 忽略（写进参数说明）；远端分派的默认超时补齐也跳过（不注入） |
| 结果形态 | 本次 tool call **以文本错误结束**（`reject`），文案「⏸ 已直接转入后台…」+ jobId + 日志路径 + 「结束时发通知、不要重跑」 |
| `/bg` 展示 | job 记录带来源（`[后台]` / `[超时]`），混合列表能一眼分清 |
| 远端组合 | ssh 一启动即经既有 job 托管端口登记；`terminate` 钩子复用（杀远端进程组 + 断 ssh） |
| 版本/能力不匹配 | 对端不支持（没装 owner / 旧版端口）⇒ **fail-closed 报错**，不静默退化成前台等待、不在本机执行 |

## 用户故事

1. 作为使用者，我让 agent 跑「全量构建」时它立刻让路，我不必再等超时才拿回控制权。
2. 作为使用者，我一眼能从 `/bg` 看出哪些 job 是我主动转的、哪些是超时转的。
3. 作为使用者，远端长任务与本地是同一套用法：一个 `run_in_background: true`，同一个 `/bg` 面、同一种通知。
4. 作为使用者，我对远端命令请求后台但对端不支持时，会看到明确报错，而不是悄悄跑到本机或悄悄变前台。
5. 作为维护者，两个插件各自的既有超时语义、文案与测试逐字不变（零回归）。

## 实现决策

- **本地传递路径（关键）**：宿主的 `createBashTool().execute` 只把 `command`/`timeout`/`env` 传进 `options`，**新参数到不了 `operations.exec`**。所以 timeout-bg 在注册时按模式各建一份宿主工具定义（`timeout` / `background`），自己的 `execute` 包一层：`params.run_in_background === true` ⇒ 用 background 版定义执行（转后台 ops），否则用原版。**不用**共享可变状态、不用哨兵值透传。
- **本地 ops**：`createTimeoutOps` 增 `mode: "timeout" | "background"`（构造期固定，per 定义实例；不用布尔标志）。`background` 模式 spawn 成功后**同 tick** 内登记 job 并 settle（`reject` 后台结果文本）；exit 处理照旧走既有 `backgrounded` 分支（`registry.markExited` → followUp）。不装定时器（`timeout` 忽略）。登记先于任何 exit 回调可能到达的时序（wire 完成后才登记，同 tick 安全）。
- **来源字段**：`JobRecord` 增 `origin: "timeout" | "background"`（默认 `"timeout"`，既有调用点零改动），只影响 `/bg` 行渲染。
- **远端传递路径**：分派把 `params` 原样转给 capability 的 `executeRemote`，`run_in_background` 随之到达 remote-tools；`execHosted` 立即登记（与超时分支共用一段登记代码）；`stripRemoteFields` 必须剔掉该字段——不能透传给宿主内置 bash 定义（未知参数会被静默忽略 = 悄悄变前台）。
- **契约（加法式扩展，不开新频道）**：job 托管端口（owner 侧 = timeout-bg）新增方法 `registerBackground(job)`（与 `register` 同载荷去掉 `timeoutSeconds`），返回结果文本；提供方（remote-tools）**探测方法存在性**——不存在即 fail-closed。旧提供方不调用新方法、新提供方缺方法即报错，双向都安全，故不需要 v2 频道。
- **能力可见性**：shell 能力载荷（remote-tools → owner）增 `runInBackground: boolean`（缺席/非布尔 = 不支持）；owner 在远端分派前检查，不支持 ⇒ fail-closed 报错（不让远端静默前台跑）。
- **错误码**：remote-tools `errors.ts` 增 `REMOTE_BACKGROUND_UNSUPPORTED`（缺托管端口 / 端口不支持 / 日志建不出且请求了后台）。文案静态模板。
- **不做秒级宽限**：语义要的是「立即」，秒失败由结束通知兜底；宽限会让每次后台调用都慢 N 秒。
- **边界（显式）**：`remote` 参数 + 未装 remote-tools 时，任何远端参数都到不了远端（今天已有的边界，本变更不扩大也不修）。

## 测试决策

先红后绿（`node:test` + `node:assert/strict`，无 mock 库；fake 只做进程/IO 边界替身）：

- **本地**：`run_in_background: true` ⇒ 调用立即 settle（不等 fake 子进程 exit）、job 已在注册表且 `origin: "background"`、结果文本含 jobId + 日志路径且**不含**「超时」；显式 `timeout: 9999` 并存时同样立即返回（后台优先）；子进程 exit 后走 `markExited` + 通知（复用既有断言）。
- **文本/schema**：`backgroundResultText` 模板；参数注入后 `parameters.properties` 含 `run_in_background`（且 `timeout` 描述仍被改写）；描述与 guidelines 提到新参数。
- **远端（remote-tools 侧）**：假 ssh（既有 fake `exec`）⇒ `run_in_background: true` 时立即登记（`registerBackground` 被调用一次）、结果文本来自端口；端口缺 `registerBackground` / 无托管端口 ⇒ 报 `REMOTE_BACKGROUND_UNSUPPORTED` 且不 spawn（无托管时）或不登记；`stripRemoteFields` 剔除该字段（断言宿主定义收到的 params 无此键）。
- **组合**：跨扩展集成测试（真 event bus + 真实加载两扩展 + 真 `ExtensionRunner`）断言「有 `runInBackground` ⇒ 带后台参数的远端调用确实进远端分支、不 fail-closed」；「无 `runInBackground`（旧提供方）⇒ fail-closed」由分派层的 fake capability 单测锁定（真实加载路径下两侧都是本仓当前版本，造不出旧提供方）。
- **真机 opt-in**：`timeout-bg/test/live.test.ts`（`PI_TIMEOUT_BG_TEST_LIVE=1`，真实 spawn + 真实计时器：立即返回 / 进程续跑 / 日志续长 / 通知一次；超时路径同链路）与 `remote-tools/test/remote-live.test.ts` 的主动后台用例（`PI_REMOTE_TOOLS_TEST_TARGET`：ssh 一启动即登记、立即返回、terminate 杀远端进程组）——对齐文档验收 1/3 的可重复形态。
- **零回归**：既有 timeout-bg 53 例 + remote-tools 全量用例逐字不动地通过。

## 范围外

- 不做 `timeout` 哨兵语义；不改宿主 `resolveTimeoutMs` 校验口径。
- 不做秒级宽限、不做跨会话后台任务守护（仍只活在本会话）。
- 不做远端 powershell；不新增命令面（如 `/bg:run`）与新工具。
- 不改超时转后台的既有语义与文案；不打宿主补丁。
- 不做「`remote` 参数 + 未装 remote-tools」的兜底修复（既有边界，另条评估）。
