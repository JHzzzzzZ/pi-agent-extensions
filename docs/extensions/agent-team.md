# agent-team — 可复用多 agent 团队

> last verified @ 1699bd4

## 职责与边界

Markdown 定义团队（leader + members），cockpit 模式下主 agent 通过 `team_run` 派单：拉起独立 leader 子进程（`--mode rpc`），leader 经 `team_dispatch` 调度成员子进程并行干活，报告以 followUp 送回；派单变卦/超预算/跑偏时主 agent 用 `team_stop <runId>` 中止（runId 由 team_run 返回与 team_status 展示）；viewer 内 `m` 发消息与成员/leader 直接对话——**leader 运行中走 RPC steer 插话（当前回合边界送达、不打断任务），成员/已落定走派单语义**（见数据流 ⑧）。**不做**：worktree 管理（`worktree.ts` 只做薄封装）、脚本编排（那是 pwr）、缓存回放（每次使用重扫团队文件）。

## 文件地图

- `types.ts` — 团队文件格式（frontmatter `leader` + `members[]`，块标量 prompt）、常量（entry / 消息类型 / 环境变量 / 上限）。**改团队文件格式必看这里。**
- `config.ts` — 团队发现：`~/.pi/agent/teams/` 或受信任项目 `.pi/teams/`，同名项目优先，每次使用重扫；frontmatter `budget:` 块解析（非法值 → `INVALID_TEAM_FILE`）。
- `runner.ts` — 子 `pi` 进程契约：**leader 走 `--mode rpc`**（stdin 发 `prompt`/`steer` JSON 行，`agent_settled` 后关 stdin 使进程退出；RPC 只在 stdin 结束时退出）；member 走 `--mode json -p`（一次性，prompt 全在 argv ⇒ stdin 默认 `ignore`）。`team-tmp://` prompt 物化，SIGTERM→SIGKILL；适配器暴露 child pid（`onSpawn`）与 stdin（`onChild`）；`onWire` 转发每行解析后的原始 JSON（RPC 的 `response`/`agent_settled` 只在此层可见）。
- `runstore.ts` — 每 run `status.json` 元数据快照（落 `teams/runs/<runId>/`，与 transcript 同目录同 7 天 retention）：coordinator claim 即写 running（含 leaderPid），每条退出路径落终态；`session_start` reconcile 把上次会话残留的 running 翻成 failed 记录（只报告**不杀**孤儿 leader，避免 PID 复用误杀）。
- `preflight.ts` — run 前 model 预检（纯函数 + 注入 registry lookup）：解析不了 → `MODEL_NOT_FOUND` 硬失败不 spawn；找到但无鉴权 → warning 放行；成员无 model 跳过（默认模型无从校验）。
- `model-caliber.ts` — 展示层模型口径归一纯函数 `resolveModelCaliber(declared, actual)`（viewer「模型:」行与 `/team:status` 共用，v1.15.2）：声明 provider 前缀 + 子进程实际上报 id 组合；runner.ts 原始上报数据不动（事实源）。
- `doctor.ts` — `/team:doctor` 自检（纯函数 `buildDoctorReport`，deps 注入发现/状态读取/lookup/fs 探测）：运行模式、团队发现、逐团队模型预检、运行目录（残留 running/损坏 status）、逐团队预算与来源、worktree、widget 开关、registry error。
- `dispatch.ts`（leader 模式工具）、`cockpit.ts`（cockpit 模式工具）、`manage.ts`（team_create/list）、`chat.ts`（viewer 发消息：task 模板 + transcript 尾部截断 + FIFO 队列/链式门控，纯逻辑层，宿主接线在 index.ts）。
- `widget.ts` — 输入栏下方可选中亮块（`setWidget(key, string[], { placement: "belowEditor" })`）——**数据驱动挂载**：controller 每会话挂一次（`session_start` 无条件，v1.13.0），宿主 widget 由 `RunStatusSnapshot.running` 决定注册（running ⇒ string[] 帧，落定 ⇒ `undefined` 自动卸载，终态不常驻；`running` 但无 progress 同样隐藏）；**刷新双触发** = coordinator `onProgress` 状态变化点事件即时（leader 事件/派发起止 → `refreshWidget()`，不等 tick）+ 1s 对齐秒节拍兜底（`aligned-ticker.ts`）+ 渲染串指纹相同跳过（`renderKey`）；默认（未选中）为折叠单行 `agent-team <团队> · ↓/← 查看详情`（不含状态/耗时/并行数，未展开时不逐秒 churn），选中态展开 `main → leader（含任务摘要）→ 成员…` 树 + 底部提示行（`buildWidgetView`/`renderWidgetView` 纯函数；成员行 `|- <名> <图标> <状态>[ · ≤30 字尾注]`，图标 queued `·`/running `●`/done `✓`/failed `✗`/aborted `⊘`；任务摘要/尾注文本先 `\s+` 压平再截断，任务摘要 44 字截断内嵌 leader 行、末行恒为成员行；`main` 行 enter 只收起选中，leader/成员行按 actor 进查看器）；激活门控 = 焦点在主编辑器（`editorFocus` 端口 + `probeEditorFocus` 结构判定，宿主无焦点信息降级）× 编辑器为空（`editorState` 端口）；选中态到顶再按 `↑`/`k` 退出选中并收回折叠）；`aligned-ticker.ts` — 对齐秒边界节拍器（每插件一份，widget 与 cockpit 进度 ticker 共用，契约见 `docs/cross/status-bar.md`）；`viewer.ts` — `/team:view` 全屏左右分栏查看器（左 roster/右 detail，fleet inspector 布局，v1.8.0 起动作键位全集对齐 fleet）；`transcript.ts` — 成员转写物化；`tools/capture-screens.mjs` + `tools/vt-screen.mjs` — 文档截图（真实 TuiMainScreen + 真实 viewer + headless 终端 → `docs/assets/*.svg`，帧锚点自检、确定性输出；见 README「文档截图」）；`docs/tui-sync.md` — TUI 行为对照 pi-subagents 的同步矩阵（**TUI 期望值唯一事实来源**）。
- 两种模式一套代码，以 `PI_AGENT_TEAM_FILE` 环境变量区分；leader 模式只注册 `team_dispatch`。`PI_AGENT_TEAM_RUNS_DIR` 可重定向 run artifacts 根（测试隔离用）。

