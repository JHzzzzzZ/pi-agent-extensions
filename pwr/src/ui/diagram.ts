/**
 * PWR UI - script structure diagram for /workflows:view (JHL-18)
 *
 * Renders the script's static call structure (from extractPlan's tree) as a
 * Unicode tree with live runtime status overlaid:
 *
 *  - live rows are correlated to plan nodes BY LABEL ONLY — the runtime
 *    builds one stage per dispatch label, so exact matches are the honest
 *    mapping;
 *  - synthesized nodes (unlabeled calls: "agent #1", "build/agent-2") never
 *    match a runtime label and render static-only;
 *  - runtime stages that match no plan node (anonymous dispatches, dynamic
 *    fan-out) surface in the trailing "未标注/动态派发" bucket instead of
 *    being force-fit onto the diagram.
 *
 * Status is NEVER color-only (PRD 4.3): every row carries a status glyph and
 * a progress count. Pure and dependency-free; fully unit-tested.
 */

import type { PlanNode } from "../types.ts";
import type { AgentView, RunDetail, StageStatus, StageView } from "./types.ts";
import { formatDuration, formatTokens } from "./views.ts";
import { truncateVisible } from "./text.ts";

/** Stage status glyphs (mirrors views.ts labels; shared with viewer tabs). */
export const STAGE_ICON: Record<StageStatus, string> = {
	queued: "··",
	running: "▶",
	paused: "⏸",
	completed: "✓",
	failed: "✗",
};

/** Live aggregate of one runtime stage (tasks + derived stage status). */
export interface StageLive {
	stageId: string;
	label: string;
	kind: StageView["kind"];
	status: StageStatus;
	completed: number;
	total: number;
	cacheHits: number;
	tokens?: number;
	elapsedMs?: number;
}

/** One rendered tree row: a plan node with its (optional) live overlay. */
export interface DiagramRow {
	/** Accumulated ancestor prefix ("" for roots, "│  "/"   " per level). */
	prefix: string;
	last: boolean;
	node: PlanNode;
	live?: StageLive;
}

export interface DiagramModel {
	rows: DiagramRow[];
	/** Runtime stages that matched no plan node label. */
	unmatched: StageLive[];
}

/** Aggregates the detail's agents per stage into live rows. Keyed by stageId. */
export function collectStageLive(detail: RunDetail): Map<string, StageLive> {
	const byStage = new Map<string, StageLive>();
	for (const stage of detail.stages) {
		byStage.set(stage.stageId, stageLiveOf(stage, detail.agents));
	}
	return byStage;
}

function stageLiveOf(stage: StageView, agents: AgentView[]): StageLive {
	const tasks = agents.filter((a) => a.stageId === stage.stageId);
	return {
		stageId: stage.stageId,
		label: stage.label,
		kind: stage.kind,
		status: stage.status,
		completed: tasks.filter((a) => a.status === "completed").length,
		total: tasks.length,
		cacheHits: tasks.filter((a) => a.cacheHit).length,
		tokens: stage.tokens,
		elapsedMs: stage.elapsedMs,
	};
}

/**
 * Builds the diagram model. With a plan tree: plan nodes in source order,
 * live overlays by label match (containers roll up their children). Without
 * a plan (runs rehydrated from persisted entries): a flat fallback of the
 * runtime stages themselves.
 */
export function buildDiagramModel(detail: RunDetail): DiagramModel {
	const byStage = collectStageLive(detail);
	const byLabel = new Map<string, StageLive>();
	for (const live of byStage.values()) {
		if (!byLabel.has(live.label)) byLabel.set(live.label, live);
	}

	const tree = detail.plan?.tree;
	if (!tree || tree.length === 0) {
		const lives = [...byStage.values()];
		const rows: DiagramRow[] = lives.map((live, i) => ({
			prefix: "",
			last: i === lives.length - 1,
			live,
			node: {
				label: live.label,
				kind: live.kind,
				agentCount: Math.max(1, live.total),
				writeRisk: false,
			},
		}));
		return { rows, unmatched: [] };
	}

	const matched = new Set<string>();
	const rows: DiagramRow[] = [];
	const walk = (nodes: PlanNode[], depth: number, prefix: string): void => {
		nodes.forEach((node, index) => {
			const last = index === nodes.length - 1;
			let live = node.synthesized ? undefined : byLabel.get(node.label);
			if (live) {
				matched.add(live.stageId);
			} else if (node.children && node.children.length > 0) {
				live = rollupContainer(node, byLabel);
				for (const id of descendantMatches(node, byLabel)) matched.add(id);
			}
			rows.push({ prefix, last, node, ...(live ? { live } : {}) });
			if (node.children && node.children.length > 0) {
				walk(node.children, depth + 1, `${prefix}${last ? "   " : "│  "}`);
			}
		});
	};
	walk(tree, 0, "");

	const unmatched = [...byStage.values()].filter(
		(live) => !matched.has(live.stageId) && live.total > 0, // 0-task rows are plan seeds, not activity
	);
	return { rows, unmatched };
}

