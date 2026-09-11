/**
 * agent-team — session persistence + result delivery
 *
 * Run records are persisted as metadata-only custom entries
 * (`agent-team-run-v1`); the leader's final report wakes the main session
 * via a custom message (`agent-team-result`, display + followUp turn) so
 * the cockpit agent can act on it. All host calls are exception-isolated —
 * persistence failures never break the run.
 */

import { Box, Text, type Component } from "@earendil-works/pi-tui";
import type { EntryRenderer } from "@earendil-works/pi-coding-agent";
import { MAX_FAILURE_NOTICE_BYTES, RUN_ENTRY_TYPE, RUN_RESULT_MESSAGE_TYPE, truncateUtf8, type TeamRunRecord } from "./types.ts";
import { flattenText } from "./viewer.ts";

/** Structural surface of ExtensionAPI used here (keeps tests host-free). */
export interface SessionPort {
  appendEntry: (customType: string, data: unknown) => unknown;
  sendMessage: (
    message: { customType: string; content: Array<{ type: "text"; text: string }>; display?: boolean },
    options?: { deliverAs?: "followUp" | "steer" | "nextTurn"; triggerTurn?: boolean },
  ) => unknown;
}

export function appendRunRecord(port: SessionPort, record: TeamRunRecord): void {
  try {
    port.appendEntry(RUN_ENTRY_TYPE, record);
  } catch {
    /* persistence failures never break the session */
  }
}

export function deliverRunResult(port: SessionPort, report: string): void {
  try {
    port.sendMessage(
      {
        customType: RUN_RESULT_MESSAGE_TYPE,
        content: [{ type: "text", text: report }],
        display: true,
      },
      { deliverAs: "followUp", triggerTurn: true },
    );
  } catch {
    /* delivery failures never break the session */
  }
}

/** One-line collapsed summary for the run entry card. */
export function runSummaryLine(record: TeamRunRecord): string {
  const statusIcon = record.status === "completed" ? "✓" : record.status === "running" ? "▶" : record.status === "aborted" ? "⊘" : "✗";
  const secs = record.durationMs !== undefined ? ` · ${Math.round(record.durationMs / 100) / 10}s` : "";
  const cost = record.totalCost > 0 ? ` · $${record.totalCost.toFixed(4)}` : "";
  return `${statusIcon} team ${record.team} · ${record.status}${secs}${cost}`;
}

/** Full expanded detail text for the run entry card. */
export function runDetailText(record: TeamRunRecord): string {
  const lines = [
    runSummaryLine(record),
    `任务: ${record.task.length > 200 ? `${record.task.slice(0, 200)}…` : record.task}`,
    `runId: ${record.runId}`,
    `started: ${record.startedAt}`,
  ];
  if (record.error) lines.push(`错误: ${record.error}`);
  if (record.members.length > 0) {
    lines.push("成员:");
    for (const member of record.members) {
      const bits = [member.status];
      if (member.model) bits.push(member.model);
      if (member.worktree) bits.push(`worktree ${member.worktree.branch}`);
      lines.push(`  - ${member.name}（${bits.join("，")}）`);
    }
  }
  if (record.report) {
    lines.push("", "报告:", record.report.length > 4000 ? `${record.report.slice(0, 4000)}…` : record.report);
  }
  return lines.join("\n");
}

/**
 * Failure summary delivered to the main session as a followUp message when
 * a background run lands `failed` (leader non-zero exit / error stopReason /
 * promptError) or fails at launch (no record path builds one via
 * failedRunRecord). Mirrors the completed report channel: the caller's
 * agent can retry, change strategy, or tell the user truthfully instead of
 * waiting forever. aborted is intentionally not delivered (team_stop
 * contract).
 *
 * Dynamic fields are newline-flattened (host renders residual line feeds as
 * extra rows); the partial report is kept verbatim and placed last so the
 * whole-notice byte cap truncates it before status/error/member rows.
 */
export function formatFailureNotice(record: TeamRunRecord): string {
  const secs = record.durationMs !== undefined ? ` · ${Math.round(record.durationMs / 100) / 10}s` : "";
  const cost = record.totalCost > 0 ? ` · $${record.totalCost.toFixed(4)}` : "";
  const lines = [`team ${record.team} run 失败（runId ${record.runId}${secs}${cost}）`];
  if (record.error) lines.push(`错误: ${flattenText(record.error)}`);
  const task = flattenText(record.task);
  lines.push(`任务: ${task.length > 200 ? `${task.slice(0, 200)}…` : task}`);
  if (record.members.length > 0) {
    lines.push("成员:");
    for (const member of record.members) {
      const summary = member.summary !== undefined ? flattenText(member.summary) : "";
      const tail = summary.length === 0 ? "" : ` — ${summary.length > 160 ? `${summary.slice(0, 160)}…` : summary}`;
      lines.push(`  - ${member.name}: ${member.status}${tail}`);
    }
  }
  if (record.report) lines.push("部分报告:", record.report);
  return truncateUtf8(lines.join("\n"), MAX_FAILURE_NOTICE_BYTES);
}

/** Entry renderer for agent-team-run-v1 records (collapsed/expanded card). */
export function createRunEntryRenderer(): EntryRenderer<TeamRunRecord | undefined> {
  return (entry, options, theme) => {
    const record = entry.data;
    if (!record || typeof record.runId !== "string") return undefined;
    const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
    box.addChild(new Text(runSummaryLine(record)));
    if (options.expanded) {
      box.addChild(new Text(""));
      box.addChild(new Text(runDetailText(record), 1, 0));
    }
    return box as Component;
  };
}
