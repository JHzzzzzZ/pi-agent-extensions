/**
 * PWR runtime — run state machine, scheduler, private cache and
 * persistence (JHL-13)
 *
 * WorkflowRuntime implements the RuntimeAdapter contract consumed by
 * JHL-16 (src/types.ts): `start` / `control` / `onRunSettled`. It owns:
 *
 * - the PRD 5.3 run state machine (every transition is persisted);
 * - the FIFO run scheduler with per-run semaphores (hard cap 128) enforced
 *   by the script interpreter, plus the cumulative 1,000-agent budget
 *   enforced here (cache hits do not consume the budget);
 * - the run-private result cache keyed by `script digest + normalized
 *   input`, so pause/resume and same-session re-runs replay completed
 *   agents instead of re-executing them;
 * - the `pi-workflow-run-v1` entry persistence (metadata/status/summary/
 *   cache index only — never source, prompts, raw output or credentials);
 * - final-summary delivery exactly once per run after ITS OWN final agent
 *   settles (`onFinalResult`), plus per-run settle notifications
 *   (`onRunSettled`);
 * - session shutdown: abort controllers so subprocesses/timers are
 *   cancelled and non-terminal runs are marked cancelled.
 */

import { randomUUID } from "node:crypto";
import {
	ErrorCodes,
	ScriptError,
	ScriptInterpreter,
	clampConcurrency,
	clampMaxAgents,
	type AgentRunResult,
	type AgentRunner,
	type AgentRunSpec,
	type RunResult,
} from "../engine/index.ts";
import { RunnerError } from "../runner/errors.ts";
import type { RuntimeAdapter, WorkflowPlan, WorkflowRunView, WorkflowScript } from "../src/types.ts";
import { extractPlan as extractStaticPlan } from "../src/plan.ts";
import { truncateJsonSummary } from "../src/notify.ts";
import { RunCache, cacheKey, type CacheEntry, type NormalizedAgentInput } from "./cache.ts";
import { RuntimeError } from "./errors.ts";
import {
	MemoryPersister,
	sanitizeUsage,
	serializeRunEntry,
	truncateError,
	truncateSummary,
	type RunPersister,
} from "./persist.ts";
import { RunScheduler } from "./scheduler.ts";
import { ALLOWED_OPERATIONS, assertTransition, isTerminal } from "./state.ts";
import type { RunEvent } from "../src/ui/types.ts";
import {
	MAX_FINAL_SUMMARY_SIZE,
	type AgentTask,
	type AgentTaskStatus,
	type RunStage,
	type RuntimeRunView,
	type StageStatus,
	type WorkflowRun,
} from "./types.ts";

export interface RuntimeOptions {
	/** Agent runner adapter; agent() fails with AGENT_RUNNER_UNAVAILABLE when absent. */
	runner?: AgentRunner;
	/** Effective per-run concurrency, clamped to [1, 128]. Default 4. */
	concurrency?: number;
	/** Agent execution budget, clamped to [1, 1000]. Default 1000. */
	maxAgents?: number;
	/** Persists the `pi-workflow-run-v1` entry on every state change. */
	persister?: RunPersister;
	/** Cap on concurrently active runs (FIFO ordering). Default: unlimited. */
	maxActiveRuns?: number;
	now?(): string;
}

interface RuntimeRunState {
	run: WorkflowRun;
	script: WorkflowScript;
	plan: WorkflowPlan;
	onFinalResult?: (summary: string) => void;
	/**
	 * Untruncated final return JSON (may exceed the 8KB state/persist cap).
	 * Delivered only via onFinalResult so the main session can recover the
	 * full result; state/persisted views stay bounded.
	 */
	fullSummary?: string;
	controller: AbortController | null;
	executor: () => Promise<void>;
	tasks: Map<string, AgentTask>;
	tasksByInput: Map<string, AgentTask>;
	stages: Map<string, RunStage>;
	callSeq: number;
	settled: boolean;
	/**
	 * Execution generation. Bumped by every lifecycle-altering control
	 * action (pause/stop/shutdown/restart). An executor that captured an
	 * older generation is superseded and must never modify the run's
	 * status, summary, cache or task records — this isolates cancelled
	 * executors whose runners ignore the abort signal (pause/resume race).
	 */
	generation: number;
}

