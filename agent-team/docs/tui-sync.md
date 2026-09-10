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
| widget 挂载/卸载 | 数据驱动活跃表面：有活跃工作即挂载，全部落定 → `setWidget(undefined)` 卸载（`fleet-status.ts:543-596` 隐藏/恢复语义 + 活跃判定） | v1.12.0 及以前：派单时 `ensureRunWidget` 挂、终态常驻到 `/team/clear`（动作驱动） | v1.13.0 **已对齐**：controller 每会话挂一次（`session_start` 无条件），宿主 widget 注册由 `RunStatusSnapshot.running` 决定——running ⇒ string[] 帧，落定 ⇒ `setWidget(key, undefined)` 自动卸载（终态行不再常驻）；`/team:clear` 收窄为清排队对话 |
| widget 刷新触发 | 事件即时 + 定时兜底：fleet-status 500ms tick + renderKey，running 时 `requestRender()` 驱动 spinner | v1.12.0 及以前：仅 1s aligned ticker 拉取快照 | v1.13.0 **已对齐（触发形式）**：状态变化点事件即时刷新（coordinator `onProgress` 观察点接线：leader 事件/派发起止 → `refreshWidget()`，不等 tick）+ 1s aligned ticker 兜底 + 渲染串指纹门控；spinner/身份色不做（差异表 §3.4） |
| 按键 release 过滤 | `isKeyRelease(data)` 在 `handleKey` 顶部短路（`fleet-status.ts:699`） | v1.13.1 及以前：reducer 只调 `matchesKey`，Kitty 键盘协议 flag 2 的 release 事件（`:3` 编码）被当第二次按键（一次按键生效两次） | v1.13.2 **已对齐**：widget `handleWidgetKey` 与 viewer `handleViewerKey` 顶部统一 `isKeyRelease` 短路；repeat（`:2`）不过滤，长按仍连续移动 |
| viewer 关闭键 | `close: ["escape", "ctrl+c", "q"]`（`fleet.ts:33-34`） | 仅 `q`/Esc | **补 ctrl+c** |
| widget 激活门控 | `editorHasFocus()` 短路（焦点非编辑器/选择器打开 → 不消费且退出选中，`fleet-status.ts:701/965`）+ `matchesKey(data,"down") \|\| matchesKey(data,"left")`，且 `ctx.ui.getEditorText() === ""` 才激活（`fleet-status.ts:606-607`） | v1.8.0：`alt+↓/↑` 激活，仅「编辑器为空」半条门控 | v1.9.1：补 **焦点门控**（`editorFocus` 端口 + `probeEditorFocus` 结构判定，经 factory 形态 `setWidget` 一次性捕获宿主 TUI）+ ↓/← 空编辑器激活；`alt+↓/↑` 保留为不受空编辑器门控的第二通道（差异表 §3.3） |
| widget 选中导航 | `down/j`、`up/k`（`fleet.ts:36-37`，`fleet-status.ts:616-625`）；up 到顶再按 = 退出选中 | `↑/↓` | **补 j/k**；`↑/↓` 保留 |
| 无变化跳过重绘 | `renderKey` 相同则跳过；running 时仍强制重绘（墙钟 spinner，`fleet-status.ts:585-591`） | v1.11.0：渲染串指纹相同则跳过（折叠行不含时间 → running 静止不 churn）；展开态 leader 行 elapsed 每秒重建 | 已对齐（agent-team 无 spinner，「running 强制重绘」不适用；差异表 §3.4） |
| widget 折叠/展开形态 | 未激活：单行 `  <label> · <usage> · ↓/← to inspect`（`fleet-status.ts:757-789`）；激活：顶部提示行 + 空行 + 内容 | 未选中态 = 折叠单行 `agent-team <团队> · ↓/← 查看详情`（不含状态/耗时/并行数/余额）；选中态 = `main → leader（含任务摘要）→ 成员…` 树 + 底部提示行（v1.13.0，任务行于 v1.13.1 并入 leader 行） | 折叠默认态**已对齐**；展开树/提示行位置差异见 §3.11 |
| open/close 互斥 | 单实例（`fleetInspectorOpen` 等守卫） | `openViewer` early-return + `viewerOpen` 门控 | 已对齐 |
| widget 隐藏/恢复 | inspector 打开期间 `clearWidget` + 恢复时 `refresh`（`fleet-status.ts:543-596`） | `setPaused(true)` 隐藏 + `setPaused(false)` 立即重绘 | 已对齐 |
| 销毁与重入 | 组件 `dispose` 清理订阅/timer | `dispose` 先停 timer 再调 done；幂等 | 已对齐（测试锁死） |
| viewer 停止动作 | `stop: ["D"]` 两步确认（`stopConfirming`；确认态 Enter/Y 确认、Esc/ctrl+c/N/backspace 取消，取消不关闭；其余键忽略，`fleet.ts:46/1134-1150`） | `D` 运行中进确认态，确认后经 `viewerStopAction` → `stopAndSettle()`（与 team_stop 同语义）；已结束仅 error notice 不进确认态 | 已对齐（agent-team 特有：横幅占正文窗口顶部、窗口收缩、帧总高不变，见差异表 §3.8） |
| viewer 刷新动作 | `refresh: ["r", "R"]`（`fleet.ts:43`） | `r`/`R` 绕过 750ms 指纹门控强制重载重绘 | 已对齐 |

