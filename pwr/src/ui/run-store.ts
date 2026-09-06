/**
 * PWR UI - in-memory run store (JHL-15)
 *
 * Synchronous snapshot of all workflow runs for the `/workflows` UI. The
 * store is fed by:
 *
 *  - `hydrateRun()` - called by the extension entry when `workflow_validate`
 *    creates a run (run + script + plan metadata).
 *  - `hydrateEntries()` - called on `session_start` from persisted
 *    `pi-workflow-run-v1` entries (metadata only; never script source).
 *  - `feedEvent()` - pushed by the runtime (JHL-13, `onEvent` contract) on
 *    every stage/agent/usage transition.
 *  - `applyControlView()` - merged with the `{ run }` view returned by
 *    `workflow_control`.
 *  - `applyRuntimeView()` - full snapshot merge from the runtime's rich view
 *    (stages + tasks + usage), pulled on every /workflows:view refresh tick
 *    (JHL-18).
 *
 * All reads are synchronous from memory so commands/widgets render without
 * blocking main input (PRD 7: refresh never blocks main input).
 */

import type { RunRegistry } from "../flow.ts";
import type { BudgetEstimate, WorkflowPlan, WorkflowRunView, WorkflowScript, WorkflowRun } from "../types.ts";
import type { RuntimeRunView } from "../../runtime/types.ts";
import {
	COST_WARN_USD,
	LARGE_RUN_AGENTS,
	LARGE_RUN_TOKENS,
	type AgentView,
	type RunDetail,
	type RunEntryData,
	type RunEvent,
	type RunListEntry,
	type RunStore,
	type StageStatus,
	type StageView,
	type TaskStatus,
} from "./types.ts";

const TERMINAL_RUN = new Set(["completed", "failed", "cancelled"]);
const MAX_RECENT_EVENTS = 20;

interface InternalRun {
	runId: string;
	scriptId: string;
	scriptName: string;
	digest: string;
	meta?: RunDetail["meta"];
	args?: unknown;
	status: string;
	createdAt: string;
	startedAt?: string;
	endedAt?: string;
	budget?: BudgetEstimate;
	/** Structure plan (with tree) for the viewer diagram (JHL-18). */
	plan?: WorkflowPlan;
	stages: Map<string, StageView>;
	agents: Map<string, AgentView>;
	totalTokens: number;
	totalCost: number;
	finalSummary?: string;
	errorCode?: string;
	errorMessage?: string;
	lastEventAt: number;
}

function stageStatusForRun(runStatus: string): StageStatus {
	switch (runStatus) {
		case "completed":
			return "completed";
		case "failed":
		case "cancelled":
			return "failed";
		case "paused":
			return "paused";
		case "running":
		case "queued":
			return runStatus;
		default:
			return "queued";
	}
}

function taskStatusForRun(runStatus: string): TaskStatus {
	switch (runStatus) {
		case "completed":
			return "completed";
		case "failed":
			return "failed";
		case "cancelled":
			return "cancelled";
		case "paused":
			return "queued";
		default:
			return "queued";
	}
}

/** Tokens from a runner usage record ({input, output, ...}; JHL-14 shape). */
function usageTokens(usage: Record<string, number>): number | undefined {
	const input = typeof usage.input === "number" ? usage.input : 0;
	const output = typeof usage.output === "number" ? usage.output : 0;
	if (input === 0 && output === 0) return undefined;
	return input + output;
}

/** Cost from a runner usage record ({cost: number}). */
function usageCost(usage: Record<string, number>): number | undefined {
	return typeof usage.cost === "number" && usage.cost > 0 ? usage.cost : undefined;
}

export class MemoryRunStore implements RunStore {
	private runs = new Map<string, InternalRun>();
	private listeners = new Set<() => void>();
	/** Injectable clock for deterministic tests. */
	private nowMs: () => number;

	constructor(opts?: { nowMs?: () => number }) {
		this.nowMs = opts?.nowMs ?? (() => Date.now());
	}

