/**
 * PWR PiAgentRunner — child pi process mode (JHL-14)
 *
 * PWR-owned reimplementation of the child-`pi` process pattern the local
 * `subagent` extension uses (JSON output mode, per-line event stream,
 * SIGTERM-then-SIGKILL abort). No subagent code is imported; the pi CLI
 * flags are the public pi interface (`pi --help` verified).
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentEvent, PiChildProcess, PiSpawn, RunnerUsage } from "./types.ts";
import { MAX_TRACE_ARGS_CHARS, MAX_TRACE_TEXT_CHARS } from "./types.ts";

/** Grace period between SIGTERM and SIGKILL when aborting a child. */
export const KILL_GRACE_MS = 5000;

/** Minimum interval between live message_update events (throttle, ms). */
export const MESSAGE_UPDATE_THROTTLE_MS = 800;

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

export interface PiChildOptions {
	command: string;
	args: string[];
	cwd?: string;
	spawn: PiSpawn;
	signal?: AbortSignal;
	now: () => string;
	/** Test seam: millisecond clock for the message_update throttle. */
	nowMs?: () => number;
	/**
	 * Live observer invoked as sanitized events are parsed (before the
	 * promise resolves). Observer failures never break the run.
	 */
	onEvent?: (event: AgentEvent) => void;
}

export interface PiChildOutcome {
	exitCode: number;
	/** Sanitized event stream (no raw tool output). */
	events: AgentEvent[];
	usage: RunnerUsage;
	finalText: string;
	stderr: string;
	errorMessage?: string;
	stopReason?: string;
	model?: string;
}

/** Empty normalized usage. */
export function emptyUsage(): RunnerUsage {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
}

interface StreamedMessage {
	role: string;
	content?: Array<{ type?: string; text?: string }>;
	usage?: unknown;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
}

interface PiMessageEvent {
	type: string;
	message?: StreamedMessage;
	toolName?: string;
	toolCallId?: string;
	args?: unknown;
	partial?: { content?: Array<{ type?: string; text?: string }>; details?: unknown };
	result?: { content?: Array<{ type?: string; text?: string }>; details?: unknown };
	isError?: boolean;
}

