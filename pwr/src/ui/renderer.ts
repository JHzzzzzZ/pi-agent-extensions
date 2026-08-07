/**
 * PWR UI - run entry renderer, status widget and status line (JHL-15 goal 3)
 *
 * - `pi-workflow-run-v1` entry renderer: collapsed = one-line summary,
 *   expanded = full detail text (PRD 4.3, 6.1: entry persists metadata only,
 *   never full prompts/tool output).
 * - Status widget above the editor (`setWidget`) + footer status
 *   (`setStatus`) updated from the store; main session only ever receives
 *   the short summary lines, never intermediate agent output.
 */

import { Box, Text, type Component } from "@earendil-works/pi-tui";
import type { EntryRenderer, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { RunEntryData, RunStore } from "./types.ts";
import { formatCount, formatDuration, formatStatus, runCardLines } from "./views.ts";

const ACTIVE_STATUSES = new Set(["queued", "running", "paused", "awaiting_approval"]);

/** Collapsed one-line summary for the entry card. */
export function runCardSummaryLine(store: RunStore, runId: string): string {
	const detail = store.getDetail(runId);
	if (!detail) return "run (unknown)";
	const completed = detail.agents.filter((a) => a.status === "completed").length;
	const total = detail.budget?.estimatedAgents ?? detail.agents.length;
	return `${formatStatus(detail.status)} ${detail.scriptName} · ${formatDuration(detail.elapsedMs)} · ${formatCount(completed, total)} agents`;
}

/** Entry renderer for pi-workflow-run-v1 (registered via pi.registerEntryRenderer). */
export function createRunEntryRenderer(store: RunStore): EntryRenderer<RunEntryData | undefined> {
	return (entry, options, theme) => {
		const data = entry.data;
		if (!data || typeof data.runId !== "string") return undefined;
		const detail = store.getDetail(data.runId);
		const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
		if (!detail) {
			box.addChild(new Text(`${formatStatus(data.status)} run ${data.runId.slice(0, 8)}`));
			return box;
		}
		box.addChild(new Text(runCardSummaryLine(store, detail.runId)));
		if (options.expanded) {
			box.addChild(new Text(""));
			box.addChild(new Text(runDetailText(detail.runId, store), 1, 0));
		}
		return box;
	};
}

/** Full expanded detail text for the entry renderer. */
export function runDetailText(runId: string, store: RunStore): string {
	const detail = store.getDetail(runId);
	if (!detail) return "run not found";
	return runCardLines(detail).join("\n");
}

/**
 * Compact widget lines (setWidget). Capped at `maxRuns` so the widget never
 * grows unbounded; refreshed only when the store emits (push, no polling).
 */
export function runWidgetLines(store: RunStore, maxRuns = 5): string[] {
	const lines: string[] = ["PWR runs:"];
	const runs = store.listRuns();
	if (runs.length === 0) {
		lines.push("  (no runs)");
		return lines;
	}
	const shown = runs.slice(0, maxRuns);
	for (const entry of shown) {
		const run = entry.runId.slice(0, 8);
		const warnings = entry.warnings.length > 0 ? ` [!${entry.warnings.length}]` : "";
		lines.push(`  ${formatStatus(entry.status)} ${run} ${entry.scriptName} · ${formatDuration(entry.totalElapsedMs)} · ${formatCount(entry.completedAgents, entry.totalAgents)}${warnings}`);
	}
	if (runs.length > maxRuns) lines.push(`  … and ${runs.length - maxRuns} more`);
	return lines;
}

/** Footer status line (short summary, main session friendly). */
export function runStatusText(store: RunStore): string | undefined {
	const runs = store.listRuns();
	const active = runs.filter((r) => ACTIVE_STATUSES.has(r.status));
	if (active.length === 0) return undefined;
	const top = active[0];
	const done = runs.length - active.length;
	return `workflows: ${active.length} active (${top.scriptName} ${top.status}), ${done} finished`;
}

/** Non-blocking push of status + widget from the store. */
export function refreshUiStatus(ui: ExtensionUIContext, store: RunStore): void {
	ui.setStatus("pwr", runStatusText(store));
	ui.setWidget("pwr-runs", runWidgetLines(store));
}
