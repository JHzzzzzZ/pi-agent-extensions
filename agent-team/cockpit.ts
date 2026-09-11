/**
 * agent-team — cockpit run coordinator (main session side)
 *
 * Owns the single active team run: pre-flights worktree requirements,
 * spawns the leader child pi process with the team's leader prompt +
 * dispatch tool, tracks progress from the leader's JSON event stream (its
 * own turns/activity + team_dispatch tool updates), exposes a status
 * snapshot (pulled by the below-editor widget and status queries), and
 * produces the final TeamRunRecord.
 */

import * as path from "node:path";
import { startAlignedTicker } from "./aligned-ticker.ts";
import { splitModelThinking } from "./config.ts";
import { defaultSpawn, getPiInvocation, runChildPi } from "./runner.ts";
import { parseDispatchMemberResults, parseDispatchTotalUsage } from "./dispatch.ts";
import { buildLeaderSystemPrompt } from "./leader-prompt.ts";
import { resolveModelCaliber } from "./model-caliber.ts";
import { fileRunStore, RUN_STATUS_VERSION, type RunStoreWriter } from "./runstore.ts";
import { FileTranscriptSink, LEADER_ACTOR, type TranscriptEntryKind } from "./transcript.ts";
import { createWorktree, defaultGitRunner, isGitRepo, teamWorktreeBranch, type GitRunner } from "./worktree.ts";
import {
  DERIVED_AGENT_TOOL_DENYLIST,
  LEADER_ENV_FILE,
  LEADER_ENV_NAME,
  LEADER_ENV_RUNID,
  MAX_RESULT_BYTES,
  STOP_SETTLE_TIMEOUT_MS,
  truncateUtf8,
  resolveRunBudget,
  type ChildEvent,
  type MemberProgress,
  type PiChildProcess,
  type PiChildStdin,
  type PiSpawn,
  type RunProgress,
  type RunStatus,
  type TeamConfig,
  type TeamErrorCode,
  type TeamRunRecord,
} from "./types.ts";
import { flattenText, truncateVisible } from "./viewer.ts";

/** UI surface used by the coordinator (implemented over ctx.ui, guarded). */
export interface UiPort {
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
  /**
   * Run status persistence (status.json per run dir). Defaults to a file
   * store under `transcriptRoot` so a crashed session's runs can be
   * reconciled on the next session_start.
   */
  runStore?: RunStoreWriter;
  /**
   * Main-session PID recorded in status.json snapshots (ownerPid). Defaults
   * to this process; another live session must not reconcile our runs.
   */
  ownerPid?: number;
  /** Test seams. */
  now?: () => string;
  nowMs?: () => number;
}

export type StartRunResult =
  | { ok: true; value: TeamRunRecord }
  | { ok: false; code: TeamErrorCode; message: string };

/** Input of one team run (spawned leader + member dispatch). */
interface StartOptions {
  team: TeamConfig;
  task: string;
  ui: UiPort;
  onProgress?: (progress: RunProgress) => void;
  signal?: AbortSignal;
}

/** Pre-computed run identity handed from start() to runActive(). */
interface RunPlan {
  now: () => string;
  nowMs: () => number;
  runId: string;
  /** Claim-time ISO timestamp reused by every snapshot/record of this run. */
  startedAt: string;
  startedAtMs: number;
  progress: RunProgress;
}

/** Elapsed label for live runs: "45s" / "3m12s". */
export function elapsedLabel(startedAtMs: number, nowMs: number): string {
  const totalSecs = Math.max(0, Math.round((nowMs - startedAtMs) / 1000));
  const mins = Math.floor(totalSecs / 60);
  const secs = totalSecs % 60;
  return mins > 0 ? `${mins}m${secs}s` : `${secs}s`;
}

/** One-line bounded summaries of tool calls/results (transcript display). */
function toolCallText(toolName: string, payload: unknown): string {
  const payloadText = payload === undefined || payload === null ? "" : ` ${flattenText(JSON.stringify(payload))}`;
  const text = flattenText(`${toolName}${payloadText}`);
  return text.length > 300 ? `${text.slice(0, 300)}…` : text;
}

function toolResultText(toolName: string, result: unknown): string {
  const text = flattenText(`${toolName}${result === undefined || result === null ? "" : ` → ${result}`}`);
  return text.length > 300 ? `${text.slice(0, 300)}…` : text;
}

