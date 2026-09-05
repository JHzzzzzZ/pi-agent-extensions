/**
 * PWR UI - pure text views for /workflows (JHL-15)
 *
 * All rendering is plain text; status is NEVER color-only (PRD 4.3: 状态不可
 * 仅用颜色表达). Every status carries a text glyph + the status word, so the
 * output stays meaningful in print mode, RPC mode and logs.
 *
 * These functions are dependency-free (no pi host) and fully unit-tested.
 */

import type { RunStatus } from "../types.ts";
import { shortcutHint } from "./keybindings.ts";
import type { AgentView, RunDetail, RunListEntry, StageView } from "./types.ts";
import { COST_WARN_USD } from "./types.ts";

export const RUN_STATUS_GLYPH: Record<RunStatus, string> = {
	draft: "…",
	awaiting_approval: "?",
	queued: "··",
	running: "▶",
	paused: "⏸",
	completed: "✓",
	failed: "✗",
	cancelled: "■",
};

export const STAGE_STATUS_LABEL: Record<StageView["status"], string> = {
	queued: "·· queued",
	running: "▶ running",
	paused: "⏸ paused",
	completed: "✓ completed",
	failed: "✗ failed",
};

export const TASK_STATUS_LABEL: Record<AgentView["status"], string> = {
	queued: "·· queued",
	running: "▶ running",
	completed: "✓ completed",
	failed: "✗ failed",
	cancelled: "■ cancelled",
};

export function formatStatus(status: RunStatus): string {
	return `${RUN_STATUS_GLYPH[status]} ${status}`;
}

export function formatDuration(ms: number | undefined): string {
	if (ms === undefined || Number.isNaN(ms)) return "-";
	if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
	const totalSeconds = Math.round(ms / 1000);
	if (totalSeconds < 60) return `${totalSeconds}s`;
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	if (minutes < 60) return `${minutes}m ${seconds.toString().padStart(2, "0")}s`;
	const hours = Math.floor(minutes / 60);
	return `${hours}h ${(minutes % 60).toString().padStart(2, "0")}m`;
}

