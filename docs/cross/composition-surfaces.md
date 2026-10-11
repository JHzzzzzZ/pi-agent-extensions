# 跨扩展横切契约：插件接触面清单（谁占了哪个槽）

> last verified @ 2c18af9
>
> 本表回答**唯一一个问题**：「哪个插件占了宿主的哪个共享槽位」——状态键、widget 槽、
> 内置工具名、`pi.events` 频道、拦截型宿主钩子、模型面、命令与快捷键。
> 细节（怎么用、载荷形状、fail-closed 口径）**不在这里**：状态条排序见 `status-bar.md`、
> shell 能力协商见 `shell-tool-capability.md`、免审批见 `solo-approval-gate.md`。
>
> 用途：① 人一眼看懂 17 个插件在哪些面上互相影响；② `tools/composition-surfaces.mjs`
> 读它做**完备性 + 声明有效性**校验并生成 L2 配对集合（`general-todo#32`，规格
> `docs/specs/composition-test-matrix.md`）。
>
> 维护规则（新增/修改插件时必须同步）：
> - **每个扩展目录都必须有一节**（含 `index.ts` 的目录才算扩展）；无注册面的写 `无注册面: true`。
> - 声明的键必须是**真实字符串字面量**且能在**该扩展自己的非测试源码**里找到（校验器正向检查）；
>   藏在常量里就把字面量写出来，可用「（常量: X）」标注来源——标注只是给人看的，校验认字面量。
> - 没有的字段写 `-`，不要省略整行（"没声明"与"声明为空"必须可区分）。
> - 校验：`node tools/composition-surfaces.mjs`（`--pairs` 看生成的配对）。

## 字段口径

| 字段 | 含义 | 参与配对 |
| --- | --- | --- |
| `状态键` | `ctx.ui.setStatus(<键>, …)` 的 footer 键（含 `10:`–`70:` 排序前缀） | 是（同名 ⇒ 冲突） |
| `widget` | `ctx.ui.setWidget(<键>, …)` 的宿主键 | 是（同名 ⇒ 同槽） |
| `widget 段键` | 排序带内的段 key（仅记录，不参与校验） | 否 |
| `工具` | 自己注册的**新**工具名 | 是（同名 ⇒ 冲突） |
| `工具面` | 顶掉/包装宿主内置工具，写 `replace:<内置名>` / `wrap:<内置名>` | 是（与 `工具` 同维度） |
| `events 广播` | 用 `pi.events.emit…` 发起的频道（能力索取/广播方） | 是（与订阅方配对） |
| `events 订阅` | 用 `pi.events.on` 订阅的频道 | 是（与广播方配对） |
| `宿主钩子` | `pi.on(<事件名>, …)` | **仅拦截型**参与配对：`tool_call` / `tool_result` / `input` / `before_agent_start` / `model_select` |
| `模型面` | `registerProvider` / `registerVirtualModel` 注册的 id | 是（同名 ⇒ 冲突） |
| `文件契约` | 与其它扩展共享的文件 / 环境变量契约（写其真实字面量，如 `PI_SOLO_MODE_FILE`） | 是（同值 ⇒ 配对） |
| `命令` | `pi.registerCommand(<名>)` | 是（同名 ⇒ 冲突） |
| `快捷键` | `pi.registerShortcut` 的绑定 | 是（同名 ⇒ 冲突） |
| `独占声明` | 该取值在宿主上**只能有一个主人**，本扩展是主人（工具名 / provider id / 命令名） | 否（L2 用它做冲突裁决） |
| `共享槽` | 该取值**可多方共享**，并写明共享契约（如排序带的段键顺序） | 否（L2 用它做冲突裁决） |
| `模式` | 加载期面随运行模式分叉（如 leader / cockpit），列出全部模式 | 否（L1 据此放宽"声明必注册"断言） |
| `会话生命周期` | `session_start` / `session_shutdown` 做什么、是否需要 revive | 否（由 L1/L2 的「可重入、无残留」断言覆盖） |
| `无注册面` | 除宿主钩子（`宿主钩子` 字段）外没有任何注册面；写了它就表示其余字段全为 `-` | 否 |

