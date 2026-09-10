/**
 * JHL-18 - /workflows:view viewer tests: split-pane frame geometry, item
 * roster, page bodies, key reducer, stop state machine, refresh gating.
 *
 * All pure — no pi-tui component instantiation. `visibleWidth`/`stripAnsi`
 * are imported from the host as the width oracle only (locked behavior);
 * real host rendering is covered by ui-viewer-host.test.ts.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { stripTerminalSequences as stripAnsi, visibleWidth } from "@earendil-works/pi-tui";
import {
	VIEWER_CHROME_ROWS,
	VIEWER_LEGEND,
	VIEWER_OVERLAY_OPTIONS,
	RunViewer,
	assembleViewerData,
	clampViewerState,
	computeFrameHeight,
	computeViewerLayout,
	handleViewerKey,
	initialViewerState,
	plainStyles,
	renderViewerFrame,
	resultPageLines,
	scriptPageLines,
	stabilizeBodyHeight,
	stagePageLines,
	structurePageLines,
	viewerBodyLines,
	viewerDataFingerprint,
	viewerViewportHeight,
	withResolvedItem,
	type ViewerData,
	type ViewerKeyContext,
	type ViewerState,
} from "../src/ui/viewer.ts";
import type { RunDetail, StageView } from "../src/ui/types.ts";

const RUN_ID = "11111111-2222-3333-4444-555555555555";

/** Applies a key and returns the next state (fails the test on close). */
function key(state: ViewerState, data: string, ctx: ViewerKeyContext = KEY_CTX): ViewerState {
	const result = handleViewerKey(state, data, ctx);
	assert.equal(result.type, "update", `key ${JSON.stringify(data)} should update, not close`);
	if (result.type !== "update") throw new Error("unreachable");
	return result.state;
}

