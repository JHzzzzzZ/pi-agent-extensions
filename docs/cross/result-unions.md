# 跨扩展横切契约：result union 与四层错误码全景

> last verified @ 0142e14
>
> 仓库统一约定：**结果联合优先于异常**——`{ ok: true, value } | { ok: false, code, message }`，调用方用判别联合收窄。每层有自己的错误码文件；新失败模式必须登记到所属层的码表，禁止临时字符串码。错误消息一律静态模板，不插值用户输入/密钥。

## 四层码表（pwr 内部，自外向内）

| 层 | 文件 | 码数 | 关键码 |
| --- | --- | --- | --- |
| 编排层（src） | `pwr/src/errors.ts` | 20 | `APPROVAL_REQUIRED` / `APPROVAL_STALE`（改脚本后重批）、`BUDGET_EXCEEDED`、`PROJECT_NOT_TRUSTED`、`NAME_CONFLICT`、`ENGINE_UNAVAILABLE`、`ARGS_SCHEMA_VIOLATION`、`WORKFLOW_NOT_FOUND` |
| 引擎层（engine） | `pwr/engine/errors.ts` | 7 | `SCRIPT_FORBIDDEN_SYNTAX`、`SCRIPT_UNKNOWN_API`、`SCRIPT_LOOP_LIMIT_EXCEEDED`、`AGENT_LIMIT_EXCEEDED`、`AGENT_RUNNER_UNAVAILABLE`；错误携带源码位置（`ScriptError.start/end`） |
| 运行时层（runtime） | `pwr/runtime/errors.ts` | 7 | `RUN_NOT_FOUND`、`RUN_NOT_CONTROLLABLE`、`ILLEGAL_STATE_TRANSITION`（迁移表拒绝）、`AGENT_NOT_RESTARTABLE`、`SESSION_SHUTDOWN` |
| 执行器层（runner） | `pwr/runner/errors.ts` | 5 | `UNKNOWN_AGENT`、`AGENT_RUNNER_UNAVAILABLE`、`AGENT_EXECUTION_ERROR`、`RESULT_TOO_LARGE`（>50KB）、`AGENT_ABORTED` |

## 跨层同名码（有意为之，别"去重"）

- `AGENT_RUNNER_UNAVAILABLE`：三层共用（src / engine / runner），保证"缺 runner ⇒ fail-closed 不回退"的语义在各层一致。
- `AGENT_LIMIT_EXCEEDED`：engine 与 runtime 共用（脚本预算 vs run 预算两道闸）。
- `RUN_NOT_FOUND` / `RUN_NOT_CONTROLLABLE` / `AGENT_NOT_RESTARTABLE`：src 透传 runtime 的码，工具层不换码。

## pwr 之外

- `agent-team/types.ts` — `TeamErrorCodes`（result union，上限同款：8 任务 / 4 并发 / 50KB / 8KB）。
- 卫星扩展（loop / goal / opencode-bridge / deep-init / human-notify）走 `{ ok }` 联合或 deps 注入失败路径，各自 test 文件内锁定契约；没有独立 errors.ts 的（单文件扩展）直接在文件内 `as const` 码对象。

## 规则

- 新码先找所属层文件；横切语义（如 runner 不可用）复用同名码而非新造。
- `ScriptError` / `RuntimeError` / `RunnerError` 保留（异常仅作层内信号与承载码的载体），跨层传递仍走 result union。
- 错误码对象用 `as const` + `(typeof X)[keyof typeof X]` 派生类型（`erasableSyntaxOnly` 禁 enum）。
