# TODO

- [x] 修复 `view` 视角下，leader 派活给成员后切换视角时上方不断出现换行重影的问题。（首轮：指纹门控+按 id 选中+帧高消抖，未根除，见第二轮条）
- [x] view 顶部标题+页签堆叠依旧（第二轮：overlay 加 maxHeight 85% + margin 1 与参考对齐，viewer 打开期间暂停并隐藏下方 widget 亮块）。105 测试 + typecheck 全绿；但用户真机截图实锤依旧堆叠（53s/54s、1m26s/1m27s 标题并存），见第三轮条。
- [x] view 标题+页签堆叠第三轮（照抄 pi-subagents fleet 壳——options 一字不差 + 标题去 elapsed 静态化 + openViewer 互斥防双 overlay；elapsed 只留下方 widget，viewer 内零每秒文本）。测试补录：viewer-host（真实 TuiMainScreen + scrollback 仿真器，单实例恒 1 组 chrome）、viewer-mutex（接线层互斥回归，旧版双 overlay 快速失败）。109 测试 + typecheck 全绿；等用户真机确认。
- [ ] 支持与各个 agent 进行动态对话。（验证中：count-duet 团队 1-10 轮流计数已跑通，5 次串行派单；1-1000 逐个派单超预算待分批方案确认）
- [ ] viewer 升级「类主界面」全页模式（路径 1：同进程内嵌，用户 2026-09-10 提出，未领取）：用 `ctx.ui.custom(factory)` **不传 overlay** 打开全页组件——官方语义是接管内容区并拿走键盘焦点（snake.ts 先例），区别于现有 /team:view 的 overlay 浮层。页面内部用 pi-tui 现成组件重组主界面观感：Editor（主界面同款输入组件，替代 v1.6.0 的右栏单行输入）+ Markdown（对话气泡）+ ScrollView（转录滚动）+ 状态行。复用既有资产：v1.6.0 `chat.ts` 队列/链式派单语义（Editor 提交接这里，不新造派单通道）、leader 成员 JSON 事件流与 run artifacts 回放（转录数据源）。明确边界：custom 是模态的（主界面核心 Editor 挂起，符合预期）；斜杠命令面板/compaction/消息持久化是主会话专属，不在范围。验收：全页打开与 Esc 返回 roster/viewer；页内 Editor 输入经 chat 队列送达且回复流式渲染；与现有 overlay viewer 的互斥/切换关系明确不双开；host 级测试（沿 viewer-host 真实 TuiMainScreen + 假终端模式）+ typecheck 绿。设计自由度留给领取者：入口形态（viewer 内切全页 vs 独立命令）、全页与 overlay 两模式并存或替代。背景：pi 无"第二个主界面"接口（单进程单 TuiMainScreen），路径 2（`pi --session` 真·第二个主界面）被 agent-team 子进程 `--no-session` 阻断（cockpit.ts:538、dispatch.ts:357），路径 3（宿主多标签）超出扩展 API——路径 1 是当前唯一可同进程落地的形态。
- [x] view 场景下支持用户与各 agent 直接对话：viewer 内选中成员/leader 后按 `m` 进入右栏输入行，Enter 提交；消息按直接派单语义到达——复用 startBackgroundRun（含 model 预检）以消息为 task 发起新后台 run，run 运行中则排队、落定（completed）后链式派出；回复经新 run transcript 展示，报告照常 followUp 送达主会话。架构约束：成员子进程归 leader 派生，cockpit 无通道注入消息，“动态对话”=派单语义。（v1.6.0 合入 feat/agent-team-view-chat：`chat.ts` 纯逻辑 + index 接线，队列/链式门控，chat/viewer-chat/viewer-chat-host 测试锁定）
- [x] 将 team 的 view 界面改成左右分栏式（对照 pi-subagents fleet inspector 布局，截图存于 `agent-team/docs/assets/view-split-layout-reference.png`）：左栏成员列表（状态标记 pending/complete/failed + agent id），右栏当前选中成员的运行详情（runId / State / Step / Transcript tail），底部按键提示栏；替代现有顶部页签切换（`buildViewerData` 页签排序随之退役或改造），键盘导航与选中保持按 actor id，同步更新 tui-sync 对照矩阵。（v1.7.0：左栏 roster（选中 `›` + 状态图标 + label + actor id，右对齐状态文本，窗口化滚动，排序沿用 leader 首位 + actor id）；右栏 = 三行元信息头 `Run:`/`State:`/`成员:`（固定不滚，键名加粗，无 Step 行——成员子进程无步进状态，不新增数据管道）+ 完整转录正文（滚动/follow/Markdown/x 工具行保留）；底部图例独立成行 + 成员 i/n；`VIEWER_CHROME_ROWS` 3→6、帧高公式换 fleet `max(2, floor(rows*0.85)-6)`、最小宽度门 36 列；键位不变、选中仍钉 actor id；确认横幅/notice 按右栏 detail 宽换行后占正文窗口顶部、帧总高不变；与 v1.6.0 发消息错峰合入、版本顺延 1.7.0。tui-sync §3.2 改写 + §4 几何字面量 + §5 登记）
- [x] 补齐 `view` 视角下的功能，例如停止 agent。（v1.4.0：viewer 内 `D` 停止整个 run——两步确认横幅占正文窗口顶部、帧总高不变，busy 守卫防重复，`stopAndSettle()` 与 team_stop 同语义，settled/未落定/异常分别映射 success/warning/error notice；`r`/`R` 手动刷新绕过指纹门控。停止粒度 = 整个 run，按成员停不可行——成员子进程归 leader 进程管。19 个新测试，全量 166）
- [x] 根 README 为每个插件增加效果示意图
- [x] devDependencies 安全升级：@earendil-works/pi-coding-agent 等 ^0.83.0 → ^0.85.1，修复 undici/brace-expansion 高危漏洞
- [x] 参照 pi-subagents（v0.66.0）对齐 agent-team 可靠性：async-first 统一 + run 落盘/reconcile + 预算可配可见 + doctor 自检 + model 预检。v1.5.0（feat/agent-team-reliability；与 viewer D 停止的 1.4.0 错峰）：
  - [x] run 落盘 + reconcile：`runstore.ts` 每 run `status.json` 元数据快照（`teams/runs/<runId>/`，与 transcript 同 retention）；coordinator claim 即写 running（含 leaderPid，runner 经 `onSpawn` 暴露 pid），每条退出路径落终态；`session_start` 把残留 running 翻成 failed 合成记录 + 孤儿 leader PID 警告（**只报告不杀**，PID 复用风险；排除 in-memory run）；损坏 status 文件隔离不抛错（doctor/reconcile 报告）。
  - [x] 预算可配可见：frontmatter `budget:` 块（`maxDispatchCalls`/`maxMemberRuns`/`maxCostUsd`/`maxTotalTokens`，非法值 `INVALID_TEAM_FILE`；协议级上限 8 任务/4 并发不可配）；leader executor 消费 resolved budget；cockpit 折叠 leader usage + dispatch `details.totalUsage` 进 `RunBudgetSnapshot`，费用/token 超限 → abort + `BUDGET_EXCEEDED`；`/team:status` 运行态预算行 + 亮块余额提示 + doctor 列出全部 caps 与来源（default/frontmatter）。
  - [x] model 预检：`preflight.ts` 纯函数（注入 registry lookup）——坏引用 `MODEL_NOT_FOUND` 硬失败不 spawn（新错误码）；无鉴权 warning 放行；成员无 model 跳过；`team_run` 与 `/team:run` 两入口接线。
  - [x] doctor 自检：`doctor.ts` 纯函数 `buildDoctorReport`（deps 注入发现/状态读取/lookup/fs 探测，分节独立容错）+ `/team:doctor` 命令（doctor 进 reserved 名单防团队名遮蔽；先 `modelRegistry.refresh()` 再读）。
  - [x] async-first 收尾：wait/后台两条终态处理收口为单一 `finalizeRun(record, delivery)`（appendRunRecord + 通知/交付），行为不变。
  - 测试 147→196（runstore 9、cockpit-runstore 6、cockpit-budget 6、preflight 5、doctor 8、reliability-host 8、config/dispatch/widget 扩展）；typecheck 零错误；真机 pi 加载 smoke 通过（7 工具注册、团队枚举可用）；`PI_AGENT_TEAM_RUNS_DIR` 测试隔离（host 级测试不再污染真实 runs 目录）。
