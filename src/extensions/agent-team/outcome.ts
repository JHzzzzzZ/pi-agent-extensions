/**
 * agent-team — member terminal outcome (single decision, both backends)
 *
 * 终态判定只有一条口径（ADR-0006 / todos/align/agent-team-todo#47.md）：
 * **末轮说了算**——成员子进程最后一次 assistant `message_end` 的
 * stopReason/errorMessage 才是真值，早轮错误只进 diagnostics。旧口径把
 * 四信号或起来判（`exitCode !== 0 || stopReason === "error" ||
 * errorMessage` + 粘性 errorMessage），于是「前轮失败、后轮重试成功」的
 * 成员在交付完整报告与 commit 之后仍被判 CHILD_FAILED（真机
 * run-1789104779153：writer 与 checker 双双中招），leader 按「环境级失败
 * 不重试」丢弃已完成的工作。
 *
 * 三态（done/failed/aborted）不变：「完成但收尾异常」（末轮干净而退出码
 * 非 0 / 收尾异常）判 `done` 并用 `warning` 承载原因——新增第四状态会让
 * status.json / TeamRunRecord / resume / viewer / widget 图标 / 失败通知
 * 全链路跟着扩。pi 成员（dispatch 的 pi 路径）与外部 CLI 成员
 * （external.ts 的 finalize 路径）共用本模块，语义一次对齐。
 */

import type { MemberDiagnostics } from "./types.ts";

/** 判定输入：两条后端各能提供多少就给多少（缺项 = 该信号不存在）。 */
export interface MemberTerminalSignals {
  /** run 级 abort 已触发（team_stop / 预算超限）。 */
  aborted: boolean;
  /** 末轮 stopReason（pi 后端；外部 CLI 无该概念时省略）。 */
  lastStopReason?: string;
  /** 末轮错误消息（pi 的 message_end.errorMessage / 外部 CLI 的末轮失败消息）。 */
  lastErrorMessage?: string;
  /** 末轮以错误收尾的显式信号（外部 CLI：codex turn.failed / claude is_error）。 */
  finalTurnError?: boolean;
  /** 子进程退出码（无 close code 时按 0）。 */
  exitCode: number;
  /** OS 上报的终止信号（如 SIGTERM）——被信号杀的证据。 */
  signal?: string | null;
  /** 是否观察到任何一轮输出（无轮消息时只能靠 exitCode/信号判）。 */
  hasFinalTurn: boolean;
  /** 结束时仍有未配对 tool_execution_start（工具执行中途被打断）。 */
  toolInterrupted?: boolean;
}

/** failed 归类：末轮错误 / 轮中被打断 / 全程无输出（错误消息组装用）。 */
export type MemberTerminalFailure = "turn_error" | "interrupted" | "no_output";

export interface MemberTerminalDecision {
  status: "done" | "failed" | "aborted";
  /** `done` 但收尾异常（exitCode ≠ 0）时的一行原因；正常收尾缺省。 */
  warning?: string;
  /** `failed` 的归类；非 failed 缺省。 */
  failure?: MemberTerminalFailure;
}

/**
 * 判定表（逐格锁在 test/outcome.test.ts）：
 *
 * | 末轮状态 | 终态 |
 * | --- | --- |
 * | abort（run 级或末轮 aborted） | `aborted` |
 * | 末轮 error / 末轮带 errorMessage | `failed`（turn_error） |
 * | 结束时仍有未配对工具 / 进程被信号杀 | `failed`（interrupted，轮中被打断） |
 * | 无末轮消息 + exitCode ≠ 0 | `failed`（no_output，轮中崩溃） |
 * | 末轮干净 + exitCode ≠ 0 | `done` + warning（收尾异常） |
 * | 末轮干净 + exitCode === 0 | `done` |
 */
export function decideMemberTerminal(signals: MemberTerminalSignals): MemberTerminalDecision {
  if (signals.aborted || signals.lastStopReason === "aborted") return { status: "aborted" };
  const turnError =
    signals.finalTurnError === true ||
    signals.lastStopReason === "error" ||
    (signals.lastErrorMessage ?? "").length > 0;
  if (turnError) return { status: "failed", failure: "turn_error" };
  if (signals.toolInterrupted === true || (signals.signal ?? "").length > 0) {
    return { status: "failed", failure: "interrupted" };
  }
  if (!signals.hasFinalTurn) {
    return signals.exitCode === 0 ? { status: "done" } : { status: "failed", failure: "no_output" };
  }
  if (signals.exitCode !== 0) return { status: "done", warning: `收尾异常：exit ${signals.exitCode}` };
  return { status: "done" };
}

/** 单行化 + 长度上限（诊断文本与错误消息共用，防多行 stderr 撑爆一行）。 */
function shortText(text: string, max: number): string {
  const single = text.replace(/\s+/g, " ").trim();
  return single.length > max ? `${single.slice(0, max)}…` : single;
}

/** 一行诊断文本（成员转录 system 行 / 失败通知成员行共用）。 */
export function formatMemberDiagnostics(diagnostics: MemberDiagnostics): string {
  const parts = [`exit ${diagnostics.exitCode}`];
  if (diagnostics.signal) parts.push(`信号 ${diagnostics.signal}`);
  if (diagnostics.lastStopReason) parts.push(`末轮 ${diagnostics.lastStopReason}`);
  if (diagnostics.priorErrorCount > 0) {
    const items = diagnostics.priorErrors.map((error) => shortText(error, 80));
    parts.push(`前轮错误 ${diagnostics.priorErrorCount} 条${items.length > 0 ? `：${items.join("；")}` : ""}`);
  }
  return parts.join(" · ");
}

export interface MemberFailureMessageInput {
  /** 「轮中被打断」——附「部分产出（可能可用）」标注（产出未必不可用）。 */
  interrupted: boolean;
  /** 后端给出的错误消息；空则回退到 `fallback`。 */
  message?: string;
  /** 无错误消息时的兜底描述（如 `pi 子进程未报告错误消息`）。 */
  fallback: string;
  exitCode: number;
  /** 终止信号（有则与 exit code 一起入括号，进程被杀的完整证据）。 */
  signal?: string;
}

/** 真 `failed` 的错误消息：必带 exit code；轮中被打断额外标注部分产出。 */
export function memberFailureMessage(input: MemberFailureMessageInput): string {
  const base = shortText(input.message ?? "", 400) || shortText(input.fallback, 400);
  const evidence =
    input.signal !== undefined && input.signal.length > 0
      ? `exit ${input.exitCode}，信号 ${input.signal}`
      : `exit ${input.exitCode}`;
  const labeled = `${base}（${evidence}）`;
  return input.interrupted ? `轮中被打断，部分产出（可能可用）：${labeled}` : labeled;
}
