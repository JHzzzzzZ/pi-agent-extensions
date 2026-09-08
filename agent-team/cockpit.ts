/**
 * agent-team — cockpit run coordinator (main session side)
 *
 * Owns the single active team run: pre-flights worktree requirements,
 * spawns the leader child pi process with the team's leader prompt +
 * dispatch tool, tracks progress from the leader's JSON event stream (its
 * own turns/activity + team_dispatch tool updates), renders the widget,
 * exposes a status snapshot, and produces the final TeamRunRecord.
 */

import * as path from "node:path";
import { defaultSpawn, getPiInvocation, runChildPi } from "./runner.ts";
import { parseDispatchMemberResults } from "./dispatch.ts";
import { buildLeaderSystemPrompt } from "./leader-prompt.ts";
import { FileTranscriptSink, LEADER_ACTOR, type TranscriptEntryKind } from "./transcript.ts";
import { createWorktree, defaultGitRunner, isGitRepo, type GitRunner } from "./worktree.ts";
import {
  LEADER_ENV_FILE,
  LEADER_ENV_NAME,
  LEADER_ENV_RUNID,
  MAX_RESULT_BYTES,
  truncateUtf8,
  type ChildEvent,
  type MemberProgress,
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
  /** Root for per-run worktrees. */
  worktreeRoot: string;
  /** Absolute path of this extension's index.ts (passed to leader via -e). */
  extensionEntryPath?: string;
  spawn?: PiSpawn;
  piCommand?: string;
  gitRunner?: GitRunner;
  killGraceMs?: number;
  /** Root for per-run transcript artifacts (leader activity for /team:view). */
  transcriptRoot?: string;
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

/** One-line bounded summaries of tool calls/results (transcript display). */
function toolCallText(toolName: string, payload: unknown): string {
  const single = (text: string): string => text.replace(/\s+/g, " ").trim();
  const payloadText = payload === undefined || payload === null ? "" : ` ${single(JSON.stringify(payload))}`;
  const text = single(`${toolName}${payloadText}`);
  return text.length > 300 ? `${text.slice(0, 300)}…` : text;
}

function toolResultText(toolName: string, result: unknown): string {
  const single = (text: string): string => text.replace(/\s+/g, " ").trim();
  const text = single(`${toolName}${result === undefined || result === null ? "" : ` → ${result}`}`);
  return text.length > 300 ? `${text.slice(0, 300)}…` : text;
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
  if (progress.leaderActivity) {
    lines.push(dim(`  ↳ ${progress.leaderActivity}`));
  }
  for (const member of progress.members) {
    const icon =
      member.status === "done" ? "✓" : member.status === "failed" ? "✗" : member.status === "aborted" ? "⊘" : "▶";
    const bits = [`${icon} ${member.name} ${member.status}`];
    if (member.note) bits.push(member.note);
    if (member.latest) bits.push(member.latest);
    lines.push(dim(bits.join(" — ")));
  }
  return lines;
}

/** Immutable snapshot of the current/most recent run (status queries). */
export interface RunStatusSnapshot {
  running: boolean;
  progress: RunProgress | null;
  lastRecord: TeamRunRecord | null;
}

/** Formats a status snapshot for /team:status and the team_status tool. */
export function formatStatusSnapshot(snapshot: RunStatusSnapshot, nowMs: number, dim?: (t: string) => string): string {
  const line = (t: string): string => (dim ? dim(t) : t);
  const icon = (status: string): string =>
    status === "done" || status === "completed" ? "✓" : status === "failed" ? "✗" : status === "aborted" ? "⊘" : status === "running" ? "▶" : "…";

  if (snapshot.running && snapshot.progress) {
    const p = snapshot.progress;
    const lines = [
      line(`当前 run：team ${p.team} ▶ running · ${elapsedLabel(p.startedAtMs, nowMs)}`),
      line(`任务: ${p.task}`),
    ];
    const leaderBits: string[] = [];
    if (p.leaderModel) leaderBits.push(p.leaderModel);
    if (p.leaderNote) leaderBits.push(p.leaderNote);
    lines.push(line(`leader: ${leaderBits.length > 0 ? leaderBits.join(" · ") : "thinking"}`));
    if (p.leaderActivity) lines.push(line(`  ↳ ${p.leaderActivity}`));
    for (const member of p.members) {
      const bits = [`${icon(member.status)} ${member.name} ${member.status}`];
      if (member.note) bits.push(member.note);
      if (member.latest) bits.push(member.latest);
      lines.push(line(`  ${bits.join(" — ")}`));
    }
    return lines.join("\n");
  }

  const record = snapshot.lastRecord;
  if (record) {
    const secs = record.durationMs !== undefined ? ` · ${Math.round(record.durationMs / 100) / 10}s` : "";
    const cost = record.totalCost > 0 ? ` · $${record.totalCost.toFixed(4)}` : "";
    const lines = [
      line(`最近一次 run：team ${record.team} ${icon(record.status)} ${record.status}${secs}${cost}`),
      line(`任务: ${record.task}`),
    ];
    if (record.error) lines.push(line(`错误: ${record.error}`));
    for (const member of record.members) {
      const bits = [`${icon(member.status)} ${member.name} ${member.status}`];
      if (member.model) bits.push(member.model);
      if (member.usage) bits.push(`$${member.usage.cost.toFixed(4)}`);
      if (member.summary) bits.push(member.summary.length > 80 ? `${member.summary.slice(0, 80)}…` : member.summary);
      lines.push(line(`  ${bits.join(" — ")}`));
    }
    if (record.worktree) {
      lines.push(line(`共享 worktree: \`${record.worktree.path}\`（分支 \`${record.worktree.branch}\`）`));
    }
    return lines.join("\n");
  }

  return "当前没有 team run 记录。用 /team:run <团队> <任务> 或 team_run 工具派单。";
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
  private currentProgress: RunProgress | null = null;
  private lastRecord: TeamRunRecord | null = null;

  constructor(deps: CoordinatorDeps) {
    this.deps = deps;
  }

  isRunning(): boolean {
    return this.active !== null;
  }

  /** Current/most recent run snapshot (team_status tool + /team:status). */
  getStatus(): RunStatusSnapshot {
    return { running: this.active !== null, progress: this.currentProgress, lastRecord: this.lastRecord };
  }

  /** Restores the last record after a reload (session_start hydration). */
  restoreLastRecord(record: TeamRunRecord): void {
    if (!this.lastRecord || (record.startedAt ?? "") > (this.lastRecord.startedAt ?? "")) {
      this.lastRecord = record;
    }
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
    const git = this.deps.gitRunner ?? defaultGitRunner();
    const baseCwd = this.deps.cwd();

    // Pre-flight: worktree requirements must be satisfiable BEFORE spawning
    // anything (environmental errors are otherwise invisible mid-run).
    const needsWorktree = team.worktree === true || team.members.some((m) => m.worktree === true);
    let sharedWorktree: { path: string; branch: string } | undefined;
    if (needsWorktree) {
      if (!(await isGitRepo(git, baseCwd))) {
        return {
          ok: false,
          code: "WORKTREE_UNAVAILABLE",
          message: `预检失败：团队或成员配置了 worktree 隔离，但 "${baseCwd}" 不是 git 仓库。请在 git 仓库中运行，或去掉团队/成员的 worktree 配置。`,
        };
      }
      if (team.worktree) {
        const created = await createWorktree({
          git,
          repoCwd: baseCwd,
          worktreePath: path.join(this.deps.worktreeRoot, runId, "team"),
          branch: `team/${runId}`,
        });
        if (!created.ok) {
          return { ok: false, code: created.code, message: `预检失败：创建团队共享 worktree 失败 — ${created.message}` };
        }
        sharedWorktree = created.value;
      }
    }

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
    this.currentProgress = progress;

    // Leader transcript artifacts (best-effort; read back by /team:view and
    // the team_transcript tool). Member transcripts are written by the
    // leader process itself — both sides share the run dir.
    const transcript = this.deps.transcriptRoot
      ? new FileTranscriptSink(this.deps.transcriptRoot, runId, now)
      : undefined;
    const recordTranscript = (kind: TranscriptEntryKind, text: string): void => {
      if (!transcript) return;
      try {
        transcript.append(LEADER_ACTOR, kind, text);
      } catch {
        /* transcript failures never break the run */
      }
    };
    recordTranscript("task", task);

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
        if (event.fullText) recordTranscript("assistant", event.fullText);
        if (event.usage) progress.leaderNote = `turn ${event.usage.turns}`;
        if (event.model) progress.leaderModel = event.model;
        if (event.text) progress.leaderActivity = event.text;
        render();
        return;
      }
      if (event.type === "tool_execution_start") {
        // Transcript keeps every leader tool call; progress only tracks dispatch.
        recordTranscript("tool", toolCallText(event.toolName, event.args));
        if (event.toolName !== "team_dispatch") return;
        const tasks = (event.args as { tasks?: Array<{ agent?: string; task?: string }> } | undefined)?.tasks;
        if (Array.isArray(tasks)) {
          const names = new Set(tasks.map((t) => t.agent).filter((a): a is string => typeof a === "string"));
          for (const member of progress.members) {
            if (names.has(member.name) && member.status === "queued") member.status = "running";
          }
          const dispatchLines = tasks
            .map((t) => (typeof t?.agent === "string" ? `${t.agent}: ${typeof t?.task === "string" ? t.task : ""}` : null))
            .filter((line): line is string => line !== null);
          if (dispatchLines.length > 0) recordTranscript("tool", `team_dispatch 派发 →\n${dispatchLines.map((l) => `  - ${l}`).join("\n")}`);
        }
        render();
        return;
      }
      if (event.type === "tool_execution_end") {
        recordTranscript("tool", toolResultText(event.toolName, event.text));
        if (event.toolName !== "team_dispatch") return;
        const members = parseDispatchMemberResults(event.details);
        if (members) {
          for (const member of members) {
            const existing = progress.members.find((m) => m.name === member.name);
            const next: MemberProgress = {
              name: member.name,
              status: member.status,
              ...(member.error ? { note: `${member.error.code}: ${member.error.message}` } : {}),
              ...(member.latest ? { latest: member.latest } : {}),
            };
            // Bound the failure note so the widget stays readable.
            if (next.note && next.note.length > 120) next.note = `${next.note.slice(0, 120)}…`;
            if (existing) Object.assign(existing, next);
            else progress.members.push(next);
          }
        }
        render();
        return;
      }
      if (event.type === "error") {
        recordTranscript("error", `${event.code}: ${event.message}`);
      }
    };

    const leaderPrompt = buildLeaderSystemPrompt(team, sharedWorktree);
    const args: string[] = ["--mode", "json", "-p", "--no-session"];
    if (team.leader.model) args.push("--model", team.leader.model);
    if (team.leader.tools && team.leader.tools.length > 0) args.push("--tools", team.leader.tools.join(","));
    if (this.deps.extensionEntryPath) args.push("-e", this.deps.extensionEntryPath);
    args.push("--append-system-prompt", `team-tmp://${leaderPrompt}`);
    args.push(`Task: ${task}`);

    const invocation = this.deps.piCommand ? { command: this.deps.piCommand, args } : getPiInvocation(args);
    const leaderCwd = sharedWorktree?.path ?? baseCwd;

    // 1s elapsed-time ticker for the widget; never keeps the process alive.
    const ticker = setInterval(render, 1000);
    if (typeof ticker.unref === "function") ticker.unref();

    try {
      const outcome = await runChildPi({
        command: invocation.command,
        args: invocation.args,
        cwd: leaderCwd,
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
          ...(member.latest !== undefined ? { latest: member.latest } : {}),
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
        ...(sharedWorktree ? { worktree: sharedWorktree } : {}),
      };
      const runStatus = aborted ? "aborted" : failed ? "failed" : "completed";
      recordTranscript("system", `run ${runStatus} · ${Math.round((record.durationMs ?? 0) / 100) / 10}s · $${record.totalCost.toFixed(4)}`);
      if (record.error) recordTranscript("error", record.error);
      this.lastRecord = record;
      return { ok: true, value: record };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      recordTranscript("error", `CHILD_FAILED: failed to start leader process: ${message}`);
      return { ok: false, code: "CHILD_FAILED", message: `failed to start leader process: ${message}` };
    } finally {
      this.active = null;
      clearInterval(ticker);
    }
  }
}
