/**
 * PWR UI - full-screen live run viewer (/workflow:view, JHL-18)
 *
 * Split-pane frame copied structurally from the sibling agent-team
 * extension's /team:view (itself pi-subagents' fleet inspector layout,
 * v0.66.0 `fleet.ts:1319-1381`): a left roster (structure / stages /
 * result / script — selection marker + status glyph + right-aligned
 * status, windowed scrolling) and a right detail pane (fixed
 * Run/State/条目 meta header, then the selected item body ending in a
 * scrollable window). A key-legend row sits above the plain bottom
 * border. Refreshes pull the runtime's rich view() snapshot so a running
 * workflow updates live and a finished (or rehydrated) run stays viewable.
 *
 * TUI-sync alignment (pwr/docs/tui-sync.md): A2 — host text utilities
 * (truncateToWidth / wrapTextWithAnsi / visibleWidth) replace the deleted
 * self-written text.ts; A3 — 750ms refresh; A4 — overlay geometry
 * (`VIEWER_OVERLAY_OPTIONS`) and the frame-height formula are fleet's.
 *
 * All rendering and key handling is pure and unit-tested without pi-tui;
 * styling and terminal dimensions are injected ports. RunViewer is the
 * thin host component and openRunViewer the thin host opener.
 */

import { matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component, type OverlayOptions } from "@earendil-works/pi-tui";
import type { ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import type { AgentView, RunDetail, StageView } from "./types.ts";
import { VIEWER_HEIGHT_JITTER_ROWS, VIEWER_TICK_MS } from "./types.ts";
import { RUN_STATUS_GLYPH, formatCost, formatDuration, formatStatus, formatTokens } from "./views.ts";
import { buildDiagramModel, renderDiagramRows, renderUnmatchedStages, STAGE_ICON } from "./diagram.ts";

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
	bold: (text: string) => string;
}

/** Unstyled port (tests). */
export function plainStyles(): ViewerStyles {
	const identity = (text: string): string => text;
	return {
		dim: identity,
		border: identity,
		accent: identity,
		success: identity,
		error: identity,
		warning: identity,
		bold: identity,
	};
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
		bold: (text: string): string => {
			try {
				return theme.bold(text);
			} catch {
				return text;
			}
		},
	};
}

// ---------------------------------------------------------------------------
// View model
// ---------------------------------------------------------------------------

export type ViewerItemKind = "structure" | "stage" | "result" | "script";

/** One selectable entry of the left roster. */
export interface ViewerItem {
	/** Stable id pinned across refreshes: `structure` / stageId / `result` / `script`. */
	id: string;
	kind: ViewerItemKind;
	label: string;
	status?: string;
	stageId?: string;
}

/** One entry of the switchable run roster ([/] keys). */
export interface ViewerRunRef {
	runId: string;
	scriptName: string;
	status: string;
}

/** Everything the viewer needs to render one frame (reloaded on refresh). */
export interface ViewerData {
	runId: string;
	scriptName?: string;
	detail: RunDetail | null;
	scriptSource?: string;
	runs: ViewerRunRef[];
	items: ViewerItem[];
}

export type NoticeKind = "success" | "warning" | "error";

/** Interactive viewer state. */
export interface ViewerState {
	/** Index into data.runs (the run being viewed). */
	runIndex: number;
	itemIndex: number;
	/**
	 * Selected item id (structure / stageId / result / script). Kept
	 * alongside the index so the selection survives stage-list changes
	 * (the index is re-resolved from this id on every refresh).
	 */
	itemId?: string;
	/** Row offset into the rendered detail body (0 = top). */
	scroll: number;
	/** Stick to the bottom while new rows arrive. */
	follow: boolean;
	/** Include the live `└` trace rows under running agents. */
	showTrace: boolean;
	/** Two-step stop confirmation armed (D on a stoppable run). */
	stopConfirming: boolean;
	/** A stop request is in flight (busy banner; repeated confirms ignored). */
	stopping?: boolean;
	/** Top banner notice (stop result / unavailable hint). */
	notice?: { text: string; kind: NoticeKind };
}

export function initialViewerState(): ViewerState {
	return { runIndex: 0, itemIndex: 0, scroll: 0, follow: true, showTrace: true, stopConfirming: false };
}

