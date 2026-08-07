/**
 * PWR PiAgentRunner — subagent adapter (PRD §5.4, JHL-14)
 *
 * Implements the PWR `run()` contract by adapting the LOCAL `subagent`
 * extension's child-`pi` process mode and agent definitions. The adapter:
 *
 * - validates the agent id against discovered definitions BEFORE any
 *   process starts (unknown agent id → `UNKNOWN_AGENT`, fail fast);
 * - maps `tools: "readonly" | "write"` onto tool allowlists intersected
 *   with the agent definition's own tool declaration;
 * - injects `schema` into the task prompt as a structured-output
 *   instruction and parses the child's final text as JSON when possible;
 * - truncates results (50KB) and summaries (8KB), normalizes usage into
 *   numeric counters, and streams sanitized events;
 * - honours the AbortSignal (SIGTERM → SIGKILL) for pause/stop/shutdown;
 * - is restart-safe: `run()` is stateless per invocation; the runtime
 *   owns attempt counting and never overwrites the audit trail;
 * - degrades cleanly: if the child cannot start the run fails with
 *   `AGENT_RUNNER_UNAVAILABLE` (no implicit fallback to the main agent).
 */

import { RunnerError, RunnerErrorCodes } from "./errors.ts";
import { discoverAgents, findAgent, formatAgentList } from "./discover.ts";
import { defaultSpawn, getPiInvocation, runPiChild, type PiChildOutcome } from "./pi.ts";
import {
	MAX_RESULT_BYTES,
	MAX_SUMMARY_BYTES,
	READONLY_TOOLS,
	WRITE_TOOLS,
	type AgentDefinition,
	type AgentEvent,
	type PiSpawn,
	type RunnerOptions,
	type RunnerUsage,
} from "./types.ts";
import type { AgentRunResult, AgentRunSpec, AgentRunner } from "../engine/interpreter.ts";

const SCHEMA_INSTRUCTION_PREFIX =
	"\n\nRespond with a single JSON object conforming to this JSON Schema (no markdown fences, no prose):\n";

/** Default agent used when a script does not select one via `agent: <id>`. */
export const DEFAULT_AGENT_ID = "worker";

/** UTF-8 safe truncation. */
export function truncateUtf8(text: string, maxBytes: number): string {
	if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
	let truncated = text.slice(0, maxBytes);
	while (Buffer.byteLength(truncated, "utf8") > maxBytes) truncated = truncated.slice(0, -1);
	return truncated;
}

function toJsonSchemaText(schema: unknown): string {
	if (typeof schema === "string") return schema;
	try {
		return JSON.stringify(schema);
	} catch {
		return String(schema);
	}
}

/**
 * Tries to extract a JSON value from model text. Tolerates ```json fences,
 * a bare JSON value, and prose-wrapped JSON: when the direct parse fails,
 * the first `{`…last `}` (or `[`…`]`) span is tried. If even that fails
 * (e.g. prose braces appearing before the real JSON), the caller falls
 * back to the raw text — an acceptable degradation.
 */
export function parseJsonResult(text: string): unknown {
	const stripped = text.trim();
	if (stripped.startsWith("```")) {
		const firstNewline = stripped.indexOf("\n");
		if (firstNewline >= 0) {
			const body = stripped.slice(firstNewline + 1);
			const fence = body.lastIndexOf("```");
			const candidate = (fence >= 0 ? body.slice(0, fence) : body).trim();
			try {
				return JSON.parse(candidate);
			} catch {
				/* fall through */
			}
		}
	}
	try {
		return JSON.parse(stripped);
	} catch {
		/* fall through to the prose-wrapped slice fallback */
	}
	const trySlice = (open: string, close: string): unknown => {
		const start = stripped.indexOf(open);
		const end = stripped.lastIndexOf(close);
		if (start < 0 || end <= start) return undefined;
		try {
			return JSON.parse(stripped.slice(start, end + 1));
		} catch {
			return undefined;
		}
	};
	const sliced = trySlice("{", "}") ?? trySlice("[", "]");
	if (sliced !== undefined) return sliced;
	return undefined;
}