function formatSummary(value: unknown): string {
	if (value === undefined) return "(no final value)";
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}

function errorCodeOf(err: unknown): string {
	if (err instanceof ScriptError) return err.code;
	if (err instanceof RuntimeError) return err.code;
	if (err instanceof RunnerError) return err.code;
	return "SCRIPT_RUNTIME_ERROR";
}

/** Truncated, persisted-safe error message from an unknown thrown value. */
function errorMessageOf(err: unknown): string | undefined {
	return err instanceof Error ? truncateError(err.message) : undefined;
}

/**
 * Session-scoped workflow runtime. One instance = one Pi session: the
 * cache and run registry are session-private and never persisted beyond
 * the metadata entry.
 */
export class WorkflowRuntime implements RuntimeAdapter {
	private readonly runs = new Map<string, RuntimeRunState>();
	private readonly cache = new RunCache();
	private readonly scheduler: RunScheduler;
	private readonly persister: RunPersister;
	private runner?: AgentRunner;
	private readonly defaultConcurrency: number | undefined;
	private readonly defaultMaxAgents: number | undefined;
	private readonly nowFn: () => string;
	private readonly settleHandlers = new Set<(runId: string) => void>();
	/** JHL-15 /workflows UI event feed subscribers. */
	private readonly eventHandlers = new Set<(ev: RunEvent) => void>();
	private shutDown = false;

	constructor(options: RuntimeOptions = {}) {
		this.runner = options.runner;
		this.defaultConcurrency = options.concurrency;
		this.defaultMaxAgents = options.maxAgents;
		this.scheduler = new RunScheduler(options.maxActiveRuns);
		this.persister = options.persister ?? new MemoryPersister();
		this.nowFn = options.now ?? (() => new Date().toISOString());
	}

	// ------------------------------------------------------------------
	// RuntimeAdapter contract (JHL-16)
	// ------------------------------------------------------------------

	async start(spec: {
		runId: string;
		script: WorkflowScript;
		args?: unknown;
		onFinalResult?: (summary: string) => void;
	}): Promise<{ runId: string; status: "running" }> {
		if (this.shutDown) throw new RuntimeError("SESSION_SHUTDOWN");
		const existing = this.runs.get(spec.runId);
		if (existing) {
			// Re-run from a terminal state (completed/failed/cancelled).
			if (isTerminal(existing.run.status)) {
				this.enqueueRestart(existing);
				return { runId: spec.runId, status: "running" };
			}
			throw new RuntimeError("RUN_NOT_CONTROLLABLE", { runId: spec.runId });
		}

		const run: WorkflowRun = {
			runId: spec.runId,
			scriptId: spec.script.scriptId,
			digest: spec.script.digest,
			meta: {
				name: spec.script.meta.name ?? "untitled",
				description: spec.script.meta.description,
				version: spec.script.meta.version,
			},
			status: "queued",
			createdAt: this.nowFn(),
			concurrency: clampConcurrency(this.defaultConcurrency),
			maxAgents: clampMaxAgents(this.defaultMaxAgents),
			agentExecutions: 0,
		};
		if (spec.args !== undefined) run.args = spec.args;

		let plan: WorkflowPlan;
		try {
			plan = extractStaticPlan(spec.script.source);
		} catch {
			// A validated script always yields a plan; never let plan
			// extraction break execution.
			plan = {
				stages: [],
				budget: {
					agentCalls: 0,
					pipelineCalls: 0,
					parallelCalls: 0,
					estimatedAgents: 0,
					writeRisk: false,
					warnLargeRun: false,
				},
			};
		}

		const state: RuntimeRunState = {
			run,
			script: spec.script,
			plan,
			onFinalResult: spec.onFinalResult,
			controller: null,
			executor: () => this.execute(state),
			tasks: new Map(),
			tasksByInput: new Map(),
			stages: new Map(),
			callSeq: 0,
			settled: false,
			generation: 0,
		};
		this.runs.set(spec.runId, state);
		this.persist(state);
		this.emitRunStatus(state);
		this.scheduler.enqueue(spec.runId, state.executor);
		return { runId: spec.runId, status: "running" };
	}

