# 规格：远端 bash 超时转后台（remote-tools × timeout-bg job 托管）

> 关联条目：`remote-tools-todo#12`（主）+ `timeout-bg-todo#4`（配套，同一变更交付）
> 对齐文档：`todos/align/remote-tools-todo#12.md`（含 5 条人工确认决策）、`todos/align/timeout-bg-todo#4.md`
> 横切契约：`docs/cross/shell-tool-capability.md`（本变更在其中有新增章节）
> 日期：2026-10-11（UTC）· 状态：规格落盘，实现待领（分支引用 `feat/remote-timeout-bg`）

## 问题陈述

同一个 `bash` 工具，超时语义在本地与远端分叉，且远端的文案与事实相反。

**实测证据（2026-10-11，本机 + `user@127.0.0.1`）**

| 场景 | 返回 | 远端实际 | job | 日志 | 结束通知 |
| --- | --- | --- | --- | --- | --- |
| 本地 `sleep 6` + `timeout: 2` | `⏱ 命令超时（2 秒）：未杀死，已转入后台继续运行 / job: bg-8` | — | 有 | 有（`bg-8.log` 写入 `LOCAL-DONE`） | 有（`退出码 0（耗时 4s）`） |
| 远端 `sleep 15; echo ORPHAN-DONE > /tmp/orphan-probe.txt` + `timeout: 3` | 宿主原生文案 `Command timed out after 3 seconds` | **仍在跑**，16 秒后写出标记文件 | 无 | 无 | 无 |

两层危害：① 用户要记两套超时语义；② 文案读起来像"已中止"，实际远端命令继续运行——对 `rm -rf`、部署类命令是安全隐患。

根因：远端分支复用宿主 bash 定义执行，宿主用「kill 本地进程」实现 timeout（只杀掉本地 ssh），既没有转后台机制，也没有把这一事件交给任何 job 体系。契约 `docs/cross/shell-tool-capability.md` 对超时**零描述**，测试对这条路径**零断言**。

## 方案

1. **远端分支自管超时，不走宿主 kill**：远端 bash 在执行层不再让宿主定义对 timeout 杀链生效；改由远端分支自己计时，命中超时后把该次执行转入**后台 job**——本地继续持有同一 ssh 会话、输出继续写本地日志文件，命令跑完后按与本地同格式通知（job id、退出码、耗时、日志路径、末尾输出）。
2. **job 托管跨扩展**：`timeout-bg` 作为 job owner，经 `pi.events` 暴露 job 托管端口（注册 / 列出 / kill / clear）；`remote-tools` 在能力协商频道里取用，**禁跨扩展 import**（两个插件保持自包含、可单独安装）。频道形状与现有 shell 能力盒子同风格：同步派发、可变盒子、形状守卫、畸形载荷按「无能力」处理。
3. **统一查询面**：远端 job 出现在 `/bg` 列表、可 `/bg:kill`、可 `/bg:clear`，并计入状态条段——用户视角只有一个 job 列表。
4. **kill 语义**：`/bg:kill` 对远端 job 尽力终止远端进程组（`kill -- -PGID` / `pkill -P`），失败再退化为断开 ssh。
5. **默认超时**：远端调用未显式给 `timeout` 时沿用 timeout-bg 的 **300s**（`PI_TIMEOUT_BG_DEFAULT` 可覆盖），与本地同一个数字。
6. **契约与文档**：`docs/cross/shell-tool-capability.md` 增「远端超时与 job 托管」一节 + 新频道登记；两扩展卡片、相关 README、根 `README.md` 测试数同步。

## 用户故事

1. 作为使用者，我在远端跑长命令且命中超时后，拿到 job id 与日志路径，能立刻判断"它还在跑、日志在哪"，而不是读一句与事实相反的"timed out"。
2. 作为使用者，我打开 `/bg` 能同时看到本地与远端 job；`/bg:kill` 能真正终止远端进程（远端不再有孤儿）。
3. 作为使用者，远端 job 结束时我收到与本地同格式的通知（退出码、耗时、日志路径、末尾输出）。
4. 作为使用者，我只装了其中一个扩展时，行为与今天逐字一致，不会因为缺另一半而报错或退化。

## 实现决策