## 核心数据流

1. `team_run`/`/team:run` → **model 预检**（`preflightTeamModels`，坏引用即 `MODEL_NOT_FOUND` 不 spawn）→ 默认后台派单（立即返回，含 runId）→ 拉起 leader 子进程（注入 `PI_AGENT_TEAM_FILE/NAME/RUN_ID`），coordinator claim 即落 `status.json` running 快照。
2. leader 解释团队 prompt → 调 `team_dispatch`（每 dispatch ≤8 任务、≤4 并发成员；预算来自团队 frontmatter `budget:`，默认 12/40）。
3. 每任务物化 `team-tmp://` prompt → member 子 pi 执行 → 结果 ≤50KB / 摘要 ≤8KB 回 leader。
4. cockpit 侧把 leader turn usage + 每次 dispatch 的 `details.totalUsage` 折叠进 `RunBudgetSnapshot`；费用/token 超限 → abort controller，终态 aborted + `BUDGET_EXCEEDED`。
5. leader 汇总 → 退出码 0 → 报告经 `finalizeRun`（wait/后台单一终态路径）持久化 + 交付：后台 followUp 自动送达主会话；`wait: true` 内联返回（同步契约不变）。
6. `team_stop <runId>` 中止：`stopAndSettle()` SIGTERM→SIGKILL 后有界等待（默认 7s）落定，返回 aborted 终态记录；停止后该 run 的报告 followUp 不再送达，可立即重新派单。viewer 内 `D` 停止共用同一停止语义：确认后经 `viewerStopAction` → `stopAndSettle()`（`index.ts` 导出仅供测试），结果映射为顶部 notice（settled → success、未落定 → warning、异常 → error，绝不上抛）；run 已结束/无活动 run 时纯渲染层 notice 拦截，不进确认态、回调不会被调。
7. 崩溃恢复：主会话中断 ⇒ 下次 `session_start` 把残留 running `status.json` 翻成 failed 记录 + 孤儿 leader PID 警告（不杀进程）；`/team:doctor` 可看全部残留与损坏文件。
8. viewer 发消息（`m`，`chat.ts` + index 接线）：**目标 = leader 且 run 运行中且 leader stdin 可用 → RPC `steer` 插话**（`ChatCoordinatorDeps.steerLeader` → `cockpit.steerLeader()` 写 `{"type":"steer"}`；pi 在当前助手回合执行完工具调用后、下次 LLM 调用前送达——不打断任务；提交返回 `{kind:"steered"}`，notice 提示「已插话（steer）」）；其余情况走派单语义：消息 → `buildChatTask`（leader 直发 / 成员转派，附目标 actor transcript 尾部 ≤2000 字节，**派出时刻现读**）→ 复用 `startBackgroundRun`（含 model 预检）派新后台 run；run 运行中则 FIFO 入队，runPromise 收尾调 `chat.onRunFinalized`——completed 链式派出下一条（一次一条，链式 run 的收尾继续驱动），failed/aborted 清空队列并 notify；`team_stop`/`/team:stop`/viewer `D`（`viewerStopAndClearChat`）/`/team:clear` 显式停止也清队列并提示丢弃条数。队列驻留在 cockpit 闭包不落盘（易失交互态，/reload 丢失可接受）。

