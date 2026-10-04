/**
 * agent-team — pi 1.0 工具面契约（agent-team-todo #73 / general-todo #20、#21）
 *
 * ① 分级与标注：exposure（编排型/阻塞型 model-only、查询型 direct）、annotations
 * （只读 / 破坏性 / 开放世界）、namespace（agent-team 分组）——各注册点只引用
 * 本文件的常量，分类口径单源。
 * ② 查询型四个工具的 outputSchema + structuredContent 稳定契约：给 codemode
 * 脚本的机器可读输出，从既有数据（RunStatusSnapshot / TeamConfig / 模型目录）
 * 派生。details 保持内部结构（viewer/widget/状态重建照旧消费它）。
 */

import type { ToolAnnotations, ToolNamespace } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import type { RunStatusSnapshot } from "./cockpit.ts";
import type { RunBudgetSnapshot, RunProgress, TeamConfig, TeamRunRecord } from "./types.ts";

/** 9 个工具同属 agent-team 分组（codemode 按 namespace 归组、可 describeNamespace）。 */
export const TEAM_TOOL_NAMESPACE: ToolNamespace = { name: "agent-team", description: "多 agent 团队派单与查询" };

/** 查询型（脚本可调）：只读，不改环境。 */
export const READ_ONLY_ANNOTATIONS: ToolAnnotations = { readOnlyHint: true };

/** 写盘 / 杀进程：可能覆盖已有数据。 */
export const WRITE_ANNOTATIONS: ToolAnnotations = { destructiveHint: true };

/** 派单：起子进程，且派出去的 agent 会碰世界（文件系统 / 网络）。 */
export const DISPATCH_ANNOTATIONS: ToolAnnotations = { destructiveHint: true, openWorldHint: true };

const memberEntry = Type.Object({
  name: Type.String(),
  status: Type.String({ description: "queued / running / done / failed / aborted" }),
  warning: Type.Optional(Type.String({ description: "done 但收尾异常时的一行说明（ADR-0006）" })),
});

const budgetEntry = Type.Object({
  maxDispatchCalls: Type.Number(),
  maxMemberRuns: Type.Number(),
  maxCostUsd: Type.Union([Type.Number(), Type.Null()]),
  maxTotalTokens: Type.Union([Type.Number(), Type.Null()]),
  spentCost: Type.Number(),
  spentTokens: Type.Number(),
  dispatchCalls: Type.Number(),
  memberRuns: Type.Number(),
});

const runEntry = Type.Object({
  runId: Type.String(),
  team: Type.String(),
  status: Type.String({ description: "running / completed / failed / aborted" }),
  startedAt: Type.String({ description: "ISO 8601" }),
  elapsedMs: Type.Optional(Type.Number()),
  parentRunId: Type.Optional(Type.String({ description: "续跑 run 的父 runId" })),
  members: Type.Array(memberEntry),
  budget: Type.Optional(budgetEntry),
});

/**
 * team_status：带 runId → 单 run 条目；省略 runId → 活跃 + 最近终态汇总。
 * 未知 runId 没有可描述的 run，与空汇总同形（原因在文本结果里）。
 */
export const TEAM_STATUS_OUTPUT = Type.Union([
  runEntry,
  Type.Object({ active: Type.Array(runEntry), recent: Type.Array(runEntry) }),
]);

export const TEAM_LIST_OUTPUT = Type.Object({
  teams: Type.Array(
    Type.Object({
      name: Type.String(),
      source: Type.Union([Type.Literal("global"), Type.Literal("project")]),
      members: Type.Array(Type.String(), { description: "成员名（模型口径用 team_models）" }),
      leader: Type.Optional(Type.String({ description: "leader 模型 provider/id；缺省 = pi 默认模型" })),
    }),
  ),
});

export const TEAM_TRANSCRIPT_OUTPUT = Type.Object({
  actor: Type.String({ description: "actor id：leader 为 _leader，成员为成员名" }),
  lines: Type.Array(Type.String(), { description: "与文本结果同一截断口径的转写行" }),
});

