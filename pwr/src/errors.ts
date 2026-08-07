/**
 * PWR - error contract (PRD 6.2)
 *
 * All tool failures return { code, message, runId?, stageId?, taskId? }.
 * Messages are static templates - they must never leak source content,
 * file contents, credentials or subagent internals.
 */

import type { PwrErrorResult } from "./types.ts";

export const ErrorCode = {
	SCRIPT_GENERATION_INVALID: "SCRIPT_GENERATION_INVALID",
	SCRIPT_FORBIDDEN_SYNTAX: "SCRIPT_FORBIDDEN_SYNTAX",
	SCRIPT_UNKNOWN_API: "SCRIPT_UNKNOWN_API",
	APPROVAL_REQUIRED: "APPROVAL_REQUIRED",
	APPROVAL_STALE: "APPROVAL_STALE",
	BUDGET_EXCEEDED: "BUDGET_EXCEEDED",
	AGENT_LIMIT_EXCEEDED: "AGENT_LIMIT_EXCEEDED",
	RUN_NOT_FOUND: "RUN_NOT_FOUND",
	RUN_NOT_CONTROLLABLE: "RUN_NOT_CONTROLLABLE",
	AGENT_NOT_RESTARTABLE: "AGENT_NOT_RESTARTABLE",
	PROJECT_NOT_TRUSTED: "PROJECT_NOT_TRUSTED",
	NAME_CONFLICT: "NAME_CONFLICT",
	AGENT_RUNNER_UNAVAILABLE: "AGENT_RUNNER_UNAVAILABLE",
	WORKFLOW_ALREADY_EXISTS: "WORKFLOW_ALREADY_EXISTS",
	ENGINE_UNAVAILABLE: "ENGINE_UNAVAILABLE",
	ARGS_INVALID: "ARGS_INVALID",
	ARGS_SCHEMA_VIOLATION: "ARGS_SCHEMA_VIOLATION",
	WORKFLOW_NOT_FOUND: "WORKFLOW_NOT_FOUND",
	SAVE_IO_ERROR: "SAVE_IO_ERROR",
	DELETE_IO_ERROR: "DELETE_IO_ERROR",
} as const;

export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode];

const MESSAGES: Record<ErrorCodeValue, string> = {
	[ErrorCode.SCRIPT_GENERATION_INVALID]:
		"Generated script does not conform to the PWR schema (missing meta or top-level await).",
	[ErrorCode.SCRIPT_FORBIDDEN_SYNTAX]: "Script uses syntax or APIs forbidden by the PWR sandbox.",
	[ErrorCode.SCRIPT_UNKNOWN_API]: "Script calls an API that is not in the PWR whitelist.",
	[ErrorCode.APPROVAL_REQUIRED]: "Workflow requires approval before start.",
	[ErrorCode.APPROVAL_STALE]: "Script digest changed since approval; approval must be re-granted.",
	[ErrorCode.BUDGET_EXCEEDED]: "Workflow budget exceeds the allowed limit.",
	[ErrorCode.AGENT_LIMIT_EXCEEDED]: "Workflow exceeds the maximum number of agents allowed per run.",
	[ErrorCode.RUN_NOT_FOUND]: "Workflow run not found.",
	[ErrorCode.RUN_NOT_CONTROLLABLE]: "Workflow run is not controllable in its current state.",
	[ErrorCode.AGENT_NOT_RESTARTABLE]: "Agent task is not restartable in its current state.",
	[ErrorCode.PROJECT_NOT_TRUSTED]: "Project is not trusted for this operation.",
	[ErrorCode.NAME_CONFLICT]: "A workflow with this name already exists.",
	[ErrorCode.AGENT_RUNNER_UNAVAILABLE]: "Agent runner is unavailable; execution was not started.",
	[ErrorCode.WORKFLOW_ALREADY_EXISTS]: "A workflow with this name is already registered.",
	[ErrorCode.ENGINE_UNAVAILABLE]: "Script engine is unavailable; validation cannot run.",
	[ErrorCode.ARGS_INVALID]: "Workflow arguments are not valid structured input (expected JSON, e.g. {\"files\": [\"src/a.ts\"]}).",
	[ErrorCode.ARGS_SCHEMA_VIOLATION]: "Workflow arguments do not conform to the declared args schema.",
	[ErrorCode.WORKFLOW_NOT_FOUND]: "Saved workflow not found.",
	[ErrorCode.SAVE_IO_ERROR]: "Failed to write the saved workflow file.",
	[ErrorCode.DELETE_IO_ERROR]: "Failed to delete the saved workflow file.",
};

export interface ErrorContext {
	runId?: string;
	stageId?: string;
	taskId?: string;
}

/** Thrown by flow code, converted to PwrErrorResult at the tool boundary. */
export class PwrError extends Error {
	readonly code: ErrorCodeValue;
	readonly runId?: string;
	readonly stageId?: string;
	readonly taskId?: string;

	constructor(code: ErrorCodeValue, context?: ErrorContext, detail?: string) {
		const message = detail ? `${MESSAGES[code]} ${detail}` : MESSAGES[code];
		super(message);
		this.name = "PwrError";
		this.code = code;
		this.runId = context?.runId;
		this.stageId = context?.stageId;
		this.taskId = context?.taskId;
	}

	toResult(): PwrErrorResult {
		const result: PwrErrorResult = { code: this.code, message: this.message };
		if (this.runId) result.runId = this.runId;
		if (this.stageId) result.stageId = this.stageId;
		if (this.taskId) result.taskId = this.taskId;
		return result;
	}
}

export function errorResult(code: ErrorCodeValue, context?: ErrorContext): PwrErrorResult {
	return new PwrError(code, context).toResult();
}

/** Static message template for a code (single source of truth, no input echo). */
export function errorMessage(code: ErrorCodeValue): string {
	return MESSAGES[code];
}
