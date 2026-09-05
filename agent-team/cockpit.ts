/**
 * agent-team — cockpit run coordinator (main session side)
 *
 * Owns the single active team run: spawns the leader child pi process with
 * the team's leader prompt + dispatch tool, tracks progress from the
 * leader's JSON event stream (its own turns + team_dispatch tool updates),
 * renders the widget, and produces the final TeamRunRecord.
 */

import { defaultSpawn, getPiInvocation, runChildPi } from "./runner.ts";
import { parseDispatchMemberResults } from "./dispatch.ts";
import { buildLeaderSystemPrompt } from "./leader-prompt.ts";
import {
  LEADER_ENV_FILE,
  LEADER_ENV_NAME,
  LEADER_ENV_RUNID,
  MAX_RESULT_BYTES,
  truncateUtf8,
  type ChildEvent,
  type PiSpawn,
  type RunProgress,
  type TeamConfig,
  type TeamErrorCode,
  type TeamRunRecord,
} from "./types.ts";

/** UI surface used by the coordinator (implemented over ctx.ui, guarded). */
export interface UiPort {
  setWidget: (lines: string[] | undefined) => void;
  notify: (text: string, level: "info" | "warning" | "error") => void;
  dim: (text: string) => string;
}

export interface CoordinatorDeps {
  cwd: () => string;
  /** Root for member worktrees. */
  worktreeRoot: string;
  /** Absolute path of this extension's index.ts (passed to leader via -e). */
  extensionEntryPath?: string;
  spawn?: PiSpawn;
  piCommand?: string;
  killGraceMs?: number;
  /** Test seams. */
  now?: () => string;
  nowMs?: () => number;
}

export type StartRunResult =
  | { ok: true; value: TeamRunRecord }
  | { ok: false; code: TeamErrorCode; message: string };

function elapsedLabel(startedAtMs: number, nowMs: number): string {
  const totalSecs = Math.max(0, Math.round((nowMs - startedAtMs) / 1000));
  const mins = Math.floor(totalSecs / 60);
  const secs = totalSecs % 60;
  return mins > 0 ? `${mins}m${secs}s` : `${secs}s`;
}

/** Pure widget renderer (unit-tested). */
export function renderWidgetLines(progress: RunProgress, nowMs: number, dim: (text: string) => string): string[] {
  const lines: string[] = [];
  lines.push(dim(`agent-team ${progress.team} ▶ running · ${elapsedLabel(progress.startedAtMs, nowMs)}`));
  const task = progress.task.length > 44 ? `${progress.task.slice(0, 44)}…` : progress.task;
  lines.push(dim(`任务: ${task}`));
  const leaderBits: string[] = [];
  if (progress.leaderModel) leaderBits.push(progress.leaderModel);
  if (progress.leaderNote) leaderBits.push(progress.leaderNote);
  lines.push(dim(`leader: ${leaderBits.length > 0 ? leaderBits.join(" · ") : "thinking"}`));
  for (const member of progress.members) {
    const icon =
      member.status === "done" ? "✓" : member.status === "failed" ? "✗" : member.status === "aborted" ? "⊘" : "▶";
    lines.push(dim(`${icon} ${member.name} ${member.status}${member.note ? ` — ${member.note}` : ""}`));
  }
  return lines;
}

/**
 * Runs one team task: spawn the leader, stream progress, resolve with the
 * final run record. The leader's team_dispatch tool results carry per-member
 * summaries/usage; they are folded into the record.
 */
export async function runTeamTask(deps: {
  coordinator: TeamRunCoordinator;
  team: TeamConfig;
  task: string;
  ui: UiPort;
  onProgress?: (progress: RunProgress) => void;
}): Promise<StartRunResult> {
  return deps.coordinator.start({ team: deps.team, task: deps.task, ui: deps.ui, onProgress: deps.onProgress });
}

export class TeamRunCoordinator {
  private readonly deps: CoordinatorDeps;
  private active: AbortController | null = null;

  constructor(deps: CoordinatorDeps) {
    this.deps = deps;
  }

  isRunning(): boolean {
    return this.active !== null;
  }

  /** Aborts the active run (leader + all member children). */
  stop(): boolean {
    if (!this.active) return false;
    this.active.abort();
    return true;
  }

