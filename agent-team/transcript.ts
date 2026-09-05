/**
 * agent-team — run transcripts (per-actor JSONL artifacts)
 *
 * Every run keeps one bounded JSONL file per actor (the leader and each
 * dispatched member) under `<agentDir>/teams/runs/<runId>/`. The dispatch
 * executor (inside the leader process) streams member activity there; the
 * cockpit (main session) streams the leader's own activity there. The
 * full-screen viewer (`/team:view`) and the `team_transcript` tool read
 * these files back — the same run-artifacts pattern pi-subagents uses for
 * its fleet inspector.
 *
 * Writes are best-effort and exception-isolated: a transcript failure never
 * breaks a run (mirrors session.ts persistence rules). Files are capped so
 * a chatty child cannot fill the disk; readers parse leniently.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { truncateUtf8 } from "./types.ts";

/** Actor id used for the leader's transcript file (sorts first). */
export const LEADER_ACTOR = "_leader";

/** Kinds of transcript entries (viewer renders each differently). */
export const TRANSCRIPT_ENTRY_KINDS = ["task", "assistant", "tool", "error", "system"] as const;
export type TranscriptEntryKind = (typeof TRANSCRIPT_ENTRY_KINDS)[number];

/** One bounded transcript line inside a run artifact file. */
export interface TranscriptEntry {
  kind: TranscriptEntryKind;
  /** Bounded human-readable text (single entry of the run conversation). */
  text: string;
  /** ISO timestamp of when the entry was recorded. */
  ts: string;
}

/** Per-entry text bound (bytes, UTF-8). */
export const MAX_TRANSCRIPT_ENTRY_BYTES = 4 * 1024;
/** Soft cap per transcript file — writes stop once exceeded. */
export const MAX_TRANSCRIPT_FILE_BYTES = 2 * 1024 * 1024;
/** Notice appended when a transcript file reaches its cap. */
export const TRANSCRIPT_CAPPED_NOTICE = "…（记录已达上限，后续内容省略）";

/** Best-effort transcript writer (exception-isolated implementations). */
export interface TranscriptSink {
  append(actor: string, kind: TranscriptEntryKind, text: string): void;
}

/** Filesystem-safe actor file name (no traversal, no collisions with the leader file). */
export function sanitizeActorName(name: string): string {
  const safe = name.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^[-._]+/, "");
  return safe.length > 0 ? safe.slice(0, 64) : "member";
}

/** Filesystem-safe run id (run ids come from internal clocks or env). */
export function sanitizeRunId(runId: string): string {
  const safe = runId.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^[-._]+/, "");
  return safe.length > 0 ? safe.slice(0, 64) : "run";
}

export function transcriptRunDir(root: string, runId: string): string {
  return path.join(root, sanitizeRunId(runId));
}

export function actorTranscriptPath(root: string, runId: string, actor: string): string {
  const fileName = actor === LEADER_ACTOR ? `${LEADER_ACTOR}.jsonl` : `${sanitizeActorName(actor)}.jsonl`;
  return path.join(transcriptRunDir(root, runId), fileName);
}

/**
 * JSONL transcript sink: appends one bounded entry per call under
 * `<root>/<runId>/<actor>.jsonl`. All filesystem failures are swallowed —
 * transcripts are observability data, never run-critical.
 */
export class FileTranscriptSink implements TranscriptSink {
  private readonly root: string;
  private readonly runId: string;
  private readonly now: () => string;
  private readonly capped = new Set<string>();

  constructor(root: string, runId: string, now?: () => string) {
    this.root = root;
    this.runId = runId;
    this.now = now ?? (() => new Date().toISOString());
  }