	/** Seed metadata for a run created by workflow_validate (JHL-16 flow). */
	hydrateRun(run: WorkflowRun, script: WorkflowScript, plan: WorkflowPlan): void {
		const stages = new Map<string, StageView>();
		const seedStatus = stageStatusForRun(run.status);
		for (const s of plan.stages) {
			stages.set(s.stageId, {
				stageId: s.stageId,
				label: s.label,
				kind: s.kind,
				status: seedStatus,
				agentCount: s.agentCount,
				dynamic: s.dynamic,
				writeRisk: s.writeRisk,
			});
		}
		this.runs.set(run.runId, {
			runId: run.runId,
			scriptId: run.scriptId,
			scriptName: script.meta.name ?? "untitled",
			digest: run.digest,
			meta: script.meta,
			args: run.args,
			status: run.status,
			createdAt: run.createdAt,
			startedAt: run.startedAt,
			endedAt: run.endedAt,
			budget: plan.budget,
			plan,
			stages,
			agents: new Map(),
			totalTokens: 0,
			totalCost: 0,
			lastEventAt: this.nowMs(),
		});
		this.emit();
	}

	/** Seed or refresh run metadata from persisted entries (session_start). */
	hydrateEntries(entries: RunEntryData[]): void {
		for (const e of entries) {
			const existing = this.runs.get(e.runId);
			if (existing) {
				existing.status = e.status;
				existing.createdAt = e.createdAt;
				existing.digest = e.digest;
				if (e.endedAt !== undefined) existing.endedAt = e.endedAt;
				if (e.errorCode !== undefined) existing.errorCode = e.errorCode;
				if (e.errorMessage !== undefined) existing.errorMessage = e.errorMessage;
				if (e.summary !== undefined) existing.finalSummary = e.summary;
				continue;
			}
			const run: InternalRun = {
				runId: e.runId,
				scriptId: e.scriptId,
				scriptName: "untitled",
				digest: e.digest,
				status: e.status,
				createdAt: e.createdAt,
				startedAt: e.startedAt,
				endedAt: e.endedAt,
				finalSummary: e.summary,
				errorCode: e.errorCode,
				errorMessage: e.errorMessage,
				stages: new Map(),
				agents: new Map(),
				totalTokens: 0,
				totalCost: 0,
				lastEventAt: this.nowMs(),
			};
			for (const t of e.tasks ?? []) {
				run.agents.set(t.taskId, {
					taskId: t.taskId,
					stageId: t.stageId,
					label: t.stageId ? `${t.stageId}/${t.taskId.slice(0, 8)}` : t.taskId.slice(0, 8),
					status: t.status,
					attempt: t.attempt,
					errorCode: t.errorCode,
					error: t.errorMessage,
					resultSummary: t.summary,
					cacheHit: t.cacheHit,
					recentEvents: [],
				});
			}
			this.runs.set(e.runId, run);
		}
		this.emit();
	}

	/** Apply a runtime event feed (JHL-13 onEvent contract). */
	feedEvent(ev: RunEvent): void {
		const run = this.runs.get(ev.runId);
		if (!run) return; // unknown run - ignore
		run.lastEventAt = this.nowMs();
		switch (ev.type) {
			case "run_status": {
				run.status = ev.status;
				if (ev.status === "running" && !run.startedAt) run.startedAt = ev.at;
				if (TERMINAL_RUN.has(ev.status) && !run.endedAt) run.endedAt = ev.at;
				const stageStatus = stageStatusForRun(ev.status);
				const taskStatus = taskStatusForRun(ev.status);
				for (const stage of run.stages.values()) {
					if (stage.status !== "completed" && stage.status !== "failed") stage.status = stageStatus;
				}
				for (const agent of run.agents.values()) {
					if (agent.status !== "completed" && agent.status !== "failed" && agent.status !== "cancelled") {
						agent.status = taskStatus;
					}
				}
				break;
			}
			case "stage_status": {
				const stage = run.stages.get(ev.stageId);
				if (stage) {
					stage.status = ev.status;
					if (ev.agentCount !== undefined) stage.agentCount = ev.agentCount;
					if (ev.tokens !== undefined) stage.tokens = ev.tokens;
					if (ev.elapsedMs !== undefined) stage.elapsedMs = ev.elapsedMs;
				} else {
					run.stages.set(ev.stageId, {
						stageId: ev.stageId,
						label: ev.stageId,
						kind: "agent",
						status: ev.status,
						agentCount: ev.agentCount ?? 1,
						tokens: ev.tokens,
						elapsedMs: ev.elapsedMs,
					});
				}
				break;
			}
			case "task_status": {
				const agent = run.agents.get(ev.taskId);
				if (agent) {
					agent.status = ev.status;
					if (ev.attempt !== undefined) agent.attempt = ev.attempt;
					if (ev.stageId) agent.stageId = ev.stageId;
				} else {
					run.agents.set(ev.taskId, {
						taskId: ev.taskId,
						stageId: ev.stageId,
						label: ev.stageId ? `${ev.stageId}/${ev.taskId.slice(0, 8)}` : ev.taskId.slice(0, 8),
						status: ev.status,
						attempt: ev.attempt ?? 1,
						recentEvents: [],
					});
				}
				break;
			}
			case "task_event": {
				const agent = run.agents.get(ev.taskId);
				if (!agent) break;
				agent.recentEvents.push(ev.event);
				if (agent.recentEvents.length > MAX_RECENT_EVENTS) {
					agent.recentEvents = agent.recentEvents.slice(-MAX_RECENT_EVENTS);
				}
				break;
			}
			case "task_result": {
				const agent = run.agents.get(ev.taskId);
				if (!agent) break;
				if (ev.summary !== undefined) agent.resultSummary = ev.summary;
				if (ev.error !== undefined) agent.error = ev.error;
				if (ev.tokens !== undefined) agent.tokens = ev.tokens;
				if (ev.elapsedMs !== undefined) agent.elapsedMs = ev.elapsedMs;
				if (ev.tokens !== undefined) run.totalTokens += ev.tokens;
				if (ev.cost !== undefined) run.totalCost += ev.cost;
				break;
			}
			case "usage": {
				if (ev.tokens !== undefined) run.totalTokens += ev.tokens;
				if (ev.cost !== undefined) run.totalCost += ev.cost;
				break;
			}
			case "summary": {
				run.finalSummary = ev.summary;
				break;
			}
		}
		this.emit();
	}