- [x] 修复每次 `/reload` 后 team 相关工具消失的问题（globalThis 双加载守卫跨 reload 常驻，entry 直接 return）。（v1.3.1：守卫命中后注册 session_shutdown 处理器删标志——pi 保证重绑扩展（reload/new/resume/fork/switch）前必发该事件，下次加载重新注册全部工具/命令/widget；同进程真双加载（无 shutdown 间隔）仍被抑制。新增 3 测试：reload 重注册 / 双加载抑制 / shutdown 幂等；147 测试 + typecheck 全绿；并入 feat/agent-team-clear 后测试断言同步 /team:clear）
- [x] 新增停止工具并暴露给 agent（如 `team_stop`：按 runId 停止运行中的团队派单）

  现状只能从 view 手动停（且该条还没做）；leader / 主 agent 在派单变卦、超预算、跑偏时停不掉，只能等跑完。
  - [x] 与 view 手动停止共用同一停止语义：成员子进程 SIGTERM→SIGKILL、run 落盘终态、widget/行状态更新、后台 followUp 报告不再送达（或送达“已停止”终态）。
  - [x] 工具参数用 Typebox schema（对齐 `manage.ts` 现有风格）；停不存在/已结束的 runId 返回类型化错误，不抛异常。

  v1.2.0 落地：cockpit 新增 `stopAndSettle()`（有界等待落定后返回终态记录，默认 7s），start() 提前同步 claim（消 concurrent start 竞态）+ finally 清空 pending/currentProgress（终态后不再谎报 running）；aborted 记录补全全体 roster 成员；team_stop 工具（runId 必填，RUN_ID_REQUIRED/RUN_NOT_FOUND/RUN_ALREADY_FINISHED）；team_run 后台返回与 team_status 输出暴露 runId。11 个新测试。
