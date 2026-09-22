# timeout-bg — shell 工具超时转后台 + 默认超时

> last verified @ 3f3ffa4

一句话：覆盖内置 `bash` / `powershell` 工具，把「超时即 `killProcessTree` 整树杀」改成「超时转后台继续跑」，
并在未显式传 `timeout` 时施加默认 300 秒（`PI_TIMEOUT_BG_DEFAULT` 覆盖，`0` = 关闭）。

## 为什么这么做

宿主 `dist/core/tools/bash.js` 的 `resolveTimeoutMs`：`timeout === undefined` → 返回 undefined，**不传超时就能无限挂住会话**；
传了超时则计时到点 `killProcessTree(child.pid)` 整树杀，长任务（构建 / 全量测试 / 下载）已完成的工作全丢。
插件侧唯一公开接缝是 `createBashTool(cwd, { operations })` / `createPowerShellTool(...)` 的 `BashOperations.exec`，
所以本插件走「同名工具覆盖 + 自定义 operations」，不改宿主（红线 8）。

## 不变量（改代码前必须知道）

- **超时 ≠ 取消**：abort（Esc）仍然 `killTree`；只有计时器命中才转后台。
- **转后台 = 本次 tool call 以错误结束**：宿主 `exec` 契约只有 resolve/reject，我们以 `Error(超时结果文本)` 结束调用。
  宿主的 OutputAccumulator 会丢弃非 `timeout:` 前缀错误的累积文本，所以结果里的「最近输出」取自 ops 自己的内存尾部缓冲
  （`TIMEOUT_TAIL_BYTES`），**不能**现读日志文件（写入流可能尚未 flush）。
- **只有超时转后台的任务进注册表**：正常结束的命令不进——`/bg` 列表的语义就是「转后台的任务」。
- **退出必须等日志 flush**：`logStream.end(cb)` 回调后才 settle；否则调用方读到半截日志。
- **只有 active 里的 shell 工具被覆盖**：`session_start` 读 `pi.getActiveTools()` 后按需注册；无条件注册会把用户关掉的工具重新启用。
- **提示词元数据不继承**：覆盖工具时宿主不继承内置 `promptSnippet` / `promptGuidelines`，本插件显式拼上 `promptGuidelines`，
  并改写 `description` 与 `timeout` 参数说明（宿主原文写着 "no default timeout"，与新语义冲突）。
- **日志布局**：`<PI_TIMEOUT_BG_DIR | ~/.pi/agent/bg-jobs>/<pi pid>/<jobId>.log`；保留最近 50 个 / 7 天，`session_start` 时清理。
- **会话级生命周期**：`session_shutdown` 杀光本会话遗留的后台任务；不做跨会话守护、不写 pid 文件。
- **killTree 自实现**：宿主的 `killProcessTree` 不在包导出面。Windows 用 `taskkill /pid <pid> /T /F`；
  其余平台 `process.kill(-pid)`（spawn 时 `detached: true` 建进程组，与宿主一致）。

## 文件地图

- `index.ts` — 接线：工具覆盖、`/bg` 命令面、`session_start`/`session_shutdown`、followUp 送达、默认 deps
- `shell-ops.ts` — `BashOperations.exec` 实现：spawn → 计时 → 输出落盘 → 退出/超时/abort 分流
- `jobs.ts` — 后台任务注册表（`running` → `exited` / `killed`，注入 `now` / `killTree` / `onExit`）
- `logs.ts` — 日志尾部读取、控制字符剔除、保留策略（7 天 / 50 个）
- `config.ts` — 默认超时解析（env）与 timeout 毫秒校验（非法文案与宿主逐字一致）
- `text.ts` — 面向模型/人的静态文本模板（超时结果 / followUp / `/bg` 列表）

## 坑

- 测试里调宿主 `createBashTool(...).execute` 必须给 fake ctx 提供 `sessionManager.getSessionId/getSessionFile` 与 `model`——
  宿主用它们注入 `PI_*` 环境变量，缺了就报 `Cannot read properties of undefined (reading 'getSessionId')`。
- 覆盖内置工具会让 pi 启动时打印「工具被覆盖」提示：预期行为，不是故障。
- Windows 上 `detached` 不生效（宿主同款写法）；进程能活下来是因为没有 job object 关联，退出时靠 `session_shutdown` 主动杀。
- `tools/install-smoke.mjs` 的 `EXTENSION_EXPECTATIONS` 必须同步加条目（命令 `bg` / `bg:kill` / `bg:clear`，无 uiKeys），
  `test/install-smoke.test.ts` 的 manifest 漂移测试会锁定；`tools/test-all.mjs` 的 `DEFAULT_SUITES` 同理被 `test/test-all.test.ts` 锁定。
- 后台任务输出会**无条件**落盘（正常结束的命令也留日志，直到保留策略清理）——换来「超时那一刻已有完整历史」，
  代价是磁盘占用，这是有意取舍。

## 测试与验证

- `cd src/extensions/timeout-bg && npm install && npm test && npm run typecheck`（31 个：config / jobs / logs / shell-ops / index 接线）
- 进程边界测试只 fake `spawn` 与 `killTree`，真实读写临时目录日志、真实毫秒级计时器；工具本体用宿主真实 `createBashTool`。
- 真机验证（2026-09-22，Windows + Node 24）：真实 spawn + 真实计时器跑 `for i in 1..6; do echo tick-$i; sleep 1; done`，
  `timeout: 2` → 2.3s 转后台、进程存活且日志持续增长 → 7.3s 自然结束，注册表转 `exited(0)` 且 `onExit` 恰好一次。
