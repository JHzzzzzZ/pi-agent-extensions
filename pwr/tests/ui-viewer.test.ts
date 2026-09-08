/**
 * JHL-18 - /workflows:view viewer tests: frame shape, page assembly, page
 * bodies, key reducer, state clamping. All pure — no pi-tui instantiation.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
	VIEWER_CHROME_ROWS,
	assembleViewerData,
	clampViewerState,
	computeFrameHeight,
	handleViewerKey,
	initialViewerState,
	plainStyles,
	renderViewerFrame,
	resultPageLines,
	scriptPageLines,
	stagePageLines,
	structurePageLines,
	viewerBodyLines,
	type ViewerKeyContext,
	type ViewerState,
} from "../src/ui/viewer.ts";
import type { RunDetail, StageView } from "../src/ui/types.ts";

/** Applies a key and returns the next state (fails the test on close). */
function key(state: ViewerState, data: string, ctx: ViewerKeyContext = KEY_CTX): ViewerState {
	const result = handleViewerKey(state, data, ctx);
	assert.equal(result.type, "update", `key ${JSON.stringify(data)} should update, not close`);
	if (result.type !== "update") throw new Error("unreachable");
	return result.state;
}

function makeDetail(overrides: Partial<RunDetail> = {}): RunDetail {
	return {
		runId: "11111111-2222-3333-4444-555555555555",
		scriptId: "sc1",
		scriptName: "demo-flow",
		status: "running",
		digest: "0123456789abcdef",
		createdAt: "2026-08-05T12:00:00Z",
		startedAt: "2026-08-05T12:00:01Z",
		stages: [],
		agents: [],
		warnings: [],
		...overrides,
	};
}

const STAGES: StageView[] = [
	{ stageId: "stage-1", label: "audit", kind: "agent", status: "completed", agentCount: 1, writeRisk: false },
	{ stageId: "stage-2", label: "build", kind: "pipeline", status: "running", agentCount: 3, dynamic: true },
];

function fullDetail(): RunDetail {
	return makeDetail({
		plan: {
			stages: [
				{ stageId: "stage-1", label: "audit", kind: "agent", agentCount: 1, writeRisk: false },
				{ stageId: "stage-2", label: "build", kind: "pipeline", agentCount: 3, writeRisk: false },
			],
			budget: { agentCalls: 4, pipelineCalls: 1, parallelCalls: 0, estimatedAgents: 4, writeRisk: false, warnLargeRun: false },
			tree: [
				{ label: "audit", kind: "agent", agentCount: 1, writeRisk: false, stageId: "stage-1" },
				{ label: "build", kind: "pipeline", agentCount: 3, writeRisk: false, stageId: "stage-2" },
			],
		},
		stages: STAGES,
		agents: [
			{
				taskId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
				stageId: "stage-1",
				label: "audit",
				status: "completed",
				attempt: 1,
				resultSummary: "12 files audited",
				tokens: 12_000,
				elapsedMs: 4_000,
				cacheHit: true,
				recentEvents: [],
			},
			{
				taskId: "ffffffff-1111-2222-3333-444444444444",
				stageId: "stage-2",
				label: "build",
				status: "failed",
				attempt: 2,
				errorCode: "AGENT_EXECUTION_ERROR",
				error: "boom",
				recentEvents: [],
			},
		],
		totalTokens: 12_000,
		totalCost: 0.05,
		elapsedMs: 65_000,
	});
}

test("computeFrameHeight：约 82% 终端高度，最小 12 行", () => {
	assert.equal(computeFrameHeight(40), 32);
	assert.equal(computeFrameHeight(10), 12);
	assert.equal(computeFrameHeight(0), 24, "异常行数回退到 24");
});