/** Immutable snapshot of the current/most recent run (status queries). */
export interface RunStatusSnapshot {
  running: boolean;
  progress: RunProgress | null;
  lastRecord: TeamRunRecord | null;
}

/** 任务行显示上限（仅任务文本本身，不含 `任务: ` 前缀）：60 显示列。 */
const STATUS_TASK_MAX_WIDTH = 60;

/** 任务文本：先压平换行，再按显示宽度截断（CJK 双宽，超宽补 `…`）。 */
function statusTaskText(task: string): string {
  return truncateVisible(flattenText(task), STATUS_TASK_MAX_WIDTH);
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
      line(`runId: ${p.runId}`),
      line(`任务: ${statusTaskText(p.task)}`.trimEnd()),
    ];
    const leaderBits: string[] = [];
    const leaderModel = resolveModelCaliber(p.leaderDeclaredModel, p.leaderModel);
    if (leaderModel) leaderBits.push(leaderModel);
    if (p.leaderNote) leaderBits.push(p.leaderNote);
    lines.push(line(`leader: ${leaderBits.length > 0 ? leaderBits.join(" · ") : "thinking"}`));
    if (p.leaderActivity) lines.push(line(`  ↳ ${p.leaderActivity}`));
    if (p.budget) {
      const b = p.budget;
      const costPart = b.maxCostUsd !== null ? `$${b.spentCost.toFixed(2)}/$${b.maxCostUsd.toFixed(2)}` : `$${b.spentCost.toFixed(2)}`;
      lines.push(line(`预算: ${costPart} · ${b.dispatchCalls}/${b.maxDispatchCalls} 派发 · ${b.memberRuns}/${b.maxMemberRuns} 成员`));
    }
    for (const member of p.members) {
      const bits = [`${icon(member.status)} ${member.name} ${member.status}`];
      if (member.model) bits.push(member.model);
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
      line(`runId: ${record.runId}`),
      line(`任务: ${statusTaskText(record.task)}`.trimEnd()),
    ];
    if (record.error) lines.push(line(`错误: ${record.error}`));
    for (const member of record.members) {
      const bits = [`${icon(member.status)} ${member.name} ${member.status}`];
      const model = resolveModelCaliber(member.model, member.usage?.model);
      if (model) bits.push(model);
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
  private readonly runStore: RunStoreWriter | undefined;
  private active: AbortController | null = null;
  private pending: Promise<StartRunResult> | null = null;
  private currentProgress: RunProgress | null = null;
  private lastRecord: TeamRunRecord | null = null;
  /** Leader RPC stdin (prompt/steer commands) — live only while a run is active. */
  private leaderStdin: PiChildStdin | undefined;
  /** Set when pi rejects the initial prompt (no agent run, so no settle event). */
  private promptError: string | undefined;

  constructor(deps: CoordinatorDeps) {
    this.deps = deps;
    this.runStore = deps.runStore ?? (deps.transcriptRoot ? fileRunStore(deps.transcriptRoot) : undefined);
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
   * Injects a user message into the running leader (RPC `steer`): pi hands
   * it to the agent at the next turn boundary — the current task is not
   * interrupted. Returns false when no leader stdin channel is live (no
   * active run / spawn pending / write failure) so callers fall back to
   * queue semantics instead.
   */
  steerLeader(message: string): boolean {
    if (!this.active || !this.leaderStdin) return false;
    try {
      this.leaderStdin.write(`${JSON.stringify({ type: "steer", message })}\n`);
      return true;
    } catch {
      return false;
    }
  }

  /** Ends the leader's stdin — RPC mode exits its process when stdin ends. */
  private closeLeaderStdin(): void {
    const stdin = this.leaderStdin;
    this.leaderStdin = undefined;
    try {
      stdin?.end();
    } catch {
      /* the run settles via the child's close event regardless */
    }
  }

  /**
   * Aborts the active run and waits (bounded) for it to settle into its
   * terminal record — the same primitive the team_stop tool and the viewer
   * stop path share. settled:false means the abort signal was sent but the
   * children are still shutting down; never an error by itself, the run's
   * promise keeps resolving in the background (with the terminal record
   * landing on lastRecord).
   */
  async stopAndSettle(
    timeoutMs: number = STOP_SETTLE_TIMEOUT_MS,
  ): Promise<{ wasRunning: boolean; settled: boolean; record: TeamRunRecord | null }> {
    if (!this.active) {
      return { wasRunning: false, settled: true, record: null };
    }
    this.active.abort();
    const run = this.pending;
    if (!run) {
      return { wasRunning: true, settled: false, record: null };
    }
    // Clear the timeout timer as soon as the run settles so a settled stop
    // never keeps a 7s placeholder alive in the event loop.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const outcome = await Promise.race([
      run.then((result): { settled: boolean; record: TeamRunRecord | null } => {
        if (timer !== undefined) clearTimeout(timer);
        return { settled: true, record: result.ok ? result.value : null };
      }),
      new Promise<{ settled: false; record: null }>((resolve) => {
        timer = setTimeout(() => resolve({ settled: false, record: null }), timeoutMs);
      }),
    ]);
    return { wasRunning: true, settled: outcome.settled, record: outcome.record };
  }

  /** runId of the run currently claimed (spawn pending or in flight). */
  activeRunId(): string | null {
    return this.currentProgress?.runId ?? null;
  }

  /**
   * Best-effort status.json update (crash recovery for the next session).
   * Never throws — status persistence must not break a run.
   */
  private persistRunStatus(input: {
    runId: string;
    team: string;
    task: string;
    startedAt: string;
    status: RunStatus;
    leaderPid?: number;
    error?: string;
    now: () => string;
  }): void {
    const store = this.runStore;
    if (!store) return;
    try {
      store.write({
        version: RUN_STATUS_VERSION,
        runId: input.runId,
        team: input.team,
        task: input.task,
        startedAt: input.startedAt,
        status: input.status,
        ...(input.leaderPid !== undefined ? { leaderPid: input.leaderPid } : {}),
        ownerPid: this.deps.ownerPid ?? process.pid,
        ...(input.error !== undefined ? { error: input.error } : {}),
        updatedAt: input.now(),
      });
    } catch {
      /* status failures never break the run */
    }
  }

  /**
   * Starts a team run. Resolves when the leader child finishes; progress
   * flows through `onProgress` (and the below-editor widget, which pulls
   * getStatus() on its own repaint ticks) while it runs. A run that fails
   * at the child level still resolves (status failed/aborted). An optional
   * external `signal` (e.g. the calling tool's abort signal) is bridged to
   * the run controller.
   */
  async start(options: StartOptions): Promise<StartRunResult> {
    if (this.active) {
      return {
        ok: false,
        code: "RUN_IN_PROGRESS",
        message: "另一个 team run 正在进行中；先 /team:stop 或等它结束。",
      };
    }
    const { team, task } = options;
    const now = this.deps.now ?? (() => new Date().toISOString());
    const nowMs = this.deps.nowMs ?? (() => Date.now());
    const runId = `run-${nowMs()}`;
    const startedAtMs = nowMs();
    // One claim-time timestamp for the whole run: running snapshot, spawn
    // refresh, terminal snapshot and terminal record all reuse it, so
    // elapsed = updatedAt - startedAt stays truthful after settle.
    const startedAt = now();
    // Claim the run BEFORE any await: two concurrent starts can no longer
    // both pass the RUN_IN_PROGRESS gate, stopAndSettle has a stable handle
    // (this.pending), and team_run can read the runId right after start().
    const controller = new AbortController();
    this.active = controller;
    // Fresh RPC channel state for this run (stale handles from the previous
    // run must never swallow a steer or a settle).
    this.leaderStdin = undefined;
    this.promptError = undefined;
    const leaderThinkingLevel = splitModelThinking(team.leader.model).thinkingLevel;
    const progress: RunProgress = {
      runId,
      team: team.name,
      task,
      startedAtMs,
      // 声明值进 progress：live leader 的展示口径需要 provider 前缀与
      // 子进程实际上报的裸 id 组合（viewer/status 归一在展示层做）。
      ...(team.leader.model ? { leaderDeclaredModel: team.leader.model } : {}),
      ...(leaderThinkingLevel ? { leaderThinkingLevel } : {}),
      members: team.members.map((m) => {
        const declaredThinking = splitModelThinking(m.model).thinkingLevel;
        return {
          name: m.name,
          status: "queued" as const,
          // 声明模型进 progress：viewer 头部要显示每个成员的后端模型，
          // 不能每次 750ms 刷新都去扫盘重读团队文件。
          ...(m.model ? { model: m.model } : {}),
          ...(declaredThinking ? { thinkingLevel: declaredThinking } : {}),
        };
      }),
      budget: (() => {
        const b = resolveRunBudget(team.budget);
        return {
          maxDispatchCalls: b.maxDispatchCalls,
          maxMemberRuns: b.maxMemberRuns,
          maxCostUsd: b.maxCostUsd,
          maxTotalTokens: b.maxTotalTokens,
          spentCost: 0,
          spentTokens: 0,
          dispatchCalls: 0,
          memberRuns: 0,
        };
      })(),
    };
    this.currentProgress = progress;
    // Crash-recovery snapshot: a running status.json on disk means the next
    // session can reconcile this run if this session dies mid-run.
    this.persistRunStatus({ runId, team: team.name, task, startedAt, status: "running", now });
    if (options.signal) {
      if (options.signal.aborted) controller.abort();
      else options.signal.addEventListener("abort", () => controller.abort(), { once: true });
    }
    const run = this.runActive(controller, options, { now, nowMs, runId, startedAt, startedAtMs, progress });
    this.pending = run;
    return run;
  }

  /**
   * The spawn-and-wait half of start(), running under the claimed
   * controller. Resolves with the terminal record; the finally block
   * releases the claim and drops the stale progress so status queries land
   * on the terminal record instead of a phantom "running".
   */
  private async runActive(controller: AbortController, options: StartOptions, plan: RunPlan): Promise<StartRunResult> {
    const { team, task } = options;
    const { now, nowMs, runId, startedAt, startedAtMs, progress } = plan;
    const git = this.deps.gitRunner ?? defaultGitRunner();
    const baseCwd = this.deps.cwd();

    // Leader transcript artifacts (best-effort; read back by /team:view and
    // the team_transcript tool). Member transcripts are written by the
    // leader process itself — both sides share the run dir. Hoisted above
    // the try so the catch can always report (pre-flight failures have no
    // transcript yet and silently no-op inside recordTranscript).
    let transcript: FileTranscriptSink | undefined;
    const recordTranscript = (kind: TranscriptEntryKind, text: string): void => {
      if (!transcript) return;
      try {
        transcript.append(LEADER_ACTOR, kind, text);
      } catch {
        /* transcript failures never break the run */
      }
    };
    // Terminal status.json rewrite on every exit path — no exit may leave a
    // stale "running" on disk (session_start reconcile depends on it). The
    // leader PID is carried into the terminal snapshot for orphan diagnostics.
    let leaderPid: number | undefined;
    const writeTerminal = (status: RunStatus, error?: string): void =>
      this.persistRunStatus({ runId, team: team.name, task, startedAt, status, ...(error !== undefined ? { error } : {}), ...(leaderPid !== undefined ? { leaderPid } : {}), now });

    // Budget accounting: leader turns are cumulative (event.usage), member
    // dispatches accumulate per tool_execution_end (details.totalUsage).
    // Cap breaches abort the run (children killed) and mark the terminal
    // record aborted + BUDGET_EXCEEDED.
    let leaderCost = 0;
    let leaderTokens = 0;
    let memberCost = 0;
    let memberTokens = 0;
    let budgetExceededReason: string | undefined;
    const foldBudget = () => {
      const b = progress.budget;
      if (!b) return;
      b.spentCost = Math.round((leaderCost + memberCost) * 1e6) / 1e6;
      b.spentTokens = leaderTokens + memberTokens;
    };
    const checkBudgetCap = () => {
      const b = progress.budget;
      if (!b || budgetExceededReason !== undefined) return;
      const maxCost = b.maxCostUsd;
      const maxTokens = b.maxTotalTokens;
      const overCost = maxCost !== null && b.spentCost > maxCost;
      const overTokens = maxTokens !== null && b.spentTokens > maxTokens;
      if (!overCost && !overTokens) return;
      budgetExceededReason = overCost
        ? `BUDGET_EXCEEDED: 累计费用 $${b.spentCost.toFixed(4)} 超过预算上限 $${maxCost.toFixed(2)}，run 已自动中止`
        : `BUDGET_EXCEEDED: 累计 tokens ${b.spentTokens} 超过预算上限 ${maxTokens}，run 已自动中止`;
      controller.abort();
    };
    let stopTicker: (() => void) | undefined;

    try {
      // Pre-flight: worktree requirements must be satisfiable BEFORE spawning
      // anything (environmental errors are otherwise invisible mid-run).
      const needsWorktree = team.worktree === true || team.members.some((m) => m.worktree === true);
      let sharedWorktree: { path: string; branch: string } | undefined;
      if (needsWorktree) {
        if (!(await isGitRepo(git, baseCwd))) {
          const message = `预检失败：团队或成员配置了 worktree 隔离，但 "${baseCwd}" 不是 git 仓库。请在 git 仓库中运行，或去掉团队/成员的 worktree 配置。`;
          writeTerminal("failed", message);
          return {
            ok: false,
            code: "WORKTREE_UNAVAILABLE",
            message,
          };
        }
        if (team.worktree) {
          const created = await createWorktree({
            git,
            repoCwd: baseCwd,
            worktreePath: path.join(this.deps.worktreeRoot, runId, "team"),
            branch: teamWorktreeBranch(runId),
          });
          if (!created.ok) {
            const message = `预检失败：创建团队共享 worktree 失败 — ${created.message}`;
            writeTerminal("failed", message);
            return { ok: false, code: created.code, message };
          }
          sharedWorktree = created.value;
        }
      }

      transcript = this.deps.transcriptRoot
        ? new FileTranscriptSink(this.deps.transcriptRoot, runId, now)
        : undefined;
      recordTranscript("task", task);

      const render = () => {
        try {
          options.onProgress?.(progress);
        } catch {
          /* observer failures never break the run */
        }
      };

      const onEvent = (event: ChildEvent) => {
        if (event.type === "message_end" && event.role === "assistant") {
          if (event.fullText) recordTranscript("assistant", event.fullText);
          if (event.usage) {
            progress.leaderNote = `turn ${event.usage.turns}`;
            // event.usage is the leader's cumulative usage (runner folds it).
            leaderCost = event.usage.cost;
            leaderTokens = event.usage.input + event.usage.output;
            foldBudget();
            checkBudgetCap();
          }
          if (event.model) progress.leaderModel = event.model;
          if (event.thinkingLevel) progress.leaderThinkingLevel = event.thinkingLevel;
          if (event.text) progress.leaderActivity = event.text;
          render();
          return;
        }
        if (event.type === "tool_execution_start") {
          // Transcript keeps every leader tool call; progress only tracks dispatch.
          recordTranscript("tool", toolCallText(event.toolName, event.args));
          if (event.toolName !== "team_dispatch") return;
          const tasks = (event.args as { tasks?: Array<{ agent?: string; task?: string }> } | undefined)?.tasks;
          const b = progress.budget;
          if (b) {
            b.dispatchCalls += 1;
            b.memberRuns += Array.isArray(tasks) ? tasks.length : 0;
          }
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
          const totalUsage = parseDispatchTotalUsage(event.details);
          if (totalUsage) {
            memberCost += totalUsage.cost;
            memberTokens += totalUsage.input + totalUsage.output;
            foldBudget();
            checkBudgetCap();
          }
          const members = parseDispatchMemberResults(event.details);
          if (members) {
            for (const member of members) {
              const existing = progress.members.find((m) => m.name === member.name);
              const next: MemberProgress = {
                name: member.name,
                status: member.status,
                // 实际上报值（子进程 message_end）取代声明 id，但保留声明的
                // provider 前缀（口径归一，与终态/leader 一致）；思考级别同源。
                ...(member.usage?.model ? { model: resolveModelCaliber(existing?.model, member.usage.model) } : {}),
                ...(member.usage?.thinkingLevel ? { thinkingLevel: member.usage.thinkingLevel } : {}),
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
      // RPC mode (not `json -p`): the leader keeps its stdin open while it
      // runs, which is the channel steering (viewer mid-run messages) and
      // clean shutdown use. The task travels as the initial `prompt` command
      // (not argv) and the run ends when `agent_settled` closes stdin.
      const args: string[] = ["--mode", "rpc", "--no-session"];
      if (team.leader.model) args.push("--model", team.leader.model);
      if (team.leader.tools && team.leader.tools.length > 0) args.push("--tools", team.leader.tools.join(","));
      if (this.deps.extensionEntryPath) args.push("-e", this.deps.extensionEntryPath);
      args.push("--exclude-tools", DERIVED_AGENT_TOOL_DENYLIST.join(","));
      args.push("--append-system-prompt", `team-tmp://${leaderPrompt}`);

      const invocation = this.deps.piCommand ? { command: this.deps.piCommand, args } : getPiInvocation(args);
      const leaderCwd = sharedWorktree?.path ?? baseCwd;

      // 1s progress ticker (onProgress observers; the widget repaints on its
      // own tick), aligned to the shared wall-clock second (status-bar contract).
      stopTicker = startAlignedTicker(render, { intervalMs: 1000 });

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
        // The leader's RPC channel needs a live stdin pipe (prompt below,
        // closed at settle) — members never do, so they keep the default.
        stdin: "pipe",
        signal: controller.signal,
        killGraceMs: this.deps.killGraceMs,
        onEvent,
        // The PID lands in the running snapshot as soon as the OS assigns
        // it — an orphaned leader is diagnosable after a crash.
        onSpawn: (pid) => {
          if (pid === undefined) return;
          leaderPid = pid;
          this.persistRunStatus({ runId, team: team.name, task, startedAt, status: "running", leaderPid: pid, now });
        },
        // RPC channel: send the task once the child exists …
        onChild: (child) => {
          this.leaderStdin = child.stdin;
          try {
            child.stdin?.write(`${JSON.stringify({ type: "prompt", id: "task", message: `Task: ${task}` })}\n`);
          } catch {
            /* the spawn/exit path settles this run */
          }
        },
        // … and close stdin at settle (or prompt rejection) so the RPC
        // process exits — it only ever returns on stdin end.
        onWire: (message) => {
          if (message.type === "agent_settled") {
            this.closeLeaderStdin();
            return;
          }
          if (message.command === "prompt" && message.success === false) {
            this.promptError =
              typeof message.error === "string" ? message.error : "pi rejected the leader prompt";
            this.closeLeaderStdin();
          }
        },
      });

      const aborted = controller.signal.aborted;
      const failed =
        !aborted &&
        (outcome.exitCode !== 0 || outcome.stopReason === "error" || !!outcome.errorMessage || !!this.promptError);

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
      // Aborted runs: fold every roster member that never produced a
      // dispatch result (queued at abort, or dispatched-but-still-running)
      // into the record as "aborted" — without this the terminal record
      // silently drops everyone the leader hadn't finished with and the
      // widget/status rows under-report the team.
      if (aborted) {
        const covered = new Set(members.map((m) => m.name));
        for (const member of progress.members) {
          if (covered.has(member.name)) continue;
          if (member.status === "queued" || member.status === "running") {
            const config = team.members.find((c) => c.name === member.name);
            members.push({ name: member.name, model: config?.model, status: "aborted" });
          }
        }
      }

      // 终态 leader 思考级别：实际事件最后值优先，无实际上报时回退声明后缀。
      const terminalLeaderThinking = progress.leaderThinkingLevel ?? splitModelThinking(team.leader.model).thinkingLevel;
      const record: TeamRunRecord = {
        runId,
        team: team.name,
        task,
        startedAt,
        status: aborted ? "aborted" : failed ? "failed" : "completed",
        ...(failed
          ? {
              error: truncateUtf8(
                outcome.errorMessage ||
                  this.promptError ||
                  outcome.stderr ||
                  `pi exited with code ${outcome.exitCode}`,
                2000,
              ),
            }
          : {}),
        ...(aborted && budgetExceededReason !== undefined ? { error: budgetExceededReason } : {}),
        report: outcome.finalText ? truncateUtf8(outcome.finalText, MAX_RESULT_BYTES) : undefined,
        members,
        leaderUsage: outcome.usage,
        ...(team.leader.model ? { leaderDeclaredModel: team.leader.model } : {}),
        ...(terminalLeaderThinking ? { leaderThinkingLevel: terminalLeaderThinking } : {}),
        totalCost: outcome.usage.cost,
        totalTokens: outcome.usage.input + outcome.usage.output,
        durationMs: nowMs() - startedAtMs,
        ...(sharedWorktree ? { worktree: sharedWorktree } : {}),
      };
      const runStatus = aborted ? "aborted" : failed ? "failed" : "completed";
      recordTranscript("system", `run ${runStatus} · ${Math.round((record.durationMs ?? 0) / 100) / 10}s · $${record.totalCost.toFixed(4)}`);
      if (record.error) recordTranscript("error", record.error);
      writeTerminal(record.status, record.error);
      this.lastRecord = record;
      return { ok: true, value: record };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      recordTranscript("error", `CHILD_FAILED: failed to start leader process: ${message}`);
      writeTerminal("failed", `failed to start leader process: ${message}`);
      return { ok: false, code: "CHILD_FAILED", message: `failed to start leader process: ${message}` };
    } finally {
      this.closeLeaderStdin();
      this.promptError = undefined;
      this.active = null;
      this.pending = null;
      this.currentProgress = null;
      if (stopTicker !== undefined) stopTicker();
    }
  }
}