- [x] agent-team 的 TUI 与 pi-subagents 同步，所有细节同步到代码层级

  agent-team 的 viewer/widget 是对照 pi-subagents（v0.66.0，`src/tui` + `src/extension` + fleet 壳）手抄的；两边一旦各改各，显示 bug（如重影堆叠）会反复出现。以后 pi-subagents 的 TUI 每变一次，agent-team 跟进一次，差异只留 agent-team 特有语义。
  - [x] 建对照矩阵：agent-team 侧（`viewer.ts` / `widget.ts` / cockpit 状态行）逐文件对应到 pi-subagents 侧源文件 + 版本号（基线 v0.66.0），矩阵落盘（`agent-team/docs/tui-sync.md`，README 已加链接）。
  - [x] 同步粒度到代码层：overlay options（verbatim 锁）、maxHeight/margin、刷新节流（viewer tick 800→750）、键盘交互（viewer close 补 ctrl+c；widget 激活门控对齐 fleet-status——空编辑器才允许 ↓/← 激活，alt+↓/↑ 为不受门控第二通道；选中导航补 j/k）、无变化跳过 setWidget（对齐 renderKey）、open/close 互斥、销毁与重入、widget 隐藏/恢复——全部 TDD 测试锁定（tui-sync / widget / viewer / viewer-host / viewer-mutex 共新增 17 测试）。
  - [x] 同步≠依赖：仍不 import pi-subagents 包（自包含要求保留），以“对照抄改 + 单测锁定”方式同步；新版本号 1.2.0 进对照矩阵与提交信息。
- [x] 终态亮块可消除：run 结束后终态行常驻且无法关闭（/reload 后还会重新挂载），需要退出路径
  - [x] 新增 `/team:clear` 命令手动清除下方亮块（run 进行中提示先 stop 或等结束；只清亮块不清 lastRecord）。v1.3.0：run 进行中拒绝（warning）；无亮块 no-op（info）；否则停 controller + setWidget(undefined)；`clear` 进保留名单防团队名遮蔽。7 个新测试。
  - [x] session_start 水合仅在存在 running run 时自动挂载亮块；终态记录不再自动挂（/team:view、/team:status 回看不受影响；派新单经 ensureRunWidget 复挂）。viewer-mutex slice-6 改经真实派单挂 widget，entry 双加载命令数 5→6。144 测试 + typecheck 全绿。
  - ~~[ ] 终态行超时自动淡出~~（已取消：用户决定不做自动淡出，仅手动 /team:clear 清除；避免注入时钟与 FADE 常量的额外复杂度）