## 不变量

- 命令面：冒号命令面（v1.12.0）——裸 `/team` 无参=列团队（`/team:list` 同义）、带参=用法提示；`/team:run <团队名> <任务>` 唯一派单入口，`/team:status|:stop|:view|:clear|:doctor` 各自独立静态注册。旧空格子命令与 `/team <团队名> <任务>` 参数路由只提示改名、绝不执行；不再动态注册 `team:<name>`（v1.9.0）；团队名可与任意子命令同名（保留词概念退役）。
- 自包含：不引 pwr、不依赖其它扩展目录，独立可复制加载。
- 上限：每 dispatch 8 任务、4 并发、50KB 结果、8KB 摘要（协议级常量，不可配；`TeamErrorCodes` result union）。派发/成员运行预算可配（frontmatter `budget:`，默认 12/40；费用/token 默认无限），schema 级上限不进 budget。
- `status.json` 只存元数据快照（runId/team/task/startedAt/status/leaderPid/updatedAt/error）——完整 `TeamRunRecord` 仍走 session entries；写入 best-effort，读取宽松解析，损坏文件隔离不抛错（doctor/reconcile 报告）。
- **reconcile 只报告不杀**：孤儿 leader 的 PID 仅进诊断信息（PID 复用风险）；reconcile 排除 in-memory run（同实例 re-bind 场景）。
- wait/后台两条路径共用 `finalizeRun`（appendRunRecord + 通知/交付单一实现）——改终态行为只改这一处。
- run 生命周期由 coordinator 同步 claim 保护：`start()` 在首个 await 前占住 active/pending/progress，finally 清空——并发 start 竞态与终态后残留 progress 均由此拦截；aborted 终态必须补全 roster 成员（queued/running → aborted），否则 widget/status 少报。
- `team_stop` 的 runId 必填：省略/未知/已结束分别返回 `RUN_ID_REQUIRED`/`RUN_NOT_FOUND`/`RUN_ALREADY_FINISHED`（类型化错误，不抛异常）。
- 亮块 `setWidget` 传**纯字符串数组**（无样式）——`ExtensionUIContext` 无 `theme` 字段，类型化访问 `ctx.ui.theme` 无法编译。
- **widget 挂载不变量（v1.13.0，触发形式对齐 fleet-status）**：controller 每会话挂一次（`session_start` 无条件，TUI + 未禁用），宿主 widget 注册由数据决定——`snapshot.running` ⇒ string[] 帧，落定 ⇒ `setWidget(key, undefined)` 自动卸载（终态行不常驻）；`refresh()` 数据为空时同步复位选择态并清指纹；点击/事件与 1s tick 共用该路径。刷新双触发：coordinator `onProgress` 事件即时 + 1s tick 兜底，指纹相同跳过；终态不重挂（/reload 水合只恢复 `lastRecord`，不影响 widget）。`/team:clear` 不再手动卸亮块（只清排队对话），集成测试要看到帧必须走真实派单。
- viewer 打开期间必须暂停下方 widget（`RunWidgetController.setPaused`），关闭恢复。
- **viewer 帧行单行不变量（v1.13.3）**：多行 tool 条目（`cockpit.ts:499` 的 `team_dispatch 派发 →\n  - 成员: 任务`）必须按 `\n` 拆成物理帧行（首段 `· `、续段两空格缩进），`fitLine` 再兜底把残余 CR/LF 折成空格——帧行携带原始换行会让宿主按物理行写出时把尾巴挤到下一行同列（overlay 左缘残行 + 帧几何漂移，diff 无法清理；真机事故见 `docs/incidents.md`）。widget 同族路径由 `flatten`（`\s+`）保证。
- **leader 可注入、成员不可注入**：leader 子进程以 `--mode rpc` 拉起，cockpit 持有其 stdin（`steerLeader()` 写 `steer` 命令，仅 run 活跃且通道未关时可写——`agent_settled`/prompt 拒绝/run 收尾即 `end()`，之后回退队列语义）；成员子进程归 leader 派生、cockpit 无任何通道，成员消息仍编成新 run 的 task（chat.ts 派单语义），绝不试图写运行中子进程的 stdin。
- **子进程 stdin 模式（v1.15.1）**：`PiSpawn`/`runChildPi` 的 `stdin` 默认 `ignore`，只有 leader RPC 显式要 `pipe`（`cockpit.ts` 是唯一写 stdin 的调用方）——pi 的 `--mode json -p` 会读 stdin 到 EOF 才推进，成员 prompt 已在 argv 却持有无人关闭的管道 ⇒ 每次成员派发死锁（v1.15.0 真机事故，见 `docs/incidents.md`）。新增子进程调用点：**不写 stdin 就别开管道**。
- **RPC 收尾不变量**：leader 进程只在 stdin 结束时退出（`onInputEnd`→shutdown）——必须在 `agent_settled` 时关 stdin；prompt 预检失败（`response.prompt.success=false`）不会产生 settle，必须同样关 stdin 否则 run 永久挂起；`promptError` 折进 failed 记录（不让预检失败落成 completed 空报告）。
- chat 队列条目只存 `{ targetLabel, message }`，上文尾部派出时刻现读（不随消息缓存，避免排队期间陈旧）；链式门控仅 completed 续发，failed/aborted 全清——显式停止（team_stop/D//team:clear）同样清队列。
- **不偷编辑器按键**：亮块**默认折叠单行**（未选中态只有激活键被消费，其余（含 esc）原样交还编辑器）——`↓`/`←`（空编辑器 ∧ 主编辑器焦点）或 `alt+↓`/`alt+↑` 展开为 `main → leader（含任务摘要）→ 成员…` 树（末行恒为成员行）+ 底部提示行，`esc` 或第 0 行再按 `↑`/`k` 收回折叠；`main` 行 enter 只收起选中（fleet main 语义），leader/成员行 enter 按 actor 进查看器；**按键 release 过滤**（v1.13.2）：widget/viewer 的 key reducer 顶部 `isKeyRelease` 短路（fleet-status.ts:699 同款）——Kitty flag 2 下 release 事件（`:3` 编码）同样能被 `matchesKey` 命中，漏过滤 = 一次按键生效两次；repeat（`:2`）保留供长按连续移动；**焦点门控**（对齐 fleet-status `editorHasFocus`，v1.9.1）：`ensureRunWidget` 挂载时经 factory 形态 `setWidget` 一次性捕获宿主 TUI（宿主同步调用 factory，空组件在 controller 首帧（running）或首个字符串帧被替换、无可见变化），`editorFocus: () => probeEditorFocus(state.tui)`——`getFocusedComponent()` 优先、`focusedComponent` 字段回退、五方法结构判定编辑器形状（`isEditorComponentLike`，不用 `instanceof`：跨 jiti 模块边界不可靠）；焦点确定非编辑器（`/login`、`/model`、`/settings` 选择器，`ctx.ui.select`，overlay 对话框）时 widget 完全不介入（含 alt 通道）且选中态退出让行；宿主无焦点信息/取用抛错 → `undefined`，降级为旧门控（仅空编辑器）。bare `↓`/`←` 仅当焦点在主编辑器且编辑器为空才激活（`editorState` 端口注入 `getEditorText`，宿主缺该 API 时降级为仅 alt 通道）；选中态 `↑`/`k` 在第 0 行再按退出选中（fleet-status 同构，后续键到达编辑器，退出保持 cursor 供再次激活恢复）。
- **TUI 同步 ≠ 依赖**：viewer/widget 行为对照 pi-subagents（基线 v0.66.0，`agent-team/docs/tui-sync.md`）代码级同步，但不 import 它；测试期望只能从矩阵来，不从实现反推；同步后登记新版本号。
- 渲染串指纹相同跳过 `setWidget`（renderKey 对齐）；但 `setPaused(false)` 必须重置指纹强制重绘——否则恢复帧被跳过，亮块卡在隐藏态。
- 时间类刷新一律走 `aligned-ticker.ts`（widget 重绘、cockpit `onProgress` 进度 ticker）对齐墙钟秒边界；`tickMs` 仅测试可覆盖，生产 1000；节拍器 `unref()` 不阻宿主退出。
- 双加载守卫（`globalThis.__piAgentTeamExtensionLoaded`）**复位时机 = session_shutdown**：pi 宿主保证重绑扩展（reload/new/resume/fork/switch）前必发该事件，entry 在此删标志，下一次 factory 调用重新注册全部工具/命令；同一进程内两份之间无 shutdown 的真双加载（leader 子 `-e` + 自动发现）依旧被抑制。没有复位的话 `/reload` 后 team_* 工具全部消失。
- 组件工厂式逐帧重绘在某 bundle 宿主上产生逐秒追加残影行