	async control(input: {
		runId: string;
		action: "pause" | "resume" | "stop" | "restart_agent";
		agentId?: string;
	}): Promise<{ run: WorkflowRunView }> {
		const state = this.runs.get(input.runId);
		if (!state) throw new RuntimeError("RUN_NOT_FOUND", { runId: input.runId });
		const { runId } = input;

		switch (input.action) {
			case "pause": {
				assertTransition(state.run.status, "paused");
				state.run.status = "paused";
				// The in-flight executor is superseded: a stale generation can
				// no longer touch the run lifecycle, cache or task records,
				// even if its runner ignores the abort and finishes late.
				state.generation++;
				this.cancelInFlightTasks(state);
				this.persist(state);
				this.emitRunStatus(state);
				this.scheduler.dequeue(runId);
				// Cooperative cancellation of in-flight agents; cached
				// completed tasks are untouched.
				state.controller?.abort();
				break;
			}
			case "resume": {
				assertTransition(state.run.status, "queued");
				state.run.status = "queued";
				this.persist(state);
				this.emitRunStatus(state);
				// If the old executor is still winding down, the scheduler
				// re-inserts the run the moment it settles (resume pending);
				// otherwise it is re-dispatched immediately at the head.
				this.scheduler.enqueueFront(runId, state.executor);
				break;
			}
			case "stop": {
				assertTransition(state.run.status, "cancelled");
				state.run.status = "cancelled";
				state.run.endedAt = this.nowFn();
				state.generation++;
				this.cancelInFlightTasks(state);
				this.persist(state);
				this.emitRunStatus(state);
				this.scheduler.dequeue(runId);
				state.controller?.abort();
				this.settle(state);
				break;
			}
			case "restart_agent": {
				if (!input.agentId) throw new RuntimeError("AGENT_NOT_RESTARTABLE", { runId });
				// PRD §5.3: restart_agent belongs to queued/running lifecycles
				// only; terminal runs are view/save/run_again only and must
				// not resurrect historical tasks or delete their cache.
				if (!ALLOWED_OPERATIONS[state.run.status].includes("restart_agent")) {
					throw new RuntimeError("RUN_NOT_CONTROLLABLE", { runId });
				}
				this.restartAgent(state, input.agentId);
				break;
			}
			default:
				throw new RuntimeError("RUN_NOT_CONTROLLABLE", { runId });
		}
		return { run: this.buildView(state) };
	}

	/** Registers the per-run settle observer (JHL-16 notifier gate). */
	onRunSettled(handler: (runId: string) => void): void {
		this.settleHandlers.add(handler);
	}

	/**
	 * Injects (or clears) the agent runner adapter (JHL-14). When absent,
	 * agent() fails with AGENT_RUNNER_UNAVAILABLE — never an implicit
	 * fallback. Session-scoped: call before starting runs.
	 */
	setRunner(runner?: AgentRunner): void {
		this.runner = runner;
	}

	/** JHL-15 contract: subscribe to the run/task/summary event feed (/workflows UI). */
	onEvent(handler: (ev: RunEvent) => void): void {
		this.eventHandlers.add(handler);
	}

	// ------------------------------------------------------------------
	// Event feed (JHL-15 /workflows UI)
	// ------------------------------------------------------------------

	private emit(ev: RunEvent): void {
		for (const handler of this.eventHandlers) {
			try {
				handler(ev);
			} catch {
				// Observer errors never break the runtime.
			}
		}
	}