/** Stage ids of a node's descendants that match by label (for matched marking). */
function descendantMatches(node: PlanNode, byLabel: Map<string, StageLive>): string[] {
	const ids: string[] = [];
	const visit = (n: PlanNode): void => {
		const live = n.synthesized ? undefined : byLabel.get(n.label);
		if (live) ids.push(live.stageId);
		for (const child of n.children ?? []) visit(child);
	};
	for (const child of node.children ?? []) visit(child);
	return ids;
}

/**
 * Aggregates a container's descendants into one live row (containers only
 * get a runtime stage when an agent() dispatch reuses their label, which is
 * rare — rolling up the children is the honest default). Status derivation
 * mirrors runtime deriveStageStatus: running > queued > failed > completed.
 */
function rollupContainer(node: PlanNode, byLabel: Map<string, StageLive>): StageLive | undefined {
	let completed = 0;
	let total = 0;
	let cacheHits = 0;
	let tokens = 0;
	let elapsed = 0;
	let any = false;
	let hasRunning = false;
	let hasPending = false;
	let hasFailed = false;
	const visit = (n: PlanNode): void => {
		const live = n.synthesized ? undefined : byLabel.get(n.label);
		if (live) {
			any = true;
			completed += live.completed;
			total += live.total;
			cacheHits += live.cacheHits;
			if (live.tokens !== undefined) tokens += live.tokens;
			if (live.elapsedMs !== undefined && live.elapsedMs > elapsed) elapsed = live.elapsedMs;
			if (live.status === "running") hasRunning = true;
			else if (live.status === "paused" || live.status === "queued") hasPending = true;
			else if (live.status === "failed") hasFailed = true;
		}
		for (const child of n.children ?? []) visit(child);
	};
	for (const child of node.children ?? []) visit(child);
	if (!any) return undefined;
	const status: StageStatus = hasRunning ? "running" : hasPending ? "queued" : hasFailed ? "failed" : "completed";
	return {
		stageId: node.stageId ?? node.label,
		label: node.label,
		kind: node.kind,
		status,
		completed,
		total,
		cacheHits,
		...(tokens > 0 ? { tokens } : {}),
		...(elapsed > 0 ? { elapsedMs: elapsed } : {}),
	};
}

/** Renders the tree rows as plain (ANSI-free) lines, each fitted to `width`. */
export function renderDiagramRows(model: DiagramModel, width: number): string[] {
	const lines: string[] = [];
	for (const row of model.rows) {
		const connector = row.last ? "└─ " : "├─ ";
		const icon = row.live ? STAGE_ICON[row.live.status] : "⋅";
		const badge =
			row.node.kind === "agent"
				? "agent"
				: `${row.node.kind} ×${row.node.agentCount}${row.node.dynamic ? "≈" : ""}`;
		let left = `${row.prefix}${connector}${icon} ${row.node.label} · ${badge}`;
		if (row.node.writeRisk) left += " ✎write";
		if (row.node.synthesized && !row.live) left += " · 静态";
		const right: string[] = [];
		if (row.live) {
			right.push(`${row.live.completed}/${row.live.total}`);
			if (row.live.cacheHits > 0) right.push(`⚡${row.live.cacheHits}`);
			if (row.live.elapsedMs !== undefined && row.live.elapsedMs > 0) right.push(formatDuration(row.live.elapsedMs));
			if (row.live.tokens !== undefined && row.live.tokens > 0) right.push(`${formatTokens(row.live.tokens)} tok`);
		} else {
			right.push("未开始");
		}
		lines.push(truncateVisible(`${left} · ${right.join(" · ")}`, width));
	}
	if (lines.length === 0) lines.push("（暂无结构信息）");
	return lines;
}

/** Renders the trailing bucket of runtime stages that matched no plan node. */
export function renderUnmatchedStages(model: DiagramModel, width: number): string[] {
	if (model.unmatched.length === 0) return [];
	const lines = [`${model.unmatched.length} 个未标注/动态派发：`];
	for (const live of model.unmatched) {
		const parts = [`${STAGE_ICON[live.status]} ${live.label} · ${live.completed}/${live.total}`];
		if (live.cacheHits > 0) parts.push(`⚡${live.cacheHits}`);
		if (live.elapsedMs !== undefined && live.elapsedMs > 0) parts.push(formatDuration(live.elapsedMs));
		lines.push(`  ${truncateVisible(parts.join(" · "), Math.max(4, width - 2))}`);
	}
	return lines;
}
