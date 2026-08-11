/**
 * PWR - Pi Workflow Runtime extension entry (JHL-16 trigger/generation/
 * approval + JHL-17 save/load & parameter commands)
 *
 * - `/workflow <task>` command + `workflow:` prefix (input event)
 * - Injects generation constraints into the main agent
 * - workflow_validate / workflow_start / workflow_control / workflow_save
 * - Start approval card (once / remember / view script / reject)
 * - `/workflow:<name> <args>` saved commands (registered on save + at
 *   session_start; args schema-validated; digest-gated re-approval)
 * - agent_settled -> final summary back to the main session
 *
 * Install location (when enabled): ~/.pi/agent/extensions/pwr/index.ts
 * or .pi/extensions/pwr/index.ts (trusted project).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ApprovalStore } from "./src/approval.ts";
import { canonicalProjectPath } from "./src/approval.ts";
import { buildGenerationRequest } from "./src/constraints.ts";
import { getValidationEngine } from "./src/engine.ts";
import { AUTO_MODEL, PwrModelConfig } from "./src/model-config.ts";
import { PWR_APPROVAL_ENTRY, PWR_GENERATION_CUSTOM_TYPE, PWR_RUN_ENTRY } from "./src/types.ts";
import { matchWorkflowPrefix, parseWorkflowCommandArgs, WORKFLOW_COMMAND, type GenerationRequest } from "./src/intent.ts";
import { RunNotifier } from "./src/notify.ts";
import { RunRegistry, type SaveAdapter } from "./src/flow.ts";
import { confirmApprovalCard, formatPlanText, registerPwrTools, type ApprovalCardInfo, type ToolDeps } from "./src/tools.ts";
import { createWorkflowsUi } from "./src/ui/index.ts";
import type { RunEntryData, UiRuntimeAdapter } from "./src/ui/types.ts";
import {
	defaultUserWorkflowsDir,
	deleteSavedWorkflow,
	invokeSavedWorkflow,
	isPwrError,
	listSavedWorkflows,
	saveWorkflowCommand,
	type ApprovalDecision,
} from "./src/save.ts";
import { resultPathForSummary } from "./runtime/persist.ts";
import type { RuntimeAdapter, WorkflowRun } from "./src/types.ts";
import type { RuntimeRunView } from "./runtime/types.ts";
import * as os from "node:os";
import * as path from "node:path";

async function resolveRuntime(): Promise<RuntimeAdapter | null> {
	try {
		// The runtime state machine + scheduler live in pwr/runtime/index.ts
		// (JHL-13), a SIBLING of this entry — `./runtime/index.ts` (relative
		// to the extension root), not `../runtime/index.ts` which would walk
		// outside pwr/ and degrade the runtime to AGENT_RUNNER_UNAVAILABLE.
		const runtimeModule = "./runtime/index.ts";
		const mod = (await import(runtimeModule)) as { default?: RuntimeAdapter; RuntimeAdapter?: RuntimeAdapter };
		return mod?.default ?? mod?.RuntimeAdapter ?? null;
	} catch {
		return null;
	}
}

/**
 * JHL-14: builds the PiAgentRunner adapter and injects it into the
 * runtime. When the adapter cannot be built (no pi command resolvable),
 * returns null — the runtime then keeps agent() at AGENT_RUNNER_UNAVAILABLE
 * and script validation/view/save stay fully functional (no fallback).
 *
 * Agent discovery scope follows the project trust decision (PRD §7): a
 * TRUSTED project contributes its own `.pi/agents` definitions alongside
 * user ones (`both`, user > project > builtin); an UNTRUSTED project only
 * sees user + builtin definitions (`user`), matching the JHL-17 project
 * workflow load gate.
 */
async function resolveAgentRunner(
	projectTrusted: boolean,
	defaultModel?: () => string | undefined,
): Promise<{ runner?: unknown; unavailable: boolean }> {
	try {
		const mod = await import("./runner/index.ts");
		const PiAgentRunner = (mod as { PiAgentRunner?: new (o?: unknown) => unknown }).PiAgentRunner;
		if (!PiAgentRunner) return { unavailable: true };
		const runner = new PiAgentRunner({ agentScope: projectTrusted ? "both" : "user", defaultModel });
		const available = typeof (runner as { isAvailable?: () => boolean }).isAvailable === "function"
			? (runner as { isAvailable(): boolean }).isAvailable()
			: true;
		return available ? { runner, unavailable: false } : { unavailable: true };
	} catch {
		return { unavailable: true };
	}
}

