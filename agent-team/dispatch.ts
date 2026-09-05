/**
 * agent-team — team_dispatch tool executor (leader mode)
 *
 * Runs inside the leader child pi process. Validates the leader's dispatch
 * request against the team roster, creates worktrees for isolated members,
 * runs member child pi processes with bounded concurrency, streams progress
 * snapshots (status + latest activity) via onUpdate, and returns a combined
 * per-member report.
 *
 * The executor is created ONCE per leader process and carries the per-run
 * dispatch budget: exceeding it makes further dispatches fail with an
 * instruction to wrap up, so a confused leader cannot loop forever.
 */

import * as path from "node:path";
import { defaultSpawn, getPiInvocation, runChildPi } from "./runner.ts";
import { createWorktree, defaultGitRunner, type GitRunner } from "./worktree.ts";
import {
  MAX_DISPATCH_CALLS_PER_RUN,
  MAX_MEMBER_RUNS_PER_RUN,
  MAX_PARALLEL_MEMBERS,
  MAX_RESULT_BYTES,
  MAX_SUMMARY_BYTES,
  MAX_TASKS_PER_DISPATCH,
  emptyUsage,
  truncateUtf8,
  type AgentUsage,
  type DispatchOutcome,
  type MemberProgress,
  type MemberProgressStatus,
  type MemberRunResult,
  type PiSpawn,
  type TeamConfig,
  type TeamErrorCode,
} from "./types.ts";

export interface DispatchRequest {
  tasks: Array<{ agent: string; task: string }>;
}

export interface DispatchMemberDetail {
  name: string;
  ok: boolean;
  status: MemberProgressStatus;
  summary?: string;
  /** Latest assistant activity tail (progress display only). */
  latest?: string;
  usage?: AgentUsage;
  worktree?: { path: string; branch: string };
  error?: { code: string; message: string };
}

export interface DispatchDetails {
  members: DispatchMemberDetail[];
  totalUsage: AgentUsage;
}

export interface DispatchDeps {
  /** Team resolved once when the leader starts. */
  team: TeamConfig;
  /** Working directory for member children (shared members run here). */
  cwd: string;
  /** Root directory for per-run worktrees. */
  worktreeRoot: string;
  runId: string;
  spawn?: PiSpawn;
  piCommand?: string;
  gitRunner?: GitRunner;
  /** Test seam: SIGTERM→SIGKILL grace for member children. */
  killGraceMs?: number;
}

export interface ToolUpdatePayload {
  content: Array<{ type: "text"; text: string }>;
  details?: unknown;
}

export type OnUpdate = (update: ToolUpdatePayload) => void;

/** Result of one executor invocation (budget exhaustion is a typed failure). */
export type DispatchExecResult =
  | { ok: true; value: DispatchOutcome }
  | { ok: false; code: TeamErrorCode; message: string };

interface PlannedMemberError {
  code: TeamErrorCode;
  message: string;
}

interface PlannedDispatch {
  member?: TeamConfig["members"][number];
  task: string;
  worktree?: { path: string; branch: string };
  preError?: PlannedMemberError;
}

/** Validates and normalizes the leader's dispatch request. */
export function parseDispatchRequest(
  raw: unknown,
): { ok: true; value: DispatchRequest } | { ok: false; message: string } {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, message: "team_dispatch requires a `tasks` array" };
  }
  const tasks = (raw as { tasks?: unknown }).tasks;
  if (!Array.isArray(tasks) || tasks.length === 0) {
    return { ok: false, message: "team_dispatch requires a non-empty `tasks` array" };
  }
  if (tasks.length > MAX_TASKS_PER_DISPATCH) {
    return { ok: false, message: `too many tasks (${tasks.length}); max ${MAX_TASKS_PER_DISPATCH} per dispatch` };
  }
  const normalized: Array<{ agent: string; task: string }> = [];
  for (let i = 0; i < tasks.length; i++) {
    const item = tasks[i];
    if (item === null || typeof item !== "object") {
      return { ok: false, message: `tasks[${i}] must be an object` };
    }
    const agent = (item as { agent?: unknown }).agent;
    const task = (item as { task?: unknown }).task;
    if (typeof agent !== "string" || agent.trim().length === 0) {
      return { ok: false, message: `tasks[${i}].agent must be a member name` };
    }
    if (typeof task !== "string" || task.trim().length === 0) {
      return { ok: false, message: `tasks[${i}].task must be a non-empty task description` };
    }
    normalized.push({ agent: agent.trim(), task: task.trim() });
  }
  return { ok: true, value: { tasks: normalized } };
}

