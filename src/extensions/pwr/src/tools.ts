/**
 * PWR - Pi tool definitions (JHL-16 goals 1-4)
 *
 * Registers workflow_validate, workflow_start, workflow_control and
 * workflow_save against the Pi tool API. All failures surface as
 * { code, message, runId?, stageId?, taskId? } in `details` and never leak
 * source content or secrets.
 *
 * pi 1.0 tool face (pwr-todo#14): all four tools are `exposure: "model-only"`
 * — they orchestrate subprocesses, write files or raise the approval card, so
 * a codemode script must never reach them — grouped under the `pwr` namespace
 * and carrying MCP-style annotations. Query-shaped results carry
 * `outputSchema` + `structuredContent` (the stable contract for programmatic
 * callers); `details` stays internal to rendering and state rebuilding.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import {
	controlWorkflow,
	queryWorkflowRun,
	queryWorkflowRuns,
	saveWorkflow,
	startWorkflow,
	validateWorkflow,
	type FlowDeps,
	type RunListResult,
	type RunQueryRow,
	type RunStatusResult,
} from "./flow.ts";
import type { SaveAdapter } from "./flow.ts";
import { extractPlan } from "./plan.ts";
import { RUN_STATUS_VALUES, type PwrErrorResult } from "./types.ts";

export interface ToolDeps extends FlowDeps {
	saveAdapter?: SaveAdapter;
	/** JHL-17: user-scope workflows directory (defaults to ~/.pi/agent/workflows). */
	getUserWorkflowsDir?: () => string;
	/** JHL-17: project trust flag (session-scoped; save/load gates). */
	isProjectTrusted?: () => boolean;
}

function isErrorResult<T>(r: T | PwrErrorResult): r is PwrErrorResult {
	return typeof r === "object" && r !== null && "code" in r && "message" in r;
}

function errorText(result: PwrErrorResult): string {
	const parts = [`Error ${result.code}: ${result.message}`];
	if (result.runId) parts.push(`(run: ${result.runId.slice(0, 8)})`);
	return parts.join(" ");
}

/** pi 1.0 namespace：4 个工具同组（codemode 分组 + describeNamespace）。 */
const PWR_NAMESPACE = { name: "pwr", description: "Pi Workflow Runtime 工作流编排" };

/**
 * 查询口径的稳定契约（pwr-todo#14）。字段集刻意小于 `details`：`details` 继续
 * 承担渲染/状态重建，结构化结果只给程序化调用方一个不随内部形状漂移的接口。
 */
const RUN_STATUS_FIELD = StringEnum(RUN_STATUS_VALUES, { description: "Run status" });

const VALIDATE_OUTPUT = Type.Object({
	runId: Type.String(),
	digest: Type.String(),
	scriptName: Type.String(),
	stages: Type.Array(
		Type.Object({
			label: Type.String(),
			agentCount: Type.Number(),
			dynamic: Type.Boolean({ description: "Fan-out size is computed at runtime" }),
		}),
	),
	estimatedAgents: Type.Number(),
	writeRisk: Type.Boolean(),
	warnLargeRun: Type.Boolean(),
});

const START_OUTPUT = Type.Object({ runId: Type.String(), status: RUN_STATUS_FIELD });

const CONTROL_RUN_ROW = Type.Object({
	runId: Type.String(),
	status: RUN_STATUS_FIELD,
	stage: Type.String({ description: "Most recently entered stage label; empty when the run entered none yet" }),
	startedAt: Type.String({ description: "ISO start time; empty when the run has not started" }),
	finishedAt: Type.Optional(Type.String({ description: "ISO end time; omitted while the run is not finished" })),
});

const CONTROL_OUTPUT = Type.Union([
	Type.Object({ runs: Type.Array(CONTROL_RUN_ROW) }),
	Type.Object({ runId: Type.String(), ok: Type.Boolean(), status: RUN_STATUS_FIELD }),
]);

