# agent-team — 多 Agent 团队协作扩展

为 Pi coding agent 提供可复用、可对话创建的 **agent team**：一个团队 = 1 个 leader + N 个成员，每个成员可指定独立的后端模型（`provider/model`，支持任意已配置供应商，如 `chatanywhere/gpt-5.6`、`anthropic/claude-opus-4-5`）与专属 system prompt。把任务（issue）派给团队后，由**独立的 leader 子进程**自主拆解、通过 `team_dispatch` 工具把子任务并行派给成员（各自为 `pi --mode json -p` 子进程）、审查结果、迭代返工，最终把报告交回主会话。整体参考 Multica 的 squad/leader/dispatch 模式。

```text
主 pi 会话（驾驶舱）
  ├─ 对话建团：主 agent 调 team_create / team_list 工具 → 写团队定义文件
  └─ 派单：/team:run <team> <task> 或 team_run 工具
        │ spawn（leader 专属 prompt + PI_AGENT_TEAM_FILE 环境变量）
        ▼
Leader 子进程 pi --mode json -p --no-session --model <leader.model> -e <本扩展>
        │ team_dispatch { tasks: [{agent, task}] }（≤8 个/次，≤4 并发）
        ▼
Member 子进程 ×N：pi --mode json -p --no-session --model <member.model> [--tools ...]
                   [--append-system-prompt <member.prompt>]  "Task: <子任务>"
                   （worktree 成员 cd 到独立 git worktree）
```

## 安装

把本目录复制到 `~/.pi/agent/extensions/`（全局）或受信任项目的 `.pi/extensions/`，然后在 Pi 中 `/reload`。也可 `pi -e ./agent-team` 临时加载。无构建步骤（Node ≥ 22.18 原生 type-stripping），无运行时 npm 依赖。`/reload`（以及 new/resume/fork/switch）后扩展会重新注册全部工具与命令——双加载守卫在 `session_shutdown` 时自动复位。

## 用法

### 1. 对话式建团（推荐）

直接对主 agent 说："帮我建一个团队，leader 用 opus 负责拆解审查，两个成员分别用 chatanywhere/gpt-5.6 写前端、claude-sonnet 写后端"。主 agent 会调用 `team_create` 工具落盘创建团队文件；`team_list` 可查看已有团队。创建成功后立即可派单（发现逻辑不缓存）。

### 2. 团队定义文件（可手写、可手改）

`~/.pi/agent/teams/*.md`（全局）或 `<项目>/.pi/teams/*.md`（项目，需信任；同名项目覆盖全局）。示例见 [examples/dev-team.example.md](examples/dev-team.example.md)：

```markdown
---
name: dev-team
description: 全栈开发小队
worktree: true              # 可选：整个团队在共享 git worktree 中工作（每次 run 独立分支）
budget:                     # 可选：每次 run 的预算上限（不配用默认：12 次 dispatch / 40 次成员运行，费用与 tokens 无限）
  maxDispatchCalls: 20      # 最多派发多少次 team_dispatch
  maxMemberRuns: 60         # 最多多少次成员运行（含派发失败）
  maxCostUsd: 5.0           # 累计费用超限 → 自动中止（BUDGET_EXCEEDED）
  maxTotalTokens: 1000000   # 累计 tokens（input+output）超限 → 自动中止
leader:
  model: anthropic/claude-opus-4-5
  prompt: |
    你是技术负责人。收到任务后：拆解 → 派发 → 审查 → 汇总。
members:
  - name: frontend
    description: 前端开发
    model: chatanywhere/gpt-5.6
    tools: [read, edit, bash]
    prompt: |
      你是资深前端工程师，使用 TypeScript……
  - name: backend
    description: 后端开发
    model: anthropic/claude-sonnet-4-5
    worktree: true          # 覆盖团队共享：该成员用独立 git worktree
    prompt: |
      你是资深后端工程师……
---

团队级补充说明正文（会追加到 leader 的 system prompt）。
```

