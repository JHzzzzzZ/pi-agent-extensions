/**
 * PWR - workflow intent recognition
 *
 * Triggers: `/workflow <task>` (extension command) and `workflow: <task>`
 * prefix (input event). Both produce a generation request that is injected
 * into the main agent. The `/workflow` command also routes the sub-commands
 * `run` / `delete` / `model` (命令风格统一).
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

/** Parsed shape of the `/workflow` command arguments (sub-command router). */
export type WorkflowCommandRoute =
	| { kind: "generate"; task: string }
	| { kind: "run"; name: string; rawArgs: string }
	| { kind: "delete"; name: string }
	| { kind: "model"; arg: string };

/**
 * Routes `/workflow` args: `run <name> [args]` (only when the name is a saved
 * workflow), `delete <name>`, `model [auto|<id>]`; anything else — including
 * a `run` head naming nothing saved — stays a generation task with the whole
 * input as the task. The 歧义 edge (a task literally starting with "run <已保存名>")
 * is documented in the help text: use the `workflow:` input prefix instead.
 */
export function parseWorkflowCommandRoute(
	raw: string,
	hasSavedWorkflow: (name: string) => boolean = () => false,
): WorkflowCommandRoute {
	const trimmed = (raw ?? "").trim();
	const spaceIndex = trimmed.indexOf(" ");
	const head = spaceIndex === -1 ? trimmed : trimmed.slice(0, spaceIndex);
	const rest = spaceIndex === -1 ? "" : trimmed.slice(spaceIndex + 1).trim();
	if (head === "delete") return { kind: "delete", name: firstToken(rest) };
	if (head === "model") return { kind: "model", arg: firstToken(rest) };
	if (head === "run" && rest) {
		const name = firstToken(rest);
		if (hasSavedWorkflow(name)) {
			return { kind: "run", name, rawArgs: rest.slice(rest.indexOf(name) + name.length).trim() };
		}
	}
	return { kind: "generate", task: trimmed };
}

function firstToken(text: string): string {
	return text.split(/\s+/)[0] ?? "";
}