> **冲突裁决（L2 口径）**：两个插件在任一维度共享同一取值时，**双方都必须把它列进
> `独占声明` 或 `共享槽`**；否则视为未声明的真冲突 ⇒ L2 失败。生命周期钩子
> （`session_start` / `session_shutdown` / `session_compact`）人人都有，**不配对**——
> 否则矩阵退化成 O(n²) 且不产生新信息。

---

### pwr
状态键: `30:pwr`
widget: `widget-band`
widget 段键: `10:pwr-runs`
工具: workflow_validate, workflow_start, workflow_control, workflow_save
工具面: -
events 广播: -
events 订阅: -
宿主钩子: model_select, input, before_agent_start, session_start, session_shutdown, tool_call, tool_result
模型面: -
命令: workflow, workflow:run, workflow:delete, workflow:model, workflow:list, workflow:view, workflow:open, workflow:pause, workflow:resume, workflow:stop, workflow:restart, workflow:save, workflow:saved, workflow:script, workflow:approve, workflow:help
文件契约: PI_SOLO_MODE_FILE（只读消费方：免审批时批准卡自动通过，见 solo-approval-gate.md）
快捷键: ctrl+alt+z, ctrl+alt+x, ctrl+alt+r
独占声明: -
共享槽: widget-band（上方排序带，段键 10:pwr-runs 保证顺序，见 status-bar.md）, tool_call（拦截型钩子：脚本审批/工具面把关，与 jev-safe-gate 并存）, tool_result（观察型钩子：只做 trace 记录，与 dir-context 并存）, model_select（观察型：只读当前模型名）, PI_SOLO_MODE_FILE（solo-mode 写、本扩展只读）
模式: -
会话生命周期: `session_start` 水合批准/运行条目并 `runtime.revive()` 复活跨会话单例；`session_shutdown` 做 UI clear + `runtime.shutdown()`（**shutdown 后必须 revive，否则 `/new` 后永久抛错**）
无注册面: -

### agent-team
状态键: -
widget: `agent-team`
widget 段键: -
工具: team_create, team_dispatch, team_ask, team_list, team_models, team_resume, team_run, team_status, team_stop, team_transcript
工具面: -
events 广播: -
events 订阅: -
宿主钩子: session_start, session_shutdown
模型面: -
命令: team, team:list, team:run, team:resume, team:status, team:stop, team:view, team:clear, team:doctor
快捷键: -
独占声明: -
共享槽: -
模式: cockpit, leader
会话生命周期: `session_start` 水合历史 run、协调残留 running 状态文件、按数据挂 widget；`session_shutdown` 停协调器 + 清 widget，并删除全局双加载守卫 `__piAgentTeamExtensionLoaded`（不复位则 `/reload` 后工具全消失）
无注册面: -

### chatanywhere-provider
状态键: -
widget: -
工具: -
工具面: -
events 广播: -
events 订阅: -
宿主钩子: -
模型面: chatanywhere, chatanywhere-claude
命令: -
快捷键: -
独占声明: chatanywhere, chatanywhere-claude
共享槽: -
模式: -
会话生命周期: 无钩子（纯 provider 注册）
无注册面: -

### deep-init
状态键: -
widget: -
工具: -
工具面: -
events 广播: -
events 订阅: -
宿主钩子: -
模型面: -
命令: deep-init
文件契约: PI_SOLO_MODE_FILE（只读消费方：免审批时跳过二次确认，见 solo-approval-gate.md）
快捷键: -
独占声明: -
共享槽: PI_SOLO_MODE_FILE（solo-mode 写、本扩展只读）
模式: -
会话生命周期: 无钩子；经 `pi.sendMessage`（customType `deep-init-start`）下达初始化提示词
无注册面: -