要点：
- **leader.prompt 是整个功能的核心入口**——你在这里教 leader 如何完成任务（拆解策略、派发规则、验收标准）。扩展会自动追加团队花名册、`team_dispatch` 用法与最终报告格式。
- **leader 默认拥有全部内置工具**（读写文件、bash 等）。若要限制 leader 亲自动手（例如只让它拆解派发），在团队文件里设置 `leader.tools`（如 `tools: [read, grep, find, ls]`）。实测中 leader 可能会用编辑工具自行"降级代写"或修订团队配置——不希望如此就收紧它的工具。
- **worktree 三种模式**：都不配 = 在当前目录工作；团队根级 `worktree: true` = 整个 run 在共享 worktree `~/.pi/agent/teams/worktrees/<runId>/team`（分支 `team/<runId>`）；成员级 `worktree: true` = 该成员独立 worktree（分支 `team/<runId>/<member>`，优先于团队配置）。改动都留在分支上**不自动合并**，结果中附路径与分支名。启动前有预检：需要 worktree 而当前目录不是 git 仓库时直接报错，不会启动 leader。
- **模型预检**：派单前会先对 leader + 全体成员的 `provider/id` 做一次注册表预检——引用不存在的模型直接报 `MODEL_NOT_FOUND`（不启动任何子进程，提示先调 `team_models`）；存在但未配置鉴权的模型放行并警告。成员不配 model 则用 pi 默认模型（无从预检）。
- 文件是唯一事实来源：手改后下一次派单即生效（leader 运行中使用启动时的花名册快照，运行中改文件不影响当次 run）；删除文件即删除团队（`/reload` 后动态命令消失）。

### 3. 派单与复用

| 方式 | 说明 |
|---|---|
| `/team:run <团队名> <任务>` | **后台运行**：命令立即返回，主会话可继续对话；输入栏下方亮块实时显示进度（见 §4），完成后报告自动送入会话 |
| `/team:<团队名> <任务>` | 等价快捷方式（`/reload` 后对新团队生效） |
| `team_run` 工具 | 让主 agent 自主派单——**默认后台**：立即返回（含 runId，`team_stop` 的中止句柄），报告完成后自动送达会话（followUp）；`wait: true` 同步等待整个 run 并内联返回报告（阻塞主会话，不推荐） |
| `team_stop` 工具 | 让主 agent 按 runId 中止后台 run（与 `/team:stop` 同一停止原语 + **settle-aware**：有界等待 leader 落定后返回 aborted 终态记录；停止后该 run 的报告 followUp 不再送达；可立即重新派单）。runId 必填：省略 `RUN_ID_REQUIRED`、未知 `RUN_NOT_FOUND`、已结束 `RUN_ALREADY_FINISHED`（均类型化错误，不抛异常） |

同一团队可反复派单复用。运行记录以 `agent-team-run-v1` entry 持久化（含各成员结果摘要、token/费用统计）。

**主 agent 忙碌时的按键语义**（宿主行为，派长任务前值得知道）：`enter`=排队（steering，当前轮次边界处理）、`alt+enter`（Windows `ctrl+q`）=followUp、`esc`=**中断当前 run 并把排队消息退回编辑器**（慎用）。因此派单请优先走后台：`/team:run`，或 team_run 工具默认（主 agent 轮次立即结束，报告完成后作为新轮次自动送回，等待期间正常对话）。查进度：`team_status` 工具、`/team:status`，或下方亮块 `alt+↓ → enter` 直达查看器。

其它命令：`/team` 列出全部团队（含无效文件警告）；`/team:status` 查看当前/最近一次 run 的详细快照（含 runId，每个成员在做什么、轮次、费用、worktree、预算消耗）；`/team:stop` 中止当前 run（SIGTERM → SIGKILL 逐级终止 leader 与成员）；`/team:view` **全屏会话记录查看器**（见下节）；`/team:clear` 清除输入栏下方的 run 亮块（见 §4）；`/team:doctor` **自检报告**（运行模式/团队发现/逐团队模型预检/运行目录残留/逐团队预算/worktree 可用性）。

### 4. 进度亮块（输入栏下方，可键盘选中）

派单后进度块出现在**输入栏下方**（`placement: "belowEditor"`），刻意保持**紧凑两行**：头行 `agent-team <团队> ▶ running · 耗时 · N/M 并行` + 任务行（44 字符截断）；leader 活动与各成员明细**不进亮块**——想看细节 `enter` 进查看器。run 结束后切终态行（`✓/✗/⊘ <status> · 耗时 · 费用`），失败附一条截断错误行，不残留 "running" 字样。终态行会一直保留（可回看）；不需要时用 `/team:clear` 手动清除——run 进行中会拒绝（先 `/team:stop` 或等结束），只卸亮块不清运行记录（`/team:status`、`/team:view` 回看不受影响）；清除后再次派单会自动重挂。`/reload` 后水合仅在存在**进行中** run 时自动挂亮块，终态记录不再自动重挂。

裸 `↑`/`↓` 平时归编辑器（光标移动/历史记录/发送消息），因此选中是**模态**的。对齐 pi-subagents fleet-status（v0.66.0）：**编辑器为空时** `↓`/`←` 也可进入选中；`alt+↓`/`alt+↑` 是不受门控的第二通道（编辑器有文本也能进）。选中态导航补 `j`/`k`（对齐 fleet roster）：

