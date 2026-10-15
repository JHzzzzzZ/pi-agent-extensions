# 对齐：timeout-bg-todo#5 — shell 工具「直接转后台」（run_in_background，本地 + 远端）

- 条目：`timeout-bg-todo#5`（tags: `功能`,`超时`）· 分支引用：`feat/direct-background`
- 日期：2026-10-15（UTC）· 参与：用户（提需求 + 选定「远端也要支持」）+ agent（接缝取证、候选触发面对照）
- 状态：**用户已确认**（2026-10-15，逐条 yes；本文件即对齐产物）
- 配套：remote-tools 侧的执行改动 = `remote-tools-todo#19`（同一变更交付，不设 dep；决策记录以本文件为准）

## 意图

用户 2026-10-15 提需求：**工具调用要能「直接转后台」**（类 background task 效果），不必先等超时才让路；
长任务（构建 / 全量测试 / 下载 / 长轮询）在调用那一刻就让路，主线程继续干活。
追加确认：**远端（`remote`）也要支持同一能力**（用户原话「remote也要支持转后台！」）。

**现状取证（为什么现在做不到）**

- 今天的转后台只在**超时命中**时发生（`shell-ops.ts` 的定时器回调里 `registry.background(...)`）；想「尽量早」只能传一个极小 `timeout`。
- 极小 timeout 有两处代价：① 结果文本说「⏱ 命令超时（N 秒）」——不是「我主动要后台」，读起来像事故；② 至少白等 N 秒（宿主 timeout 最小单位是秒，`timeout: 0.001` 属于钻空子且文案更离谱）。
- 远端同理（remote-tools `ops.ts` 的 `execHosted`：定时器命中才 `host.register(...)`）。

**触发面对照（本条目最关键的决策）**

| 候选 | 判据 | 结论 |
| --- | --- | --- |
| `timeout: 0` | 本插件词表里**已是反义**：`PI_TIMEOUT_BG_DEFAULT=0` = 关闭默认超时 = 不限时；宿主 `resolveTimeoutMs` 对 ≤0 抛 `Invalid timeout: must be a finite number of seconds`（`dist/core/tools/bash.js`），其它消费者（remote-tools 转发、宿主自身）也照此拒绝 | 否 |
| `timeout: -1` | 魔法数，零可读性；模型不会自发输出负 timeout | 否 |
| **新参数 `run_in_background: boolean`** | 自解释（Claude Code 的 Bash 工具同名同义，模型有先验）；把「多久超时」与「是否后台」两个正交维度分成两个字段；两扩展可各自声明/转发 | **采用** |

## 范围

**做什么**

1. **参数面**：`bash` / `powershell` 增 `run_in_background?: boolean`（描述：「立即转入后台，不等超时；与 timeout 同时给时后台优先、timeout 被忽略」）；
   模型面同时更新工具 `description` 与 `promptGuidelines`（长任务用法的显式示例）。参数由 timeout-bg 单源持有（合并后的 bash schema 由它注入）。
2. **本地语义**：spawn 成功即 `registry.background(...)` 登记并结束本次 tool call —— 进程继续跑、输出继续落同一个 job 日志、`/bg`、`/bg:kill`、`/bg:clear`、footer 状态条段（`⏱ N bg`）、结束时同格式 followUp 通知全部复用**零新机制**。
3. **结果形态**：与超时路径同构 —— 本次 tool call **以文本错误结束**（`reject`），文案是「⏸ 已直接转入后台」（不是「超时」），含 jobId + 日志路径 + 「结束时发通知、不要重跑」。
   不走 `resolve`：宿主的 `outputSchema`（`exit_code` / `wall_time_seconds` / `truncated`）没有「已后台」这个位，resolve 等于告诉 codemode 脚本「命令成功完成」。
