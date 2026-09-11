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
- 文件是唯一事实来源：手改后下一次派单即生效（leader 运行中使用启动时的花名册快照，运行中改文件不影响当次 run）；删除文件即删除团队（下次派单/列表即生效，无注册缓存）。

### 3. 派单与复用

| 方式 | 说明 |
|---|---|
| `/team:run <团队名> <任务>` | **后台运行**（唯一派单命令）：命令立即返回，主会话可继续对话；输入栏下方亮块实时显示进度（见 §4），完成后报告自动送入会话；团队增删即时生效（无注册缓存），团队名可与子命令同名（保留词概念已退役） |
| `/team` · `/team:list` | 无参 `/team`（或 `/team:list`）列出全部团队（含无效文件警告） |
| `team_run` 工具 | 让主 agent 自主派单——**默认后台**：立即返回（含 runId，`team_stop` 的中止句柄），报告完成后自动送达会话（followUp）；`wait: true` 同步等待整个 run 并内联返回报告（阻塞主会话，不推荐） |
| `team_stop` 工具 | 让主 agent 按 runId 中止后台 run（与 `/team:stop` 同一停止原语 + **settle-aware**：有界等待 leader 落定后返回 aborted 终态记录；停止后该 run 的报告 followUp 不再送达；可立即重新派单）。runId 必填：省略 `RUN_ID_REQUIRED`、未知 `RUN_NOT_FOUND`、已结束 `RUN_ALREADY_FINISHED`（均类型化错误，不抛异常） |

同一团队可反复派单复用。运行记录以 `agent-team-run-v1` entry 持久化（含各成员结果摘要、token/费用统计）。

**主 agent 忙碌时的按键语义**（宿主行为，派长任务前值得知道）：`enter`=排队（steering，当前轮次边界处理）、`alt+enter`（Windows `ctrl+q`）=followUp、`esc`=**中断当前 run 并把排队消息退回编辑器**（慎用）。因此派单请优先走后台：`/team:run`，或 team_run 工具默认（主 agent 轮次立即结束，报告完成后作为新轮次自动送回，等待期间正常对话）。查进度：`team_status` 工具、`/team:status`，或下方亮块 `alt+↓ → enter` 直达查看器。

其它命令（冒号命令面，v1.12.0）：`/team`（无参列团队；带参显示用法）与 `/team:list`；`/team:status` 查看当前/最近一次 run 的详细快照（含 runId，每个成员在做什么、轮次、费用、worktree、预算消耗；任务行先压平换行（连续空白 → 单空格）再按显示宽度截断到 60 列（CJK 双宽，超宽补 `…`，整行 ≤66 列），`team_status` 工具共用同一口径）；`/team:stop` 中止当前 run（SIGTERM → SIGKILL 逐级终止 leader 与成员）；`/team:view` **全屏会话记录查看器**（见下节）；`/team:clear` 丢弃排队的 viewer 对话消息（亮块随 run 结束自动隐藏，见 §4）；`/team:doctor` **自检报告**（运行模式/团队发现/逐团队模型预检/运行目录残留/逐团队预算/worktree 可用性）。旧空格写法（`/team run` 等）只提示改名、不再执行。

### 4. 进度亮块（输入栏下方，可键盘选中）

**派单后**进度块出现在**输入栏下方**（`placement: "belowEditor"`），默认保持 fleet-status 同款**折叠单行**；**run 落定后自动消失**（数据驱动挂载/卸载：有活跃 run 才挂帧，全部落定即 `setWidget(undefined)` 卸载，不再常驻终态行）：

```text
agent-team dev-team · ↓/← 查看详情
```

按 `↓`/`←`（焦点在主编辑器且编辑器为空）或 `alt+↓`/`alt+↑` 展开为 **team/成员树**（单 run 单 team；`main` = 主 agent 根节点，leader 行内嵌任务摘要，成员挂在其下；**末行恒为成员行**）：

```text
main
leader dev-team · 重构登录模块并补齐单测 ▶ running · 3m12s · 2/3 并行
  |- frontend ● running · 正在改 login.tsx
  |- backend ✓ done
  |- reviewer · queued
↑↓ 选择 · enter 查看 · esc 退出
```