| 按键 | 作用 |
|---|---|
| `↓`/`←`（编辑器为空）或 `alt+↓`/`alt+↑` | 进入选中：亮块高亮，出现行光标与按键提示行 |
| `↑`/`↓`、`j`/`k` | 在行间移动光标（首末行钳位） |
| `enter` | 打开 `/team:view` 查看器（定位 leader 页，`←→`/`1-9` 切成员） |
| `esc` | 退出选中 |
| 其它任意键 | 退出选中，并把该键**原样交还编辑器**（打字、ctrl+c 不受影响） |

实现：`setWidget(key, string[], { placement: "belowEditor" })` 每秒刷新（宿主自行包装渲染，是跨宿主构建最稳的路径；组件工厂式逐帧重绘在某个 bundle 构建的宿主上会产生逐秒追加的残影行）；选中经 `ctx.ui.onTerminalInput`（特性检测，宿主不支持时自动降级为纯展示）在编辑器之前拦截按键 + 纯函数 reducer 处理；渲染串指纹无变化时跳过 `setWidget`（对齐 fleet-status renderKey，静止内容不空转宿主）；查看器 overlay 打开期间自动旁路；`PI_AGENT_TEAM_WIDGET=0` 可整体关闭亮块。TUI 行为逐细节对照 pi-subagents fleet 同步，矩阵见 [docs/tui-sync.md](docs/tui-sync.md)。

### 5. 会话记录查看器（/team:view）与成员 transcript

派单后随时执行 `/team:view`（仅交互式 TUI）打开**全屏分栏查看器**（fleet inspector 同款布局：左栏成员 roster，右栏运行详情，约 85% 终端高、95% 宽，完整边框与主 agent 界面明确分割；终端窄于 36 列时仅提示不渲染）。左栏是成员 roster（选中行 `›` 标记 + 状态图标 + 名称 + actor id，右对齐状态文本；选中滚出可见区时列表跟随滚动）。右栏顶部是固定的三行元信息头（`Run:` / `State:` / `成员:`），下方是选中成员的完整连续会话流：派发的任务（用户气泡样式）→ assistant 回复全文（主 agent 同款 Markdown 渲染，带 dim 小标签）→ 连续合并的工具调用行 → 错误与结束状态，实时刷新（run 结束后仍可查看）。参考 pi-subagents 的 fleet inspector 交互：

| 按键 | 作用 |
|---|---|
| `↑`/`↓` 或 `j`/`k` | 逐行滚动右栏转录正文（上滚自动退出跟随，滚到底自动恢复跟随最新） |
| `PgUp`/`PgDn` | 翻页 |
| `g`/`G`（或 `Home`/`End`） | 跳到顶部 / 跟随底部最新 |
| `←`/`→`、`h`/`l`、`Tab` | 切换上/下一个成员（左栏 roster 选中行移动，右栏随之切换） |
| `1`–`9` | 直接跳到第 N 个成员 |
| `x` | 显示/隐藏工具调用行 |
| `D`（shift+d） | 停止整个 run（两步确认，对齐 fleet）：运行中按下进入确认态（右栏头部下方横幅 `确认停止 run <runId>？`），`Enter`/`Y` 确认、`N`/`Esc`/`ctrl+c`/`backspace` 取消（取消不关闭查看器）；确认后经 `stopAndSettle()` 中止 leader 与全体成员（SIGTERM→SIGKILL、有界等待落定），横幅依次显示停止中→结果（settled → `run 已停止（aborted · Xs）；该 run 的报告不再送达`，未落定 → 提示稍后用 `/team:status` 确认终态）；run 已结束时按下仅提示，不进确认态 |
| `r` / `R` | 手动刷新：绕过 750ms 指纹门控强制重载重绘 |
| `q` / `Esc` / `ctrl+c` | 关闭查看器（close 键集对齐 fleet） |

实现机制（run artifacts）：每个 run 在 `~/.pi/agent/teams/runs/<runId>/` 下保留每个成员一份有界 JSONL 流水（leader 为 `_leader.jsonl`）——leader 侧事件由驾驶舱从 leader 子进程 JSON 流写入，成员侧由 leader 进程内的 dispatch 执行器实时写入，查看器与工具按需读取。单条记录封顶 4KB、单文件 2MB、目录保留 7 天（session 启动时自动清理）。全部落盘 best-effort，记录失败绝不影响 run 本身。

