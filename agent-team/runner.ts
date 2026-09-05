/**
 * agent-team — child pi process runner
 *
 * Own reimplementation of the child-`pi` process pattern (JSON output mode,
 * per-line event stream, SIGTERM-then-SIGKILL abort) used by the official
 * subagent extension and pwr's runner. Self-contained: no imports from pwr.
 *
 * The pi CLI flags are the public pi interface. `--append-system-prompt`
 * reads a file path, so prompt texts passed as `team-tmp://<text>` are
 * materialized into private temp files (0600, removed on exit).
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  KILL_GRACE_MS,
  emptyUsage,
  type AgentUsage,
  type ChildEvent,
  type ChildOutcome,
  type PiChildProcess,
  type PiSpawn,
} from "./types.ts";

const PROMPT_SCHEME = "team-tmp://";

/** Resolve the pi invocation: same strategy as the pi host itself. */
export function getPiInvocation(args: string[]): { command: string; args: string[] } {
  const currentScript = process.argv[1];
  const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
  if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
    return { command: process.execPath, args: [currentScript, ...args] };
  }
  const execName = path.basename(process.execPath).toLowerCase();
  const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
  if (!isGenericRuntime) {
    return { command: process.execPath, args };
  }
  return { command: "pi", args };
}

export function defaultSpawn(): PiSpawn {
  return (command, args, opts) => {
    const child = spawn(command, args, {
      cwd: opts.cwd,
      env: opts.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const adapter: PiChildProcess = {
      stdout: {
        on(event, cb) {
          if (event === "data") child.stdout?.on("data", (chunk: Buffer) => cb(chunk));
        },
      },
      stderr: {
        on(event, cb) {
          if (event === "data") child.stderr?.on("data", (chunk: Buffer) => cb(chunk));
        },
      },
      on(event, cb) {
        if (event === "close") child.on("close", (code) => (cb as (code: number | null) => void)(code));
        else if (event === "error") child.on("error", (err) => (cb as (err: Error) => void)(err));
      },
      kill(signal) {
        try {
          return child.kill(signal as NodeJS.Signals);
        } catch {
          return false;
        }
      },
    };
    return adapter;
  };
}

export interface RunChildOptions {
  command: string;
  args: string[];
  cwd?: string;
  /** Extra environment variables merged over process.env for the child. */
  env?: NodeJS.ProcessEnv;
  spawn: PiSpawn;
  signal?: AbortSignal;
  /** Live event callback (called as events are parsed, before resolution). */
  onEvent?: (event: ChildEvent) => void;
  /** Test seam: SIGTERM→SIGKILL grace period (default 5000ms). */
  killGraceMs?: number;
}

interface StreamedMessage {
  role?: string;
  content?: Array<{ type?: string; text?: string }>;
  usage?: unknown;
  model?: string;
  stopReason?: string;
  errorMessage?: string;
}

interface JsonLineEvent {
  type?: string;
  message?: StreamedMessage;
  toolName?: string;
  toolCallId?: string;
  args?: unknown;
  partial?: { content?: Array<{ type?: string; text?: string }>; details?: unknown };
  result?: { content?: Array<{ type?: string; text?: string }>; details?: unknown };
}

function toNumber(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function parseLine(line: string): JsonLineEvent | null {
  if (!line.trim()) return null;
  try {
    const parsed = JSON.parse(line) as JsonLineEvent;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function applyUsage(target: AgentUsage, raw: unknown): void {
  if (raw === null || typeof raw !== "object") return;
  const usage = raw as Record<string, unknown>;
  target.input += toNumber(usage.input);
  target.output += toNumber(usage.output);
  target.cacheRead += toNumber(usage.cacheRead);
  target.cacheWrite += toNumber(usage.cacheWrite);
  const cost = usage.cost as { total?: unknown } | undefined;
  target.cost += toNumber(cost?.total);
}

function contentText(parts: Array<{ type?: string; text?: string }> | undefined): string | undefined {
  const texts = (parts ?? [])
    .filter((p) => p.type === "text" && typeof p.text === "string")
    .map((p) => p.text as string);
  return texts.length > 0 ? texts.join("\n") : undefined;
}

/** Flattens text to a single line and keeps only the tail (progress display). */
export function textTail(text: string, max = 160): string {
  const singleLine = text.replace(/\s+/g, " ").trim();
  if (singleLine.length <= max) return singleLine;
  return `…${singleLine.slice(singleLine.length - max)}`;
}

/**
 * Runs one child pi process in JSON mode. Streams sanitized events to
 * `onEvent` as they arrive and resolves when the child exits. Abort kills
 * the child (SIGTERM, then SIGKILL after `killGraceMs`).
 */
export async function runChildPi(options: RunChildOptions): Promise<ChildOutcome> {
  const { command, args, cwd, env, spawn: spawnFn, signal, onEvent } = options;
  const killGraceMs = options.killGraceMs ?? KILL_GRACE_MS;
  const outcome: ChildOutcome = {
    exitCode: 0,
    events: [],
    usage: emptyUsage(),
    finalText: "",
    stderr: "",
  };

  const emit = (event: ChildEvent) => {
    outcome.events.push(event);
    try {
      onEvent?.(event);
    } catch {
      /* observer failures never break the run */
    }
  };

  // Materialize `team-tmp://<text>` system prompts into private temp files.
  const tmpFiles: string[] = [];
  const tmpDirs: string[] = [];
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] === "--append-system-prompt" && args[i + 1]?.startsWith(PROMPT_SCHEME)) {
      const promptText = args[i + 1].slice(PROMPT_SCHEME.length);
      const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "agent-team-"));
      const tmpPath = path.join(tmpDir, "prompt.md");
      await fs.promises.writeFile(tmpPath, promptText, { encoding: "utf-8", mode: 0o600 });
      args[i + 1] = tmpPath;
      tmpFiles.push(tmpPath);
      tmpDirs.push(tmpDir);
    }
  }

  /** Releases the SIGKILL timer + abort listener once the child is done. */
  let clearAbort: (() => void) | null = null;

  try {
    let spawned: PiChildProcess;
    try {
      spawned = spawnFn(command, args, { cwd, env });
    } catch (err) {
      throw err instanceof Error ? err : new Error(String(err));
    }

    let buffer = "";
    let spawnErrorMessage = "";
    let stoppedByAbort = false;

    spawned.on("error", (err) => {
      spawnErrorMessage = err.message;
    });

    const processLine = (line: string) => {
      const event = parseLine(line);
      if (!event) return;
      const msg = event.message;
      if (event.type === "message_end" && msg) {
        const role = msg.role ?? "unknown";
        if (role === "assistant") {
          outcome.usage.turns++;
          applyUsage(outcome.usage, msg.usage);
          if (msg.model) {
            outcome.model = msg.model;
            outcome.usage.model = msg.model;
          }
          if (msg.stopReason) outcome.stopReason = msg.stopReason;
          if (msg.errorMessage) outcome.errorMessage = msg.errorMessage;
        }
        const text = contentText(msg.content);
        if (role === "assistant" && text) outcome.finalText = text;
        emit({
          type: "message_end",
          role,
          ...(role === "assistant" && text ? { text: textTail(text) } : {}),
          ...(msg.stopReason ? { stopReason: msg.stopReason } : {}),
          ...(role === "assistant" && msg.usage ? { usage: { ...outcome.usage } } : {}),
          ...(msg.model ? { model: msg.model } : {}),
        });
        return;
      }
      if (event.type === "tool_execution_start") {
        emit({ type: "tool_execution_start", toolName: event.toolName ?? "?", args: event.args });
        return;
      }
      if (event.type === "tool_execution_update") {
        emit({
          type: "tool_execution_update",
          toolName: event.toolName ?? "?",
          text: contentText(event.partial?.content),
          details: event.partial?.details,
        });
        return;
      }
      if (event.type === "tool_execution_end") {
        emit({
          type: "tool_execution_end",
          toolName: event.toolName ?? "?",
          text: contentText(event.result?.content),
          details: event.result?.details,
        });
        return;
      }
      // Other event types (message_start/message_update/...) are ignored.
    };

    spawned.stdout.on("data", (chunk) => {
      buffer += String(chunk);
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) processLine(line);
    });

    spawned.stderr.on("data", (chunk) => {
      outcome.stderr += String(chunk);
    });

    const exit = new Promise<number>((resolve) => {
      spawned.on("close", (code) => {
        if (buffer.trim()) processLine(buffer);
        resolve(code ?? 0);
      });
    });

    if (signal) {
      let killTimer: ReturnType<typeof setTimeout> | null = null;
      const killProc = () => {
        stoppedByAbort = true;
        spawned.kill("SIGTERM");
        killTimer = setTimeout(() => {
          killTimer = null;
          spawned.kill("SIGKILL");
        }, killGraceMs);
      };
      clearAbort = () => {
        if (killTimer !== null) {
          clearTimeout(killTimer);
          killTimer = null;
        }
        signal.removeEventListener("abort", killProc);
      };
      if (signal.aborted) killProc();
      else signal.addEventListener("abort", killProc, { once: true });
    }

    const exitCode = await exit;
    clearAbort?.();

    emit({ type: "exit", exitCode });
    if (spawnErrorMessage) {
      emit({ type: "error", code: "CHILD_SPAWN_FAILED", message: spawnErrorMessage });
    }
    if (stoppedByAbort) {
      emit({ type: "error", code: "AGENT_ABORTED", message: "child process killed by abort" });
    }

    outcome.exitCode = exitCode;
    return outcome;
  } finally {
    clearAbort?.();
    for (const tmpPath of tmpFiles) {
      try {
        fs.unlinkSync(tmpPath);
      } catch {
        /* ignore */
      }
    }
    for (const tmpDir of tmpDirs) {
      try {
        fs.rmdirSync(tmpDir);
      } catch {
        /* ignore */
      }
    }
  }
}