/**
 * Effective tool list = intersection of the agent definition's declared
 * tools and the mode allowlist (readonly strips bash/write/edit even when
 * the agent definition declares them).
 */
export function effectiveTools(agent: AgentDefinition, mode: "readonly" | "write" | undefined): string[] {
	const modeTools = mode === "readonly" ? READONLY_TOOLS : WRITE_TOOLS;
	const declared = agent.tools && agent.tools.length > 0 ? agent.tools : modeTools;
	return modeTools.filter((t) => declared.includes(t));
}

export interface PiAgentRunnerOptions extends RunnerOptions {
	/** Optional precomputed agent list (tests). Defaults to discovery. */
	agents?: AgentDefinition[];
	/**
	 * Dynamic default model resolver, evaluated at launch time (not
	 * construction). When the agent definition does not pin a model, its
	 * value is passed to the child pi as `--model`. Returning undefined
	 * lets the child fall back to its own configured default.
	 */
	defaultModel?: () => string | undefined;
}

export class PiAgentRunner implements AgentRunner {
	private readonly cwd: string;
	private readonly agentScope: "user" | "project" | "both";
	private readonly piCommand: string | undefined;
	private readonly now: () => string;
	private readonly agents: AgentDefinition[];
	private readonly defaultModel: (() => string | undefined) | undefined;
	private spawn: PiSpawn;

	constructor(options: PiAgentRunnerOptions = {}) {
		this.cwd = options.cwd ?? process.cwd();
		this.agentScope = options.agentScope ?? "user";
		this.piCommand = options.piCommand;
		this.spawn = options.spawn ?? defaultSpawn();
		this.now = options.now ?? (() => new Date().toISOString());
		this.agents = options.agents ?? discoverAgents(this.cwd, this.agentScope);
		this.defaultModel = options.defaultModel;
	}

	/** Test seam: replace the spawn factory (defaults to a real child_process.spawn). */
	setSpawn(spawn: PiSpawn): void {
		this.spawn = spawn;
	}

	listAgents(): AgentDefinition[] {
		return [...this.agents];
	}

	/**
	 * The adapter is available when a pi invocation can be resolved.
	 * When unavailable the host must NOT inject the runner, and execution
	 * stays `AGENT_RUNNER_UNAVAILABLE` (never an implicit fallback).
	 */
	isAvailable(): boolean {
		const { command } = this.resolveInvocation([]);
		return command.length > 0;
	}

	private resolveInvocation(args: string[]): { command: string; args: string[] } {
		if (this.piCommand) return { command: this.piCommand, args };
		return getPiInvocation(args);
	}

	private buildArgs(agent: AgentDefinition, tools: string[], task: string, model: string | undefined): string[] {
		const args: string[] = ["--mode", "json", "-p", "--no-session"];
		// Model precedence is resolved once in run(): agent definition pin >
		// per-call agent(..., { model }) option > PWR default resolver
		// (e.g. /pwr-model auto → main session model); undefined → the child
		// pi falls back to its own configured default.
		if (model) args.push("--model", model);
		if (tools.length > 0) args.push("--tools", tools.join(","));
		if (agent.systemPrompt.trim()) {
			args.push("--append-system-prompt", `pwr-tmp://${agent.systemPrompt}`);
		}
		args.push(`Task: ${task}`);
		return args;
	}

	private launch(
		agent: AgentDefinition,
		tools: string[],
		task: string,
		signal: AbortSignal | undefined,
		model: string | undefined,
	): Promise<PiChildOutcome> {
		const { command, args } = this.resolveInvocation(this.buildArgs(agent, tools, task, model));
		return runPiChild({
			command,
			args,
			cwd: this.cwd,
			spawn: this.spawn,
			signal,
			now: this.now,
		});
	}