4. **远端语义（配套 remote-tools#19）**：`remote` + `run_in_background` ⇒ 远端分支 ssh 一启动就经既有 job 托管端口 `register`（`terminate` 钩子复用：尽力杀远端进程组 + 断 ssh），不等超时；字号、日志、`/bg` 面、通知与本地逐字同格式。
5. **契约扩展**：`docs/cross/shell-tool-capability.md` 增补 —— ① 参数归属（owner 新增、提供方不得重复声明）；② 托管端口登记区分两种来源（超时 / 主动后台）与结果文本仍由 timeout-bg 单源持有；③ 提供方是否支持该参数的可见性（对端不支持时 owner fail-closed）。
6. **`/bg` 列表标记来源**：job 行加一个来源词（`超时` / `后台`），避免混合列表里读不出「这是我要的后台还是超时事故」。
7. **测试**：两扩展单测（本地立即登记 / 远端立即登记 / 参数透传与剥离 / 对端不支持时 fail-closed）+ 跨扩展组合集成测试 + opt-in 真机用例（本地与远端各一条：调完立刻返回、job 在 `/bg`、日志续写、结束通知到达）。

**明确不做什么**

- 不做 `timeout` 哨兵（0 / -1）语义，也不改宿主 `resolveTimeoutMs` 的校验口径。
- 不做「秒级宽限」（先等 N 秒看命令是否秒失败再决定）：语义要的是「立即」，失败有结束通知兜底；列为后续可选。
- 不做远端 powershell（远端能力只有 bash）。
- 不做新的命令面（如 `/bg:run <cmd>`）、不加新工具。
- 不改超时转后台的既有语义与文案（零回归）；不打宿主补丁。
- 不做跨会话的后台任务守护（仍只活在本会话，`session_shutdown` 全部终止）。

## 验收标准

1. **本地立即后台**：`bash` 传 `run_in_background: true` 跑 `sleep 20; echo DONE-BG` ⇒ 调用**立即**（< 1s）返回，文本含 jobId + 日志路径且不含「超时」字样；`/bg` 能看到该 job；稍后日志出现 `DONE-BG` 且收到结束通知（退出码 0）。
2. **不等超时的证明**：同一用例里 `timeout` 显式给大值（如 600）或省略时，行为与「未给 timeout」一致（后台优先）。
3. **远端立即后台**：`bash` 传 `remote` + `run_in_background: true` 跑 `sleep 20; echo REMOTE-DONE` ⇒ 同样立即返回 + `/bg` 可见（展示 `remote <host>`）+ 日志续写 + 结束通知；`/bg:kill` 后远端进程确实终止（远端 `ps` 无残留）。
4. **对端不支持时 fail-closed**：对端（remote-tools / timeout-bg 任一）为不支持的版本时，该组合报结构化错误并给出可见提示，**不静默退化成前台等待**、更不在本机跑远端意图的命令。
5. **零回归**：现有 53 个 timeout-bg 测试 + remote-tools 全量测试绿；超时转后台链路（显式与默认 300s）文案与行为逐字不变。
6. 两扩展 `npm run typecheck` 零错误 + 全仓测试门绿 + 跨厂商评审到无新意见（红线 11，T3 口径）。

## 人工确认

- **确认人**：用户（本会话）· **日期**：2026-10-15（UTC）· **方式**：对下列 Q1–Q6 一次回复「OKOK，速度」= 全部采纳 agent 推荐答案（含 Q5/Q6 两条小项）
- **决策（全部采纳）**
  1. **Q1 触发面**：新参数 `run_in_background`（不用 `timeout` 0 / -1）。
  2. **Q2 参数归属**：timeout-bg 单源声明；不装 timeout-bg（或加载顺序相反、远端实现单独生效）时**没有**该参数，而不是给一个假装支持的空承诺。
  3. **Q3 结果形态**：本次 tool call 以文本**错误**结束（与超时路径同构），不 resolve（避免结构化结果谎报 `exit_code: 0`）。
  4. **Q4 远端组合**：远端分支 ssh 一启动即登记 job（复用托管端口与 terminate 钩子）；对端不支持 ⇒ fail-closed 报错。
  5. **Q5 `/bg` 标记来源**：列表行加 `超时` / `后台` 来源词。
  6. **Q6 不做秒级宽限**：不做（列为后续可选）。
- **已知取舍（显式接受）**：① 主动后台的调用在 UI 上是一次「失败」的 tool call（文本说明是主动行为），换取结构化结果不撒谎；② 远端后台会常驻一个本地 ssh 到命令结束（既有 #12 决策的延续）；③ 契约与两个插件都要动（T3 档位），是本条目最贵的部分。
- **开工放行**：已确认，跑 `align` → `claim` 进 `processing`，随后写 `docs/specs/`（T3 必填）→ worktree `feat/direct-background` 实施。
