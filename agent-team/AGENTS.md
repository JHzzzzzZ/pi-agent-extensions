# agent-team 知识库
<!-- PROJECT KNOWLEDGE BASE / Generated: 2026-09-09T03:50:04Z / Commit: 457adcf / Branch: dev-laptop / Parent: 根 AGENTS.md -->

## OVERVIEW
可复用多 agent 团队：独立 leader 子进程经 `team_dispatch` 调度成员子进程，自包含不引 pwr。

## WHERE TO LOOK
| 任务 | 位置 |
|---|---|
| 团队文件格式 | `~/.pi/agent/teams/*.md` 或受信项目 `.pi/teams/`（项目优先），frontmatter `leader` + `members[]` |
| 成员字段 | 每成员 `provider/model` + `tools` + `worktree` + 块标量 `prompt`，见 `examples/dev-team.example.md` |
| 双模式分叉 | `PI_AGENT_TEAM_FILE`：有则 leader 模式（仅 `team_dispatch`），无则 cockpit 模式（`team_create/list/run/status/stop` + `/team*`） |
| 停止/终态 | `cockpit.ts` `TeamRunCoordinator.stop()`（同步 abort）/`stopAndSettle()`（有界等待落定返回终态记录）+ `team_stop` 工具（runId 必填；aborted 记录补全 roster 成员） |
| 派发/并发上限 | `dispatch.ts`：每 dispatch ≤8 任务，4 并发成员 |
| 子进程复用 | `runner.ts`（子 pi JSON 模式，`team-tmp://` 物化，SIGTERM→SIGKILL） |
| 隔离分支 | `worktree.ts`（每次 run 独立分支；同 run 重派复用已注册 worktree / 空闲同名分支，不碰当前目录） |
| 亮块/进度节拍 | `widget.ts` + `cockpit.ts` 走 `aligned-ticker.ts`（对齐墙钟秒边界，契约 `docs/cross/status-bar.md`）；数据驱动挂载：controller 每会话挂一次，运行中有帧、落定 `setWidget(undefined)` 自动卸载；未选中态 = 折叠单行 `agent-team <团队> · ↓/← 查看详情`，选中态 = `main → leader（含任务摘要）→ 成员…` 树 + 底部提示行（末行恒为成员行；v1.13.0，任务摘要 v1.13.1 并入） |
| 错误码 | `types.ts` `TeamErrorCodes` |

## CONVENTIONS
- 团队文件每次使用重扫，无缓存 —— 加缓存则项目覆盖用户优先级失效。
- leader prompt 经 `leader-prompt.ts` 组装，自包含任务上下文 —— 直传用户原话则成员看不到约束。
- 结果 ≤50KB、摘要 ≤8KB，与 pwr 同限不同码 —— 超限截断，违则 cockpit entry 溢出。
- cockpit/widget/entry 键 `agent-team-run-v1` —— 改键则旧会话渲染器失配。
- start() 在首个 await 前同步 claim（controller + progress + pending）且 finally 清空 —— 并发 start 竞态与终态后残留 progress 均由此拦截；aborted 终态必须补全 roster（否则 widget/status 少报成员）。
- 缩进 2 空格（pwr 用 tab）—— 混用即 diff 噪音。
- 时间类刷新走 `aligned-ticker.ts`（widget 重绘 + cockpit 进度 ticker，勿用裸 `setInterval`）—— 相位漂移会让多个 widget 逐秒换位；`tickMs` 仅测试覆盖。
- 亮块行文本不允许含换行：任务/尾注先 `\s+` 压平再截断（任务 44 + `…`、成员尾注 ≤30）—— 残余换行由宿主渲染成额外行（截图回归）；折叠单行只报团队名，状态/耗时/并行数只在展开树。
- 亮块挂载由数据决定（v1.13.0）：`buildWidgetView` 仅在 `running && progress` 时产出视图，否则返回空——`RunWidgetController.refresh()` 空视图即卸载（setWidget undefined + 复位选择态）；刷新由 coordinator `onProgress` 事件即时驱动 + 1s tick 兜底，`/team:clear` 不碰 widget（只清排队对话）。
- 按键 reducer（widget `handleWidgetKey` / viewer `handleViewerKey`）顶部必须 `isKeyRelease` 短路（fleet-status.ts:699）：Kitty 键盘协议 flag 2 下 release 事件（`:3` 编码）同样能被 `matchesKey` 命中，漏过滤 = 一次按键生效两次（激活+移动/跳两行/开关两回）；repeat（`:2`）故意保留（长按连移）。

## ANTI-PATTERNS
- 从 pwr import 复用 —— 实证：自包含声明，`runner.ts` 另写一份子 pi 适配，不引 `pwr/runner`。
- dispatch 超 8 任务/4 并发 —— 实证：`dispatch.ts` 硬上限，超发直接拒绝不排队。
- 成员 prompt 一句空话 —— 实证：`examples/dev-team.example.md` 要求角色+约束+输出格式+验收。
- 前台 run 切视角换行重影 —— 实证：`todos/agent-team-todo.md` 未关闭条目，`view` 下 leader 派活后复现。

## COMMANDS
```bash
cd agent-team && npm install && npm test   # 372 测试（node --test test/*.test.ts）
npm run typecheck
```
