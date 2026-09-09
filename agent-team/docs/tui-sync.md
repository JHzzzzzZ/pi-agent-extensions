# agent-team TUI ↔ pi-subagents 同步对照矩阵

> 本文件是 agent-team 侧 TUI（viewer / widget / cockpit 状态行 / index 接线）与
> pi-subagents fleet 家族（v0.66.0）**代码级同步**的唯一事实来源。所有同步相关
> 测试的期望值一律从这里抄（独立于被测实现），禁止从被测代码复制断言。
> 同步≠依赖：仍不 import pi-subagents 包（自包含要求保留），以“对照抄改 + 单测锁定”方式同步。

## 1. 文件映射表

| agent-team 侧 | pi-subagents 侧（v0.66.0） | 关系 |
|---|---|---|
| `viewer.ts`（`TranscriptViewer` 组件 + `openTranscriptViewer` 打开器 + 边框渲染） | `src/tui/fleet.ts`（`SubagentFleetComponent` + `openSubagentFleet` 壳 + `overlayOptions`）；`src/tui/fleet-transcript.ts`（仅渲染参照） | 对照抄改 |
| `widget.ts`（`RunWidgetController` + 纯 reducer + 行渲染） | `src/tui/fleet-status.ts`（`FleetStatusComponent`：激活门控、roster 导航、renderKey 跳过重绘） | 对照抄改 |
| `cockpit.ts` 状态行（`formatStatusSnapshot`） | `src/tui/fleet-status.ts` 状态行（仅文本样式参照） | 已对齐（无行为差异） |
| `index.ts` 接线（`openViewer` / `ensureRunWidget` / widget 隐藏恢复 / 互斥） | `src/extension/*` + `src/tui/fleet-status.ts` 的 open/close 互斥与隐藏语义 | 对照抄改 |

**基线版本：pi-subagents v0.66.0**（本地 `~/.pi/agent/npm/node_modules/pi-subagents`，`package.json` 版本字段）。本矩阵记录的是 v0.66.0 的快照；pi-subagents 每升版一次，agent-team 跟进一次并在此登记新版本号（见 §5）。

## 2. 对齐维度表

| 维度 | pi-subagents v0.66.0 字面量 | agent-team 现状 | 处置 |
|---|---|---|---|
| overlay 几何（五字段） | `{ anchor: "center", width: "95%", minWidth: 60, maxHeight: "85%", margin: 1 }`（`fleet.ts:1440`） | `VIEWER_OVERLAY_OPTIONS` 已 verbatim | 已对齐（测试锁死防回归） |
| 刷新节流 | `REFRESH_MS = 750`（`fleet.ts:25`，`MIN_REFRESH_MS = 250`） | viewer tick 800；widget tick 1000 | viewer 800→**750**；widget 1000 保留（下方亮块是宿主纯字符串表面，见差异表） |
| viewer 关闭键 | `close: ["escape", "ctrl+c", "q"]`（`fleet.ts:33-34`） | 仅 `q`/Esc | **补 ctrl+c** |
| widget 激活门控 | `matchesKey(data,"down") \|\| matchesKey(data,"left")`，且 `ctx.ui.getEditorText() === ""` 才激活（`fleet-status.ts:606-607`） | `alt+↓/↑` 激活，无编辑器门控 | 新增 **↓/← 空编辑器激活**；`alt+↓/↑` 保留为不受门控第二通道（差异表 §3.3） |
| widget 选中导航 | `down/j`、`up/k`（`fleet.ts:36-37`，`fleet-status.ts:616-625`）；up 到顶再按 = 退出选中 | `↑/↓` | **补 j/k**；`↑/↓` 保留 |
| 无变化跳过重绘 | `renderKey` 相同则跳过；running 时仍强制重绘（墙钟 spinner，`fleet-status.ts:585-591`） | 每次 refresh 必 setWidget | **渲染串指纹相同则跳过**；running + elapsed 变化照常重建 |
| open/close 互斥 | 单实例（`fleetInspectorOpen` 等守卫） | `openViewer` early-return + `viewerOpen` 门控 | 已对齐 |
| widget 隐藏/恢复 | inspector 打开期间 `clearWidget` + 恢复时 `refresh`（`fleet-status.ts:543-596`） | `setPaused(true)` 隐藏 + `setPaused(false)` 立即重绘 | 已对齐 |
| 销毁与重入 | 组件 `dispose` 清理订阅/timer | `dispose` 先停 timer 再调 done；幂等 | 已对齐（测试锁死） |
| viewer 停止动作 | `stop: ["D"]` 两步确认（`stopConfirming`；确认态 Enter/Y 确认、Esc/ctrl+c/N/backspace 取消，取消不关闭；其余键忽略，`fleet.ts:46/1134-1150`） | `D` 运行中进确认态，确认后经 `viewerStopAction` → `stopAndSettle()`（与 team_stop 同语义）；已结束仅 error notice 不进确认态 | 已对齐（agent-team 特有：横幅占正文窗口顶部、窗口收缩、帧总高不变，见差异表 §3.8） |
| viewer 刷新动作 | `refresh: ["r", "R"]`（`fleet.ts:43`） | `r`/`R` 绕过 750ms 指纹门控强制重载重绘 | 已对齐 |

