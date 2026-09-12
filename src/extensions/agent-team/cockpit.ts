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

import * as fs from "node:fs";
import * as path from "node:path";
import { archiveRunRecords } from "./archive.ts";
import { startAlignedTicker } from "./aligned-ticker.ts";
import { AskChannel, outcomeEntryText, questionEntryText, type AskPort } from "./ask.ts";
import { splitModelThinking } from "./config.ts";
import { defaultSpawn, getPiInvocation, runChildPi } from "./runner.ts";
import { parseDispatchMemberResults, parseDispatchTotalUsage, stripRunScopedEnv } from "./dispatch.ts";
import { buildLeaderSystemPrompt } from "./leader-prompt.ts";
import { resolveModelCaliber } from "./model-caliber.ts";
import {
  parentWorktreeSpec,
  readSessionHeaderCwd,
  resolveEffectiveTeam,
  resolveLeaderSessionFile,
  type ModelOverrides,
} from "./resume.ts";
import { fileRunStore, RUN_STATUS_VERSION, type RunStatusFile, type RunStoreWriter } from "./runstore.ts";
import { FileTranscriptSink, LEADER_ACTOR, transcriptRunDir, type TranscriptEntryKind } from "./transcript.ts";
import {
  createWorktree,
  defaultGitRunner,
  isGitRepo,
  restoreWorktree,
  teamWorktreeBranch,
  type GitRunner,
} from "./worktree.ts";
import {
  DERIVED_AGENT_TOOL_DENYLIST,
  LEADER_ENV_FILE,
  LEADER_ENV_MEMBER_MODELS,
  LEADER_ENV_NAME,
  LEADER_ENV_RUNID,
  LEADER_ENV_WORKTREE_RUNID,
  MAX_CONCURRENT_TEAM_RUNS,
  MAX_RESULT_BYTES,
  MAX_RETAINED_RUN_RECORDS,
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
  /** Test seam: backstop margin over a leader question's timeout (default 5000ms). */
  askBackstopMarginMs?: number;
}

export type StartRunResult =
  | { ok: true; value: TeamRunRecord }
  | { ok: false; code: TeamErrorCode; message: string; record?: TeamRunRecord };

/**
 * Minimal failed record for launch-level failures (worktree pre-flight,
 * worktree creation, leader spawn error) — no member dispatch happened yet,
 * so the record carries the error only. Written to lastRecord so
 * /team:status and the viewer can look the failure up after the fact, and
 * delivered to the main session by the background dispatch path.
 */
export function failedRunRecord(input: {
  runId: string;
  team: string;
  task: string;
  startedAt: string;
  error: string;
  durationMs?: number;
}): TeamRunRecord {
  return {
    runId: input.runId,
    team: input.team,
    task: input.task,
    startedAt: input.startedAt,
    status: "failed",
    error: input.error,
    members: [],
    totalCost: 0,
    totalTokens: 0,
    ...(input.durationMs !== undefined ? { durationMs: input.durationMs } : {}),
  };
}

/** Input of one team run (spawned leader + member dispatch). */
interface StartOptions {
  team: TeamConfig;
  task: string;
  ui: UiPort;
  /** Main-session dialog port for leader questions (absent = fail-closed). */
  ask?: AskPort;
  onProgress?: (progress: RunProgress) => void;
  signal?: AbortSignal;
  /** Resume context (`team_resume`): open the parent leader session. */
  resume?: ResumeContext;
}

/**
 * Resume wiring: which parent run to continue, where its leader session
 * lives, and the per-run model overrides to apply (leader + members). The
 * conversation itself is the context — no summary is handed to the leader.
 */
export interface ResumeContext {
  parentRunId: string;
  parentStatus: RunStatusFile;
  /** Absolute path of the parent leader session file to open. */
  sessionFile: string;
  modelOverrides?: ModelOverrides;
}