- [x] 按键未对齐：真机使用中 viewer/widget 按键行为与 pi-subagents fleet 不一致（v1.8.0，feat/agent-team-viewer-keys → da59366）
  - 现象：用户反馈按键未对齐（具体哪些键、什么场景待真机复现后补记）。
  - 方案（已确认）：viewer 键位全面对齐 fleet `DEFAULT_FLEET_KEYBINDINGS`——`↑↓/j/k` 切成员、`Shift+J/K` 正文滚动、`Home/End` 首末成员、`PgUp/PgDn` 翻页、`x/X/ctrl+o` 工具行；旧键 `←→/h/l/Tab/1-9/g/G` 退役（忽略）。widget 选中态 `↑/k` 到顶（cursor 0）再按 = 退出选中放行编辑器（fleet-status 同构），废弃钳位。保留特有语义：`m` 发消息、widget `alt+↓/↑` 第二通道。
  - 交付：TDD 先红后绿；viewer/widget/tui-sync/ghost 测试重写锁定；全量 267 测试 + typecheck 绿；tui-sync 矩阵 §2/§3.2/§3.7/§4/§5 改写（另清理 §4 尾部残留冲突标记）、两份 README 按键表、AGENTS.md、docs 卡同步；agent-team 1.8.0 / 根 2.15.1。真机 smoke（切成员/JK 滚动/到顶退出）待用户验证。
- [ ] viewer/widget 重复行第四轮：v1.7.0 分栏改版后真机仍有重复行出现（processing）
  - 现象：前三轮修复（指纹门控、overlay maxHeight/margin 对齐、fleet 壳照抄 + 单实例/互斥测试）后，用户真机仍观察到重复行（具体帧/截图待补记，历史见上三轮条目）。
  - 要求：先拿真机截图定位是哪类重复（标题堆叠？roster 正文重影？亮块与 viewer 并存？），再对照 pi-subagents fleet 真机已验证的渲染路径逐行比对差异；警惕"纯函数单测绿但真机红"——复用 viewer-host（真实 TuiMainScreen + scrollback 仿真器）扩大仿真覆盖，直到仿真复现真机现象再动手修。
- [ ] 支持运行中的 run 中途插话（steer 语义）：viewer 发消息当前是派单语义（排队 → run 落定后链式派出），用户实测"数数途中打招呼，任务结束才收到回复"——期望不打断任务、让正在干活的 leader/成员尽快看到插话并回应。
  - 架构前提：现 leader 是 cockpit 派生的一次性 `pi --no-session` 进程、成员由 leader 派生，cockpit/用户均无通道向运行中的子进程注入消息；中途插话需要 leader 常驻会话进程（保持会话、可接收新输入）+ steer/注入通道，并解决与现有"run 显式终态"可靠性的冲突（run 落盘/reconcile/预算中止/stopAndSettle 都建立在 run 有明确终点上；常驻后"run 何时算结束"需要重新定义——如空闲超时或显式结束命令）。
  - 参考：pi 的 followUp/steer 语义（主 agent 接收排队消息的三种投递模式）；`chat.ts` 队列可复用为 steer 入口，只换"消息到达"的通道，提交/输入框 UI 不变。
  - 范围外：成员子进程仍不可直达（归 leader 管），插话始终经 leader 转发。