- leader 行：`leader <团队> · <任务摘要> ▶ running · 耗时 · N/M 并行`（配了费用上限且未超限时附 ` · 剩 $X.XX`）；任务摘要 44 字符截断，多行文本先压平。
- 成员行：`|- <成员名> <图标> <状态>[ · <尾注>]`；图标 `·` queued / `●` running / `✓` done / `✗` failed / `⊘` aborted；尾注取 note，否则取最新活动，压平换行后 ≤30 字符。
- 任务摘要不占独立行（v1.13.1，用户真机反馈）：否则末行是任务行、`enter` 却打开 leader，像“选不中成员”的陷阱；现在 `↓`/`j` 到底就是最后一个成员，`enter` 直达该成员。
- `esc` 或第 0 行再按 `↑`/`k` 收回折叠；`enter` 在 `main` 行只收起选中，在 leader/成员行打开查看器并定位到对应 actor。
- 大团队（成员 ≥7）展开态自动窗口化（v1.14.2）：帧总行数不超过宿主 `string[]` widget 的 10 行硬上限（超出会被宿主播成 `... (widget truncated)`），选中行永远在窗口内，隐藏侧显示 `  … 上方/下方还有 N 行`。

```text
改动前（常显多行；任务里的换行被宿主渲染成残行、终态行常驻到手动清除）：
  agent-team count-duet ✓ completed · 26.8s · $0.0060
▸ 任务: 目标: 输出小写单词 hello。
特别注意：这是对 count-duet 的一次复用任…
↑↓ 选择 · enter 查看 · esc 退出

改动后（默认折叠单行；按 ↓/← 或 alt+↓ 展开为 main→leader→成员树；落定自动消失）：
agent-team count-duet · ↓/← 查看详情
```

结束不需要手动清理：**run 落定（completed/failed/aborted）即自动卸载亮块**；`/team:status`、`/team:view`、runstore 记录不受影响。`/team:clear` 保留为清排队对话的入口：run 进行中拒绝（先 `/team:stop` 或等结束），否则丢弃排队中的 viewer 对话消息并提示（无排队时提示「亮块随 run 结束自动隐藏，没有可清除的内容」）。

裸 `↑`/`↓` 平时归编辑器（光标移动/历史记录/发送消息），因此选中是**模态**的。对齐 pi-subagents fleet-status（v0.66.0）：**焦点在主编辑器且编辑器为空时** `↓`/`←` 才可进入选中；`alt+↓`/`alt+↑` 是不受门控的第二通道（编辑器有文本也能进）。**焦点不在编辑器时 widget 完全不介入**（对齐 fleet `editorHasFocus`，v1.9.1）：`/login`、`/model`、`/settings` 等选择器或 `ctx.ui.select`/overlay 对话框打开期间，方向键原样让给选择器（含 alt 通道），已进入的选中态自动退出。选中态导航补 `j`/`k`（对齐 fleet roster）：

| 按键 | 作用 |
|---|---|
| `↓`/`←`（焦点在主编辑器且编辑器为空）或 `alt+↓`/`alt+↑` | 从折叠单行**展开**亮块：出现行光标与按键提示行 |
| `↑`/`↓`、`j`/`k` | 在行间移动光标（底部钳位）；第 0 行再按 `↑`/`k` **退出选中并收回折叠**（fleet-status 同构） |
| `enter` | `main` 行只收起选中；leader/成员行打开 `/team:view` 查看器并定位到该 actor（查看器内 `↑↓/j/k` 切成员） |
| `esc` | 退出选中并收回折叠 |
| 其它任意键 | 退出选中，并把该键**原样交还编辑器**（打字、ctrl+c 不受影响） |