function rosterText(team: TeamConfig): string {
  return team.members.map((m) => `- ${m.name}${m.model ? ` (${m.model})` : ""}`).join("\n");
}

function statusLine(result: MemberRunResult): string {
  const secs = Math.round(result.durationMs / 100) / 10;
  const cost = result.usage.cost > 0 ? `，$${result.usage.cost.toFixed(4)}` : "";
  if (result.status === "done") return `## ${result.name} — done（${secs}s${cost}）`;
  if (result.status === "aborted") return `## ${result.name} — aborted`;
  return `## ${result.name} — failed（${result.error?.code ?? "CHILD_FAILED"}）`;
}

function worktreeLines(result: MemberRunResult): string[] {
  if (!result.worktree) return [];
  return ["", `> worktree: \`${result.worktree.path}\`（分支 \`${result.worktree.branch}\`，改动留在该分支，未合并）`];
}

/** Flattens a message to one line and bounds it (progress notes). */
function shortMessage(text: string, max = 80): string {
  const single = text.replace(/\s+/g, " ").trim();
  return single.length > max ? `${single.slice(0, max)}…` : single;
}

/** Member result codes that are environmental — retrying cannot help. */
const ENVIRONMENT_FAILURE_CODES = new Set<string>(["WORKTREE_UNAVAILABLE", "MEMBER_NOT_FOUND", "CHILD_FAILED"]);

const FAILURE_GUIDANCE =
  [
    "⚠ 失败处理指令：",
    "- 上面的失败若为环境级错误（worktree/git 不可用、成员/模型不存在、子进程启动失败），重试必然再次失败——**不要再次派发给失败的成员**。",
    "- 调整方案（换成员、改任务、放弃该子任务）或直接输出最终报告，并在报告中如实说明失败原因。",
  ].join("\n");

/** Builds the combined markdown report returned to the leader. */
export function buildDispatchReport(results: MemberRunResult[]): string {
  const sections = results.map((result) => {
    const header = statusLine(result);
    const body = result.ok ? result.result : `错误: ${result.error?.message ?? result.result}`;
    return [header, "", body, ...worktreeLines(result)].join("\n");
  });
  const anyFailure = results.some((r) => !r.ok);
  return anyFailure ? `${sections.join("\n\n")}\n\n${FAILURE_GUIDANCE}` : sections.join("\n\n");
}

/** Builds a compact progress snapshot text (used for onUpdate + widget). */
export function buildProgressText(members: MemberProgress[]): string {
  const icon: Record<MemberProgressStatus, string> = {
    queued: "…",
    running: "▶",
    done: "✓",
    failed: "✗",
    aborted: "⊘",
  };
  return members
    .map((m) => {
      const bits = [`${icon[m.status]} ${m.name} ${m.status}`];
      if (m.note) bits.push(m.note);
      if (m.latest) bits.push(m.latest);
      return bits.join(" — ");
    })
    .join("\n");
}

/** Runs a bounded-concurrency map over items. */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

function truncateMessage(text: string, max = 2000): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * Creates the dispatch executor. Created ONCE per leader process: the
 * closure carries the per-run dispatch budget across calls.
 */