- [x] login 时上下键冲突：Pi 的 login（登录/鉴权选择）界面中，team widget 的上下键选中激活与界面的选项上下选择冲突，导致无法选择选项。（v1.9.1，feat/agent-team-widget-focus → 7b56797）根因：v1.8.0 抄 fleet-status 门控只抄了「编辑器为空」半条，漏掉 `editorHasFocus()` 短路——宿主 `/login` 经 showSelector 把主编辑器替换为选择器并 setFocus（非 overlay），而 pi-tui 扩展 onTerminalInput 监听器**先于**聚焦组件，widget consume 即抢键。交付：`probeEditorFocus`（`getFocusedComponent()` 优先/`focusedComponent` 字段回退/未知→undefined 降级）+ `editorFocus` 端口，index 经 factory 形态 setWidget 一次性捕获宿主 TUI；焦点确定非编辑器时 widget 完全不介入（含 alt 通道）、选中态退出让行。测试 279→290（本分支新增 11：widget 7 + widget-focus-host 3 真宿主 + viewer-mutex 接线 1）；两条 README/docs 卡/tui-sync/incidents/AGENTS 同步；agent-team 1.9.1 / 根 2.17.1。真机验收待用户：有亮块时 /login、/model 选择器方向键不再被抢。
- [x] 命令风格统一（跨插件）：冒号命名空间式 `/team:run|stop|status|view|clear|doctor` 与 loop 的子命令式 `/loop list|pause|resume|delete|clear` 用法不一致，需统一（倾向于哪种、是否连带 provider-quota `/quota`、如何向后兼容旧写法待定）。跨插件需求，已在 loop-todo.md 同步登记。（完成 2026-09-10 @ merge a03e525：已定子命令式，范围=全部命令面，直接替换不留别名。agent-team v1.9.0 合并为单 `/team` 命令 + 子命令路由 `run|status|stop|view|clear|doctor`；动态 `/team:<name>` 退役为 `/team <name> <任务>` 参数路由，撞保留词提示显式 `/team run`。连带 pwr v2.6.0 `/workflows` 子命令合并与 `/workflow run|delete|model`、opencode-bridge v1.6.0 `sync|restore`；loop/goal/deep-init/quota 不动，仅文档口径同步。agent-team 279 测试 + typecheck 绿）
- [x] 状态条时钟统一与排序（跨插件）：widget 与 cockpit 进度 ticker 改走 `aligned-ticker.ts` 对齐墙钟秒节拍；契约 `docs/cross/status-bar.md`（完成 2026-09-10 @ feat/status-clock b9d397e，agent-team 288 测试 + typecheck 绿）。
- [x] 状态条对齐 pi-subagents fleet-status：触发形式（数据驱动活跃表面 + 事件/定时刷新）+ 组件式渲染（完成 2026-09-14 @ feat/agent-team-widget-tree，agent-team 1.13.0 / 根 2.21.0：触发形式已交付——controller 每会话挂一次（`session_start` 无条件），宿主 widget 注册由 `snapshot.running` 决定（running ⇒ string[] 帧、落定 ⇒ `setWidget(undefined)` 自动卸载）；刷新双触发 = coordinator `onProgress` 事件即时 + 1s aligned ticker 兜底 + renderKey 指纹；组件工厂式渲染仍为文档化偏差（`tui-sync.md` §3.1 残影教训，未采用）；322 测试 + typecheck 绿）
  - 需求原话：参考 pi-subagent 的状态栏实现方式。
  - 参考实现（本地 `~/.pi/agent/npm/node_modules/pi-subagents/src/tui/fleet-status.ts`）：`ctx.ui.setWidget(FLEET_STATUS_WIDGET_KEY, (tui, theme) => ({ render(width), invalidate(), dispose() }), { placement })` 的**组件工厂式**注册——`render(width)` 每帧按当前宽度渲染（身份色 hash、agent 名、model/thinking、状态、elapsed；≤6 行 owner/子 agent 树），`invalidate()` 重置渲染键，`dispose()` 撤订阅；500ms tick + renderKey 相同跳过，running 时 `tui.requestRender()` 驱动墙钟 spinner；`onTerminalInput` 接 `handleKey`（editorHasFocus + 空编辑器激活、down/j up/k 导航、enter 进 inspector）；inspector 打开时 clearWidget、关闭重挂。另有 slash 运行期 footer 临时状态（`src/slash/slash-commands.ts:608` 起 `setStatus("subagent-slash", …)`）可作参照。
  - 现状差距（`agent-team/widget.ts`）：`setWidget(key, string[])` 两行概要（头行 + 任务行），tick 1000ms，无逐 agent 行 / spinner / 身份色 / 组件内渲染；状态投影与渲染已分离（`buildWidgetRows` / `renderWidgetView` 纯函数 + `RunWidgetController` 字符串推送）。
  - 硬约束（先决策再动手）：① 组件工厂式逐帧重绘曾在该 bundle 构建宿主上产生逐秒追加残影（`docs/incidents.md`「亮块逐秒追加残影」、`tui-sync.md` §3.1）——若换组件路径必须先真机复现/证明残影已消，否则保留 string[]、只借鉴其投影/渲染键/门控逻辑；② 自包含不引 pi-subagents 运行时依赖；③ TUI 期望值以 `agent-team/docs/tui-sync.md` 为唯一事实来源，改完登记 §2/§3/§4/§5；④ 时间类刷新须走 `aligned-ticker.ts`（`docs/cross/status-bar.md` 契约；下方 widget 目前仅 agent-team，无栈顺序冲突）。
  - 方向（用户已确认「对齐之」，2026-09-10）——按 fleet-status 的**触发形式**对齐（不是只抄渲染样式）：
    - 挂载/卸载数据驱动：以「活跃表面」判定（有活跃工作即挂载，全部落定即 `setWidget(undefined)` 卸载），取代「派单时 `ensureRunWidget` 挂、终态常驻到 `/team clear`」的动作驱动；终态常驻与 `/team clear` 是否保留作为显式设计项（对齐后默认不常驻）。
    - 刷新双触发：工作状态变化处事件即时 `refresh()` + 定时兜底（现 `aligned-ticker.ts` 1s；fleet 为 500ms）+ 组件帧渲染（renderKey 未变跳过、running 时 `tui.requestRender()` 驱动 spinner）。
    - 数据源复用：coordinator 的 progress/成员状态快照即「活跃工作」，投影函数 `buildWidgetRows` 保留；需新增「状态变化通知点」。
    - 按键沿用已对齐的 `editorHasFocus`/空编辑器门控；`enter` 映射到现有 `/team view`（agent-team 无 inspector）。
  - 仍待实现时定：逐成员行/树/滚动/展开；spinner 与身份色是否照搬；组件工厂式渲染 vs 保持 string[]（硬约束①先证残影）；`/team clear` 命令去留。
  - 验收思路：真机（派单看状态条渲染/动画/按键）+ 真实宿主测试（复用 `viewer-host.test.ts` / `widget-focus-host.test.ts` 的 TuiMainScreen 仿真路径）+ 全量测试/typecheck 绿。