## 已知坑

- **TUI 渲染问题纯函数测试抓不住**：/team:view 顶部堆叠修了三轮（f430112 → edaac69 → cc3aa17），全是"纸面正确"。真机问题必须接真实宿主测——`test/viewer-host.test.ts`（真实 TuiMainScreen headless 渲染 + VT 仿真）与 `test/viewer-mutex.test.ts`（打开互斥）就是为此存在；堆叠 bug 只在真实合成/diff 路径里，此文件破例实例化真实 pi-tui。
- 组件工厂式逐帧重绘在某 bundle 宿主上产生逐秒追加残影行——亮块渲染回退为每秒 string[] setWidget（c87bd3f）；`PI_AGENT_TEAM_WIDGET=0` 整体关闭用于 A/B 诊断。
- CJK/ANSI 行必须感知宽度截断补齐（`fitLine`）：曾因超宽行触发宿主 `doRender` 断言崩溃（d797975）。
- viewer 帧几何对齐 fleet inspector（v1.6.0 分栏）：最小宽度门 36 列（`width < 36` 单行提示）、`innerWidth = width - 2`、rosterWidth/detailWidth 公式与 `VIEWER_CHROME_ROWS = 6` 全部锁在 tui-sync §4 + 测试；帧高 ±1 行消抖、数据指纹门控刷新（elapsed 空转不重绘）、overlay 盒模型用 `VIEWER_OVERLAY_OPTIONS`（宽 95% / maxHeight 85% / margin 1，测试锁死）；close 键集对齐 fleet（`q`/`Esc`/`ctrl+c`，提示行仍只写 `q`——文案有意不变，别当成漏改）。
- viewer 停止/刷新/全部动作键位（v1.8.0 起全集）锁在 `VIEWER_ACTION_KEYS`——逐字对齐 fleet `DEFAULT_FLEET_KEYBINDINGS`（`↑↓/k/j` 切成员、`Shift+K/J` 滚动、`Home/End` 首末成员、`PgUp/PgDn` 翻页、`x/X/ctrl+o` 工具行、`D` 停止、`r`/`R` 刷新、`q`/`Esc`/`ctrl+c` 关闭）；旧键 `←→/h/l/Tab/1-9/g/G` 退役按下忽略；仅 `m` 发消息是特有键。
- viewer 右栏元信息头为固定四行 `Run:`/`State:`/`成员:`/`模型:`（v1.14.0；口径 v1.15.2）：模型=选中 actor 的后端，统一为 `provider/id` 展示口径（`model-caliber.ts` 纯函数，runner 原始上报数据不动）——声明含 provider 前缀时用「声明 provider 前缀 + 子进程实际上报 id 段」组合（实际跑了别的模型也如实显示，如 declared `opencode-go/deepseek-flash` + actual `deepseek-v3` → `opencode-go/deepseek-v3`）；实际值自带 `/` 原样用（不重复组合）、无声明不造假前缀（裸 id 就裸 id）、无实际回退声明值，两者皆无显示 `（默认）`。leader：live 用 `RunProgress.leaderDeclaredModel`（cockpit 启动时写入的声明值）+ `RunProgress.leaderModel`（实际上报），终态用 `record.leaderDeclaredModel` + `record.leaderUsage?.model`；成员：live 用 `MemberProgress.model`（声明值），终态用 `member.model` + `member.usage?.model`。`/team:status` 同口径（live leader 行与终态成员行）。头部仍不滚、帧总行数恒为 `bodyHeight + VIEWER_CHROME_ROWS`（行数 3→4 只吞一行正文窗口）。viewer 刷新不为此重读团队文件，也不改变任何键位/焦点语义（差异条目 tui-sync §3.13）。
- 确认横幅/notice 按右栏 detail 宽换行后占正文窗口顶部、窗口收缩、**帧总行数恒为 `bodyHeight + VIEWER_CHROME_ROWS`**（ghost-host 定高约束，差异条目 tui-sync §3.8）；busy 守卫防重复调 stop；notice 由按键清除或被新 notice 替换（不做自动淡出/指纹清除——停止结果 notice 会随 aborted 终态刷新立即变指纹，指纹清除会把它瞬间抹掉）。
- 焦点结构判定按 fleet 同款五方法形状（`render`/`invalidate`/`handleInput`/`getText`/`setText`）：宿主 `ctx.ui.editor()` 的 `ExtensionEditorComponent` 同样满足，会被判为编辑器——该对话框内 ↓ 仍可能被 widget 消费一次；与 fleet 行为一致，agent-team 自身不用该对话框，接受并记录在案。
- Kitty 键盘协议 flag 2 下每次按键额外发 release 事件（`:3` 编码，如 `\x1b[1;1:3B`），release 同样能被 `matchesKey` 命中——widget/viewer 的 key reducer 漏过滤会一次按键生效两次（真机 2026-09-15 实锤，fleet-status.ts:699 同款过滤）；repeat（`:2`）不得一并过滤，否则长按不能连续移动。
- widget 展开态窗口化（v1.14.2，差异条目 tui-sync §3.14）：帧总行数（含折叠提示行与底部提示行）≤ `WIDGET_MAX_LINES = 10`＝宿主 `setExtensionWidget` 对 `string[]` 的硬上限（超出会被宿主截为前 10 行 + `... (widget truncated)`）；选中行恒在窗口内、窗口 7..9 行，隐藏侧以 `  … 上方/下方还有 N 行` 明示；`WIDGET_MAX_LINES` 与宿主常量的等值由测试直接读宿主 dist 源码锁定（宿主漂移即红）。
- 入口接受 `{ spawn }` 供工具级测试（`test/run-tool.test.ts`）。
- **成员派发死锁（v1.15.0，真机 100% 复现；v1.15.1 修）**：`defaultSpawn` 的 stdio 从 `ignore` 改 `pipe` 后，成员 `--mode json -p` 等 stdin EOF、无人关管道 → run 永远 running（零输出 / 零 TCP 连接 / CPU 冻结）。`makeFakeSpawn`/`FakeChild` 的 stdin 是普通对象、不会真的等 EOF——**纯 fake 测试永远抓不到这类进程边界语义**；`runner.test.ts` 的两个真实子进程用例（默认模式见 EOF 即退出、显式 `pipe` 可写）就是它的回归护栏。

