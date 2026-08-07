/**
 * PWR UI - shared view models and event feed contract (JHL-15)
 *
 * The `/workflows` observation/control UI consumes a *run store* that is fed
 * by two sources:
 *
 *  1. `RunRegistry` (src/flow.ts, JHL-16) - run metadata created by
 *     `workflow_validate` (run/script/plan/budget/status).
 *  2. A runtime event feed (JHL-13 implements `onEvent`). The runtime pushes
 *     `RunEvent`s on every stage/agent/usage transition; the store applies
 *     them synchronously so commands/widgets read from memory (UI feedback
 *     target < 500ms, refresh never blocks main input).
 *
 * Cross-component contracts (PRD 6.2 + JHL-15):
 *  - `RunEvent` - what the runtime (JHL-13) must emit to keep the UI live.
 *  - `OverwritableSaveAdapter` - JHL-17 save adapter; the UI save flow passes
 *    `overwrite` after the user confirms a `NAME_CONFLICT`.
 */

import type { RuntimeAdapter } from "../types.ts";
import type { BudgetEstimate, RunStatus, WorkflowMeta } from "../types.ts";

/** Run entry persisted by the extension (pi-workflow-run-v1). */
export interface RunEntryData {
	runId: string;
	scriptId: string;
	digest: string;
	status: RunStatus;
	createdAt: string;
	startedAt?: string;
	endedAt?: string;
	summary?: string;
	errorCode?: string;
	errorMessage?: string;
	tasks?: Array<{
		taskId: string;
		stageId?: string;
		label: string;
		status: TaskStatus;
		attempt: number;
		errorCode?: string;
		errorMessage?: string;
		summary?: string;
	}>;
}

export type StageStatus = "queued" | "running" | "paused" | "completed" | "failed";
export type TaskStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

/**
 * Event feed contract between the runtime (JHL-13) and the UI store (JHL-15).
 * The runtime MUST call `onEvent` for every observable transition; the UI
 * store applies events to its in-memory snapshot synchronously.
 */
export type RunEvent =
	| { type: "run_status"; runId: string; status: RunStatus; at: string }
	| { type: "stage_status"; runId: string; stageId: string; status: StageStatus; agentCount?: number; tokens?: number; elapsedMs?: number; at: string }
	| { type: "task_status"; runId: string; taskId: string; stageId?: string; status: TaskStatus; attempt?: number; at: string }
	| { type: "task_event"; runId: string; taskId: string; event: string; at: string }
	| { type: "task_result"; runId: string; taskId: string; summary?: string; error?: string; tokens?: number; elapsedMs?: number; cost?: number; at: string }
	| { type: "usage"; runId: string; tokens?: number; cost?: number; at: string }
	| { type: "summary"; runId: string; summary: string; at: string };

/** Optional runtime extension: a runtime that supports the JHL-15 event feed. */
export interface WorkflowEventsSource {
	onEvent(handler: (ev: RunEvent) => void): void;
}

export type UiRuntimeAdapter = RuntimeAdapter & Partial<WorkflowEventsSource>;

/** One row of the `/workflows` run list (PRD 4.3). */
export interface RunListEntry {
	runId: string;
	scriptName: string;
	status: RunStatus;
	totalElapsedMs?: number;
	completedAgents: number;
	totalAgents: number;
	tokens?: number;
	cost?: number;
	warnings: string[];
	createdAt: string;
}

/** One stage row of the run detail view (PRD 4.3). */
export interface StageView {
	stageId: string;
	label: string;
	kind: "agent" | "pipeline" | "parallel";
	status: StageStatus;
	agentCount: number;
	/** Fan-out size computed at runtime (not a literal array). */
	dynamic?: boolean;
	tokens?: number;
	elapsedMs?: number;
}

/** One agent row of the run detail view (PRD 4.3). */
export interface AgentView {
	taskId: string;
	stageId?: string;
	label: string;
	status: TaskStatus;
	attempt: number;
	promptSummary?: string;
	toolPolicy?: string;
	recentEvents: string[];
	resultSummary?: string;
	error?: string;
	tokens?: number;
	elapsedMs?: number;
}

/** Full run detail assembled by the store for the UI. */
export interface RunDetail {
	runId: string;
	scriptId: string;
	scriptName: string;
	status: RunStatus;
	digest: string;
	meta?: WorkflowMeta;
	args?: unknown;
	createdAt: string;
	startedAt?: string;
	endedAt?: string;
	budget?: BudgetEstimate;
	stages: StageView[];
	agents: AgentView[];
	totalTokens?: number;
	totalCost?: number;
	elapsedMs?: number;
	finalSummary?: string;
	errorCode?: string;
	errorMessage?: string;
	warnings: string[];
}

/** Read-only view over runs the UI renders. Implemented by MemoryRunStore. */
export interface RunStore {
	listRuns(): RunListEntry[];
	getDetail(runId: string): RunDetail | null;
	subscribe(listener: () => void): () => void;
}

/** Save adapter that supports the UI overwrite-confirmation flow (JHL-17). */
export interface OverwritableSaveAdapter {
	save(input: { runId: string; scope: "user" | "project"; name: string; overwrite?: boolean }): Promise<
		{ commandName: string; pathScope: "user" | "project" } | { code: string; message: string; runId?: string; stageId?: string; taskId?: string }
	>;
}

/** Large-run / cost warning thresholds (PRD 7: >25 agents, 1.5M tokens). */
export const LARGE_RUN_AGENTS = 25;
export const LARGE_RUN_TOKENS = 1_500_000;
export const COST_WARN_USD = 2;
