# 成员终态判定：末轮说了算，三态不变，收尾异常用 warning 承载

Status: accepted（2026-09-14，agent-team-todo:47；用户逐条采纳）

成员子进程的终态此前由四个信号**或**起来判（`dispatch.ts:606`：`aborted || exitCode !== 0 || stopReason === "error" || !!outcome.errorMessage`），而 `errorMessage` 在多轮聚合里是**粘性**的（`runner.ts:291` 只在为真时赋值）——前轮失败、后轮重试成功（宿主自带 `auto_retry_start/end`）的成员，会在交付完整报告与 commit 之后被判 `failed`（真机 run-1789104779153：writer 与 checker 双双如此），leader 按「环境级失败不重试」直接丢弃已完成的工作。决定：终态以**最后一次 assistant `message_end`**（末轮）的 `stopReason`/`errorMessage` 为真值，早轮错误只进 `diagnostics.priorErrors`；`done`/`failed`/`aborted` 三态**不变**，「末轮干净但 `exitCode` 非 0／被信号杀」判 `done` 并附 `warning`（收尾异常）；「末轮之后再无事件且存在未配对 `tool_execution_start`」判 `failed`（轮中被打断，文本标注部分产出）。pi 成员（`runner.ts`）与外部 CLI 成员（`external.ts` 的 `finalize`）共用同一判定函数。

## Considered Options

- **新增第四状态 `done-with-warning`**：语义最直白，但 `status.json` / `TeamRunRecord` / resume 的 `RUN_NOT_TERMINAL` 判定 / viewer 与 widget 图标全集 / 失败通知全部要跟着扩，收益只是一个字段——否决。
- **把 `exitCode !== 0` 一律判 failed（保守）**：省掉「收尾异常」这一档，但真机冤案里成功成员被判失败正是这一档的代价（丢弃已完成工作 + 重复派发），比漏报更贵——否决。
- **新增错误码（`CHILD_TRAILING_ERROR` 等）区分收尾异常**：语义更细，但错误码表与文档、`ENVIRONMENT_FAILURE_CODES`、leader 提示全线扩散，而 warning 字段已能承载同一信息——否决。
- **只按 `stopReason` 判、完全忽略 `exitCode`**：会漏掉真正的「轮中崩溃」（无末轮消息时无从区分），所以保留 `exitCode`/信号作为诊断与「轮中被打断」的证据——部分采纳。
- **只修 pi 成员路径**：外部 CLI 成员用同一 `MemberRunResult` 契约（`finalize` 路径已有 `errorMessage` 语义），只修一条会留下同一 bug 的第二种形态——否决，两条共用判定函数。

## Consequences

- `MemberRunResult` 增 `warning?: string` 与 `diagnostics = { exitCode, signal, lastStopReason, priorErrors[] }`；下游（leader 结果分节、转录 system 行、失败通知、`team_transcript`）按新增字段渲染，旧字段语义不变。
- 「已完成」的定义从「进程干净退出」变成「最后一轮干净结束」：进程收尾异常不再抹掉产出，但也不静默——warning 一定可见（leader + 转录 + 通知三处）。
- 判定逻辑抽成单一函数（pi / 外部 CLI 两条路径共用），未来新增后端（如外部 leader）复用它而不是各自复制四信号表达式。
- 若某天真机需要区分「轮中被打断」与「收尾异常」的更细证据，宿主 wire 事件（如 `auto_retry_*`）可作为增量输入；本决定不预设该字段。