## 改动清单

- 必跑：`cd agent-team && npm install && npm test`（364 个）+ `npm run typecheck`。
- 真机级 reload 复演：`node test/reload-host-replay.mjs [部署副本 index.ts]`——用 pi 包真实 loader + ExtensionRunner 复演 reload 序列（shutdown → 重绑），非 fake；`node test/reload-real-env.mjs`——直接驱动宿主 `DefaultResourceLoader.reload()`（/reload 命令真实实现）在真实环境（git 包解析 + 缓存装载）跑两轮 reload。回归 /reload 工具消失 bug（b8f6eaf）。
- TUI 行为改动：**先读 `docs/tui-sync.md` 矩阵**，期望值从矩阵来（红→绿），改完在矩阵 §5 登记新版本号；除单测外必须跑 `viewer-host.test.ts`，最好真机 `/reload` 后目检一次。
- fake 模式：fake spawn 手写（`makeFakeSpawn` 式）；宿主交互测试实例化真实组件、只 fake 终端。
- 涉及团队文件格式：同步 `types.ts` + `examples/` + README。
- 改 viewer/widget/cockpit 外观或文档截图：跑 `node tools/capture-screens.mjs` 重生成 `docs/assets/agent-team-viewer.svg`、`docs/assets/agent-team-widget.svg`（亮块展开态；帧锚点自检失败即报错，说明渲染路径已变）。同一命令也重生成 `docs/assets/pwr-viewer.svg`（pwr `RunViewer` 场景，同一 VT/SVG 管线）。