  append(actor: string, kind: TranscriptEntryKind, text: string): void {
    try {
      fs.mkdirSync(transcriptRunDir(this.root, this.runId), { recursive: true });
      const file = actorTranscriptPath(this.root, this.runId, actor);
      let size = 0;
      try {
        size = fs.statSync(file).size;
      } catch {
        /* first write */
      }
      if (size >= MAX_TRANSCRIPT_FILE_BYTES) {
        if (!this.capped.has(file)) {
          this.capped.add(file);
          try {
            fs.appendFileSync(file, `${JSON.stringify({ kind: "system", text: TRANSCRIPT_CAPPED_NOTICE, ts: this.now() })}\n`, "utf-8");
          } catch {
            /* ignore */
          }
        }
        return;
      }
      const entry: TranscriptEntry = { kind, text: truncateUtf8(text, MAX_TRANSCRIPT_ENTRY_BYTES), ts: this.now() };
      fs.appendFileSync(file, `${JSON.stringify(entry)}\n`, "utf-8");
    } catch {
      /* transcript failures never break the run */
    }
  }
}

/**
 * In-memory sink (tests and non-filesystem wiring): records entries per
 * actor in insertion order.
 */
export class MemoryTranscriptSink implements TranscriptSink {
  readonly entries = new Map<string, TranscriptEntry[]>();

  constructor(now?: () => string) {
    this.now = now ?? (() => new Date().toISOString());
  }

  private readonly now: () => string;

  append(actor: string, kind: TranscriptEntryKind, text: string): void {
    const list = this.entries.get(actor) ?? [];
    list.push({ kind, text: truncateUtf8(text, MAX_TRANSCRIPT_ENTRY_BYTES), ts: this.now() });
    this.entries.set(actor, list);
  }
}

/** Parses one JSONL line leniently; malformed lines are dropped. */
function parseEntryLine(line: string): TranscriptEntry | null {
  if (!line.trim()) return null;
  try {
    const raw = JSON.parse(line) as { kind?: unknown; text?: unknown; ts?: unknown };
    if (typeof raw.text !== "string" || !TRANSCRIPT_ENTRY_KINDS.includes(raw.kind as TranscriptEntryKind)) {
      return null;
    }
    return { kind: raw.kind as TranscriptEntryKind, text: raw.text, ts: typeof raw.ts === "string" ? raw.ts : "" };
  } catch {
    return null;
  }
}

/** Reads one actor's transcript; missing or corrupt files read as empty. */
export function readTranscript(root: string, runId: string, actor: string): TranscriptEntry[] {
  try {
    const content = fs.readFileSync(actorTranscriptPath(root, runId, actor), "utf-8");
    return content.split("\n").map(parseEntryLine).filter((e): e is TranscriptEntry => e !== null);
  } catch {
    return [];
  }
}

/**
 * Actors that have a transcript file for the run. The leader comes first,
 * members follow alphabetically. Returns file-derived actor ids (already
 * sanitized when written by FileTranscriptSink).
 */
export function listTranscriptActors(root: string, runId: string): string[] {
  let files: string[];
  try {
    files = fs.readdirSync(transcriptRunDir(root, runId));
  } catch {
    return [];
  }
  const actors = files
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => f.slice(0, -".jsonl".length))
    .filter((a) => a.length > 0);
  actors.sort((a, b) => {
    if (a === LEADER_ACTOR) return -1;
    if (b === LEADER_ACTOR) return 1;
    return a.localeCompare(b);
  });
  return actors;
}

/** Removes run transcript directories older than `maxAgeMs` (best-effort). */
export function pruneOldTranscripts(root: string, nowMs: number, maxAgeMs: number): number {
  let removed = 0;
  let names: string[];
  try {
    names = fs.readdirSync(root);
  } catch {
    return 0;
  }
  for (const name of names) {
    try {
      const dir = path.join(root, name);
      const stat = fs.statSync(dir);
      if (!stat.isDirectory()) continue;
      if (nowMs - stat.mtimeMs >= maxAgeMs) {
        fs.rmSync(dir, { recursive: true, force: true });
        removed++;
      }
    } catch {
      /* per-dir failures are ignored */
    }
  }
  return removed;
}
