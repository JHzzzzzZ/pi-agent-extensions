/**
 * PWR - workflow intent recognition
 *
 * Triggers: `/workflow <task>` (extension command) and `workflow: <task>`
 * prefix (input event). Both produce a generation request that is injected
 * into the main agent.
 */

export const WORKFLOW_COMMAND = "workflow";
export const WORKFLOW_PREFIX = "workflow:";

export interface GenerationRequest {
	task: string;
	requestedAt: string;
	argsSchema?: unknown;
}

/** Parses the argument text of the /workflow command. Empty args are invalid. */
export function parseWorkflowCommandArgs(raw: string): GenerationRequest | null {
	const task = (raw ?? "").trim();
	if (!task) return null;
	return { task, requestedAt: new Date().toISOString() };
}

/** Detects the `workflow:` prefix in raw user input (before skill/template expansion). */
export function matchWorkflowPrefix(text: string): GenerationRequest | null {
	const trimmed = (text ?? "").trim();
	const lower = trimmed.toLowerCase();
	if (!lower.startsWith(WORKFLOW_PREFIX)) return null;

	const task = trimmed.slice(WORKFLOW_PREFIX.length).trim();
	if (!task) return null;
	return { task, requestedAt: new Date().toISOString() };
}
