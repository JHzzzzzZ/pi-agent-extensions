/**
 * PWR UI - pi wiring for /workflows (JHL-15)
 *
 * Registers commands, shortcuts, entry renderer, widget and status line,
 * and feeds the MemoryRunStore from the registry / runtime / persisted
 * entries. Pure logic lives in sibling modules (views/commands/save-flow/
 * run-store) so everything except this file is host-free and unit-tested.
 */

import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ToolDeps } from "../tools.ts";
import type { RunStatus, WorkflowPlan, WorkflowScript, WorkflowRun } from "../types.ts";
import { PWR_RUN_ENTRY } from "../types.ts";
import {
	SHORTCUT_PAUSE,
	SHORTCUT_RESTART,
	SHORTCUT_STOP,
	parseControlArgs,
	parseWorkflowsArgs,
	resolveRunId,
	runApproveAction,
	runControlAction,
	workflowsHelpText,
} from "./commands.ts";
import { runSaveFlow, type SaveFlowActions } from "./save-flow.ts";
import { MemoryRunStore } from "./run-store.ts";
import { createRunEntryRenderer, refreshUiStatus, runCardSummaryLine } from "./renderer.ts";
import type { RunEntryData, UiRuntimeAdapter } from "./types.ts";
import { formatRunDetail, formatRunList, formatStatus } from "./views.ts";

export interface WorkflowsUi {
	store: MemoryRunStore;
	/** Call inside the registry.create wrapper so new runs appear instantly. */
	onRunCreated(run: WorkflowRun, script: WorkflowScript, plan: WorkflowPlan): void;
	/** Call inside the registry.setStatus wrapper so registry-only transitions stay visible. */
	onRunStatusChanged(runId: string, status: RunStatus, startedAt?: string): void;
	/** Call from session_start with the persisted run entries. */
	hydrateEntries(entries: RunEntryData[]): void;
	/** Bind the runtime event feed (JHL-13 onEvent contract). */
	bindRuntime(runtime: UiRuntimeAdapter | null | undefined): void;
	/** Refresh widget + footer status from the store (fire-and-forget). */
	refresh(ctx: ExtensionContext): void;
}