实现：`setWidget(key, string[], { placement: "belowEditor" })`——**数据驱动挂载**：controller 每会话挂一次（`session_start` 无条件），宿主 widget 注册由快照决定（`running` ⇒ string[] 帧；落定 ⇒ `setWidget(key, undefined)` 卸载）；**刷新双触发**：coordinator `onProgress` 状态变化点事件即时重绘 + 1s aligned ticker（`aligned-ticker.ts`，契约 `docs/cross/status-bar.md`）兜底，渲染串指纹无变化即跳过 `setWidget`（对齐 fleet-status renderKey；折叠行不含时间 → 未展开时不逐秒 churn）；宿主自行包装渲染是跨宿主构建最稳的路径（组件工厂式逐帧重绘在某个 bundle 构建的宿主上会产生逐秒追加的残影行，`docs/tui-sync.md` §3.1）；行投影 `buildWidgetView` 产出「折叠单行 + 展开树」（`main`/`leader`（含任务摘要）/成员行），`renderWidgetView` 按 `selected` 选分支（大团队展开态窗口化：帧 ≤ 宿主 `MAX_WIDGET_LINES = 10`、选中行恒在窗口内、隐藏侧 `… 上方/下方还有 N 行`）；任务摘要/成员尾注文本先 `\s+` 压平再截断（多行任务不再产生残行）；选中经 `ctx.ui.onTerminalInput`（特性检测，宿主不支持时自动降级为纯展示）在编辑器之前拦截按键 + 纯函数 reducer 处理（reducer 顶部 `isKeyRelease` 过滤 Kitty 协议 release 事件，一次按键只生效一次；repeat 保留供长按连续移动）；焦点判定经挂载时一次性的 factory 形态 `setWidget` 捕获宿主 TUI（`probeEditorFocus`：`getFocusedComponent()` 优先、`focusedComponent` 字段回退，五方法结构判定编辑器形状；宿主无焦点信息时降级）；查看器 overlay 打开期间自动旁路；`PI_AGENT_TEAM_WIDGET=0` 可整体关闭亮块。TUI 行为逐细节对照 pi-subagents fleet 同步，矩阵见 [docs/tui-sync.md](docs/tui-sync.md)。

### 5. 会话记录查看器（/team:view）与成员 transcript

派单后随时执行 `/team:view`（仅交互式 TUI）打开**全屏分栏查看器**（fleet inspector 同款布局：左栏成员 roster，右栏运行详情，约 85% 终端高、95% 宽，完整边框与主 agent 界面明确分割；终端窄于 36 列时仅提示不渲染）。左栏是成员 roster（选中行 `›` 标记 + 状态图标 + 名称 + actor id，右对齐状态文本；选中滚出可见区时列表跟随滚动）。右栏顶部是固定的四行元信息头（`Run:` / `State:` / `成员:` / `模型:`——模型为选中 actor 的后端：leader 显示子进程实际上报值、成员显示团队文件声明值，未声明时显示 `（默认）`），下方是选中成员的完整连续会话流：派发的任务（用户气泡样式）→ assistant 回复全文（主 agent 同款 Markdown 渲染，带 dim 小标签）→ 连续合并的工具调用行 → 错误与结束状态，实时刷新（run 结束后仍可查看）。参考 pi-subagents 的 fleet inspector 交互：

| 按键 | 作用 |
|---|---|
| `↑`/`↓` 或 `j`/`k` | 切换上/下一个成员（左栏 roster 选中行移动，右栏随之切换；切换重置滚动并跟随最新；首末钳位；键位对齐 fleet selectUp/selectDown） |
| `Home`/`End` | 跳到第一个 / 最后一个成员（fleet `moveSelection(±items.length)` 同构） |
| `Shift+K`/`Shift+J` | 逐行滚动右栏转录正文（上滚自动退出跟随，滚到底自动恢复跟随最新；键位对齐 fleet scrollUp/scrollDown） |
| `PgUp`/`PgDn` | 翻页（视口 = 右栏实际可见行数） |
| `x` / `X` / `ctrl+o` | 显示/隐藏工具调用行（键位对齐 fleet toggleTools） |
| `m` | 发消息给当前选中的成员/leader（进入右栏输入行，详见下段） |
| `D`（shift+d） | 停止整个 run（两步确认，对齐 fleet）：运行中按下进入确认态（右栏头部下方横幅 `确认停止 run <runId>？`），`Enter`/`Y` 确认、`N`/`Esc`/`ctrl+c`/`backspace` 取消（取消不关闭查看器）；确认后经 `stopAndSettle()` 中止 leader 与全体成员（SIGTERM→SIGKILL、有界等待落定），横幅依次显示停止中→结果（settled → `run 已停止（aborted · Xs）；该 run 的报告不再送达`，未落定 → 提示稍后用 `/team:status` 确认终态）；run 已结束时按下仅提示，不进确认态 |
| `r` / `R` | 手动刷新：绕过 750ms 指纹门控强制重载重绘 |
| `q` / `Esc` / `ctrl+c` | 关闭查看器（close 键集对齐 fleet） |

v1.8.0 起旧键 `←→/h/l/Tab/1-9/g/G` 退役（按下忽略不改状态）；键位全集逐字对齐 pi-subagents `DEFAULT_FLEET_KEYBINDINGS`（v0.66.0 `fleet.ts:33-48`），仅保留 `m` 发消息一个特有键，见 `docs/tui-sync.md` §3.2。