export const TEAM_MODELS_OUTPUT = Type.Object({
  models: Type.Array(
    Type.Object({ provider: Type.String(), id: Type.String(), name: Type.String() }, {
      description: "已配置鉴权的模型（不含 cost / contextWindow 等内部字段）",
    }),
  ),
});

function budgetOf(budget: RunBudgetSnapshot): Static<typeof budgetEntry> {
  return {
    maxDispatchCalls: budget.maxDispatchCalls,
    maxMemberRuns: budget.maxMemberRuns,
    maxCostUsd: budget.maxCostUsd,
    maxTotalTokens: budget.maxTotalTokens,
    spentCost: budget.spentCost,
    spentTokens: budget.spentTokens,
    dispatchCalls: budget.dispatchCalls,
    memberRuns: budget.memberRuns,
  };
}

function activeEntry(progress: RunProgress, nowMs: number): Static<typeof runEntry> {
  return {
    runId: progress.runId,
    team: progress.team,
    status: "running",
    startedAt: new Date(progress.startedAtMs).toISOString(),
    elapsedMs: Math.max(0, nowMs - progress.startedAtMs),
    ...(progress.parentRunId !== undefined ? { parentRunId: progress.parentRunId } : {}),
    members: progress.members.map((member) => ({ name: member.name, status: member.status })),
    ...(progress.budget !== undefined ? { budget: budgetOf(progress.budget) } : {}),
  };
}

function recordEntry(record: TeamRunRecord): Static<typeof runEntry> {
  return {
    runId: record.runId,
    team: record.team,
    status: record.status,
    startedAt: record.startedAt,
    ...(record.durationMs !== undefined ? { elapsedMs: record.durationMs } : {}),
    ...(record.parentRunId !== undefined ? { parentRunId: record.parentRunId } : {}),
    members: record.members.map((member) => ({
      name: member.name,
      status: member.status,
      ...(member.warning !== undefined ? { warning: member.warning } : {}),
    })),
  };
}

/** team_status 的 structuredContent（runId 省略 = 汇总，null = 未知 runId）。 */
export function statusStructured(
  snapshot: RunStatusSnapshot | null,
  nowMs: number,
  runId?: string,
): Static<typeof TEAM_STATUS_OUTPUT> {
  if (runId === undefined) {
    return {
      active: (snapshot?.actives ?? []).map((progress) => activeEntry(progress, nowMs)),
      recent: (snapshot?.records ?? []).map(recordEntry),
    };
  }
  const progress = snapshot?.actives[0];
  if (progress !== undefined) return activeEntry(progress, nowMs);
  const record = snapshot?.lastRecord ?? null;
  if (record !== null && record.runId === runId) return recordEntry(record);
  return { active: [], recent: [] };
}

/** team_list 的 structuredContent（成员名 + 来源 + leader 模型）。 */
export function teamListStructured(teams: TeamConfig[]): Static<typeof TEAM_LIST_OUTPUT> {
  return {
    teams: teams.map((team) => ({
      name: team.name,
      source: team.source,
      members: team.members.map((member) => member.name),
      ...(team.leader.model ? { leader: team.leader.model } : {}),
    })),
  };
}

/** team_transcript 的 structuredContent（行 = 文本结果按行拆开，截断口径同一处）。 */
export function transcriptStructured(actor: string, text: string): Static<typeof TEAM_TRANSCRIPT_OUTPUT> {
  return { actor, lines: text.length > 0 ? text.split("\n") : [] };
}

/** team_models 的 structuredContent（只暴露 provider/id/name）。 */
export function modelsStructured(
  models: Array<{ provider: string; id: string; name: string }>,
): Static<typeof TEAM_MODELS_OUTPUT> {
  return { models: models.map((model) => ({ provider: model.provider, id: model.id, name: model.name })) };
}
