/**
 * PWR PiAgentRunner — error model (JHL-14)
 *
 * Stable codes surfaced through the runtime as task error codes
 * (PRD 6.2 error shapes). `AGENT_RUNNER_UNAVAILABLE` matches the engine's
 * existing code so the degradation path stays consistent.
 */

export const RunnerErrorCodes = {
	/** The requested agent id is not among the discovered definitions; failed BEFORE any process starts. */
	UNKNOWN_AGENT: "UNKNOWN_AGENT",
	/** The adapter could not start (no pi command / spawn failure); execution must not fall back to the main agent. */
	AGENT_RUNNER_UNAVAILABLE: "AGENT_RUNNER_UNAVAILABLE",
	/** The child pi process failed (non-zero exit, LLM error, or no usable output). */
	AGENT_EXECUTION_ERROR: "AGENT_EXECUTION_ERROR",
	/** A structured (schema) result exceeded the result byte budget and was rejected. */
	RESULT_TOO_LARGE: "RESULT_TOO_LARGE",
	/** The run was aborted via the AbortSignal. */
	AGENT_ABORTED: "AGENT_ABORTED",
} as const;

export type RunnerErrorCode = (typeof RunnerErrorCodes)[keyof typeof RunnerErrorCodes];

export class RunnerError extends Error {
	override readonly name = "RunnerError" as const;
	readonly code: RunnerErrorCode;

	constructor(code: RunnerErrorCode, message: string) {
		super(message);
		this.code = code;
	}
}