test("assembleViewerData：页面顺序为 结构 → 每 stage 一页 → 结果 → 脚本", () => {
	const data = assembleViewerData(fullDetail(), "const x = 1;", [{ runId: "r1", scriptName: "demo", status: "running" }]);
	assert.deepEqual(
		data.pages.map((p) => p.kind),
		["structure", "stage", "stage", "result", "script"],
	);
	assert.deepEqual(data.pageTitles, ["结构", "audit", "build", "结果", "脚本"]);
	assert.equal(data.runs.length, 1);

	const empty = assembleViewerData(null, undefined, []);
	assert.equal(empty.detail, null);
	assert.deepEqual(
		empty.pages.map((p) => p.kind),
		["structure", "result", "script"],
	);
});

test("结构页：脚本 meta + 结构图 + 进度", () => {
	const lines = structurePageLines(fullDetail(), 80);
	assert.ok(lines.some((l) => l.includes("demo-flow")));
	assert.ok(lines.some((l) => l.includes("脚本结构:")));
	assert.ok(lines.some((l) => l.includes("audit")));
	assert.ok(lines.some((l) => l.includes("1/2")), "agents 完成数/计划数");

	const noPlan = structurePageLines(makeDetail({ stages: STAGES }), 80);
	assert.ok(noPlan.some((l) => l.includes("历史会话记录")), "无 plan 时提示平铺来源");

	const missing = structurePageLines(null, 80);
	assert.ok(missing[0]!.includes("未找到"));
});

test("stage 页：任务行含 ⚡cache、attempt、失败详情与最近结果", () => {
	const auditPage = stagePageLines(fullDetail(), STAGES[0]!, 80);
	assert.ok(auditPage.some((l) => l.includes("stage-1 · audit · agent")));
	assert.ok(auditPage.some((l) => l.includes("⚡cache")), "cache 命中任务带 ⚡ 标记");
	assert.ok(auditPage.some((l) => l.includes("最近结果:")));
	assert.ok(auditPage.some((l) => l.includes("12 files audited")));

	const buildPage = stagePageLines(fullDetail(), STAGES[1]!, 80);
	assert.ok(buildPage.some((l) => l.includes("stage-2 · build · pipeline ×3≈")));
	assert.ok(buildPage.some((l) => l.includes("attempt 2")));
	assert.ok(buildPage.some((l) => l.includes("失败详情:")));
	assert.ok(buildPage.some((l) => l.includes("AGENT_EXECUTION_ERROR")));
});

test("结果页与脚本页", () => {
	const done = resultPageLines(makeDetail({ finalSummary: "全部通过", status: "completed" }), 80);
	assert.ok(done.some((l) => l.includes("全部通过")));

	const failed = resultPageLines(makeDetail({ status: "failed", errorCode: "SCRIPT_ERROR", errorMessage: "boom" }), 80);
	assert.ok(failed.some((l) => l.includes("boom")));

	const pending = resultPageLines(makeDetail(), 80);
	assert.ok(pending.some((l) => l.includes("尚未产生最终结果")));

	const noScript = scriptPageLines(undefined, 80);
	assert.ok(noScript[0]!.includes("未保留"));
	const withScript = scriptPageLines("await agent('x')", 80);
	assert.ok(withScript.some((l) => l.includes("await agent")));
});

test("viewerBodyLines 按页分发", () => {
	const data = assembleViewerData(fullDetail(), "src", []);
	assert.ok(viewerBodyLines(data, initialViewerState(), 80).some((l) => l.includes("脚本结构:")));
	const stageState = { ...initialViewerState(), pageIndex: 1 };
	assert.ok(viewerBodyLines(data, stageState, 80).some((l) => l.includes("stage-1")));
	const resultState = { ...initialViewerState(), pageIndex: 3 };
	assert.ok(viewerBodyLines(data, resultState, 80).some((l) => l.includes("最终结果") || l.includes("尚未产生")));
});