- [x] `/team` 帮助与命令编排合理性（完成 2026-09-14 @ 命令面冒号化）：原问题（`/team help` 被当作团队名、与 `/workflows help` 不对称、`help` 未进保留词）随 v1.12.0 冒号化消失——裸 `/team` 任何带参输入（含 `help`）都显示完整用法（列出全部 `/team:*` 命令与用法），参数路由与 `RESERVED_TEAM_COMMAND_NAMES` 保留词概念整体退役；命令面固定为 list/run/status/stop/view/clear/doctor，`getArgumentCompletions` 不再参与（本插件无子命令补全）。独立 `help` 子命令不再必要；若后续仍要，可在冒号面上加 `/team:help`（本条目已关闭，需要时重开）。
- [x] widget 默认态太丑：亮块常显 2-3 行，需按 pi-subagents fleet-status 折叠——默认只留一行小提示，按 `↓`/`←` 才展开（用户 2026-09-10 截图反馈；完成 2026-09-14 @ merge 073d66b，agent-team 1.11.0 / 307 测试）
  - 现象：只要存在 run（running 或终态），输入栏下方就常驻多行亮块（头行 `agent-team … status…` + `任务: …`，失败再加 `✗ …`），选中态再多一行提示——占地方且与 fleet-status 的紧凑观感不一致；用户原话「这一块非常丑」。
  - 截图实读（`C:/Users/12967/AppData/Local/Temp/pi-clipboard-798090fd-79fa-4ff4-8dde-93492ee5383f.png`，临时路径，实现时先拷进 `agent-team/docs/assets/` 存档再引用）——选中态共 4 个显示行：
    1. `  agent-team count-duet ✓ completed · 26.8s · $0.0060`
    2. `▸ 任务: 目标: 输出小写单词 hello。`
    3. `特别注意：这是对 count-duet 的一次复用任…`（**任务文本换行残留**：`truncateTask` 按字符截断但未压平 `\n`，宿主把残留换行渲染成额外一行）
    4. `↑↓ 选择 · enter 查看 · esc 退出`
  - 附带缺陷（同源，与折叠/展开改造一并修）：`widget.ts` `truncateTask`（44 字符截断）未把连续空白/换行压成单空格——多行任务一律多出残行；折叠单行文案同样必须压平换行，否则一行会变多行。
  - 目标行为（对齐 pi-subagents fleet-status，参考 `~/.pi/agent/npm/node_modules/pi-subagents/src/tui/fleet-status.ts:757-789`）：
    - 折叠态（默认，未激活）：**单行**小提示，形如 `… · ↓/← 查看详情`（fleet 参考行为：`{label} · {usage} · ↓/← to inspect` 一行；agent-team 允许保留最小状态信息——团队/状态/耗时——但必须 ≤1 行，具体文案实现时定）。
    - 展开态（按 `↓`/`←`；`alt+↓/↑` 第二通道照旧）：显示现有 rows（状态行 + 任务行 + 可选错误行）+ 底部 `↑↓ 选择 · enter 查看 · esc 退出`；`esc` 或到顶再按 `↑` 收回折叠态。
    - 键盘门控不变：`editorHasFocus` 短路 + 空编辑器判定（v1.9.1 已对齐）；焦点非编辑器（/login、/model 选择器等）时完全不介入。
  - 现状差距（`agent-team/widget.ts`）：`buildWidgetRows` 直接产出常显 rows；`renderWidgetView` 在 `state.selected === false` 时把 rows 全量 `dim` 输出——没有折叠态概念。改动点：行投影拆「折叠单行」/「展开 rows」两支，`renderWidgetView` 按 `selected` 选分支；`RunWidgetController.refresh` 的指纹门控与 `setWidget(key, string[])` 推送路径不变。
  - 约束：① 保持字符串 `setWidget` 路径，不做组件工厂化（`tui-sync.md` §3.1 残影教训）；② 时间类刷新继续走 `aligned-ticker`（当前 1s tick，§3.4）；③ 同步更新 `agent-team/docs/tui-sync.md`（§2 门控行、差异表新增折叠/展开行、§4 几何/文案字面量）；④ 版本 bump + AGENTS.md + 根 README（截图/用法）同步。
  - 验收：默认态只占 1 行且含激活提示；`↓`/`←` 展开出现 rows + 提示行；`esc` 收起回折叠；选择器/对话框场景不抢键；widget 纯函数测试 + 真宿主路径（`widget-focus-host.test.ts` 的 TuiMainScreen 仿真）锁定；全量测试 + typecheck 绿；真机截图复核。
