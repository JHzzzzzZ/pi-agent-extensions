/**
 * PWR runtime — error contract (JHL-13 scope)
 *
 * Runtime failures surface as RuntimeError with static messages. Messages
 * never leak script source, file contents, credentials or subagent
 * internals (PRD 6.2).
 */

export type RuntimeErrorCode =
	| "AGENT_LIMIT_EXCEEDED"
	| "AGENT_RUNNER_UNAVAILABLE"
	| "AGENT_NOT_RESTARTABLE"
	| "RUN_NOT_FOUND"
	| "RUN_NOT_CONTROLLABLE"
	| "ILLEGAL_STATE_TRANSITION"
	| "SESSION_SHUTDOWN";

const MESSAGES: Record<RuntimeErrorCode, string> = {
	AGENT_LIMIT_EXCEEDED: "Workflow exceeds the maximum number of agents allowed per run.",
	AGENT_RUNNER_UNAVAILABLE: "Agent runner is unavailable; execution was not started.",
	AGENT_NOT_RESTARTABLE: "Agent task is not restartable in its current state.",
	RUN_NOT_FOUND: "Workflow run not found.",
	RUN_NOT_CONTROLLABLE: "Workflow run is not controllable in its current state.",
	ILLEGAL_STATE_TRANSITION: "Illegal workflow run state transition.",
	SESSION_SHUTDOWN: "Runtime has been shut down; no new runs can start.",
};

export class RuntimeError extends Error {
	readonly code: RuntimeErrorCode;
	readonly runId?: string;
	readonly taskId?: string;

	constructor(code: RuntimeErrorCode, context?: { runId?: string; taskId?: string }, detail?: string) {
		super(detail ? `${MESSAGES[code]} ${detail}` : MESSAGES[code]);
		this.name = "RuntimeError";
		this.code = code;
		this.runId = context?.runId;
		this.taskId = context?.taskId;
	}
}