function makeDetail(overrides: Partial<RunDetail> = {}): RunDetail {
	return {
		runId: RUN_ID,
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

function fullData(): ViewerData {
	return assembleViewerData(fullDetail(), "await agent('x')", [{ runId: RUN_ID, scriptName: "demo-flow", status: "running" }]);
}

/** Body rows of the roster pane (between the frame's first two borders). */
function rosterPane(frame: string[], bodyHeight: number): string[] {
	return frame.slice(3, 3 + bodyHeight).map((line) => stripAnsi(line).split("│")[1] ?? "");
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

test("几何：computeFrameHeight 用 fleet 公式（max(2, floor(rows*0.85)-6)），非法 rows 回退 32", () => {
	assert.equal(computeFrameHeight(32), 21);
	assert.equal(computeFrameHeight(40), 28);
	assert.equal(computeFrameHeight(0), 21, "非法 rows 回退 fleet 默认 32 → 21");
	assert.equal(computeFrameHeight(Number.NaN), 21);
	assert.equal(computeFrameHeight(-3), 21);
	assert.equal(computeFrameHeight(2), 2, "极矮终端钳到 2 行");
	assert.equal(VIEWER_CHROME_ROWS, 6, "顶框/标题/上分隔/下分隔/图例/底框");
});

test("几何：分栏宽度 fleet 公式（roster 22..46，detail 取余）", () => {
	assert.deepEqual(computeViewerLayout(100), { innerWidth: 98, rosterWidth: 36, detailWidth: 61 });
	assert.deepEqual(computeViewerLayout(60), { innerWidth: 58, rosterWidth: 22, detailWidth: 35 });
	assert.deepEqual(computeViewerLayout(200), { innerWidth: 198, rosterWidth: 46, detailWidth: 151 });
	assert.deepEqual(computeViewerLayout(37), { innerWidth: 35, rosterWidth: 22, detailWidth: 12 });
});

test("overlay 几何：verbatim fleet 选项（宽 95% + maxHeight 85% + margin 1）", () => {
	assert.deepEqual(VIEWER_OVERLAY_OPTIONS, { anchor: "center", width: "95%", minWidth: 60, maxHeight: "85%", margin: 1 });
});

// ---------------------------------------------------------------------------
// Item roster model
// ---------------------------------------------------------------------------

test("assembleViewerData：条目顺序 结构 → stage* → 结果 → 脚本，id/状态齐全", () => {
	const data = fullData();
	assert.deepEqual(
		data.items.map((i) => i.kind),
		["structure", "stage", "stage", "result", "script"],
	);
	assert.deepEqual(
		data.items.map((i) => i.id),
		["structure", "stage-1", "stage-2", "result", "script"],
	);
	assert.deepEqual(
		data.items.map((i) => i.label),
		["结构", "audit", "build", "结果", "脚本"],
	);
	assert.equal(data.items[0]!.status, "running", "结构图标随 run 状态");
	assert.equal(data.items[1]!.status, "completed");
	assert.equal(data.items[2]!.status, "running");
	assert.equal(data.items[4]!.status, "只读");
	assert.equal(data.runs.length, 1);
	assert.equal(data.scriptSource, "await agent('x')");

	const empty = assembleViewerData(null, undefined, []);
	assert.equal(empty.detail, null);
	assert.deepEqual(
		empty.items.map((i) => i.kind),
		["structure", "result", "script"],
	);
});

test("withResolvedItem：itemId 优先于索引；target 消失后回落索引钳制", () => {
	const data = fullData();
	const pinned = withResolvedItem(data, { ...initialViewerState(), itemIndex: 0, itemId: "stage-2" });
	assert.equal(pinned.itemIndex, 2);
	const gone = withResolvedItem(data, { ...initialViewerState(), itemIndex: 99, itemId: "stage-gone" });
	assert.equal(gone.itemIndex, data.items.length - 1);
});

// ---------------------------------------------------------------------------
// Frame
// ---------------------------------------------------------------------------

test("renderViewerFrame：恒 bodyHeight + 6 行；每行精确列宽（含中文）", () => {
	const data = fullData();
	for (const width of [100, 61]) {
		const frame = renderViewerFrame(data, initialViewerState(), width, { styles: plainStyles(), bodyHeight: 14 });
		assert.equal(frame.length, 14 + VIEWER_CHROME_ROWS);
		for (const line of frame) {
			assert.equal(visibleWidth(line), width, `列宽应为 ${width}: ${JSON.stringify(stripAnsi(line))}`);
		}
	}
	const frame = renderViewerFrame(data, initialViewerState(), 100, { styles: plainStyles(), bodyHeight: 14 });
	assert.match(stripAnsi(frame[0]!), /^╭─+╮$/);
	assert.match(stripAnsi(frame[2]!), /^├─+┬─+┤$/);
	assert.match(stripAnsi(frame[3 + 14]!), /^├─+┴─+┤$/);
	assert.match(stripAnsi(frame[frame.length - 1]!), /^╰─+╯$/);
	assert.ok(stripAnsi(frame[1]!).includes("PWR viewer"), "标题行");
	assert.ok(stripAnsi(frame[1]!).includes("demo-flow"));
	assert.ok(stripAnsi(frame[1]!).includes(RUN_ID.slice(0, 8)), "标题含 run shortId");
	assert.ok(stripAnsi(frame[frame.length - 2]!).includes("D 停止"), "图例行含停止键");
	assert.equal(VIEWER_LEGEND.includes("[/] run"), true);
});

test("窄终端（< 36 列）只渲染一行提示", () => {
	const frame = renderViewerFrame(fullData(), initialViewerState(), 30, { styles: plainStyles(), bodyHeight: 10 });
	assert.equal(frame.length, 1);
	assert.match(stripAnsi(frame[0]!), /至少需要 36 列/);
	assert.ok(visibleWidth(frame[0]!) <= 30);
});

test("roster：选中标记/粗体语义/右对齐状态；选中项超出窗口时窗口跟随滚动", () => {
	const one = assembleViewerData(makeDetail({ stages: [STAGES[1]!] }), undefined, []);
	const single = renderViewerFrame(one, { ...initialViewerState(), itemId: "stage-2", itemIndex: 1 }, 100, {
		styles: plainStyles(),
		bodyHeight: 8,
	});
	const singleRoster = rosterPane(single, 8).filter((l) => l.trim().length > 0);
	const buildRow = singleRoster.find((l) => l.includes("build"));
	assert.ok(buildRow, "stage 行在 roster 中");
	assert.ok(buildRow!.includes("›"), "选中行带 › 标记");
	assert.ok(buildRow!.trimEnd().endsWith("running"), "状态右对齐到行尾");
	assert.ok(buildRow!.includes("▶"), "stage 图标");

	const stages: StageView[] = Array.from({ length: 20 }, (_, i) => ({
		stageId: `s${i}`,
		label: `S${String(i).padStart(2, "0")}`,
		kind: "agent",
		status: "queued",
		agentCount: 1,
	}));
	const many = assembleViewerData(makeDetail({ stages }), undefined, []);
	const frame = renderViewerFrame(many, { ...initialViewerState(), itemIndex: 20, itemId: "s19" }, 100, {
		styles: plainStyles(),
		bodyHeight: 6,
	});
	const roster = rosterPane(frame, 6);
	assert.ok(roster.some((l) => l.includes("S19")), "选中项在窗口内");
	assert.ok(roster.some((l) => l.includes("›")), "选中标记");
	assert.ok(!roster.some((l) => l.includes("S00")), "窗口跟随选中滚动（首项已滚出）");
});

test("viewerViewportHeight：bodyHeight − 三行头 − 换行后的横幅行数（≥1）", () => {
	const data = fullData();
	assert.equal(viewerViewportHeight(data, initialViewerState(), 200, 20, plainStyles()), 17);
	const confirming = { ...initialViewerState(), stopConfirming: true };
	assert.equal(viewerViewportHeight(data, confirming, 200, 20, plainStyles()), 15, "两行确认横幅");
	assert.equal(viewerViewportHeight(data, initialViewerState(), 200, 2, plainStyles()), 1, "极矮时最小 1");
});

test("确认横幅占正文窗口顶部且帧总行数不变", () => {
	const data = fullData();
	const before = renderViewerFrame(data, initialViewerState(), 100, { styles: plainStyles(), bodyHeight: 12 });
	const after = renderViewerFrame(data, { ...initialViewerState(), stopConfirming: true }, 100, {
		styles: plainStyles(),
		bodyHeight: 12,
	});
	assert.equal(after.length, before.length, "帧总行数恒定");
	const text = stripAnsi(after.join("\n"));
	assert.match(text, /确认停止 run 11111111？/);
	assert.match(text, /Enter\/Y 确认 · N 取消/);
});

// ---------------------------------------------------------------------------
// Page bodies
// ---------------------------------------------------------------------------

test("结构页：脚本 meta + 结构图 + 进度；每行不超宽", () => {
	const lines = structurePageLines(fullDetail(), 80);
	assert.ok(lines.some((l) => l.includes("demo-flow")));
	assert.ok(lines.some((l) => l.includes("脚本结构:")));
	assert.ok(lines.some((l) => l.includes("audit")));
	assert.ok(lines.some((l) => l.includes("1/2")), "agents 完成数/计划数");

	const noPlan = structurePageLines(makeDetail({ stages: STAGES }), 80);
	assert.ok(noPlan.some((l) => l.includes("历史会话记录")), "无 plan 时提示平铺来源");

	const missing = structurePageLines(null, 80);
	assert.ok(missing[0]!.includes("未找到"));

	for (const line of structurePageLines(fullDetail(), 40)) {
		assert.ok(visibleWidth(line) <= 40, `结构页行不超宽: ${JSON.stringify(line)}`);
	}
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

test("viewerBodyLines 按选中条目分发；stage 消失与无 run 的降级文案", () => {
	const data = fullData();
	const view = (id: string, overrides: Partial<ViewerState> = {}): string[] =>
		viewerBodyLines(data, { ...initialViewerState(), itemId: id, ...overrides }, 80);
	assert.ok(view("structure").some((l) => l.includes("脚本结构:")));
	assert.ok(view("stage-2").some((l) => l.includes("stage-2")));
	assert.ok(view("result").some((l) => l.includes("最终结果") || l.includes("尚未产生")));
	assert.ok(view("script").some((l) => l.includes("await agent")));
	assert.ok(view("stage-gone").some((l) => l.includes("该 stage 已不存在")));

	const orphan = assembleViewerData(null, undefined, []);
	assert.ok(viewerBodyLines(orphan, initialViewerState(), 80).some((l) => l.includes("未找到该 run")));
});

// ---------------------------------------------------------------------------
// Live per-step trace (v2.4): gated by showTrace
// ---------------------------------------------------------------------------

test("stage 正文的 trace 行由 showTrace 控制", () => {
	const running = makeDetail({
		stages: [{ stageId: "stage-2", label: "build", kind: "pipeline", status: "running", agentCount: 1 }],
		agents: [
			{
				taskId: "ffffffff-1111-2222-3333-444444444444",
				stageId: "stage-2",
				label: "build",
				status: "running",
				attempt: 1,
				recentEvents: ["▶ bash: npm test", "… running tests"],
			},
		],
	});
	const data = assembleViewerData(running, undefined, []);
	const withTrace = viewerBodyLines(data, { ...initialViewerState(), itemId: "stage-2", showTrace: true }, 80);
	assert.equal(withTrace.filter((l) => l.includes("└")).length, 2, "最多渲染最近两条活动");
	assert.ok(withTrace.some((l) => l.includes("▶ bash: npm test")));
	const hidden = viewerBodyLines(data, { ...initialViewerState(), itemId: "stage-2", showTrace: false }, 80);
	assert.equal(hidden.filter((l) => l.includes("└")).length, 0, "showTrace=false 隐藏 trace 行");

	const done = makeDetail({
		stages: [{ stageId: "stage-1", label: "audit", kind: "agent", status: "completed", agentCount: 1 }],
		agents: [
			{
				taskId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
				stageId: "stage-1",
				label: "audit",
				status: "completed",
				attempt: 1,
				recentEvents: ["▶ bash: npm test"],
			},
		],
	});
	const doneLines = stagePageLines(done, done.stages[0]!, 80);
	assert.equal(doneLines.filter((l) => l.includes("└")).length, 0, "非运行中 agent 不渲染 trace 行");
});

// ---------------------------------------------------------------------------
// Key handling
// ---------------------------------------------------------------------------

const KEY_CTX: ViewerKeyContext = {
	totalLines: 50,
	itemCount: 5,
	itemIds: ["structure", "stage-1", "stage-2", "result", "script"],
	bodyHeight: 10,
	runCount: 2,
	runRunning: true,
	runStatus: "running",
};

test("按键：close 键集 = Esc / ctrl+c / q（含 kitty 编码 Esc）", () => {
	for (const closeKey of ["q", "\x1b", "\x1b[27u", "\x03"]) {
		assert.equal(handleViewerKey(initialViewerState(), closeKey, KEY_CTX).type, "close", `key ${JSON.stringify(closeKey)}`);
	}
});

test("按键：↑↓/k/j 切换条目并复位滚动 + 钉 itemId；Home/End 首末", () => {
	const moved = key({ ...initialViewerState(), itemIndex: 2, itemId: "stage-2", scroll: 7, follow: false }, "j");
	assert.equal(moved.itemIndex, 3);
	assert.equal(moved.itemId, "result");
	assert.equal(moved.scroll, 0);
	assert.equal(moved.follow, true);
	assert.equal(key(moved, "k").itemIndex, 2);
	assert.equal(key(moved, "\x1b[1;1A").itemIndex, 2, "kitty 编码 up");
	assert.equal(key(moved, "\x1b[B").itemIndex, 4, "legacy down");

	assert.equal(key(initialViewerState(), "\x1b[F").itemIndex, 4);
	assert.equal(key({ ...initialViewerState(), itemIndex: 3 }, "\x1b[H").itemIndex, 0);
	assert.equal(key({ ...initialViewerState(), itemIndex: 3 }, "\x1b[1;1H").itemIndex, 0, "kitty 编码 home");
	const clamped = key({ ...initialViewerState(), itemIndex: 0 }, "k");
	assert.equal(clamped.itemIndex, 0, "首项再上钳位");
});

test("按键：Shift+K/J 滚正文（上滚 unfollow、到底 re-follow）", () => {
	const up = key({ ...initialViewerState(), scroll: 7, follow: false }, "K");
	assert.equal(up.scroll, 6);
	assert.equal(up.follow, false);
	const unfollow = key(initialViewerState(), "K");
	assert.equal(unfollow.scroll, 39, "follow 时从 bottom 上滚一行");
	assert.equal(unfollow.follow, false);
	const bottom = key({ ...initialViewerState(), scroll: 39, follow: false }, "J");
	assert.equal(bottom.scroll, 40);
	assert.equal(bottom.follow, true, "到底恢复 follow");
	assert.equal(key({ ...initialViewerState(), scroll: 0, follow: false }, "K").scroll, 0, "顶部钳位");
});

test("按键：PgUp/PgDn 整页滚动；x/X/ctrl+o 切 trace；r/R refresh", () => {
	const paged = key(initialViewerState(), "\x1b[5~");
	assert.equal(paged.scroll, 30, "follow 时 PgUp 从 bottom(40) 上翻一页");
	assert.equal(paged.follow, false);
	assert.equal(key({ ...initialViewerState(), scroll: 15, follow: false }, "\x1b[6~").scroll, 25);

	const off = key(initialViewerState(), "x");
	assert.equal(off.showTrace, false);
	assert.equal(key(off, "X").showTrace, true);
	assert.equal(key(initialViewerState(), "\x0f").showTrace, false, "ctrl+o 等价");

	for (const refreshKey of ["r", "R"]) {
		assert.equal(handleViewerKey(initialViewerState(), refreshKey, KEY_CTX).type, "refresh");
	}
});

test("按键：[/] 切换 run 并整页复位到结构页（trace 开关保留）", () => {
	const deep: ViewerState = {
		runIndex: 0,
		itemIndex: 3,
		itemId: "result",
		scroll: 9,
		follow: false,
		showTrace: false,
		stopConfirming: false,
	};
	const next = key(deep, "]");
	assert.equal(next.runIndex, 1);
	assert.equal(next.itemIndex, 0);
	assert.equal(next.itemId, "structure");
	assert.equal(next.scroll, 0);
	assert.equal(next.follow, true);
	assert.equal(next.showTrace, false, "trace 开关不因换 run 复位");
	const prev = key(next, "[");
	assert.equal(prev.runIndex, 0);
	assert.equal(key(next, "]").runIndex, 1, "runIndex 钳制在范围内");
});

test("按键：旧键（←→/h/l/Tab/1-9/g/G）退役——按下不改状态", () => {
	const state = initialViewerState();
	for (const retired of ["h", "l", "g", "G", "\t", "1", "3", "9", "\x1b[D", "\x1b[C"]) {
		assert.deepEqual(key(state, retired), state, `旧键 ${JSON.stringify(retired)} 应被忽略`);
	}
	assert.deepEqual(key(state, "z"), state, "未知键忽略");
});

test("按键：D 在可停止 run 上进入确认态；终态只出 warning notice", () => {
	const armed = handleViewerKey(initialViewerState(), "D", KEY_CTX);
	assert.equal(armed.type, "update");
	if (armed.type !== "update") throw new Error("unreachable");
	assert.equal(armed.state.stopConfirming, true, "D 进入两步确认态");
	// 两步确认第二步：确认态下 Enter 返回 stop-confirm（组件据此调 onStop）。
	assert.equal(handleViewerKey(armed.state, "\r", KEY_CTX).type, "stop-confirm");

	const idle = handleViewerKey(initialViewerState(), "D", { ...KEY_CTX, runRunning: false, runStatus: "completed" });
	assert.equal(idle.type, "update");
	if (idle.type !== "update") throw new Error("unreachable");
	assert.equal(idle.state.notice?.kind, "warning");
	assert.match(idle.state.notice?.text ?? "", /run 已结束（completed），无需停止/);
});

test("按键：停止确认态 Enter/Y 确认；Esc/ctrl+c/N/backspace 取消且不关闭；其余键忽略", () => {
	const confirming: ViewerState = { ...initialViewerState(), stopConfirming: true };
	assert.equal(handleViewerKey(confirming, "\r", KEY_CTX).type, "stop-confirm");
	assert.equal(handleViewerKey(confirming, "Y", KEY_CTX).type, "stop-confirm");

	for (const cancelKey of ["\x1b", "\x1b[27u", "\x03", "N", "\x7f"]) {
		const result = handleViewerKey(confirming, cancelKey, KEY_CTX);
		assert.equal(result.type, "update", `取消键 ${JSON.stringify(cancelKey)} 不关闭`);
		if (result.type !== "update") throw new Error("unreachable");
		assert.equal(result.state.stopConfirming, false);
	}

	const ignored = handleViewerKey(confirming, "j", KEY_CTX);
	assert.equal(ignored.type, "update");
	if (ignored.type !== "update") throw new Error("unreachable");
	assert.equal(ignored.state.stopConfirming, true, "确认态下移动键忽略");
});

test("clampViewerState：follow 贴底、scroll 钳制", () => {
	assert.equal(clampViewerState({ ...initialViewerState(), scroll: 999, follow: true }, 50, 10).scroll, 40);
	assert.equal(clampViewerState({ ...initialViewerState(), scroll: -5, follow: false }, 50, 10).scroll, 0);
});

// ---------------------------------------------------------------------------
// Refresh gating
// ---------------------------------------------------------------------------

test("viewerDataFingerprint：忽略 elapsed（顶层/stage/agent）纯时钟变化，内容变化则不同", () => {
	const base = makeDetail({
		elapsedMs: 1_000,
		stages: [{ stageId: "stage-1", label: "audit", kind: "agent", status: "running", agentCount: 1, elapsedMs: 1_000 }],
		agents: [
			{
				taskId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
				stageId: "stage-1",
				label: "audit",
				status: "running",
				attempt: 1,
				elapsedMs: 1_000,
				recentEvents: [],
			},
		],
	});
	const elapsedOnly = makeDetail({
		elapsedMs: 9_000,
		stages: [{ stageId: "stage-1", label: "audit", kind: "agent", status: "running", agentCount: 1, elapsedMs: 9_000 }],
		agents: [
			{
				taskId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
				stageId: "stage-1",
				label: "audit",
				status: "running",
				attempt: 1,
				elapsedMs: 9_000,
				recentEvents: [],
			},
		],
	});
	assert.equal(viewerDataFingerprint(assembleViewerData(base, "src", [])), viewerDataFingerprint(assembleViewerData(elapsedOnly, "src", [])));

	const progressed = makeDetail({
		...base,
		agents: [
			{
				taskId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
				stageId: "stage-1",
				label: "audit",
				status: "running",
				attempt: 1,
				elapsedMs: 1_000,
				recentEvents: ["▶ bash: npm test"],
			},
		],
	});
	assert.notEqual(viewerDataFingerprint(assembleViewerData(base, "src", [])), viewerDataFingerprint(assembleViewerData(progressed, "src", [])));
});

test("stabilizeBodyHeight：±1 抖动保持旧高度，超出才换", () => {
	assert.equal(stabilizeBodyHeight(21, 22), 21);
	assert.equal(stabilizeBodyHeight(21, 20), 21);
	assert.equal(stabilizeBodyHeight(21, 23), 23);
	assert.equal(stabilizeBodyHeight(0, 21), 21);
});

// ---------------------------------------------------------------------------
// Stop state machine (real RunViewer + fake onStop)
// ---------------------------------------------------------------------------

function viewerWith(opts: { onStop?: (runId: string) => Promise<{ ok: boolean; text: string }>; done?: () => void } = {}): RunViewer {
	return new RunViewer({
		load: () => fullData(),
		initialRunId: RUN_ID,
		done: opts.done ?? ((): void => {}),
		styles: plainStyles(),
		rows: () => 40,
		refreshMs: 3_600_000, // timer 不参与：帧由显式 render 驱动
		...(opts.onStop ? { onStop: opts.onStop } : {}),
	});
}

test("停止状态机：D→Enter 恰调一次 onStop，busy 横幅与成功 notice，重复确认被守卫", async () => {
	let resolveStop!: (value: { ok: boolean; text: string }) => void;
	const calls: string[] = [];
	const viewer = viewerWith({
		onStop: (runId) => {
			calls.push(runId);
			return new Promise((resolve) => {
				resolveStop = resolve;
			});
		},
	});
	try {
		viewer.handleInput("D");
		assert.match(stripAnsi(viewer.render(100).join("\n")), /确认停止 run 11111111？/);
		viewer.handleInput("\r");
		assert.deepEqual(calls, [RUN_ID], "确认后 onStop 恰调一次");
		assert.match(stripAnsi(viewer.render(100).join("\n")), /停止中…/, "busy 横幅上屏");
		viewer.handleInput("\r");
		viewer.handleInput("Y");
		assert.deepEqual(calls, [RUN_ID], "busy 守卫：重复确认不重复调 onStop");

		resolveStop({ ok: true, text: "stop ok (run 11111111)" });
		await new Promise((resolve) => setTimeout(resolve, 0));
		const frame = stripAnsi(viewer.render(100).join("\n"));
		assert.match(frame, /stop ok \(run 11111111\)/, "成功 notice 用控制返回值文本");
		assert.doesNotMatch(frame, /停止中…/, "busy 已撤");
		assert.doesNotMatch(frame, /确认停止 run/, "确认横幅已撤");
	} finally {
		viewer.dispose();
	}
});

test("停止状态机：ok:false → warning notice 带原文；reject → error notice 固定文案", async () => {
	const failed = viewerWith({ onStop: async () => ({ ok: false, text: "Error: run not found (RUN_NOT_FOUND)." }) });
	try {
		failed.handleInput("D");
		failed.handleInput("\r");
		await new Promise((resolve) => setTimeout(resolve, 0));
		assert.match(stripAnsi(failed.render(100).join("\n")), /Error: run not found \(RUN_NOT_FOUND\)\./);
	} finally {
		failed.dispose();
	}

	const thrown = viewerWith({
		onStop: () => Promise.reject(new Error("boom")),
	});
	try {
		thrown.handleInput("D");
		thrown.handleInput("Y");
		await new Promise((resolve) => setTimeout(resolve, 0));
		assert.match(stripAnsi(thrown.render(100).join("\n")), /停止失败（控制调用异常）/);
	} finally {
		thrown.dispose();
	}
});

test("停止状态机：未注入 onStop → error notice；取消不关闭；dispose 幂等", () => {
	let doneCalls = 0;
	const viewer = viewerWith({ done: () => (doneCalls += 1) });
	try {
		viewer.handleInput("D");
		viewer.handleInput("N");
		assert.equal(doneCalls, 0, "取消确认不关闭查看器");
		assert.doesNotMatch(stripAnsi(viewer.render(100).join("\n")), /确认停止 run/);
		viewer.handleInput("D");
		viewer.handleInput("\r");
		assert.match(stripAnsi(viewer.render(100).join("\n")), /停止不可用：当前上下文没有接停止动作/);
		viewer.handleInput("q");
		assert.equal(doneCalls, 1, "q 关闭恰回调一次");
		viewer.dispose();
		viewer.dispose();
	} finally {
		viewer.dispose();
	}
});

test("RunViewer 定时刷新门控：elapsed 纯推进不请求重绘，内容变化才请求", async () => {
	let elapsedMs = 1_000;
	let extraEvents: string[] = [];
	let loads = 0;
	let renders = 0;
	const viewer = new RunViewer({
		load: () => {
			loads += 1;
			const detail = fullDetail();
			detail.elapsedMs = elapsedMs;
			detail.agents[0]!.recentEvents = extraEvents;
			return assembleViewerData(detail, "src", []);
		},
		initialRunId: RUN_ID,
		done: () => {},
		styles: plainStyles(),
		rows: () => 40,
		refreshMs: 5,
		requestRender: () => (renders += 1),
	});
	const waitFor = async (predicate: () => boolean): Promise<void> => {
		for (let i = 0; i < 600 && !predicate(); i++) await new Promise((resolve) => setTimeout(resolve, 5));
	};
	try {
		elapsedMs = 9_000; // 纯时钟推进：指纹不变
		await waitFor(() => loads >= 3);
		assert.ok(loads >= 3, `tick 应持续重载，实得 ${loads}`);
		assert.equal(renders, 0, "仅 elapsed 变化不请求重绘");

		extraEvents = ["▶ bash: npm test"]; // 内容变化
		await waitFor(() => renders >= 1);
		assert.ok(renders >= 1, "内容变化触发重绘请求");
	} finally {
		viewer.dispose();
		viewer.dispose();
	}
});
