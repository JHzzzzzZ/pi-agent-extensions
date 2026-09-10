/**
 * PWR — /workflows:view viewer through the REAL host stack (headless)
 *
 * 纯函数单测绿 ≠ 真机行为对：overlay 堆叠（每 tick 追加一组标题+分栏）
 * 只存在于真实合成/diff 路径里。本文件把 RunViewer 接到真实的
 * `TuiMainScreen`（render → compositeOverlays → previousLines diff → 终端
 * 字节流）上跑，并用一个最小 scrollback VT 仿真器把字节流还原成用户实际
 * 看到的屏幕，断言标题行与 roster 行恒为一组、边框恒为一对。
 *
 * FakeScreen 与场景驱动移植自 agent-team `test/viewer-host.test.ts`（同
 * workspace 已验证模式）；本仓库惯例"测试中不实例化真实 pi-tui"在此文件
 * 破例——堆叠 bug 恰恰只存在于真实路径，fake 结构断言不到。
 */

import * as assert from "node:assert/strict";
import { test } from "node:test";
import { TuiMainScreen, stripTerminalSequences as stripAnsi, type Component } from "@earendil-works/pi-tui";
import { VIEWER_OVERLAY_OPTIONS, RunViewer, assembleViewerData, plainStyles, type ViewerData } from "../src/ui/viewer.ts";
import type { RunDetail, StageView } from "../src/ui/types.ts";

// ---------------------------------------------------------------------------
// 最小 scrollback VT 仿真器（移植自 agent-team/test/viewer-host.test.ts，
// 略作裁剪）：只实现主屏 diff 渲染器实际发出的序列（\r \n \x1b[nA/B
// \x1b[H \x1b[{r};{c}H \x1b[2K \x1b[2J \x1b[3J SGR OSC/APC/private-mode），
// 可打印字符按显示宽度落格。
// ---------------------------------------------------------------------------

const WIDE_CONT = "\0";

function charWidth(ch: string): number {
	const code = ch.codePointAt(0) ?? 0;
	if (
		(code >= 0x1100 && code <= 0x115f) ||
		(code >= 0x2e80 && code <= 0xa4cf) ||
		(code >= 0xac00 && code <= 0xd7a3) ||
		(code >= 0xf900 && code <= 0xfaff) ||
		(code >= 0xfe30 && code <= 0xfe4f) ||
		(code >= 0xff00 && code <= 0xff60) ||
		(code >= 0xffe0 && code <= 0xffe6) ||
		(code >= 0x20000 && code <= 0x3fffd)
	) {
		return 2;
	}
	return 1;
}

class FakeScreen {
	private readonly slots: string[][] = [];
	private row = 0;
	private col = 0;

	readonly cols: number;
	readonly rows: number;

	constructor(cols: number, rows: number) {
		this.cols = cols;
		this.rows = rows;
	}

	private viewportStart(): number {
		return Math.max(0, this.slots.length - this.rows);
	}

	private ensureRow(r: number): string[] {
		while (this.slots.length <= r) this.slots.push([]);
		const line = this.slots[r];
		if (!line) throw new Error("unreachable");
		return line;
	}

	private writeChar(ch: string): void {
		const line = this.ensureRow(this.row);
		const w = charWidth(ch);
		if ((line[this.col] ?? "") === WIDE_CONT && this.col > 0) line[this.col - 1] = "";
		line[this.col] = ch;
		if (w === 2) line[this.col + 1] = WIDE_CONT;
		else if ((line[this.col + 1] ?? "") === WIDE_CONT) line[this.col + 1] = "";
		this.col += w;
	}

	/** 消费渲染器写出的全部字节，返回后本屏即"用户看到的画面"。 */
	feed(data: string): void {
		let i = 0;
		const skipCsi = (): void => {
			while (i < data.length) {
				const code = data.charCodeAt(i) ?? 0;
				i += 1;
				if (code >= 0x40 && code <= 0x7e) return;
			}
		};
		const skipUntilBelOrSt = (): void => {
			while (i < data.length) {
				if (data[i] === "\x07") {
					i += 1;
					return;
				}
				if (data[i] === "\x1b" && data[i + 1] === "\\") {
					i += 2;
					return;
				}
				i += 1;
			}
		};
		while (i < data.length) {
			const ch = data[i] ?? "";
			if (ch === "\x1b" && data[i + 1] === "[") {
				i += 2;
				let params = "";
				while (i < data.length) {
					const code = data.charCodeAt(i) ?? 0;
					if (code >= 0x40 && code <= 0x7e) break;
					params += data[i];
					i += 1;
				}
				const fin = data[i] ?? "";
				i += 1;
				this.applyCsi(params, fin);
				continue;
			}
			if (ch === "\x1b" && data[i + 1] === "]") {
				i += 2;
				skipUntilBelOrSt();
				continue;
			}
			if (ch === "\x1b" && data[i + 1] === "_") {
				i += 2;
				skipUntilBelOrSt();
				continue;
			}
			if (ch === "\x1b") {
				i += 1;
				skipCsi();
				continue;
			}
			if (ch === "\r") {
				this.col = 0;
				i += 1;
				continue;
			}
			if (ch === "\n") {
				this.row += 1;
				this.ensureRow(this.row);
				i += 1;
				continue;
			}
			if (ch === "\x07" || ch === "\0") {
				i += 1;
				continue;
			}
			this.writeChar(ch);
			i += 1;
		}
	}