实现机制（run artifacts）：每个 run 在 `~/.pi/agent/teams/runs/<runId>/` 下保留每个成员一份有界 JSONL 流水（leader 为 `_leader.jsonl`）——leader 侧事件由驾驶舱从 leader 子进程 JSON 流写入，成员侧由 leader 进程内的 dispatch 执行器实时写入，查看器与工具按需读取。单条记录封顶 4KB、单文件 2MB、目录保留 7 天（session 启动时自动清理）。全部落盘 best-effort，记录失败绝不影响 run 本身。

**与成员/leader 直接对话（`m` 发消息，v1.6.0；leader 运行中插话 v1.15.0）**：选中某个 actor 后按 `m` 进入右栏头部下方单行输入（`❯ <内容>▏`），可打印字符（含 CJK）追加、backspace 删字、`Esc`/`ctrl+c` 只退出输入（不关查看器）、`Enter` 提交。**目标 = leader 且 run 运行中**：leader 子进程以 `--mode rpc` 拉起，cockpit 持有其 stdin，消息以 RPC `steer` 发出——pi 在当前助手回合执行完工具调用后、下次 LLM 调用前送达（当前任务不被打断），回复出现在本 run 的 transcript 里；提交 notice 为「已插话给 leader（steer）：不打断当前任务，leader 会在当前回合结束后尽快回应」。其余情况走**派单语义**：每条消息编成一个新 run 的 task（leader 直发；成员则指示 leader 转派并附该成员 transcript 尾部 ~2000 字节作上文，派出时刻现读不缓存）——成员子进程归 leader 派生、驾驶舱无通道注入，因此仍走此路径；复用 `startBackgroundRun`（含 model 预检）派出；当前 run 在跑则消息**排队**，run 落定（completed）后自动链式派出，run failed/aborted 则清空队列（用户变卦语义，与 `team_stop`/viewer `D`/`/team:clear` 一致——显式停止也清队列并提示丢弃条数）。回复经新 run 的 transcript 在查看器里展示（选中页跟随最新 run），报告照常 followUp 送达主会话。队列驻留在会话内存不落盘，`/reload` 后丢失可接受。

对话内查看：主 agent 可调用 `team_transcript` 工具（`member` 参数指定成员名或 `leader`）读取同样的记录并转述要点；`team_status` 之外想深入某个成员"到底做了什么"时用它。统一路由下不存在动态命令覆盖问题：首 token 是保留词即子命令，否则才是团队名。

### 防失控与失败可见性

- 每个成员的失败会显示**具体原因**（不只错误码），Widget、进度流和派发报告中都可见。
- 派发报告对环境级失败（worktree/git 不可用、成员/模型不存在）附带指令：重试无效，不要再次派发同一成员。
- **派发预算**：单次 run 最多 12 次 dispatch 调用 / 40 次成员运行（可用团队文件 `budget:` 块调整）；超限后 team_dispatch 返回错误并强制 leader 立即输出最终报告，杜绝无限重试循环。
- **费用/token 硬上限**（可选）：`budget.maxCostUsd` / `budget.maxTotalTokens` 超限时整个 run 自动中止（`BUDGET_EXCEEDED`），累计值 = leader 轮次 + 全部成员 usage，`/team:status` 运行态显示预算行（如 `预算: $0.42/$5.00 · 2/12 派发 · 5/40 成员`），亮块展开头行在设了费用上限时显示余额提示（折叠行不含）。
- **崩溃恢复**：每个 run 的元数据快照（`status.json`，含 leader PID）落盘在 `~/.pi/agent/teams/runs/<runId>/`；主会话中断后下次启动自动把残留 running 翻成 failed 记录并警告（孤儿 leader **只诊断不杀**，PID 可能复用，请人工确认后处理）；`/team:doctor` 可查看全部残留与损坏文件。

## 命令与工具一览

