/**
 * PWR runtime — run state machine (PRD 5.3)
 *
 * Every transition is validated against the legal table below; any state
 * change MUST be persisted by the caller (the runtime persists on every
 * transition). Allowed operations per state mirror PRD §5.3.
 */

import { RuntimeError } from "./errors.ts";
import type { RunStatus } from "./types.ts";

/**
 * Legal transitions. `queued` and `running` share one PRD row; `paused`
 * resumes through `queued` so the run re-enters the FIFO scheduler.
 */
export const TRANSITIONS: Record<RunStatus, readonly RunStatus[]> = {
	draft: ["awaiting_approval", "cancelled"],
	awaiting_approval: ["queued", "cancelled"],
	queued: ["running", "paused", "cancelled", "failed"],
	running: ["paused", "completed", "failed", "cancelled"],
	paused: ["queued", "cancelled", "failed"],
	// "再次运行" / "从脚本重新运行" (PRD §5.3) re-enters the FIFO queue.
	completed: ["queued"],
	failed: ["queued"],
	cancelled: ["queued"],
};

/** Operations allowed in each state (PRD §5.3 table). */
export const ALLOWED_OPERATIONS: Record<RunStatus, readonly string[]> = {
	draft: ["view", "discard"],
	awaiting_approval: ["run_once", "remember_and_run", "view", "reject"],
	queued: ["view", "pause", "stop", "restart_agent"],
	running: ["view", "pause", "stop", "restart_agent"],
	paused: ["resume", "stop"],
	completed: ["view", "save", "run_again"],
	failed: ["view", "run_again"],
	cancelled: ["view", "run_again"],
};

export function canTransition(from: RunStatus, to: RunStatus): boolean {
	return TRANSITIONS[from].includes(to);
}

/**
 * Throws ILLEGAL_STATE_TRANSITION when `from -> to` is not legal. Error
 * messages are static templates and never embed run internals.
 */
export function assertTransition(from: RunStatus, to: RunStatus): void {
	if (canTransition(from, to)) return;
	throw new RuntimeError("ILLEGAL_STATE_TRANSITION", undefined, `(${from} -> ${to})`);
}

/** True when the state is terminal (no further execution can happen). */
export function isTerminal(status: RunStatus): boolean {
	return status === "completed" || status === "failed" || status === "cancelled";
}
