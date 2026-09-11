/**
 * agent-team — shared contracts
 *
 * A team is a persistent, reusable Markdown definition file (frontmatter:
 * one leader + N members, each with an optional `provider/model` backend
 * and a dedicated system prompt). Assigning a task to a team spawns an
 * independent leader child `pi` process; the leader dispatches subtasks to
 * member child `pi` processes through the `team_dispatch` tool and
 * aggregates their results into a final report.
 */

/** Maximum member result payload returned to the leader (bytes, UTF-8). */
export const MAX_RESULT_BYTES = 50 * 1024;

/** Maximum per-member summary embedded in run records (bytes, UTF-8). */
export const MAX_SUMMARY_BYTES = 8 * 1024;

/** Maximum tasks accepted in a single team_dispatch call. */
export const MAX_TASKS_PER_DISPATCH = 8;

/** Maximum member child processes running concurrently. */
export const MAX_PARALLEL_MEMBERS = 4;

/** Dispatch-call budget per run (leader loop guard — exceeded ⇒ wrap up). */
export const MAX_DISPATCH_CALLS_PER_RUN = 12;

/** Total member-run budget per run (leader loop guard). */
export const MAX_MEMBER_RUNS_PER_RUN = 40;

/** Grace period between SIGTERM and SIGKILL when aborting a child. */
export const KILL_GRACE_MS = 5000;

/**
 * Bounded settle window for stopAndSettle: SIGTERM→SIGKILL grace plus a
 * 2s margin for the leader's event stream to flush before the terminal
 * record is written.
 */
export const STOP_SETTLE_TIMEOUT_MS = KILL_GRACE_MS + 2000;

/** Per-message text captured in run transcripts (bytes, UTF-8). */
export const MAX_TRANSCRIPT_MESSAGE_BYTES = 4 * 1024;

/** Session entry type used to persist run records (metadata only). */
export const RUN_ENTRY_TYPE = "agent-team-run-v1";

/** Custom message type used to wake the main session with a final report. */
export const RUN_RESULT_MESSAGE_TYPE = "agent-team-result";

/** Widget id (one status surface per extension, per repo convention). */
export const WIDGET_ID = "agent-team";

/** Repaint interval of the below-editor run widget (elapsed labels). */
export const WIDGET_TICK_MS = 1000;

/**
 * Refresh interval of the full-screen transcript viewer overlay.
 * Aligned to pi-subagents v0.66.0 fleet `REFRESH_MS = 750`
 * (`pi-subagents/src/tui/fleet.ts:25`); spec lock in
 * docs/tui-sync.md §4 + test/tui-sync.test.ts. Deviation here is a
 * ghosting suspect. (Widget keeps its own 1000ms tick — below-editor
 * string surface, see WIDGET_TICK_MS.)
 */
export const VIEWER_TICK_MS = 750;

/**
 * Frame-height jitter tolerance (rows): terminal-row reports that wobble
 * by this much keep the previous body height instead of resizing the
 * overlay frame (resizes on a trail-prone host leave ghost chrome rows).
 */
export const VIEWER_HEIGHT_JITTER_ROWS = 1;

/** Env var that switches the extension into leader mode inside a child pi. */
export const LEADER_ENV_FILE = "PI_AGENT_TEAM_FILE";

/** Env var carrying the team name inside a leader child pi. */
export const LEADER_ENV_NAME = "PI_AGENT_TEAM_NAME";

/** Env var carrying the run id (used for worktree paths/branches). */
export const LEADER_ENV_RUNID = "PI_AGENT_TEAM_RUN_ID";

// ---------------------------------------------------------------------------
// Team configuration
// ---------------------------------------------------------------------------

export interface TeamLeaderConfig {
  /** Backend model as `provider/id` (child pi default when omitted). */
  model?: string;
  /** Optional tool allowlist passed to the leader child as `--tools`. */
  tools?: string[];
  /** User-authored strategy prompt (how to complete tasks with the team). */
  prompt: string;
}

export interface TeamMemberConfig {
  name: string;
  description?: string;
  /** Backend model as `provider/id` (child pi default when omitted). */
  model?: string;
  /** Optional tool allowlist passed to the member child as `--tools`. */
  tools?: string[];
  /** Run this member in an isolated git worktree instead of the shared cwd. */
  worktree?: boolean;
  /** Dedicated member system prompt. */
  prompt: string;
}

export interface TeamConfig {
  name: string;
  description: string;
  leader: TeamLeaderConfig;
  members: TeamMemberConfig[];
  /**
   * Team-level shared worktree: the whole run (leader + all members without
   * their own `worktree: true`) works in one per-run git worktree instead of
   * the caller's working directory.
   */
  worktree?: boolean;
  /** Optional per-run budget caps (frontmatter `budget:` block). */
  budget?: RunBudgetConfig;
  /** Markdown body under the frontmatter (team-level notes for the leader). */
  notes?: string;
  /** Absolute path of the source definition file. */
  filePath: string;
  source: "global" | "project";
}