	/** Merge the `{ run }` view returned by workflow_control (PRD 6.2). */
	applyControlView(runId: string, view: WorkflowRunView): void {
		const run = this.runs.get(runId);
		if (!run) return;
		run.status = view.status;
		run.digest = view.digest;
		run.scriptName = view.scriptName;
		run.budget = view.budget;
		for (const s of view.stages) {
			const stage = run.stages.get(s.stageId);
			if (stage) {
				stage.agentCount = s.agentCount;
				stage.kind = s.kind;
				stage.label = s.label;
				stage.writeRisk = s.writeRisk;
			} else {
				run.stages.set(s.stageId, {
					stageId: s.stageId,
					label: s.label,
					kind: s.kind,
					status: stageStatusForRun(view.status),
					agentCount: s.agentCount,
					writeRisk: s.writeRisk,
				});
			}
		}
		run.lastEventAt = this.nowMs();
		this.emit();
	}

	/**
	 * Full snapshot merge from the runtime's rich view (JHL-18): replaces
	 * stage/task rows with the read-time-derived runtime state (statuses,
	 * elapsed, usage, summaries, cache hits). Totals are RECOMPUTED from the
	 * task rows — the success path never emits `task_result` events, so this
	 * is the only source of per-task tokens/cost and it must not accumulate.
	 */
	applyRuntimeView(runId: string, view: RuntimeRunView): void {
		const run = this.runs.get(runId);
		if (!run) return;
		run.status = view.status;
		run.digest = view.digest;
		run.scriptName = view.scriptName;
		run.budget = view.budget;
		run.startedAt = view.startedAt ?? run.startedAt;
		run.endedAt = view.endedAt ?? run.endedAt;
		if (view.summary !== undefined) run.finalSummary = view.summary;
		run.errorCode = view.errorCode;
		run.errorMessage = view.errorMessage;

		for (const s of view.stages) {
			const tokens = s.usage ? usageTokens(s.usage) : undefined;
			run.stages.set(s.stageId, {
				stageId: s.stageId,
				label: s.label,
				kind: s.kind,
				status: s.status,
				agentCount: s.agentCount,
				dynamic: s.dynamic,
				writeRisk: s.writeRisk,
				tokens,
				elapsedMs: s.elapsedMs,
			});
		}

		for (const t of view.tasks) {
			const startedAt = t.startedAt !== undefined ? Date.parse(t.startedAt) : NaN;
			const endedAt = t.endedAt !== undefined ? Date.parse(t.endedAt) : NaN;
			const elapsedMs = Number.isFinite(startedAt)
				? Math.max(0, (Number.isFinite(endedAt) ? endedAt : this.nowMs()) - startedAt)
				: undefined;
			const next: AgentView = {
				taskId: t.taskId,
				stageId: t.stageId,
				label: t.label,
				status: t.status,
				attempt: t.attempt,
				resultSummary: t.summary,
				error: t.errorMessage,
				errorCode: t.errorCode,
				tokens: t.usage ? usageTokens(t.usage) : undefined,
				cost: t.usage ? usageCost(t.usage) : undefined,
				elapsedMs,
				cacheHit: t.cacheHit,
				recentEvents: run.agents.get(t.taskId)?.recentEvents ?? [],
			};
			run.agents.set(t.taskId, next);
		}

		let totalTokens = 0;
		let totalCost = 0;
		for (const agent of run.agents.values()) {
			if (agent.tokens !== undefined) totalTokens += agent.tokens;
			if (agent.cost !== undefined) totalCost += agent.cost;
		}
		run.totalTokens = totalTokens;
		run.totalCost = totalCost;

		run.lastEventAt = this.nowMs();
		this.emit();
	}

