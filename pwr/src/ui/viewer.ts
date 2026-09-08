/**
 * PWR UI - full-screen live run viewer (/workflows:view, JHL-18)
 *
 * Modeled on the sibling agent-team extension's /team:view: a capturing
 * overlay drawn via ctx.ui.custom, hand-drawn rounded borders, one page per
 * view — the script structure diagram first, then one page per runtime
 * stage, then the final result and the raw script. Refreshes on an interval
 * by pulling the runtime's rich view() snapshot into the run store, so a
 * running workflow updates live and a finished (or post-restart rehydrated)
 * run stays viewable as a frozen snapshot.
 *
 * All rendering and key handling is pure and unit-tested without pi-tui;
 * styling and terminal dimensions are injected ports. RunViewer is the thin
 * host component and openRunViewer the thin host opener.
 */

import type { Component } from "@earendil-works/pi-tui";
import type { ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import type { AgentView, RunDetail, StageView } from "./types.ts";
import { RUN_STATUS_GLYPH, formatCost, formatDuration, formatStatus, formatTokens } from "./views.ts";
import { buildDiagramModel, renderDiagramRows, renderUnmatchedStages, STAGE_ICON } from "./diagram.ts";
import { padLine, truncateVisible, visibleWidth, wrapText } from "./text.ts";

// ---------------------------------------------------------------------------
// Style port (identity in tests; theme-backed in the host)
// ---------------------------------------------------------------------------

/** Style functions used by the frame chrome. */
export interface ViewerStyles {
	dim: (text: string) => string;
	border: (text: string) => string;
	accent: (text: string) => string;
	success: (text: string) => string;
	error: (text: string) => string;
	warning: (text: string) => string;
}

/** Unstyled port (tests). */
export function plainStyles(): ViewerStyles {
	const identity = (text: string): string => text;
	return { dim: identity, border: identity, accent: identity, success: identity, error: identity, warning: identity };
}

/** Theme-backed port (host). All lookups are exception-isolated. */
export function themeStyles(theme: Theme): ViewerStyles {
	const fg = (color: Parameters<Theme["fg"]>[0]) => (text: string): string => {
		try {
			return theme.fg(color, text);
		} catch {
			return text;
		}
	};
	return {
		dim: fg("dim"),
		border: fg("border"),
		accent: fg("accent"),
		success: fg("success"),
		error: fg("error"),
		warning: fg("warning"),
	};
}

// ---------------------------------------------------------------------------
// View model
// ---------------------------------------------------------------------------

export type ViewerPage =
	| { kind: "structure" }
	| { kind: "stage"; stageId: string }
	| { kind: "result" }
	| { kind: "script" };

/** One entry of the switchable run roster ([/] keys). */
export interface ViewerRunRef {
	runId: string;
	scriptName: string;
	status: string;
}

/** Everything the viewer needs to render one frame (reloaded on refresh). */
export interface ViewerData {
	runId: string;
	detail: RunDetail | null;
	scriptSource?: string;
	runs: ViewerRunRef[];
	pages: ViewerPage[];
	pageTitles: string[];
}

/** Interactive viewer state. */
export interface ViewerState {
	/** Index into data.runs (the run being viewed). */
	runIndex: number;
	pageIndex: number;
	/** Row offset into the rendered body (0 = top). */
	scroll: number;
	/** Stick to the bottom while new rows arrive. */
	follow: boolean;
}

export function initialViewerState(runIndex = 0): ViewerState {
	return { runIndex, pageIndex: 0, scroll: 0, follow: true };
}

/** Builds the page list from a detail snapshot (pure; unit-tested). */
export function assembleViewerData(
	detail: RunDetail | null,
	scriptSource: string | undefined,
	runs: ViewerRunRef[],
): ViewerData {
	const pages: ViewerPage[] = [{ kind: "structure" }];
	const pageTitles: string[] = ["结构"];
	if (detail) {
		for (const stage of detail.stages) {
			pages.push({ kind: "stage", stageId: stage.stageId });
			pageTitles.push(stage.label);
		}
	}
	pages.push({ kind: "result" }, { kind: "script" });
	pageTitles.push("结果", "脚本");
	return { runId: detail?.runId ?? "", detail, ...(scriptSource !== undefined ? { scriptSource } : {}), runs, pages, pageTitles };
}

const TASK_ICON: Record<AgentView["status"], string> = {
	queued: "··",
	running: "▶",
	completed: "✓",
	failed: "✗",
	cancelled: "■",
};

// ---------------------------------------------------------------------------
// Page bodies (plain text, width-fitted; whole-line styling only)
// ---------------------------------------------------------------------------

/** Page 0: run header + the script structure diagram with live overlay. */
export function structurePageLines(detail: RunDetail | null, width: number): string[] {
	if (!detail) return ["未找到该 run（可能已被清理或从未创建）。"];
	const lines: string[] = [];
	lines.push(`${formatStatus(detail.status)} ${detail.scriptName} · digest ${detail.digest.slice(0, 12)}`);
	const done = detail.agents.filter((a) => a.status === "completed").length;
	const planned = detail.budget?.estimatedAgents ?? detail.agents.length;
	lines.push(
		truncateVisible(
			`agents ${done}/${planned} · tokens ${formatTokens(detail.totalTokens)} · cost ${formatCost(detail.totalCost)} · elapsed ${formatDuration(detail.elapsedMs)}`,
			width,
		),
	);
	if (detail.warnings.length > 0) lines.push(truncateVisible(`[!] ${detail.warnings.join(" · ")}`, width));
	if (detail.errorMessage) lines.push(truncateVisible(`error: ${detail.errorCode ?? "-"}: ${detail.errorMessage}`, width));

	lines.push("");
	lines.push("脚本结构:");
	const model = buildDiagramModel(detail);
	const inner = Math.max(8, width - 2);
	for (const row of renderDiagramRows(model, inner)) lines.push(`  ${row}`);
	const unmatched = renderUnmatchedStages(model, inner);
	if (unmatched.length > 0) {
		lines.push("");
		for (const line of unmatched) lines.push(`  ${line}`);
	}
	if (!detail.plan) {
		lines.push("");
		lines.push("（该 run 来自历史会话记录，仅保留元数据——结构图为运行时 stage 平铺）");
	}
	return lines;
}

/** One stage page: stage header + task table + failures + latest summaries. */
export function stagePageLines(detail: RunDetail, stage: StageView, width: number): string[] {
	const lines: string[] = [];
	const agents = detail.agents.filter((a) => a.stageId === stage.stageId);
	const stageTokens =
		stage.tokens ??
		(() => {
			const sum = agents.reduce((acc, a) => acc + (a.tokens ?? 0), 0);
			return sum > 0 ? sum : undefined;
		})();
	const badge =
		stage.kind === "agent" ? "agent" : `${stage.kind} ×${stage.agentCount}${stage.dynamic ? "≈" : ""}`;
	lines.push(truncateVisible(`${stage.stageId} · ${stage.label} · ${badge}${stage.writeRisk ? " · ✎write" : ""}`, width));
	lines.push(
		truncateVisible(
			`status ${stage.status} · agents ${agents.filter((a) => a.status === "completed").length}/${agents.length} · tokens ${formatTokens(stageTokens)} · elapsed ${formatDuration(stage.elapsedMs)}`,
			width,
		),
	);
	lines.push("");
	if (agents.length === 0) {
		lines.push("（该 stage 暂无任务记录）");
		return lines;
	}
	for (const agent of agents) {
		const parts = [`${TASK_ICON[agent.status]} ${agent.taskId.slice(0, 8)} ${agent.label}`, `attempt ${agent.attempt}`];
		if (agent.cacheHit) parts.push("⚡cache");
		if (agent.tokens !== undefined) parts.push(`${formatTokens(agent.tokens)} tok`);
		if (agent.elapsedMs !== undefined) parts.push(formatDuration(agent.elapsedMs));
		lines.push(truncateVisible(parts.join(" · "), width));
	}

	const failures = agents.filter((a) => a.status === "failed" || (a.error !== undefined && a.status !== "completed"));
	if (failures.length > 0) {
		lines.push("");
		lines.push("失败详情:");
		for (const agent of failures) {
			const head = truncateVisible(`✗ ${agent.taskId.slice(0, 8)} ${agent.errorCode ?? "ERROR"}: ${agent.error ?? ""}`, width);
			lines.push(head);
		}
	}

	const summaries = agents.filter((a) => a.status === "completed" && a.resultSummary).slice(-5);
	if (summaries.length > 0) {
		lines.push("");
		lines.push("最近结果:");
		for (const agent of summaries) {
			for (const line of wrapText(`▸ ${agent.taskId.slice(0, 8)}: ${agent.resultSummary ?? ""}`, width)) {
				lines.push(truncateVisible(line, width));
			}
		}
	}
	return lines;
}

/** Result page: the final summary (or run error / pending note). */
export function resultPageLines(detail: RunDetail, width: number): string[] {
	const lines: string[] = [];
	if (detail.finalSummary) {
		lines.push(`最终结果 · ${formatStatus(detail.status)}`);
		lines.push("");
		for (const line of wrapText(detail.finalSummary, width)) lines.push(line);
		return lines;
	}
	if (detail.errorMessage) {
		lines.push(`运行失败 · ${detail.errorCode ?? "-"}`);
		lines.push("");
		for (const line of wrapText(detail.errorMessage, width)) lines.push(line);
		return lines;
	}
	lines.push("尚未产生最终结果（运行中或未完成）。");
	lines.push("");
	lines.push(`状态 ${formatStatus(detail.status)} · elapsed ${formatDuration(detail.elapsedMs)}`);
	return lines;
}

/** Script page: read-only source (only kept for runs created this session). */
export function scriptPageLines(source: string | undefined, width: number): string[] {
	if (source === undefined) {
		return ["本轮会话未保留该 run 的脚本源码（安全约束：脚本源码不落盘）。", "", "提示: 新会话中创建的 run 可在此页查看源码。"];
	}
	const lines = ["脚本源码（只读）:", ""];
	for (const line of wrapText(source, width)) lines.push(line);
	return lines;
}

/** Body lines for the current page (pure). */
export function viewerBodyLines(data: ViewerData, state: ViewerState, width: number): string[] {
	const page = data.pages[Math.min(state.pageIndex, data.pages.length - 1)] ?? { kind: "structure" as const };
	switch (page.kind) {
		case "structure":
			return structurePageLines(data.detail, width);
		case "stage": {
			if (!data.detail) return ["未找到该 run。"];
			const stage = data.detail.stages.find((s) => s.stageId === page.stageId);
			return stage ? stagePageLines(data.detail, stage, width) : ["该 stage 已不存在（run 状态已更新）。"];
		}
		case "result":
			return data.detail ? resultPageLines(data.detail, width) : ["未找到该 run。"];
		case "script":
			return scriptPageLines(data.scriptSource, width);
	}
}

// ---------------------------------------------------------------------------
// Bordered frame (~82% of the terminal, clear separation from the main UI)
// ---------------------------------------------------------------------------

/** Chrome rows of the frame: top border + page tabs + bottom border. */
export const VIEWER_CHROME_ROWS = 3;

/**
 * Frame height for a terminal with `rows` rows: ~82% of the screen,
 * at least 12 rows (very small terminals let the TUI clip).
 */
export function computeFrameHeight(rows: number): number {
	if (!Number.isFinite(rows) || rows <= 0) return 24;
	return Math.max(12, Math.min(Math.floor(rows * 0.82), rows - 2));
}

function topBorder(data: ViewerData, width: number, styles: ViewerStyles): string {
	const detail = data.detail;
	const status = detail ? formatStatus(detail.status) : "no run";
	const elapsed = detail?.elapsedMs !== undefined ? ` · ${formatDuration(detail.elapsedMs)}` : "";
	const title = `PWR · ${detail?.scriptName ?? "-"} · ${status}${elapsed} · run ${data.runId.slice(0, 8) || "-"}`;
	const room = Math.max(4, width - 5);
	const shown = truncateVisible(title, room);
	const pad = Math.max(1, width - visibleWidth(`╭─ ${shown} `) - 1);
	return styles.border(`╭─ `) + shown + styles.border(` ${"─".repeat(pad)}╮`);
}

function pageIcon(data: ViewerData, index: number): string {
	const page = data.pages[index];
	if (!page) return "·";
	switch (page.kind) {
		case "structure": {
			const status = data.detail?.status;
			return status ? RUN_STATUS_GLYPH[status] : "·";
		}
		case "stage": {
			const stage = data.detail?.stages.find((s) => s.stageId === page.stageId);
			return stage ? STAGE_ICON[stage.status] : "·";
		}
		case "result":
			return "≡";
		case "script":
			return "{}";
	}
}

function tabsRow(data: ViewerData, state: ViewerState, width: number, styles: ViewerStyles): string {
	const parts = data.pageTitles.map((title, index) => {
		const icon = pageIcon(data, index);
		const label = truncateVisible(title, 12);
		return index === state.pageIndex ? styles.accent(`▸${index + 1} ${label} ${icon}`) : styles.dim(`${index + 1} ${label} ${icon}`);
	});
	const tabs = parts.join(styles.dim("  "));
	const position = styles.dim(`页 ${Math.min(state.pageIndex + 1, data.pages.length)}/${data.pages.length}`);
	const gap = width - visibleWidth(tabs) - visibleWidth(position) - 2;
	return gap > 1 ? `${tabs}${" ".repeat(gap)}${position}` : tabs;
}

function bottomBorder(data: ViewerData, state: ViewerState, width: number, styles: ViewerStyles): string {
	const legend = "↑↓ 滚动 · ←→/1-9 页 · g/G 首末 · q 关闭";
	const multiRun = data.runs.length > 1;
	const position = multiRun
		? `页 ${Math.min(state.pageIndex + 1, data.pages.length)}/${data.pages.length} · run ${state.runIndex + 1}/${data.runs.length}`
		: `页 ${Math.min(state.pageIndex + 1, data.pages.length)}/${data.pages.length}`;
	const segmentWidth = (legendText: string): number => 3 + visibleWidth(legendText) + 3 + visibleWidth(position) + 1 + 1;
	let shownLegend = legend;
	if (multiRun) shownLegend = "↑↓ 滚动 · ←→ 页 · [/] run · g/G · q 关闭";
	if (segmentWidth(shownLegend) > width) {
		shownLegend = truncateVisible(shownLegend, Math.max(4, width - segmentWidth("") - 1));
	}
	const pad = Math.max(1, width - segmentWidth(shownLegend));
	return (
		styles.border(`╰─ `) +
		styles.dim(shownLegend) +
		styles.border(` ─ `) +
		styles.dim(position) +
		styles.border(` ${"─".repeat(pad)}╯`)
	);
}

/** Wraps a body/chrome line with the side borders, padding to full width. */
function sideWrap(line: string, width: number, styles: ViewerStyles): string {
	return styles.border("│ ") + padLine(line, width) + styles.border(" │");
}

/**
 * Renders the full bordered frame: title top border, page tabs, a
 * fixed-height body window, and the key-legend bottom border. Always returns
 * exactly `bodyHeight + VIEWER_CHROME_ROWS` lines.
 */
export function renderViewerFrame(
	data: ViewerData,
	state: ViewerState,
	width: number,
	opts: { styles: ViewerStyles; bodyHeight: number },
): string[] {
	const styles = opts.styles;
	// Side borders take "│ " + " │" = 4 columns.
	const inner = Math.max(10, width - 4);

	const lines = viewerBodyLines(data, state, inner);
	const clamped = clampViewerState(state, lines.length, opts.bodyHeight, data.pages.length);
	const body = lines.slice(clamped.scroll, clamped.scroll + opts.bodyHeight);
	while (body.length < opts.bodyHeight) body.push("");

	return [
		topBorder(data, width, styles),
		sideWrap(tabsRow(data, clamped, inner, styles), inner, styles),
		...body.map((line) => sideWrap(line, inner, styles)),
		bottomBorder(data, clamped, width, styles),
	];
}

// ---------------------------------------------------------------------------
// Key handling (pure)
// ---------------------------------------------------------------------------

export interface ViewerKeyContext {
	/** Total rendered body lines for the current page (last render). */
	totalLines: number;
	pageCount: number;
	runCount: number;
	bodyHeight: number;
}

export type ViewerKeyResult = { type: "update"; state: ViewerState } | { type: "close" };

const KEY_UP = "\x1b[A";
const KEY_DOWN = "\x1b[B";
const KEY_LEFT = "\x1b[D";
const KEY_RIGHT = "\x1b[C";
const KEY_PGUP = "\x1b[5~";
const KEY_PGDN = "\x1b[6~";
const KEY_HOME = "\x1b[H";
const KEY_END = "\x1b[F";

/**
 * Pure key reducer. Unrecognized keys leave the state unchanged (still an
 * update) so the component ignores them; `q`/Esc request close.
 */
export function handleViewerKey(state: ViewerState, data: string, ctx: ViewerKeyContext): ViewerKeyResult {
	const bottom = Math.max(0, ctx.totalLines - ctx.bodyHeight);
	const next: ViewerState = { ...state };
	const switchPage = (index: number): void => {
		next.pageIndex = Math.min(Math.max(0, index), Math.max(0, ctx.pageCount - 1));
		next.scroll = 0;
		next.follow = true;
	};
	const switchRun = (index: number): void => {
		next.runIndex = Math.min(Math.max(0, index), Math.max(0, ctx.runCount - 1));
		next.pageIndex = 0;
		next.scroll = 0;
		next.follow = true;
	};

	switch (data) {
		case "q":
		case "\x1b":
			return { type: "close" };
		case KEY_UP:
		case "k":
			next.follow = false;
			next.scroll = Math.max(0, (state.follow ? bottom : state.scroll) - 1);
			break;
		case KEY_DOWN:
		case "j": {
			const base = state.follow ? bottom : state.scroll;
			next.scroll = base + 1;
			if (next.scroll >= bottom) next.follow = true;
			break;
		}
		case KEY_PGUP:
			next.follow = false;
			next.scroll = Math.max(0, (state.follow ? bottom : state.scroll) - ctx.bodyHeight);
			break;
		case KEY_PGDN: {
			const base = state.follow ? bottom : state.scroll;
			next.scroll = base + ctx.bodyHeight;
			if (next.scroll >= bottom) next.follow = true;
			break;
		}
		case "g":
		case KEY_HOME:
			next.follow = false;
			next.scroll = 0;
			break;
		case "G":
		case KEY_END:
			next.follow = true;
			break;
		case KEY_LEFT:
		case "h":
			switchPage(state.pageIndex - 1);
			break;
		case KEY_RIGHT:
		case "l":
		case "\t":
			switchPage(state.pageIndex + 1);
			break;
		case "[":
			switchRun(state.runIndex - 1);
			break;
		case "]":
			switchRun(state.runIndex + 1);
			break;
		default: {
			if (/^[1-9]$/.test(data)) {
				const index = Number(data) - 1;
				if (index < ctx.pageCount) switchPage(index);
			}
			break;
		}
	}
	return { type: "update", state: next };
}

/** Clamps scroll/follow/page against the current body and page counts. */
export function clampViewerState(state: ViewerState, totalLines: number, bodyHeight: number, pageCount: number): ViewerState {
	const maxScroll = Math.max(0, totalLines - bodyHeight);
	const page = Math.min(Math.max(0, state.pageIndex), Math.max(0, pageCount - 1));
	if (state.follow) return { ...state, pageIndex: page, scroll: maxScroll };
	return { ...state, pageIndex: page, scroll: Math.min(Math.max(0, state.scroll), maxScroll) };
}

// ---------------------------------------------------------------------------
// Host component + opener (thin; not unit-tested — repo convention)
// ---------------------------------------------------------------------------

export interface RunViewerOptions {
	/** Reloads viewer data for a run id on each refresh tick. */
	load: (runId: string) => ViewerData;
	initialRunId: string;
	/** Closes the overlay (ctx.ui.custom's done callback). */
	done: () => void;
	styles: ViewerStyles;
	/** Requests a repaint (host passes tui.requestRender). */
	requestRender?: () => void;
	/** Terminal rows provider (defaults to 30). Host passes tui.terminal.rows. */
	rows?: () => number;
	refreshMs?: number;
}

/** pi-tui component wrapper: refresh timer + key handling + rendering. */
export class RunViewer implements Component {
	private readonly opts: RunViewerOptions;
	private data: ViewerData;
	private state: ViewerState = initialViewerState();
	private lastTotalLines = 0;
	private lastBodyHeight = 22;
	private timer: ReturnType<typeof setInterval> | null = null;

	constructor(opts: RunViewerOptions) {
		this.opts = opts;
		this.data = opts.load(opts.initialRunId);
		const runIndex = this.data.runs.findIndex((r) => r.runId === opts.initialRunId);
		this.state = initialViewerState(runIndex >= 0 ? runIndex : 0);
		const refreshMs = opts.refreshMs ?? 800;
		this.timer = setInterval(() => {
			try {
				this.reload();
				this.requestRender();
			} catch {
				/* refresh failures never break the viewer */
			}
		}, refreshMs);
		if (typeof this.timer.unref === "function") this.timer.unref();
	}

	private currentRunId(): string {
		if (this.data.runs.length === 0) return this.opts.initialRunId;
		const index = Math.min(Math.max(0, this.state.runIndex), this.data.runs.length - 1);
		return this.data.runs[index].runId;
	}

	private reload(): void {
		try {
			this.data = this.opts.load(this.currentRunId());
		} catch {
			/* keep the last snapshot on load failures */
		}
	}

	private requestRender(): void {
		if (!this.opts.requestRender) return;
		try {
			this.opts.requestRender();
		} catch {
			/* rendering is best-effort */
		}
	}

	render(width: number): string[] {
		const rows = this.opts.rows?.() ?? 30;
		const bodyHeight = computeFrameHeight(rows) - VIEWER_CHROME_ROWS;
		this.lastBodyHeight = bodyHeight;
		this.reload();
		this.lastTotalLines = viewerBodyLines(this.data, this.state, Math.max(10, width - 4)).length;
		this.state = clampViewerState(this.state, this.lastTotalLines, bodyHeight, this.data.pages.length);
		return renderViewerFrame(this.data, this.state, width, {
			styles: this.opts.styles,
			bodyHeight,
		});
	}

	handleInput(data: string): void {
		const result = handleViewerKey(this.state, data, {
			totalLines: this.lastTotalLines,
			pageCount: this.data.pages.length,
			runCount: this.data.runs.length,
			bodyHeight: this.lastBodyHeight,
		});
		if (result.type === "close") {
			this.dispose();
			this.opts.done();
			return;
		}
		this.state = result.state;
		if (data === "[" || data === "]") this.reload();
		this.requestRender();
	}

	invalidate(): void {
		/* stateless rendering — nothing cached */
	}

	/** Stops the refresh timer (called on close and by the host on teardown). */
	dispose(): void {
		if (this.timer !== null) {
			clearInterval(this.timer);
			this.timer = null;
		}
	}
}

/**
 * Opens the run viewer as a centered capturing overlay (~96% wide, ~82% of
 * the terminal height with a full border). Resolves when the user closes it
 * (q/Esc). Host failures are the caller's to guard (ui/index.ts checks
 * hasUI/mode/custom and exception-isolates).
 */
export async function openRunViewer(
	ui: Pick<ExtensionUIContext, "custom">,
	opts: { load: (runId: string) => ViewerData; initialRunId: string; refreshMs?: number },
): Promise<void> {
	await ui.custom<void>(
		(tui, theme, _keybindings, done) =>
			new RunViewer({
				load: opts.load,
				initialRunId: opts.initialRunId,
				done,
				styles: themeStyles(theme),
				requestRender: () => {
					try {
						tui.requestRender();
					} catch {
						/* rendering is best-effort */
					}
				},
				rows: () => {
					try {
						return tui.terminal.rows;
					} catch {
						return 30;
					}
				},
				...(opts.refreshMs !== undefined ? { refreshMs: opts.refreshMs } : {}),
			}),
		{
			overlay: true,
			overlayOptions: { anchor: "center", width: "96%" },
		},
	);
}