| viewer 成员切换/滚动键位 | `selectUp: ["up", "k"]`、`selectDown: ["down", "j"]`、`selectFirst: ["home"]`、`selectLast: ["end"]`、`scrollUp: ["K"]`、`scrollDown: ["J"]`、`pageUp: ["pageUp"]`、`pageDown: ["pageDown"]`、`toggleTools: ["x", "X", "ctrl+o"]`（`fleet.ts:33-48`） | v1.7.0 及以前：`↑↓/j/k/PgUp/PgDn/g/G` 滚右栏、`←→/h/l/Tab/1-9` 切成员 | v1.8.0 起**全面对齐**（差异表 §3.2）；旧键退役按下忽略 |


## 3. 差异条目表

| # | 差异 | 处置 | 原因 / 注释位置 |
|---|---|---|---|
| 3.1 | widget 渲染用 `setWidget(key, string[], …)` 而非 fleet-status 的组件工厂式 `setWidget(key, (tui, theme) => Component, …)` | **渲染路径避坑保留；触发形式已对齐（v1.13.0）** | 组件工厂式逐帧重绘在某个 bundle 构建的宿主上会产生逐秒追加残影行；string[] 由宿主包装渲染，是跨构建最稳路径。v1.13.0 起只借鉴 fleet-status 的**触发形式**（数据驱动活跃表面 + 事件/定时刷新 + renderKey 指纹 + 挂载/卸载策略），渲染仍走 string[]。见 `widget.ts` 头注 + `index.ts ensureRunWidget` 注释。 |
| 3.2 | viewer roster+detail 左右双栏 + 键位（v1.8.0 起全面对齐 fleet）：`↑↓/k/j` 切换左栏成员、`Shift+K/J` 滚右栏正文、`Home/End` 首末成员、`PgUp/PgDn` 翻页、`x/X/ctrl+o` 工具行；旧键 `←→/h/l/Tab/1-9/g/G` 退役按下忽略。特有语义仅剩 `m` 发消息（fleet 无对应；fleet 的 p/Enter/H/s steer/inspect/prompt audit 控制面无对应语义，未列入） | **布局 + 键位已对齐** | 布局与几何公式对照 `fleet.ts:1319-1381` 抄改（§4 规格表）；键位逐字对齐 `DEFAULT_FLEET_KEYBINDINGS`（`fleet.ts:33-48`，大写滚动键经 fleet 同款大写→`shift+小写` matchesKey 判定，`fleet.ts:59-61` 同构）。见 `viewer.ts` `VIEWER_ACTION_KEYS`/`handleViewerKey` + `README.md §5` 按键表。 |
| 3.3 | `alt+↓/↑` 为不受（空编辑器）门控的第二激活通道 | **特有语义保留** | fleet-status 只有 ↓/← 激活；alt 通道是 agent-team 历史行为（模态选中风格，与 pi 主编辑器语义并行）。非空编辑器仍可经 alt 通道进 widget。但**焦点门控对 alt 通道同样生效**（v1.9.1）：焦点确定非编辑器（选择器/对话框）时 alt+↓/↑ 也不介入——对话框期 widget 完全不介入。见 `widget.ts` `isActivate` + `onData` 焦点短路。 |
| 3.4 | widget tick 1000ms（vs fleet 750ms） | **避坑保留** | 下方亮块是宿主渲染的纯字符串表面（无 overlay 重影风险），1s 节奏够用且省 churn；v1.13.0 起状态变化由事件即时刷新（`onProgress` → `refreshWidget()`），1s aligned ticker 仅作兜底。见 `types.ts` `WIDGET_TICK_MS`。 |
| 3.5 | 行图标/文案映射 | **已对齐** | fleet ●/◦/■ 与 agent-team ✓/✗/⊘/·/▶ 的映射关系：fleet 运行中 ▶ spinner 语义 ≈ agent-team `running → ▶`；完成 ✓、失败 ✗、中止 ⊘、队列 ·。见 `viewer.ts statusDisplay` + `widget.ts recordIcon`。 |
| 3.6 | 状态行文本（`formatStatusSnapshot`） | **已对齐** | 仅样式/文案参照 fleet-status 状态行，无行为差异。 |
| 3.7 | 选中态 up 到顶再按 | **已采纳（v1.8.0，退出选中）** | fleet-status `up` 在选中第 0 行时退出选中（`fleet-status.ts:620-625`）；agent-team v1.8.0 起同构（cursor 0 再按 `↑`/`k` 退出选中放行编辑器，保持 cursor 供再次激活恢复；底部仍钳位），废弃旧钳位行为。见 `widget.ts` `handleWidgetKey`。 |
| 3.8 | 停止确认横幅/notice 占**正文窗口顶部**，窗口收缩、帧总高不变 | **特有语义保留** | fleet 的 `withActionLines` 是把 action 行插在 detail 正文之前（总高可变）；agent-team 帧是定高（ghost-host 稳定性约束，`fitLine` 逐行定宽），故改为横幅占窗口顶部 + 窗口 slice 少取对应行数，帧总行数恒为 `bodyHeight + VIEWER_CHROME_ROWS`。优先级 busy > 确认 > notice（对齐 fleet `actionLines` 顺序）。见 `viewer.ts` `actionLines` + `renderViewerFrame`。 |
| 3.9 | 停止粒度 = 整个 run（`viewerStopAction` → `stopAndSettle()`） | **特有语义保留** | fleet 按选中的单个 async run 停；agent-team 的成员子进程归 leader 进程管，cockpit 只能停整个 run（与 team_stop 工具同一路径）。 |
| 3.10 | 亮块 running **展开**头行可选余额提示（`· 剩 $X.XX`） | **特有语义新增** | fleet 无预算概念；仅当团队 frontmatter 配了 `budget.maxCostUsd` 且未超限时显示（超限即自动中止，不再显示）；无费用上限时头行与 fleet 对齐不变。余额提示只出现在展开态头行，折叠单行不含。 |
| 3.11 | 展开态：`main → leader（含任务摘要）→ 成员…` 树（v1.13.0；任务行 v1.13.1 并入 leader 行）+ 底部提示行 | **特有语义保留** | fleet 无 main 树/任务摘要；agent-team 展开块 = 树行（`main` / `leader <团队> · <任务摘要> ▶ running · 耗时 · N/M 并行[ · 剩 $X.XX]` / `|- <成员> <图标> <状态>[ · 尾部]`）+ 底部 `↑↓ 选择 · enter 查看 · esc 退出`（无空行、无缩进，`renderWidgetView`）。**末行恒为成员行**（不设独立任务行：避免用户把末行任务当成员、enter 却打开 leader 的假成员陷阱，用户 2026-09-15 真机反馈）；`main` 行 enter 只收起选中（fleet main 同构），leader/成员行 enter 进查看器（按 actor 钉选）。折叠默认形态对齐 fleet 折叠单行（§2）。历史截图（多行常显/折叠）存 `agent-team/docs/assets/widget-before-collapse.png`；任务行陷阱截图存 `agent-team/docs/assets/widget-tree-feedback.png`。 |
| 3.12 | viewer 帧行单行不变量：多行 tool 条目（`team_dispatch 派发 →\n  - 成员: 任务`）按 `\n` 拆成物理帧行（首段 `· `、续段两空格缩进），`fitLine` 兜底折叠残余 CR/LF | **特有语义（fleet 无此数据形状）** | `cockpit.ts:499` 的派发条目是多行文本；fleet 的工具输出路径本就按行拆分或 `\s+` 压平（`fleet-transcript.ts:441/500`）。agent-team 旧实现把整条当单行 → 帧行携带 `\n`，宿主按物理行写屏时尾巴落到下一行同列，overlay 左缘残行 + 帧几何漂移且 diff 无法清理（真机 2026-09-15 实锤，`docs/incidents.md`）。见 `viewer.ts` `blockLines`（tools 分支）/ `fitLine`。 |
| 3.13 | detail 元信息头第 4 行 `模型:`（Run/State/成员/模型）——leader 显示子进程 `message_end` 实际上报值（`RunProgress.leaderModel` / 终态 `record.leaderUsage?.model`），成员显示团队文件声明值（live 经 `MemberProgress.model`、终态优先 `member.usage?.model` 实际值），未声明显示 `（默认）` | **特有语义（fleet 检查器无模型行）** | 用户 2026-09-10 提出“viewer 显示 teammate 详细信息（如每个成员使用的模型）”。头部行数由 3 → 4（仍占正文窗口顶部、帧总行数恒为 `bodyHeight + VIEWER_CHROME_ROWS`、无焦点/键位变化）；`buildViewerData` 不再为此重读团队文件（模型随 progress/record 到达）。见 `viewer.ts` `ViewerActor.model`/`detailHeaderLines` + `index.ts` `buildViewerData`。 |
| 3.14 | widget 展开态窗口化：选中行恒在窗口内、帧总行数（含折叠提示行与底部提示行）≤ 宿主 `MAX_WIDGET_LINES = 10`，隐藏侧以 `  … 上方/下方还有 N 行` 明示 | **特有语义（fleet-status 的 owner/子 agent 树本身 ≤6 行，无窗口化需求）** | 宿主 `setExtensionWidget` 对 `string[]` 只渲染前 10 行并追加 `... (widget truncated)`（`interactive-mode.js`）：v1.14.2 前 8+ 成员团队展开即被截断、光标可落到不可见行（第六轮读宿主源码发现的候选问题）。`widget.ts` `WIDGET_MAX_LINES`/`widgetRowWindow`；`WIDGET_MAX_LINES` 与宿主常量的等值由测试直接读宿主 dist 源码锁定（漂移即红）。 |