### dir-context
状态键: `70:dir-context`
widget: -
工具: -
工具面: -
events 广播: pi-extensions:dir-context-remote-context:v2
events 订阅: -
宿主钩子: session_start, session_compact, session_shutdown, tool_result
模型面: -
命令: dir-context, dir-context:status
快捷键: -
独占声明: -
共享槽: tool_result（观察型钩子：只把触碰路径记进注入缓存，不改工具结果）
无注册面: -

### goal
状态键: `10:goal`
widget: -
工具: -
工具面: -
events 广播: -
events 订阅: -
宿主钩子: session_start, agent_start, turn_end, agent_end, agent_settled, session_shutdown
模型面: -
命令: goal, goal:status, goal:clear, goal:stop, goal:off, goal:reset, goal:none, goal:cancel, goal:resume
快捷键: -
独占声明: -
共享槽: -
模式: -
会话生命周期: `session_start` 从会话条目水合目标；`session_shutdown` 复位 idle、停状态时钟、移除 footer 段
无注册面: -

### human-notify
状态键: -
widget: -
工具: -
工具面: -
events 广播: -
events 订阅: -
宿主钩子: agent_start, agent_settled, agent_end, turn_end, message_end, ui_prompt_start, tool_execution_start, session_start
模型面: -
命令: -
快捷键: -
独占声明: -
共享槽: -
模式: -
会话生命周期: 仅挂 `session_start`（重置待通知文本，防跨会话泄漏）；无 shutdown 钩子，只派生一次性 detached 通知子进程
无注册面: true

### jev-safe-gate
状态键: `60:jev-safe-gate`
widget: -
工具: -
工具面: -
events 广播: -
events 订阅: -
宿主钩子: tool_call, session_start, session_shutdown
模型面: -
文件契约: PI_SOLO_MODE_FILE（只读消费方：读会话级免审批状态，fail-closed）
命令: -
快捷键: -
独占声明: -
共享槽: tool_call（拦截型钩子：只对危险命令 block/放行，fail-closed，与 pwr 并存）, PI_SOLO_MODE_FILE（solo-mode 写、本扩展只读，见 solo-approval-gate.md）
模式: -
会话生命周期: `session_start` / `session_shutdown` 都重置状态带计数；`tool_call` 上拦截危险命令（fail-closed）
无注册面: -

### loop
状态键: -
widget: `widget-band`
widget 段键: `30:loop`
工具: loop_create, loop_list, loop_delete
工具面: -
events 广播: -
events 订阅: -
宿主钩子: session_start, session_shutdown
模型面: -
命令: loop, loop:list, loop:pause, loop:resume, loop:delete, loop:clear
快捷键: -
独占声明: -
共享槽: widget-band（上方排序带，段键 30:loop，见 status-bar.md）
模式: -
会话生命周期: `session_start` 先停旧调度再回放条目重建任务、重启对齐 ticker；`session_shutdown` 停调度（后台 `--bg` 子进程 detached+unref，不随会话结束）
无注册面: -

### opencode-bridge
状态键: -
widget: -
工具: -
工具面: -
events 广播: -
events 订阅: -
宿主钩子: session_start
模型面: -
文件契约: PI_SOLO_MODE_FILE（只读消费方，按免审批状态决定同步确认路径）
命令: opencode-bridge, opencode-bridge:status, opencode-bridge:sync, opencode-bridge:restore
快捷键: -
独占声明: -
共享槽: PI_SOLO_MODE_FILE（solo-mode 写、本扩展只读，见 solo-approval-gate.md）
模式: -
会话生命周期: 仅挂 `session_start`（确保 helper 桥进程在跑）；`sync` / `restore` 会写宿主 `settings.json`（人工确认 + 备份）
无注册面: -

