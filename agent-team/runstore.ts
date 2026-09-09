/**
 * agent-team — run status store (per-run status.json snapshots)
 *
 * Every run persists a small metadata snapshot into its existing per-run
 * artifact directory (`<agentDir>/teams/runs/<runId>/status.json`, next to
 * the transcript JSONL files — same 7-day retention lifecycle). The
 * coordinator writes a `running` snapshot right after it claims the run
 * and updates it with the terminal status at the end, so a crashed main
 * session no longer loses its runs: `session_start` reconciles stale
 * `running` files into `failed` records (reporting — never killing — the
 * possibly-orphaned leader PID).
 *
 * Same durability rules as the transcripts: writes are best-effort and
 * exception-isolated; readers parse leniently and isolate corrupt files
 * (surfaced by doctor/reconcile, never thrown).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { sanitizeRunId, transcriptRunDir } from "./transcript.ts";
import type { RunStatus } from "./types.ts";

/** Schema version of status.json (bump on incompatible shape changes). */
export const RUN_STATUS_VERSION = 1;

/** Metadata snapshot persisted per run (no prompts, no report bodies). */
export interface RunStatusFile {
  version: number;
  runId: string;
  team: string;
  task: string;
  startedAt: string;
  status: RunStatus;
  /** Leader child PID (diagnostics for orphaned leaders; never auto-killed). */
  leaderPid?: number;
  updatedAt: string;
  /** Terminal-state error detail (failed/aborted runs). */
  error?: string;
}

export function runStatusPath(root: string, runId: string): string {
  return path.join(transcriptRunDir(root, runId), "status.json");
}

/** Writes (or overwrites) the run's status.json. Failures are swallowed. */
export function writeRunStatus(root: string, status: RunStatusFile): void {
  try {
    fs.mkdirSync(transcriptRunDir(root, status.runId), { recursive: true });
    fs.writeFileSync(runStatusPath(root, status.runId), `${JSON.stringify(status, null, 2)}\n`, "utf-8");
  } catch {
    /* status persistence failures never break the run */
  }
}

/** Store surface the coordinator depends on (injectable for tests). */
export interface RunStoreWriter {
  write(status: RunStatusFile): void;
}

/** File-backed store over `writeRunStatus` (the coordinator's default). */
export function fileRunStore(root: string): RunStoreWriter {
  return { write: (status) => writeRunStatus(root, status) };
}

export interface RunStatusesRead {
  entries: RunStatusFile[];
  /** Files that exist but failed validation (corrupt → isolated). */
  corrupt: Array<{ file: string; message: string }>;
}

const RUN_STATUSES: ReadonlySet<string> = new Set(["running", "completed", "failed", "aborted"]);

/** Validates one parsed status.json leniently; null when not a status file. */
function parseStatusFile(raw: unknown): RunStatusFile | null {
  if (raw === null || typeof raw !== "object") return null;
  const s = raw as Record<string, unknown>;
  if (s.version !== RUN_STATUS_VERSION) return null;
  if (typeof s.runId !== "string" || typeof s.team !== "string" || typeof s.task !== "string") return null;
  if (typeof s.startedAt !== "string" || typeof s.updatedAt !== "string") return null;
  if (typeof s.status !== "string" || !RUN_STATUSES.has(s.status)) return null;
  if (s.leaderPid !== undefined && typeof s.leaderPid !== "number") return null;
  if (s.error !== undefined && typeof s.error !== "string") return null;
  return {
    version: RUN_STATUS_VERSION,
    runId: s.runId,
    team: s.team,
    task: s.task,
    startedAt: s.startedAt,
    status: s.status as RunStatus,
    updatedAt: s.updatedAt,
    ...(typeof s.leaderPid === "number" ? { leaderPid: s.leaderPid } : {}),
    ...(typeof s.error === "string" ? { error: s.error } : {}),
  };
}

/** Reads every run's status snapshot; corrupt files land in `corrupt`. */
export function readRunStatuses(root: string): RunStatusesRead {
  const entries: RunStatusFile[] = [];
  const corrupt: Array<{ file: string; message: string }> = [];
  let names: string[];
  try {
    names = fs.readdirSync(root);
  } catch {
    return { entries, corrupt };
  }
  for (const name of names) {
    const file = path.join(root, name, "status.json");
    let content: string;
    try {
      if (!fs.statSync(file).isFile()) continue;
      content = fs.readFileSync(file, "utf-8");
    } catch {
      continue; // no status.json in this run dir — normal for old runs
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch (e) {
      corrupt.push({ file, message: e instanceof Error ? e.message : String(e) });
      continue;
    }
    const status = parseStatusFile(parsed);
    if (status) entries.push(status);
    else corrupt.push({ file, message: "status.json 形状不符合 v1 schema" });
  }
  return { entries, corrupt };
}

export interface ReconciledRun {
  runId: string;
  team: string;
  task: string;
  startedAt: string;
  leaderPid?: number;
}

/** Shared orphan-leader diagnostic (status.json + synthesized record). */
export function orphanRunError(leaderPid?: number): string {
  return leaderPid !== undefined
    ? `主会话在 run 进行中退出，run 未落终态；leader 子进程 pid=${leaderPid} 可能仍残留（未自动终止）`
    : "主会话在 run 进行中退出，run 未落终态；leader 子进程可能仍残留（未自动终止）";
}

/**
 * Reconciles stale `running` status files after a session restart: every
 * snapshot whose run is not in `inMemoryRunIds` was orphaned by a crashed
 * main session — rewritten to `failed` with an orphan-leader diagnostic.
 * The leader process is NEVER killed here (PID reuse risk; the diagnostic
 * tells the user what to check). Terminal or in-memory runs are untouched.
 */
export function reconcileStaleRuns(options: {
  root: string;
  inMemoryRunIds: Set<string>;
  now: () => string;
}): ReconciledRun[] {
  let read: RunStatusesRead;
  try {
    read = readRunStatuses(options.root);
  } catch {
    return [];
  }
  const reconciled: ReconciledRun[] = [];
  for (const entry of read.entries) {
    if (entry.status !== "running") continue;
    if (options.inMemoryRunIds.has(entry.runId)) continue;
    const error = orphanRunError(entry.leaderPid);
    writeRunStatus(options.root, {
      ...entry,
      status: "failed",
      updatedAt: options.now(),
      error,
    });
    reconciled.push({
      runId: entry.runId,
      team: entry.team,
      task: entry.task,
      startedAt: entry.startedAt,
      ...(entry.leaderPid !== undefined ? { leaderPid: entry.leaderPid } : {}),
    });
  }
  return reconciled;
}
