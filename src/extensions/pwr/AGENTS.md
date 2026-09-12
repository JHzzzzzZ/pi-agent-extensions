# pwr 知识库
<!-- PROJECT KNOWLEDGE BASE / Generated: 2026-09-09T03:12:29Z / Commit: 56da138 / Branch: dev-laptop / Parent: 根 AGENTS.md（通用约定不重复） -->

## OVERVIEW
PWR 工作流运行时：受约束 ECMAScript 脚本 → 校验 → 批准卡 → 子 pi 进程执行，零构建直跑。

## WHERE TO LOOK
| 任务 | 位置 |
|---|---|
| DSL 白名单/上限/版本 | `engine/spec.ts`（唯一事实来源，`SCRIPT_VERSION='1.1.2'`） |
| 解析/校验/解释 | `engine/parser.ts` → `validator.ts` → `interpreter.ts` → `concurrency.ts` |
| 调度/缓存/状态机 | `runtime/scheduler.ts` FIFO、`cache.ts`（digest+sha256 回放）、`state.ts` 迁移表 |
| 子 pi 派生/实时 trace | `runner/pi.ts`（`--mode json -p --no-session`，`onEvent` 单行截断） |
| agent 发现优先级 | `runner/discover.ts`（用户 > 项目 > 内置，trust 门控） |
| 批准 digest 门控 | `src/approval.ts`（键=项目路径|digest，改脚本即 `APPROVAL_STALE`） |
| 保存/调用已存流 | `src/save.ts`、`src/ui/save-flow.ts` |
| 快捷键注册表 | `src/ui/keybindings.ts`（`ctrl+alt+z/x/r` 唯一定义处） |
| 渲染唯一 pi-tui 引入 | `src/ui/renderer.ts`（仅此文件碰 `Box/Text`） |
| 内置解析器（生成文件） | `vendor/acorn.mjs` + `acorn.d.mts`，勿改 |

## CONVENTIONS
- 改 DSL 先改 `spec.ts`，再同步 validator/interpreter —— 违反则校验与执行分叉。
- `interpreter.ts` 全局仅 `meta/args/agent/pipeline/parallel/sleep/JSON` —— 加全局即破白名单校验。
- 并发信号量 ≤128，循环预算 100k，脚本 ≤256KB —— 超限直接拒绝，不钳制外的值。
- runner 结果 ≤50KB（`RESULT_TOO_LARGE`）、摘要 ≤8KB —— 超限截断，违反则下游 entry 渲染爆炸。
- 杀进程 SIGTERM 后 5s SIGKILL（`KILL_GRACE_MS=5000`）—— 改小则子 pi 来不及落盘事件。
- prompt 物化仅 `pwr-tmp://` 进程内 —— 落盘即泄漏用户脚本。
- trace 文本单行+尾部截断，禁透传原始工具输出 —— 违反则 widget 换行重影。
- 缩进 tab（其余扩展 2 空格）—— 混用即 typecheck 无事但 diff 噪音。

## ANTI-PATTERNS
- 直引 `vendor/acorn.mjs` 以外解析器 —— 实证：仅 `engine/parser.ts` 引入，运行时零 npm 依赖。
- 缺 runner 时隐式回退 —— 实证：`AGENT_RUNNER_UNAVAILABLE` fail-closed，`src/engine.ts` 门控。
- 持久化脚本源码/args —— 实证：`runtime/persist.ts` 仅元数据，`run.args` 永不落盘。
- 在 `renderer.ts` 之外引 pi-tui —— 实证：全库唯一引入点，违则 UI 层泄漏。
- 跨层复写上限常量 —— 实证：`types.ts`/`spec.ts`/`runtime/types.ts` 三处重复已是已知怪癖，新增上限只进 `spec.ts`。

## COMMANDS
```bash
cd src/extensions/pwr && npm install && npm test        # 405 测试：test/ + tests/ + runtime/test/ + runner/test/
npm run typecheck                        # 承载性规则（.ts 扩展名/import type/无 enum）
node --test tests/ui-*.test.ts           # UI 子集；perf 门：64KB 脚本 validate <300ms
```

## NOTES
- `engine/validate-tool.ts` 仅测试消费，生产链路不走它。
- `runtime.shutdown()` 无接线（无 `session_shutdown` 钩子），别当清理点。
- `DELIVERY.md` 含行首字符丢失损坏痕迹，读时以代码为准。