	listRuns(): RunListEntry[] {
		const out: RunListEntry[] = [];
		for (const run of this.runs.values()) {
			let completedAgents = 0;
			for (const agent of run.agents.values()) {
				if (agent.status === "completed") completedAgents++;
			}
			const totalAgents = run.budget?.estimatedAgents ?? run.agents.size;
			out.push({
				runId: run.runId,
				scriptName: run.scriptName,
				status: run.status as RunListEntry["status"],
				totalElapsedMs: this.runElapsedMs(run),
				completedAgents,
				totalAgents,
				tokens: run.totalTokens || undefined,
				cost: run.totalCost || undefined,
				warnings: this.runWarnings(run),
				createdAt: run.createdAt,
			});
		}
		out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
		return out;
	}

	getDetail(runId: string): RunDetail | null {
		const run = this.runs.get(runId);
		if (!run) return null;
		return {
			runId: run.runId,
			scriptId: run.scriptId,
			scriptName: run.scriptName,
			status: run.status as RunDetail["status"],
			digest: run.digest,
			meta: run.meta,
			args: run.args,
			createdAt: run.createdAt,
			startedAt: run.startedAt,
			endedAt: run.endedAt,
			budget: run.budget,
			plan: run.plan,
			stages: [...run.stages.values()],
			agents: [...run.agents.values()],
			totalTokens: run.totalTokens || undefined,
			totalCost: run.totalCost || undefined,
			elapsedMs: this.runElapsedMs(run),
			finalSummary: run.finalSummary,
			errorCode: run.errorCode,
			errorMessage: run.errorMessage,
			warnings: this.runWarnings(run),
		};
	}

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private runElapsedMs(run: InternalRun): number | undefined {
		if (!run.startedAt) return undefined;
		const start = Date.parse(run.startedAt);
		if (Number.isNaN(start)) return undefined;
		if (run.endedAt) {
			const end = Date.parse(run.endedAt);
			if (!Number.isNaN(end)) return Math.max(0, end - start);
			return undefined;
		}
		// Live elapsed for non-terminal runs: computed at read time, no timers.
		return Math.max(0, this.nowMs() - start);
	}

	private runWarnings(run: InternalRun): string[] {
		const warnings: string[] = [];
		const agents = run.budget?.estimatedAgents;
		if (agents !== undefined && agents > LARGE_RUN_AGENTS) {
			warnings.push(`large run (${agents} agents)`);
		}
		if (run.totalTokens > LARGE_RUN_TOKENS) {
			warnings.push("tokens over 1.5M");
		}
		if (run.totalCost > COST_WARN_USD) {
			warnings.push(`cost over $${COST_WARN_USD.toFixed(2)}`);
		}
		return warnings;
	}

	private emit(): void {
		for (const listener of this.listeners) {
			try {
				listener();
			} catch {
				// a failing listener must not break the store or the runtime feed
			}
		}
	}
}

/** Convenience: seed the store with every run currently in a RunRegistry. */
export function hydrateRegistryInto(store: MemoryRunStore, registry: RunRegistry, runIds: Iterable<string>): void {
	for (const runId of runIds) {
		const run = registry.getRun(runId);
		const script = registry.getScript(runId);
		const plan = registry.getPlan(runId);
		if (run && script && plan) store.hydrateRun(run, script, plan);
	}
}
