/**
 * JHL-15 - widget/status/card renderer data tests: compact summaries stay
 * short (main session friendly), widget capped, status counts active runs.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { MemoryRunStore } from "../src/ui/run-store.ts";
import { RunRegistry } from "../src/flow.ts";
import { runCardSummaryLine, runStatusText, runWidgetLines } from "../src/ui/renderer.ts";

function makeRun(registry: RunRegistry, source: string, name: string, createdAt: string, agentCalls = 3): string {
	const plan = {
		stages: [{ stageId: "s1", label: "discover", kind: "agent" as const, agentCount: 1, writeRisk: false }],
		budget: { agentCalls, pipelineCalls: 0, parallelCalls: 0, estimatedAgents: agentCalls, writeRisk: false, warnLargeRun: false },
	};
	return registry.create(source, { name }, plan, createdAt).runId;
}

function storeWith(runs: Array<{ name: string; at: string; status?: "running" | "completed" }>): MemoryRunStore {
	const store = new MemoryRunStore({ nowMs: () => Date.parse("2026-08-05T12:03:00Z") });
	const registry = new RunRegistry();
	for (const r of runs) {
		const runId = makeRun(registry, "src", r.name, r.at);
		const run = registry.getRun(runId)!;
		store.hydrateRun(run, registry.getScript(runId)!, registry.getPlan(runId)!);
		if (r.status) store.feedEvent({ type: "run_status", runId, status: r.status, at: r.at });
	}
	return store;
}

test("runCardSummaryLine is a one-line summary", () => {
	const store = storeWith([{ name: "audit", at: "2026-08-05T12:00:00Z", status: "running" }]);
	const line = runCardSummaryLine(store, store.listRuns()[0]!.runId);
	assert.ok(line.includes("running"));
	assert.ok(line.includes("audit"));
	assert.ok(line.includes("agents"));
	assert.ok(line.split("\n").length === 1);
});

test("runWidgetLines caps at maxRuns and shows warnings count", () => {
	const store = storeWith([
		{ name: "a", at: "2026-08-05T12:00:00Z", status: "running" },
		{ name: "b", at: "2026-08-05T11:00:00Z", status: "running" },
		{ name: "c", at: "2026-08-05T10:00:00Z", status: "completed" },
		{ name: "d", at: "2026-08-05T09:00:00Z", status: "completed" },
		{ name: "e", at: "2026-08-05T08:00:00Z", status: "completed" },
		{ name: "f", at: "2026-08-05T07:00:00Z", status: "completed" },
	]);
	const lines = runWidgetLines(store, 5);
	assert.equal(lines.length, 7, "header + 5 runs + more-line");
	assert.ok(lines.some((l) => l.includes("and 1 more")));
	assert.ok(lines.some((l) => l.includes("a")));
});

test("runWidgetLines empty store", () => {
	const store = storeWith([]);
	const lines = runWidgetLines(store);
	assert.ok(lines.some((l) => l.includes("no runs")));
});

test("runStatusText counts only active runs; undefined when none", () => {
	const store = storeWith([
		{ name: "a", at: "2026-08-05T12:00:00Z", status: "running" },
		{ name: "b", at: "2026-08-05T11:00:00Z", status: "running" },
		{ name: "c", at: "2026-08-05T10:00:00Z", status: "completed" },
	]);
	const text = runStatusText(store)!;
	assert.ok(text.includes("2 active"));
	assert.ok(text.includes("1 finished"));
	const done = storeWith([{ name: "c", at: "2026-08-05T10:00:00Z", status: "completed" }]);
	assert.equal(runStatusText(done), undefined);
});
