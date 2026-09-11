/**
 * Shared test helpers: a fake child pi process (scripted stdout lines /
 * exit / recorded kills) and a spawn factory that records invocations.
 * Modeled on pwr/runner/test/helpers.ts, extended with env capture and
 * auto-response scheduling for multi-child scenarios (leader + members).
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { LEADER_ENV_RUNID } from "../types.ts";
import type { ChildStdinMode, PiChildProcess, PiSpawn } from "../types.ts";

/**
 * Redirects the extension's per-run artifact root (status.json + run
 * transcripts) to a fresh temp dir for the current test FILE. Host-level
 * tests that fire session_start or dispatch runs must call this at module
 * scope — otherwise runs pollute (and get reconciled from) the real
 * `~/.pi/agent/teams/runs`, making tests order-dependent.
 */
export function isolateRunsDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-team-runs-"));
  process.env.PI_AGENT_TEAM_RUNS_DIR = dir;
  return dir;
}

export interface SpawnRecord {
  command: string;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** stdin mode the caller asked for (members `ignore`, leader RPC `pipe`). */
  stdin?: ChildStdinMode;
}

export class FakeChild implements PiChildProcess {
  private readonly stdoutCbs: Array<(chunk: unknown) => void> = [];
  private readonly stderrCbs: Array<(chunk: unknown) => void> = [];
  private readonly closeCbs: Array<(code: number | null) => void> = [];
  private readonly errorCbs: Array<(err: Error) => void> = [];
  readonly killed: string[] = [];
  /** Fake OS pid (assigned by the spawn factory when nextPid is set). */
  pid: number | undefined = undefined;

  stdout = {
    on: (_event: "data", cb: (chunk: unknown) => void) => {
      this.stdoutCbs.push(cb);
    },
  };
  stderr = {
    on: (_event: "data", cb: (chunk: unknown) => void) => {
      this.stderrCbs.push(cb);
    },
  };

  /** RPC command lines written to the child (leader prompt/steer). */
  readonly writes: string[] = [];
  /** True once stdin.end() was called (RPC shutdown trigger). */
  ended = false;

  stdin = {
    write: (data: string) => {
      this.writes.push(data);
    },
    end: () => {
      this.ended = true;
    },
  };

  on(event: "close" | "error", cb: (arg: never) => void): void {
    if (event === "close") this.closeCbs.push(cb as (code: number | null) => void);
    else if (event === "error") this.errorCbs.push(cb as (err: Error) => void);
  }

  kill(signal: string): boolean {
    this.killed.push(signal);
    return true;
  }

  /** Emits one complete JSON event line (appended with \n). */
  emitLine(line: string): void {
    const chunk = Buffer.from(`${line}\n`, "utf8");
    for (const cb of this.stdoutCbs) cb(chunk);
  }

  /** Simulates partial chunks (tests line buffering). */
  emitChunk(part: string): void {
    for (const cb of this.stdoutCbs) cb(Buffer.from(part, "utf8"));
  }

  emitStderr(text: string): void {
    for (const cb of this.stderrCbs) cb(Buffer.from(text, "utf8"));
  }

  emitClose(code: number | null): void {
    for (const cb of this.closeCbs) cb(code);
  }

  emitError(err: Error): void {
    for (const cb of this.errorCbs) cb(err);
  }

  /**
   * Schedules a scripted response: emits the given lines (with a small
   * async delay so callers can observe intermediate state) then closes.
   */
  autoRespond(lines: string[], exitCode = 0, delayMs = 5): void {
    setTimeout(() => {
      for (const line of lines) this.emitLine(line);
      this.emitClose(exitCode);
    }, delayMs);
  }
}

export interface FakeSpawnHandle {
  spawn: PiSpawn;
  records: SpawnRecord[];
  children: FakeChild[];
  /** If set, spawn throws this error instead of returning a child. */
  spawnError?: Error;
  /** If set, assigns a fake pid to each spawned child (by index). */
  nextPid?: (index: number) => number | undefined;
}

export function makeFakeSpawn(): FakeSpawnHandle {
  const handle: FakeSpawnHandle = {
    spawn: (command, args, opts) => {
      if (handle.spawnError) throw handle.spawnError;
      const child = new FakeChild();
      child.pid = handle.nextPid?.(handle.children.length);
      handle.records.push({ command, args, cwd: opts.cwd, env: opts.env, stdin: opts.stdin });
      handle.children.push(child);
      return child;
    },
    records: [],
    children: [],
  };
  return handle;
}

/** Waits until the spawn factory has produced a child at `index`. */
export async function waitForChild(handle: FakeSpawnHandle, index = 0): Promise<FakeChild> {
  for (let i = 0; i < 200; i++) {
    if (handle.children[index]) return handle.children[index];
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`no child spawned at index ${index}`);
}

/**
 * Waits until the child spawned for `runId` exists and returns it.
 * Concurrent start() calls run real fs/git work before spawning, so spawn
 * completion order can differ from start-call order — pairing children by
 * array index then feeds one run's events to another run's channel (and
 * hangs `await` on the run that never gets a response). Pair by the runId
 * the spawn port already records in `env[LEADER_ENV_RUNID]` instead.
 */
export async function waitForChildByRunId(
  handle: FakeSpawnHandle,
  runId: string,
  attempts = 400,
): Promise<FakeChild> {
  for (let i = 0; i < attempts; i++) {
    const index = handle.records.findIndex((record) => record.env?.[LEADER_ENV_RUNID] === runId);
    if (index >= 0 && handle.children[index]) return handle.children[index]!;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`no leader child spawned for runId ${runId}`);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** JSON message_end event line (pi stream format). */
export function messageEndLine(
  role: string,
  overrides: Record<string, unknown> = {},
): string {
  const msg: Record<string, unknown> = {
    role,
    content: [{ type: "text", text: "final output" }],
    ...overrides,
  };
  return JSON.stringify({ type: "message_end", message: msg });
}

export function toolExecutionStartLine(toolName: string, args: unknown): string {
  return JSON.stringify({ type: "tool_execution_start", toolName, args });
}

export function toolExecutionEndLine(toolName: string, result: unknown): string {
  return JSON.stringify({ type: "tool_execution_end", toolName, result });
}

/** JSON tool_execution_update line (pi stream format: `partial.content`/`partial.details`). */
export function toolExecutionUpdateLine(toolName: string, partial: unknown): string {
  return JSON.stringify({ type: "tool_execution_update", toolName, partial });
}
