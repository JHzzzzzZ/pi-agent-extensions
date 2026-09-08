/**
 * Shared test helpers: a fake child pi process (scripted stdout lines /
 * exit / recorded kills) and a spawn factory that records invocations.
 * Modeled on pwr/runner/test/helpers.ts, extended with env capture and
 * auto-response scheduling for multi-child scenarios (leader + members).
 */

import type { PiChildProcess, PiSpawn } from "../types.ts";

export interface SpawnRecord {
  command: string;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

export class FakeChild implements PiChildProcess {
  private readonly stdoutCbs: Array<(chunk: unknown) => void> = [];
  private readonly stderrCbs: Array<(chunk: unknown) => void> = [];
  private readonly closeCbs: Array<(code: number | null) => void> = [];
  private readonly errorCbs: Array<(err: Error) => void> = [];
  readonly killed: string[] = [];

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
}

export function makeFakeSpawn(): FakeSpawnHandle {
  const handle: FakeSpawnHandle = {
    spawn: (command, args, opts) => {
      if (handle.spawnError) throw handle.spawnError;
      const child = new FakeChild();
      handle.records.push({ command, args, cwd: opts.cwd, env: opts.env });
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