	/** Emits the run-status event for the CURRENT status (call after persisting). */
	private emitRunStatus(state: RuntimeRunState): void {
		this.emit({ type: "run_status", runId: state.run.runId, status: state.run.status, at: this.nowFn() });
	}

	/** Emits a task-status event (attempt carries the audit counter). */
	private emitTaskStatus(state: RuntimeRunState, task: AgentTask): void {
		this.emit({
			type: "task_status",
			runId: state.run.runId,
			taskId: task.taskId,
			stageId: task.stageId,
			status: task.status,
			attempt: task.attempt,
			at: this.nowFn(),
		});
	}

	// ------------------------------------------------------------------
	// Runtime-owned extras
	// ------------------------------------------------------------------

	/** Re-run from a terminal state (completed/failed/cancelled → queued). */
	async restart(runId: string): Promise<RuntimeRunView> {
		if (this.shutDown) throw new RuntimeError("SESSION_SHUTDOWN");
		const state = this.runs.get(runId);
		if (!state) throw new RuntimeError("RUN_NOT_FOUND", { runId });
		this.enqueueRestart(state);
		return this.buildView(state);
	}

	getRun(runId: string): WorkflowRun | undefined {
		return this.runs.get(runId)?.run;
	}

	view(runId: string): RuntimeRunView {
		const state = this.runs.get(runId);
		if (!state) throw new RuntimeError("RUN_NOT_FOUND", { runId });
		return this.buildView(state);
	}

	list(): RuntimeRunView[] {
		return [...this.runs.values()].map((state) => this.buildView(state));
	}

	/**
	 * Session shutdown: abort all controllers (cancels subprocesses and
	 * timers) and mark non-terminal runs cancelled. Called from the Pi
	 * session shutdown hook; a new session gets a fresh runtime.
	 */
	shutdown(): void {
		this.shutDown = true;
		for (const state of this.runs.values()) {
			if (isTerminal(state.run.status)) continue;
			state.run.status = "cancelled";
			state.run.endedAt = this.nowFn();
			state.generation++;
			this.cancelInFlightTasks(state);
			state.controller?.abort();
			this.scheduler.dequeue(state.run.runId);
			this.persist(state);
			this.emitRunStatus(state);
			this.settle(state);
		}
		this.settleHandlers.clear();
	}

	// ------------------------------------------------------------------
	// Execution
	// ------------------------------------------------------------------

	private enqueueRestart(state: RuntimeRunState): void {
		assertTransition(state.run.status, "queued");
		state.run.status = "queued";
		state.run.summary = undefined;
		state.fullSummary = undefined;
		state.run.errorCode = undefined;
		state.run.startedAt = undefined;
		state.run.endedAt = undefined;
		// Re-running from the script is a fresh lifecycle for budget purposes.
		state.run.agentExecutions = 0;
		state.settled = false;
		// Fresh generation: any executor from the previous lifecycle is stale.
		state.generation++;
		this.persist(state);
		this.emitRunStatus(state);
		this.scheduler.enqueue(state.run.runId, state.executor);
	}

	private async execute(state: RuntimeRunState): Promise<void> {
		if (state.run.status !== "queued") return;
		const generation = state.generation;
		assertTransition(state.run.status, "running");
		state.run.status = "running";
		state.run.startedAt ??= this.nowFn();
		this.persist(state);
		this.emitRunStatus(state);

		const controller = new AbortController();
		state.controller = controller;
		try {
			const result = await new ScriptInterpreter().execute(state.script.source, {
				runner: this.makeRunner(state, generation),
				args: state.run.args as Record<string, unknown> | undefined,
				concurrency: state.run.concurrency,
				maxAgents: state.run.maxAgents,
				signal: controller.signal,
			});
			// The interpreter awaits every agent()/pipeline()/parallel()
			// call, so resolving here means all agents of THIS run have
			// settled. Only now may the final return reach the main session.
			this.complete(state, result, generation);
		} catch (err) {
			this.failOrKeep(state, err, generation);
		} finally {
			// Only the current-generation executor may clear the controller;
			// a superseded executor must not clobber the resumed run's one.
			if (state.generation === generation) state.controller = null;
		}
	}