// ---------------------------------------------------------------------------
// Error codes + result unions (repo convention: no exceptions across layers)
// ---------------------------------------------------------------------------

export const TeamErrorCodes = {
  INVALID_TEAM_FILE: "INVALID_TEAM_FILE",
  TEAM_NOT_FOUND: "TEAM_NOT_FOUND",
  TEAM_ALREADY_EXISTS: "TEAM_ALREADY_EXISTS",
  WRITE_FAILED: "WRITE_FAILED",
  MEMBER_NOT_FOUND: "MEMBER_NOT_FOUND",
  INVALID_DISPATCH: "INVALID_DISPATCH",
  WORKTREE_UNAVAILABLE: "WORKTREE_UNAVAILABLE",
  CHILD_FAILED: "CHILD_FAILED",
  AGENT_ABORTED: "AGENT_ABORTED",
  RUN_IN_PROGRESS: "RUN_IN_PROGRESS",
  RUN_ID_REQUIRED: "RUN_ID_REQUIRED",
  RUN_NOT_FOUND: "RUN_NOT_FOUND",
  RUN_ALREADY_FINISHED: "RUN_ALREADY_FINISHED",
  BUDGET_EXCEEDED: "BUDGET_EXCEEDED",
  MODEL_NOT_FOUND: "MODEL_NOT_FOUND",
} as const;

export type TeamErrorCode = (typeof TeamErrorCodes)[keyof typeof TeamErrorCodes];

export type Result<T> = { ok: true; value: T } | { ok: false; code: TeamErrorCode; message: string };

export function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}

export function err(code: TeamErrorCode, message: string): Result<never> {
  return { ok: false, code, message };
}

// ---------------------------------------------------------------------------
// Run budget (per-run loop/cost guards)
// ---------------------------------------------------------------------------

/**
 * Configurable run budget (team frontmatter `budget:` block). Dispatch/
 * member-run caps default to the protocol constants; cost/token caps are
 * unlimited unless set. Schema-level limits (max tasks per dispatch,
 * parallel members) stay protocol constants — see MAX_TASKS_PER_DISPATCH /
 * MAX_PARALLEL_MEMBERS.
 */
export interface RunBudgetConfig {
  maxDispatchCalls?: number;
  maxMemberRuns?: number;
  maxCostUsd?: number;
  maxTotalTokens?: number;
}

/** Resolved budget consumed by the leader executor and the cockpit. */
export interface RunBudget {
  maxDispatchCalls: number;
  maxMemberRuns: number;
  /** null = unlimited. */
  maxCostUsd: number | null;
  /** null = unlimited. */
  maxTotalTokens: number | null;
  /** Where the caps came from (doctor/status display). */
  source: "default" | "frontmatter";
}

/** Resolves the frontmatter budget block onto the protocol defaults. */
export function resolveRunBudget(config?: RunBudgetConfig): RunBudget {
  const configured =
    config !== undefined &&
    (config.maxDispatchCalls !== undefined ||
      config.maxMemberRuns !== undefined ||
      config.maxCostUsd !== undefined ||
      config.maxTotalTokens !== undefined);
  return {
    maxDispatchCalls: config?.maxDispatchCalls ?? MAX_DISPATCH_CALLS_PER_RUN,
    maxMemberRuns: config?.maxMemberRuns ?? MAX_MEMBER_RUNS_PER_RUN,
    maxCostUsd: typeof config?.maxCostUsd === "number" ? config.maxCostUsd : null,
    maxTotalTokens: typeof config?.maxTotalTokens === "number" ? config.maxTotalTokens : null,
    source: configured ? "frontmatter" : "default",
  };
}

/** Live budget accounting for a running run (status display + caps). */
export interface RunBudgetSnapshot {
  maxDispatchCalls: number;
  maxMemberRuns: number;
  maxCostUsd: number | null;
  maxTotalTokens: number | null;
  spentCost: number;
  spentTokens: number;
  dispatchCalls: number;
  memberRuns: number;
}

// ---------------------------------------------------------------------------
// Usage accounting
// ---------------------------------------------------------------------------

export interface AgentUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  turns: number;
  model?: string;
}

export function emptyUsage(): AgentUsage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
}

export function addUsage(target: AgentUsage, source: AgentUsage): void {
  target.input += source.input;
  target.output += source.output;
  target.cacheRead += source.cacheRead;
  target.cacheWrite += source.cacheWrite;
  target.cost += source.cost;
  target.turns += source.turns;
}

// ---------------------------------------------------------------------------
// Child pi process runner
// ---------------------------------------------------------------------------