export default function pwrExtension(pi: ExtensionAPI): void {
	const approvals = new ApprovalStore();
	const registry = new RunRegistry();
	// Workflow default model: /pwr-model auto | <model-id>. Loaded at module
	// load so the runner gets the persisted value immediately; the live
	// main-session model id is tracked in session_start / model_select.
	const modelConfig = new PwrModelConfig();
	modelConfig.load();
	let generationRequest: GenerationRequest | null = null;
	let projectTrusted = false;
	// Approval cards shown at workflow_validate time (per run), so a later
	// workflow_start can await the same decision instead of showing a second
	// card. Dismissed cards are removed, allowing a re-ask.
	const approvalCards = new Map<string, Promise<"once" | "remember" | "reject" | null>>();

	const deps: ToolDeps = {
		engine: null, // set once the engine resolves (session_start)
		approvals,
		registry,
		getProjectPath: () => {
			const cwd = pi.getFlag("cwd");
			// PRD §5.5: approval keys use the canonical project path
			// (resolve + realpath + case normalization on win32).
			return canonicalProjectPath(typeof cwd === "string" ? cwd : process.cwd());
		},
		getUserWorkflowsDir: () => path.join(os.homedir(), ".pi", "agent", "workflows"),
		isProjectTrusted: () => projectTrusted,
		runtime: null,
		saveAdapter: null as never, // set below before tools are callable
	};

	// Over-8KB workflow results land in `<workflowsDir>/results/<runId>.json`
	// (sibling of the saved-script directory); the completion message and the
	// persisted entry carry the path.
	const resultsDir = (): string => path.join(deps.getUserWorkflowsDir?.() ?? defaultUserWorkflowsDir(), "results");

	// ----- saved-workflow command registry (JHL-17) -----
	// `workflow:<name>` commands are registered once per session (saved on
	// demand, scanned from disk at session_start). Handlers always read the
	// file fresh at invocation time, so an overwrite never needs to
	// re-register a command.
	const registeredCommands = new Set<string>();

	function registerSavedCommand(name: string): void {
		if (registeredCommands.has(name)) return;
		pi.registerCommand(`workflow:${name}`, {
			description: `Run the saved PWR workflow "${name}" (loaded from ~/.pi/agent/workflows or .pi/workflows).`,
			handler: async (args, ctx) => {
				const result = await invokeSavedWorkflow(deps, { name, rawArgs: args ?? "" }, (info) => approveSavedCommand(ctx, info));
				if (result && isPwrError(result)) {
					ctx.ui.notify(`[PWR] ${result.code}: ${result.message}`, "error");
					return;
				}
				if (result && result.ok) {
					ctx.ui.notify(`[PWR] ${result.message}`, "info");
				}
			},
		});
		registeredCommands.add(name);
	}

	/** Bridges the saved-command approval card to the same UI loop as workflow_start. */
	function approveSavedCommand(
		ctx: unknown,
		info: { runId: string; scriptName: string; digest: string; planText: string; scriptSource: string },
	): Promise<ApprovalDecision> {
		const c = ctx as { hasUI?: boolean; ui?: { select?: unknown; notify?: unknown } } | null | undefined;
		if (!c?.ui?.select || c.hasUI === false) return Promise.resolve(null);
		const cardInfo: ApprovalCardInfo = {
			runId: info.runId,
			scriptName: info.scriptName,
			digest: info.digest,
			planText: info.planText,
			scriptSource: info.scriptSource,
		};
		return confirmApprovalCard(c as never, cardInfo);
	}

	// ----- save adapter: persist + register (JHL-17) -----
	const saveAdapter: SaveAdapter = {
		async save(input) {
			const { runId, scope, name, overwrite } = input;
			const result = await saveWorkflowCommand(deps, { runId, scope, name, overwrite });
			if (!isPwrError(result)) {
				registerSavedCommand(result.commandName);
			}
			return result;
		},
	};
	deps.saveAdapter = saveAdapter;

	const notifier = new RunNotifier(
		(message, options) => pi.sendMessage(message, options),
		// No agent_settled flood hook here: final summaries are runId-scoped
		// and delivered through the runtime's per-run settle callback (JHL-13
		// wires `onRunSettled`, see session_start). A settle event for one run
		// must never flush another run's pending results.
		undefined,
		{ resultDir: resultsDir() },
	);
	deps.notifier = notifier;

	// ----- /pwr-model: workflow default model -----
	pi.registerCommand("pwr-model", {
		description: "Set the default model for PWR workflow agents: /pwr-model auto | <model-id> (no args shows current).",
		handler: async (args, ctx) => {
			const arg = (args ?? "").trim().split(/\s+/)[0] ?? "";
			if (!arg) {
				const s = modelConfig.describe();
				ctx.ui.notify(
					`[PWR] workflow model: ${s.mode === AUTO_MODEL ? "auto (follow main session)" : s.mode}` +
						` · main session: ${s.sessionModel ?? "unknown"}` +
						` · effective: ${s.effective ?? "child pi default (settings.json)"}`,
					"info",
				);
				return;
			}
			if (arg === AUTO_MODEL || arg === "--auto" || arg === "-a") {
				modelConfig.set(AUTO_MODEL);
				ctx.ui.notify("[PWR] workflow model = auto: agents follow the main session model.", "info");
				return;
			}
			modelConfig.set(arg);
			ctx.ui.notify(`[PWR] workflow model = ${arg} (fixed for all workflow agents).`, "info");
		},
	});

	// ----- /workflow-delete: remove a saved workflow -----
	// Project-scope file is deleted first (trusted projects only), then the
	// user-scope file — the same resolution order as loading. The previously
	// registered /workflow:<name> command stays until /reload and reports
	// WORKFLOW_NOT_FOUND on invocation (pi has no unregisterCommand API).
	pi.registerCommand("workflow-delete", {
		description: "Delete a saved PWR workflow: /workflow-delete <name> (project scope first, then user scope).",
		handler: async (args, ctx) => {
			const name = (args ?? "").trim().split(/\s+/)[0] ?? "";
			if (!name) {
				ctx.ui.notify("Usage: /workflow-delete <name>", "error");
				return;
			}
			const result = deleteSavedWorkflow(deps, name);
			if (isPwrError(result)) {
				ctx.ui.notify(`[PWR] ${result.code}: ${result.message}`, "error");
				return;
			}
			ctx.ui.notify(`[PWR] Deleted workflow "${name}" (${result.scope} scope).`, "info");
		},
	});

	// ----- track live model switches so `auto` mode follows the main session -----
	pi.on("model_select", (event) => {
		modelConfig.setSessionModel((event as { model?: { id?: string } }).model?.id);
	});

	// ----- trigger: /workflow command -----
	pi.registerCommand(WORKFLOW_COMMAND, {
		description: "Run a task as a PWR workflow: the agent generates a script, you approve, PWR runs it.",
		handler: async (args, ctx) => {
			const request = parseWorkflowCommandArgs(args ?? "");
			if (!request) {
				ctx.ui.notify("Usage: /workflow <task description>", "error");
				return;
			}
			generationRequest = request;
			ctx.ui.notify("Generating workflow script...", "info");
			pi.sendMessage(
				{
					customType: PWR_GENERATION_CUSTOM_TYPE,
					content: buildGenerationRequest(request.task, request.argsSchema),
					display: false,
				},
				{ triggerTurn: true, deliverAs: "followUp" },
			);
		},
	});

	// ----- trigger: workflow: prefix (input event) -----
	pi.on("input", async (event) => {
		if (event.source === "extension") return { action: "continue" };
		const request = matchWorkflowPrefix(event.text);
		if (!request) return { action: "continue" };

		generationRequest = request;
		// Transform the input into the bare task; before_agent_start injects
		// the full generation constraints.
		return { action: "transform", text: request.task };
	});

	// ----- inject generation constraints into the main agent's next turn -----
	pi.on("before_agent_start", async () => {
		if (!generationRequest) return;
		const request = generationRequest;
		generationRequest = null;
		return {
			message: {
				customType: PWR_GENERATION_CUSTOM_TYPE,
				content: buildGenerationRequest(request.task, request.argsSchema),
				display: false,
			},
		};
	});

	// ----- session lifecycle: hydrate approvals, resolve engine/runtime -----
	pi.on("session_start", async (_event, ctx) => {
		const runEntries: RunEntryData[] = [];
		for (const entry of ctx.sessionManager.getEntries()) {
			const e = entry as { type: string; customType?: string; data?: unknown };
			if (e.type === "custom" && e.customType === PWR_APPROVAL_ENTRY) {
				approvals.hydrate(Array.isArray(e.data) ? (e.data as Parameters<ApprovalStore["hydrate"]>[0]) : []);
			}
			if (e.type === "custom" && e.customType === PWR_RUN_ENTRY) {
				const data = e.data as Partial<RunEntryData> | undefined;
				if (data && typeof data.runId === "string") runEntries.push(data as RunEntryData);
			}
		}
		ui.hydrateEntries(runEntries);
		projectTrusted = ctx.isProjectTrusted();
		// Track the current main-session model so `auto` mode follows it.
		modelConfig.setSessionModel((ctx as { model?: { id?: string } | null }).model?.id);
		deps.runtime = await resolveRuntime();
		deps.engine = await getValidationEngine();
		// JHL-14: inject the PiAgentRunner adapter (subagent child-pi mode).
		// If it is unavailable, setRunner() is skipped and the runtime keeps
		// returning AGENT_RUNNER_UNAVAILABLE — never an implicit fallback to
		// the main agent, while validation/view/save remain functional.
		// Discovery scope: "both" for trusted projects, "user" otherwise.
		// The default model resolver is evaluated per agent launch, so the
		// workflow model follows live model switches in the main session.
		const runnerResult = await resolveAgentRunner(projectTrusted, () => modelConfig.effectiveModel());
		if (
			runnerResult.runner &&
			typeof (deps.runtime as { setRunner?: (r: unknown) => void } | null)?.setRunner === "function"
		) {
			(deps.runtime as unknown as { setRunner(r: unknown): void }).setRunner(runnerResult.runner);
		}
		// JHL-13 contract: per-run settle events gate final-summary delivery.
		// handler(runId) fires when THAT run's final agent settles.
		deps.runtime?.onRunSettled?.((runId) => {
			// 失败 run 没有 final summary；用已记录的失败详情唤起主 agent
			// （cancelled 是用户主动中断，不唤起）。
			const view = (deps.runtime as { view?(id: string): RuntimeRunView } | null)?.view?.(runId);
			if (view && view.status === "failed") {
				notifier.queueFailure(runId, view.scriptName, view.errorCode, view.errorMessage);
			}
			void notifier.settle(runId);
		});
		// JHL-13/JHL-15 contract: the runtime pushes RunEvents to the
		// /workflows UI store; refresh the widget/status line once bound.
		ui.bindRuntime(deps.runtime as UiRuntimeAdapter | null);
		// 运行时状态桥：每次 run_status 变迁把富条目（含任务错误）写盘。
		(deps.runtime as { onEvent?(h: (ev: { type: string; runId: string }) => void): void } | null)?.onEvent?.((ev) => {
			if (ev.type === "run_status") persistRunFromRuntime(ev.runId);
		});
		ui.refresh(ctx);
		// JHL-17: register saved /workflow:<name> commands from disk so they
		// survive restarts. Project-scope scripts are only registered in
		// trusted projects.
		for (const name of listSavedWorkflows(deps)) {
			registerSavedCommand(name);
		}
	});

	// ----- approval records persisted as metadata-only session entries -----
	function persistApprovals(): void {
		pi.appendEntry(PWR_APPROVAL_ENTRY, approvals.toJSON());
	}
	const originalRemember = approvals.remember.bind(approvals);
	approvals.remember = (projectPath, digest, decidedAt) => {
		originalRemember(projectPath, digest, decidedAt);
		persistApprovals();
	};

	// ----- /workflows observation & control UI (JHL-15) -----
	const ui = createWorkflowsUi(pi, deps, () => deps.runtime as UiRuntimeAdapter | null);

	// ----- run metadata trail (never the script source) -----
	function persistRun(run: WorkflowRun): void {
		pi.appendEntry(PWR_RUN_ENTRY, {
			runId: run.runId,
			scriptId: run.scriptId,
			digest: run.digest,
			status: run.status,
			createdAt: run.createdAt,
		});
	}

	/**
	 * 运行时状态桥：runtime 每次 run_status 变迁把富条目（含任务错误）
	 * 写盘，使重启后 /workflows 仍能显示失败详情。只落白名单字段；
	 * 持久化失败绝不破坏会话。
	 */
	function persistRunFromRuntime(runId: string): void {
		try {
			const rt = deps.runtime as { view?(id: string): RuntimeRunView } | null;
			const view = rt?.view?.(runId);
			if (!view) return;
			pi.appendEntry(PWR_RUN_ENTRY, {
				runId: view.runId,
				scriptId: view.scriptId,
				digest: view.digest,
				status: view.status,
				createdAt: view.createdAt,
				startedAt: view.startedAt,
				endedAt: view.endedAt,
				summary: view.summary,
				resultPath: resultPathForSummary(view.summary, resultsDir(), view.runId),
				errorCode: view.errorCode,
				errorMessage: view.errorMessage,
				tasks: view.tasks.map((t) => ({
					taskId: t.taskId,
					stageId: t.stageId,
					label: t.label,
					status: t.status,
					attempt: t.attempt,
					errorCode: t.errorCode,
					errorMessage: t.errorMessage,
					summary: t.summary,
				})),
			});
		} catch {
			// 持久化失败绝不破坏会话。
		}
	}
	const originalCreate = registry.create.bind(registry);
	registry.create = (source, meta, plan, now, astVersion, args) => {
		const run = originalCreate(source, meta, plan, now, astVersion, args);
		persistRun(run);
		const script = registry.getScript(run.runId);
		const runPlan = registry.getPlan(run.runId);
		if (script && runPlan) ui.onRunCreated(run, script, runPlan);
		return run;
	};
	const originalSetStatus = registry.setStatus.bind(registry);
	registry.setStatus = (runId, status, startedAt) => {
		originalSetStatus(runId, status, startedAt);
		const run = registry.getRun(runId);
		if (run) persistRun(run);
		ui.onRunStatusChanged(runId, status, startedAt);
	};

	// ----- approval card integration point (UI hook; card rendered by JHL-15) -----
	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "workflow_start") return;
		const params = event.input as { runId?: string; approval?: string };
		if (!params?.runId || !ctx.hasUI) return;

		const run = registry.getRun(params.runId);
		const script = registry.getScript(params.runId);
		if (!run || !script) return;

		const projectPath = deps.getProjectPath();
		// Skip the card when approval is already satisfied (this also covers
		// decisions recorded by the workflow_validate card below).
		if (approvals.get(projectPath, script.digest)) return;
		if (params.approval === "remember" || registry.isOnceApproved(params.runId)) return;

		// The validate-time card is still pending (user has not decided yet):
		// await the SAME decision instead of showing a second card.
		const pending = approvalCards.get(params.runId);
		if (pending) {
			const decision = await pending;
			if (decision === "reject") {
				registry.setStatus(params.runId, "cancelled");
				return { block: true, reason: "Workflow start rejected by user." };
			}
			if (decision === null) {
				approvalCards.delete(params.runId);
				return { block: true, reason: "Approval pending — workflow start was not approved." };
			}
			return; // once/remember already recorded by the validate card
		}

		const decision = await confirmApprovalCard(ctx, {
			runId: run.runId,
			scriptName: script.meta.name ?? "untitled",
			digest: script.digest,
			planText: formatPlanText(script.source),
			scriptSource: script.source,
		});

		// PRD §4.2: only an explicit Reject cancels the run. Dismissing the
		// card leaves the run awaiting_approval (never a rejection).
		if (decision === "reject") {
			registry.setStatus(run.runId, "cancelled");
			return { block: true, reason: "Workflow start rejected by user." };
		}
		if (decision === null) {
			return { block: true, reason: "Approval pending — workflow start was not approved." };
		}
		if (decision === "once") {
			registry.markOnceApproved(run.runId);
			event.input = { ...params, approval: "once" };
		}
		if (decision === "remember") {
			approvals.remember(projectPath, script.digest, new Date().toISOString());
			event.input = { ...params, approval: "remember" };
		}
	});

	// ----- approval card on workflow_validate success -----
	// The card fires as soon as validation succeeds (PRD §4.2), so the
	// approval window appears even if the agent never calls workflow_start.
	// Decisions are recorded here and re-used by the workflow_start hook.
	pi.on("tool_result", async (event, ctx) => {
		if (event.toolName !== "workflow_validate") return;
		if (event.isError) return;
		const details = event.details as { runId?: string } | null | undefined;
		const runId = details?.runId;
		if (!runId || !ctx.hasUI) return;

		const run = registry.getRun(runId);
		const script = registry.getScript(runId);
		if (!run || !script) return;

		const projectPath = deps.getProjectPath();
		if (approvals.get(projectPath, script.digest)) return; // remembered approval covers it
		if (approvalCards.has(runId)) return; // card already showing

		const card = confirmApprovalCard(ctx, {
			runId,
			scriptName: script.meta.name ?? "untitled",
			digest: script.digest,
			planText: formatPlanText(script.source),
			scriptSource: script.source,
		});
		approvalCards.set(runId, card);
		const decision = await card;
		if (decision === "reject") registry.setStatus(runId, "cancelled");
		else if (decision === "remember") approvals.remember(projectPath, script.digest, new Date().toISOString());
		else if (decision === "once") registry.markOnceApproved(runId);
		else approvalCards.delete(runId); // dismissed → allow re-ask
	});

	// ----- tools (registered once at load; deps resolved at session_start) -----
	registerPwrTools(pi, deps);
}