	private complete(state: RuntimeRunState, result: RunResult, generation: number): void {
		if (state.generation !== generation) return; // superseded executor
		if (state.run.status === "paused" || state.run.status === "cancelled") return;
		assertTransition(state.run.status, "completed");
		state.run.status = "completed";
		state.fullSummary = formatSummary(result.value);
		state.run.summary = truncateJsonSummary(state.fullSummary, MAX_FINAL_SUMMARY_SIZE);
		state.run.errorCode = undefined;
		state.run.errorMessage = undefined;
		state.run.endedAt = this.nowFn();
		this.persist(state);
		this.emitRunStatus(state);
		this.emit({ type: "summary", runId: state.run.runId, summary: state.run.summary ?? "", at: this.nowFn() });
		this.settle(state);
	}

	private failOrKeep(state: RuntimeRunState, err: unknown, generation: number): void {
		if (state.generation !== generation) return; // superseded executor
		const status = state.run.status;
		if (status === "paused" || status === "cancelled") {
			// User-initiated interruption; the control action already
			// persisted the status. Do not downgrade to failed.
			state.run.endedAt ??= this.nowFn();
			this.persist(state);
			if (status === "cancelled") this.settle(state);
			return;
		}
		assertTransition(status, "failed");
		state.run.status = "failed";
		state.run.errorCode = errorCodeOf(err);
		state.run.errorMessage = errorMessageOf(err);
		state.run.endedAt = this.nowFn();
		this.persist(state);
		this.emitRunStatus(state);
		this.settle(state);
	}

	/**
	 * Marks tasks that are mid-flight as cancelled AT CONTROL TIME (pause/
	 * stop/shutdown). The superseded executor's own late completion path is
	 * generation-isolated and cannot resurrect or overwrite them.
	 */
	private cancelInFlightTasks(state: RuntimeRunState): void {
		for (const task of state.tasks.values()) {
			if (task.status === "running") {
				this.markTask(state, task, "cancelled", undefined);
			}
		}
	}

	/** Delivers the final summary (completed only), then per-run settle. */
	private settle(state: RuntimeRunState): void {
		if (state.settled) return;
		state.settled = true;
		const runId = state.run.runId;
		if (state.run.status === "completed") {
			try {
				state.onFinalResult?.(state.fullSummary ?? state.run.summary ?? "");
			} catch {
				// Observer errors never break the runtime.
			}
		}
		for (const handler of this.settleHandlers) {
			try {
				handler(runId);
			} catch {
				// Observer errors never break the runtime.
			}
		}
	}

	private makeRunner(state: RuntimeRunState, generation: number): AgentRunner {
		return {
			run: async (spec: AgentRunSpec) => this.dispatch(state, generation, spec),
		};
	}

	// ------------------------------------------------------------------
	// Agent dispatch (private cache + budget + task/stage bookkeeping)
	// ------------------------------------------------------------------