	private applyCsi(params: string, fin: string): void {
		const nums = params
			.replace(/^[?]/, "")
			.split(";")
			.map((p) => Number(p))
			.filter((n) => Number.isInteger(n));
		const n = (dflt: number): number => nums[0] ?? dflt;
		switch (fin) {
			case "A":
				this.row = Math.max(0, this.row - n(1));
				break;
			case "B":
				this.row = this.row + n(1);
				this.ensureRow(this.row);
				break;
			case "H": {
				if (params === "" || nums.length === 0) {
					this.row = this.viewportStart();
					this.col = 0;
				} else {
					this.row = this.viewportStart() + (nums[0] ?? 1) - 1;
					this.col = (nums[1] ?? 1) - 1;
					this.ensureRow(this.row);
				}
				break;
			}
			case "K":
				this.slots[this.row] = [];
				break;
			case "J": {
				const mode = n(0);
				if (mode === 2) {
					const start = this.viewportStart();
					for (let r = start; r < start + this.rows; r++) this.slots[r] = [];
				} else if (mode === 3) {
					const dropped = this.viewportStart();
					this.slots.splice(0, dropped);
					this.row = Math.max(0, this.row - dropped);
				}
				break;
			}
			default:
				break; // SGR/同步输出/光标显隐：无像素影响
		}
	}

	/** 当前全缓冲文本行（ANSI 已剥离，宽字符占位已清除）。 */
	text(): string[] {
		return this.slots.map((line) => line.join("").replaceAll(WIDE_CONT, ""));
	}
}

// ---------------------------------------------------------------------------
// 场景驱动：真实 TuiMainScreen + 假终端 + 真实 RunViewer
// ---------------------------------------------------------------------------

const RUN_ID = "2f6c1a10-9a11-4b22-8c33-2a4b5c6d7e8f";

function agentTask(stageId: string, status: "running" | "completed"): RunDetail["agents"][number] {
	return {
		taskId: `${stageId}-task-0000-0000-000000000000`,
		stageId,
		label: stageId,
		status,
		attempt: 1,
		elapsedMs: 3_000,
		recentEvents: status === "running" ? ["▶ bash: npm test", "… running tests"] : [],
	};
}

/** 真实形态的 pwr 快照：stage 增长、elapsed 每秒推进、trace 行更新。 */
function scenarioData(elapsedSec: number, stageCount: number): ViewerData {
	const stages: StageView[] = Array.from({ length: stageCount }, (_, i) => ({
		stageId: `stage-${i + 1}`,
		label: `S${i + 1}`,
		kind: i === 0 ? "agent" : "pipeline",
		status: i === stageCount - 1 ? "running" : "completed",
		agentCount: i === 0 ? 1 : 3,
	}));
	const detail: RunDetail = {
		runId: RUN_ID,
		scriptId: "sc1",
		scriptName: "count-flow",
		status: "running",
		digest: "0123456789abcdef",
		createdAt: "2026-09-06T12:00:00Z",
		startedAt: "2026-09-06T12:00:01Z",
		plan: {
			stages: stages.map((s) => ({ stageId: s.stageId, label: s.label, kind: s.kind, agentCount: s.agentCount, writeRisk: false })),
			budget: { agentCalls: stageCount, pipelineCalls: 0, parallelCalls: 0, estimatedAgents: stageCount, writeRisk: false, warnLargeRun: false },
			tree: stages.map((s) => ({ label: s.label, kind: s.kind, agentCount: s.agentCount, writeRisk: false, stageId: s.stageId })),
		},
		stages,
		agents: stages.map((s) => agentTask(s.stageId, s.status === "running" ? "running" : "completed")),
		totalTokens: stageCount * 1_000,
		totalCost: 0.01 * stageCount,
		elapsedMs: elapsedSec * 1_000,
		warnings: [],
	};
	return assembleViewerData(detail, "await agent('count');", [{ runId: RUN_ID, scriptName: "count-flow", status: "running" }]);
}

const isTitleRow = (line: string): boolean => stripAnsi(line).includes("PWR viewer ·");
/** roster 行：分栏帧第一个 `│` 与第二个 `│` 之间的左栏带选中标记 `›`。 */
const isRosterRow = (line: string): boolean => {
	const parts = stripAnsi(line).split("│");
	return parts.length >= 3 && (parts[1] ?? "").includes("›");
};
const isTopBorderRow = (line: string): boolean => stripAnsi(line).includes("╭");
const isBottomBorderRow = (line: string): boolean => stripAnsi(line).includes("╰");