/** Builds the roster from a detail snapshot (pure; unit-tested). */
export function assembleViewerData(
	detail: RunDetail | null,
	scriptSource: string | undefined,
	runs: ViewerRunRef[],
): ViewerData {
	const items: ViewerItem[] = [
		{ id: "structure", kind: "structure", label: "结构", ...(detail ? { status: detail.status } : {}) },
	];
	if (detail) {
		for (const stage of detail.stages) {
			items.push({ id: stage.stageId, kind: "stage", label: stage.label, status: stage.status, stageId: stage.stageId });
		}
	}
	items.push({ id: "result", kind: "result", label: "结果", ...(detail ? { status: detail.status } : {}) });
	items.push({ id: "script", kind: "script", label: "脚本", status: "只读" });
	return {
		runId: detail?.runId ?? "",
		...(detail?.scriptName !== undefined ? { scriptName: detail.scriptName } : {}),
		detail,
		...(scriptSource !== undefined ? { scriptSource } : {}),
		runs,
		items,
	};
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

/** Structure item: run header + the script structure diagram with live overlay. */
export function structurePageLines(detail: RunDetail | null, width: number): string[] {
	if (!detail) return ["未找到该 run（可能已被清理或从未创建）。"];
	const lines: string[] = [];
	lines.push(truncateToWidth(`${formatStatus(detail.status)} ${detail.scriptName} · digest ${detail.digest.slice(0, 12)}`, width, "…"));
	const done = detail.agents.filter((a) => a.status === "completed").length;
	const planned = detail.budget?.estimatedAgents ?? detail.agents.length;
	lines.push(
		truncateToWidth(
			`agents ${done}/${planned} · tokens ${formatTokens(detail.totalTokens)} · cost ${formatCost(detail.totalCost)} · elapsed ${formatDuration(detail.elapsedMs)}`,
			width,
			"…",
		),
	);
	if (detail.warnings.length > 0) lines.push(truncateToWidth(`[!] ${detail.warnings.join(" · ")}`, width, "…"));
	if (detail.errorMessage) lines.push(truncateToWidth(`error: ${detail.errorCode ?? "-"}: ${detail.errorMessage}`, width, "…"));

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

/** One stage item: stage header + task table + failures + latest summaries. */
export function stagePageLines(detail: RunDetail, stage: StageView, width: number, showTrace = true): string[] {
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
	lines.push(truncateToWidth(`${stage.stageId} · ${stage.label} · ${badge}${stage.writeRisk ? " · ✎write" : ""}`, width, "…"));
	lines.push(
		truncateToWidth(
			`status ${stage.status} · agents ${agents.filter((a) => a.status === "completed").length}/${agents.length} · tokens ${formatTokens(stageTokens)} · elapsed ${formatDuration(stage.elapsedMs)}`,
			width,
			"…",
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
		lines.push(truncateToWidth(parts.join(" · "), width, "…"));
		// Live per-step trace: the latest sanitized child activity (tool
		// steps / assistant text tails) under each running agent row.
		if (showTrace && agent.status === "running" && agent.recentEvents.length > 0) {
			for (const ev of agent.recentEvents.slice(-2)) {
				lines.push(truncateToWidth(`  └ ${ev}`, width, "…"));
			}
		}
	}

	const failures = agents.filter((a) => a.status === "failed" || (a.error !== undefined && a.status !== "completed"));
	if (failures.length > 0) {
		lines.push("");
		lines.push("失败详情:");
		for (const agent of failures) {
			const head = truncateToWidth(`✗ ${agent.taskId.slice(0, 8)} ${agent.errorCode ?? "ERROR"}: ${agent.error ?? ""}`, width, "…");
			lines.push(head);
		}
	}

	const summaries = agents.filter((a) => a.status === "completed" && a.resultSummary).slice(-5);
	if (summaries.length > 0) {
		lines.push("");
		lines.push("最近结果:");
		for (const agent of summaries) {
			for (const line of wrapTextWithAnsi(`▸ ${agent.taskId.slice(0, 8)}: ${agent.resultSummary ?? ""}`, width)) {
				lines.push(truncateToWidth(line, width, "…"));
			}
		}
	}
	return lines;
}

/** Result item: the final summary (or run error / pending note). */
export function resultPageLines(detail: RunDetail, width: number): string[] {
	const lines: string[] = [];
	if (detail.finalSummary) {
		lines.push(`最终结果 · ${formatStatus(detail.status)}`);
		lines.push("");
		for (const line of wrapTextWithAnsi(detail.finalSummary, width)) lines.push(line);
		return lines;
	}
	if (detail.errorMessage) {
		lines.push(`运行失败 · ${detail.errorCode ?? "-"}`);
		lines.push("");
		for (const line of wrapTextWithAnsi(detail.errorMessage, width)) lines.push(line);
		return lines;
	}
	lines.push("尚未产生最终结果（运行中或未完成）。");
	lines.push("");
	lines.push(`状态 ${formatStatus(detail.status)} · elapsed ${formatDuration(detail.elapsedMs)}`);
	return lines;
}

/** Script item: read-only source (only kept for runs created this session). */
export function scriptPageLines(source: string | undefined, width: number): string[] {
	if (source === undefined) {
		return ["本轮会话未保留该 run 的脚本源码（安全约束：脚本源码不落盘）。", "", "提示: 新会话中创建的 run 可在此条目查看源码。"];
	}
	const lines = ["脚本源码（只读）:", ""];
	for (const line of wrapTextWithAnsi(source, width)) lines.push(line);
	return lines;
}

/** Detail body lines for the selected item (pure). */
export function viewerBodyLines(data: ViewerData, state: ViewerState, width: number): string[] {
	// 钉住的条目已从 roster 消失（刷新间隔内 stage 被清理）→ 明确告知，而非静默跳到邻项。
	if (state.itemId !== undefined && !data.items.some((item) => item.id === state.itemId)) {
		return ["该 stage 已不存在（run 状态已更新）。"];
	}
	const item = data.items[resolveItemIndex(data, state)];
	if (!item) return structurePageLines(data.detail, width);
	switch (item.kind) {
		case "structure":
			return structurePageLines(data.detail, width);
		case "stage": {
			if (!data.detail) return ["未找到该 run。"];
			const stage = data.detail.stages.find((s) => s.stageId === item.stageId);
			return stage ? stagePageLines(data.detail, stage, width, state.showTrace) : ["该 stage 已不存在（run 状态已更新）。"];
		}
		case "result":
			return data.detail ? resultPageLines(data.detail, width) : ["未找到该 run。"];
		case "script":
			return scriptPageLines(data.scriptSource, width);
	}
}

// ---------------------------------------------------------------------------
// Split frame (fleet inspector layout: roster left, detail right)
// ---------------------------------------------------------------------------

/**
 * Chrome rows of the frame: top border + title row + upper separator +
 * lower separator + legend row + bottom border (fleet.ts:1343-1370).
 * "Frame total = bodyHeight + VIEWER_CHROME_ROWS" stays invariant.
 */
export const VIEWER_CHROME_ROWS = 6;

/**
 * 动作键位对齐 pi-subagents `DEFAULT_FLEET_KEYBINDINGS`（v0.66.0
 * `fleet.ts:33-48`）；pwr 特有 `[/]` 换 run 不在表内（agent-team 同样保留
 * 特有病 `m`）。大写滚动/停止键经 `matchesViewerBinding` 的大写→
 * `shift+小写` 转换用 matchesKey 判定（fleet.ts:59-61 同构）。
 */
export const VIEWER_ACTION_KEYS = {
	close: ["escape", "ctrl+c", "q"],
	scrollUp: ["K"],
	scrollDown: ["J"],
	selectUp: ["up", "k"],
	selectDown: ["down", "j"],
	selectFirst: ["home"],
	selectLast: ["end"],
	pageUp: ["pageUp"],
	pageDown: ["pageDown"],
	refresh: ["r", "R"],
	stop: ["D"],
	toggleTrace: ["x", "X", "ctrl+o"],
} as const;

/** Key legend for the bottom border (kept in sync with the key handler). */
export const VIEWER_LEGEND = "↑↓ 条目 · J/K 滚动 · PgUp/PgDn 翻页 · x trace · D 停止 · r 刷新 · [/] run · q 关闭";

/** fleet 的 `matchesFleetBinding`（fleet.ts:59-61）：大写绑定 → shift+小写。 */
function matchesViewerBinding(data: string, binding: string): boolean {
	const key = /^[A-Z]$/.test(binding) ? `shift+${binding.toLowerCase()}` : binding;
	return matchesKey(data, key as Parameters<typeof matchesKey>[1]);
}

function matchesViewerAction(data: string, action: keyof typeof VIEWER_ACTION_KEYS): boolean {
	return VIEWER_ACTION_KEYS[action].some((binding) => matchesViewerBinding(data, binding));
}

/**
 * Frame body height for a terminal with `rows` rows: fleet's formula
 * `max(2, floor(rows * 0.85) - 6)` (fleet.ts:1326-1327). Invalid rows
 * fall back to fleet's default terminal height of 32.
 */
export function computeFrameHeight(rows: number): number {
	const safe = Number.isFinite(rows) && rows > 0 ? rows : 32;
	return Math.max(2, Math.floor(safe * 0.85) - 6);
}

/**
 * Split-pane geometry, verbatim from fleet.ts:1322-1329: the two `│`
 * borders take 2 columns total, the roster takes 22..46 columns (38% of
 * the rest), the detail pane gets whatever remains (≥ 1).
 */
export function computeViewerLayout(width: number): { innerWidth: number; rosterWidth: number; detailWidth: number } {
	const innerWidth = Math.max(0, width - 2);
	const rosterWidth = Math.max(22, Math.min(46, Math.floor((innerWidth - 1) * 0.38)));
	const detailWidth = Math.max(1, innerWidth - rosterWidth - 1);
	return { innerWidth, rosterWidth, detailWidth };
}

/**
 * ANSI/CJK-aware clamp to an exact display width (host `truncateToWidth`
 * with `pad`), so nothing bleeds past the border and the diff renderer
 * sees stable line widths.
 */
export function fitLine(line: string, width: number): string {
	return truncateToWidth(line, width, "…", true);
}

/** fleet's `rightAligned` (fleet.ts:754): left + gap + right, exact width. */
function rightAligned(left: string, right: string, width: number): string {
	const rightWidth = visibleWidth(right);
	const leftWidth = Math.max(0, width - rightWidth - 1);
	return fitLine(left, leftWidth) + " ".repeat(Math.max(1, width - leftWidth - rightWidth)) + fitLine(right, rightWidth);
}

type StatusStyleName = "dim" | "accent" | "success" | "error" | "warning";

function statusStyleName(status: string | undefined): StatusStyleName {
	switch (status) {
		case "running":
			return "accent";
		case "completed":
			return "success";
		case "failed":
			return "error";
		case "paused":
		case "cancelled":
		case "awaiting_approval":
			return "warning";
		default:
			return "dim";
	}
}

function applyStyle(styles: ViewerStyles, name: StatusStyleName, text: string): string {
	return styles[name](text);
}

/** Status glyph shown for one roster item (run glyph / stage glyph / ≡ / {}). */
export function itemIcon(item: ViewerItem, data: ViewerData): string {
	switch (item.kind) {
		case "structure":
			return data.detail ? RUN_STATUS_GLYPH[data.detail.status] : "·";
		case "stage": {
			const stage = data.detail?.stages.find((s) => s.stageId === item.stageId);
			return stage ? STAGE_ICON[stage.status] : "·";
		}
		case "result":
			return "≡";
		case "script":
			return "{}";
	}
}

function selectedItem(data: ViewerData, state: ViewerState): { item: ViewerItem; index: number } | undefined {
	const index = Math.min(Math.max(0, state.itemIndex), Math.max(0, data.items.length - 1));
	const item = data.items[index];
	return item ? { item, index } : undefined;
}

/**
 * Left-pane item roster: `<marker> <status icon> <label>` with the status
 * text right-aligned and selected marker `›` (accent) + bold label. The
 * window follows the selection so it never scrolls out of view (fleet's
 * start-clamp formula, fleet.ts:1219).
 */
function rosterLines(data: ViewerData, state: ViewerState, width: number, bodyHeight: number, styles: ViewerStyles): string[] {
	if (data.items.length === 0) return [styles.dim("（无条目）")];
	const selected = Math.min(Math.max(0, state.itemIndex), data.items.length - 1);
	const start = Math.max(0, Math.min(selected - bodyHeight + 1, Math.max(0, data.items.length - bodyHeight)));
	const rows: string[] = [];
	for (let index = start; index < Math.min(data.items.length, start + bodyHeight); index++) {
		const item = data.items[index];
		if (!item) continue;
		const isSelected = index === selected;
		const marker = isSelected ? styles.accent("›") : " ";
		const label = isSelected ? styles.bold(item.label) : item.label;
		const left = `${marker} ${applyStyle(styles, statusStyleName(item.status), itemIcon(item, data))} ${label}`;
		rows.push(rightAligned(left, styles.dim(item.status ?? ""), width));
	}
	return rows;
}

/**
 * Fixed detail-pane meta header (three lines): Run / State / 条目. Key
 * names bold like fleet's `^(Run|State|…):` rule; the header never
 * scrolls with the body.
 */
function detailHeaderLines(data: ViewerData, state: ViewerState, styles: ViewerStyles): string[] {
	const selected = selectedItem(data, state);
	const position = selected
		? `${selected.item.label}${selected.item.status ? `（${selected.item.status}）` : ""} · ${selected.index + 1}/${data.items.length}`
		: "（无条目）";
	return [
		`${styles.bold("Run:")} ${data.runId || "(no run)"}`,
		`${styles.bold("State:")} ${data.detail?.status ?? "unknown"}`,
		`${styles.bold("条目:")} ${position}`,
	];
}

/**
 * Static title row (no per-second text in the chrome — the elapsed clock
 * stacking incident; elapsed lives in the body). Right side shows the
 * selected item's icon + label + status.
 */
function titleRow(data: ViewerData, state: ViewerState, innerWidth: number, styles: ViewerStyles): string {
	const title = ` PWR viewer · ${data.scriptName ?? "-"} · run ${data.runId.slice(0, 8) || "(no run)"}`;
	const selected = selectedItem(data, state);
	const right = selected
		? `${applyStyle(styles, statusStyleName(selected.item.status), itemIcon(selected.item, data))} ${selected.item.label} · ${selected.item.status ?? "-"} `
		: `${styles.dim("无条目")} `;
	return styles.border("│") + rightAligned(title, right, innerWidth) + styles.border("│");
}

function legendRow(data: ViewerData, state: ViewerState, styles: ViewerStyles): string {
	const position = data.items.length > 0 ? `条目 ${Math.min(state.itemIndex + 1, data.items.length)}/${data.items.length}` : "";
	return styles.dim(position ? `${VIEWER_LEGEND} · ${position}` : VIEWER_LEGEND);
}

/**
 * Action banner/notice lines for the top of the body window (priority
 * busy > confirm > notice). Pure: derived entirely from the viewer state,
 * mutually exclusive display.
 */
export function actionLines(data: ViewerData, state: ViewerState, styles: ViewerStyles): string[] {
	if (state.stopping) return [styles.accent("停止中…")];
	if (state.stopConfirming) {
		return [
			styles.warning(`确认停止 run ${data.runId.slice(0, 8) || "(no run)"}？`),
			styles.dim("停止会中止运行中的 agent 子进程。Enter/Y 确认 · N 取消 · Esc 取消"),
		];
	}
	if (state.notice) {
		const style = state.notice.kind === "error" ? styles.error : state.notice.kind === "warning" ? styles.warning : styles.success;
		return [style(state.notice.text)];
	}
	return [];
}

/** Action lines wrapped to the detail width (fleet wraps detail lines too). */
function wrappedActions(data: ViewerData, state: ViewerState, detailWidth: number, styles: ViewerStyles): string[] {
	return actionLines(data, state, styles).flatMap((line) => wrapTextWithAnsi(line, Math.max(1, detailWidth)));
}

/**
 * Detail-pane body viewport height: bodyHeight minus the fixed header rows
 * and any action lines (≥ 1). Action lines wrap to the detail width, so
 * their row count depends on it. The component clamps scroll and feeds key
 * handling with this so paging matches what is visible.
 */
export function viewerViewportHeight(data: ViewerData, state: ViewerState, width: number, bodyHeight: number, styles: ViewerStyles): number {
	const header = detailHeaderLines(data, state, styles).slice(0, Math.max(0, bodyHeight - 1));
	const actions = wrappedActions(data, state, computeViewerLayout(width).detailWidth, styles);
	return Math.max(1, bodyHeight - header.length - actions.length);
}

/**
 * Renders the fleet-style split frame: plain top border, static title row,
 * `│roster│detail│` body rows, and the key legend above the plain bottom
 * border. The detail pane = fixed meta header + action lines (stop
 * banner/notice) + the scrollable body window — the frame always returns
 * exactly `bodyHeight + VIEWER_CHROME_ROWS` lines. Terminals narrower than
 * 36 columns get a single hint line (fleet's minimum-width gate,
 * fleet.ts:1321).
 */
export function renderViewerFrame(
	data: ViewerData,
	state: ViewerState,
	width: number,
	opts: { styles: ViewerStyles; bodyHeight: number },
): string[] {
	if (width < 36) return [truncateToWidth("PWR viewer 至少需要 36 列。Esc 关闭。", width, "…")];
	const styles = opts.styles;
	const { innerWidth, rosterWidth, detailWidth } = computeViewerLayout(width);
	const bodyHeight = opts.bodyHeight;

	const roster = rosterLines(data, state, rosterWidth, bodyHeight, styles);
	const body = viewerBodyLines(data, state, detailWidth);
	const header = detailHeaderLines(data, state, styles).slice(0, Math.max(0, bodyHeight - 1));
	const actions = wrappedActions(data, state, detailWidth, styles);
	const effective = Math.max(1, bodyHeight - header.length - actions.length);
	const clamped = clampViewerState(state, body.length, effective);
	const window = body.slice(clamped.scroll, clamped.scroll + effective);
	while (window.length < effective) window.push("");
	const detail = [...header, ...actions, ...window];

	const lines = [
		styles.border(`╭${"─".repeat(innerWidth)}╮`),
		titleRow(data, clamped, innerWidth, styles),
		styles.border(`├${"─".repeat(rosterWidth)}┬${"─".repeat(detailWidth)}┤`),
	];
	for (let index = 0; index < bodyHeight; index++) {
		lines.push(
			styles.border("│") +
				fitLine(roster[index] ?? "", rosterWidth) +
				styles.border("│") +
				fitLine(detail[index] ?? "", detailWidth) +
				styles.border("│"),
		);
	}
	lines.push(styles.border(`├${"─".repeat(rosterWidth)}┴${"─".repeat(detailWidth)}┤`));
	lines.push(styles.border("│") + fitLine(legendRow(data, clamped, styles), innerWidth) + styles.border("│"));
	lines.push(styles.border(`╰${"─".repeat(innerWidth)}╯`));
	return lines.map((line) => fitLine(line, width));
}

// ---------------------------------------------------------------------------
// Key handling (pure)
// ---------------------------------------------------------------------------

export interface ViewerKeyContext {
	/** Total rendered body lines for the current item (last render). */
	totalLines: number;
	itemCount: number;
	/** Item ids in roster order (pins selection by id when present). */
	itemIds?: string[];
	bodyHeight: number;
	runCount: number;
	/** True while the current run can be stopped (queued/running/paused). */
	runRunning?: boolean;
	/** Latest known run status (used for the D-on-finished notice copy). */
	runStatus?: string;
}

export type ViewerKeyResult = { type: "update"; state: ViewerState } | { type: "close" } | { type: "refresh" } | { type: "stop-confirm" };

/**
 * Pure key reducer. Unrecognized keys leave the state unchanged (still an
 * update) so the component ignores them; close 键集请求 close。
 *
 * 键位对齐 fleet `DEFAULT_FLEET_KEYBINDINGS`（v0.66.0 `fleet.ts:33-48`）：
 * `↑↓/k/j` 切换条目（切换重置滚动/follow、钉 itemId，首末钳位）、
 * `Shift+K/J` 右栏正文逐行滚动（上滚 unfollow、到底 re-follow）、
 * `Home/End` 首末条目、`PgUp/PgDn` 翻页、`x/X/ctrl+o` trace 行开关、
 * `D` 停止、`r/R` 刷新、`[/]` 换 run（pwr 特有）；旧键
 * `←→/h/l/Tab/1-9/g/G` 退役（按下忽略不改状态）。
 *
 * 确认态按键集对齐 fleet.ts:1134-1150：Enter/Y 确认、
 * Esc/ctrl+c/N/backspace 取消（取消不关闭查看器）、其余键忽略。
 */
export function handleViewerKey(state: ViewerState, data: string, ctx: ViewerKeyContext): ViewerKeyResult {
	if (state.stopConfirming) {
		if (matchesKey(data, "enter") || data === "y" || data === "Y") {
			return { type: "stop-confirm" };
		}
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || data === "n" || data === "N" || matchesKey(data, "backspace")) {
			return { type: "update", state: { ...state, stopConfirming: false } };
		}
		return { type: "update", state }; // 确认态下其余键一律忽略
	}

	const bottom = Math.max(0, ctx.totalLines - ctx.bodyHeight);
	const next: ViewerState = { ...state };
	const switchItem = (index: number): void => {
		next.itemIndex = Math.min(Math.max(0, index), Math.max(0, ctx.itemCount - 1));
		if (ctx.itemIds !== undefined) {
			const id = ctx.itemIds[next.itemIndex];
			if (id !== undefined) next.itemId = id;
			else delete next.itemId;
		}
		next.scroll = 0;
		next.follow = true;
	};
	// fleet 的 `scrollDetail`（fleet.ts:1013-1018）：clamp 到 [0, maxScroll]，
	// 到底/在底再滚 = re-follow。
	const scrollDetail = (delta: number): void => {
		const base = state.follow ? bottom : state.scroll;
		next.scroll = Math.max(0, Math.min(bottom, base + delta));
		next.follow = next.scroll >= bottom;
	};

	if (matchesViewerAction(data, "close")) {
		return { type: "close" };
	}

	if (matchesViewerAction(data, "scrollUp")) scrollDetail(-1);
	else if (matchesViewerAction(data, "scrollDown")) scrollDetail(1);
	else if (matchesViewerAction(data, "selectUp")) switchItem(state.itemIndex - 1);
	else if (matchesViewerAction(data, "selectDown")) switchItem(state.itemIndex + 1);
	else if (matchesViewerAction(data, "selectFirst")) switchItem(0);
	else if (matchesViewerAction(data, "selectLast")) switchItem(Math.max(0, ctx.itemCount - 1));
	else if (matchesViewerAction(data, "pageUp")) scrollDetail(-ctx.bodyHeight);
	else if (matchesViewerAction(data, "pageDown")) scrollDetail(ctx.bodyHeight);
	else if (matchesViewerAction(data, "refresh")) return { type: "refresh" };
	else if (matchesViewerAction(data, "stop")) {
		// 可停止（queued/running/paused）→ 两步确认；已结束 → warning notice（不进确认态）。
		if (ctx.runRunning) {
			next.stopConfirming = true;
		} else {
			next.notice = { text: `run 已结束（${ctx.runStatus ?? "unknown"}），无需停止`, kind: "warning" };
			return { type: "update", state: next };
		}
	} else if (matchesViewerAction(data, "toggleTrace")) {
		next.showTrace = !state.showTrace;
	} else if (data === "[") {
		next.runIndex = Math.max(0, state.runIndex - 1);
		next.itemIndex = 0;
		next.itemId = "structure";
		next.scroll = 0;
		next.follow = true;
	} else if (data === "]") {
		next.runIndex = Math.min(Math.max(0, ctx.runCount - 1), state.runIndex + 1);
		next.itemIndex = 0;
		next.itemId = "structure";
		next.scroll = 0;
		next.follow = true;
	}
	// 旧键与其余未识别键：忽略不改状态，仍返回 update；普通按键清除 notice。
	delete next.notice;
	return { type: "update", state: next };
}

/** Clamps scroll/follow against the current body size. */
export function clampViewerState(state: ViewerState, totalLines: number, bodyHeight: number): ViewerState {
	const maxScroll = Math.max(0, totalLines - bodyHeight);
	if (state.follow) return { ...state, scroll: maxScroll };
	return { ...state, scroll: Math.min(Math.max(0, state.scroll), maxScroll) };
}

/**
 * Resolves the selected item index from the pinned item id. Falls back to
 * the stored index (clamped) when no id is pinned or the item is gone —
 * pure, so roster growth after a refresh never steals the selection.
 */
export function resolveItemIndex(data: ViewerData, state: ViewerState): number {
	const clamped = Math.min(Math.max(0, state.itemIndex), Math.max(0, data.items.length - 1));
	if (state.itemId === undefined) return clamped;
	const found = data.items.findIndex((item) => item.id === state.itemId);
	return found >= 0 ? found : clamped;
}

/** State with itemIndex re-resolved from the pinned item id (pure). */
export function withResolvedItem(data: ViewerData, state: ViewerState): ViewerState {
	if (data.items.length === 0) return state.itemIndex === 0 ? state : { ...state, itemIndex: 0 };
	const index = resolveItemIndex(data, state);
	return index === state.itemIndex ? state : { ...state, itemIndex: index };
}

/**
 * Refresh-gate fingerprint: everything the frame shows EXCEPT the
 * wall-clock `elapsedMs` labels (run/stage/agent). Those tick every second
 * while the body is idle; repainting on them alone repaints ~1/s and — on a
 * host whose overlay repaint appends instead of replacing — stacks a new
 * title+frame pair per tick (the reported ghosting). Elapsed still
 * refreshes on every content-driven repaint.
 */
export function viewerDataFingerprint(data: ViewerData): string {
	return JSON.stringify(data, (key, value) => (key === "elapsedMs" ? undefined : value));
}

/**
 * Frame-height stabilizer: terminal-row reports that wobble within
 * `tolerance` keep the previous body height instead of resizing the
 * overlay frame (each resize is a full repaint on a trail-prone host).
 */
export function stabilizeBodyHeight(prev: number, next: number, tolerance: number = VIEWER_HEIGHT_JITTER_ROWS): number {
	if (prev <= 0) return next;
	return Math.abs(next - prev) <= tolerance ? prev : next;
}

// ---------------------------------------------------------------------------
// Host component + opener (thin; not unit-tested — repo convention)
// ---------------------------------------------------------------------------

/** Result of a viewer stop request, mapped to a top banner notice. */
export interface StopResult {
	ok: boolean;
	text: string;
}

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
	/**
	 * Stops the whole run after the two-step D confirmation. Wired by the
	 * UI index (runControlAction "stop"); maps the outcome to a banner
	 * notice. Exceptions never escape (busy guard swallows repeats;
	 * rejections render an error notice).
	 */
	onStop?: (runId: string) => Promise<StopResult>;
}

/** pi-tui component wrapper: gated refresh timer + key handling + rendering. */
export class RunViewer implements Component {
	private readonly opts: RunViewerOptions;
	private data: ViewerData;
	private state: ViewerState = initialViewerState();
	private lastTotalLines = 0;
	private lastBodyHeight = 22;
	private lastWidth = 100;
	private lastFingerprint: string | null = null;
	private disposed = false;
	private timer: ReturnType<typeof setInterval> | null = null;

	constructor(opts: RunViewerOptions) {
		this.opts = opts;
		this.data = opts.load(opts.initialRunId);
		const runIndex = this.data.runs.findIndex((r) => r.runId === opts.initialRunId);
		if (runIndex >= 0) this.state = { ...this.state, runIndex };
		try {
			const rows = this.opts.rows?.() ?? 30;
			this.lastBodyHeight = computeFrameHeight(rows);
		} catch {
			/* keep the default height */
		}
		this.lastFingerprint = viewerDataFingerprint(this.data);
		const refreshMs = opts.refreshMs ?? VIEWER_TICK_MS;
		this.timer = setInterval(() => {
			if (this.disposed) return;
			try {
				const next = this.opts.load(this.currentRunId());
				let bodyHeight = this.lastBodyHeight;
				try {
					const rows = this.opts.rows?.() ?? 30;
					bodyHeight = stabilizeBodyHeight(this.lastBodyHeight, computeFrameHeight(rows));
				} catch {
					/* keep the previous height */
				}
				const fingerprint = viewerDataFingerprint(next);
				this.data = next;
				this.state = withResolvedItem(this.data, this.state);
				if (fingerprint === this.lastFingerprint && bodyHeight === this.lastBodyHeight) return;
				this.lastFingerprint = fingerprint;
				this.lastBodyHeight = bodyHeight;
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

	private runRunning(): boolean {
		const status = this.data.detail?.status;
		return status === "queued" || status === "running" || status === "paused";
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
		this.lastWidth = width;
		const rows = this.opts.rows?.() ?? 30;
		const bodyHeight = stabilizeBodyHeight(this.lastBodyHeight, computeFrameHeight(rows));
		this.lastBodyHeight = bodyHeight;
		this.reload();
		this.state = withResolvedItem(this.data, this.state);
		this.lastFingerprint = viewerDataFingerprint(this.data);
		const { detailWidth } = computeViewerLayout(width);
		this.lastTotalLines = viewerBodyLines(this.data, this.state, detailWidth).length;
		this.state = clampViewerState(
			this.state,
			this.lastTotalLines,
			viewerViewportHeight(this.data, this.state, width, bodyHeight, this.opts.styles),
		);
		return renderViewerFrame(this.data, this.state, width, { styles: this.opts.styles, bodyHeight });
	}

	handleInput(data: string): void {
		const result = handleViewerKey(this.state, data, {
			totalLines: this.lastTotalLines,
			itemCount: this.data.items.length,
			itemIds: this.data.items.map((item) => item.id),
			bodyHeight: viewerViewportHeight(this.data, this.state, this.lastWidth, this.lastBodyHeight, this.opts.styles),
			runCount: this.data.runs.length,
			runRunning: this.runRunning(),
			runStatus: this.data.detail?.status,
		});
		if (result.type === "close") {
			this.dispose();
			this.opts.done();
			return;
		}
		if (result.type === "refresh") {
			// 手动刷新：绕过指纹门控强制重载重绘（render() 每次 load）。
			this.requestRender();
			return;
		}
		if (result.type === "stop-confirm") {
			this.beginStop();
			return;
		}
		this.state = withResolvedItem(this.data, result.state);
		if (data === "[" || data === "]") this.reload();
		this.requestRender();
	}

	/**
	 * Runs the injected stop action once: busy banner immediately, notice
	 * on settle. Repeated confirms during the flight are ignored (busy
	 * guard); failures map to an error notice and never escape.
	 */
	private beginStop(): void {
		if (this.state.stopping) return;
		const stop = this.opts.onStop;
		if (!stop) {
			this.state = {
				...this.state,
				stopConfirming: false,
				notice: { text: "停止不可用：当前上下文没有接停止动作", kind: "error" },
			};
			this.requestRender();
			return;
		}
		const runId = this.currentRunId();
		this.state = { ...this.state, stopConfirming: false, stopping: true };
		this.requestRender();
		void (async () => {
			let result: StopResult & { kind: NoticeKind };
			try {
				const outcome = await stop(runId);
				result = { ...outcome, kind: outcome.ok ? "success" : "warning" };
			} catch {
				result = { ok: false, text: "停止失败（控制调用异常）", kind: "error" };
			}
			this.state = { ...this.state, stopping: false, notice: { text: result.text, kind: result.kind } };
			this.requestRender();
		})();
	}

	invalidate(): void {
		/* stateless rendering — nothing cached */
	}

	/** Stops the refresh timer (called on close and by the host on teardown). */
	dispose(): void {
		this.disposed = true;
		if (this.timer !== null) {
			clearInterval(this.timer);
			this.timer = null;
		}
	}
}

/**
 * Overlay geometry for the run viewer, copied verbatim from pi-subagents'
 * fleet inspector (`openSubagentFleet` in `pi-subagents/src/tui/fleet.ts`
 * v0.66.0, line 1440) — geometry/overlay parity with agent-team's viewer
 * (tui-sync matrix A4). Do not "improve" it.
 */
export const VIEWER_OVERLAY_OPTIONS: OverlayOptions = {
	anchor: "center",
	width: "95%",
	minWidth: 60,
	maxHeight: "85%",
	margin: 1,
};

/**
 * Opens the run viewer as a centered capturing overlay (geometry:
 * `VIEWER_OVERLAY_OPTIONS`). Resolves when the user closes it
 * (q/Esc). Host failures are the caller's to guard (ui/index.ts checks
 * hasUI/mode/custom and exception-isolates).
 */
export async function openRunViewer(
	ui: Pick<ExtensionUIContext, "custom">,
	opts: { load: (runId: string) => ViewerData; initialRunId: string; refreshMs?: number; onStop?: (runId: string) => Promise<StopResult> },
): Promise<void> {
	await ui.custom<void>(
		(tui, theme, _keybindings, done) =>
			new RunViewer({
				load: opts.load,
				initialRunId: opts.initialRunId,
				done,
				styles: themeStyles(theme),
				...(opts.onStop ? { onStop: opts.onStop } : {}),
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
			overlayOptions: VIEWER_OVERLAY_OPTIONS,
		},
	);
}