	private outcomeToResult(outcome: PiChildOutcome, schema: unknown): { result: unknown; summary: string } {
		const rawText = outcome.finalText || outcome.stderr || "(no output)";
		let result: unknown = rawText;
		if (schema !== undefined) {
			const parsed = parseJsonResult(rawText);
			if (parsed !== undefined) {
				// Structured results are bound by the SAME byte budget as text
				// (PRD §5.4): an oversized object/array must never enter the
				// runtime cache un-truncated — serialize and reject with a
				// controlled error instead.
				const serialized = JSON.stringify(parsed);
				if (serialized !== undefined && Buffer.byteLength(serialized, "utf8") > MAX_RESULT_BYTES) {
					throw new RunnerError(
						RunnerErrorCodes.RESULT_TOO_LARGE,
						`Structured agent result exceeds the ${MAX_RESULT_BYTES}-byte limit and was rejected.`,
					);
				}
				result = parsed;
			}
		}
		if (typeof result === "string") {
			result = truncateUtf8(result, MAX_RESULT_BYTES);
		}
		const summary = truncateUtf8(rawText, MAX_SUMMARY_BYTES);
		return { result, summary };
	}

	private outcomeToUsage(outcome: PiChildOutcome): Record<string, unknown> {
		const usage: Record<string, unknown> = { ...outcome.usage };
		if (outcome.model) usage.model = outcome.model;
		return usage;
	}

	async run(spec: AgentRunSpec): Promise<AgentRunResult> {
		// The script selects an agent via agent(prompt, { agent: <id> });
		// without one, the P0 default agent is used. label is a stage label,
		// never an agent id. Unknown ids fail BEFORE launching any process.
		const agentId = spec.agentId ?? DEFAULT_AGENT_ID;
		const agent = findAgent(this.agents, agentId);
		if (!agent) {
			throw new RunnerError(
				RunnerErrorCodes.UNKNOWN_AGENT,
				`Unknown agent id "${agentId}". Available agents: ${formatAgentList(this.agents)}.`,
			);
		}

		const tools = effectiveTools(agent, spec.tools);
		const schema = spec.schema;
		const schemaInstruction =
			schema !== undefined ? `${SCHEMA_INSTRUCTION_PREFIX}${toJsonSchemaText(schema)}` : "";
		const task = spec.prompt + schemaInstruction;
		// Single resolution point: agent definition pin > per-call option >
		// PWR default resolver. undefined → no --model, child pi default.
		const model = agent.model ?? spec.model ?? this.defaultModel?.();

		// Abort check before launch: never start a process for an already
		// cancelled run.
		if (spec.signal?.aborted) {
			throw new RunnerError(RunnerErrorCodes.AGENT_ABORTED, "Agent run aborted");
		}

		let outcome: PiChildOutcome;
		try {
			outcome = await this.launch(agent, tools, task, spec.signal, model);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			throw new RunnerError(
				RunnerErrorCodes.AGENT_RUNNER_UNAVAILABLE,
				`Failed to start pi subprocess: ${message}`,
			);
		}

		if (spec.signal?.aborted) {
			throw new RunnerError(RunnerErrorCodes.AGENT_ABORTED, "Agent run aborted");
		}
		if (outcome.stopReason === "error" || outcome.errorMessage) {
			throw new RunnerError(
				RunnerErrorCodes.AGENT_EXECUTION_ERROR,
				truncateUtf8(outcome.errorMessage || outcome.stderr || "LLM error", MAX_SUMMARY_BYTES),
			);
		}
		if (outcome.exitCode !== 0) {
			throw new RunnerError(
				RunnerErrorCodes.AGENT_EXECUTION_ERROR,
				truncateUtf8(
					`pi exited with code ${outcome.exitCode}: ${outcome.stderr || outcome.finalText || "(no output)"}`,
					MAX_SUMMARY_BYTES,
				),
			);
		}

		const { result, summary } = this.outcomeToResult(outcome, schema);
		return {
			result,
			summary,
			usage: this.outcomeToUsage(outcome),
			events: outcome.events,
		};
	}
}

export type { AgentEvent, RunnerUsage };
export * from "./errors.ts";
export * from "./discover.ts";
export * from "./pi.ts";