/** Minimal child-process surface (testable without real processes). */
export interface PiChildProcess {
  /** OS pid when known (leader diagnostics for orphaned processes). */
  readonly pid?: number;
  stdout: { on(event: "data", cb: (chunk: unknown) => void): void };
  stderr: { on(event: "data", cb: (chunk: unknown) => void): void };
  /**
   * Writable stdin when the spawn opened a pipe (leader RPC mode sends
   * `prompt`/`steer` commands here). Absent on one-shot children.
   */
  stdin?: PiChildStdin;
  on(event: "close", cb: (code: number | null) => void): void;
  on(event: "error", cb: (err: Error) => void): void;
  kill(signal: string): boolean;
}

/** Child stdin command channel (JSON line protocol in RPC mode). */
export interface PiChildStdin {
  write(data: string): void;
  end(): void;
}

/**
 * How a child's stdin is wired. `ignore` is the safe default for children
 * whose prompt travels through argv: pi's `--mode json -p` reads stdin to
 * EOF before it starts working, so an open-but-unused pipe deadlocks the
 * run. Only the leader's RPC channel needs `pipe`.
 */
export type ChildStdinMode = "pipe" | "ignore";

export type PiSpawn = (
  command: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; stdin?: ChildStdinMode },
) => PiChildProcess;

/** Sanitized events parsed from a child's `--mode json` stdout stream. */
export type ChildEvent =
  | {
      type: "message_end";
      role: string;
      /** Single-line tail of the assistant text (progress display only). */
      text?: string;
      /** Bounded full text of the message (run transcripts; assistant only). */
      fullText?: string;
      stopReason?: string;
      usage?: AgentUsage;
      model?: string;
    }
  | { type: "tool_execution_start"; toolName: string; args?: unknown }
  | { type: "tool_execution_update"; toolName: string; text?: string; details?: unknown }
  | { type: "tool_execution_end"; toolName: string; text?: string; details?: unknown }
  | { type: "error"; code: string; message: string }
  | { type: "exit"; exitCode: number };

export interface ChildOutcome {
  exitCode: number;
  events: ChildEvent[];
  usage: AgentUsage;
  finalText: string;
  stderr: string;
  /** OS pid of the child when known (persisted for orphan diagnostics). */
  pid?: number;
  errorMessage?: string;
  stopReason?: string;
  model?: string;
}

// ---------------------------------------------------------------------------
// Member dispatch
// ---------------------------------------------------------------------------

export interface MemberRunResult {
  name: string;
  ok: boolean;
  status: "done" | "failed" | "aborted";
  /** Full (truncated) final text of the member run. */
  result: string;
  /** Short summary for run records. */
  summary: string;
  usage: AgentUsage;
  durationMs: number;
  worktree?: { path: string; branch: string };
  error?: { code: TeamErrorCode; message: string };
}

export interface DispatchOutcome {
  results: MemberRunResult[];
  /** Combined markdown report returned to the leader. */
  text: string;
}

// ---------------------------------------------------------------------------
// Run records (persistence + result delivery)
// ---------------------------------------------------------------------------

export type RunStatus = "running" | "completed" | "failed" | "aborted";

export interface TeamRunRecord {
  runId: string;
  team: string;
  task: string;
  startedAt: string;
  finishedAt?: string;
  status: RunStatus;
  /** Leader's final report text (truncated). */
  report?: string;
  error?: string;
  members: Array<{
    name: string;
    model?: string;
    status: string;
    summary?: string;
    usage?: AgentUsage;
    worktree?: { path: string; branch: string };
  }>;
  leaderUsage?: AgentUsage;
  totalCost: number;
  totalTokens: number;
  durationMs?: number;
  /** Team-level shared worktree of this run (when configured). */
  worktree?: { path: string; branch: string };
}

// ---------------------------------------------------------------------------
// Live progress (widget + tool onUpdate)
// ---------------------------------------------------------------------------

export type MemberProgressStatus = "queued" | "running" | "done" | "failed" | "aborted";

export interface MemberProgress {
  name: string;
  status: MemberProgressStatus;
  note?: string;
  /** Latest assistant activity tail (what the member is doing right now). */
  latest?: string;
  /** Declared backend model from the team file (child pi default when unset). */
  model?: string;
}

export interface RunProgress {
  runId: string;
  team: string;
  task: string;
  startedAtMs: number;
  leaderModel?: string;
  leaderNote?: string;
  /** Leader's latest activity tail (progress display only). */
  leaderActivity?: string;
  members: MemberProgress[];
  /** Live budget accounting (caps + spent) when the run tracks a budget. */
  budget?: RunBudgetSnapshot;
}

/** UTF-8 safe truncation (same semantics as pwr's runner). */
export function truncateUtf8(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  let truncated = text.slice(0, maxBytes);
  while (Buffer.byteLength(truncated, "utf8") > maxBytes) truncated = truncated.slice(0, -1);
  return truncated;
}