## 4. 规格字面量表（测试期望值唯一来源）

> 后续所有 TDD 测试的期望值从此表抄录，禁止从被测实现复制。出处行号为 v0.66.0。

| 规格 | 字面量 | 出处 |
|---|---|---|
| `REFRESH_MS`（viewer tick） | `750` | `fleet.ts:25` |
| `WIDGET_TICK_MS`（widget 兜底 tick） | `1000`（事件即时刷新为主，tick 仅兜底；差异表 §3.4） | `types.ts`；对齐墙钟秒边界契约 `docs/cross/status-bar.md` |
| overlay `anchor` | `"center"` | `fleet.ts:1440` |
| overlay `width` | `"95%"` | `fleet.ts:1440` |
| overlay `minWidth` | `60` | `fleet.ts:1440` |
| overlay `maxHeight` | `"85%"` | `fleet.ts:1440` |
| overlay `margin` | `1` | `fleet.ts:1440` |
| close 键集 | `escape`、`ctrl+c`、`q`（编码：`\x1b`、`\x03`、`"q"`） | `fleet.ts:34` |
| 激活键集 | `down`（`\x1b[B`）、`left`（`\x1b[D`） | `fleet-status.ts:606` |
| 激活条件 | 焦点 = 主编辑器（`editorHasFocus()`）∧ 编辑器文本为空（`getEditorText() === ""`） | `fleet-status.ts:607/701` |
| 焦点探测 | 优先 `getFocusedComponent()`，否则读 `focusedComponent` 字段（`fleet-status.ts:965` 同款读法）；五方法（`render`/`invalidate`/`handleInput`/`getText`/`setText`）齐全 = 编辑器；两者皆无/取用抛错 → undefined（降级为旧门控） | `fleet-status.ts:965`；getter 优先为 agent-team 补充（公共 API 优先于运行时字段） |
| 选中导航键集 | `selectUp: ["up", "k"]`、`selectDown: ["down", "j"]`（fleet 首末钳位；fleet-status 的“up 到顶再按退出选中”v1.8.0 已采纳，见差异表 §3.7） | `fleet.ts:37-38`、`fleet-status.ts:616-625` |
| 成员首末跳转 | `selectFirst: ["home"]`、`selectLast: ["end"]`（fleet `moveSelection(±items.length)` 同构） | `fleet.ts:39-40`、`fleet.ts:1159-1160` |
| 正文滚动键 | `scrollUp: ["K"]`、`scrollDown: ["J"]`（大写绑定→`shift+小写` 经 matchesKey 判定，`fleet.ts:59-61`）；`scrollDetail` 骤到 [0, maxScroll]，到底/在底再滚 = re-follow（`fleet.ts:1013-1018`） | `fleet.ts:35-36`、`fleet.ts:1155-1156` |
| 翻页键 | `pageUp: ["pageUp"]`、`pageDown: ["pageDown"]`（视口高 = 右栏实际可见行数） | `fleet.ts:41-42`、`fleet.ts:1161-1162` |
| 工具行开关 | `toggleTools: ["x", "X", "ctrl+o"]` | `fleet.ts:48`、`fleet.ts:1205-1207` |
| 无变化跳过 | 渲染串指纹相同且无 running 强制 → 跳过 | `fleet-status.ts:585-591` |
| widget 折叠行 | `agent-team <团队> · ↓/← 查看详情`（仅活跃 run；落定自动卸载，无终态折叠行） | agent-team 特有文案，对齐 fleet 折叠单行语义（`fleet-status.ts:757-789`）；纯函数 `buildWidgetView.collapsed` |
| widget 树行 | `main` / `leader <团队> · <任务摘要> ▶ running · <耗时> · <N>/<M> 并行[ · 剩 $X.XX]` / `|- <成员名> <图标> <状态>[ · <尾部>]`（无独立任务行；末行恒为成员行） | agent-team 特有（v1.13.0；任务摘要 v1.13.1 并入 leader 行）；成员图标 queued `·` / running `●` / done `✓` / failed `✗` / aborted `⊘`；行文本不带 gutter（渲染器统一加 `▸ `/`  `） |
| widget 任务摘要 | 压平后 44 字符 + `…`（截断后 `trimEnd()`）；空白任务省略 ` · <任务>` 段 | agent-team 特有（v1.13.1；leader 行内，不占独立行） |
| widget 成员尾注 | 取 `note`，否则 `latest`；`\s+` 压平后 ≤30 字符（超出 29 字 + `…`）；空白尾注省略 ` · ` 段 | agent-team 特有（v1.13.0）；`widget.ts` `truncateMemberTail` |
| widget 挂载不变量 | `snapshot.running && snapshot.progress` ⇒ string[] 帧；否则 `setWidget(key, undefined)`（终态自动卸载；`running` 但无 progress 同样隐藏） | agent-team 特有接线（v1.13.0，触发形式对齐 fleet 活跃表面） |
| 按键 release 过滤 | `isKeyRelease(data)`（Kitty flag 2 的 `:3u`/`:3~`/`:3A`/`:3B`/`:3C`/`:3D`/`:3H`/`:3F` 编码）在 key reducer 顶部短路；repeat `:2` 不禁（长按连移） | `fleet-status.ts:699`；agent-team widget（`handleWidgetKey`）+ viewer（`handleViewerKey`）双侧同款（v1.13.2） |
| 帧行单行不变量 | 每个帧行不得含 CR/LF：多行 tool 条目拆物理行（首段 `· ` + 内容，续段 `  ` + trim 后内容，均截断到 `width-2`）；`fitLine` 兜底把残余 CR/LF 折成空格后再定宽 | agent-team 特有（v1.13.3）；真机事故见 `docs/incidents.md` |
| widget 刷新触发 | 事件即时（coordinator `onProgress`）+ 1s aligned ticker 兜底 + 渲染串指纹跳过 | fleet 500ms + renderKey（`fleet-status.ts:585-591`）；差异表 §3.4 |
| widget 展开提示行 | `↑↓ 选择 · enter 查看 · esc 退出`（底部、无缩进） | agent-team 特有（见差异表 §3.11） |
| widget 文本截断 | 先压平（`\s+` → 单空格 + trim），再 44 字符 + `…`，截断后 `trimEnd()` | fleet 无同款截断；换行残行修复（截图回归），任务摘要/成员尾注共用 |
| widget 展开窗口 | 帧总行数 ≤ `WIDGET_MAX_LINES`（10 = 宿主 `setExtensionWidget` 的 string[] 硬上限）；预算 = 10 − 1（底部提示行）− 折叠提示行（0/1/2）⇒ 窗口 7..9 行，选中行必在窗口内 | agent-team 特有（v1.14.2）；`widget.ts` `widgetRowWindow` |
| widget 折叠提示行 | `  … 上方还有 N 行` / `  … 下方还有 N 行`（两空格 gutter、dim；仅对应侧有隐藏行时各出现一行） | agent-team 特有（v1.14.2）；与 `widget 展开提示行` 同帧 |
| stop 键位 | `["D"]`（确认态按键：Enter/Y 确认；Esc/ctrl+c/N/backspace 取消） | `fleet.ts:46`、`fleet.ts:1134-1150` |
| refresh 键位 | `["r", "R"]` | `fleet.ts:43` |
| close 键位 | `["escape", "ctrl+c", "q"]` | `fleet.ts:34`、`fleet.ts:1150-1154` |
| 退役键 | `←`/`→`/`h`/`l`/`Tab`/`1-9`/`g`/`G`（agent-team 旧键位；按下忽略不改状态，不关闭不报错） | fleet 无对应绑定（同为忽略路径）；agent-team v1.8.0 起 |
| 发消息键位（特有） | `m` 进入单行输入模式；输入模式优先于一切现有按键：可打印字符（含 CJK）追加 buffer，backspace（`\x7f`）删最后一个码点，Enter 提交（返回 `chat-submit`），Esc/ctrl+c 只退出输入不关 viewer，其余控制序列忽略 | fleet 无对应语义（inspector 无对话输入）；agent-team 特有，`viewer.ts` `handleViewerKey` 输入分支 + `viewer-chat.test.ts` 锁定 |
| 最小宽度门 | `width < 36` → 单行提示（agent-team 文案：`agent-team viewer 至少需要 36 列。Esc 关闭。`） | `fleet.ts:1321` |
| innerWidth | `width - 2`（两侧 `│` 边框各占 1 列，无内边距空格） | `fleet.ts:1322` |
| bodyHeight 公式 | `max(2, floor(rows * 0.85) - 6)`；rows 缺省 `?? 32` | `fleet.ts:1326-1327` |
| rosterWidth 公式 | `max(22, min(46, floor((innerWidth - 1) * 0.38)))` | `fleet.ts:1328` |
| detailWidth 公式 | `max(1, innerWidth - rosterWidth - 1)` | `fleet.ts:1329` |
| 帧行结构 | `│<roster>│<detail>│`，每行 `fit` 定宽（rosterWidth/detailWidth 分别钳制） | `fleet.ts:1352-1358` |
| 帧结构 | 顶边框 → 标题行（左静态标题，右对齐 `<glyph> <label> · <status>`）→ `├─┬─┤` → bodyHeight 行正文 → `├─┴─┤` → 图例行 → 底边框；chrome 行数 = 6 | `fleet.ts:1343-1370` |
| roster 行格式 | `<marker> <状态图标> <label> · <actorId 短 id>`，marker 选中 `›`（accent）/空格，选中 label 加粗，右对齐状态文本；无成员时 dim `（无成员）` | `fleet.ts:1217-1229` |

