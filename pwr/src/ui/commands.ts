/**
 * PWR UI - /workflows command parsing and control dispatch (JHL-15)
 *
 * Pure argument parsing + action dispatch. Every keyboard operation (keys
 * defined in keybindings.ts, the single source of truth) is ALSO reachable
 * as a command (PRD 4.3: 键盘和命令均须可达):
 *
 *   /workflows                     - run list
 *   /workflows <runId>             - run detail
 *   /workflows --filter <status>   - filtered list
 *   /workflows list [status]       - list (optionally filtered)
 *   /workflows view [runId]        - full-screen live viewer (JHL-18)
 *   /workflows open <runId>        - detail
 *   /workflows pause <runId>
 *   /workflows resume <runId>
 *   /workflows stop <runId> [taskId]
 *   /workflows restart <runId> <taskId>
 *   /workflows save <runId>
 *   /workflows saved               - saved workflow list
 *   /workflows script <runId>
 *   /workflows approve <runId>
 *   /workflows help
 *
 * Run ids may be full UUIDs or 8-char prefixes. Control calls go through the
 * JHL-16 `controlWorkflow` flow so error contracts stay consistent; the
 * returned `{ run }` view is merged into the store (PRD 6.2).
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { controlWorkflow, startWorkflow, type FlowDeps } from "../flow.ts";
import { isPwrError } from "../save.ts";
import { confirmApprovalCard, formatPlanText } from "../tools.ts";
import type { RunStatus } from "../types.ts";
import type { PwrErrorResult } from "../types.ts";
import type { MemoryRunStore } from "./run-store.ts";
import { PWR_SHORTCUTS } from "./keybindings.ts";

export const WORKFLOWS_COMMAND = "workflows";

export type WorkflowsParse =
	| { kind: "help" }
	| { kind: "list"; status?: RunStatus }
	| { kind: "detail"; runId: string };

const VALID_RUN_STATUSES = new Set<RunStatus>([
	"draft",
	"awaiting_approval",
	"queued",
	"running",
	"paused",
	"completed",
	"failed",
	"cancelled",
]);

/** Parse the free-form args of the `/workflows` command (PRD 6.2). */
export function parseWorkflowsArgs(args: string): WorkflowsParse {
	const tokens = args.trim().split(/\s+/).filter(Boolean);
	if (tokens.length === 0) return { kind: "list" };
	const [first, ...rest] = tokens;
	if (first === "help" || first === "--help" || first === "-h") return { kind: "help" };
	if (first === "--filter" || first === "-f") {
		const status = rest[0];
		if (status && VALID_RUN_STATUSES.has(status as RunStatus)) {
			return { kind: "list", status: status as RunStatus };
		}
		return { kind: "list" };
	}
	if (first.startsWith("--")) return { kind: "help" };
	return { kind: "detail", runId: first };
}

/** Routed shape of the unified `/workflows` sub-command surface（命令风格统一）. */
export type WorkflowsCommand =
	| { kind: "help" }
	| { kind: "list"; status?: string }
	| { kind: "detail"; runId: string }
	| { kind: "view"; runId?: string }
	| { kind: "open"; runId: string }
	| { kind: "pause"; runId: string }
	| { kind: "resume"; runId: string }
	| { kind: "stop"; runId: string; agentId?: string }
	| { kind: "restart"; runId: string; agentId: string }
	| { kind: "save"; runId: string }
	| { kind: "saved" }
	| { kind: "script"; runId: string }
	| { kind: "approve"; runId: string }
	| { kind: "usage"; text: string };

/**
 * Parses the single `/workflows` command into a sub-command action. The
 * former `/workflows:<name>` commands each map to one branch; the legacy
 * free-form `/workflows [<runId> | --filter <status>]` forms are kept as the
 * fall-through (a run id never collides with a sub-command word).
 */
