/**
 * PWR - shared contracts (JHL-16 scope)
 *
 * Core data types and constants for the Pi Workflow Runtime trigger,
 * generation and approval layer. Cross-extension contracts live here so
 * the engine (JHL-12), runtime (JHL-13) and save/load (JHL-17) components
 * can implement against the same shapes.
 */

export const PWR_RUN_ENTRY = "pi-workflow-run-v1";
export const PWR_APPROVAL_ENTRY = "pwr-approval-v1";
export const PWR_GENERATION_CUSTOM_TYPE = "pwr-generation-request";
export const PWR_RESULT_CUSTOM_TYPE = "pwr-workflow-result";

/** Total agent hard limit per run (Tony Stark 2026-08-05 approved resolution). */
export const AGENT_LIMIT = 1000;
/** Concurrency hard cap (Tony Stark 2026-08-05 approved resolution, supersedes PRD v2.0's 16). */
export const CONCURRENCY_MAX = 128;
/** Default concurrency when a script does not specify one. */
export const CONCURRENCY_DEFAULT = 4;
/** Static budget estimate fan-out used when a pipeline/parallel item count is not statically visible. */
export const PIPELINE_FANOUT_ESTIMATE = 3;

/** Maximum accepted script source size (bytes). */
export const MAX_SCRIPT_SIZE = 256 * 1024;
/**
 * Inline full-summary threshold AND the state/persisted-entry summary cap
 * (bytes). Results at or below this size are delivered inline unchanged;
 * larger results are written to `<workflowsDir>/results/<runId>.json` and
 * the message carries a JSON-safe preview + the file path.
 */
export const MAX_FINAL_SUMMARY_SIZE = 8 * 1024;
/**
 * Total completion-message budget (bytes): header + preview + path line.
 * The preview is sized so the final assembled message never exceeds this.
 */
export const MAX_MESSAGE_BUDGET_BYTES = 16 * 1024;

export interface WorkflowMeta {
	name: string;
	description?: string;
	version?: number | string;
	/** Optional JSON schema (subset) validated against `args` at /workflow:<name> invocation. */
	argsSchema?: unknown;
}

export interface WorkflowScript {
	scriptId: string;
	digest: string;
	source: string;
	meta: WorkflowMeta;
	astVersion: string;
}

export type RunStatus =
	| "draft"
	| "awaiting_approval"
	| "queued"
	| "running"
	| "paused"
	| "completed"
	| "failed"
	| "cancelled";

export interface WorkflowRun {
	runId: string;
	scriptId: string;
	digest: string;
	status: RunStatus;
	args?: unknown;
	createdAt: string;
	startedAt?: string;
	endedAt?: string;
}

export interface StagePlan {
	stageId: string;
	label: string;
	kind: "agent" | "pipeline" | "parallel";
	agentCount: number;
	/** True when the fan-out size is not a literal (computed at runtime). */
	dynamic?: boolean;
	writeRisk: boolean;
}

export interface BudgetEstimate {
	agentCalls: number;
	pipelineCalls: number;
	parallelCalls: number;
	estimatedAgents: number;
	writeRisk: boolean;
	warnLargeRun: boolean;
}

export interface WorkflowPlan {
	stages: StagePlan[];
	budget: BudgetEstimate;
}

export interface ApprovalRecord {
	projectPath: string;
	digest: string;
	decision: "approved";
	remembered: boolean;
	decidedAt: string;
}

export interface AgentTaskSummary {
	taskId: string;
	stageId?: string;
	status: "queued" | "running" | "completed" | "failed" | "cancelled";
	attempt: number;
	summary?: string;
}

export interface WorkflowRunView {
	runId: string;
	scriptId: string;
	scriptName: string;
	status: RunStatus;
	digest: string;
	createdAt: string;
	stages: StagePlan[];
	budget: BudgetEstimate;
}

/** Error result shape mandated by PRD 6.2. Never carries source text or secrets. */
export interface PwrErrorResult {
	code: string;
	message: string;
	runId?: string;
	stageId?: string;
	taskId?: string;
}

/** Runtime adapter contract (JHL-13 implements; JHL-16 consumes). */
export interface RuntimeAdapter {
	/**
	 * Starts a run. `onFinalResult` is part of the JHL-13 contract: the
	 * runtime MUST call it with the run's final `return` summary exactly once
	 * per run, after that run's final agent settles (never on intermediate
	 * agent activity).
	 */
	start(spec: {
		runId: string;
		script: WorkflowScript;
		args?: unknown;
		onFinalResult?: (summary: string) => void;
	}): Promise<{ runId: string; status: "running" }>;
	control(input: { runId: string; action: "pause" | "resume" | "stop" | "restart_agent"; agentId?: string }): Promise<{
		run: WorkflowRunView;
	}>;
	/**
	 * Optional per-run settle observer: the runtime calls handler(runId) when
	 * THAT run's final agent settles. Used to gate final-summary delivery so
	 * one run's settle never flushes another run's pending results.
	 */
	onRunSettled?(handler: (runId: string) => void): void;
}

/** Engine adapter contract (JHL-12 implements; JHL-16 consumes). */
export interface ScriptEngine {
	validate(source: string): Promise<ScriptValidationResult> | ScriptValidationResult;
}

export interface ScriptValidationResult {
	ok: boolean;
	astVersion: string;
	meta?: WorkflowMeta;
	errors: Array<{
		code: string;
		message: string;
		line?: number;
		column?: number;
	}>;
}