	private async dispatch(state: RuntimeRunState, generation: number, spec: AgentRunSpec): Promise<AgentRunResult> {
		const input: NormalizedAgentInput = {
			prompt: spec.prompt,
			label: spec.label,
			tools: spec.tools,
			schema: spec.schema,
		};
		const key = cacheKey(state.script.digest, input);
		const stage = this.ensureStage(state, spec.label);
		const existing = state.tasksByInput.get(key);

		// Cache hit: replay the completed agent without executing it. A
		// hit applies when there is no task record yet (cross-run reuse) or
		// the record is completed (resume replay). A failed/cancelled/
		// queued record always re-dispatches.
		const cached = this.cache.get(key);
		if (cached && (!existing || existing.status === "completed")) {
			this.recordCacheHit(state, stage, existing, key, cached);
			return { result: cached.result, summary: cached.summary, usage: cached.usage };
		}

		// The cumulative 1,000-agent budget counts REAL dispatches; cache
		// replays never consume it.
		if (state.run.agentExecutions >= state.run.maxAgents) {
			throw new ScriptError(
				ErrorCodes.AGENT_LIMIT_EXCEEDED,
				`单次运行 agent() 执行超过硬上限 ${state.run.maxAgents}`,
			);
		}
		state.run.agentExecutions++;

		if (!this.runner) {
			const task = this.beginTask(state, stage, existing, key);
			this.markTask(state, task, "failed", ErrorCodes.AGENT_RUNNER_UNAVAILABLE, undefined, undefined, "Agent runner 不可用（未注入 runner）");
			this.persist(state);
			throw new ScriptError(ErrorCodes.AGENT_RUNNER_UNAVAILABLE, "Agent runner 不可用（未注入 runner）");
		}

		const task = this.beginTask(state, stage, existing, key);
		try {
			const result = await this.runner.run({
				runId: state.run.runId,
				// JHL-14: agentId is the discovered agent name (script may
				// select it via agent(prompt, { agent })); unknown ids fail
				// in the runner adapter BEFORE any process starts.
				agentId: spec.agentId,
				prompt: spec.prompt,
				label: spec.label,
				tools: spec.tools,
				schema: spec.schema,
				// JHL-14 fix: forward the per-call model override (agent
				// definition pin > per-call option > PWR default resolver).
				model: spec.model,
				signal: spec.signal,
			});
			if (state.generation !== generation) {
				// Superseded executor: its late result must not touch the
				// cache, task records or persistence of the (possibly
				// resumed) run. The dying interpreter aborts at its next
				// checkpoint anyway.
				return { result: result.result, summary: result.summary ?? "", usage: result.usage };
			}
			const entry: CacheEntry = {
				key,
				scriptDigest: state.script.digest,
				taskId: task.taskId,
				result: result.result,
				summary: result.summary ?? "",
				usage: sanitizeUsage(result.usage),
				createdAt: this.nowFn(),
			};
			this.cache.set(entry);
			this.markTask(state, task, "completed", undefined, result.summary ?? "", result.usage);
			this.persist(state);
			return { result: result.result, summary: result.summary ?? "", usage: result.usage };
		} catch (err) {
			if (state.generation === generation) {
				const aborted = spec.signal?.aborted === true;
				this.markTask(state, task, aborted ? "cancelled" : "failed", errorCodeOf(err), undefined, undefined, errorMessageOf(err));
				this.persist(state);
				this.emit({ type: "task_result", runId: state.run.runId, taskId: task.taskId, error: task.errorMessage, at: this.nowFn() });
			}
			throw err;
		}
	}

	private beginTask(
		state: RuntimeRunState,
		stage: RunStage,
		existing: AgentTask | undefined,
		key: string,
	): AgentTask {
		if (existing) {
			// A task explicitly re-queued by restart_agent already carries
			// its next attempt number; a retry of a failed/cancelled task
			// gets a fresh attempt so the audit trail grows.
			if (existing.status !== "queued") existing.attempt++;
			existing.status = "running";
			existing.errorCode = undefined;
			existing.errorMessage = undefined;
			existing.endedAt = undefined;
			existing.startedAt = this.nowFn();
			this.attachToStage(state, stage, existing);
			this.emitTaskStatus(state, existing);
			return existing;
		}
		const task: AgentTask = {
			taskId: randomUUID(),
			stageId: stage.stageId,
			label: stage.label,
			inputDigest: key,
			status: "running",
			attempt: 1,
			startedAt: this.nowFn(),
		};
		state.tasks.set(task.taskId, task);
		state.tasksByInput.set(key, task);
		this.attachToStage(state, stage, task);
		this.emitTaskStatus(state, task);
		return task;
	}

