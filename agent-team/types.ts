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

/** Session entry type used to persist run records (metadata only). */
export const RUN_ENTRY_TYPE = "agent-team-run-v1";

/** Custom message type used to wake the main session with a final report. */
export const RUN_RESULT_MESSAGE_TYPE = "agent-team-result";

/** Widget id (one status surface per extension, per repo convention). */
export const WIDGET_ID = "agent-team";

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
  BUDGET_EXCEEDED: "BUDGET_EXCEEDED",
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
  stdout: { on(event: "data", cb: (chunk: unknown) => void): void };
  stderr: { on(event: "data", cb: (chunk: unknown) => void): void };
  on(event: "close", cb: (code: number | null) => void): void;
  on(event: "error", cb: (err: Error) => void): void;
  kill(signal: string): boolean;
}

export type PiSpawn = (command: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv }) => PiChildProcess;

/** Sanitized events parsed from a child's `--mode json` stdout stream. */
export type ChildEvent =
  | {
      type: "message_end";
      role: string;
      /** Single-line tail of the assistant text (progress display only). */
      text?: string;
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
}

/** UTF-8 safe truncation (same semantics as pwr's runner). */
export function truncateUtf8(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  let truncated = text.slice(0, maxBytes);
  while (Buffer.byteLength(truncated, "utf8") > maxBytes) truncated = truncated.slice(0, -1);
  return truncated;
}
