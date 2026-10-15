# timeout-bg

shell 工具（`bash` / `powershell`）的**超时语义改写 + 主动转后台**。宿主原本的语义是「超时即整树 kill」，
且不显式传 `timeout` 就无限挂住；本扩展经公开接缝（`createBashTool` / `createPowerShellTool` 的 `operations`）改三件事。

## 能力

- **超时转后台** — 命中 `timeout`（显式或默认 300s）不再 kill：进程继续跑、输出继续写日志，本次 tool call 立刻以
  「已转后台 + jobId + 日志路径」的结果结束。**不要重跑超时的命令**，读日志拿中间结果。
- **主动转后台（`run_in_background: true`）** — 不等超时：进程一启动就转后台，本次调用立刻结束。
  长任务（构建 / 全量测试 / 下载 / 长轮询）用它代替「给一个很小的 timeout」。与 `timeout` 同时给时后台优先。
- **默认超时** — 未传 `timeout` 时用 300s（`PI_TIMEOUT_BG_DEFAULT=<秒>` 覆盖，`0` = 关闭；非法值回退并提示一次）。
- **完成通知** — 后台任务自然结束时给会话送一条通知（jobId / 退出码 / 耗时 / 末尾输出），不必轮询。以 `deliverAs: "steer"` 送达：agent 流式中在**当前工具批结束**时就进上下文，不等它收工（`#6` 之前的 followUp 只在 agent「本来要停」才被消费）。
- **命令面** — `/bg`（列表：状态 / 来源 `[超时]`\|`[后台]` / pid 或远端主机 / 命令首行 / 日志路径）、
  `/bg:kill <jobId>`（杀整棵进程树）、`/bg:clear`（清已结束记录）。
- **状态条** — 底部出现 `⏱ <N> bg`（运行中的后台任务数），没有运行时本段不占位置。
- **与 remote-tools 组合** — 两个扩展都覆盖 `bash`，宿主对同名工具按扩展加载顺序 first-wins：本扩展在注册前用
  `pi.events` 收集「shell 能力」，把远端参数并进合并后的 `bash` 并分派（远端超时同样转后台、进同一个 `/bg` 面；
  `run_in_background` 在远端同样生效）。要求 `timeout-bg` **先于** `remote-tools` 加载（仓库 `package.json` 顺序即如此），
  顺序相反时会提示冲突而不是静默。契约：[`docs/cross/shell-tool-capability.md`](../../../docs/cross/shell-tool-capability.md)。

## 边界

- 只覆盖**当前启用**的 shell 工具（`active` 里没有的不注册，不凭空加工具）；用户手敲的 `!` 命令与其它带
  `timeoutMs` 的工具（agent-team / pwr / subagent 等，属调度语义）不受影响。
- **Esc（abort）仍然是 kill**：取消 ≠ 超时。
- 后台任务**只活在本会话**，`session_shutdown` 时全部杀掉；不做跨会话守护。headless（`pi --print`）一次性会话里，会话一结束（pi 退出）后台任务即被杀、日志停在那刻——跨进程「等它跑完再 cat 日志」永远等不到；同会话内验收要「先转后台，再用前台命令等一会儿」。
- 对端不支持主动后台（没装 remote-tools 的远端分支 / 旧版端口）时，该组合 **fail-closed 报错**——
  不静默退化成前台等待、不在本机执行远端意图的命令。
- 日志：`<PI_TIMEOUT_BG_DIR 或 ~/.pi/agent/bg-jobs>/<pi pid>/<jobId>.log`，保留最近 50 个 / 7 天。
- codemode 脚本视角：`tools.bash` 的结构化结果（`output` 1 MiB 上限 / `truncated` / `full_output_path` /
  `exit_code` / `wall_time_seconds`）与内置一致；转后台那次调用以错误结束（脚本能 catch 到 jobId 文本）。

## 用法与开发

```bash
cd src/extensions/timeout-bg && npm install && npm test && npm run typecheck   # 70 个测试（+2 真机 opt-in：PI_TIMEOUT_BG_TEST_LIVE=1）
```

安装：把本目录复制到 `~/.pi/agent/extensions/timeout-bg/` 或 `<项目>/.pi/extensions/timeout-bg/`，Pi 内 `/reload`。

架构、不变量与踩过的坑见 [`docs/extensions/timeout-bg.md`](../../../docs/extensions/timeout-bg.md)。