/** Pre-computed run identity handed from start() to runActive(). */
interface RunPlan {
  /** Effective team for this run (resume model overrides already applied). */
  team: TeamConfig;
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

/**
 * Immutable snapshot of the live runs plus recent terminal records (status
 * queries, the below-editor widget and the viewer all read this shape).
 * `running`/`progress`/`lastRecord` are the single-run compatibility fields:
 * with at most one active run their values are exactly the v1.21.0 ones.
 */
export interface RunStatusSnapshot {
  /** Compatibility field: equivalent to actives.length > 0. */
  running: boolean;
  /** Compatibility field: newest active run's progress; null with none active. */
  progress: RunProgress | null;
  /** Compatibility field: records[0] ?? null (newest terminal record). */
  lastRecord: TeamRunRecord | null;
  /** Every active run's progress, oldest first (startedAtMs). */
  actives: RunProgress[];
  /** Recent terminal records, newest first, at most MAX_RETAINED_RUN_RECORDS. */
  records: TeamRunRecord[];
}

/**
 * One in-flight run's mutable state — the v1.21.0 singleton fields, per run:
 * its abort controller, settle promise, live progress, leader RPC channel and
 * prompt-rejection flag. Progress events never cross handles: every closure
 * in runActive() captures the handle it was created for.
 */
interface RunHandle {
  controller: AbortController;
  /** Resolves with the terminal record; set synchronously right after claim. */
  pending: Promise<StartRunResult> | undefined;
  progress: RunProgress;
  /** Leader RPC stdin (prompt/steer commands) — live only while this run runs. */
  leaderStdin: PiChildStdin | undefined;
  /** Set when pi rejects this run's initial prompt (no agent run, no settle event). */
  promptError: string | undefined;
}

/** 任务行显示上限（仅任务文本本身，不含 `任务: ` 前缀）：60 显示列。 */
const STATUS_TASK_MAX_WIDTH = 60;

/** Live leader activity shown while a question waits for the human. */
const ASK_ACTIVITY_MAX_WIDTH = 80;

/** 任务文本：先压平换行，再按显示宽度截断（CJK 双宽，超宽补 `…`）。 */
function statusTaskText(task: string): string {
  return truncateVisible(flattenText(task), STATUS_TASK_MAX_WIDTH);
}

/**
 * Formats a status snapshot for /team:status and the team_status tool.
 * A live runId argument pins the single-run format (the caller already
 * resolved the target through getStatus(runId)); without one, several
 * active runs render as one `── run …` section per run and an idle session
 * appends the recent-records tail. With at most one active run the output
 * is byte-identical to v1.21.0.
 */
export function formatStatusSnapshot(
  snapshot: RunStatusSnapshot,
  nowMs: number,
  dim?: (t: string) => string,
  runId?: string,
): string {
  const line = (t: string): string => (dim ? dim(t) : t);
  const icon = (status: string): string =>
    status === "done" || status === "completed" ? "✓" : status === "failed" ? "✗" : status === "aborted" ? "⊘" : status === "running" ? "▶" : "…";

  /** Task/leader/budget/member rows shared by the single- and multi-run blocks. */
  const runningBody = (p: RunProgress): string[] => {
    const lines: string[] = [line(`任务: ${statusTaskText(p.task)}`.trimEnd())];
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
    return lines;
  };

  const actives = snapshot.actives.length > 0 ? snapshot.actives : snapshot.progress ? [snapshot.progress] : [];
  if (snapshot.running && snapshot.progress && runId === undefined && actives.length >= 2) {
    const lines: string[] = [line(`当前共 ${actives.length} 个 run 并行（上限 ${MAX_CONCURRENT_TEAM_RUNS}）：`)];
    for (const p of actives) {
      const lineage = p.parentRunId ? `（续跑自 ${p.parentRunId}）` : "";
      lines.push(line(`── run ${p.runId} · team ${p.team} ▶ running · ${elapsedLabel(p.startedAtMs, nowMs)}${lineage}`));
      lines.push(...runningBody(p));
    }
    return lines.join("\n");
  }

  if (snapshot.running && snapshot.progress) {
    const p = snapshot.progress;
    const lineage = p.parentRunId ? `（续跑自 ${p.parentRunId}）` : "";
    return [
      line(`当前 run：team ${p.team} ▶ running · ${elapsedLabel(p.startedAtMs, nowMs)}`),
      line(`runId: ${p.runId}${lineage}`),
      ...runningBody(p),
    ].join("\n");
  }

  const record = snapshot.lastRecord;
  if (record) {
    const secs = record.durationMs !== undefined ? ` · ${Math.round(record.durationMs / 100) / 10}s` : "";
    const cost = record.totalCost > 0 ? ` · $${record.totalCost.toFixed(4)}` : "";
    const lines = [
      line(`最近一次 run：team ${record.team} ${icon(record.status)} ${record.status}${secs}${cost}`),
      line(`runId: ${record.runId}${record.parentRunId ? `（续跑自 ${record.parentRunId}）` : ""}`),
      line(`任务: ${statusTaskText(record.task)}`.trimEnd()),
    ];
    if (record.error) lines.push(line(`错误: ${record.error}`));
    if ((record.status === "failed" || record.status === "aborted") && record.leaderSessionFile) {
      lines.push(line(`可用 team_resume ${record.runId} 续跑（可换模型）`));
    }
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
    // Default view (no runId pinned): surface the older retained records so
    // /team:status can point at a specific runId instead of hiding history.
    if (runId === undefined && snapshot.records.length > 1) {
      const recent = snapshot.records
        .slice(1, 1 + MAX_RETAINED_RUN_RECORDS - 1)
        .map((r) => `${r.runId} ${icon(r.status)}${r.status}`);
      lines.push(line(`近期 run：${recent.join(" · ")}（最多再列 ${MAX_RETAINED_RUN_RECORDS - 1} 条；/team:status <runId> 查看详情）`));
    }
    return lines.join("\n");
  }

  return "当前没有 team run 记录。用 /team:run <团队> <任务> 或 team_run 工具派单。";
}

/**
 * 终态归档：把该 run 的记录复制到主工作区 `history/team-runs/<runId>/`
 * （worktree 记录会随 run worktree 被删，见 archive.ts 根因说明）。冲突与失败
 * 只发 warning 诊断，绝不影响终态、绝不抛异常；扫描源期间记录尚未落盘或已被
 * 移除都只是正常空操作。
 */
function archiveTerminalRun(deps: CoordinatorDeps, runId: string, ui: UiPort): void {
  try {
    const result = archiveRunRecords({
      runId,
      baseCwd: deps.cwd(),
      worktreeRunRoot: path.join(deps.worktreeRoot, runId),
    });
    const diagnostics = [...result.failures, ...result.conflicts];
    if (diagnostics.length === 0) return;
    try {
      ui.notify(`run ${runId} 记录归档诊断：\n${diagnostics.join("\n")}`, "warning");
    } catch {
      /* notify failures never break the run */
    }
  } catch {
    /* archiving must never break a run */
  }
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
  /** Active runs keyed by runId (claimed before any await; released in finally). */
  private readonly runs = new Map<string, RunHandle>();
  /** Recent terminal records, newest first, bounded by MAX_RETAINED_RUN_RECORDS. */
  private records: TeamRunRecord[] = [];

  constructor(deps: CoordinatorDeps) {
    this.deps = deps;
    this.runStore = deps.runStore ?? (deps.transcriptRoot ? fileRunStore(deps.transcriptRoot) : undefined);
  }

  isRunning(): boolean {
    return this.runs.size > 0;
  }

  /** runIds of every active run, oldest first (startedAtMs, then runId). */
  activeRunIds(): string[] {
    return this.activeProgress().map((progress) => progress.runId);
  }

  /** True while the run with this runId is claimed (spawn pending or in flight). */
  isRunActive(runId: string): boolean {
    return this.runs.has(runId);
  }

  /** Terminal status of a recent record, or null when the runId is unknown. */
  terminalStatus(runId: string): string | null {
    return this.records.find((record) => record.runId === runId)?.status ?? null;
  }

  private activeProgress(): RunProgress[] {
    return [...this.runs.values()]
      .map((handle) => handle.progress)
      .sort((a, b) => a.startedAtMs - b.startedAtMs || a.runId.localeCompare(b.runId));
  }

  /**
   * Aggregated snapshot (all active runs + recent records).
   */
  getStatus(): RunStatusSnapshot;
  /**
   * Target-run projection: an active run is projected alone, a recent
   * terminal record is looked up, and an unknown runId is null (callers
   * answer "没有找到" themselves).
   */
  getStatus(runId: string): RunStatusSnapshot | null;
  getStatus(runId?: string): RunStatusSnapshot | null {
    if (runId !== undefined) {
      const handle = this.runs.get(runId);
      if (handle) {
        return {
          running: true,
          progress: handle.progress,
          lastRecord: this.records[0] ?? null,
          actives: [handle.progress],
          records: this.records,
        };
      }
      const record = this.records.find((r) => r.runId === runId);
      if (record) {
        return { running: false, progress: null, lastRecord: record, actives: [], records: this.records };
      }
      return null;
    }
    const actives = this.activeProgress();
    return {
      running: actives.length > 0,
      progress: actives[actives.length - 1] ?? null,
      lastRecord: this.records[0] ?? null,
      actives,
      records: this.records,
    };
  }

  /** Restores a record after a reload / reconcile (dedupe, newest-first, cap). */
  restoreRecord(record: TeamRunRecord): void {
    this.pushRecord(record);
  }

  /** Dedupes by runId, orders newest-first (startedAt) and keeps the newest 5. */
  private pushRecord(record: TeamRunRecord): void {
    const rest = this.records.filter((r) => r.runId !== record.runId);
    this.records = [record, ...rest]
      .sort((a, b) => (b.startedAt ?? "").localeCompare(a.startedAt ?? ""))
      .slice(0, MAX_RETAINED_RUN_RECORDS);
  }

  /** Aborts every active run (session_shutdown); returns how many were stopped. */
  stop(): number {
    let stopped = 0;
    for (const handle of this.runs.values()) {
      handle.controller.abort();
      stopped += 1;
    }
    return stopped;
  }

  /**
   * Aborts one run without waiting for settle (the /team:stop command path);
   * returns false when the runId is not active.
   */
  stopRun(runId: string): boolean {
    const handle = this.runs.get(runId);
    if (!handle) return false;
    handle.controller.abort();
    return true;
  }

  /**
   * Injects a user message into the given run's leader (RPC `steer`): pi hands
   * it to the agent at the next turn boundary — the current task is not
   * interrupted. Returns false when the run is unknown or its stdin channel is
   * not live (no active run / spawn pending / write failure) so callers fall
   * back to queue semantics instead.
   */
  steerLeader(runId: string, message: string): boolean {
    const handle = this.runs.get(runId);
    if (!handle || !handle.leaderStdin) return false;
    try {
      handle.leaderStdin.write(`${JSON.stringify({ type: "steer", message })}\n`);
      return true;
    } catch {
      return false;
    }
  }

  /** Ends this run's leader stdin — RPC mode exits its process when stdin ends. */
  private closeLeaderStdin(handle: RunHandle): void {
    const stdin = handle.leaderStdin;
    handle.leaderStdin = undefined;
    try {
      stdin?.end();
    } catch {
      /* the run settles via the child's close event regardless */
    }
  }

  /**
   * Aborts the targeted run and waits (bounded) for it to settle into its
   * terminal record — the same primitive the team_stop tool and the viewer
   * stop path share. settled:false means the abort signal was sent but the
   * children are still shutting down; never an error by itself, the run's
   * promise keeps resolving in the background (with the terminal record
   * landing on records[]). Unknown runId → wasRunning:false (nothing to do).
   */
  async stopAndSettle(
    runId: string,
    timeoutMs: number = STOP_SETTLE_TIMEOUT_MS,
  ): Promise<{ wasRunning: boolean; settled: boolean; record: TeamRunRecord | null }> {
    const handle = this.runs.get(runId);
    if (!handle) {
      return { wasRunning: false, settled: true, record: null };
    }
    handle.controller.abort();
    const run = handle.pending;
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

  /**
   * Allocates a process-unique runId. `run-<ms>` repeats when two dispatches
   * land in the same millisecond (now genuinely reachable with parallel
   * runs), so an occupied id (another handle, a retained record, or a
   * `runsRoot/<runId>` directory from an earlier session) falls through to
   * `run-<ms>-2`, `-3`, … Filesystem probing is best-effort: a failing stat
   * degrades to the in-memory check.
   */
  private allocateRunId(nowMs: () => number): string {
    const base = `run-${nowMs()}`;
    const taken = (candidate: string): boolean => {
      if (this.runs.has(candidate)) return true;
      if (this.records.some((record) => record.runId === candidate)) return true;
      const root = this.deps.transcriptRoot;
      if (root === undefined) return false;
      try {
        return fs.existsSync(path.join(root, candidate));
      } catch {
        return false;
      }
    };
    if (!taken(base)) return base;
    let candidate = base;
    for (let n = 2; n <= 100; n++) {
      candidate = `${base}-${n}`;
      if (!taken(candidate)) return candidate;
    }
    return candidate;
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
    parentRunId?: string;
    leaderSessionFile?: string;
    worktree?: { path: string; branch: string };
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
        ...(input.parentRunId !== undefined ? { parentRunId: input.parentRunId } : {}),
        ...(input.leaderSessionFile !== undefined ? { leaderSessionFile: input.leaderSessionFile } : {}),
        ...(input.worktree !== undefined ? { worktree: input.worktree } : {}),
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
    const activeIds = this.activeRunIds();
    if (activeIds.length >= MAX_CONCURRENT_TEAM_RUNS) {
      return {
        ok: false,
        code: "RUN_IN_PROGRESS",
        message: `并发 team run 已达上限（${MAX_CONCURRENT_TEAM_RUNS}）：${activeIds.join("、")} 进行中；先 team_stop <runId> 或等任一结束。`,
      };
    }
    const { task } = options;
    // 续跑：把本次 run 的模型覆盖应用到团队副本（不改团队文件；不污染后续
    // team_run）。未知成员名忽略 + 告警——团队文件可能在失败后被改过。
    const effective = options.resume?.modelOverrides
      ? resolveEffectiveTeam(options.team, options.resume.modelOverrides)
      : { team: options.team, unknownMembers: [] };
    if (effective.unknownMembers.length > 0) {
      try {
        options.ui.notify(
          `续跑模型覆盖忽略未知成员：${effective.unknownMembers.join("、")}（团队花名册里没有这些成员）`,
          "warning",
        );
      } catch {
        /* observer failures never break the run */
      }
    }
    const team = effective.team;
    const now = this.deps.now ?? (() => new Date().toISOString());
    const nowMs = this.deps.nowMs ?? (() => Date.now());
    const runId = this.allocateRunId(nowMs);
    const startedAtMs = nowMs();
    // One claim-time timestamp for the whole run: running snapshot, spawn
    // refresh, terminal snapshot and terminal record all reuse it, so
    // elapsed = updatedAt - startedAt stays truthful after settle.
    const startedAt = now();
    // Claim the run BEFORE any await: concurrent starts can no longer
    // overrun the concurrency cap, stopAndSettle has a stable handle
    // (handle.pending), and team_run can read the runId right after start().
    const controller = new AbortController();
    const leaderThinkingLevel = splitModelThinking(team.leader.model).thinkingLevel;
    const progress: RunProgress = {
      runId,
      team: team.name,
      task,
      startedAtMs,
      ...(options.resume ? { parentRunId: options.resume.parentRunId } : {}),
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
    // Fresh RPC channel state per run (stale handles from another run must
    // never swallow a steer or a settle).
    const handle: RunHandle = {
      controller,
      pending: undefined,
      progress,
      leaderStdin: undefined,
      promptError: undefined,
    };
    this.runs.set(runId, handle);
    // Crash-recovery snapshot: a running status.json on disk means the next
    // session can reconcile this run if this session dies mid-run.
    this.persistRunStatus({
      runId,
      team: team.name,
      task,
      startedAt,
      status: "running",
      ...(options.resume ? { parentRunId: options.resume.parentRunId, leaderSessionFile: path.resolve(options.resume.sessionFile) } : {}),
      now,
    });
    if (options.signal) {
      if (options.signal.aborted) controller.abort();
      else options.signal.addEventListener("abort", () => controller.abort(), { once: true });
    }
    const run = this.runActive(handle, options, { team, now, nowMs, runId, startedAt, startedAtMs, progress });
    handle.pending = run;
    return run;
  }

  /**
   * The spawn-and-wait half of start(), running under the claimed handle.
   * Resolves with the terminal record; the finally block releases the claim
   * (runs.delete) so status queries land on the terminal record instead of a
   * phantom "running".
   */
  private async runActive(handle: RunHandle, options: StartOptions, plan: RunPlan): Promise<StartRunResult> {
    const controller = handle.controller;
    const { task } = options;
    const { now, nowMs, runId, startedAt, startedAtMs, progress } = plan;
    const team = plan.team;
    const resume = options.resume;
    const git = this.deps.gitRunner ?? defaultGitRunner();
    const baseCwd = this.deps.cwd();
    const parentRunId = resume?.parentRunId;
    /** Session dir of this run's own leader mirror (first runs only). */
    const ownSessionDir =
      this.deps.transcriptRoot !== undefined ? path.join(transcriptRunDir(this.deps.transcriptRoot, runId), "session") : undefined;
    // Resume inherits the opened file; a first run resolves its own mirror
    // from its session dir once the leader exited (best-effort).
    let leaderSessionFile = resume !== undefined ? path.resolve(resume.sessionFile) : undefined;
    // Team-level shared worktree, hoisted for every status snapshot/record.
    let sharedWorktree: { path: string; branch: string } | undefined;

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
    // leader PID is carried into the terminal snapshot for orphan diagnostics;
    // the resume lineage fields ride along on every write.
    let leaderPid: number | undefined;
    const lineageFields = (): {
      parentRunId?: string;
      leaderSessionFile?: string;
      worktree?: { path: string; branch: string };
    } => ({
      ...(parentRunId !== undefined ? { parentRunId } : {}),
      ...(leaderSessionFile !== undefined ? { leaderSessionFile } : {}),
      ...(sharedWorktree !== undefined ? { worktree: sharedWorktree } : {}),
    });
    // Leader → human questions: created once the transcript sink exists,
    // disposed on settle/abort (see the finally block).
    let askChannel: AskChannel | undefined;
    const writeTerminal = (status: RunStatus, error?: string): void =>
      this.persistRunStatus({
        runId,
        team: team.name,
        task,
        startedAt,
        status,
        ...(error !== undefined ? { error } : {}),
        ...(leaderPid !== undefined ? { leaderPid } : {}),
        ...lineageFields(),
        now,
      });
    // 终态单一出口：先落终态快照，再归档 run 记录（归档异常绝不影响终态；
    // 预检失败等无记录路径归档只是空操作）。
    const finish = (status: RunStatus, error?: string): void => {
      writeTerminal(status, error);
      archiveTerminalRun(this.deps, runId, options.ui);
    };
    // Minimal failed record for launches that die before any dispatch
    // (worktree pre-flight / createWorktree / spawn): keeps /team:status and
    // the viewer able to look the failure up, and lets the background
    // dispatch path deliver it to the main session.
    const writeFailedRecord = (error: string): TeamRunRecord => {
      const record = failedRunRecord({ runId, team: team.name, task, startedAt, error, durationMs: nowMs() - startedAtMs });
      this.pushRecord(record);
      return record;
    };

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
      if (needsWorktree) {
        if (!(await isGitRepo(git, baseCwd))) {
          const message = `预检失败：团队或成员配置了 worktree 隔离，但 "${baseCwd}" 不是 git 仓库。请在 git 仓库中运行，或去掉团队/成员的 worktree 配置。`;
          finish("failed", message);
          return {
            ok: false,
            code: "WORKTREE_UNAVAILABLE",
            message,
            record: writeFailedRecord(message),
          };
        }
        if (team.worktree) {
          // 续跑复用父 run 的共享树（记录字段优先，旧记录回退约定路径），
          // 不可恢复即硬失败——绝不静默新建，否则新 leader 会话的 cwd
          // 会与父会话记录的工作目录漂移。首跑行为不变（新建）。
          const spec = resume
            ? parentWorktreeSpec({
                status: resume.parentStatus,
                worktreeRoot: this.deps.worktreeRoot,
                runId: resume.parentRunId,
              })
            : { path: path.join(this.deps.worktreeRoot, runId, "team"), branch: teamWorktreeBranch(runId) };
          const created = resume
            ? await restoreWorktree({ git, repoCwd: baseCwd, worktreePath: spec.path, branch: spec.branch })
            : await createWorktree({ git, repoCwd: baseCwd, worktreePath: spec.path, branch: spec.branch });
          if (!created.ok) {
            const message = resume
              ? `续跑失败：无法恢复父 run 的共享 worktree — ${created.message}`
              : `预检失败：创建团队共享 worktree 失败 — ${created.message}`;
            finish("failed", message);
            return { ok: false, code: created.code, message, record: writeFailedRecord(message) };
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

      // Leader questions (RPC dialogs): presented in the main session, the
      // answer travels back over the same stdin channel steer uses. Every
      // failure path is bounded (timeout / abort / no UI) — the run never
      // waits forever on a human.
      askChannel = new AskChannel({
        port: options.ask,
        write: (line) => handle.leaderStdin?.write(line),
        signal: controller.signal,
        backstopMarginMs: this.deps.askBackstopMarginMs,
        onQuestion: (request) => {
          recordTranscript("question", questionEntryText(request));
          progress.leaderActivity = `等待人工回答：${truncateVisible(flattenText(request.title), ASK_ACTIVITY_MAX_WIDTH)}`;
          render();
        },
        onOutcome: (_request, outcome) => {
          const entry = outcomeEntryText(outcome);
          recordTranscript(entry.kind, entry.text);
          progress.leaderActivity = outcome.kind === "answer" ? "已收到回答，leader 继续" : "未获回答，leader 继续";
          render();
        },
      });

      const onEvent = (event: ChildEvent) => {
        if (event.type === "message_end" && event.role === "assistant") {
          // Leader 阶段：assistant 消息落地 = 思考/等待下一个事件（v1.17.0 活动行）。
          progress.leaderPhase = "waiting";
          delete progress.leaderToolName;
          progress.leaderLastEventAtMs = nowMs();
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
          // Leader 阶段：进入工具调用（工具名供 viewer 活动行显示）。
          progress.leaderPhase = "tool";
          progress.leaderToolName = event.toolName;
          progress.leaderLastEventAtMs = nowMs();
          // Transcript keeps every leader tool call; progress only tracks dispatch.
          recordTranscript("tool", toolCallText(event.toolName, event.args));
          if (event.toolName !== "team_dispatch") {
            // 普通工具的起止也改变 leader 活动阶段：必须刷新观察者。
            render();
            return;
          }
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
        if (event.type === "tool_execution_update") {
          // 工具流式输出：只刷新时间；team_dispatch 的进度载荷带成员活动，
          // 按名字折入 progress.members（viewer 成员活动行数据源，v1.17.0）。
          progress.leaderLastEventAtMs = nowMs();
          if (event.toolName === "team_dispatch") {
            const members = parseDispatchMemberResults(event.details);
            if (members) {
              for (const member of members) {
                const existing = progress.members.find((m) => m.name === member.name);
                if (!existing) continue;
                existing.status = member.status;
                if (member.note !== undefined) existing.note = member.note;
                if (member.latest !== undefined) existing.latest = member.latest;
                if (member.phase !== undefined) existing.phase = member.phase;
                if (member.toolName !== undefined) existing.toolName = member.toolName;
                else delete existing.toolName;
                if (member.lastActivityAtMs !== undefined) existing.lastActivityAtMs = member.lastActivityAtMs;
              }
            }
          }
          render();
          return;
        }
        if (event.type === "tool_execution_end") {
          // Leader 阶段：工具结束 = 思考中（活动行显式回 waiting）。
          progress.leaderPhase = "waiting";
          delete progress.leaderToolName;
          progress.leaderLastEventAtMs = nowMs();
          recordTranscript("tool", toolResultText(event.toolName, event.text));
          if (event.toolName !== "team_dispatch") {
            render();
            return;
          }
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
      //
      // Session persistence: every leader run keeps its conversation on disk.
      // A first run opens a fresh session in the run dir; a resume opens the
      // parent leader session file directly (pi appends to it — no fork).
      const args: string[] = ["--mode", "rpc"];
      if (resume) {
        args.push("--session", path.resolve(resume.sessionFile));
      } else if (ownSessionDir) {
        args.push("--session-dir", ownSessionDir);
      } else {
        args.push("--no-session");
      }
      if (team.leader.model) args.push("--model", team.leader.model);
      if (team.leader.tools && team.leader.tools.length > 0) args.push("--tools", team.leader.tools.join(","));
      if (this.deps.extensionEntryPath) args.push("-e", this.deps.extensionEntryPath);
      args.push("--exclude-tools", DERIVED_AGENT_TOOL_DENYLIST.join(","));
      args.push("--append-system-prompt", `team-tmp://${leaderPrompt}`);

      const invocation = this.deps.piCommand ? { command: this.deps.piCommand, args } : getPiInvocation(args);
      // Resume without a shared worktree: run where the parent leader ran
      // (its session header cwd) so member dispatch directories never drift.
      const leaderCwd = sharedWorktree?.path ?? (resume ? (readSessionHeaderCwd(resume.sessionFile) ?? baseCwd) : baseCwd);

      // Keep the resumed lineage's session dir fresh so the 7-day run-artifact
      // retention cannot prune a session that is being continued right now.
      if (resume) {
        try {
          const sessionDir = path.dirname(path.resolve(resume.sessionFile));
          const touched = new Date(nowMs());
          fs.utimesSync(sessionDir, touched, touched);
        } catch {
          /* retention refresh is best-effort */
        }
      }

      // 1s progress ticker (onProgress observers; the widget repaints on its
      // own tick), aligned to the shared wall-clock second (status-bar contract).
      stopTicker = startAlignedTicker(render, { intervalMs: 1000 });

      // 继承父进程环境（PATH、provider key 等），只剥 run 级键，再叠加本次 run 三键。
      const leaderEnv: NodeJS.ProcessEnv = stripRunScopedEnv();
      leaderEnv[LEADER_ENV_FILE] = team.filePath;
      leaderEnv[LEADER_ENV_NAME] = team.name;
      leaderEnv[LEADER_ENV_RUNID] = runId;
      if (resume) {
        // Member worktrees alias to the parent run (same on-disk trees) and
        // the member-model overrides travel to the leader's dispatch executor.
        leaderEnv[LEADER_ENV_WORKTREE_RUNID] = resume.parentRunId;
        const overrides = resume.modelOverrides?.memberModels ?? {};
        const known = Object.fromEntries(
          Object.entries(overrides).filter(([name]) => team.members.some((member) => member.name === name)),
        );
        if (Object.keys(known).length > 0) leaderEnv[LEADER_ENV_MEMBER_MODELS] = JSON.stringify(known);
      }

      const outcome = await runChildPi({
        command: invocation.command,
        args: invocation.args,
        cwd: leaderCwd,
        env: leaderEnv,
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
          this.persistRunStatus({
            runId,
            team: team.name,
            task,
            startedAt,
            status: "running",
            leaderPid: pid,
            ...lineageFields(),
            now,
          });
        },
        // RPC channel: send the task once the child exists …
        onChild: (child) => {
          handle.leaderStdin = child.stdin;
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
            // Leader is exiting: drop any in-flight question and close stdin
            // (RPC exits only on stdin end).
            askChannel?.dispose();
            this.closeLeaderStdin(handle);
            return;
          }
          if (message.command === "prompt" && message.success === false) {
            handle.promptError =
              typeof message.error === "string" ? message.error : "pi rejected the leader prompt";
            askChannel?.dispose();
            this.closeLeaderStdin(handle);
            return;
          }
          // Dialog requests (extension_ui_request) are bridged to the main
          // session; everything else stays tolerated-and-ignored.
          askChannel?.handle(message);
        },
      });

      const aborted = controller.signal.aborted;
      const failed =
        !aborted &&
        (outcome.exitCode !== 0 || outcome.stopReason === "error" || !!outcome.errorMessage || !!handle.promptError);

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
      // 首跑：leader 退出后从自己的 session 目录解析会话镜像（唯一/最新一个；
      // 解析失败只跳过——不能因此毁掉 run）。续跑直接沿用打开的文件。
      if (leaderSessionFile === undefined && ownSessionDir !== undefined) {
        leaderSessionFile = resolveLeaderSessionFile(ownSessionDir) ?? undefined;
      }
      const record: TeamRunRecord = {
        runId,
        team: team.name,
        task,
        startedAt,
        status: aborted ? "aborted" : failed ? "failed" : "completed",
        ...(parentRunId !== undefined ? { parentRunId } : {}),
        ...(leaderSessionFile !== undefined ? { leaderSessionFile } : {}),
        ...(failed
          ? {
              error: truncateUtf8(
                outcome.errorMessage ||
                  handle.promptError ||
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
      finish(record.status, record.error);
      this.pushRecord(record);
      return { ok: true, value: record };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      const error = `failed to start leader process: ${message}`;
      recordTranscript("error", `CHILD_FAILED: ${error}`);
      finish("failed", error);
      return { ok: false, code: "CHILD_FAILED", message: error, record: writeFailedRecord(error) };
    } finally {
      askChannel?.dispose();
      this.closeLeaderStdin(handle);
      handle.promptError = undefined;
      this.runs.delete(runId);
      if (stopTicker !== undefined) stopTicker();
    }
  }
}
