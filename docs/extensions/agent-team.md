# agent-team — 可复用多 agent 团队

> last verified @ 8303bfe

## 职责与边界

Markdown 定义团队（leader + members），cockpit 模式下主 agent 通过 `team_run` 派单：拉起独立 leader 子进程，leader 经 `team_dispatch` 调度成员子进程并行干活，报告以 followUp 送回；派单变卦/超预算/跑偏时主 agent 用 `team_stop <runId>` 中止（runId 由 team_run 返回与 team_status 展示）。**不做**：worktree 管理（`worktree.ts` 只做薄封装）、脚本编排（那是 pwr）、缓存回放（每次使用重扫团队文件）。

## 文件地图

- `types.ts` — 团队文件格式（frontmatter `leader` + `members[]`，块标量 prompt）、常量（entry / 消息类型 / 环境变量 / 上限）。**改团队文件格式必看这里。**
- `config.ts` — 团队发现：`~/.pi/agent/teams/` 或受信任项目 `.pi/teams/`，同名项目优先，每次使用重扫。
- `runner.ts` — 子 `pi --mode json -p` 契约（leader 与 member 共用），`team-tmp://` prompt 物化，SIGTERM→SIGKILL。
- `dispatch.ts`（leader 模式工具）、`cockpit.ts`（cockpit 模式工具）、`manage.ts`（team_create/list）。
- `widget.ts` — 输入栏下方可选中亮块（`setWidget(key, string[], { placement: "belowEditor" })` 每秒刷新 + `onTerminalInput` 选中；激活门控经 `editorState` 端口）；`viewer.ts` — `/team:view` 全屏查看器；`transcript.ts` — 成员转写物化；`docs/tui-sync.md` — TUI 行为对照 pi-subagents 的同步矩阵（**TUI 期望值唯一事实来源**）。
- 两种模式一套代码，以 `PI_AGENT_TEAM_FILE` 环境变量区分；leader 模式只注册 `team_dispatch`。

## 核心数据流

1. `team_run` → 默认后台派单（立即返回，含 runId）→ 拉起 leader 子进程（注入 `PI_AGENT_TEAM_FILE/NAME/RUN_ID`）。
2. leader 解释团队 prompt → 调 `team_dispatch`（每 dispatch ≤8 任务、≤4 并发成员）。
3. 每任务物化 `team-tmp://` prompt → member 子 pi 执行 → 结果 ≤50KB / 摘要 ≤8KB 回 leader。
4. leader 汇总 → 退出码 0 → 报告经 `deliverRunResult` 以 followUp 自动送达主会话。
5. `wait: true` 保留同步契约（注意：同步 await 会阻塞主 agent 轮次）。
6. `team_stop <runId>` 中止：`stopAndSettle()` SIGTERM→SIGKILL 后有界等待（默认 7s）落定，返回 aborted 终态记录；停止后该 run 的报告 followUp 不再送达，可立即重新派单。

## 不变量

