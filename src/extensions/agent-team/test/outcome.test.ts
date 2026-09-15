/**
 * 成员终态判定表（ADR-0006 / todos/align/agent-team-todo#47.md）。
 *
 * 判定口径本身就是本次修复：终态以**末轮**（最后一次 assistant
 * message_end）的 stopReason/errorMessage 为真值，早轮错误只作诊断——
 * 真机 run-1789104779153 里 writer 与 checker 交付完整报告后仍被判
 * CHILD_FAILED，根因就是早轮错误被粘性保留。逐格锁在纯函数测试里；
 * dispatch 集成断言（test/dispatch.test.ts）、真实子进程用例与外部 CLI
 * 路径（external.ts 的 finalize）都只是这张表在不同后端的落地。
 */

import * as assert from "node:assert/strict";
import { test } from "node:test";
import {
  decideMemberTerminal,
  formatMemberDiagnostics,
  memberFailureMessage,
  type MemberTerminalSignals,
} from "../outcome.ts";

/** 判定表基线：末轮干净、进程正常退出（各用例只覆盖自己关心的信号）。 */
function signals(overrides: Partial<MemberTerminalSignals> = {}): MemberTerminalSignals {
  return {
    aborted: false,
    exitCode: 0,
    hasFinalTurn: true,
    lastStopReason: "stop",
    ...overrides,
  };
}

test("判定表：abort（run 级或末轮 aborted）⇒ aborted，最高优先", () => {
  assert.deepEqual(decideMemberTerminal(signals({ aborted: true })), { status: "aborted" });
  // 即使末轮带错误，abort 仍然赢（team_stop 契约：不得报成 failed）
  assert.deepEqual(
    decideMemberTerminal(signals({ aborted: true, lastStopReason: "error", lastErrorMessage: "boom" })),
    { status: "aborted" },
  );
  assert.deepEqual(decideMemberTerminal(signals({ lastStopReason: "aborted" })), { status: "aborted" });
});

test("判定表：末轮 error / 末轮带 errorMessage ⇒ failed（turn_error）", () => {
  assert.deepEqual(decideMemberTerminal(signals({ lastStopReason: "error" })), {
    status: "failed",
    failure: "turn_error",
  });
  assert.deepEqual(decideMemberTerminal(signals({ lastErrorMessage: "model exploded" })), {
    status: "failed",
    failure: "turn_error",
  });
  // 外部 CLI 后端没有 stopReason：finalTurnError 是它的末轮失败信号
  assert.deepEqual(decideMemberTerminal(signals({ finalTurnError: true, lastErrorMessage: "405" })), {
    status: "failed",
    failure: "turn_error",
  });
});

test("判定表：前轮 error + 末轮干净 + exit 0 ⇒ done（真机冤案最小复现）", () => {
  const decision = decideMemberTerminal(
    signals({ lastStopReason: "stop", lastErrorMessage: undefined, exitCode: 0 }),
  );
  assert.deepEqual(decision, { status: "done" });
  assert.equal(decision.warning, undefined, "收尾正常不给 warning");
});

test("判定表：末轮干净 + exitCode ≠ 0 ⇒ done + warning（收尾异常，产出不丢）", () => {
  assert.deepEqual(decideMemberTerminal(signals({ exitCode: 3 })), {
    status: "done",
    warning: "收尾异常：exit 3",
  });
});

test("判定表：未配对工具 / 进程被信号杀 ⇒ failed（轮中被打断）", () => {
  assert.deepEqual(decideMemberTerminal(signals({ toolInterrupted: true })), {
    status: "failed",
    failure: "interrupted",
  });
  assert.deepEqual(decideMemberTerminal(signals({ signal: "SIGTERM" })), {
    status: "failed",
    failure: "interrupted",
  });
  // 空信号（close code 正常）不算信号杀
  assert.deepEqual(decideMemberTerminal(signals({ signal: null })), { status: "done" });
});

test("判定表：无末轮消息时只能靠 exitCode 判（0 ⇒ done，非 0 ⇒ failed）", () => {
  assert.deepEqual(decideMemberTerminal(signals({ hasFinalTurn: false, lastStopReason: undefined })), {
    status: "done",
  });
  assert.deepEqual(decideMemberTerminal(signals({ hasFinalTurn: false, exitCode: 1, lastStopReason: undefined })), {
    status: "failed",
    failure: "no_output",
  });
});

test("formatMemberDiagnostics：exit/信号/末轮/前轮错误（前 3 条 + 计数 + 单行化）", () => {
  assert.equal(
    formatMemberDiagnostics({ exitCode: 0, priorErrors: [], priorErrorCount: 0 }),
    "exit 0",
  );
  assert.equal(
    formatMemberDiagnostics({
      exitCode: 1,
      signal: "SIGTERM",
      lastStopReason: "error",
      priorErrors: ["bad\ngateway", "timeout"],
      priorErrorCount: 5,
    }),
    "exit 1 · 信号 SIGTERM · 末轮 error · 前轮错误 5 条：bad gateway；timeout",
  );
  // 前轮错误条目单行化并按 80 字截断，长 stderr 不撑爆一行
  const long = formatMemberDiagnostics({
    exitCode: 1,
    lastStopReason: "stop",
    priorErrors: ["x".repeat(200)],
    priorErrorCount: 1,
  });
  assert.match(long, /前轮错误 1 条：x{80}…$/);
});

test("memberFailureMessage：必带 exit code；轮中被打断标注部分产出（可能可用）", () => {
  assert.equal(
    memberFailureMessage({ interrupted: false, message: "model exploded", fallback: "无消息", exitCode: 1 }),
    "model exploded（exit 1）",
  );
  assert.equal(
    memberFailureMessage({ interrupted: false, message: "  ", fallback: "pi 子进程未报告错误消息", exitCode: 7 }),
    "pi 子进程未报告错误消息（exit 7）",
  );
  assert.equal(
    memberFailureMessage({ interrupted: true, message: "", fallback: "pi 子进程未报告错误消息", exitCode: 1 }),
    "轮中被打断，部分产出（可能可用）：pi 子进程未报告错误消息（exit 1）",
  );
});
