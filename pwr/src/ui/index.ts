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
	WORKFLOWS_COMMAND,
	WORKFLOWS_SUBCOMMANDS,
	RETIRED_WORKFLOWS_SUBCOMMANDS,
	latestRunId,
	parseControlArgs,
	parseRunRefArgs,
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
import { formatRunDetail, formatRunList, formatSavedWorkflows, formatStatus } from "./views.ts";
import { describeSavedWorkflows } from "../save.ts";
import { PWR_SHORTCUTS } from "./keybindings.ts";
import { assembleViewerData, openRunViewer, type ViewerData } from "./viewer.ts";

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

	// ----- full-screen live viewer (JHL-18) -----
	/**
	 * One viewer refresh tick: pull the runtime's rich view snapshot into the
	 * store (when the runtime knows the run — post-restart runs fall back to
	 * the store-only snapshot), then assemble the pure viewer data.
	 */
	function viewerLoad(runId: string): ViewerData {
		const runtime = getRuntime();
		if (runtime?.view) {
			try {
				store.applyRuntimeView(runId, runtime.view(runId));
			} catch {
				// Unknown to the runtime (e.g. rehydrated run) — store-only.
			}
		}
		const detail = store.getDetail(runId);
		let scriptSource: string | undefined;
		try {
			scriptSource = deps.registry.getScript(runId)?.source;
		} catch {
			scriptSource = undefined;
		}
		const runs = store.listRuns().map((r) => ({ runId: r.runId, scriptName: r.scriptName, status: r.status }));
		return assembleViewerData(detail, scriptSource, runs);
	}

	async function openViewer(ctx: ExtensionCommandContext, ref: string): Promise<void> {
		if (!ctx.hasUI || ctx.mode !== "tui") {
			notify(ctx, "The live viewer needs the interactive TUI (unavailable in headless modes).", "warning");
			return;
		}
		if (typeof ctx.ui.custom !== "function") {
			notify(ctx, "This host does not support custom overlays.", "warning");
			return;
		}
		const runId = ref ? resolveRunId(store, ref) : (lastViewedRunId ?? latestRunId(store));
		if (!runId) {
			notify(ctx, "No PWR runs yet — create one with /workflow <task> first.", "warning");
			return;
		}
		lastViewedRunId = runId;
		try {
			await openRunViewer(ctx.ui, {
				load: viewerLoad,
				initialRunId: runId,
				// D 两步确认后的停止：复用 /workflows:stop 的控制路径（store 同步刷新）。
				onStop: async (stoppingRunId) => {
					const outcome = await runControlAction(deps, store, "stop", stoppingRunId);
					return { ok: outcome.ok, text: outcome.text };
				},
			});
		} catch (err) {
			notify(ctx, `Viewer failed: ${err instanceof Error ? err.message : String(err)}`, "warning");
		}
	}

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
		const actions = [
			"View live (full-screen)",
			"Refresh",
			"Pause",
			"Resume",
			"Stop run",
			"Stop agent",
			"Restart agent",
			"Save as command",
			"View script",
			"Back",
		];
		const choice = await ctx.ui.select(`PWR run ${runId.slice(0, 8)} — ${detail.scriptName}`, actions);
		if (!choice || choice === "Back") return;
		switch (choice) {
			case "View live (full-screen)": {
				await openViewer(ctx, runId);
				break;
			}
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
	/** 首个空白分隔 token（无则 undefined）。 */
	const firstArg = (args: string): string | undefined => args.trim().split(/\s+/).filter(Boolean)[0];

	/** `parseControlArgs` + `dispatchControl` 的共用包装（冒号子命令入口）。 */
	async function dispatchControlArgs(
		ctx: ExtensionCommandContext,
		action: "pause" | "resume" | "stop" | "restart_agent",
		args: string,
	): Promise<void> {
		const parsed = parseControlArgs(action, args);
		if (!parsed.ok) {
			notify(ctx, parsed.usage, "error");
			return;
		}
		await dispatchControl(ctx, action, parsed.runId, parsed.agentId);
	}

	/**
	 * `/workflows` 裸命令（命令面冒号化 v2.8.0）：无参=列表；`<runId>`=详情；
	 * `--filter <状态>`；`help|--help|-h`=帮助。旧空格子命令只提示改名、绝不执行；
	 * 子命令是独立静态命令（WORKFLOWS_SUBCOMMANDS），各有独立 handler。
	 */
	pi.registerCommand(WORKFLOWS_COMMAND, {
		description:
			"PWR 工作流：无参=运行列表；/workflows <runId> 详情；/workflows --filter <状态>；子命令为独立冒号命令（/workflows:list|view|open|pause|resume|stop|restart|save|saved|script|approve|help）",
		handler: async (args, ctx) => {
			const trimmed = (args ?? "").trim();
			const head = firstArg(trimmed) ?? "";
			const renamed = RETIRED_WORKFLOWS_SUBCOMMANDS[head];
			if (renamed) {
				notify(ctx, `「/workflows ${head}」已改名为「/${renamed.command}」；用法：${renamed.usage}`, "warning");
				return;
			}
			const route = parseWorkflowsArgs(trimmed);
			switch (route.kind) {
				case "help":
					notify(ctx, workflowsHelpText(), "info");
					return;
				case "list":
					showList(ctx, route.status);
					return;
				case "detail":
					await showDetail(ctx, route.runId);
					return;
			}
		},
	});

	pi.registerCommand(WORKFLOWS_SUBCOMMANDS.list, {
		description: "运行列表：/workflows:list [draft|awaiting_approval|queued|running|paused|completed|failed|cancelled]",
		handler: async (args, ctx) => showList(ctx, firstArg(args ?? "")),
	});

	pi.registerCommand(WORKFLOWS_SUBCOMMANDS.view, {
		description: "全屏实时查看器：/workflows:view [runId]（无参=最近 run；左 roster / 右 detail）",
		handler: async (args, ctx) => openViewer(ctx, firstArg(args ?? "") ?? ""),
	});

	pi.registerCommand(WORKFLOWS_SUBCOMMANDS.open, {
		description: "运行详情：/workflows:open <runId>（完整 id 或 8 位前缀）",
		handler: async (args, ctx) => {
			const parsed = parseRunRefArgs("open", args ?? "");
			if (!parsed.ok) {
				notify(ctx, parsed.usage, "error");
				return;
			}
			await showDetail(ctx, parsed.runId);
		},
	});

	pi.registerCommand(WORKFLOWS_SUBCOMMANDS.pause, {
		description: "暂停 run：/workflows:pause <runId>",
		handler: async (args, ctx) => dispatchControlArgs(ctx, "pause", args ?? ""),
	});

	pi.registerCommand(WORKFLOWS_SUBCOMMANDS.resume, {
		description: "恢复 run：/workflows:resume <runId>",
		handler: async (args, ctx) => dispatchControlArgs(ctx, "resume", args ?? ""),
	});

	pi.registerCommand(WORKFLOWS_SUBCOMMANDS.stop, {
		description: "停止 run（或单个 agent）：/workflows:stop <runId> [taskId]",
		handler: async (args, ctx) => dispatchControlArgs(ctx, "stop", args ?? ""),
	});

	pi.registerCommand(WORKFLOWS_SUBCOMMANDS.restart, {
		description: "重跑单个 agent：/workflows:restart <runId> <taskId>（已完成缓存不变）",
		handler: async (args, ctx) => dispatchControlArgs(ctx, "restart_agent", args ?? ""),
	});

	pi.registerCommand(WORKFLOWS_SUBCOMMANDS.save, {
		description: "把 run 保存为命令：/workflows:save <runId>",
		handler: async (args, ctx) => {
			const parsed = parseRunRefArgs("save", args ?? "");
			if (!parsed.ok) {
				notify(ctx, parsed.usage, "error");
				return;
			}
			await saveFlow(ctx, parsed.runId);
		},
	});

	pi.registerCommand(WORKFLOWS_SUBCOMMANDS.saved, {
		description: "列出已保存工作流（scope/描述/参数提示）",
		handler: async (_args, ctx) => notify(ctx, formatSavedWorkflows(describeSavedWorkflows(deps)), "info"),
	});

	pi.registerCommand(WORKFLOWS_SUBCOMMANDS.script, {
		description: "查看 run 的原始脚本（只读）：/workflows:script <runId>",
		handler: async (args, ctx) => {
			const parsed = parseRunRefArgs("script", args ?? "");
			if (!parsed.ok) {
				notify(ctx, parsed.usage, "error");
				return;
			}
			const runId = resolveRunId(store, parsed.runId);
			if (!runId) {
				notify(ctx, `Error: run "${parsed.runId}" not found (RUN_NOT_FOUND).`, "error");
				return;
			}
			const script = deps.registry.getScript(runId);
			notify(ctx, script ? `[PWR] Workflow script (read-only)\n\n${script.source}` : "Script not available for this run.", "info");
		},
	});

	pi.registerCommand(WORKFLOWS_SUBCOMMANDS.approve, {
		description: "批准等待审批的 run：/workflows:approve <runId>",
		handler: async (args, ctx) => {
			const parsed = parseRunRefArgs("approve", args ?? "");
			if (!parsed.ok) {
				notify(ctx, parsed.usage, "error");
				return;
			}
			const outcome = await runApproveAction(deps, store, parsed.runId, ctx);
			notify(ctx, outcome.text, outcome.ok ? "info" : "error");
			refresh(ctx);
		},
	});

	pi.registerCommand(WORKFLOWS_SUBCOMMANDS.help, {
		description: "显示 PWR 冒号命令面帮助",
		handler: async (_args, ctx) => notify(ctx, workflowsHelpText(), "info"),
	});

	// ----- shortcuts (operate on the last viewed run; keys from keybindings.ts) -----
	pi.registerShortcut(PWR_SHORTCUTS.pause.key, {
		description: PWR_SHORTCUTS.pause.description,
		handler: async (ctx) => {
			if (!lastViewedRunId) {
				ctx.ui.notify("No PWR run viewed yet — open one with /workflows:open <runId> first.", "warning");
				return;
			}
			await dispatchControl(ctx as ExtensionCommandContext, "pause", lastViewedRunId);
		},
	});

	pi.registerShortcut(PWR_SHORTCUTS.stop.key, {
		description: PWR_SHORTCUTS.stop.description,
		handler: async (ctx) => {
			if (!lastViewedRunId) {
				ctx.ui.notify("No PWR run viewed yet — open one with /workflows:open <runId> first.", "warning");
				return;
			}
			await dispatchControl(ctx as ExtensionCommandContext, "stop", lastViewedRunId);
		},
	});

	pi.registerShortcut(PWR_SHORTCUTS.restart.key, {
		description: PWR_SHORTCUTS.restart.description,
		handler: async (ctx) => {
			if (!lastViewedRunId) {
				ctx.ui.notify("No PWR run viewed yet — open one with /workflows:open <runId> first.", "warning");
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