- 自包含：不引 pwr、不依赖其它扩展目录，独立可复制加载。
- 上限：每 dispatch 8 任务、4 并发、50KB 结果、8KB 摘要（`TeamErrorCodes` result union）。
- run 生命周期由 coordinator 同步 claim 保护：`start()` 在首个 await 前占住 active/pending/progress，finally 清空——并发 start 竞态与终态后残留 progress 均由此拦截；aborted 终态必须补全 roster 成员（queued/running → aborted），否则 widget/status 少报。
- `team_stop` 的 runId 必填：省略/未知/已结束分别返回 `RUN_ID_REQUIRED`/`RUN_NOT_FOUND`/`RUN_ALREADY_FINISHED`（类型化错误，不抛异常）。
- 亮块 `setWidget` 传**纯字符串数组**（无样式）——`ExtensionUIContext` 无 `theme` 字段，类型化访问 `ctx.ui.theme` 无法编译。
- 亮块终态行只能 `/team:clear` 手动清除（run 进行中拒绝，只卸 widget 不动 `lastRecord`）；`session_start` 水合仅在存在 **running** run 时挂亮块——终态记录不自动重挂（否则用户 clear 后 /reload 又复活）；派新单经 `startBackgroundRun → ensureRunWidget` 自然复挂。集成测试要挂 widget 时必须走真实派单（旧“水合终态记录即挂载”路径已删）。
- viewer 打开期间必须暂停下方 widget（`RunWidgetController.setPaused`），关闭恢复。
- **不偷编辑器按键**：亮块非选中态只有激活键被消费，其余（含 esc）原样交还编辑器；bare `↓`/`←` 仅当编辑器为空才激活（`editorState` 端口注入 `getEditorText`，宿主缺该 API 时降级为仅 alt 通道）。
- **TUI 同步 ≠ 依赖**：viewer/widget 行为对照 pi-subagents（基线 v0.66.0，`agent-team/docs/tui-sync.md`）代码级同步，但不 import 它；测试期望只能从矩阵来，不从实现反推；同步后登记新版本号。
- 渲染串指纹相同跳过 `setWidget`（renderKey 对齐）；但 `setPaused(false)` 必须重置指纹强制重绘——否则恢复帧被跳过，亮块卡在隐藏态。
- 双加载守卫（`globalThis.__piAgentTeamExtensionLoaded`）**复位时机 = session_shutdown**：pi 宿主保证重绑扩展（reload/new/resume/fork/switch）前必发该事件，entry 在此删标志，下一次 factory 调用重新注册全部工具/命令；同一进程内两份之间无 shutdown 的真双加载（leader 子 `-e` + 自动发现）依旧被抑制。没有复位的话 `/reload` 后 team_* 工具全部消失。
- 组件工厂式逐帧重绘在某 bundle 宿主上产生逐秒追加残影行

## 已知坑

- **TUI 渲染问题纯函数测试抓不住**：/team:view 顶部堆叠修了三轮（f430112 → edaac69 → cc3aa17），全是"纸面正确"。真机问题必须接真实宿主测——`test/viewer-host.test.ts`（真实 TuiMainScreen headless 渲染 + VT 仿真）与 `test/viewer-mutex.test.ts`（打开互斥）就是为此存在；堆叠 bug 只在真实合成/diff 路径里，此文件破例实例化真实 pi-tui。
- 组件工厂式逐帧重绘在某 bundle 宿主上产生逐秒追加残影行——亮块渲染回退为每秒 string[] setWidget（c87bd3f）；`PI_AGENT_TEAM_WIDGET=0` 整体关闭用于 A/B 诊断。
- CJK/ANSI 行必须感知宽度截断补齐（`fitLine`）：曾因超宽行触发宿主 `doRender` 断言崩溃（d797975）。
- viewer 帧高 ±1 行消抖、数据指纹门控刷新（elapsed 空转不重绘）、overlay 盒模型用 `VIEWER_OVERLAY_OPTIONS`（宽 96% / maxHeight 85% / margin 1，测试锁死）；close 键集对齐 fleet（`q`/`Esc`/`ctrl+c`，提示行仍只写 `q`——文案有意不变，别当成漏改）。
- 入口接受 `{ spawn }` 供工具级测试（`test/run-tool.test.ts`）。

## 改动清单

- 必跑：`cd agent-team && npm install && npm test`（147 个）。
- 真机级 reload 复演：`node test/reload-host-replay.mjs [部署副本 index.ts]`——用 pi 包真实 loader + ExtensionRunner 复演 reload 序列（shutdown → 重绑），非 fake；回归 /reload 工具消失 bug（b8f6eaf）。
- TUI 行为改动：**先读 `docs/tui-sync.md` 矩阵**，期望值从矩阵来（红→绿），改完在矩阵 §5 登记新版本号；除单测外必须跑 `viewer-host.test.ts`，最好真机 `/reload` 后目检一次。
- fake 模式：fake spawn 手写（`makeFakeSpawn` 式）；宿主交互测试实例化真实组件、只 fake 终端。
- 涉及团队文件格式：同步 `types.ts` + `examples/` + README。