const SAVE_OUTPUT = Type.Object({ commandName: Type.String(), scope: StringEnum(["user", "project"] as const) });

/** list 动作的模型可读文本：保留完整 runId，后续 status/控制动作都要用它。 */
function runListText(runs: RunQueryRow[]): string {
	if (runs.length === 0) return "No workflow runs in this session.";
	const lines = [`Workflow runs (${runs.length}):`];
	for (const run of runs) {
		const stage = run.stage ? ` stage ${run.stage}` : "";
		const started = run.startedAt ? ` started ${run.startedAt}` : "";
		const finished = run.finishedAt ? ` finished ${run.finishedAt}` : "";
		lines.push(`- ${run.runId}  ${run.status}${stage}${started}${finished}`);
	}
	return lines.join("\n");
}

export function registerPwrTools(pi: ExtensionAPI, deps: ToolDeps): void {
	pi.registerTool({
		name: "workflow_validate",
		label: "Workflow Validate",
		description: [
			"Validate a PWR workflow script, extract its stage plan and budget, and create a draft run.",
			"Call this with the complete script source after generating a workflow. Returns the plan, budget estimate, script digest and runId.",
		].join(" "),
		exposure: "model-only",
		namespace: PWR_NAMESPACE,
		annotations: { readOnlyHint: true },
		parameters: Type.Object({
			source: Type.String({ description: "Complete PWR JavaScript script source" }),
			argsSchema: Type.Optional(Type.Any({ description: "Optional JSON schema describing workflow arguments" })),
		}),
		outputSchema: VALIDATE_OUTPUT,
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const result = await validateWorkflow(deps, { source: params.source, argsSchema: params.argsSchema });
			if (isErrorResult(result)) {
				return { content: [{ type: "text", text: errorText(result) }], details: result, isError: true };
			}
			const planText = result.plan.stages.map((s) => `- ${s.label} (${s.agentCount} agent(s)${s.dynamic ? " · 动态" : ""})`).join("\n");
			const warning = result.budgetEstimate.warnLargeRun ? "\n⚠️ Large run: consider a smaller scope." : "";
			return {
				content: [
					{
						type: "text",
						text: `Workflow validated (digest ${result.script.digest.slice(0, 12)})\nPlan:\n${planText}\nBudget: ${result.budgetEstimate.estimatedAgents} agents (write risk: ${result.budgetEstimate.writeRisk ? "yes" : "no"})${warning}\nrunId: ${result.runId}`,
					},
				],
				details: result,
				structuredContent: {
					runId: result.runId,
					digest: result.script.digest,
					scriptName: result.script.meta.name,
					stages: result.plan.stages.map((s) => ({ label: s.label, agentCount: s.agentCount, dynamic: s.dynamic === true })),
					estimatedAgents: result.budgetEstimate.estimatedAgents,
					writeRisk: result.budgetEstimate.writeRisk,
					warnLargeRun: result.budgetEstimate.warnLargeRun,
				},
			};
		},
	});

	pi.registerTool({
		name: "workflow_start",
		label: "Workflow Start",
		description: [
			"Start an approved PWR workflow run.",
			"approval: 'once' starts only this run; 'remember' approves this script for the current project and digest (future identical scripts skip approval).",
			"A changed script digest invalidates remembered approval (APPROVAL_STALE).",
		].join(" "),
		exposure: "model-only",
		namespace: PWR_NAMESPACE,
		annotations: { destructiveHint: true, openWorldHint: true },
		parameters: Type.Object({
			runId: Type.String({ description: "Run id returned by workflow_validate" }),
			approval: StringEnum(["once", "remember"] as const, {
				description: "'once' = approve this run only; 'remember' = approve for project + digest",
				default: "once",
			}),
		}),
		outputSchema: START_OUTPUT,
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const result = await startWorkflow(deps, { runId: params.runId, approval: params.approval });
			if (isErrorResult(result)) {
				return { content: [{ type: "text", text: errorText(result) }], details: result, isError: true };
			}
			return {
				content: [{ type: "text", text: `Workflow started (run ${result.runId.slice(0, 8)})` }],
				details: result,
				structuredContent: { runId: result.runId, status: result.status },
			};
		},
	});

	pi.registerTool({
		name: "workflow_control",
		label: "Workflow Control",
		description: [
			"Query or control PWR workflow runs.",
			"'list' returns this session's runs (runId/status/stage/startedAt/finishedAt); 'status' returns one run's current status.",
			"'pause'/'resume'/'stop' act on a run; 'restart_agent' re-runs a single agent task (agentId required).",
		].join(" "),
		exposure: "model-only",
		namespace: PWR_NAMESPACE,
		annotations: { destructiveHint: true },
		parameters: Type.Object({
			action: StringEnum(["list", "status", "pause", "resume", "stop", "restart_agent"] as const, {
				description: "'list' = this session's runs; 'status' = one run's status; other actions control a run",
			}),
			runId: Type.Optional(Type.String({ description: "Run id (required for every action except 'list')" })),
			agentId: Type.Optional(Type.String({ description: "Agent task id (required for restart_agent)" })),
		}),
		outputSchema: CONTROL_OUTPUT,
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			if (params.action === "list") {
				const payload: RunListResult = { runs: queryWorkflowRuns(deps).runs };
				return { content: [{ type: "text", text: runListText(payload.runs) }], details: payload, structuredContent: payload };
			}
			if (params.action === "status") {
				const result = queryWorkflowRun(deps, { runId: params.runId ?? "" });
				if (isErrorResult(result)) {
					return { content: [{ type: "text", text: errorText(result) }], details: result, isError: true };
				}
				const payload: RunStatusResult = { runId: result.runId, ok: true, status: result.status };
				return {
					content: [{ type: "text", text: `Run ${result.runId.slice(0, 8)} status: ${result.status}` }],
					details: payload,
					structuredContent: payload,
				};
			}
			const result = await controlWorkflow(deps, { runId: params.runId ?? "", action: params.action, agentId: params.agentId });
			if (isErrorResult(result)) {
				return { content: [{ type: "text", text: errorText(result) }], details: result, isError: true };
			}
			const payload: RunStatusResult = { runId: result.runId, ok: true, status: result.run.status };
			return {
				content: [{ type: "text", text: `${params.action} ok (run ${result.runId.slice(0, 8)})` }],
				details: result,
				structuredContent: payload,
			};
		},
	});

	pi.registerTool({
		name: "workflow_save",
		label: "Workflow Save",
		description: [
			"Save a validated workflow as a reusable command (user or project scope).",
			"Auto-fills meta.name/description/version, validates, writes the script and registers the /workflow:run <name> entry.",
			"An existing same-name workflow returns NAME_CONFLICT; confirm with overwrite: true to replace it.",
		].join(" "),
		exposure: "model-only",
		namespace: PWR_NAMESPACE,
		annotations: { destructiveHint: true },
		parameters: Type.Object({
			runId: Type.String({ description: "Run id returned by workflow_validate" }),
			scope: StringEnum(["user", "project"] as const, { description: "'user' = all projects; 'project' = trusted project only" }),
			name: Type.String({ description: "Command name, e.g. 'audit-routes' (run it later via /workflow:run <name>)" }),
			overwrite: Type.Optional(Type.Boolean({ description: "Confirm replacing an existing workflow with the same name (NAME_CONFLICT resolution)" })),
		}),
		outputSchema: SAVE_OUTPUT,
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const result = await saveWorkflow(deps, { runId: params.runId, scope: params.scope, name: params.name, overwrite: params.overwrite });
			if (isErrorResult(result)) {
				return { content: [{ type: "text", text: errorText(result) }], details: result, isError: true };
			}
			return {
				content: [{ type: "text", text: `Saved as /workflow:run ${result.commandName} (${result.pathScope})` }],
				details: result,
				structuredContent: { commandName: result.commandName, scope: result.pathScope },
			};
		},
	});
}