interface HostCounts {
	modelTitles: number;
	gridTitles: number;
	modelRosters: number;
	gridRosters: number;
	modelTopBorders: number;
	gridTopBorders: number;
	modelBottomBorders: number;
	gridBottomBorders: number;
}

/**
 * 跑满一个"用户真机 6 秒"：打开 viewer → 每秒主屏追加对话 + elapsed
 * 推进 → 第 3 跳新 stage 落地 → 中途改终端高度。全程走同步 renderNow
 * （确定性，不依赖 viewer 内部定时器），最后同时检查渲染器屏模型与
 * 仿真器像素屏。
 */
function driveHostViewer(opts: { cols?: number; rows?: number; resizeTo?: number } = {}): HostCounts {
	const screen = new FakeScreen(opts.cols ?? 160, opts.rows ?? 40);
	const term = {
		columns: screen.cols,
		rows: screen.rows,
		write: (data: string): void => {
			screen.feed(data);
		},
		hideCursor: (): void => {},
		showCursor: (): void => {},
	};
	const tui = new TuiMainScreen(term as never);
	const baseLines = ["$ pi /workflows:view", "leader turn 0 thinking…"];
	const base: Component = {
		render: () => [...baseLines],
		handleInput: () => {},
		invalidate: () => {},
	};
	tui.addChild(base);

	let elapsedSec = 53;
	let stageCount = 2;
	const viewer = new RunViewer({
		load: () => scenarioData(elapsedSec, stageCount),
		initialRunId: RUN_ID,
		done: () => {},
		styles: plainStyles(),
		rows: () => term.rows,
		refreshMs: 3_600_000, // 定时器不参与：帧由 renderNow 精确驱动
	});
	try {
		tui.showOverlay(viewer, VIEWER_OVERLAY_OPTIONS);
		tui.renderNow();
		for (let tick = 1; tick <= 6; tick++) {
			elapsedSec += 1;
			if (tick === 3) stageCount += 1; // 新 stage 落地
			baseLines.push(`leader turn ${tick} streaming…`, `stage ack ${tick}`);
			if (opts.resizeTo !== undefined && tick === 3) term.rows = opts.resizeTo;
			tui.renderNow();
		}
		// previousLines 在 .d.ts 里标 private（JS 侧是公开字段）：经结构类型只读。
		const model = (tui as unknown as { previousLines: string[] }).previousLines;
		const grid = screen.text();
		return {
			modelTitles: model.filter(isTitleRow).length,
			gridTitles: grid.filter(isTitleRow).length,
			modelRosters: model.filter(isRosterRow).length,
			gridRosters: grid.filter(isRosterRow).length,
			modelTopBorders: model.filter(isTopBorderRow).length,
			gridTopBorders: grid.filter(isTopBorderRow).length,
			modelBottomBorders: model.filter(isBottomBorderRow).length,
			gridBottomBorders: grid.filter(isBottomBorderRow).length,
		};
	} finally {
		viewer.dispose();
	}
}

test("真实宿主 6 秒运行：屏模型与像素屏都恒为一组标题+roster+边框", () => {
	const counts = driveHostViewer();
	assert.equal(counts.modelTitles, 1, `屏模型标题行应恰 1，实得 ${counts.modelTitles}`);
	assert.equal(counts.gridTitles, 1, `像素屏标题行应恰 1，实得 ${counts.gridTitles}`);
	assert.equal(counts.modelRosters, 1, `屏模型 roster 行应恰 1，实得 ${counts.modelRosters}`);
	assert.equal(counts.gridRosters, 1, `像素屏 roster 行应恰 1，实得 ${counts.gridRosters}`);
	assert.equal(counts.modelTopBorders, 1, `屏模型顶框应恰 1，实得 ${counts.modelTopBorders}`);
	assert.equal(counts.gridTopBorders, 1, `像素屏顶框应恰 1，实得 ${counts.gridTopBorders}`);
	assert.equal(counts.gridBottomBorders, 1, `像素屏底框应恰 1，实得 ${counts.gridBottomBorders}`);
});

test("真实宿主中途改终端高度：重绘后仍为一组标题+roster+边框", () => {
	const counts = driveHostViewer({ resizeTo: 36 });
	assert.equal(counts.modelTitles, 1);
	assert.equal(counts.gridTitles, 1);
	assert.equal(counts.gridRosters, 1, `改高度后像素屏 roster 应恰 1，实得 ${counts.gridRosters}`);
	assert.equal(counts.gridTopBorders, 1);
	assert.equal(counts.gridBottomBorders, 1);
});

test("真实宿主窄终端：<36 列单行提示，不产生分栏边框", () => {
	const counts = driveHostViewer({ cols: 30 });
	assert.equal(counts.gridTitles, 0, "窄终端无分栏标题");
	assert.equal(counts.gridRosters, 0, "窄终端无 roster 行");
	assert.equal(counts.gridTopBorders, 0, "窄终端无边框组");
});
