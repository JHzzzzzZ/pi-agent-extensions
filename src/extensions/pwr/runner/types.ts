/**
 * PWR PiAgentRunner — shared contracts (JHL-14)
 *
 * The adapter fixes its own contract (PRD 5.4) and adapts the LOCAL
 * `subagent` extension's *patterns* (child `pi` process in JSON mode,
 * agent definitions discovered from `~/.pi/agent/agents`), never its
 * private implementation. Everything the adapter needs from the host is
 * the public @earendil-works/pi-coding-agent API.
 */

/** Tool allowlist for `tools: "readonly"` (read-only intel only). */
export const READONLY_TOOLS: readonly string[] = ["read", "grep", "find", "ls", "glob"];

/** Tool allowlist for `tools: "write"` (agent may modify files / run commands). */
export const WRITE_TOOLS: readonly string[] = ["read", "grep", "find", "ls", "glob", "bash", "write", "edit"];

/** Maximum result payload returned by run() (bytes, UTF-8). Mirrors the 50KB per-task cap. */
export const MAX_RESULT_BYTES = 50 * 1024;

/** Maximum summary text returned by run() (bytes, UTF-8). */
export const MAX_SUMMARY_BYTES = 8 * 1024;

/** One discovered agent definition (PWR-owned view of a `*.md` agent file). */
export interface AgentDefinition {
	name: string;
	description: string;
	tools?: string[];
	model?: string;
	systemPrompt: string;
	source: "user" | "project" | "builtin";
	filePath: string;
}

/** Normalized usage counters (PRD 5.4 `usage?`). Numbers only, runtime-agnostic. */
export interface RunnerUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
	model?: string;
}

/** Upper bound for any single sanitized trace text (assistant tails, tool output tails). */
export const MAX_TRACE_TEXT_CHARS = 200;

/** Upper bound for the sanitized tool-args summary attached to tool_execution_start. */
export const MAX_TRACE_ARGS_CHARS = 120;

/**
 * Lightweight sanitized event stream (PRD 5.4 `events`). Never raw tool
 * output: every text is single-line and tail-truncated to the caps above.
 * `message_update` exists only on the live onEvent channel (never
 * accumulated into the post-hoc audit array).
 */
export type AgentEvent =
	| {
			type: "message_end";
			at: string;
			role: string;
			/** Single-line tail of the assistant text (sanitized, live trace only). */
			text?: string;
			stopReason?: string;
			usage?: RunnerUsage;
			model?: string;
	  }
	| { type: "message_update"; at: string; text: string }
	| { type: "tool_execution_start"; at: string; toolName: string; argsSummary?: string }
	| { type: "tool_execution_update"; at: string; toolName: string; text?: string }
	| { type: "tool_execution_end"; at: string; toolName: string; text?: string; isError?: boolean }
	| { type: "tool_result_end"; at: string }
	| { type: "error"; at: string; code: string; message: string }
	| { type: "exit"; at: string; exitCode: number };

export interface RunnerOptions {
	/** Working directory for child pi processes. Defaults to process.cwd(). */
	cwd?: string;
	/** Agent discovery scope: "user" (default), "project", or "both". */
	agentScope?: "user" | "project" | "both";
	/** Explicit pi command override (default: resolved from the host runtime). */
	piCommand?: string;
	/** Test seam: spawn factory. Defaults to a real child_process.spawn wrapper. */
	spawn?: PiSpawn;
	/** Test seam: clock. */
	now?: () => string;
}

/** Minimal child-process surface the adapter needs (testable without real processes). */
export interface PiChildProcess {
	stdout: { on(event: "data", cb: (chunk: unknown) => void): void };
	stderr: { on(event: "data", cb: (chunk: unknown) => void): void };
	on(event: "close", cb: (code: number | null) => void): void;
	on(event: "error", cb: (err: Error) => void): void;
	kill(signal: string): boolean;
}

export type PiSpawn = (command: string, args: string[], opts: { cwd?: string }) => PiChildProcess;