function toNumber(v: unknown): number {
	return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function parseLine(line: string): PiMessageEvent | null {
	if (!line.trim()) return null;
	try {
		const parsed = JSON.parse(line) as PiMessageEvent;
		return parsed && typeof parsed === "object" ? parsed : null;
	} catch {
		return null;
	}
}

function contentText(parts: Array<{ type?: string; text?: string }> | undefined): string | undefined {
	const texts = (parts ?? [])
		.filter((p) => p.type === "text" && typeof p.text === "string")
		.map((p) => p.text as string);
	return texts.length > 0 ? texts.join("\n") : undefined;
}

/** Flattens text to a single line and keeps only the tail (progress display). */
export function textTail(text: string, max = MAX_TRACE_TEXT_CHARS): string {
	const singleLine = text.replace(/\s+/g, " ").trim();
	if (singleLine.length <= max) return singleLine;
	return `…${singleLine.slice(singleLine.length - max)}`;
}

/** Bounded single-line summary of tool call args (never the full payload). */
export function summarizeArgs(args: unknown, max = MAX_TRACE_ARGS_CHARS): string {
	if (args === undefined || args === null) return "";
	let raw: string;
	if (typeof args === "string") raw = args;
	else {
		try {
			raw = JSON.stringify(args);
		} catch {
			return "";
		}
	}
	if (!raw || raw === "{}") return "";
	return textTail(raw, max);
}

function applyUsage(target: RunnerUsage, raw: unknown): void {
	if (raw === null || typeof raw !== "object") return;
	const usage = raw as Record<string, unknown>;
	target.input += toNumber(usage.input);
	target.output += toNumber(usage.output);
	target.cacheRead += toNumber(usage.cacheRead);
	target.cacheWrite += toNumber(usage.cacheWrite);
	const cost = usage.cost as { total?: unknown } | undefined;
	target.cost += toNumber(cost?.total);
	target.contextTokens = Math.max(target.contextTokens, toNumber(usage.totalTokens));
}

function messageText(msg: StreamedMessage): string | undefined {
	for (const part of msg.content ?? []) {
		if (part.type === "text" && typeof part.text === "string" && part.text.length > 0) return part.text;
	}
	return undefined;
}

/**
 * Runs one child pi process in JSON mode and streams sanitized events.
 * Resolves when the child exits; throws on spawn error. Abort kills the
 * child (SIGTERM then SIGKILL after a grace period).
 */
export async function runPiChild(options: PiChildOptions): Promise<PiChildOutcome> {
	const { command, args, cwd, spawn: spawnFn, signal, now, onEvent } = options;
	const nowMs = options.nowMs ?? (() => Date.now());
	const outcome: PiChildOutcome = {
		exitCode: 0,
		events: [],
		usage: emptyUsage(),
		finalText: "",
		stderr: "",
	};

	// --append-system-prompt reads a file path: materialize the prompt
	// into a private temp file (removed on exit).
	let tmpPromptPath: string | null = null;
	let tmpPromptDir: string | null = null;
	/** Releases the SIGKILL timer + abort listener once the child is done. */
	let clearAbort: (() => void) | null = null;
	const appendIndex = args.indexOf("--append-system-prompt");
	if (appendIndex >= 0 && args[appendIndex + 1]?.startsWith("pwr-tmp://")) {
		const promptText = args[appendIndex + 1].slice("pwr-tmp://".length);
		tmpPromptDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pwr-agent-"));
		tmpPromptPath = path.join(tmpPromptDir, "prompt.md");
		await fs.promises.writeFile(tmpPromptPath, promptText, { encoding: "utf-8", mode: 0o600 });
		args[appendIndex + 1] = tmpPromptPath;
	}

	try {
		let spawned: PiChildProcess;
		try {
			spawned = spawnFn(command, args, { cwd });
		} catch (err) {
			throw err instanceof Error ? err : new Error(String(err));
		}

	let buffer = "";
	let exitCode = 0;
	let spawnErrorMessage = "";
	let stoppedByAbort = false;

		spawned.on("error", (err) => {
			spawnErrorMessage = err.message;
		});

		let lastStreamAtMs = Number.NEGATIVE_INFINITY;
		const emit = (ev: AgentEvent) => {
			outcome.events.push(ev);
			try {
				onEvent?.(ev);
			} catch {
				/* observer failures never break the run */
			}
		};

		const processLine = (line: string) => {
			const event = parseLine(line);
			if (!event) return;
			const msg = event.message;
			// Tool-execution events carry no `message` field — they are the
			// per-step trace (tool name + bounded args/output tails) the live
			// view renders. They are sanitized and bounded like every event.
			if (event.type === "tool_execution_start") {
				if (typeof event.toolName === "string" && event.toolName) {
					const argsSummary = summarizeArgs(event.args);
					emit({
						type: "tool_execution_start",
						at: now(),
						toolName: event.toolName,
						...(argsSummary ? { argsSummary } : {}),
					});
				}
				return;
			}
			if (event.type === "tool_execution_update") {
				if (typeof event.toolName === "string" && event.toolName) {
					const tail = textTail(contentText(event.partial?.content) ?? "");
					emit({
						type: "tool_execution_update",
						at: now(),
						toolName: event.toolName,
						...(tail ? { text: tail } : {}),
					});
				}
				return;
			}
			if (event.type === "tool_execution_end") {
				if (typeof event.toolName === "string" && event.toolName) {
					const tail = textTail(contentText(event.result?.content) ?? "");
					emit({
						type: "tool_execution_end",
						at: now(),
						toolName: event.toolName,
						...(tail ? { text: tail } : {}),
						...(event.isError === true ? { isError: true } : {}),
					});
				}
				return;
			}
			if (!msg) return;
			const text = messageText(msg);
			if (event.type === "message_end") {
				if (msg.role === "assistant") {
					outcome.usage.turns++;
					applyUsage(outcome.usage, msg.usage);
					if (msg.model) outcome.model = msg.model;
					if (msg.stopReason) outcome.stopReason = msg.stopReason;
					if (msg.errorMessage) outcome.errorMessage = msg.errorMessage;
				}
				const tail = msg.role === "assistant" && text ? textTail(text) : undefined;
				emit({
					type: "message_end",
					at: now(),
					role: msg.role,
					...(tail ? { text: tail } : {}),
					...(msg.stopReason ? { stopReason: msg.stopReason } : {}),
					...(msg.usage && outcome.usage.turns > 0 ? { usage: { ...outcome.usage } } : {}),
					...(msg.model ? { model: msg.model } : {}),
				});
			} else if (event.type === "message_update") {
				// Live-only channel: throttled streaming text tail (never
				// accumulated into the audit `events` array).
				if (msg.role !== "assistant" || !text) return;
				const ts = nowMs();
				if (ts - lastStreamAtMs < MESSAGE_UPDATE_THROTTLE_MS) return;
				lastStreamAtMs = ts;
				try {
					onEvent?.({ type: "message_update", at: now(), text: textTail(text) });
				} catch {
					/* observer failures never break the run */
				}
			} else if (event.type === "tool_result_end") {
				emit({ type: "tool_result_end", at: now() });
			}
			if (msg.role === "assistant" && text) {
				outcome.finalText = text;
			}
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
				}, KILL_GRACE_MS);
			};
			// PRD §7 shutdown hygiene: once the child has closed (or the
			// spawn failed) the pending SIGKILL timer and the abort listener
			// are released so nothing signals an already-finished child and
			// no timer outlives the run.
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

		exitCode = await exit;
		clearAbort?.();

		emit({ type: "exit", at: now(), exitCode });
		if (spawnErrorMessage) {
			emit({ type: "error", at: now(), code: "AGENT_RUNNER_UNAVAILABLE", message: spawnErrorMessage });
		}
		if (stoppedByAbort) {
			emit({ type: "error", at: now(), code: "AGENT_ABORTED", message: "subagent process killed by abort" });
		}

		outcome.exitCode = exitCode;
		return outcome;
	} finally {
		clearAbort?.();
		if (tmpPromptPath)
			try {
				fs.unlinkSync(tmpPromptPath);
			} catch {
				/* ignore */
			}
		if (tmpPromptDir)
			try {
				fs.rmdirSync(tmpPromptDir);
			} catch {
				/* ignore */
			}
	}
}