export function createDispatchExecutor(deps: DispatchDeps) {
  const git = deps.gitRunner ?? defaultGitRunner();
  const spawn = deps.spawn ?? defaultSpawn();
  let dispatchCalls = 0;
  let memberRuns = 0;

  return async function executeDispatch(
    request: DispatchRequest,
    signal: AbortSignal | undefined,
    onUpdate: OnUpdate | undefined,
  ): Promise<DispatchExecResult> {
    // Loop guard: a leader that keeps dispatching (e.g. retrying an
    // environmental failure forever) is cut off and told to wrap up.
    if (dispatchCalls >= MAX_DISPATCH_CALLS_PER_RUN || memberRuns >= MAX_MEMBER_RUNS_PER_RUN) {
      return {
        ok: false,
        code: "BUDGET_EXCEEDED",
        message: [
          `已达本次 run 的派发预算上限（${dispatchCalls} 次 dispatch / ${memberRuns} 次成员运行）。`,
          "不要再调用 team_dispatch。立即基于已收到的结果输出最终报告（含已完成部分与未完成原因）。",
        ].join(""),
      };
    }
    dispatchCalls++;
    memberRuns += request.tasks.length;

    const statuses = new Map<string, MemberProgress>();

    const emitProgress = () => {
      if (!onUpdate) return;
      try {
        onUpdate({
          content: [{ type: "text", text: buildProgressText(Array.from(statuses.values())) }],
          details: { members: Array.from(statuses.values()) },
        });
      } catch {
        /* progress failures never break the run */
      }
    };

    const setProgress = (name: string, status: MemberProgressStatus, note?: string, latest?: string) => {
      const previous = statuses.get(name);
      statuses.set(name, {
        name,
        status,
        ...(note !== undefined ? { note } : previous?.note ? { note: previous.note } : {}),
        ...(latest !== undefined ? { latest } : previous?.latest ? { latest: previous.latest } : {}),
      });
      emitProgress();
    };

    // Plan: resolve members up front (unknown names never spawn anything).
    const planned: PlannedDispatch[] = [];
    for (const item of request.tasks) {
      const member = deps.team.members.find((m) => m.name === item.agent);
      if (!member) {
        planned.push({
          task: item.task,
          preError: {
            code: "MEMBER_NOT_FOUND",
            message: `unknown agent "${item.agent}". Available members:\n${rosterText(deps.team)}`,
          },
        });
        continue;
      }
      planned.push({ member, task: item.task });
    }

    // Worktree setup (sequential — cheap git ops, avoids racing git index).
    for (const plan of planned) {
      if (!plan.member?.worktree || plan.preError) continue;
      setProgress(plan.member.name, "running", "创建 worktree…");
      const worktreePath = path.join(deps.worktreeRoot, deps.runId, plan.member.name);
      const branch = `team/${deps.runId}/${plan.member.name}`;
      const created = await createWorktree({ git, repoCwd: deps.cwd, worktreePath, branch });
      if (created.ok) {
        plan.worktree = created.value;
      } else {
        plan.preError = { code: created.code, message: created.message };
      }
    }

    for (const plan of planned) {
      const name = plan.member?.name ?? "?";
      statuses.set(name, {
        name,
        status: plan.preError ? "failed" : plan.worktree ? "running" : "queued",
        ...(plan.preError ? { note: shortMessage(`${plan.preError.code}: ${plan.preError.message}`) } : {}),
      });
    }
    emitProgress();

    const runOne = async (plan: PlannedDispatch): Promise<MemberRunResult> => {
      const name = plan.member?.name ?? "?";
      const startMs = Date.now();
      if (plan.preError || !plan.member) {
        return {
          name,
          ok: false,
          status: "failed",
          result: "",
          summary: "",
          usage: emptyUsage(),
          durationMs: 0,
          error: {
            code: plan.preError?.code ?? "CHILD_FAILED",
            message: plan.preError?.message ?? "unknown error",
          },
        };
      }

      const args: string[] = ["--mode", "json", "-p", "--no-session"];
      if (plan.member.model) args.push("--model", plan.member.model);
      if (plan.member.tools && plan.member.tools.length > 0) args.push("--tools", plan.member.tools.join(","));
      if (plan.member.prompt.trim()) args.push("--append-system-prompt", `team-tmp://${plan.member.prompt}`);
      args.push(`Task: ${plan.task}`);

      const invocation = deps.piCommand ? { command: deps.piCommand, args } : getPiInvocation(args);

      setProgress(name, "running");
      try {
        const outcome = await runChildPi({
          command: invocation.command,
          args: invocation.args,
          cwd: plan.worktree?.path ?? deps.cwd,
          spawn,
          signal,
          killGraceMs: deps.killGraceMs,
          onEvent: (event) => {
            if (event.type === "message_end" && event.role === "assistant") {
              if (event.usage) {
                setProgress(name, "running", `turn ${event.usage.turns}`, event.text);
              } else if (event.text) {
                setProgress(name, "running", undefined, event.text);
              }
            }
          },
        });
        const durationMs = Date.now() - startMs;
        const aborted = signal?.aborted === true || outcome.stopReason === "aborted";
        const failed = aborted || outcome.exitCode !== 0 || outcome.stopReason === "error" || !!outcome.errorMessage;
        const rawText = outcome.finalText || outcome.stderr || "(no output)";
        const result: MemberRunResult = {
          name,
          ok: !failed,
          status: aborted ? "aborted" : failed ? "failed" : "done",
          result: truncateUtf8(rawText, MAX_RESULT_BYTES),
          summary: truncateUtf8(rawText, MAX_SUMMARY_BYTES),
          usage: outcome.usage,
          durationMs,
        };
        if (plan.worktree) result.worktree = plan.worktree;
        if (failed) {
          result.error = {
            code: aborted ? "AGENT_ABORTED" : "CHILD_FAILED",
            message: truncateMessage(outcome.errorMessage || outcome.stderr || `pi exited with code ${outcome.exitCode}`),
          };
        }
        setProgress(
          name,
          result.status,
          result.ok ? `turn ${outcome.usage.turns}` : shortMessage(`${result.error?.code}: ${result.error?.message}`),
          result.ok ? shortMessage(rawText) : undefined,
        );
        return result;
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        setProgress(name, "failed", shortMessage(`CHILD_FAILED: ${message}`));
        const result: MemberRunResult = {
          name,
          ok: false,
          status: "failed",
          result: "",
          summary: "",
          usage: emptyUsage(),
          durationMs: Date.now() - startMs,
          error: { code: "CHILD_FAILED", message: truncateMessage(`failed to start pi subprocess: ${message}`) },
        };
        if (plan.worktree) result.worktree = plan.worktree;
        return result;
      }
    };

    const results = await mapWithConcurrency(planned, MAX_PARALLEL_MEMBERS, runOne);

    const totalUsage = emptyUsage();
    for (const result of results) {
      totalUsage.cost += result.usage.cost;
      totalUsage.input += result.usage.input;
      totalUsage.output += result.usage.output;
    }

    return { ok: true, value: { results, text: buildDispatchReport(results) } };
  };
}