- **会话归属**：本地持有 ssh 到命令结束（换取真实退出码、耗时与通知）；不采用「远端 nohup + 轮询远端日志」。
- **跨扩展通道**：只用宿主的 `pi.events` 能力盒子（同步 `emit`、可变盒子、先到先得、形状守卫）；不得 import 对方模块、不得用 `globalThis` 私有槽；畸形载荷 ⇒ 当作「无能力」并走原路径。
- **owner 归属**：`bash` 工具 owner 仍是 `timeout-bg`（现状契约），远端执行由 `remote-tools` 提供；timeout 后的 job 转移由 owner 的 job 体系承接。
- **失败口径**：远端超时转后台失败（例如 ssh 提前断开）⇒ 结构化错误 + `notify` 一次，绝不静默当作"已杀"。
- **powershell 不覆盖**：`remote-tools` 无远端 powershell 能力，本变更不动 powershell 路径。
- **本地零回归**：本地超时 → 转后台 → 日志 → 通知这条链路的行为与文案保持逐字不变。

## 测试决策

- **单测（两扩展各自）**：远端分支的超时判定与后台转移（含「未超时不转后台」）；日志接管与通知格式；job 托管端口的注册/列出/kill/clear；畸形载荷守卫；本地语义零回归（复用现有 `bg-*` 用例）。
- **跨扩展集成**：真加载两个扩展 + 真 event bus + 真 `ExtensionRunner`（沿用 `shell-composition.test.ts` 模式），断言远端超时走 job 路径、**不出现宿主 `Command timed out after …` 文案**；未装对方扩展时两侧行为不变。
- **opt-in 真机用例**（沿用 `remote-live.test.ts` 的 opt-in 形态）：远端 `sleep N` 超时 ⇒ ① 返回含 job id 与日志路径；② 远端标记文件最终出现（命令未被杀）；③ `/bg:kill` 后远端进程消失（`ps` 无残留）。
- 验收以 `todos/align/remote-tools-todo#12.md` 的 6 条为准；全量门 + `npm run typecheck` + 跨厂商评审（红线 11）不破。

## 范围外

- 远端 powershell、远端进程组的强保证清理（只在 kill / 超时转移时尽力终止）。
- 远端 job 的持久化与跨会话恢复（与本地一致：会话结束即消失）。
- 宿主 `registerTool` 组合 API 的上游诉求（另立 `general-todo#30`），本变更仍走仓库内组合方案。
- 模型面 `bash` 参数任何变化（仍是 `command`/`timeout` + `remote`/`remotePort`/`remoteCwd` 的并集）。
- 远端超时的"自动重试""自动降级到远端 nohup"等未讨论的行为。

## 实现注记（2026-10-11，分支 `feat/remote-timeout-bg`，实现提交 `7de0a44`，评审修复 `ccb6e44` / `e77c448`）

实现与上文措辞的偏离与补充（红线 3：偏离要写清）：

- **job 托管端口的形状定为 `allocate` / `register` / `settle`**（不是三条独立的 register/kill/clear 命令）：
  `allocate` 在命令**开始前**发号 + 给本地日志路径（远端要先把 pid 写进文件供 kill 用、输出要全量落盘，只有真的超时才登记）；
  `kill` 不另开端口——提供方 `register` 时带上自己的 `terminate` 钩子（杀远端进程组 + 断本地 ssh），`/bg:kill` 与会话关闭
  都走它（优先于本地 `killTree(pid)`）；`clear` 用既有的 `/bg:clear`（同一个注册表，没有第二套列表）。
- **默认超时在 owner 侧转交**：`createBashDispatch` 在把参数交给远端分支**之前**把缺省的 `timeout` 填成 300s
  （`PI_TIMEOUT_BG_DEFAULT` 覆盖，`0` = 不施加）；远端分支不自己知道默认值，避免两处口径。
- **超时结果文本由 owner 单源提供**：`register` 的返回值就是要抛出的 tool error 文本（模板在 timeout-bg 的 `text.ts`），
  提供方不复制一份中文文案；跨扩展载荷进文本前剔控制字符 + 尾部限长 2000 字符。
- **远端进程定位用 /tmp 随机名 pid 文件**（不是「远端 nohup + 轮询远端日志」）：不需要解析远端 `$HOME`，
  也避免可预测路径的符号链接风险；`EXIT` / `TERM` / `HUP` trap 自清理，且 **TERM/HUP 显式 `exit`**
  （真机抓到过：只挂清理 trap 会让 shell 吞信号后继续跑下一条命令）。
- **状态条段**：`80:timeout-bg` 的 `⏱ <N> bg`（运行中任务数，本地 + 远端同一注册表），只在 N > 0 时出现；
  `docs/cross/status-bar.md` 的带表与格式表已同步。
- **测试数**：timeout-bg 53、remote-tools 90 本地 + 9 真机 opt-in；跨扩展组合测试真加载两个扩展
  （能力频道 + job 托管频道 + 反向加载顺序），真机用例覆盖「超时不断连」与「kill 后远端进程组消失」。