- [ ] 真正并发跑多个 team run（未领取）
  - 需求（用户 2026-09-10）：一个会话里可同时运行多个 team，各自 leader/成员子进程并行推进（当前第二个派单会被拒）。
  - 现状差距：`TeamRunCoordinator` 单 active（`this.active`/`this.pending` 各一个句柄），第二个 `/team:run` 直接返回 `RUN_IN_PROGRESS`；只保留 `lastRecord` 一条终态；`getStatus()` 返回单个 `RunStatusSnapshot`；widget 取单快照。`team_stop`/`stopAndSettle` 虽按 runId 对外暴露，但内部只有这一个句柄。
  - 改动要点（实现时定）：多 run registry（Map<runId, controller/pending/progress/record>）；按 runId 的 status/stop/settle/预算独立；runstore 已按 runId 落盘，`session_start` reconcile 需处理多条残留；跨 run 的总并发上限与子进程资源（成员 4 并发是单 dispatch 协议上限，需另定）；报告 followUp 交错；`/team:status`、`team_status`、viewer 选中 run 的定位；`RUN_IN_PROGRESS` 契约去留（保留为并发上限？改为可配？）；`team_stop` 省略 runId 的行为待重定。
  - 依赖/关系：与「widget 展开态改 team + 成员树」配套（多 team 行才有真实数据源）；`/team:clear`、终态常驻与水合语义需随之重定。
- [x] widget 展开态改 team + 成员树（完成 2026-09-14 @ feat/agent-team-widget-tree，agent-team 1.13.0 / 根 2.21.0）
  - 交付：展开态 = `main → leader → 成员… → 任务` 树（`main` 根行 / `leader <团队> ▶ running · 耗时 · N/M 并行[ · 剩 $X.XX]` / `|- <成员名> <图标> <状态>[ · ≤30 字尾注]` / `任务: 44 字截断`；图标 queued `·`/running `●`/done `✓`/failed `✗`/aborted `⊘`），`main` 行 enter 只收起选中（fleet main 语义）、leader/成员行 enter 按 actor 直达查看器；单 team 单 run（多 team 行待「真并发多 run」条目）；终态无行（落定即卸载）；widget 测试重写 + 新增 `widget-lifecycle.test.ts`（真实 entry 接线：派单出帧/落定卸载/事件同步刷新/链式派单不闪卸载），tui-sync §2/§3/§4/§5 同步；322 测试 + typecheck 绿。
  - 需求（用户 2026-09-10）：展开不再只是「状态行 + 任务行」，显示 team 与 teammate 的行；多 team 时用树形层级。
  - 树形格式（用户给定；`main` = 主 agent 对话框，即根节点；每个 team 一个 leader 节点，`|-` 下为其成员）：
    ```text
    main
    leader
      |- teammate1
      |- teammate2
    leader2
      |- teammate3
    ```
  - 事实前提：一个会话可定义/保存任意多个 team，但**当前同时只能跑一个 run**（见上一条；多 team 行需等真并发或历史保留）；协调器仅保留 `lastRecord` 一条终态。
  - 可行性：active 的 `progress.members[]`（name/status/note/latest）与终态 `record.members[]`（status/model/usage/summary）数据齐备；`WidgetRowSpec.actor` 已支持逐行 actor，`enter` 可直达查看器对应成员（`handleWidgetKey` → `onConfirm(actor)` 现成接线）。
  - 实现时定：`main` 行显示什么（主 agent 活动文本？可否 `enter` 进入？）；单 team 时是否也保留 `main`/`leader` 层级；任务行去留；折叠态是否显示活跃 team 数；树连接符/缩进/窄宽度退化；行光标与 `enter` 的 actor 映射；与「状态条对齐 pi-subagents fleet-status」条目的「逐成员行/树/滚动/展开」一并决策；组件工厂式渲染硬约束（`tui-sync.md` §3.1 残影教训）仍适用（先证残影再考虑换渲染路径）。
