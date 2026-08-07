/**
 * JHL-15 - MemoryRunStore tests: registry hydration, event feed (stage/agent/
 * usage/summary), control view merge, entry hydration, warnings, subscription.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { MemoryRunStore, hydrateRegistryInto } from "../src/ui/run-store.ts";
import { RunRegistry } from "../src/flow.ts";
import { LARGE_RUN_AGENTS } from "../src/ui/types.ts";

function makeRun(registry: RunRegistry, source: string, scriptName: string, agentCalls = 5): string {
	const plan = {
		stages: [
			{ stageId: "s1", label: "discover", kind: "agent" as const, agentCount: 1, writeRisk: false },
			{ stageId: "s2", label: "verify", kind: "pipeline" as const, agentCount: agentCalls, writeRisk: true },
		],
		budget: {
			agentCalls,
			pipelineCalls: 1,
			parallelCalls: 0,
			estimatedAgents: agentCalls,
			writeRisk: true,
			warnLargeRun: agentCalls > LARGE_RUN_AGENTS,
		},
	};
	return registry.create(source, { name: scriptName, description: "d", version: 1 }, plan, "2026-08-05T12:00:00Z").runId;
}

function newStore() {
	const store = new MemoryRunStore({ nowMs: () => Date.parse("2026-08-05T12:03:00Z") });
	return store;
}

test("hydrateRun seeds list entry, detail stages (queued) and budget", () => {
	const store = newStore();
	const registry = new RunRegistry();
	const runId = makeRun(registry, "export const meta={name:'audit'};", "audit-routes");

	const run = registry.getRun(runId)!;
	const script = registry.getScript(runId)!;
	const plan = registry.getPlan(runId)!;
	store.hydrateRun(run, script, plan);

	const list = store.listRuns();
	assert.equal(list.length, 1);
	assert.equal(list[0]!.scriptName, "audit-routes");
	assert.equal(list[0]!.status, "awaiting_approval");
	assert.equal(list[0]!.totalAgents, 5);

	const detail = store.getDetail(runId)!;
	assert.equal(detail.stages.length, 2);
	assert.ok(detail.stages.every((s) => s.status === "queued"));
	assert.equal(detail.budget?.estimatedAgents, 5);
	assert.equal(detail.digest, run.digest);
});

test("run_status events drive started/ended times and stage statuses", () => {
	const store = newStore();
	const registry = new RunRegistry();
	const runId = makeRun(registry, "src", "x");
	const run = registry.getRun(runId)!;
	store.hydrateRun(run, registry.getScript(runId)!, registry.getPlan(runId)!);

	store.feedEvent({ type: "run_status", runId, status: "running", at: "2026-08-05T12:00:05Z" });
	let detail = store.getDetail(runId)!;
	assert.equal(detail.startedAt, "2026-08-05T12:00:05Z");
	assert.ok(detail.stages.every((s) => s.status === "running"));
	assert.equal(detail.elapsedMs, 175_000, "live elapsed computed from startedAt (no timers)");

	store.feedEvent({ type: "run_status", runId, status: "completed", at: "2026-08-05T12:02:05Z" });
	detail = store.getDetail(runId)!;
	assert.equal(detail.endedAt, "2026-08-05T12:02:05Z");
	assert.ok(detail.stages.every((s) => s.status === "completed"));
	assert.equal(detail.elapsedMs, 120_000);
});

test("task/stage/result/event feeds build the agent detail view", () => {
	const store = newStore();
	const registry = new RunRegistry();
	const runId = makeRun(registry, "src", "x");
	const run = registry.getRun(runId)!;
	store.hydrateRun(run, registry.getScript(runId)!, registry.getPlan(runId)!);

	store.feedEvent({ type: "run_status", runId, status: "running", at: "2026-08-05T12:00:05Z" });
	store.feedEvent({ type: "stage_status", runId, stageId: "s1", status: "running", agentCount: 1, tokens: 10_000, elapsedMs: 5_000, at: "2026-08-05T12:00:10Z" });
	store.feedEvent({ type: "task_status", runId, taskId: "t1", stageId: "s1", status: "running", attempt: 1, at: "2026-08-05T12:00:06Z" });
	store.feedEvent({ type: "task_event", runId, taskId: "t1", event: "reading src/routes", at: "2026-08-05T12:00:07Z" });
	store.feedEvent({ type: "task_event", runId, taskId: "t1", event: "found 12 files", at: "2026-08-05T12:00:08Z" });
	store.feedEvent({ type: "task_result", runId, taskId: "t1", summary: "12 files", tokens: 12_000, elapsedMs: 20_000, cost: 0.05, at: "2026-08-05T12:00:26Z" });
	store.feedEvent({ type: "task_status", runId, taskId: "t1", status: "completed", at: "2026-08-05T12:00:26Z" });
	store.feedEvent({ type: "usage", runId, tokens: 3_000, cost: 0.01, at: "2026-08-05T12:01:00Z" });

	const detail = store.getDetail(runId)!;
	const agent = detail.agents.find((a) => a.taskId === "t1")!;
	assert.equal(agent.status, "completed");
	assert.equal(agent.stageId, "s1");
	assert.equal(agent.recentEvents.length, 2);
	assert.equal(agent.resultSummary, "12 files");
	assert.equal(agent.tokens, 12_000);
	assert.equal(detail.totalTokens, 15_000, "task tokens + usage delta accumulate");
	assert.ok(Math.abs((detail.totalCost ?? 0) - 0.06) < 1e-9, "cost accumulates (float tolerance)");
	const stage = detail.stages.find((s) => s.stageId === "s1")!;
	assert.equal(stage.status, "running");
	assert.equal(stage.tokens, 10_000);

	const list = store.listRuns()[0]!;
	assert.equal(list.completedAgents, 1);
});

test("final summary event lands in detail", () => {
	const store = newStore();
	const registry = new RunRegistry();
	const runId = makeRun(registry, "src", "x");
	const run = registry.getRun(runId)!;
	store.hydrateRun(run, registry.getScript(runId)!, registry.getPlan(runId)!);
	store.feedEvent({ type: "summary", runId, summary: "all good", at: "2026-08-05T12:05:00Z" });
	assert.equal(store.getDetail(runId)!.finalSummary, "all good");
});

test("applyControlView merges workflow_control { run } result (PRD 6.2)", () => {
	const store = newStore();
	const registry = new RunRegistry();
	const runId = makeRun(registry, "src", "x");
	const run = registry.getRun(runId)!;
	store.hydrateRun(run, registry.getScript(runId)!, registry.getPlan(runId)!);

	store.applyControlView(runId, {
		runId,
		scriptId: run.scriptId,
		scriptName: "x",
		status: "paused",
		digest: run.digest,
		createdAt: run.createdAt,
		stages: [{ stageId: "s1", label: "discover", kind: "agent", agentCount: 2, writeRisk: false }],
		budget: { agentCalls: 2, pipelineCalls: 0, parallelCalls: 0, estimatedAgents: 2, writeRisk: false, warnLargeRun: false },
	});

	const detail = store.getDetail(runId)!;
	assert.equal(detail.status, "paused");
	assert.equal(detail.budget?.estimatedAgents, 2);
	const s1 = detail.stages.find((s) => s.stageId === "s1")!;
	assert.equal(s1.agentCount, 2, "control view refreshed stage counts");
	assert.ok(detail.stages.some((s) => s.stageId === "s2"), "runtime stages not in the view are preserved (union, never destroy data)");
});

test("entry hydration survives restart (metadata only)", () => {
	const store = newStore();
	store.hydrateEntries([
		{ runId: "r1", scriptId: "s1", digest: "dd", status: "completed", createdAt: "2026-08-05T11:00:00Z" },
	]);
	const list = store.listRuns();
	assert.equal(list.length, 1);
	assert.equal(list[0]!.status, "completed");
	assert.equal(list[0]!.scriptName, "untitled");
	assert.equal(store.getDetail("r1")!.stages.length, 0);
});

test("hydrateEntries 带 tasks 时恢复 agent 错误行", () => {
	const store = newStore();
	store.hydrateEntries([
		{
			runId: "r1",
			scriptId: "s1",
			digest: "dd",
			status: "failed",
			createdAt: "2026-08-05T11:00:00Z",
			startedAt: "2026-08-05T11:00:01Z",
			endedAt: "2026-08-05T11:00:20Z",
			summary: "no summary",
			errorCode: "AGENT_EXECUTION_ERROR",
			errorMessage: "boom",
			tasks: [
				{
					taskId: "t1",
					stageId: "stage-1",
					label: "analyze",
					status: "failed",
					attempt: 1,
					errorCode: "AGENT_EXECUTION_ERROR",
					errorMessage: "boom",
					summary: "partial",
				},
			],
		},
	]);
	const detail = store.getDetail("r1")!;
	assert.equal(detail.status, "failed");
	assert.equal(detail.startedAt, "2026-08-05T11:00:01Z");
	assert.equal(detail.endedAt, "2026-08-05T11:00:20Z");
	assert.equal(detail.finalSummary, "no summary");
	assert.equal(detail.errorCode, "AGENT_EXECUTION_ERROR");
	assert.equal(detail.errorMessage, "boom");
	assert.equal(detail.agents.length, 1);
	const agent = detail.agents[0]!;
	assert.equal(agent.taskId, "t1");
	assert.equal(agent.label, "stage-1/t1", "label follows the feedEvent task_status convention");
	assert.equal(agent.status, "failed");
	assert.equal(agent.attempt, 1);
	assert.equal(agent.error, "boom");
	assert.equal(agent.resultSummary, "partial");
});

test("hydrateEntries refresh updates error fields on existing runs", () => {
	const store = newStore();
	store.hydrateEntries([
		{ runId: "r1", scriptId: "s1", digest: "dd", status: "queued", createdAt: "2026-08-05T11:00:00Z" },
	]);
	store.hydrateEntries([
		{
			runId: "r1",
			scriptId: "s1",
			digest: "dd",
			status: "failed",
			createdAt: "2026-08-05T11:00:00Z",
			errorMessage: "boom later",
			summary: "s",
			endedAt: "2026-08-05T11:00:10Z",
		},
	]);
	const detail = store.getDetail("r1")!;
	assert.equal(detail.status, "failed");
	assert.equal(detail.errorMessage, "boom later");
	assert.equal(detail.finalSummary, "s");
	assert.equal(detail.endedAt, "2026-08-05T11:00:10Z");
});

test("events for unknown runs are ignored", () => {
	const store = newStore();
	store.feedEvent({ type: "run_status", runId: "nope", status: "running", at: "2026-08-05T12:00:00Z" });
	assert.equal(store.listRuns().length, 0);
});

test("warnings: large run, tokens over 1.5M, cost over $2", () => {
	const store = newStore();
	const registry = new RunRegistry();
	const runId = makeRun(registry, "src", "big", 26);
	const run = registry.getRun(runId)!;
	store.hydrateRun(run, registry.getScript(runId)!, registry.getPlan(runId)!);
	store.feedEvent({ type: "usage", runId, tokens: 1_600_000, cost: 2.5, at: "2026-08-05T12:01:00Z" });
	const warnings = store.getDetail(runId)!.warnings;
	assert.ok(warnings.includes("large run (26 agents)"));
	assert.ok(warnings.includes("tokens over 1.5M"));
	assert.ok(warnings.includes("cost over $2.00"));
});

test("subscribe fires on changes and unsubscribe stops it", () => {
	const store = newStore();
	const registry = new RunRegistry();
	const runId = makeRun(registry, "src", "x");
	const run = registry.getRun(runId)!;
	let events = 0;
	const off = store.subscribe(() => events++);
	store.hydrateRun(run, registry.getScript(runId)!, registry.getPlan(runId)!);
	assert.equal(events, 1);
	store.feedEvent({ type: "run_status", runId, status: "running", at: "2026-08-05T12:00:05Z" });
	assert.equal(events, 2);
	off();
	store.feedEvent({ type: "run_status", runId, status: "paused", at: "2026-08-05T12:01:00Z" });
	assert.equal(events, 2);
});

test("hydrateRegistryInto seeds every registry run", () => {
	const store = newStore();
	const registry = new RunRegistry();
	const a = makeRun(registry, "src-a", "a");
	const b = makeRun(registry, "src-b", "b");
	hydrateRegistryInto(store, registry, [a, b]);
	assert.equal(store.listRuns().length, 2);
});