export function createWorkflowsUi(pi: ExtensionAPI, deps: ToolDeps, getRuntime: () => UiRuntimeAdapter | null): WorkflowsUi {
	const store = new MemoryRunStore();
	let lastUi: ExtensionContext["ui"] | undefined;
	let lastViewedRunId: string | undefined;

	const refresh = (ctx: ExtensionContext): void => {
		lastUi = ctx.ui;
		refreshUiStatus(ctx.ui, store);
	};

	const notify = (ctx: ExtensionCommandContext, text: string, type: "info" | "warning" | "error" = "info"): void => {
		ctx.ui.notify(text, type);
	};

	// ----- run list / detail -----
	function showList(ctx: ExtensionCommandContext, status?: string): void {
		const entries = store.listRuns().filter((e) => !status || e.status === status);
		notify(ctx, formatRunList(entries, { statusFilter: status as RunStatus | undefined }));
	}

	async function showDetail(ctx: ExtensionCommandContext, ref: string): Promise<void> {
		const runId = resolveRunId(store, ref);
		if (!runId) {
			notify(ctx, `Error: run "${ref}" not found (RUN_NOT_FOUND).`, "error");
			return;
		}
		const detail = store.getDetail(runId);
		if (!detail) {
			notify(ctx, `Error: run "${ref}" not found (RUN_NOT_FOUND).`, "error");
			return;
		}
		lastViewedRunId = runId;
		notify(ctx, formatRunDetail(detail), "info");
		await runDetailMenu(ctx, runId);
	}

	async function runDetailMenu(ctx: ExtensionCommandContext, runId: string): Promise<void> {
		if (!ctx.hasUI) return;
		const detail = store.getDetail(runId);
		if (!detail) return;
		const actions = ["Refresh", "Pause", "Resume", "Stop run", "Stop agent", "Restart agent", "Save as command", "View script", "Back"];
		const choice = await ctx.ui.select(`PWR run ${runId.slice(0, 8)} — ${detail.scriptName}`, actions);
		if (!choice || choice === "Back") return;
		switch (choice) {
			case "Refresh": {
				const fresh = store.getDetail(runId);
				notify(ctx, formatRunDetail(fresh ?? detail), "info");
				break;
			}
			case "Pause": {
				await dispatchControl(ctx, "pause", runId);
				break;
			}
			case "Resume": {
				await dispatchControl(ctx, "resume", runId);
				break;
			}
			case "Stop run": {
				await dispatchControl(ctx, "stop", runId);
				break;
			}
			case "Stop agent": {
				const agentId = await pickAgent(ctx, runId, "Choose an agent to stop");
				if (agentId) await dispatchControl(ctx, "stop", runId, agentId);
				break;
			}
			case "Restart agent": {
				const agentId = await pickAgent(ctx, runId, "Choose an agent to restart");
				if (agentId) await dispatchControl(ctx, "restart_agent", runId, agentId);
				break;
			}
			case "Save as command": {
				await saveFlow(ctx, runId);
				break;
			}
			case "View script": {
				const script = deps.registry.getScript(runId);
				notify(ctx, script ? `[PWR] Workflow script (read-only)\n\n${script.source}` : "Script not available.", "info");
				break;
			}
		}
		// Stay in the menu so multi-step control is possible.
		await runDetailMenu(ctx, runId);
	}

	async function pickAgent(ctx: ExtensionCommandContext, runId: string, title: string): Promise<string | undefined> {
		const detail = store.getDetail(runId);
		if (!detail || detail.agents.length === 0) {
			notify(ctx, "No agent tasks recorded yet.", "warning");
			return undefined;
		}
		const options = detail.agents.map((a) => `${a.taskId.slice(0, 8)} ${formatStatus(a.status)} ${a.label}`);
		const picked = await ctx.ui.select(title, options);
		if (!picked) return undefined;
		return detail.agents.find((a) => picked.startsWith(a.taskId.slice(0, 8)))?.taskId;
	}

	async function dispatchControl(
		ctx: ExtensionCommandContext,
		action: "pause" | "resume" | "stop" | "restart_agent",
		runId: string,
		agentId?: string,
	): Promise<void> {
		notify(ctx, `${action}…`, "info");
		const outcome = await runControlAction(deps, store, action, runId, agentId);
		if (outcome.ok) {
			notify(ctx, `${outcome.text}\n${runCardSummaryLine(store, outcome.runId)}`, "info");
		} else {
			notify(ctx, outcome.text, "error");
		}
		refresh(ctx);
	}

	// ----- save flow (goal 4) -----
	function makeSaveActions(ctx: ExtensionCommandContext): SaveFlowActions {
		return {
			askName: (defaultName) => ctx.ui.input("Save workflow as command name", defaultName),
			askScope: async () => {
				const scope = await ctx.ui.select("Save scope", ["user", "project"]);
				return scope === "user" || scope === "project" ? scope : undefined;
			},
			confirmOverwrite: (name, scope) => ctx.ui.confirm("Overwrite?", `"${name}" already exists (${scope} scope). Overwrite it?`),
			notify: (text, type) => ctx.ui.notify(text, type),
		};
	}
	async function saveFlow(ctx: ExtensionCommandContext, runId: string): Promise<void> {
		await runSaveFlow({ store, saveAdapter: deps.saveAdapter }, makeSaveActions(ctx), runId);
	}

	// ----- commands -----
	pi.registerCommand("workflows", {
		description: "List PWR workflow runs or open a run detail view (/workflows [runId | --filter <status>]).",
		handler: async (args, ctx) => {
			const parsed = parseWorkflowsArgs(args ?? "");
			if (parsed.kind === "help") {
				notify(ctx, workflowsHelpText(), "info");
				return;
			}
			if (parsed.kind === "list") {
				showList(ctx, parsed.status);
				return;
			}
			await showDetail(ctx, parsed.runId);
		},
	});

	pi.registerCommand("workflows:list", {
		description: "List PWR runs, optionally filtered by status.",
		handler: async (args, ctx) => {
			const status = (args ?? "").trim();
			showList(ctx, status === "" ? undefined : status);
		},
	});

	pi.registerCommand("workflows:open", {
		description: "Open a PWR run detail view.",
		handler: async (args, ctx) => {
			const ref = (args ?? "").trim();
			if (!ref) {
				notify(ctx, "Usage: /workflows:open <runId>", "error");
				return;
			}
			await showDetail(ctx, ref);
		},
	});

	pi.registerCommand("workflows:pause", {
		description: "Pause a PWR run.",
		handler: async (args, ctx) => {
			const parsed = parseControlArgs("pause", args ?? "");
			if (!parsed.ok) {
				notify(ctx, parsed.usage, "error");
				return;
			}
			await dispatchControl(ctx, "pause", parsed.runId);
		},
	});

	pi.registerCommand("workflows:resume", {
		description: "Resume a paused PWR run.",
		handler: async (args, ctx) => {
			const parsed = parseControlArgs("resume", args ?? "");
			if (!parsed.ok) {
				notify(ctx, parsed.usage, "error");
				return;
			}
			await dispatchControl(ctx, "resume", parsed.runId);
		},
	});

	pi.registerCommand("workflows:stop", {
		description: "Stop a PWR run, or a single agent task: /workflows:stop <runId> [taskId].",
		handler: async (args, ctx) => {
			const parsed = parseControlArgs("stop", args ?? "");
			if (!parsed.ok) {
				notify(ctx, parsed.usage, "error");
				return;
			}
			await dispatchControl(ctx, "stop", parsed.runId, parsed.agentId);
		},
	});

	pi.registerCommand("workflows:restart", {
		description: "Restart a single agent task (completed cache unchanged): /workflows:restart <runId> <taskId>.",
		handler: async (args, ctx) => {
			const parsed = parseControlArgs("restart_agent", args ?? "");
			if (!parsed.ok) {
				notify(ctx, parsed.usage, "error");
				return;
			}
			await dispatchControl(ctx, "restart_agent", parsed.runId, parsed.agentId);
		},
	});

	pi.registerCommand("workflows:save", {
		description: "Save a PWR run as a reusable command (with overwrite confirmation).",
		handler: async (args, ctx) => {
			const ref = (args ?? "").trim();
			if (!ref) {
				notify(ctx, "Usage: /workflows:save <runId>", "error");
				return;
			}
			await saveFlow(ctx, ref);
		},
	});

	pi.registerCommand("workflows:script", {
		description: "Show the raw script of a PWR run (read-only).",
		handler: async (args, ctx) => {
			const ref = (args ?? "").trim();
			const runId = ref ? resolveRunId(store, ref) : undefined;
			if (!runId) {
				notify(ctx, ref ? `Error: run "${ref}" not found (RUN_NOT_FOUND).` : "Usage: /workflows:script <runId>", "error");
				return;
			}
			const script = deps.registry.getScript(runId);
			notify(ctx, script ? `[PWR] Workflow script (read-only)\n\n${script.source}` : "Script not available for this run.", "info");
		},
	});

	pi.registerCommand("workflows:approve", {
		description: "Approve and start a run waiting for approval: /workflows:approve <runId> (shows the approval card).",
		handler: async (args, ctx) => {
			const ref = (args ?? "").trim();
			if (!ref) {
				notify(ctx, "Usage: /workflows:approve <runId>", "error");
				return;
			}
			const outcome = await runApproveAction(deps, store, ref, ctx);
			notify(ctx, outcome.text, outcome.ok ? "info" : "error");
			refresh(ctx);
		},
	});

	pi.registerCommand("workflows:help", {
		description: "Show PWR /workflows command help.",
		handler: async (_args, ctx) => {
			notify(ctx, workflowsHelpText(), "info");
		},
	});

	// ----- shortcuts (operate on the last viewed run) -----
	pi.registerShortcut(SHORTCUT_PAUSE, {
		description: "Pause the last viewed PWR run",
		handler: async (ctx) => {
			if (!lastViewedRunId) {
				ctx.ui.notify("No PWR run viewed yet — open one with /workflows <runId> first.", "warning");
				return;
			}
			await dispatchControl(ctx as ExtensionCommandContext, "pause", lastViewedRunId);
		},
	});

	pi.registerShortcut(SHORTCUT_STOP, {
		description: "Stop the last viewed PWR run",
		handler: async (ctx) => {
			if (!lastViewedRunId) {
				ctx.ui.notify("No PWR run viewed yet — open one with /workflows <runId> first.", "warning");
				return;
			}
			await dispatchControl(ctx as ExtensionCommandContext, "stop", lastViewedRunId);
		},
	});

	pi.registerShortcut(SHORTCUT_RESTART, {
		description: "Restart an agent of the last viewed PWR run",
		handler: async (ctx) => {
			if (!lastViewedRunId) {
				ctx.ui.notify("No PWR run viewed yet — open one with /workflows <runId> first.", "warning");
				return;
			}
			const agentId = await pickAgent(ctx as ExtensionCommandContext, lastViewedRunId, "Choose an agent to restart");
			if (agentId) await dispatchControl(ctx as ExtensionCommandContext, "restart_agent", lastViewedRunId, agentId);
		},
	});

	// ----- entry renderer + widget/status -----
	pi.registerEntryRenderer(PWR_RUN_ENTRY, createRunEntryRenderer(store));

	store.subscribe(() => {
		if (lastUi) refreshUiStatus(lastUi, store);
	});

	return {
		store,
		onRunCreated(run, script, plan) {
			store.hydrateRun(run, script, plan);
		},
		onRunStatusChanged(runId, status, startedAt) {
			store.feedEvent({ type: "run_status", runId, status, at: startedAt ?? new Date().toISOString() });
		},
		hydrateEntries(entries) {
			store.hydrateEntries(entries);
		},
		bindRuntime(runtime) {
			if (!runtime) return;
			runtime.onEvent?.((ev) => store.feedEvent(ev));
		},
		refresh,
	};
}
