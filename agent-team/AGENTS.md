# agent-team 知识库
<!-- PROJECT KNOWLEDGE BASE / Generated: 2026-09-09T03:50:04Z / Commit: 457adcf / Branch: dev-laptop / Parent: 根 AGENTS.md -->

## OVERVIEW
可复用多 agent 团队：独立 leader 子进程经 `team_dispatch` 调度成员子进程；遇需求歧义时经 `team_ask` 向主会话（用户）提问并阻塞等待，答案经 cockpit 回写后继续。自包含不引 pwr。

## WHERE TO LOOK
| 任务 | 位置 |
|---|---|
| 团队文件格式 | `~/.pi/agent/teams/*.md` 或受信项目 `.pi/teams/`（项目优先），frontmatter `leader` + `members[]` |
| 成员字段 | 每成员 `provider/model` + `tools` + `worktree` + 块标量 `prompt`，见 `examples/dev-team.example.md` |
| 双模式分叉 | `PI_AGENT_TEAM_FILE`：有则 leader 模式（`team_dispatch` + `team_ask`），无则 cockpit 模式（`team_create/list/run/resume/status/stop` + `/team*`） |
| leader 提问（人工澄清） | leader 侧 `ask.ts` `askLeaderQuestion`（team_ask 工具）；cockpit 侧 `AskChannel` + `index.ts` `askPortFrom(ctx)` 宿主对话框；RPC 协议 = pi stdout `extension_ui_request` ↔ stdin `extension_ui_response` |
| 续跑/换模型 | `resume.ts`（父 status/会话镜像/cwd/override 纯函数 + `restoreWorktree` 在 `worktree.ts`）+ `cockpit.ts` `start({resume})`（`--session <父文件>` 原地续写 + 父 worktree 恢复）+ `team_resume` 工具//`/team:resume`；leader 会话落盘 `<runsRoot>/<runId>/session/`（v1.21.0） |
| 停止/终态 | `cockpit.ts` `TeamRunCoordinator.stop()`（同步 abort）/`stopAndSettle()`（有界等待落定返回终态记录）+ `team_stop` 工具（runId 必填；aborted 记录补全 roster 成员） |
| 派发/并发上限 | `dispatch.ts`：每 dispatch ≤8 任务，4 并发成员 |
| 子进程复用 | `runner.ts`（子 pi JSON 模式，`team-tmp://` 物化，SIGTERM→SIGKILL） |
| 子进程 env / 工具面 | 成员 env 经 `dispatch.ts` `stripLeaderEnv()` 剥离 `PI_AGENT_TEAM_FILE/NAME/RUN_ID`；leader 与成员 args 统一 `--exclude-tools subagent,team_run`（`types.ts` `DERIVED_AGENT_TOOL_DENYLIST`，exclude 优先于 `--tools`） |
| 隔离分支 | `worktree.ts`（每次 run 独立分支；同 run 重派复用已注册 worktree / 空闲同名分支，不碰当前目录） |
| 亮块/进度节拍 | `widget.ts` + `cockpit.ts` 走 `aligned-ticker.ts`（对齐墙钟秒边界，契约 `docs/cross/status-bar.md`）；数据驱动挂载：controller 每会话挂一次，运行中有帧、落定 `setWidget(undefined)` 自动卸载；未选中态 = 折叠单行 `agent-team <团队> · ↓/← 查看详情`，选中态 = `main → leader（含任务摘要）→ 成员…` 树 + 底部提示行（末行恒为成员行；v1.13.0，任务摘要 v1.13.1 并入）；连接符 `├─ `/`╰─ `（末项圆角，v1.15.4），每行带背景（普通行 `rowBg`、选中行 `rowSelectedBg`，按宿主内容宽补齐，v1.15.4） |
| 错误码 | `types.ts` `TeamErrorCodes` |