- 主会话工具：`team_models`（列出可用供应商/模型——建团前必看）、`team_create`（建团）、`team_list`（查团队）、`team_run`（派单，含 model 预检）、`team_status`（查运行状态，含 runId 与预算）、`team_stop`（按 runId 中止）、`team_transcript`（读成员/leader 会话记录）
- leader 进程内工具：`team_dispatch`（派发子任务给成员，带预算保护）
- 命令：裸 `/team`（无参=列团队；带参=用法）+ 独立冒号命令 `/team:list`/`:run`/`:status`/`:stop`/`:view`（内含 `m` 发消息直接对话）/`:clear`/`:doctor`；派单统一 `/team:run <团队名> <任务>`（团队名可与子命令同名，v1.12.0 保留词概念退役）
- Widget：输入栏下方可选中亮块（数据驱动：有活跃 run 才挂帧、落定自动卸载；默认折叠单行，`↓`/`←`（空编辑器+编辑器焦点）或 `alt+↓` 展开为 `main → leader（含任务摘要）→ 成员` 树，末行恒为成员行）——`main` 行 `enter` 只收起选中，leader/成员行 `enter` 直达查看器对应 actor（仅 TUI 模式，详见 §4）
- `/team:view`：全屏分栏会话记录查看器——左栏成员 roster、右栏成员对话/工具调用/错误实时可读（仅交互式 TUI）

## 开发与测试

```bash
cd agent-team
npm install
npm test          # node --test test/*.test.ts（356 个测试，含真实 git worktree 测试）
npm run typecheck # tsc -p tsconfig.json --noEmit
```

测试可用 `PI_AGENT_TEAM_RUNS_DIR` 把 run artifacts 根（status.json + transcripts）重定向到临时目录，避免污染真实的 `~/.pi/agent/teams/runs`（host 级测试已内置）。

### 与 pi-subagents 的 TUI 同步

本扩展的 TUI（viewer / widget / cockpit 状态行 / index 接线）对照 pi-subagents 的 fleet 家族（当前基线 v0.66.0）**代码级同步**：同步≠依赖（不 import pi-subagents），以“对照抄改 + 单测锁定”方式维护。逐文件映射、对齐维度、差异处置与测试期望值的**唯一事实来源**见 [docs/tui-sync.md](docs/tui-sync.md)——pi-subagents 每升版一次，agent-team 跟进一次并登记新版本号。

测试约定与仓库一致：`node:test` + `node:assert/strict`、手写 FakeChild 进程 fake、注入时钟、真实 git 只用于 worktree 用例（临时目录，自动清理）。

### 文档截图（无头真实渲染）

`tools/capture-screens.mjs` 把真实 `TuiMainScreen` + 真实 `TranscriptViewer` 接到一个记录字节流的 headless 终端上，把渲染器写出的 ANSI 还原成字符网格并输出 SVG 到 `../docs/assets/`（根 README 内嵌）。不需要真机终端窗口、不需要人工抓屏，产物可重复生成、可 diff；`tools/vt-screen.mjs` 是带样式追踪的最小 VT 仿真屏（与 `test/viewer-host.test.ts` 的 FakeScreen 同源、互不依赖）。帧锚点自检失败时工具直接报错退出——渲染路径变了，截图就不许悄悄过期。

同一工具也是**工作区级**截图管线：第二个场景导入 `../pwr/src/ui/viewer.ts` 的真实 `RunViewer`，输出 `../docs/assets/pwr-viewer.svg`（pwr 卡「改动清单」指向它）；第三个场景是**亮块**（输入栏下方 widget）：文字取真实 `buildWidgetView` + `renderWidgetView`（运行时 `setWidget` 推送的同一份 string[]），上方放真实 pi-tui `Editor`（宿主 `CustomEditor` 的基类），widget 的屏上包装照抄宿主 `setExtensionWidget` 对 string[] 的确切代码路径（`Container` + `Text(line, 1, 0)`，每行 1 列缩进），输出 `../docs/assets/agent-team-widget.svg`。为第二个插件复制一份 VT 仿真屏不值得——跨插件只发生在 dev 工具里，运行时仍互不 import。

## 设计说明

- 零构建 TS ESM；entry `index.ts` 默认导出工厂；通过环境变量 `PI_AGENT_TEAM_FILE` 区分 leader 模式（只注册 `team_dispatch`）与驾驶舱模式（注册命令/工具/Widget）——同一份代码两种形态。
- 成员子进程与 pwr 的 `PiAgentRunner`、官方 subagent 扩展同模式：`--mode json -p --no-session`、行 JSON 事件流解析（usage/stopReason/finalText）、`team-tmp://` prompt 物化为 0600 临时文件、SIGTERM→SIGKILL 中止。本扩展自包含，不 import pwr。
- 结果截断：单成员结果 50KB、摘要 8KB；错误按成员隔离（单个成员失败不拖垮整次 dispatch）。
- 已知限制（v1）：任务为纯文本（GitHub issue 输入、成员后端适配外部 CLI 如 codex/claude-code 预留后续）；worktree 不自动合并；无超时（手动 `/team:stop`）。