	private markTask(
		state: RuntimeRunState,
		task: AgentTask,
		status: AgentTaskStatus,
		errorCode?: string,
		summary?: string,
		usage?: Record<string, unknown>,
		errorMessage?: string,
	): void {
		task.status = status;
		task.errorCode = errorCode;
		if (errorMessage !== undefined) task.errorMessage = errorMessage;
		if (summary !== undefined) task.summary = truncateSummary(summary);
		if (usage !== undefined) task.usage = sanitizeUsage(usage);
		if (status === "completed" || status === "failed" || status === "cancelled") {
			task.endedAt = this.nowFn();
		}
		this.emitTaskStatus(state, task);
	}

	private restartAgent(state: RuntimeRunState, agentId: string): void {
		const task = state.tasks.get(agentId);
		if (!task) {
			throw new RuntimeError("AGENT_NOT_RESTARTABLE", { runId: state.run.runId, taskId: agentId });
		}
		// Invalidate the private cache entry so the next dispatch of the
		// same input re-executes the agent; the attempt counter grows so
		// the audit trail is preserved (previous states are not overwritten).
		this.cache.delete(task.inputDigest);
		task.attempt++;
		task.status = "queued";
		task.errorCode = undefined;
		task.errorMessage = undefined;
		task.endedAt = undefined;
		this.emitTaskStatus(state, task);
		this.persist(state);
	}

	/**
	 * A cache hit (cross-run reuse or resume replay) still produces a
	 * completed task record for THIS run so the /workflows view stays
	 * accurate. Full results stay in the private cache only.
	 */
	private recordCacheHit(
		state: RuntimeRunState,
		stage: RunStage,
		existing: AgentTask | undefined,
		key: string,
		entry: CacheEntry,
	): void {
		if (existing) {
			if (existing.summary !== entry.summary || existing.usage !== entry.usage) {
				existing.summary = entry.summary;
				existing.usage = entry.usage;
				this.attachToStage(state, stage, existing);
			}
			return;
		}
		const task: AgentTask = {
			taskId: randomUUID(),
			stageId: stage.stageId,
			label: stage.label,
			inputDigest: key,
			status: "completed",
			attempt: 1,
			summary: entry.summary,
			usage: entry.usage,
			startedAt: entry.createdAt,
			endedAt: entry.createdAt,
		};
		state.tasks.set(task.taskId, task);
		state.tasksByInput.set(key, task);
		this.attachToStage(state, stage, task);
		this.emitTaskStatus(state, task);
	}

	// ------------------------------------------------------------------
	// Stages
	// ------------------------------------------------------------------

	private ensureStage(state: RuntimeRunState, label: string | undefined): RunStage {
		// Anonymous agent() calls are numbered by dispatch order (PRD 5.3:
		// "无 label 时使用调用序号").
		const stageLabel = label ?? `agent-${++state.callSeq}`;
		for (const stage of state.stages.values()) {
			if (stage.label === stageLabel) return stage;
		}
		const planItem = state.plan.stages.find((s) => s.label === stageLabel);
		const stage: RunStage = {
			stageId: `stage-${state.stages.size + 1}`,
			label: stageLabel,
			kind: planItem?.kind ?? "agent",
			agentCount: planItem?.agentCount ?? 1,
			dynamic: planItem?.dynamic ?? false,
			writeRisk: planItem?.writeRisk ?? false,
			status: "queued",
			agentIds: [],
			elapsedMs: 0,
			createdAt: this.nowFn(),
		};
		state.stages.set(stage.stageId, stage);
		return stage;
	}

	private attachToStage(state: RuntimeRunState, stage: RunStage, task: AgentTask): void {
		if (!stage.agentIds.includes(task.taskId)) stage.agentIds.push(task.taskId);
	}