/** Renders the approval card content as plain text (used by the UI entry point). */
export function formatPlanText(source: string): string {
	const plan = extractPlan(source);
	const lines = [`Stages (${plan.stages.length}):`];
	for (const stage of plan.stages) {
		lines.push(`  - ${stage.label} (${stage.agentCount} agent(s)${stage.dynamic ? " · 动态" : ""})${stage.writeRisk ? " [write]" : ""}`);
	}
	lines.push(`Budget: ~${plan.budget.estimatedAgents} agents`);
	if (plan.budget.writeRisk) lines.push("⚠️ Write tools will be available to some agents.");
	if (plan.budget.warnLargeRun) lines.push("⚠️ Large run warning (over 25 agents).");
	return lines.join("\n");
}

export interface ApprovalCardInfo {
	runId: string;
	scriptName: string;
	digest: string;
	planText: string;
	/** Raw script source shown read-only via View raw script. */
	scriptSource: string;
}

/** Max bytes of script source shown by "View raw script" (full source via /workflow:script). */
export const MAX_SCRIPT_PREVIEW_BYTES = 8 * 1024;

/** Byte-safe script preview: pass-through under the cap, truncated with a pointer otherwise. */
export function truncateScriptPreview(source: string): string {
	if (Buffer.byteLength(source, "utf8") <= MAX_SCRIPT_PREVIEW_BYTES) return source;
	let preview = source.slice(0, MAX_SCRIPT_PREVIEW_BYTES);
	while (Buffer.byteLength(preview, "utf8") > MAX_SCRIPT_PREVIEW_BYTES) preview = preview.slice(0, -1);
	return `${preview}\n\n[脚本过长：共 ${source.length} 字符，仅展示前 ${preview.length} 字符]`;
}