## CONVENTIONS
- 团队文件每次使用重扫，无缓存 —— 加缓存则项目覆盖用户优先级失效。
- leader prompt 经 `leader-prompt.ts` 组装，自包含任务上下文 —— 直传用户原话则成员看不到约束。
- 结果 ≤50KB、摘要 ≤8KB，与 pwr 同限不同码 —— 超限截断，违则 cockpit entry 溢出。
- cockpit/widget/entry 键 `agent-team-run-v1` —— 改键则旧会话渲染器失配。
- start() 在首个 await 前同步 claim（controller + progress + pending）且 finally 清空 —— 并发 start 竞态与终态后残留 progress 均由此拦截；aborted 终态必须补全 roster（否则 widget/status 少报成员）。
- 派生 agent 子进程的环境与工具面必须显式声明（v1.17.1）：成员剥 leader 三键、两侧 `--exclude-tools subagent,team_run`（宿主排除优先于 `--tools` 白名单）——默认继承会把 leader 模式标记泄漏成成员行为开关，也放行嵌套派单绕过预算。
- 缩进 2 空格（pwr 用 tab）—— 混用即 diff 噪音。
- 时间类刷新走 `aligned-ticker.ts`（widget 重绘 + cockpit 进度 ticker，勿用裸 `setInterval`）—— 相位漂移会让多个 widget 逐秒换位；`tickMs` 仅测试覆盖。
- 亮块每行按宿主内容宽（终端宽 − 2，宿主 `setExtensionWidget` 对 `string[]` 包 `Text(line, 1, 0)` 两侧各 1 列 margin）CJK 双宽截断+补齐后再包背景：背景块等宽连续、不折行不超宽；连接符前缀恒 3 列（与旧 `|- ` 等宽），截断预算不变。
- 亮块行文本不允许含换行：任务/尾注先 `\s+` 压平再截断（任务 44 + `…`、成员尾注 ≤30）—— 残余换行由宿主渲染成额外行（截图回归）；折叠单行只报团队名，状态/耗时/并行数只在展开树。
- 亮块挂载由数据决定（v1.13.0）：`buildWidgetView` 仅在 `running && progress` 时产出视图，否则返回空——`RunWidgetController.refresh()` 空视图即卸载（setWidget undefined + 复位选择态）；刷新由 coordinator `onProgress` 事件即时驱动 + 1s tick 兜底，`/team:clear` 不碰 widget（只清排队对话）。
- 按键 reducer（widget `handleWidgetKey` / viewer `handleViewerKey`）顶部必须 `isKeyRelease` 短路（fleet-status.ts:699）：Kitty 键盘协议 flag 2 下 release 事件（`:3` 编码）同样能被 `matchesKey` 命中，漏过滤 = 一次按键生效两次（激活+移动/跳两行/开关两回）；repeat（`:2`）故意保留（长按连移）。
- leader 提问必须 fail-closed：任何等待都有界（工具侧超时 30s~30min，默认 10 分钟；cockpit 侧 backstop = 超时 + 5s），超时/取消/主会话无 UI/run abort 一律回 `extension_ui_response {cancelled}`，leader 按工具结果自行决策 —— 无界等待会把 run 挂死（对齐 v1.15.0 教训）。
- RPC dialog 不能从 `session_start` 触发：pi 在 session-start 处理器 pending 期间不消费 RPC stdin，请求永远收不到 response（真机 E2E 实证，fixture 改用 `/ask-e2e` 命令触发）。
- 真机 E2E 起 pi 子进程用包的真实 bin 入口 `dist/bundle/cli.js`（unbundled `dist/cli.js` 在本工作区不启动），并以 `PI_CODING_AGENT_DIR` 隔离用户全局扩展/配置。

## ANTI-PATTERNS
- 从 pwr import 复用 —— 实证：自包含声明，`runner.ts` 另写一份子 pi 适配，不引 `pwr/runner`。
- dispatch 超 8 任务/4 并发 —— 实证：`dispatch.ts` 硬上限，超发直接拒绝不排队。
- 成员 prompt 一句空话 —— 实证：`examples/dev-team.example.md` 要求角色+约束+输出格式+验收。
- 前台 run 切视角换行重影 —— 实证：`todos/agent-team-todo.md` 未关闭条目，`view` 下 leader 派活后复现。

## COMMANDS
```bash
cd agent-team && npm install && npm test   # 550 测试（node --test test/*.test.ts）
node test/resume-host-smoke.mjs            # opt-in：真实 pi 验证 --session 原地续写（不调模型）
npm run typecheck
```