	/** Stage status is derived from its tasks (and the run state) at view time. */
	private deriveStageStatus(state: RuntimeRunState, stage: RunStage): StageStatus {
		let hasRunning = false;
		let hasQueued = false;
		let hasFailed = false;
		let hasCancelled = false;
		let any = false;
		for (const task of state.tasks.values()) {
			if (task.stageId !== stage.stageId) continue;
			any = true;
			switch (task.status) {
				case "running":
					hasRunning = true;
					break;
				case "queued":
					hasQueued = true;
					break;
				case "failed":
					hasFailed = true;
					break;
				case "cancelled":
					hasCancelled = true;
					break;
				default:
					break;
			}
		}
		if (!any) return "queued";
		let status: StageStatus;
		if (hasRunning) {
			status = "running";
		} else if (hasQueued) {
			status = "queued";
		} else if (hasFailed) {
			status = "failed";
		} else if (hasCancelled) {
			status = "failed";
		} else {
			status = "completed";
		}
		if (state.run.status === "paused" && status !== "completed") status = "paused";
		return status;
	}

	private stageElapsed(stage: RunStage, state: RuntimeRunState): number {
		let minStart = Number.POSITIVE_INFINITY;
		let maxEnd = 0;
		for (const task of state.tasks.values()) {
			if (task.stageId !== stage.stageId) continue;
			if (task.startedAt) {
				const ms = Date.parse(task.startedAt);
				if (Number.isFinite(ms)) minStart = Math.min(minStart, ms);
			}
			if (task.endedAt) {
				const ms = Date.parse(task.endedAt);
				if (Number.isFinite(ms)) maxEnd = Math.max(maxEnd, ms);
			}
		}
		if (!Number.isFinite(minStart)) return 0;
		const end = maxEnd > 0 ? maxEnd : Date.now();
		return Math.max(0, end - minStart);
	}

	// ------------------------------------------------------------------
	// Views / persistence
	// ------------------------------------------------------------------

	private buildView(state: RuntimeRunState): RuntimeRunView {
		const stages: RunStage[] = [...state.stages.values()].map((stage) => ({
			...stage,
			status: this.deriveStageStatus(state, stage),
			elapsedMs: this.stageElapsed(stage, state),
		}));
		const tasks: AgentTask[] = [...state.tasks.values()].sort((a, b) =>
			(a.startedAt ?? "").localeCompare(b.startedAt ?? ""),
		);
		const run = state.run;
		const staticBudget = state.plan.budget;
		return {
			runId: run.runId,
			scriptId: run.scriptId,
			scriptName: run.meta.name,
			status: run.status,
			digest: run.digest,
			createdAt: run.createdAt,
			startedAt: run.startedAt,
			endedAt: run.endedAt,
			summary: run.summary,
			errorCode: run.errorCode,
			errorMessage: run.errorMessage,
			args: run.args,
			budget: {
				agentCalls: run.agentExecutions,
				pipelineCalls: staticBudget.pipelineCalls,
				parallelCalls: staticBudget.parallelCalls,
				estimatedAgents: staticBudget.estimatedAgents,
				writeRisk: staticBudget.writeRisk,
				warnLargeRun: staticBudget.warnLargeRun,
				maxAgents: run.maxAgents,
				concurrency: run.concurrency,
			},
			stages,
			tasks,
		};
	}

	/** Persists the `pi-workflow-run-v1` entry — metadata/status/summary/index only. */
	private persist(state: RuntimeRunState): void {
		try {
			this.persister.persist(
				serializeRunEntry(state.run, state.tasks.values()),
			);
		} catch {
			// Persistence failures must never break execution.
		}
	}
}

/**
 * Singleton used by the Pi extension entry (JHL-16 resolves
 * `../runtime/index.ts` and takes `default`). Constructing a fresh
 * WorkflowRuntime per session is fine for tests and embedders.
 */
const runtime = new WorkflowRuntime();
export default runtime;
export { runtime };
export type { RuntimeRunView, WorkflowRun, AgentTask, RunStage };
export * from "./state.ts";
export * from "./cache.ts";
export * from "./scheduler.ts";
export * from "./persist.ts";
export * from "./errors.ts";
export * from "./types.ts";