export function parseWorkflowsCommand(args: string): WorkflowsCommand {
	const tokens = args.trim().split(/\s+/).filter(Boolean);
	if (tokens.length === 0) return { kind: "list" };
	const [head, ...rest] = tokens;
	const ref = rest[0] ?? "";
	switch (head) {
		case "list":
			return ref ? { kind: "list", status: ref } : { kind: "list" };
		case "view":
			return ref ? { kind: "view", runId: ref } : { kind: "view" };
		case "open":
			return ref ? { kind: "open", runId: ref } : { kind: "usage", text: "Usage: /workflows open <runId>" };
		case "pause":
		case "resume": {
			const parsed = parseControlArgs(head, ref);
			return parsed.ok ? { kind: head, runId: parsed.runId } : { kind: "usage", text: parsed.usage };
		}
		case "stop": {
			const parsed = parseControlArgs("stop", rest.join(" "));
			return parsed.ok
				? { kind: "stop", runId: parsed.runId, agentId: parsed.agentId }
				: { kind: "usage", text: parsed.usage };
		}
		case "restart": {
			const parsed = parseControlArgs("restart_agent", rest.join(" "));
			return parsed.ok && parsed.agentId
				? { kind: "restart", runId: parsed.runId, agentId: parsed.agentId }
				: { kind: "usage", text: parsed.ok ? "Usage: /workflows restart <runId> <taskId>" : parsed.usage };
		}
		case "save":
			return ref ? { kind: "save", runId: ref } : { kind: "usage", text: "Usage: /workflows save <runId>" };
		case "saved":
			return { kind: "saved" };
		case "script":
			return ref ? { kind: "script", runId: ref } : { kind: "usage", text: "Usage: /workflows script <runId>" };
		case "approve":
			return ref ? { kind: "approve", runId: ref } : { kind: "usage", text: "Usage: /workflows approve <runId>" };
		case "help":
		case "--help":
		case "-h":
			return { kind: "help" };
	}
	return parseWorkflowsArgs(args);
}

/** Parse a single-action sub-command invocation. */
export function parseControlArgs(
	action: "pause" | "resume" | "stop" | "restart_agent",
	args: string,
): { ok: true; runId: string; agentId?: string } | { ok: false; usage: string } {
	const tokens = args.trim().split(/\s+/).filter(Boolean);
	const usage: Record<string, string> = {
		pause: "Usage: /workflows pause <runId>",
		resume: "Usage: /workflows resume <runId>",
		stop: "Usage: /workflows stop <runId> [taskId]",
		restart_agent: "Usage: /workflows restart <runId> <taskId>",
	};
	if (tokens.length === 0) return { ok: false, usage: usage[action] };
	if (action === "restart_agent" && !tokens[1]) return { ok: false, usage: usage[action] };
	return { ok: true, runId: tokens[0], agentId: tokens[1] };
}

/** Resolve a full run id from a UUID or its 8-char prefix. */
export function resolveRunId(store: Pick<MemoryRunStore, "listRuns">, ref: string): string | undefined {
	const runs = store.listRuns();
	const exact = runs.find((r) => r.runId === ref);
	if (exact) return exact.runId;
	const short = ref.toLowerCase();
	const matches = runs.filter((r) => r.runId.toLowerCase().startsWith(short));
	if (matches.length === 1) return matches[0].runId;
	return undefined;
}

/**
 * Default run for /workflows view with no argument: the most recent
 * non-terminal run, else the most recent run overall (JHL-18).
 */
export function latestRunId(store: Pick<MemoryRunStore, "listRuns">): string | undefined {
	const runs = store.listRuns(); // newest first (createdAt desc)
	const active = runs.find((r) => r.status !== "completed" && r.status !== "failed" && r.status !== "cancelled");
	return active?.runId ?? runs[0]?.runId;
}

export type ControlOutcome =
	| { ok: true; text: string; runId: string; agentId?: string }
	| { ok: false; text: string; runId?: string };

/**
 * Execute a control action through the JHL-16 flow and refresh the store
 * with the returned `{ run }` view. UI feedback stays < 500ms: the store
 * read is synchronous and only the control call itself awaits the runtime.
 */
export async function runControlAction(
	deps: FlowDeps,
	store: MemoryRunStore,
	action: "pause" | "resume" | "stop" | "restart_agent",
	ref: string,
	agentId?: string,
): Promise<ControlOutcome> {
	const runId = resolveRunId(store, ref);
	if (!runId) {
		return { ok: false, text: `Error: run "${ref}" not found (RUN_NOT_FOUND).` };
	}
	if (action === "restart_agent" && !agentId) {
		return { ok: false, text: "Error: restart_agent requires a taskId.", runId };
	}
	const result = await controlWorkflow(deps, { runId, action, agentId });
	if (isError(result)) {
		return { ok: false, text: errorText(result), runId };
	}
	store.applyControlView(runId, result.run);
	const label = action === "restart_agent" ? `restart_agent ${agentId}` : action;
	return { ok: true, text: `${label} ok (run ${runId.slice(0, 8)})`, runId, agentId };
}