## 3. 差异条目表

| # | 差异 | 处置 | 原因 / 注释位置 |
|---|---|---|---|
| 3.1 | widget 渲染用 `setWidget(key, string[], …)` 而非 fleet-status 的组件工厂式 `setWidget(key, (tui, theme) => Component, …)` | **避坑保留** | 组件工厂式逐帧重绘在某个 bundle 构建的宿主上会产生逐秒追加残影行；string[] 由宿主包装渲染，是跨构建最稳路径。见 `widget.ts` 头注 + `index.ts ensureRunWidget` 注释。 |
| 3.2 | viewer 单页转录 + 页签 `←→/h/l/tab/1-9/g/G` | **特有语义保留** | fleet 是 roster+detail 双栏 + prompt audit/steer/stop 控制面；agent-team 无对应语义。页签 = agent-team 的成员切换，fleet 无。见 `viewer.ts` `handleViewerKey` + `README.md §5` 按键表。 |
| 3.3 | `alt+↓/↑` 为不受门控的第二激活通道 | **特有语义保留** | fleet-status 只有 ↓/← 激活；alt 通道是 agent-team 历史行为（模态选中风格，与 pi 主编辑器语义并行）。非空编辑器仍可经 alt 通道进 widget。见 `widget.ts` `isActivate`。 |
| 3.4 | widget tick 1000ms（vs fleet 750ms） | **避坑保留** | 下方亮块是宿主渲染的纯字符串表面（无 overlay 重影风险），1s 节奏够用且省 churn。见 `types.ts` `WIDGET_TICK_MS`。 |
| 3.5 | 行图标/文案映射 | **已对齐** | fleet ●/◦/■ 与 agent-team ✓/✗/⊘/·/▶ 的映射关系：fleet 运行中 ▶ spinner 语义 ≈ agent-team `running → ▶`；完成 ✓、失败 ✗、中止 ⊘、队列 ·。见 `viewer.ts statusDisplay` + `widget.ts recordIcon`。 |
| 3.6 | 状态行文本（`formatStatusSnapshot`） | **已对齐** | 仅样式/文案参照 fleet-status 状态行，无行为差异。 |
| 3.7 | 选中态 up 到顶再按 | **未采纳（agent-team 钳位）** | fleet-status `up` 在选中第 0 行时退出选中；agent-team 保持钳位（首行再按 up 不动），与现有交互一致，无重影风险。见 `widget.ts` `handleWidgetKey`。 |
| 3.8 | 停止确认横幅/notice 占**正文窗口顶部**，窗口收缩、帧总高不变 | **特有语义保留** | fleet 的 `withActionLines` 是把 action 行插在 detail 正文之前（总高可变）；agent-team 帧是定高（ghost-host 稳定性约束，`fitLine` 逐行定宽），故改为横幅占窗口顶部 + 窗口 slice 少取对应行数，帧总行数恒为 `bodyHeight + VIEWER_CHROME_ROWS`。优先级 busy > 确认 > notice（对齐 fleet `actionLines` 顺序）。见 `viewer.ts` `actionLines` + `renderViewerFrame`。 |
| 3.9 | 停止粒度 = 整个 run（`viewerStopAction` → `stopAndSettle()`） | **特有语义保留** | fleet 按选中的单个 async run 停；agent-team 的成员子进程归 leader 进程管，cockpit 只能停整个 run（与 team_stop 工具同一路径）。 |

