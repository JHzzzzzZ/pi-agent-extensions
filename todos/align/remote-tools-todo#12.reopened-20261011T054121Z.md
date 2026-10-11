# 对齐：remote-tools-todo#12 — 远端 bash 超时语义与本地对齐（远端转后台 + 统一 job 面）

- 条目：`remote-tools-todo#12`（tags: `超时`,`组合`,`契约`）· 分支引用：`feat/remote-timeout-bg`
- 日期：2026-10-11（UTC）· 参与：用户（报障 + 选定方案 B + 逐条 yes）+ agent（实测取证、跨扩展边界梳理）
- 状态：用户已逐条确认，待 `align` 过后进入 `processing`
- 配套：timeout-bg 侧的 job 托管能力半边 = `timeout-bg-todo#4`（同一变更交付，不设 dep）

## 意图

用户 2026-10-11 实测：同一个 `bash` 工具，超时语义在本地与远端分叉。

- **本地**（timeout-bg）：超时不杀进程，转入后台继续跑，落日志、给出 job id、结束时发通知。闭环实测：`sleep 6` + `timeout: 2` → 返回 `⏱ 命令超时（2 秒）：未杀死，已转入后台继续运行 / job: bg-8`，稍后日志写入 `LOCAL-DONE`，并收到 `[timeout-bg bg-8] 后台命令已结束，退出码 0（耗时 4s）` 通知。
- **远端**（remote-tools 经组合后的远端分支）：返回宿主原生文案 `Command timed out after N seconds`，本地 ssh 被杀，**但远端命令没死、继续孤儿运行**——实测 `sleep 15; echo ORPHAN-DONE > /tmp/orphan-probe.txt`（`timeout: 3`）在 16 秒后写出了标记文件。既没有 job、也没有日志、更没有结束通知，文案还误导为「已结束」。

危害有两层：① 语义不一致，用户要记两套；② 文案说谎，`rm -rf`、部署这类命令超时后仍在远端跑，而使用者以为它被中止了。

用户选定**方案 B**：远端超时也走 timeout-bg 的转后台语义。契约 `docs/cross/shell-tool-capability.md` 目前**没有任何关于超时的描述**，测试也**没有任何断言**覆盖这条路径——两边都要补。

## 范围

**做什么**

1. **远端分支超时不断连**：远端 bash 命中 `timeout` 时不再杀本地 ssh，改为把命令转入后台继续执行；输出持续写本地日志文件；结束时按本地同格式通知（job id、退出码、耗时、日志路径、末尾输出）。
2. **统一 job 面**：远端超时产生的 job 出现在 timeout-bg 的既有查询面——`/bg` 列表、`/bg:kill`、`/bg:clear`，并计入状态条段。
3. **`/bg:kill` 真杀远端**：尽力终止远端进程组（`kill -- -PGID` / `pkill -P`），失败再退化为断开 ssh。
4. **契约扩展**：`docs/cross/shell-tool-capability.md` 增补「远端超时与 job 托管」一节，并新增一条能力频道承载 job 托管端口（timeout-bg 作为 job owner 暴露 register/kill，remote-tools 经 `pi.events` 取用；**禁跨扩展 import**，两个插件保持自包含可单独安装）。
5. **默认超时**：远端调用未显式给 `timeout` 时沿用 timeout-bg 的默认值 **300s**（`PI_TIMEOUT_BG_DEFAULT` 可覆盖）——用户只记一个数字。
6. **测试**：跨扩展组合集成测试（真加载两个扩展 + 真 event bus + 真 `ExtensionRunner`，断言远端超时走 job 路径而不是宿主 kill 路径）+ opt-in 真机用例（远端超时后 job 出现、远端命令不被杀、`/bg:kill` 后远端进程确实终止）。
7. **文档四处同步**：两扩展卡片、契约卡、相关 README；测试数唯一来源同步到根 `README.md`。

**明确不做什么**

- 不做远端 powershell：remote-tools 只提供 bash 远端能力（**Q4 决定：只覆盖 bash**）。
- 不改模型面 `bash` 参数（仍是 `command`/`timeout` + `remote`/`remotePort`/`remoteCwd` 的并集），不加新参数、不加新工具。
- 不改本地超时语义与本地 job 行为（零回归是硬要求）。
- 不打宿主补丁；上游 `registerTool` 组合诉求仍走 `general-todo#30`。
- 不做远端进程组的兜底清理（只在 `/bg:kill` 与 timeout 转后台时按需尽力终止），不追求"远端绝无孤儿"的强保证。

## 验收标准

1. **远端超时不再杀连**：远端 `sleep 15; echo MARK > /tmp/mark` 配 `timeout: 3` ⇒ 工具返回含 **job id 与日志路径**（不再是裸 `Command timed out after 3 seconds`），且稍后远端 `/tmp/mark` 出现（证明命令活到了结束）。
2. **job 面可用**：该 job 出现在 `/bg` 列表；`/bg:kill` 后远端进程确实终止（远端 `ps` 无残留 / 标记文件不再生成）。
3. **通知同格式**：结束时收到与本地同格式的通知（退出码、耗时、日志路径、末尾输出）。
4. **本地零回归**：本地超时→转后台→日志→结束通知这条链路复测通过（`bg-N` 用例）。
5. **缺一不可装**：只装 timeout-bg 或只装 remote-tools 时各自行为与今天逐字一致；显式给出远端 `timeout` 的正常（未超时）路径行为不变。
6. 两扩展单测全绿 + `npm run typecheck` 零错误 + 全量门绿；跨厂商评审到无新意见（红线 11）。

## 人工确认

- **确认人**：用户（本会话）· **日期**：2026-10-11（UTC）· **方式**：对第一轮 5 条设计问题逐条回复 `yes`（= 全部采纳 agent 推荐答案），并在此之前明确选定**方案 B**（远端超时转后台）而非方案 A（只改文案 + 锁现状）
- **逐条决策**：
  1. **Q1 ssh 会话归属**：本地继续持有同一 ssh（不 kill、输出继续落本地日志、退出码/耗时/末尾输出照抄本地格式）——不采用「远端 nohup + 轮询远端日志」
  2. **Q2 job 归属**：远端 job **进统一查询面**（`/bg`、`/bg:kill`、`/bg:clear`、状态条段），实现方式是契约新增 job 托管能力频道，timeout-bg 暴露端口，remote-tools 经 `pi.events` 取用（禁 import）
  3. **Q3 kill 语义**：`/bg:kill` **尽力杀远端进程组**，失败退化为断开 ssh（不采用「只断 ssh」）
  4. **Q4 范围**：**只覆盖 bash**（powershell 无远端能力）
  5. **Q5 默认超时**：远端沿用 timeout-bg 默认 **300s**（`PI_TIMEOUT_BG_DEFAULT` 可覆盖）
- **已知取舍（显式接受）**：① 远端超时期间会常驻一个本地 ssh 连接到命令结束（换取与本地一致的退出码与通知）；② 契约要多一条频道、timeout-bg 要多暴露一组 job 托管端口，是本条目最贵的部分；③ 远端进程组清理仍不追求强保证。
- **开工放行**：用户已确认全部 5 条决策，对齐文档落盘并通过 `align` 校验后进入 `processing`。
