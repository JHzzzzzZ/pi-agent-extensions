/**
 * PWR runtime — shared contracts (JHL-13 scope)
 *
 * Run state machine, scheduler, private cache and persistence implement
 * against these shapes. The RuntimeAdapter contract consumed by JHL-16
 * (src/types.ts) is implemented in runtime/index.ts; everything in this
 * module is runtime-internal.
 */

/** Session entry version persisted for every run (PRD 6.1). */
export const PWR_RUN_ENTRY_VERSION = "pi-workflow-run-v1";

/** Total agent executions hard cap per run (Tony Stark 2026-08-05 resolution). */
export const MAX_AGENTS_HARD_LIMIT = 1000;

/** Concurrency hard cap per run (Tony Stark 2026-08-05 resolution, supersedes PRD v2.0's 16). */
export const MAX_CONCURRENCY_HARD_LIMIT = 128;

/** Default effective concurrency when a run does not specify one. */
export const DEFAULT_CONCURRENCY = 4;

/** Maximum final summary size delivered to the main session and persisted (bytes). */
export const MAX_FINAL_SUMMARY_SIZE = 8 * 1024;

/** Maximum task/run error message size persisted and surfaced to the UI (bytes). */
export const MAX_TASK_ERROR_SIZE = 8 * 1024;

export type RunStatus =
	| "draft"
	| "awaiting_approval"
	| "queued"
	| "running"
	| "paused"
	| "completed"
	| "failed"
	| "cancelled";

export type AgentTaskStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export type StageStatus = "queued" | "running" | "paused" | "completed" | "failed";

export const RUN_STATUSES: readonly RunStatus[] = [
	"draft",
	"awaiting_approval",
	"queued",
	"running",
	"paused",
	"completed",
	"failed",
	"cancelled",
];

export interface WorkflowMeta {
	name: string;
	description?: string;
	version?: number | string;
}

/**
 * Runtime view of a workflow run. Metadata/status/summary only — never the
 * script source, subagent prompts or raw tool output (PRD 6.1).
 */
export interface WorkflowRun {
	runId: string;
	scriptId: string;
	digest: string;
	meta: WorkflowMeta;
	status: RunStatus;
	args?: unknown;
	createdAt: string;
	startedAt?: string;
	endedAt?: string;
	summary?: string;
	errorCode?: string;
	errorMessage?: string;
	/** Effective concurrency for this run, clamped to [1, 128]. */
	concurrency: number;
	/** Agent execution budget for this run, clamped to [1, 1000]. */
	maxAgents: number;
	/** Cumulative real agent dispatches (cache hits do not consume budget). */
	agentExecutions: number;
}

/**
 * One agent() invocation tracked by the runtime. `inputDigest` is the
 * private-cache key (normalized input + script digest); `resultRef` is the
 * cache entry key. Raw results never leave the run-private cache.
 */
export interface AgentTask {
	taskId: string;
	stageId: string;
	label: string;
	inputDigest: string;
	status: AgentTaskStatus;
	attempt: number;
	summary?: string;
	usage?: Record<string, number>;
	errorCode?: string;
	errorMessage?: string;
	startedAt?: string;
	endedAt?: string;
	/** True when the recorded completion was served from the private cache
	 * (no child process spawned; JHL-18 viewer marks these with ⚡). */
	cacheHit?: boolean;
}

/** Execution stage aggregated from agent/pipeline/parallel labels. */
export interface RunStage {
	stageId: string;
	label: string;
	kind: "agent" | "pipeline" | "parallel";
	/** Static plan estimate for this stage (agentCount from the plan card). */
	agentCount: number;
	/** Fan-out size computed at runtime (not a literal array). */
	dynamic?: boolean;
	writeRisk: boolean;
	status: StageStatus;
	agentIds: string[];
	elapsedMs: number;
	usage?: Record<string, number>;
	createdAt: string;
}

export interface RuntimeBudgetView {
	/** Cumulative real agent dispatches so far. */
	agentCalls: number;
	pipelineCalls: number;
	parallelCalls: number;
	/** Static estimate from the plan card (unclamped, may exceed hard caps). */
	estimatedAgents: number;
	writeRisk: boolean;
	warnLargeRun: boolean;
	maxAgents: number;
	concurrency: number;
}

/**
 * Rich run view returned by runtime control/query APIs. Structurally a
 * superset of JHL-16's WorkflowRunView so `workflow_control` can return it
 * directly to the UI (JHL-15).
 */
export interface RuntimeRunView {
	runId: string;
	scriptId: string;
	scriptName: string;
	status: RunStatus;
	digest: string;
	createdAt: string;
	startedAt?: string;
	endedAt?: string;
	summary?: string;
	errorCode?: string;
	errorMessage?: string;
	args?: unknown;
	budget: RuntimeBudgetView;
	stages: RunStage[];
	tasks: AgentTask[];
}