## 5. 同步记录

| 版本 | 日期 | 变更 | commit |
|---|---|---|---|
| 基线 | 2026-09-09 | v0.66.0 快照登记；首版矩阵 | — |
| agent-team 1.2.0 | 2026-09-09 | viewer ctrl+c 关闭 + tick 750；widget 空编辑器激活门控 + j/k 导航 + 无变化跳过 setWidget；接线互斥/隐藏/销毁语义测试锁定 | `feat/agent-team-tui-sync` |
| agent-team 1.4.0 | 2026-09-14 | viewer stop（D 两步确认，确认态按键集对齐 fleet.ts:1134-1150）+ refresh（r/R）；差异条目 §3.8（横幅占正文窗口顶部、帧总高不变）与 §3.9（停止粒度 = 整个 run）登记；tui-sync/viewer/viewer-host/viewer-stop 四文件测试锁定 | `feat/agent-team-view-stop` |
| agent-team 1.5.0 | 2026-09-09 | 亮块 running 头行新增可选余额提示（仅当团队配了 `budget.maxCostUsd` 且未超限：`· 剩 $X.XX`；fleet 无此概念，agent-team 特有语义）——差异条目 §3.10 登记；widget.test 锁定 | `feat/agent-team-reliability` |
| agent-team 1.6.0 | 2026-09-14 | viewer 发消息（`m` 单行输入，特有语义；输入模式分支优先于一切按键、Esc 只退输入不关 viewer）；actionLines 优先级 busy > confirm > **input** > notice（输入行占右栏正文窗口、帧总高不变）；图例追加 `m 发消息`。差异条目 §4（发消息键位行）登记；chat/viewer-chat/viewer-chat-host 三文件测试锁定 | `feat/agent-team-view-chat` |
| agent-team 1.7.0 | 2026-09-09 | viewer 改 roster+detail 左右双栏（对照 `fleet.ts:1319-1381` 抄改）：左栏成员 roster（选中标记+状态图标+右对齐状态，窗口化滚动），右栏 = 三行元信息头（Run/State/成员）+ 完整转录正文（滚动/follow/Markdown/x 工具行保留）；`VIEWER_CHROME_ROWS` 3→6、帧高公式换 `max(2, floor(rows*0.85) - 6)`、最小宽度门 36 列；键位不变，差异条目 §3.2 改写，§4 新增几何字面量（另修正 AGENTS 卡里 overlay 宽度的陈旧记载 96%→95%，常量从未变过） | `feat/agent-team-viewer-split` |
| agent-team 1.8.0 | 2026-09-14 | viewer/widget 按键全面对齐 fleet：viewer 动作键位全集逐字对齐 `DEFAULT_FLEET_KEYBINDINGS`（`↑↓/k/j` 切成员+钉 actor id、`Shift+K/J` 滚正文、`Home/End` 首末成员、`PgUp/PgDn` 翻页、`x/X/ctrl+o` 工具行；旧键 `←→/h/l/Tab/1-9/g/G` 退役忽略，特有仅剩 `m`）；widget 选中态到顶（cursor 0）再按 `↑`/`k` 退出选中（§3.7 改已采纳）。§2 新增成员切换/滚动键位行、§3.2/§3.7 改写、§4 新增键位字面量（selectUp/Down/First/Last、scrollUp/Down、pageUp/Down、toggleTools、close、退役键）；另清理 §4 尾部残留合并冲突标记 | `feat/agent-team-viewer-keys` |
| agent-team 1.9.1 | 2026-09-10 | widget 补焦点门控（`editorHasFocus` 半条）：`probeEditorFocus`（`getFocusedComponent()` 优先/`focusedComponent` 字段回退/未知 → undefined 降级）经 index factory 形态 `setWidget` 一次性捕获宿主 TUI 接线；焦点确定非编辑器（`/login`、`/model`、`/settings` 选择器，`ctx.ui.select`，overlay 对话框）时 widget 完全不介入（含 alt 通道），选中态退出让行。§2 门控行、§3.3、§4 激活条件/焦点探测改写；widget（7）、widget-focus-host（3，真 TuiMainScreen + 真 CustomEditor/OAuthSelector/ExtensionSelector）、viewer-mutex（1）共 11 测试锁定 | `feat/agent-team-widget-focus` |
| agent-team 1.11.0 | 2026-09-14 | widget 折叠默认态：未选中只占 1 行 `agent-team <团队> · ↓/← 查看详情`（无状态/耗时/并行数/余额；running 与终态同格式），按 `↓`/`←`（空编辑器 ∧ 焦点门控）或 `alt+↓/↑` 展开为 rows + 底部提示行，`esc`/到顶 `↑`/`k` 收回；行投影 `buildWidgetRows` → `buildWidgetView {collapsed, rows}`（`renderWidgetView` 按 `selected` 选分支）；`truncateTask` 增加 `\s+` 压平（换行残行修复），折叠行复用 `flatten`；折叠行不含时间 → running 不再逐秒 churn（renderKey 自然跳过）。§2 折叠/展开行、§3.10 改写、§3.11 新增、§4 折叠行/提示行/截断字面量；改动前截图存档 `agent-team/docs/assets/widget-before-collapse.png`；widget 测试锁定 | `feat/agent-team-widget-fold` |
| agent-team 1.13.0 | 2026-09-14 | widget 触发形式对齐 fleet-status（数据驱动活跃表面）：controller 每会话挂一次（`session_start` 无条件），宿主 widget 注册由 `snapshot.running` 决定——running ⇒ string[] 帧、落定 ⇒ `setWidget(undefined)` 自动卸载（终态不再常驻）；刷新双触发 = coordinator `onProgress` 事件即时 + 1s aligned ticker 兜底 + renderKey 指纹；展开态改 `main → leader → 成员… → 任务` 树（`|- ` 连接符、成员状态图标 queued `·`/running `●`/done `✓`/failed `✗`/aborted `⊘`、尾注 ≤30 字、leader 行余额提示保留）；`main` 行 enter 只收起选中（fleet main 语义）；`/team:clear` 收窄为清排队对话（不再手动卸亮块，无内容时提示「亮块随 run 结束自动隐藏」）。§2 新增挂载/刷新行并改写折叠行、§3.1/§3.4/§3.11 改写、§4 新增树行/尾注/挂载/刷新字面量；widget-lifecycle 宿主测试锁定派单出帧/落定卸载/事件同步刷新/链式派单不闪卸载 | `feat/agent-team-widget-tree` |
| agent-team 1.13.1 | 2026-09-15 | widget 真机反馈修复：任务摘要并入 leader 行（`leader <团队> · <任务摘要> ▶ running · …`，44 字截断），删除独立 `任务: …` 行——**末行恒为成员行**，消除“末行任务像成员、enter 却打开 leader”的假成员陷阱；宿主回归测试锁“成员行 enter → 查看器 roster 定位该成员”；§3.11/§4 改写，截图存档 `docs/assets/widget-tree-feedback.png` | `feat/agent-team-widget-leader-summary` |
| agent-team 1.13.2 | 2026-09-15 | 按键 release 过滤（修复“一次按键生效两次”真机问题，也是“选不中成员”的真凶）：Kitty 键盘协议 flag 2 下每次按键额外发 release 事件（`:3` 编码），release 同样能被 matchesKey 命中——widget `handleWidgetKey` 与 viewer `handleViewerKey` 顶部统一 `isKeyRelease(data)` 短路（`fleet-status.ts:699` 同款）；repeat（`:2`）保留（长按连续移动）；§2/§4 新增行，widget/viewer 测试锁定（press+release 序列只生效一次）；参考截图存档 `docs/assets/widget-fleet-status-reference.png` | `fix/agent-team-widget-key-release` |
| agent-team 1.13.3 | 2026-09-15 | viewer 帧行单行不变量（“重复行第四轮”根因）：多行 tool 条目（`team_dispatch 派发 →\n  - 成员: 任务`）按 `\n` 拆成物理帧行（首段 `· `、续段两空格缩进），`fitLine` 兜底折叠残余 CR/LF——旧实现帧行携带原始 `\n`，宿主按物理行写屏时尾巴落到下一行同列，overlay 左缘残行 + 帧几何漂移且 diff 渲染器无法清理（computer-use 全分辨率真机实锤）。差异条目 §3.12 + §4 新增行；viewer（拆行/帧不变量）、viewer-host（真实宿主多行派发条目）、widget（同类护栏）测试锁定 | `fix/agent-team-viewer-newline` |
| agent-team 1.14.0 | 2026-09-11 | viewer detail 元信息头新增第 4 行 `模型:`（leader 实际/成员声明，未声明 `（默认）`）+ `team_transcript` details 同步带 model；差异条目 §3.13 登记；`MemberProgress.model` 由 cockpit 启动时写入（viewer 不重读团队文件）；截图管线 countDuet 场景补模型、`agent-team-viewer.svg` 重生成并加 `模型:` 锚点；viewer 头部测试与 run-tool 集成测试锁定 | `feat/agent-team-viewer-model` |
| agent-team 1.14.2 | 2026-09-11 | widget 展开态窗口化（大团队真机截断修复）：`WIDGET_MAX_LINES = 10`（= 宿主 string[] widget 上限）+ `widgetRowWindow`（选中行恒可见、窗口 7..9 行、隐藏侧 `  … 上方/下方还有 N 行`）；宿主常量漂移由测试直读宿主 dist 源码锁定；差异条目 §3.14 + §4 新增两行；widget 测试 4 个新增（全 cursor 行数上限/选中行在帧内、两侧折叠提示、宽度约束、宿主常量等值） | `feat/agent-team-widget-window` |
| agent-team 1.15.0 | 2026-09-11 | viewer 发消息语义拆分（不涉布局/键位/帧几何）：目标 = leader 且 run 运行中 → RPC `steer` 插话（notice「已插话给 leader（steer）：不打断当前任务，leader 会在当前回合结束后尽快回应」，回复入本 run transcript）；成员/已落定仍为派单语义（排队 + 链式）。leader 子进程改 `--mode rpc`（stdin `prompt`/`steer`，`agent_settled` 关 stdin 收尾），widget/viewer 渲染路径不变 | `feat/agent-team-steer` |

## 6. 范围外（明确不做）

- 不修 /reload 工具消失、team_stop、view 内停止、可靠性对齐、动态对话等其余 todo 条目。
- 不引入 pi-subagents 运行时依赖；不做 widget 组件工厂化改造。
- 不抄 fleet 的 prompt audit/herdr 控制面；steer 仅按本仓语义（cockpit → leader stdin 的 RPC 命令）实现，不引入 fleet 的多 agent 协同 steer/广播。