/** Pure card body: title, run id, digest, plan summary and choices as plain text. */
export function buildApprovalBody(info: ApprovalCardInfo): string {
	const lines: string[] = [];
	lines.push(`Approve workflow "${info.scriptName}"?`);
	lines.push(`run:   ${info.runId.slice(0, 8)}`);
	lines.push(`digest ${info.digest.slice(0, 12)}`);
	lines.push("");
	lines.push(info.planText);
	lines.push("");
	lines.push("Choices: Run once / Remember for this script / View raw script / Reject");
	return lines.join("\n");
}

/**
 * Interactive approval card. The plan-summary body is notified before every
 * prompt. Selecting "View raw script" shows the script read-only (truncated
 * over 8KB) and then returns to the SAME card, so the user always ends at
 * an explicit decision. Only "Reject" yields "reject"; dismissing the card
 * yields `null` (approval stays pending — never treated as a rejection).
 */
export async function confirmApprovalCard(
	ctx: ExtensionContext,
	info: ApprovalCardInfo,
): Promise<"once" | "remember" | "reject" | null> {
	if (!ctx.hasUI) return null;

	for (;;) {
		ctx.ui.notify(buildApprovalBody(info), "info");
		const choice = await ctx.ui.select(`Approve workflow "${info.scriptName}"?`, [
			"Run once",
			"Remember for this script",
			"View raw script",
			"Reject",
		]);
		if (!choice) return null; // card dismissed — approval still pending
		if (choice === "Run once") return "once";
		if (choice === "Remember for this script") return "remember";
		if (choice === "Reject") return "reject";
		if (choice === "View raw script") {
			// Read-only preview, then loop back to the same approval card.
			const body = truncateScriptPreview(info.scriptSource);
			ctx.ui.notify(
				`[PWR] Workflow script "${info.scriptName}" (read-only)\n\n${body}\n完整源码: /workflow:script ${info.runId.slice(0, 8)}`,
				"info",
			);
			continue;
		}
		// Unknown choice: re-show the card rather than guessing a decision.
	}
}