- [x] 命令面改冒号形式（跨插件，全量任务一部分）：`/team run|status|stop|view|clear|doctor` → `/team:run` 等；`/team <团队名> <任务>` 参数路由去留与保留字冲突（团队名撞 `run` 等）待定。全量清单与待定项见 `todos/commands-colon-todo.md`。（完成 2026-09-14 @ merge 134a3d6：agent-team v1.12.0——裸 `/team` 仅保留无参=列团队/带参=用法，新增 `/team:list` 冒号副本，`/team:run|:status|:stop|:view|:clear|:doctor` 各自独立静态注册；参数路由与 `RESERVED_TEAM_COMMAND_NAMES` 保留词整体退役，团队名可与子命令同名；旧词只提示改名。309 测试 + typecheck 绿；真实 pi loader 冒烟通过）
- [ ] 上游根修（route A）：pi 宿主 `InteractiveMode.setExtensionWidget` 保序 bug——同 key 更新先 `Map.delete` 再 `Map.set`，把 widget 挪到所在栈底部；多个周期刷新的 widget 因此逐秒换位。本插件下方亮块（belowEditor 独立栈）与 cockpit 进度 ticker 直接受影响。需求：把最小复现 + 源码级 diff（`keepPosition`：目标栈已存在 key 时原地 `Map.set`、不清除位置；换 placement / 清除仍从对应栈删除）提交上游 `github.com/earendil-works/pi`（目标 `packages/coding-agent/src/modes/interactive/interactive-mode.ts`）；上游修复发布后撤本地补丁并回归状态条顺序契约。跨插件需求，已在 run-timer / loop / goal / pwr / provider-quota / solo-mode / stream-token-speed / agent-team 的 todo 同步登记。（processing 2026-09-10 @ route A：材料已备，待提交上游）
- [ ] viewer 显示 teammate 详细信息（如每个成员使用的模型）（未领取，用户 2026-09-10 提出）
  - 现象：`/team:view` 只见 roster（label/actor id/状态）与右栏 `Run:`/`State:`/`成员:` 三行元信息头——成员用的是什么模型、费用、worktree 分支等一概看不到；同样的信息 `/team:status` 文本输出里有（`cockpit.ts` 终态成员行拼 `member.model`、`$cost`、summary）。
  - 数据现状：终态 `TeamRunRecord.members[]` 已带 `model/status/summary/usage/worktree`（数据齐备，仅缺渲染）；运行中 `RunProgress.members[]`（`MemberProgress`）只有 name/status/note/latest，成员模型需按 name 从 team config join（`RunProgress.leaderModel` 已有 leader 模型）；`ViewerActor`/`buildViewerData`（`index.ts:349`）目前只投影 actor/label/status。
  - 落点建议：右栏 detail 头（`viewer.ts` `detailHeaderLines`）按选中成员加 `模型:` 行，或 roster 行尾注；样式以 pi-subagents fleet inspector 为对照（`agent-team/docs/tui-sync.md` 为 TUI 期望值唯一来源，改完登记矩阵）。
  - 验收：打开 `/team:view` 选中任一成员即可看到其模型（provider/id）；运行中与终态都有值；窄宽度下不超宽（fitLine/截断）；viewer 纯函数测试 + 真实宿主测试（`viewer-host`）锁定；README/AGENTS/docs 卡同步；全量测试 + typecheck 绿。
