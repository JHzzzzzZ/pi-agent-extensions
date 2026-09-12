/**
 * JHL-15 - widget/status/card renderer data tests: compact summaries stay
 * short (main session friendly), widget capped, status counts active runs.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { MemoryRunStore } from "../src/ui/run-store.ts";
import { RunRegistry } from "../src/flow.ts";
import { refreshUiStatus, runCardSummaryLine, runStatusText, runWidgetLines } from "../src/ui/renderer.ts";
import { writeBand } from "../src/ui/status-band.ts";

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

test("refreshUiStatus 写 footer 排序带键 30:pwr；最前段无前缀、有更低排序带时带 `│ `（docs/cross/status-bar.md）", () => {
	const store = storeWith([{ name: "a", at: "2026-08-05T12:00:00Z", status: "running" }]);
	const statusCalls: Array<{ key: string; text: string | undefined }> = [];
	const widgetCalls: Array<{ key: string; lines: string[] }> = [];
	const ui = {
		setStatus: (key: string, text: string | undefined) => statusCalls.push({ key, text }),
		setWidget: (key: string, lines: string[]) => widgetCalls.push({ key, lines }),
	} as never;
	const anchorWrites: Array<string | undefined> = [];
	const anchorWriter = (t: string | undefined): void => {
		anchorWrites.push(t);
	};
	try {
		refreshUiStatus(ui, store);
		const footer = statusCalls.find((c) => c.key === "30:pwr");
		assert.ok(footer, "footer 状态键带排序前缀");
		assert.equal(footer!.text, "pwr 1▶", "唯一段 = 最前，无前导分隔符");
		assert.ok(widgetCalls.some((c) => c.key === "pwr-runs"), "widget 键不变");

		// 更低排序带出现 -> 重渲染带前缀；低带消失 -> 恢复无前缀
		writeBand("05:test-anchor", "锚点", anchorWriter);
		assert.equal(anchorWrites.at(-1), "锚点", "最前段自身无前缀");
		assert.equal(statusCalls.at(-1)!.text, "│ pwr 1▶", "非最前段带前缀");
		writeBand("05:test-anchor", undefined, anchorWriter);
		assert.equal(statusCalls.at(-1)!.text, "pwr 1▶", "低带消失后重渲染为最前");
	} finally {
		writeBand("05:test-anchor", undefined, anchorWriter);
	}
});

test("runStatusText 计数式短文案；无活跃 run 返回 undefined", () => {
	const store = storeWith([
		{ name: "a", at: "2026-08-05T12:00:00Z", status: "running" },
		{ name: "b", at: "2026-08-05T11:00:00Z", status: "running" },
		{ name: "c", at: "2026-08-05T10:00:00Z", status: "completed" },
	]);
	assert.equal(runStatusText(store), "pwr 2▶ 1✓");
	const single = storeWith([{ name: "a", at: "2026-08-05T12:00:00Z", status: "running" }]);
	assert.equal(runStatusText(single), "pwr 1▶", "无已完成时不输出 0✓");
	const done = storeWith([{ name: "c", at: "2026-08-05T10:00:00Z", status: "completed" }]);
	assert.equal(runStatusText(done), undefined);
});
