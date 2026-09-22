# timeout-bg-todo#1 timeout-bg 插件：工具超时转后台 + 默认超时

## 意图

宿主内置 shell 工具（`bash` / `powershell`）的 `timeout` 参数当前语义是**超时即整树 kill**
（`killProcessTree`，报 `Command timed out after N seconds`），且 `timeout` 可选、**无默认值**。
后果：①合法长任务（构建、全量测试、下载）一旦命中超时，已完成的工作全丢，agent 只能从头重跑；
②没有默认超时，模型不传 `timeout` 时命令可以无限挂住，整轮会话卡死。

本插件（`timeout-bg`）把超时语义从「杀掉」改成「转后台继续跑」，并给未显式传 `timeout` 的调用
施加一个默认超时。目标不是更严的管控，而是**不丢工作 + 不卡会话**：超时后进程照常跑完，输出有落盘，
会话里拿到一条可读的结果与日志路径，完成后自动收到通知。

## 范围

**做什么**

1. 覆盖内置 `bash` 与 `powershell` 两个 shell 工具的 `execute`：正常情况（超时前退出）行为与宿主一致
   （输出尾部截断 + 非零退出报错）；命中超时（显式或默认）不再 kill，进程转入后台继续运行。
2. 未显式传 `timeout` 时施加默认超时 300 秒；环境变量 `PI_TIMEOUT_BG_DEFAULT`（秒）覆盖，`0` 表示关闭默认超时。
3. 后台任务输出落盘 `~/.pi/agent/bg-jobs/<jobId>.log`（jobId 为进程内自增短 id，如 `bg-1`）；
   tool result 文本里给出 jobId、pid 与日志路径，agent 用现有 `read` / `bash tail` 查看，不新增 agent 工具。
4. 后台任务退出时给会话注入一条简短 followUp 消息（jobId、退出码、输出末尾若干行）。
5. 会话级生命周期：`session_shutdown` 时杀掉本会话遗留的后台任务（属主是本进程）。
6. 人工管理命令面 `/bg`（列表：jobId / 状态 / pid / 命令首行 / 日志路径）、`/bg:kill <id>`、`/bg:clear`。
7. 保留最近 50 个任务 / 7 天日志，启动时清理更老的任务目录。

**明确不做什么**

- 不改宿主、不给宿主打补丁（红线 8）；只走公开扩展 API（`createBashTool`/`createPowerShellTool` 的
  `operations` 接缝 + `registerTool` 同名覆盖 + `session_shutdown` + `sendMessage`）。
- 不覆盖用户手敲的 `!` 命令（`user_bash`）——人看得见输出、可直接中断。
- 不把 Esc / abort 也转后台：主动取消仍然 kill（超时 ≠ 用户取消）。
- 不改任何带 `timeoutMs` 的**非 shell 工具**（agent-team / pwr / subagent 等）的超时语义——它们的超时
  是调度层语义，不是「杀进程」。本插件只处理两个 shell 工具。
- 不做跨会话后台守护 / 进程池 / 队列；后台任务不跨 pi 会话存活。
- 不加状态条 widget（命令面足够，避免与 run-timer 等抢 footer 带宽）。

## 验收标准

1. 单测（`node:test` + 手写 fake，不 mock 库）覆盖：
   - 未传 `timeout` → 生效默认 300s；`PI_TIMEOUT_BG_DEFAULT=0` → 不施加默认超时；非法值回退默认并警告一次。
   - 显式 `timeout` → 用显式值；`timeout` 非正数/超上限沿用宿主校验语义（报错文本一致）。
   - 超时前退出 → 结果形状与宿主一致（output 尾部 + 截断 details；非零退出 → isError）。
   - 超时命中 → 返回文本含 jobId / pid / 日志路径；**进程未被杀**（fake spawn 断言无 kill 调用）；job 状态为 running。
   - 后台任务退出 → 注册表状态转 exited(exitCode)，并触发一次 followUp 发送（fake 断言消息形状）。
   - abort（Esc）→ 仍然 kill（fake 断言 kill 调用），不产生后台任务。
   - 日志保留策略：>50 个或 >7 天的任务被清理，边界内不清理。
2. 真机验证：在 pi 里跑一条 `sleep 400` 且 `timeout: 2` 的命令 → 2 秒后 tool result 报告转后台，
   进程用 `/bg` 可见且继续跑完，完成后收到 followUp。
3. 全量测试绿 + `npm run typecheck` 零错误（含新扩展纳入 test-all 套件与根 `pi.extensions` 注册）。
4. 文档同步：`docs/extensions/timeout-bg.md` 建卡 + `docs/INDEX.md` 登记 + 根 `README.md` 用法与测试数 +
   `AGENTS.md` 目录/命令清单 + `package.json` 版本 bump + `todos/timeout-bg-todo.json` 一一对应。

## 人工确认

- 确认人：用户（仓库所有者）
- 日期：2026-09-22
- 方式：会话内逐条确认对齐问题 Q1–Q5（覆盖 `bash`+`powershell`、Esc 仍 kill、默认 300s 环境变量可覆盖、
  会话级生命周期、完成自动 followUp、不新增 agent 工具 + `/bg` 命令面），回复「没问题」。