## 4. 规格字面量表（测试期望值唯一来源）

> 后续所有 TDD 测试的期望值从此表抄录，禁止从被测实现复制。出处行号为 v0.66.0。

| 规格 | 字面量 | 出处 |
|---|---|---|
| `REFRESH_MS`（viewer tick） | `750` | `fleet.ts:25` |
| overlay `anchor` | `"center"` | `fleet.ts:1440` |
| overlay `width` | `"95%"` | `fleet.ts:1440` |
| overlay `minWidth` | `60` | `fleet.ts:1440` |
| overlay `maxHeight` | `"85%"` | `fleet.ts:1440` |
| overlay `margin` | `1` | `fleet.ts:1440` |
| close 键集 | `escape`、`ctrl+c`、`q`（编码：`\x1b`、`\x03`、`"q"`） | `fleet.ts:34` |
| 激活键集 | `down`（`\x1b[B`）、`left`（`\x1b[D`） | `fleet-status.ts:606` |
| 激活条件 | 编辑器文本为空（`getEditorText() === ""`） | `fleet-status.ts:607` |
| 选中导航键集 | `down`/`j` 下移、`up`/`k` 上移（均钳位；fleet 的“up 到顶再按退出选中”未采纳，见差异表 §3.7） | `fleet.ts:36-37`、`fleet-status.ts:616-625` |
| 无变化跳过 | 渲染串指纹相同且无 running 强制 → 跳过 | `fleet-status.ts:585-591` |
| stop 键位 | `["D"]`（确认态按键：Enter/Y 确认；Esc/ctrl+c/N/backspace 取消） | `fleet.ts:46`、`fleet.ts:1134-1150` |
| refresh 键位 | `["r", "R"]` | `fleet.ts:43` |

## 5. 同步记录

| 版本 | 日期 | 变更 | commit |
|---|---|---|---|
| 基线 | 2026-09-09 | v0.66.0 快照登记；首版矩阵 | — |
| agent-team 1.2.0 | 2026-09-09 | viewer ctrl+c 关闭 + tick 750；widget 空编辑器激活门控 + j/k 导航 + 无变化跳过 setWidget；接线互斥/隐藏/销毁语义测试锁定 | `feat/agent-team-tui-sync` |
| agent-team 1.4.0 | 2026-09-14 | viewer stop（D 两步确认，确认态按键集对齐 fleet.ts:1134-1150）+ refresh（r/R）；差异条目 §3.8（横幅占正文窗口顶部、帧总高不变）与 §3.9（停止粒度 = 整个 run）登记；tui-sync/viewer/viewer-host/viewer-stop 四文件测试锁定 | `feat/agent-team-view-stop` |

## 6. 范围外（明确不做）

- 不修 /reload 工具消失、team_stop、view 内停止、可靠性对齐、动态对话等其余 todo 条目。
- 不引入 pi-subagents 运行时依赖；不做 widget 组件工厂化改造。
- 不抄 fleet 的 roster+detail 双栏与 prompt audit/steer/stop 控制面。
