# agent-team — 可复用多 agent 团队

> last verified @ 8642a5b

## 职责与边界

Markdown 定义团队（leader + members），cockpit 模式下主 agent 通过 `team_run` 派单：拉起独立 leader 子进程，leader 经 `team_dispatch` 调度成员子进程并行干活，报告以 followUp 送回；派单变卦/超预算/跑偏时主 agent 用 `team_stop <runId>` 中止（runId 由 team_run 返回与 team_status 展示）。**不做**：worktree 管理（`worktree.ts` 只做薄封装）、脚本编排（那是 pwr）、缓存回放（每次使用重扫团队文件）。

## 文件地图

- `types.ts` — 团队文件格式（frontmatter `leader` + `members[]`，块标量 prompt）、常量（entry / 消息类型 / 环境变量 / 上限）。**改团队文件格式必看这里。**
- `config.ts` — 团队发现：`~/.pi/agent/teams/` 或受信任项目 `.pi/teams/`，同名项目优先，每次使用重扫。
- `runner.ts` — 子 `pi --mode json -p` 契约（leader 与 member 共用），`team-tmp://` prompt 物化，SIGTERM→SIGKILL。
- `dispatch.ts`（leader 模式工具）、`cockpit.ts`（cockpit 模式工具）、`manage.ts`（team_create/list）。
- `widget.ts` — 输入栏下方可选中亮块（`setWidget(key, string[], { placement: "belowEditor" })` 每秒刷新 + `onTerminalInput` 选中）；`viewer.ts` — `/team:view` 全屏查看器；`transcript.ts` — 成员转写物化。
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
- viewer 打开期间必须暂停下方 widget（`RunWidgetController.setPaused`），关闭恢复。

## 已知坑

- **TUI 渲染问题纯函数测试抓不住**：/team:view 顶部堆叠修了三轮（f430112 → edaac69 → cc3aa17），全是"纸面正确"。真机问题必须接真实宿主测——`test/viewer-host.test.ts`（真实 TuiMainScreen headless 渲染 + VT 仿真）与 `test/viewer-mutex.test.ts`（打开互斥）就是为此存在；堆叠 bug 只在真实合成/diff 路径里，此文件破例实例化真实 pi-tui。
- 组件工厂式逐帧重绘在某 bundle 宿主上产生逐秒追加残影行——亮块渲染回退为每秒 string[] setWidget（c87bd3f）；`PI_AGENT_TEAM_WIDGET=0` 整体关闭用于 A/B 诊断。
- CJK/ANSI 行必须感知宽度截断补齐（`fitLine`）：曾因超宽行触发宿主 `doRender` 断言崩溃（d797975）。
- viewer 帧高 ±1 行消抖、数据指纹门控刷新（elapsed 空转不重绘）、overlay 盒模型用 `VIEWER_OVERLAY_OPTIONS`（宽 96% / maxHeight 85% / margin 1）。
- 入口接受 `{ spawn }` 供工具级测试（`test/run-tool.test.ts`）。

## 改动清单

- 必跑：`cd agent-team && npm install && npm test`（137 个）。
- TUI 改动：除单测外必须跑 `viewer-host.test.ts`，最好真机 `/reload` 后目检一次。
- fake 模式：fake spawn 手写（`makeFakeSpawn` 式）；宿主交互测试实例化真实组件、只 fake 终端。
- 涉及团队文件格式：同步 `types.ts` + `examples/` + README。
