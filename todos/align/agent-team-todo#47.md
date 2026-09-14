# agent-team-todo#47 成员交付完成仍被判 CHILD_FAILED（终态判定按末轮 + 收尾诊断）

## 意图

成员子进程**产出完整报告与 commit 之后**被判 `failed`（真机 run-1789104779153：writer 第 2 轮与 checker 双双如此），leader 按「环境级失败不重试」规则会丢弃已完成的工作或重复派发——把成功当失败，比失败本身更贵。

根因是判定口径，不是单点 bug：

- `runner.ts:283-291`：一次派发内多轮 assistant 消息聚合成一个 `outcome`，`usage.turns++` 逐轮累加，但 `errorMessage` 是**粘性赋值**（`if (msg.errorMessage) outcome.errorMessage = msg.errorMessage`）——任意一轮带过错误，此后永不清除。
- `dispatch.ts:606`：`aborted || exitCode !== 0 || stopReason === "error" || !!outcome.errorMessage` 任一命中即 `failed`。于是「前轮失败、后轮重试成功」被永久记为失败。
- 宿主 `StopReason = pending|stop|length|toolUse|error|aborted|deferred`，且宿主有 `auto_retry_start/end`（agent-team 不解析该事件）——**末轮状态才是终态真值**，早轮状态只应作诊断。
- 真机 run 记录已被清理（`~/.pi/agent/teams/runs` 只留 14 个 run，该 runId 不在其中），无法回看当时由哪个信号触发；因此本次修复必须**让结果自证**（诊断字段），不依赖复现。

## 范围

**做什么**

1. **末轮判定（判定表）**

   | 条件 | 终态 |
   | --- | --- |
   | `signal.aborted` 或末轮 `stopReason === "aborted"` | `aborted`（不变） |
   | 末轮 `stopReason === "error"` 或末轮带 `errorMessage` | `failed` |
   | 末轮之后仍有未配对 `tool_execution_start`（无 end）或进程被信号杀 | `failed`（轮中被打断；文本标注「部分产出（可能可用）」） |
   | 末轮干净（`stop`）+ `exitCode === 0` | `done` |
   | 末轮干净但 `exitCode !== 0`／收尾异常 | `done` + `warning`（收尾异常） |

   三态（`done`/`failed`/`aborted`）**不变**——`warning` 承载「完成但收尾异常」，避免 status.json / resume / viewer / widget 全链路契约扩散。`errorMessage` 改为**按轮作用域**（末轮说了算，不再粘性）。判定表的取舍与备选见 `docs/adr/0006-member-terminal-outcome.md`。

2. **诊断面（条目②）**：`MemberRunResult.diagnostics = { exitCode, signal, lastStopReason, priorErrors[] }`（前轮错误留前 3 条 + 计数）。三处可见（用户确认「都要」）：转录 system 行、leader 结果分节（`— done（收尾异常：exit 1）`）、失败通知。

3. **错误码与 leader 契约**：不新增错误码（保持 `CHILD_FAILED`/`AGENT_ABORTED`）；真 `failed` 时 message 带 exit code；失败结果附一行「已有完整产出 N 字节，可直接取用」；`leader-prompt.ts:73` 的「环境级失败不重试」原则**不变**。

4. **范围覆盖**：pi 成员路径（`runner.ts` + `dispatch.ts`）与外部 CLI 成员路径（`external.ts` 的 `finalize`）**共用同一个判定函数**，语义一次对齐。

5. **顺手清理**：`dispatch.ts:223` `ENVIRONMENT_FAILURE_CODES` 是死代码（全仓仅此一处声明，无引用）——删除（仓库规范：死代码直接删）。

**不做什么**

- 不改 leader 侧超时/clamp、`AskChannel`、wire 协议字段。
- 不改「失败不重试」原则本身（本次修的是「不要把成功判成失败」，不是放宽重试）。
- 不动 `status.json` / `TeamRunRecord` 的状态枚举（仍三态）。
- 不 patch 宿主（`-p` 模式 auto-retry 行为、`stopReason` 语义只读不改）。

## 验收标准

1. 单测（先红）：判定表逐格覆盖——末轮 `error`/带 `errorMessage` ⇒ failed；前轮 `error` + 末轮干净 ⇒ done（这是真机冤案的最小复现）；末轮干净 + `exitCode !== 0` ⇒ done + warning；信号杀在轮中（未配对 tool 事件）⇒ failed。
2. 真实子进程用例：脚本化 `--mode json` 事件流（前轮 `message_end` 带 `errorMessage` + 后轮干净 `stop`，进程正常退出）⇒ 断言 `done` 且 `diagnostics.priorErrors` 留痕。
3. `diagnostics` 字段与三处呈现各有断言：转录 system 行、leader 结果分节标题（收尾异常）、失败通知文本。
4. 既有语义零回归：`aborted` 路径、`team_stop` 清队列、失败终态必达（v1.18.0 followUp 通道）、外部 CLI 成员三态、viewer/widget 状态图标不变。
5. `cd src/extensions/agent-team && npm test` 全绿 + `npm run typecheck` 零错误；`docs/extensions/agent-team.md` 卡（含 `last verified` 行）与扩展 README 同步；根 README 测试数更新。

## 人工确认

- 确认人：用户（会话内本人）
- 日期：2026-09-14
- 方式：本轮 5 问逐条确认——Q1 判定表（选 (a)：三态不变 + `warning` 承载收尾异常）、Q2「轮中被打断」启发式（接受）、Q3 诊断面（用户答「都要」：转录 + leader 可见 + 失败通知）、Q4 不新增错误码 + leader 契约不动（同意）、Q5 外部 CLI 后端同修、共享判定函数（同意）。
- 决策落盘：判定表立 ADR（用户批准）→ `docs/adr/0006-member-terminal-outcome.md`。
