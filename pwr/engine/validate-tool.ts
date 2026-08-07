/**
 * `workflow_validate` tool contract (PRD §6.2).
 *
 * Params:   { source, argsSchema? }
 * Success:  { script, plan, budgetEstimate }
 * Failure:  { code, message, line?, column?, errors? }
 *
 * This module is free of Pi-host imports (typebox / @earendil-works), so the
 * contract is unit-testable without the Pi runtime; `index.ts` wires it into
 * the extension entry point.
 */

import { ErrorCodes, ScriptError, type ScriptDiagnostic } from "./errors.ts";
import { isPlainObject, snapshotPlain } from "./plain.ts";
import { validateScript, type PlanItem, type WorkflowMeta } from "./validator.ts";

export interface WorkflowValidateParams {
	source: string;
	argsSchema?: unknown;
}

export interface WorkflowValidateSuccess {
	valid: true;
	script: {
		source: string;
		meta?: WorkflowMeta;
		argsSchema?: unknown;
	};
	plan: PlanItem[];
	budgetEstimate: {
		agentCalls: number;
		stages: number;
	};
}

export interface WorkflowValidateFailure {
	valid: false;
	code: string;
	message: string;
	line: number | null;
	column: number | null;
	errors: ScriptDiagnostic[];
}

export type WorkflowValidateOutcome = WorkflowValidateSuccess | WorkflowValidateFailure;

/**
 * Validate a PWR workflow script without executing it.
 *
 * `argsSchema` (optional) is the JSON Schema that constrains the `args`
 * global when the workflow is later invoked via `/workflow:<name>`; it must
 * itself be plain JSON data. On success the structured result follows the
 * PRD §6.2 contract: `{ script, plan, budgetEstimate }`.
 */
export function runWorkflowValidate(params: WorkflowValidateParams): WorkflowValidateOutcome {
	if (typeof params.source !== "string") {
		return failure(
			ErrorCodes.SCRIPT_FORBIDDEN_SYNTAX,
			"source 必须是字符串（PWR 工作流脚本源码）",
			null,
			null,
			[],
		);
	}

	let argsSchema: unknown;
	if (params.argsSchema !== undefined) {
		if (!isPlainObject(params.argsSchema)) {
			return failure(
				ErrorCodes.SCRIPT_FORBIDDEN_SYNTAX,
				"argsSchema 必须是纯 JSON 对象（JSON Schema）",
				null,
				null,
				[],
			);
		}
		try {
			// Single-pass snapshot: the host-provided schema is validated and
			// deep-copied in one traversal (no validate-then-re-read window).
			argsSchema = snapshotPlain(params.argsSchema);
		} catch (err) {
			if (err instanceof ScriptError) {
				return failure(
					ErrorCodes.SCRIPT_FORBIDDEN_SYNTAX,
					`argsSchema 非法：${err.message}`,
					null,
					null,
					[err.toDiagnostic()],
				);
			}
			return failure(
				ErrorCodes.SCRIPT_FORBIDDEN_SYNTAX,
				`argsSchema 非法：${String(err)}`,
				null,
				null,
				[],
			);
		}
	}

	const result = validateScript(params.source);
	if (!result.ok) {
		const first = result.errors[0];
		return failure(
			first?.code ?? ErrorCodes.SCRIPT_FORBIDDEN_SYNTAX,
			first?.message ?? "validation failed",
			first?.start?.line ?? null,
			first?.start?.column ?? null,
			result.errors,
		);
	}

	const plan = result.plan ?? [];
	const script: WorkflowValidateSuccess["script"] = { source: params.source };
	if (result.meta !== undefined) script.meta = result.meta;
	if (argsSchema !== undefined) script.argsSchema = argsSchema;
	return {
		valid: true,
		script,
		plan,
		budgetEstimate: {
			agentCalls: plan.filter((p) => p.type === "agent").length,
			stages: plan.length,
		},
	};
}

function failure(
	code: string,
	message: string,
	line: number | null,
	column: number | null,
	errors: ScriptDiagnostic[],
): WorkflowValidateFailure {
	return { valid: false, code, message, line, column, errors };
}
