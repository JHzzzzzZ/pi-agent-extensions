/**
 * PWR script engine error model.
 *
 * Every failure surfaced by the validator / interpreter carries a stable
 * error code (PRD 6.2) and, whenever possible, a position in the *original*
 * script source so the caller can highlight the offending location.
 */

export const ErrorCodes = {
	/** The script uses syntax that is outside the PWR ECMAScript subset, or references a forbidden API / global. */
	SCRIPT_FORBIDDEN_SYNTAX: "SCRIPT_FORBIDDEN_SYNTAX",
	/** The script references an identifier that is neither declared nor whitelisted. */
	SCRIPT_UNKNOWN_API: "SCRIPT_UNKNOWN_API",
	/** A runtime failure while interpreting the script. */
	SCRIPT_RUNTIME_ERROR: "SCRIPT_RUNTIME_ERROR",
	/** Loop iteration budget exceeded (infinite-loop guard). */
	SCRIPT_LOOP_LIMIT_EXCEEDED: "SCRIPT_LOOP_LIMIT_EXCEEDED",
	/** The run-level hard cap on agent() invocations was reached. */
	AGENT_LIMIT_EXCEEDED: "AGENT_LIMIT_EXCEEDED",
	/** No agent runner is available to the interpreter. */
	AGENT_RUNNER_UNAVAILABLE: "AGENT_RUNNER_UNAVAILABLE",
	/** Execution was cancelled via the run's AbortSignal. */
	SCRIPT_ABORTED: "SCRIPT_ABORTED",
} as const;

export type ScriptErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];

export interface ScriptPosition {
	/** 1-based line. */
	line: number;
	/** 0-based column. */
	column: number;
	/** 0-based offset into the source string. */
	offset: number;
}

export interface ScriptEndPosition {
	line: number;
	column: number;
	offset: number;
}

export interface ScriptDiagnostic {
	code: ScriptErrorCode;
	message: string;
	start?: ScriptPosition;
	end?: ScriptEndPosition;
}

export class ScriptError extends Error {
	override readonly name = "ScriptError" as const;
	readonly code: ScriptErrorCode;
	readonly start?: ScriptPosition;
	readonly end?: ScriptEndPosition;
	override readonly cause?: unknown;

	constructor(
		code: ScriptErrorCode,
		message: string,
		start?: ScriptPosition,
		end?: ScriptEndPosition,
		cause?: unknown,
	) {
		super(message);
		this.code = code;
		this.start = start;
		this.end = end;
		this.cause = cause;
	}

	toDiagnostic(): ScriptDiagnostic {
		return {
			code: this.code,
			message: this.message,
			start: this.start,
			end: this.end,
		};
	}
}

/** Render a ScriptError as a compact single-line string (safe for logs / user messages). */
export function formatScriptError(error: ScriptError): string {
	const at = error.start ? ` at ${error.start.line}:${error.start.column + 1}` : "";
	return `${error.code}${at}: ${error.message}`;
}

/** Internal control-flow signals used by the interpreter. Not user-facing. */
export class BreakSignal {
	readonly label: string | undefined;
	constructor(label: string | undefined) {
		this.label = label;
	}
}

export class ContinueSignal {
	readonly label: string | undefined;
	constructor(label: string | undefined) {
		this.label = label;
	}
}

export class ReturnSignal {
	readonly value: unknown;
	constructor(value: unknown) {
		this.value = value;
	}
}