function isError(r: unknown): r is PwrErrorResult {
	return typeof r === "object" && r !== null && "code" in r && "message" in r;
}

/**
 * /workflows approve — manual approval path for runs parked in
 * awaiting_approval (e.g. the validate-time card was dismissed). Shows the
 * approval card unless a remembered or once approval already covers the
 * run, then starts it. Mirrors invokeSavedWorkflow's approval sequence.
 */
export async function runApproveAction(
	deps: FlowDeps,
	store: MemoryRunStore,
	ref: string,
	ctx: ExtensionContext,
): Promise<ControlOutcome> {
	const runId = resolveRunId(store, ref);
	if (!runId) return { ok: false, text: `Error: run "${ref}" not found (RUN_NOT_FOUND).` };
	const run = deps.registry.getRun(runId);
	const script = deps.registry.getScript(runId);
	if (!run || !script) return { ok: false, text: "Error: run not found in the session registry.", runId };
	if (run.status !== "awaiting_approval") {
		return { ok: false, text: `Error: run is ${run.status}; only awaiting_approval runs can be approved.`, runId };
	}
	const projectPath = deps.getProjectPath();
	const remembered = deps.approvals.get(projectPath, script.digest);
	if (!(remembered && remembered.digest === script.digest) && !deps.registry.isOnceApproved(runId)) {
		const decision = await confirmApprovalCard(ctx, {
			runId,
			scriptName: script.meta.name ?? "untitled",
			digest: script.digest,
			planText: formatPlanText(script.source),
			scriptSource: script.source,
		});
		if (decision === null) return { ok: false, text: "Approval pending — run not started.", runId };
		if (decision === "reject") {
			deps.registry.setStatus(runId, "cancelled");
			return { ok: false, text: "Workflow start rejected by user.", runId };
		}
		if (decision === "remember") deps.approvals.remember(projectPath, script.digest, new Date().toISOString());
		else deps.registry.markOnceApproved(runId);
	}
	const result = await startWorkflow(deps, { runId, approval: "once" }); // passes for once AND remembered
	if (isPwrError(result)) return { ok: false, text: errorText(result), runId };
	return { ok: true, text: `approved: workflow started (run ${runId.slice(0, 8)})`, runId };
}

function errorText(result: PwrErrorResult): string {
	const parts = [`Error ${result.code}: ${result.message}`];
	if (result.runId) parts.push(`(run: ${result.runId.slice(0, 8)})`);
	return parts.join(" ");
}

export function workflowsHelpText(): string {
	return [
		"PWR /workflows commands:",
		"  /workflow <task>               generate a workflow script (approve, then run)",
		"  /workflow run <name> [args]    run a saved workflow (key=value or JSON args)",
		"  /workflow delete [name]        delete a saved workflow (no name = list them)",
		"  /workflow model [auto|<model-id>]  set workflow default model (no args = show)",
		"  /workflows                     run list",
		"  /workflows <runId>             run detail",
		"  /workflows --filter <status>   filtered list (draft|awaiting_approval|queued|running|paused|completed|failed|cancelled)",
		"  /workflows list [status]       list (optionally filtered)",
		"  /workflows view [runId]        full-screen live viewer (structure diagram + per-stage pages)",
		"  /workflows open <runId>        detail view",
		"  /workflows pause <runId>       pause run",
		"  /workflows resume <runId>      resume run",
		"  /workflows stop <runId> [taskId]  stop run (or one agent)",
		"  /workflows restart <runId> <taskId>  restart agent (completed cache unchanged)",
		"  /workflows save <runId>        save as command",
		"  /workflows saved               list saved workflows (scope, description, args hint)",
		"  /workflows script <runId>      view raw script (read-only)",
		"  /workflows approve <runId>     approve a run waiting for approval",
		"  /workflows help                this help",
		"注：`/workflow run <name>` 与“任务文本恰好以 run <已保存名> 开头”存在歧义；要生成脚本请用 `workflow:` 输入前缀。",
		"Keys (operate on the last viewed run):",
		`  ${Object.values(PWR_SHORTCUTS)
			.map((s) => `${s.key} ${s.action}`)
			.join(" · ")}`,
	].join("\n");
}