/**
 * Extracts per-member dispatch results (status/summary/latest/usage/worktree)
 * from a team_dispatch tool `details` payload as seen in the leader's JSON
 * event stream. Lenient: malformed shapes yield undefined.
 */
export function parseDispatchMemberResults(details: unknown): DispatchMemberDetail[] | undefined {
  if (details === null || typeof details !== "object") return undefined;
  const members = (details as { members?: unknown }).members;
  if (!Array.isArray(members)) return undefined;
  const results: DispatchMemberDetail[] = [];
  for (const item of members) {
    if (item === null || typeof item !== "object") continue;
    const raw = item as Record<string, unknown>;
    if (typeof raw.name !== "string" || typeof raw.status !== "string") continue;
    results.push({
      name: raw.name,
      ok: raw.ok === true,
      status: raw.status as MemberProgressStatus,
      ...(typeof raw.summary === "string" ? { summary: raw.summary } : {}),
      ...(typeof raw.latest === "string" ? { latest: raw.latest } : {}),
      ...(raw.usage !== null && typeof raw.usage === "object" ? { usage: raw.usage as AgentUsage } : {}),
      ...(raw.worktree !== null && typeof raw.worktree === "object"
        ? { worktree: raw.worktree as { path: string; branch: string } }
        : {}),
      ...(raw.error !== null && typeof raw.error === "object" ? { error: raw.error as { code: string; message: string } } : {}),
    });
  }
  return results.length > 0 ? results : undefined;
}