export function formatTokens(tokens: number | undefined): string {
	if (tokens === undefined || Number.isNaN(tokens)) return "-";
	if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
	if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k`;
	return String(tokens);
}

export function formatCost(cost: number | undefined): string {
	if (cost === undefined || Number.isNaN(cost)) return "-";
	return `$${cost.toFixed(2)}`;
}

export function formatDateTime(iso: string | undefined): string {
	if (!iso) return "-";
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return iso;
	return d.toISOString().slice(0, 19).replace("T", " ");
}

export function formatDigest(digest: string): string {
	return digest.slice(0, 12);
}

export function formatCount(completed: number, total: number): string {
	return `${completed}/${total}`;
}

/** One line of the run list (PRD 4.3: run id, script name, status, elapsed, agents done, warnings). */
export function formatRunListLine(entry: RunListEntry): string {
	const run = entry.runId.slice(0, 8);
	const script = entry.scriptName.padEnd(18).slice(0, 18);
	const status = formatStatus(entry.status).padEnd(18);
	const elapsed = formatDuration(entry.totalElapsedMs).padEnd(9);
	const agents = formatCount(entry.completedAgents, entry.totalAgents).padEnd(9);
	const tokens = formatTokens(entry.tokens).padEnd(8);
	const cost = formatCost(entry.cost).padEnd(7);
	const warnings = entry.warnings.length > 0 ? `[!] ${entry.warnings.join(", ")}` : "-";
	return `${run}  ${script}  ${status}  ${elapsed}  ${agents}  ${tokens}  ${cost}  ${warnings}`;
}

export interface RunListOptions {
	title?: string;
	statusFilter?: RunStatus;
	header?: boolean;
}

export function formatRunList(entries: RunListEntry[], opts: RunListOptions = {}): string {
	const title = opts.title ?? "PWR runs";
	const lines = [`${title} (${entries.length})`];
	if (opts.header) {
		lines.push(`run        script              status             elapsed    agents     tokens    cost     warnings`);
	}
	for (const entry of entries) {
		if (opts.statusFilter && entry.status !== opts.statusFilter) continue;
		lines.push(formatRunListLine(entry));
	}
	if (opts.statusFilter) {
		lines.push(`filter: ${opts.statusFilter} — use /workflows:list without filter to see all runs`);
	}
	return lines.join("\n");
}

export function formatStageLine(stage: StageView): string {
	const label = stage.label.padEnd(20).slice(0, 20);
	const status = STAGE_STATUS_LABEL[stage.status].padEnd(18);
	const agents = stage.kind === "agent" ? "single" : `${stage.agentCount} agents${stage.dynamic ? " · 动态" : ""}`;
	const tokens = formatTokens(stage.tokens).padEnd(8);
	const elapsed = formatDuration(stage.elapsedMs);
	return `${status}  ${label}  ${agents.padEnd(14)}  ${tokens}  ${elapsed}`;
}

export function formatAgentLine(agent: AgentView): string {
	const label = agent.label.padEnd(24).slice(0, 24);
	const status = TASK_STATUS_LABEL[agent.status].padEnd(16);
	const attempt = `attempt ${agent.attempt}`;
	const tools = agent.toolPolicy ? `tools: ${agent.toolPolicy}` : "tools: -";
	const elapsed = formatDuration(agent.elapsedMs);
	return `${status}  ${label}  ${attempt.padEnd(11)}  ${tools.padEnd(18)}  ${elapsed}`;
}

export function formatBudget(budget: RunDetail["budget"]): string {
	if (!budget) return "budget: -";
	const parts = [`~${budget.estimatedAgents} agents`];
	if (budget.writeRisk) parts.push("write risk: yes");
	if (budget.warnLargeRun) parts.push("[!] large run (over 25 agents)");
	return parts.join(" · ");
}

/** Warning summary line for the detail header. */
export function formatDetailWarnings(detail: RunDetail): string {
	return detail.warnings.length > 0 ? detail.warnings.map((w) => `[!] ${w}`).join(" · ") : "-";
}

/** Full run detail text (PRD 4.3: run/stages/agents + script & save section). */
export function formatRunDetail(detail: RunDetail): string {
	const lines: string[] = [];
	lines.push(`PWR run ${detail.runId.slice(0, 8)} — ${detail.scriptName} (${formatStatus(detail.status)})`);
	lines.push(`run id:      ${detail.runId}`);
	lines.push(`script:      ${detail.scriptName} (digest ${formatDigest(detail.digest)})`);
	if (detail.meta?.description) lines.push(`meta:        ${detail.meta.description}`);
	if (detail.meta?.version !== undefined) lines.push(`version:     ${String(detail.meta.version)}`);
	lines.push(`args:        ${detail.args === undefined ? "none" : safeJson(detail.args)}`);
	lines.push(`created:     ${formatDateTime(detail.createdAt)}`);
	const elapsed = formatDuration(detail.elapsedMs);
	if (detail.endedAt) {
		lines.push(`ended:       ${formatDateTime(detail.endedAt)} · elapsed ${elapsed}`);
	} else if (detail.startedAt) {
		lines.push(`started:     ${formatDateTime(detail.startedAt)} · elapsed ${elapsed}`);
	} else {
		lines.push(`elapsed:     ${elapsed}`);
	}
	lines.push(`budget:      ${formatBudget(detail.budget)}`);
	lines.push(`tokens:      ${formatTokens(detail.totalTokens)} · cost ${formatCost(detail.totalCost)}`);
	lines.push(`warnings:    ${formatDetailWarnings(detail)}`);

	if (detail.errorMessage) lines.push(`error:       ${detail.errorCode ?? "-"}: ${detail.errorMessage}`);

	if (detail.finalSummary) {
		lines.push(`final:       ${detail.finalSummary}`);
	}

	lines.push("");
	lines.push(`Stages (${detail.stages.length}):`);
	if (detail.stages.length === 0) {
		lines.push("  (no stage info yet)");
	} else {
		for (const stage of detail.stages) lines.push(`  ${formatStageLine(stage)}`);
	}

	lines.push("");
	lines.push(`Agents (${detail.agents.length}):`);
	if (detail.agents.length === 0) {
		lines.push("  (no agent info yet)");
	} else {
		for (const agent of detail.agents) {
			lines.push(`  ${formatAgentLine(agent)}`);
			if (agent.promptSummary) lines.push(`     prompt: ${agent.promptSummary}`);
			if (agent.recentEvents.length > 0) {
				lines.push(`     events: ${agent.recentEvents.slice(-5).join(" → ")}`);
			}
			if (agent.resultSummary) lines.push(`     result: ${agent.resultSummary}`);
			if (agent.error) lines.push(`     error:  ${agent.error}`);
		}
	}

	lines.push("");
	lines.push("Actions (commands + keys):");
	lines.push(`  /workflows:pause ${detail.runId.slice(0, 8)}    ${shortcutHint("pause")}  pause run`);
	lines.push(`  /workflows:resume ${detail.runId.slice(0, 8)}                 resume run`);
	lines.push(`  /workflows:stop ${detail.runId.slice(0, 8)}      ${shortcutHint("stop")}  stop run (or one agent)`);
	lines.push(`  /workflows:restart ${detail.runId.slice(0, 8)} <taskId>  ${shortcutHint("restart")}  restart agent`);
	lines.push(`  /workflows:save ${detail.runId.slice(0, 8)}      save as command`);
	lines.push(`  /workflows:script ${detail.runId.slice(0, 8)}    view raw script`);
	lines.push(`  /workflows      list all runs`);
	return lines.join("\n");
}

/** Compact card lines for the entry renderer widget (main session shows only a short summary). */
export function runCardLines(detail: RunDetail): string[] {
	const lines: string[] = [];
	lines.push(`${formatStatus(detail.status)} ${detail.scriptName} — ${formatDuration(detail.elapsedMs)} · ${formatCount(
		detail.agents.filter((a) => a.status === "completed").length,
		detail.budget?.estimatedAgents ?? detail.agents.length,
	)} agents`);
	if (detail.totalTokens) lines.push(`tokens ${formatTokens(detail.totalTokens)} · cost ${formatCost(detail.totalCost)}`);
	if (detail.warnings.length > 0) lines.push(`[!] ${detail.warnings.join(" · ")}`);
	if (detail.finalSummary) lines.push(detail.finalSummary);
	return lines;
}

function safeJson(value: unknown): string {
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}

/** Human-readable threshold used in warnings copy. */
export function costWarningText(): string {
	return `cost over $${COST_WARN_USD.toFixed(2)}`;
}
