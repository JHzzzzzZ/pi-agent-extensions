# stream-token-speed 知识库
<!-- PROJECT KNOWLEDGE BASE / Generated: 2026-09-09T03:12:29Z / Commit: 56da138 / Branch: dev-laptop / Parent: 根 AGENTS.md -->

## OVERVIEW
流式回复 TTFT + 实时 tokens/s 状态条，结束后留本轮 TTFT/末瞬时/平均值。

## WHERE TO LOOK
| 任务 | 位置 |
|---|---|
| 事件适配 | `adapter.ts`（文本/thinking/tool call 增量纳入，tool result 与执行进度排除） |
| 节流/状态机 | `controller.ts` + `metrics.ts`（TTFT、瞬时、平均） |
| UI 端口 | `status-port.ts`（`ctx.hasUI` 守卫，异常隔离，每扩展一状态键） |
| 入口 | `index.ts`（运行时零依赖，无需 npm install） |
| 测试固件 | `test/fixtures.ts` `RecordingStatusPort` |

## CONVENTIONS
- 计量排除 tool result —— 纳入则速度虚高，`adapter.ts` 白名单为准。
- 样式经 `theme.fg("dim",…)` 包纯文本，仅 TUI 模式 —— RPC 下套样式即 ANSI 泄漏。
- 每次 `setStatus` 异常隔离 —— 违反则状态栏一次失败拖垮会话。
- 单文件单职责（adapter/controller/metrics/status-port）—— 合并即测试固件无法单 mock。
- 无 package.json，宿主运行时解析类型 —— 加依赖即破坏零依赖安装。

## ANTI-PATTERNS
- 实例化真实 pi-tui 测试 —— 实证：结构 fake 以 `as never` 断言，从不实例化。
- tool result 计入 tokens/s —— 实证：`adapter.test.ts` 断言排除项。
- 跨扩展复用状态键 —— 实证：键 `stream-token-speed` 独占，复用即互相覆盖。

## COMMANDS
```bash
cd stream-token-speed && node --experimental-strip-types --test test/*.test.ts   # 43 测试，无 typecheck
```
