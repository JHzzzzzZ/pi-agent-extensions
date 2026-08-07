/**
 * JHL-15 - pure text views tests: statuses are never color-only, list/detail
 * text covers PRD 4.3 fields (run id, script name, status, elapsed, agents
 * done, warnings, stages, agents, digest, save actions).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
	RUN_STATUS_GLYPH,
	formatAgentLine,
	formatBudget,
	formatCost,
	formatCount,
	formatDetailWarnings,
	formatDigest,
	formatDuration,
	formatRunDetail,
	formatRunList,
	formatRunListLine,
	formatStageLine,
	formatStatus,
	formatTokens,
	runCardLines,
} from "../src/ui/views.ts";
import type { AgentView, RunDetail, RunListEntry, StageView } from "../src/ui/types.ts";

const RUN: RunListEntry = {
	runId: "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6",
	scriptName: "audit-routes",
	status: "running",
	totalElapsedMs: 192_000,
	completedAgents: 12,
	totalAgents: 40,
	tokens: 812_000,
	cost: 0.42,
	warnings: ["large run (40 agents)"],
	createdAt: "2026-08-05T12:00:00Z",
};

test("every run status renders as a text glyph + word (never color-only)", () => {
	for (const status of ["draft", "awaiting_approval", "queued", "running", "paused", "completed", "failed", "cancelled"] as const) {
		const text = formatStatus(status);
		assert.ok(text.includes(status), `status word must appear: ${text}`);
		assert.ok(RUN_STATUS_GLYPH[status], `glyph must exist for ${status}`);
		assert.ok(!text.includes("\x1b["), "no ANSI color codes in status text");
	}
});

test("formatDuration handles ms/s/m/h", () => {
	assert.equal(formatDuration(undefined), "-");
	assert.equal(formatDuration(500), "500ms");
	assert.equal(formatDuration(1_200), "1s");
	assert.equal(formatDuration(192_000), "3m 12s");
	assert.equal(formatDuration(3_600_000), "1h 00m");
});

test("formatTokens / formatCost / formatCount / formatDigest", () => {
	assert.equal(formatTokens(undefined), "-");
	assert.equal(formatTokens(812_000), "812k");
	assert.equal(formatTokens(1_500_000), "1.5M");
	assert.equal(formatCost(0.42), "$0.42");
	assert.equal(formatCount(12, 40), "12/40");
	assert.equal(formatDigest("abcdef1234567890"), "abcdef123456");
});

test("run list line carries id, script, status, elapsed, agents, tokens, warnings", () => {
	const line = formatRunListLine(RUN);
	assert.ok(line.includes("a1b2c3d4"));
	assert.ok(line.includes("audit-routes"));
	assert.ok(line.includes("running"));
	assert.ok(line.includes("3m 12s"));
	assert.ok(line.includes("12/40"));
	assert.ok(line.includes("812k"));
	assert.ok(line.includes("[!] large run (40 agents)"));
});

test("run list supports status filter", () => {
	const list = formatRunList([RUN, { ...RUN, runId: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", status: "completed", warnings: [] }], {
		statusFilter: "running",
	});
	assert.ok(list.includes("filter: running"));
	assert.ok(list.includes("a1b2c3d4"));
	assert.ok(!list.includes("bbbbbbbb"), "filtered-out run must not appear");
});

const STAGE: StageView = {
	stageId: "s1",
	label: "discover",
	kind: "pipeline",
	status: "running",
	agentCount: 8,
	tokens: 100_000,
	elapsedMs: 100_000,
};

test("stage line renders status text + label + agents + tokens + elapsed", () => {
	const line = formatStageLine(STAGE);
	assert.ok(line.includes("running"));
	assert.ok(line.includes("discover"));
	assert.ok(line.includes("8 agents"));
	assert.ok(line.includes("100k"));
	assert.ok(line.includes("1m 40s"));
});

test("动态阶段显示 · 动态", () => {
	const line = formatStageLine({ ...STAGE, dynamic: true });
	assert.ok(line.includes("3 agents · 动态") === false, "STAGE fixture is 8 agents");
	assert.ok(line.includes("8 agents · 动态"));
	const plain = formatStageLine({ ...STAGE, dynamic: undefined });
	assert.ok(!plain.includes("· 动态"));
	const single = formatStageLine({ ...STAGE, kind: "agent", dynamic: true });
	assert.ok(single.includes("single"), "agent stages never show the marker");
});

const AGENT: AgentView = {
	taskId: "task-0001",
	stageId: "s1",
	label: "discover/task-0001",
	status: "completed",
	attempt: 1,
	promptSummary: "列出 src/routes 下的路由文件",
	toolPolicy: "readonly",
	recentEvents: ["started", "listed 12 files"],
	resultSummary: "found 12 files",
	elapsedMs: 90_000,
};

test("agent line renders status, label, attempt, tools, elapsed", () => {
	const line = formatAgentLine(AGENT);
	assert.ok(line.includes("completed"));
	assert.ok(line.includes("attempt 1"));
	assert.ok(line.includes("tools: readonly"));
	assert.ok(line.includes("1m 30s"));
});

const DETAIL: RunDetail = {
	runId: "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6",
	scriptId: "script-1",
	scriptName: "audit-routes",
	status: "running",
	digest: "abcdef1234567890",
	meta: { name: "audit-routes", description: "审查路由鉴权", version: 1 },
	createdAt: "2026-08-05T12:00:00Z",
	startedAt: "2026-08-05T12:00:05Z",
	budget: { agentCalls: 40, pipelineCalls: 1, parallelCalls: 0, estimatedAgents: 40, writeRisk: true, warnLargeRun: true },
	stages: [STAGE],
	agents: [AGENT],
	totalTokens: 812_000,
	totalCost: 0.42,
	elapsedMs: 192_000,
	warnings: ["large run (40 agents)"],
};

test("detail view covers PRD 4.3 sections and command reachability", () => {
	const text = formatRunDetail(DETAIL);
	assert.ok(text.includes("audit-routes"));
	assert.ok(text.includes("a1b2c3d4"));
	assert.ok(text.includes("digest abcdef123456"));
	assert.ok(text.includes("Stages (1)"));
	assert.ok(text.includes("Agents (1)"));
	assert.ok(text.includes("prompt: 列出 src/routes 下的路由文件"));
	assert.ok(text.includes("result: found 12 files"));
	assert.ok(text.includes("/workflows:pause"));
	assert.ok(text.includes("/workflows:stop"));
	assert.ok(text.includes("/workflows:restart"));
	assert.ok(text.includes("/workflows:save"));
	assert.ok(text.includes("ctrl+alt+p"));
	assert.ok(text.includes("[!] large run (40 agents)"));
});

test("final summary appears in detail once available", () => {
	const text = formatRunDetail({ ...DETAIL, finalSummary: "all endpoints verified" });
	assert.ok(text.includes("final:"));
	assert.ok(text.includes("all endpoints verified"));
});

test("formatRunDetail 渲染 run 级错误行", () => {
	const text = formatRunDetail({ ...DETAIL, status: "failed", errorCode: "AGENT_EXECUTION_ERROR", errorMessage: "boom", finalSummary: "s" });
	assert.ok(text.includes("error:       AGENT_EXECUTION_ERROR: boom"));
	assert.ok(text.indexOf("error:") < text.indexOf("final:"), "error line precedes final line");
	const noCode = formatRunDetail({ ...DETAIL, status: "failed", errorMessage: "boom" });
	assert.ok(noCode.includes("error:       -: boom"));
	const noMessage = formatRunDetail({ ...DETAIL, status: "failed" });
	assert.ok(!noMessage.includes("error:"), "no error line without a message");
});

test("budget text includes write risk and large-run warning", () => {
	const budget = formatBudget(DETAIL.budget);
	assert.ok(budget.includes("~40 agents"));
	assert.ok(budget.includes("write risk: yes"));
	assert.ok(budget.includes("large run"));
});

test("warnings summary text", () => {
	assert.equal(formatDetailWarnings(DETAIL), "[!] large run (40 agents)");
	assert.equal(formatDetailWarnings({ ...DETAIL, warnings: [] }), "-");
});

test("card lines stay compact (short summary for the main session)", () => {
	const lines = runCardLines(DETAIL);
	assert.equal(lines.length, 3);
	assert.ok(lines[0]!.includes("running"));
	assert.ok(lines[0]!.includes("3m 12s"));
	assert.ok(lines[1]!.includes("812k"));
	assert.ok(lines[2]!.includes("[!] large run (40 agents)"));
});
