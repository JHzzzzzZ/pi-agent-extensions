# loop 知识库
<!-- PROJECT KNOWLEDGE BASE / Generated: 2026-09-09T03:12:29Z / Commit: 56da138 / Branch: dev-laptop / Parent: 根 AGENTS.md -->

## OVERVIEW
`/loop` 定时任务：固定间隔/每天定时/每日窗口循环 + 一次性提醒 + `--bg` 后台 agent。

## WHERE TO LOOK
| 任务 | 位置 |
|---|---|
| 调度语法解析 | `parse.ts`（`every 5m`/`daily at 09:00`/`every 1h from 00:00 to 09:00`/`in 30m`/`at 15:00`） |
| 任务状态/快照 | `tasks.ts`（会话条目快照持久化） |
| agent 工具 | `tools.ts`（`loop_create/list/delete`） |
| 后台拉起 | `runner.ts`（前台 followUp 送达；`--bg` 拉子 `pi --mode json -p`，会话 id 可 `pi --session` 恢复） |
| 命令入口 | `index.ts`（`pi.extensions: ["./index.ts"]` 清单） |
| 状态条节拍 | `aligned-ticker.ts`（对齐墙钟秒边界；契约 `<仓库根>/docs/cross/status-bar.md`） |

## CONVENTIONS
- `setWidget` 传纯字符串，不碰 `ctx.ui.theme` —— `ExtensionUIContext` 无 theme 字段，访问即编译失败。
- 最小间隔 1 分钟；窗口 `[start,end]` 闭区间 —— 违反则 parse 拒绝不钳制。
- `--bg` 进程 detached + 会话落盘 —— 前台 `followUp` 与后台恢复二选一，不双送。
- 时间计算经 `nowMs` 注入 —— 直调 `Date.now()` 则测试时钟固定 `2026-08-05T12:00:00Z` 失效。
- 新调度形式先加 `parse.ts` 用例 —— 无用例即无文档，`test/parse.test.ts` 为准。
- 时间类刷新走 `aligned-ticker.ts`（勿用裸 `setInterval`）—— 相位漂移会让多个 widget 逐秒换位；widget 文本指纹未变时跳过 `setWidget`。

## ANTI-PATTERNS
- 给 widget 套样式 —— 实证：`index.ts` 注释明示 RPC 下 ANSI 泄漏，只传纯文本。
- 绕过 parse 手拼任务 —— 实证：`tasks.ts` 只接受 parse 产物，非法调度静默永不触发。
- 后台进程持有父资源 —— 实证：`runner.ts` detached+unref，Pi 不持有子进程。

## COMMANDS
```bash
cd src/extensions/loop && npm install && npm test   # 192 测试；另有 npm run typecheck
```