test("renderViewerFrame：完整边框、精确行数（bodyHeight + 3）", () => {
	const data = assembleViewerData(fullDetail(), "src", [{ runId: "r1", scriptName: "d", status: "running" }]);
	const frame = renderViewerFrame(data, initialViewerState(), 100, { styles: plainStyles(), bodyHeight: 10 });
	assert.equal(frame.length, 10 + VIEWER_CHROME_ROWS);
	assert.match(frame[0]!, /^╭─ .*╮$/);
	assert.match(frame[frame.length - 1]!, /^╰─ .*╯$/);
	for (const line of frame.slice(1, -1)) assert.match(line, /^│ .*│$/);
	assert.ok(frame[1]!.includes("结构"), "tabs 行含页名");
	assert.ok(frame[0]!.includes("PWR"), "顶栏含 PWR 标识");
});

const KEY_CTX: ViewerKeyContext = { totalLines: 50, pageCount: 5, runCount: 2, bodyHeight: 10 };

test("按键：翻页键换页并复位滚动；1-9 直达", () => {
	assert.equal(handleViewerKey(initialViewerState(), "q", KEY_CTX).type, "close");
	assert.equal(handleViewerKey(initialViewerState(), "\x1b", KEY_CTX).type, "close");

	const scrolled = { ...initialViewerState(), scroll: 7, follow: false };
	const paged = key(scrolled, "l");
	assert.equal(paged.pageIndex, 1);
	assert.equal(paged.scroll, 0);
	assert.equal(paged.follow, true);

	const back = key({ ...initialViewerState(), pageIndex: 3 }, "h");
	assert.equal(back.pageIndex, 2);
	const tab = key({ ...initialViewerState(), pageIndex: 4 }, "\t");
	assert.equal(tab.pageIndex, 4, "超出末页被钳制");
	const jump = key(initialViewerState(), "3");
	assert.equal(jump.pageIndex, 2);
	const noJump = key(initialViewerState(), "9");
	assert.equal(noJump.pageIndex, 0, "9 超出页数时忽略");
});

test("按键：滚动与 follow 语义", () => {
	const top = initialViewerState(); // follow=true → scroll 钳制到 bottom(40)
	const up = key(top, "k");
	assert.equal(up.follow, false);
	assert.equal(up.scroll, 39);

	const down = key({ ...initialViewerState(), scroll: 30, follow: false }, "j");
	assert.equal(down.scroll, 31);
	assert.equal(down.follow, false, "未到底不恢复 follow");

	const bottom = key({ ...initialViewerState(), scroll: 39, follow: false }, "j");
	assert.equal(bottom.follow, true, "到底自动恢复 follow");

	const home = key(initialViewerState(), "g");
	assert.equal(home.scroll, 0);
	assert.equal(home.follow, false);
	const end = key({ ...initialViewerState(), scroll: 0, follow: false }, "G");
	assert.equal(end.follow, true);
});

test("按键：[/] 切换 run 并整页复位", () => {
	const deep = { runIndex: 0, pageIndex: 2, scroll: 9, follow: false };
	const next = key(deep, "]");
	assert.equal(next.runIndex, 1);
	assert.equal(next.pageIndex, 0);
	assert.equal(next.scroll, 0);
	assert.equal(next.follow, true);

	const prev = key({ ...next }, "[");
	assert.equal(prev.runIndex, 0);
	const clampRun = key({ ...next }, "]");
	assert.equal(clampRun.runIndex, 1, "runIndex 钳制在范围内");
});

test("未知按键不改变状态", () => {
	const state = initialViewerState();
	assert.deepEqual(key(state, "z"), state);
});

test("clampViewerState：follow 贴底、scroll/page 钳制", () => {
	const clamped = clampViewerState({ runIndex: 0, pageIndex: 99, scroll: 999, follow: true }, 50, 10, 5);
	assert.equal(clamped.pageIndex, 4);
	assert.equal(clamped.scroll, 40);

	const topClamped = clampViewerState({ runIndex: 0, pageIndex: -1, scroll: -5, follow: false }, 50, 10, 5);
	assert.equal(topClamped.pageIndex, 0);
	assert.equal(topClamped.scroll, 0);
});
