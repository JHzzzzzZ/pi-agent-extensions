# timeout-bg — shell 工具超时转后台 + 默认超时

> last verified @ 1c1acc5

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
- **结构化结果靠「spread 宿主工具」天然对齐（timeout-bg#2）**：注册的工具是宿主 `createBashTool(cwd, { operations })` 的返回值
  加覆盖 `description` / `parameters` / `promptGuidelines`，`outputSchema` 与 `structuredContent`（codemode 脚本视角的
  `output` / `truncated` / `full_output_path` / `exit_code` / `wall_time_seconds`）全由宿主工具层生成。
  **动哪里会破**：一旦改成自己拼返回值（`defineTool` / 自定义 `execute`）而不再 spread 宿主工具，就必须自己声明等价的
  `outputSchema` 并回填 `structuredContent`，否则脚本侧静默退化（拿不到 1 MiB 输出与落盘路径）——`test/index.test.ts` 的
  两条「codemode 视角」测试锁的就是这个（devDependency 因此要求 `^1.0.0`：0.85.x 既无 codemode 也无 outputSchema）。

## codemode 结构化结果（timeout-bg#2 实测，pi 1.0.1）

差异表（本扩展返回值 vs 上游 `docs/codemode.md`「Call tools」声明），逐字段全对齐：

| 字段 | 上游声明 | 实测（真机 codemode 脚本） | 差异 |
|---|---|---|---|
| `output` | 上限 1 MiB；超长保首尾各 512 KiB + 省略标记；空输出为 `""` | 1.6 MB 输入 → `len 1048611`（1 MiB + `[... N bytes omitted ...]`，首 `AAAA` 尾 `A==\n`）；空输出 `""`（非 `(no output)`）；`seq 1 5000` → 23.9 KB 全量返回（`startsWith: "1\n2\n"`，首行也在），不被模型侧 2000 行口径截断 | 无 |
| `truncated` | boolean | `false`（小 / 空输出）、`true`（>1 MiB） | 无 |
| `full_output_path` | 可选，仅截断时给 | 仅截断时出现，指向宿主 `pi-bash-*.log`（`details.fullOutputPath` 同值） | 无 |
| `exit_code` | number；非零退出仍返回结构值而非 reject | `exit 3` → `{ output: "boom\n", exit_code: 3 }` | 无 |
| `wall_time_seconds` | number | `0.1` / `0.2` | 无 |

- 模型侧零回归：`content[0].text` 仍是宿主 2000 行 / 50 KB 尾部快照（`>1 MiB` 样本的模型文本 < 60 KB 且带 `[Showing lines …]`）。
- **唯一形态差异是设计使然**：超时转后台那次 call 以 reject 结束（脚本 catch 到 jobId / 日志路径文本），不是结构化值——超时≠完成，见上节不变量。
- 复现命令（脚本里 `tools.bash` 打 JSON 即可）：
  `pi --print --mode json --no-session --no-extensions -e builtin:codemode -e <本目录>/index.ts --tools codemode,bash --model <任意模型> -- "<让模型跑一段 codemode 脚本的提示词>"`

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

- `cd src/extensions/timeout-bg && npm install && npm test && npm run typecheck`（33 个：config / jobs / logs / shell-ops / index 接线，其中 2 条锁 codemode 视角的结构化结果）
- 进程边界测试只 fake `spawn` 与 `killTree`，真实读写临时目录日志、真实毫秒级计时器；工具本体用宿主真实 `createBashTool`。
- 真机验证（2026-09-22，Windows + Node 24）：真实 spawn + 真实计时器跑 `for i in 1..6; do echo tick-$i; sleep 1; done`，
  `timeout: 2` → 2.3s 转后台、进程存活且日志持续增长 → 7.3s 自然结束，注册表转 `exited(0)` 且 `onExit` 恰好一次。
- 真机验证 codemode 契约（2026-10-04，Windows + pi 1.0.1）：见上节差异表；模型侧 2000 行 / 50 KB 口径与超时转后台路径均无回归。
