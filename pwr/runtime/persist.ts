/**
 * PWR runtime — persistence (PRD 6.1)
 *
 * Session entry `pi-workflow-run-v1` persists ONLY metadata, status,
 * summary and the cache index. It NEVER writes full subagent prompts, raw
 * tool output, environment variables or credentials. `usage` fields are
 * sanitized to numeric counters before they may enter an entry.
 */

import * as path from "node:path";
import { MAX_FINAL_SUMMARY_SIZE, MAX_TASK_ERROR_SIZE, PWR_RUN_ENTRY_VERSION } from "./types.ts";
import type { AgentTaskStatus, RunStatus, WorkflowMeta, WorkflowRun } from "./types.ts";
import { truncateJsonSummary } from "../src/notify.ts";

export interface RunEntryPayload {
	entryVersion: typeof PWR_RUN_ENTRY_VERSION;
	runId: string;
	scriptId: string;
	digest: string;
	meta: WorkflowMeta;
	status: RunStatus;
	createdAt: string;
	startedAt?: string;
	endedAt?: string;
	summary?: string;
	/** Full-result file (`<resultsDir>/<runId>.json`) when the summary was truncated. */
	resultPath?: string;
	errorCode?: string;
	errorMessage?: string;
	budget: { agentCalls: number; maxAgents: number; concurrency: number };
	cacheIndex: CacheIndexRecord[];
}

/** Per-task persisted record — summary + counters only. */
export interface CacheIndexRecord {
	key: string;
	taskId: string;
	stageId: string;
	label: string;
	status: AgentTaskStatus;
	attempt: number;
	summary?: string;
	usage?: Record<string, number>;
	errorCode?: string;
	errorMessage?: string;
}

export interface RunPersister {
	persist(entry: RunEntryPayload): void;
}

/** In-memory persister for tests and for hosts without a session store. */
export class MemoryPersister implements RunPersister {
	private readonly entries: RunEntryPayload[] = [];

	persist(entry: RunEntryPayload): void {
		this.entries.push(structuredClone(entry));
	}

	snapshots(): readonly RunEntryPayload[] {
		return this.entries;
	}

	latest(): RunEntryPayload | undefined {
		return this.entries[this.entries.length - 1];
	}

	clear(): void {
		this.entries.length = 0;
	}
}

/**
 * Usage counters are reduced to finite numbers. Anything that is not a
 * finite number is dropped so no host object, string or nested data can
 * sneak into a persisted entry.
 */
export function sanitizeUsage(usage: unknown): Record<string, number> | undefined {
	if (usage === null || typeof usage !== "object") return undefined;
	const out: Record<string, number> = {};
	let wrote = false;
	for (const [key, value] of Object.entries(usage)) {
		if (typeof value === "number" && Number.isFinite(value)) {
			out[key] = value;
			wrote = true;
		}
	}
	return wrote ? out : undefined;
}

/**
 * UTF-8-safe byte truncation: keeps as much of `text` as fits in
 * `maxBytes` (multi-byte characters are never split) and appends
 * `suffix` when truncation happened.
 */
export function truncateUtf8Bytes(text: string, maxBytes: number, suffix: string): string {
	if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
	const budget = maxBytes - Buffer.byteLength(suffix, "utf8");
	let truncated = text.slice(0, budget);
	while (Buffer.byteLength(truncated, "utf8") > budget) truncated = truncated.slice(0, -1);
	return `${truncated}${suffix}`;
}

/** Truncate a summary to MAX_FINAL_SUMMARY_SIZE bytes (UTF-8 safe). */
export function truncateSummary(summary: string): string {
	return truncateUtf8Bytes(summary, MAX_FINAL_SUMMARY_SIZE, "\n\n[Summary truncated.]");
}

/** Truncate a task/run error message to MAX_TASK_ERROR_SIZE bytes (UTF-8 safe). */
export function truncateError(message: string): string {
	return truncateUtf8Bytes(message, MAX_TASK_ERROR_SIZE, "\n\n[Error truncated.]");
}

/**
 * Builds the persisted entry from runtime state. Only whitelisted fields
 * are copied; cacheIndex carries summaries/counters only. The script
 * source, prompts and results are structurally absent.
 */
export function serializeRunEntry(
	run: WorkflowRun,
	tasks: Iterable<{
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
	}>,
): RunEntryPayload {
	const cacheIndex: CacheIndexRecord[] = [];
	for (const task of tasks) {
		cacheIndex.push({
			key: task.inputDigest,
			taskId: task.taskId,
			stageId: task.stageId,
			label: task.label,
			status: task.status,
			attempt: task.attempt,
			summary: task.summary === undefined ? undefined : truncateSummary(task.summary),
			usage: sanitizeUsage(task.usage),
			errorCode: task.errorCode,
			errorMessage: task.errorMessage === undefined ? undefined : truncateError(task.errorMessage),
		});
	}
	const entry: RunEntryPayload = {
		entryVersion: PWR_RUN_ENTRY_VERSION,
		runId: run.runId,
		scriptId: run.scriptId,
		digest: run.digest,
		meta: { name: run.meta.name, description: run.meta.description, version: run.meta.version },
		status: run.status,
		createdAt: run.createdAt,
		budget: {
			agentCalls: run.agentExecutions,
			maxAgents: run.maxAgents,
			concurrency: run.concurrency,
		},
		cacheIndex,
	};
	// NOTE: run.args is NEVER persisted (PRD §6.1 — "绝不写入凭证"). Args may
	// carry tokens/passwords and stay in run memory only; the entry is
	// structurally args-free.
	if (run.startedAt !== undefined) entry.startedAt = run.startedAt;
	if (run.endedAt !== undefined) entry.endedAt = run.endedAt;
	if (run.summary !== undefined) entry.summary = truncateJsonSummary(run.summary, MAX_FINAL_SUMMARY_SIZE);
	if (run.errorCode !== undefined) entry.errorCode = run.errorCode;
	if (run.errorMessage !== undefined) entry.errorMessage = truncateError(run.errorMessage);
	return entry;
}

/**
 * Full-result file path for a run whose summary carries a truncation marker
 * (`__pwr_truncated__` JSON marker or the text `[Summary truncated.]`
 * scalar fallback). Judgment is marker-based, never fs-based: the file is
 * written by the notifier before the summary is ever persisted.
 */
export function resultPathForSummary(
	summary: string | undefined,
	resultsDir: string,
	runId: string,
): string | undefined {
	if (typeof summary !== "string") return undefined;
	if (!summary.includes("__pwr_truncated__") && !summary.includes("[Summary truncated.]")) return undefined;
	return path.join(resultsDir, `${runId}.json`);
}
