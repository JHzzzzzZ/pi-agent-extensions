/**
 * PWR - Pi tool definitions (JHL-16 goals 1-4)
 *
 * Registers workflow_validate, workflow_start, workflow_control and
 * workflow_save against the Pi tool API. All failures surface as
 * { code, message, runId?, stageId?, taskId? } in `details` and never leak
 * source content or secrets.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { controlWorkflow, saveWorkflow, startWorkflow, validateWorkflow, type FlowDeps } from "./flow.ts";
import type { SaveAdapter } from "./flow.ts";
import { extractPlan } from "./plan.ts";
import type { PwrErrorResult } from "./types.ts";

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

export function registerPwrTools(pi: ExtensionAPI, deps: ToolDeps): void {
	pi.registerTool({
		name: "workflow_validate",
		label: "Workflow Validate",
		description: [
			"Validate a PWR workflow script, extract its stage plan and budget, and create a draft run.",
			"Call this with the complete script source after generating a workflow. Returns the plan, budget estimate, script digest and runId.",
		].join(" "),
		parameters: Type.Object({
			source: Type.String({ description: "Complete PWR JavaScript script source" }),
			argsSchema: Type.Optional(Type.Any({ description: "Optional JSON schema describing workflow arguments" })),
		}),
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
		parameters: Type.Object({
			runId: Type.String({ description: "Run id returned by workflow_validate" }),
			approval: StringEnum(["once", "remember"] as const, {
				description: "'once' = approve this run only; 'remember' = approve for project + digest",
				default: "once",
			}),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const result = await startWorkflow(deps, { runId: params.runId, approval: params.approval });
			if (isErrorResult(result)) {
				return { content: [{ type: "text", text: errorText(result) }], details: result, isError: true };
			}
			return {
				content: [{ type: "text", text: `Workflow started (run ${result.runId.slice(0, 8)})` }],
				details: result,
			};
		},
	});

	pi.registerTool({
		name: "workflow_control",
		label: "Workflow Control",
		description: "Pause, resume, stop a workflow run or restart a single agent task.",
		parameters: Type.Object({
			runId: Type.String({ description: "Run id" }),
			action: StringEnum(["pause", "resume", "stop", "restart_agent"] as const),
			agentId: Type.Optional(Type.String({ description: "Agent task id (required for restart_agent)" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const result = await controlWorkflow(deps, { runId: params.runId, action: params.action, agentId: params.agentId });
			if (isErrorResult(result)) {
				return { content: [{ type: "text", text: errorText(result) }], details: result, isError: true };
			}
			return {
				content: [{ type: "text", text: `${params.action} ok (run ${params.runId.slice(0, 8)})` }],
				details: result,
			};
		},
	});

	pi.registerTool({
		name: "workflow_save",
		label: "Workflow Save",
		description: [
			"Save a validated workflow as a reusable command (user or project scope).",
			"Auto-fills meta.name/description/version, validates, writes the script and registers /workflow:<name>.",
			"An existing same-name workflow returns NAME_CONFLICT; confirm with overwrite: true to replace it.",
		].join(" "),
		parameters: Type.Object({
			runId: Type.String({ description: "Run id returned by workflow_validate" }),
			scope: StringEnum(["user", "project"] as const, { description: "'user' = all projects; 'project' = trusted project only" }),
			name: Type.String({ description: "Command name, e.g. 'audit-routes' (registers /workflow:audit-routes)" }),
			overwrite: Type.Optional(Type.Boolean({ description: "Confirm replacing an existing workflow with the same name (NAME_CONFLICT resolution)" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const result = await saveWorkflow(deps, { runId: params.runId, scope: params.scope, name: params.name, overwrite: params.overwrite });
			if (isErrorResult(result)) {
				return { content: [{ type: "text", text: errorText(result) }], details: result, isError: true };
			}
			return {
				content: [{ type: "text", text: `Saved as /workflow:${result.commandName} (${result.pathScope})` }],
				details: result,
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

/** Max bytes of script source shown by "View raw script" (full source via /workflows:script). */
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
				`[PWR] Workflow script "${info.scriptName}" (read-only)\n\n${body}\n完整源码: /workflows:script ${info.runId.slice(0, 8)}`,
				"info",
			);
			continue;
		}
		// Unknown choice: re-show the card rather than guessing a decision.
	}
}