对话内查看：主 agent 可调用 `team_transcript` 工具（`member` 参数指定成员名或 `leader`）读取同样的记录并转述要点；`team_status` 之外想深入某个成员"到底做了什么"时用它。动态命令 `/team:<name>` 不会覆盖内置的 `/team:run|status|stop|view`。

### 防失控与失败可见性

- 每个成员的失败会显示**具体原因**（不只错误码），Widget、进度流和派发报告中都可见。
- 派发报告对环境级失败（worktree/git 不可用、成员/模型不存在）附带指令：重试无效，不要再次派发同一成员。
- **派发预算**：单次 run 最多 12 次 dispatch 调用 / 40 次成员运行（可用团队文件 `budget:` 块调整）；超限后 team_dispatch 返回错误并强制 leader 立即输出最终报告，杜绝无限重试循环。
- **费用/token 硬上限**（可选）：`budget.maxCostUsd` / `budget.maxTotalTokens` 超限时整个 run 自动中止（`BUDGET_EXCEEDED`），累计值 = leader 轮次 + 全部成员 usage，`/team:status` 运行态显示预算行（如 `预算: $0.42/$5.00 · 2/12 派发 · 5/40 成员`），亮块头行在设了费用上限时显示余额提示。
- **崩溃恢复**：每个 run 的元数据快照（`status.json`，含 leader PID）落盘在 `~/.pi/agent/teams/runs/<runId>/`；主会话中断后下次启动自动把残留 running 翻成 failed 记录并警告（孤儿 leader **只诊断不杀**，PID 可能复用，请人工确认后处理）；`/team:doctor` 可查看全部残留与损坏文件。

## 命令与工具一览

- 主会话工具：`team_models`（列出可用供应商/模型——建团前必看）、`team_create`（建团）、`team_list`（查团队）、`team_run`（派单，含 model 预检）、`team_status`（查运行状态，含 runId 与预算）、`team_stop`（按 runId 中止）、`team_transcript`（读成员/leader 会话记录）
- leader 进程内工具：`team_dispatch`（派发子任务给成员，带预算保护）
- 命令：`/team`、`/team:run`、`/team:status`、`/team:stop`、`/team:view`、`/team:clear`、`/team:doctor`、动态 `/team:<name>`
- Widget：输入栏下方可选中亮块（紧凑两行概要）——`alt+↓` 选中、`enter` 直达查看器（仅 TUI 模式，详见 §4）
- `/team:view`：全屏分栏会话记录查看器——左栏成员 roster、右栏成员对话/工具调用/错误实时可读（仅交互式 TUI）

## 开发与测试

```bash
cd agent-team
npm install
npm test          # node --test test/*.test.ts（223 个测试，含真实 git worktree 测试）
npm run typecheck # tsc -p tsconfig.json --noEmit
```

测试可用 `PI_AGENT_TEAM_RUNS_DIR` 把 run artifacts 根（status.json + transcripts）重定向到临时目录，避免污染真实的 `~/.pi/agent/teams/runs`（host 级测试已内置）。

### 与 pi-subagents 的 TUI 同步

本扩展的 TUI（viewer / widget / cockpit 状态行 / index 接线）对照 pi-subagents 的 fleet 家族（当前基线 v0.66.0）**代码级同步**：同步≠依赖（不 import pi-subagents），以“对照抄改 + 单测锁定”方式维护。逐文件映射、对齐维度、差异处置与测试期望值的**唯一事实来源**见 [docs/tui-sync.md](docs/tui-sync.md)——pi-subagents 每升版一次，agent-team 跟进一次并登记新版本号。

测试约定与仓库一致：`node:test` + `node:assert/strict`、手写 FakeChild 进程 fake、注入时钟、真实 git 只用于 worktree 用例（临时目录，自动清理）。

## 设计说明

- 零构建 TS ESM；entry `index.ts` 默认导出工厂；通过环境变量 `PI_AGENT_TEAM_FILE` 区分 leader 模式（只注册 `team_dispatch`）与驾驶舱模式（注册命令/工具/Widget）——同一份代码两种形态。
- 成员子进程与 pwr 的 `PiAgentRunner`、官方 subagent 扩展同模式：`--mode json -p --no-session`、行 JSON 事件流解析（usage/stopReason/finalText）、`team-tmp://` prompt 物化为 0600 临时文件、SIGTERM→SIGKILL 中止。本扩展自包含，不 import pwr。
- 结果截断：单成员结果 50KB、摘要 8KB；错误按成员隔离（单个成员失败不拖垮整次 dispatch）。
- 已知限制（v1）：任务为纯文本（GitHub issue 输入、成员后端适配外部 CLI 如 codex/claude-code 预留后续）；worktree 不自动合并；无超时（手动 `/team:stop`）。