### provider-quota
状态键: `20:provider-quota`
widget: -
工具: -
工具面: -
events 广播: -
events 订阅: -
宿主钩子: session_start, model_select, session_shutdown
模型面: -
命令: quota
快捷键: -
独占声明: -
共享槽: model_select（观察型钩子：只读当前 provider 去拉额度，不改模型选择）
模式: -
会话生命周期: `session_start` 起刷新定时器；`session_shutdown` 中止请求、清状态与共享登记
无注册面: -

### remote-tools
状态键: -
widget: -
工具: -
工具面: replace:read, replace:write, replace:edit, replace:ls, replace:find, replace:grep, replace:bash
events 广播: -
events 订阅: pi-extensions:shell-capability:v1, pi-extensions:dir-context-remote-context:v2
宿主钩子: -
模型面: -
命令: -
快捷键: -
独占声明: -
共享槽: replace:bash（远端分支经能力频道并入 timeout-bg 的 bash，见 shell-tool-capability.md）
模式: -
会话生命周期: 无钩子（加载期注册工具 + 订阅能力频道回填远端能力）
无注册面: -

### run-timer
状态键: -
widget: `widget-band`
widget 段键: `20:run-timer`
工具: -
工具面: -
events 广播: -
events 订阅: -
宿主钩子: session_start, agent_start, turn_start, turn_end, agent_settled, session_shutdown
模型面: -
命令: -
快捷键: -
独占声明: -
共享槽: widget-band（上方排序带，段键 20:run-timer，见 status-bar.md）
模式: -
会话生命周期: `session_start` 复位计时并起对齐 ticker；`session_shutdown` 结算并清自己的段
无注册面: -

### solo-mode
状态键: `40:solo-mode`
widget: -
工具: -
工具面: -
events 广播: -
events 订阅: -
宿主钩子: session_start, session_shutdown
模型面: -
文件契约: PI_SOLO_MODE_FILE（写入方：会话级免审批状态，形状与采纳方见 solo-approval-gate.md）
命令: solo, solo:on, solo:off, solo:status
快捷键: -
独占声明: -
共享槽: PI_SOLO_MODE_FILE（本扩展写入；pwr / jev-safe-gate / deep-init / opencode-bridge 只读）
模式: -
无注册面: -

### stream-token-speed
状态键: `50:stream-token-speed`
widget: -
工具: -
工具面: -
events 广播: -
events 订阅: -
宿主钩子: message_start, message_update, message_end, session_shutdown
模型面: -
命令: -
快捷键: -
独占声明: -
共享槽: -
模式: -
会话生命周期: 无 `session_start`；`session_shutdown` 清状态键（防旧指标残留到新会话）
无注册面: -

### timeout-bg
状态键: `80:timeout-bg`
widget: -
工具: -
工具面: replace:bash, replace:powershell
events 广播: pi-extensions:shell-capability:v1
events 订阅: pi-extensions:shell-capability:v1
宿主钩子: session_start, session_shutdown
模型面: -
命令: bg, bg:kill, bg:clear
快捷键: -
独占声明: replace:bash, replace:powershell
共享槽: pi-extensions:shell-capability:v1（能力协商发起方 = bash 的 owner，见 shell-tool-capability.md）
模式: -
会话生命周期: `session_start` 逐个重注册 active shell 工具并做一次能力协商（含后台任务状态段的清理）；`session_shutdown` `killAll()` 杀全部后台任务并清状态段。另经 `pi.sendMessage`（deliverAs followUp）回送后台完成消息
无注册面: -

### virtual-model-router
状态键: -
widget: -
工具: -
工具面: -
events 广播: -
events 订阅: -
宿主钩子: -
模型面: router
命令: -
快捷键: -
独占声明: router
共享槽: -
模式: -
会话生命周期: 无钩子（注册虚拟模型 `opencode-go/router`，路由状态由宿主按会话分支持久化）
无注册面: -