  /**
   * Starts a team run. Resolves when the leader child finishes; progress
   * flows through `ui.setWidget` and `onProgress` while it runs. A run that
   * fails at the child level still resolves (status failed/aborted). An
   * optional external `signal` (e.g. the calling tool's abort signal) is
   * bridged to the run controller.
   */
  async start(options: {
    team: TeamConfig;
    task: string;
    ui: UiPort;
    onProgress?: (progress: RunProgress) => void;
    signal?: AbortSignal;
  }): Promise<StartRunResult> {
    if (this.active) {
      return {
        ok: false,
        code: "RUN_IN_PROGRESS",
        message: "另一个 team run 正在进行中；先 /team:stop 或等它结束。",
      };
    }
    const { team, task, ui } = options;
    const now = this.deps.now ?? (() => new Date().toISOString());
    const nowMs = this.deps.nowMs ?? (() => Date.now());
    const runId = `run-${nowMs()}`;
    const startedAtMs = nowMs();
    const controller = new AbortController();
    this.active = controller;
    if (options.signal) {
      if (options.signal.aborted) controller.abort();
      else options.signal.addEventListener("abort", () => controller.abort(), { once: true });
    }

    const progress: RunProgress = {
      runId,
      team: team.name,
      task,
      startedAtMs,
      members: team.members.map((m) => ({ name: m.name, status: "queued" as const })),
    };

    const render = () => {
      try {
        ui.setWidget(renderWidgetLines(progress, nowMs(), ui.dim));
      } catch {
        /* widget failures never break the run */
      }
      try {
        options.onProgress?.(progress);
      } catch {
        /* observer failures never break the run */
      }
    };

    const onEvent = (event: ChildEvent) => {
      if (event.type === "message_end" && event.role === "assistant") {
        if (event.usage) progress.leaderNote = `turn ${event.usage.turns}`;
        if (event.model) progress.leaderModel = event.model;
        render();
        return;
      }
      if (
        event.type === "tool_execution_start" ||
        event.type === "tool_execution_update" ||
        event.type === "tool_execution_end"
      ) {
        if (event.toolName !== "team_dispatch") return;
        if (event.type === "tool_execution_start") {
          const tasks = (event.args as { tasks?: Array<{ agent?: string }> } | undefined)?.tasks;
          if (Array.isArray(tasks)) {
            const names = new Set(tasks.map((t) => t.agent).filter((a): a is string => typeof a === "string"));
            for (const member of progress.members) {
              if (names.has(member.name) && member.status === "queued") member.status = "running";
            }
          }
        } else {
          const members = parseDispatchMemberResults(event.details);
          if (members) {
            for (const member of members) {
              const existing = progress.members.find((m) => m.name === member.name);
              const next = { name: member.name, status: member.status, ...(member.error ? { note: member.error.code } : {}) };
              if (existing) Object.assign(existing, next);
              else progress.members.push(next);
            }
          }
        }
        render();
      }
    };

    const leaderPrompt = buildLeaderSystemPrompt(team);
    const args: string[] = ["--mode", "json", "-p", "--no-session"];
    if (team.leader.model) args.push("--model", team.leader.model);
    if (team.leader.tools && team.leader.tools.length > 0) args.push("--tools", team.leader.tools.join(","));
    if (this.deps.extensionEntryPath) args.push("-e", this.deps.extensionEntryPath);
    args.push("--append-system-prompt", `team-tmp://${leaderPrompt}`);
    args.push(`Task: ${task}`);

    const invocation = this.deps.piCommand ? { command: this.deps.piCommand, args } : getPiInvocation(args);

    // 1s elapsed-time ticker for the widget; never keeps the process alive.
    const ticker = setInterval(render, 1000);
    if (typeof ticker.unref === "function") ticker.unref();

    try {
      const outcome = await runChildPi({
        command: invocation.command,
        args: invocation.args,
        cwd: this.deps.cwd(),
        env: {
          [LEADER_ENV_FILE]: team.filePath,
          [LEADER_ENV_NAME]: team.name,
          [LEADER_ENV_RUNID]: runId,
        },
        spawn: this.deps.spawn ?? defaultSpawn(),
        signal: controller.signal,
        killGraceMs: this.deps.killGraceMs,
        onEvent,
      });

      const aborted = controller.signal.aborted;
      const failed = !aborted && (outcome.exitCode !== 0 || outcome.stopReason === "error" || !!outcome.errorMessage);

      // Fold per-member results from every team_dispatch tool_execution_end.
      const dispatchResults = outcome.events.flatMap((event) =>
        event.type === "tool_execution_end" && event.toolName === "team_dispatch"
          ? (parseDispatchMemberResults(event.details) ?? [])
          : [],
      );
      const members = dispatchResults.map((member) => {
        const config = team.members.find((m) => m.name === member.name);
        return {
          name: member.name,
          model: config?.model,
          status: member.status,
          ...(member.summary !== undefined ? { summary: member.summary } : {}),
          ...(member.usage ? { usage: member.usage } : {}),
          ...(member.worktree ? { worktree: member.worktree } : {}),
        };
      });

      const record: TeamRunRecord = {
        runId,
        team: team.name,
        task,
        startedAt: now(),
        status: aborted ? "aborted" : failed ? "failed" : "completed",
        ...(failed
          ? {
              error: truncateUtf8(
                outcome.errorMessage || outcome.stderr || `pi exited with code ${outcome.exitCode}`,
                2000,
              ),
            }
          : {}),
        report: outcome.finalText ? truncateUtf8(outcome.finalText, MAX_RESULT_BYTES) : undefined,
        members,
        leaderUsage: outcome.usage,
        totalCost: outcome.usage.cost,
        totalTokens: outcome.usage.input + outcome.usage.output,
        durationMs: nowMs() - startedAtMs,
      };
      return { ok: true, value: record };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return { ok: false, code: "CHILD_FAILED", message: `failed to start leader process: ${message}` };
    } finally {
      this.active = null;
      clearInterval(ticker);
    }
  }
}
