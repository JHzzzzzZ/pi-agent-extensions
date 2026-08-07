/**
 * PWR - command/tool flow logic (JHL-16 goals 1-4)
 *
 * Pure flow functions behind the Pi tool definitions: workflow_validate,
 * workflow_start, workflow_control, workflow_save. Each returns either a
 * success payload or a PwrErrorResult ({ code, message, runId?, stageId?,
 * taskId? }) that never leaks source content, file contents or secrets.
 */

import { ApprovalStore } from "./approval.ts";
import { computeDigest } from "./digest.ts";
import { ErrorCode, PwrError } from "./errors.ts";
import { extractPlan } from "./plan.ts";
import {
	AGENT_LIMIT,
	CONCURRENCY_MAX,
	type ApprovalRecord,
	type BudgetEstimate,
	type PwrErrorResult,
	type RuntimeAdapter,
	type ScriptEngine,
	type WorkflowMeta,
	type WorkflowPlan,
	type WorkflowRun,
	type WorkflowRunView,
	type WorkflowScript,
} from "./types.ts";
import type { RunNotifier } from "./notify.ts";

export interface FlowDeps {
	/** JHL-12-backed engine; null means validation cannot run (ENGINE_UNAVAILABLE). */
	engine: ScriptEngine | null;
	approvals: ApprovalStore;
	registry: RunRegistry;
	getProjectPath(): string;
	runtime?: RuntimeAdapter | null;
	notifier?: RunNotifier;
	now?(): string | Date;
}

function toIso(value: string | Date | undefined): string {
	return value instanceof Date ? value.toISOString() : (value ?? new Date()).toString();
}

/** In-memory run registry; persistence of metadata is the caller's job. */
export class RunRegistry {
	private runs = new Map<string, WorkflowRun>();
	private scripts = new Map<string, WorkflowScript>();
	private plans = new Map<string, WorkflowPlan>();
	private onceApproved = new Set<string>();

	create(source: string, meta: WorkflowMeta, plan: WorkflowPlan, now: string, astVersion = "1", args?: unknown): WorkflowRun {
		const digest = computeDigest(source);
		const runId = crypto.randomUUID();
		const run: WorkflowRun = {
			runId,
			scriptId: digest,
			digest,
			status: "awaiting_approval",
			args,
			createdAt: now,
		};
		this.runs.set(runId, run);
		this.scripts.set(runId, { scriptId: digest, digest, source, meta, astVersion });
		this.plans.set(runId, plan);
		return run;
	}

	getRun(runId: string): WorkflowRun | undefined {
		return this.runs.get(runId);
	}

	getScript(runId: string): WorkflowScript | undefined {
		return this.scripts.get(runId);
	}

	getPlan(runId: string): WorkflowPlan | undefined {
		return this.plans.get(runId);
	}

	setStatus(runId: string, status: WorkflowRun["status"], startedAt?: string): void {
		const run = this.runs.get(runId);
		if (!run) return;
		run.status = status;
		if (startedAt) run.startedAt = startedAt;
	}

	markOnceApproved(runId: string): void {
		this.onceApproved.add(runId);
	}

	isOnceApproved(runId: string): boolean {
		return this.onceApproved.has(runId);
	}
}

export type ValidateSuccess = {
	script: { scriptId: string; digest: string; meta: WorkflowMeta; astVersion: string };
	plan: WorkflowPlan;
	budgetEstimate: BudgetEstimate;
	runId: string;
};

export async function validateWorkflow(
	deps: FlowDeps,
	input: { source: string; argsSchema?: unknown },
): Promise<ValidateSuccess | PwrErrorResult> {
	const source = input?.source;
	if (typeof source !== "string" || source.trim().length === 0) {
		return new PwrError(ErrorCode.SCRIPT_GENERATION_INVALID).toResult();
	}

	// The JHL-12 engine is the only acceptable validator: when it is not
	// resolved we fail with ENGINE_UNAVAILABLE instead of approving scripts
	// with the weaker structural gate.
	if (!deps.engine) {
		return new PwrError(ErrorCode.ENGINE_UNAVAILABLE).toResult();
	}

	let result;
	try {
		result = await deps.engine.validate(source);
	} catch {
		return new PwrError(ErrorCode.ENGINE_UNAVAILABLE).toResult();
	}

	if (!result.ok) {
		const first = result.errors[0];
		return new PwrError(
			first?.code === ErrorCode.SCRIPT_FORBIDDEN_SYNTAX || first?.code === ErrorCode.SCRIPT_UNKNOWN_API
				? first.code
				: ErrorCode.SCRIPT_GENERATION_INVALID,
			undefined,
			first?.line !== undefined ? `(line ${first.line}${first.column !== undefined ? `, col ${first.column}` : ""})` : undefined,
		).toResult();
	}

	// Plan extraction reads the validated AST (real call nodes only), and the
	// budget estimate is RAW (unclamped) so the hard cap is enforced on the
	// true call count.
	const plan = extractPlan(source);
	if (plan.budget.estimatedAgents > AGENT_LIMIT) {
		return new PwrError(ErrorCode.BUDGET_EXCEEDED).toResult();
	}

	// PRD §5.5 args source-of-truth rule: a script-declared `meta.argsSchema`
	// (engine-validated) is AUTHORITATIVE for argument validation — it must
	// survive validate -> save so /workflow:<name> rejects violating args.
	// The tool's `argsSchema` parameter is a fallback used only when the
	// script declares none; a script-declared schema is never silently
	// dropped or overridden.
	const meta: WorkflowMeta = {
		name: result.meta?.name ?? "untitled",
		description: result.meta?.description,
		version: result.meta?.version,
	};
	if (result.meta?.argsSchema !== undefined) {
		meta.argsSchema = result.meta.argsSchema;
	} else if (input.argsSchema !== undefined) {
		meta.argsSchema = input.argsSchema;
	}
	const run = deps.registry.create(source, meta, plan, toIso(deps.now?.()), result.astVersion);

	return {
		script: { scriptId: run.scriptId, digest: run.digest, meta, astVersion: result.astVersion },
		plan,
		budgetEstimate: plan.budget,
		runId: run.runId,
	};
}

export type StartSuccess = { runId: string; status: "running" };

export async function startWorkflow(
	deps: FlowDeps,
	input: { runId: string; approval: "once" | "remember" },
): Promise<StartSuccess | PwrErrorResult> {
	const { runId, approval } = input ?? {};
	if (!runId) return new PwrError(ErrorCode.RUN_NOT_FOUND).toResult();

	const run = deps.registry.getRun(runId);
	if (!run) return new PwrError(ErrorCode.RUN_NOT_FOUND).toResult();
	if (run.status !== "awaiting_approval") {
		return new PwrError(ErrorCode.RUN_NOT_CONTROLLABLE, { runId }).toResult();
	}

	const script = deps.registry.getScript(runId);
	if (!script) return new PwrError(ErrorCode.RUN_NOT_FOUND, { runId }).toResult();

	const projectPath = deps.getProjectPath();
	const remembered = deps.approvals.get(projectPath, script.digest);

	const isStale = (): boolean => {
		try {
			deps.approvals.assertFresh(projectPath, script.digest);
			return false;
		} catch {
			return true;
		}
	};

	if (approval === "remember") {
		if (remembered && remembered.digest === script.digest) {
			// valid remembered approval
		} else if (isStale()) {
			return new PwrError(ErrorCode.APPROVAL_STALE, { runId }).toResult();
		} else {
			return new PwrError(ErrorCode.APPROVAL_REQUIRED, { runId }).toResult();
		}
	} else if (approval === "once") {
		const onceOk = deps.registry.isOnceApproved(runId);
		if (onceOk || (remembered && remembered.digest === script.digest)) {
			// user granted once at the card, or a remembered approval covers it
		} else if (isStale()) {
			return new PwrError(ErrorCode.APPROVAL_STALE, { runId }).toResult();
		} else {
			return new PwrError(ErrorCode.APPROVAL_REQUIRED, { runId }).toResult();
		}
	} else {
		return new PwrError(ErrorCode.APPROVAL_REQUIRED, { runId }).toResult();
	}

	if (!deps.runtime) {
		deps.registry.setStatus(runId, "failed");
		return new PwrError(ErrorCode.AGENT_RUNNER_UNAVAILABLE, { runId }).toResult();
	}

	try {
		const started = await deps.runtime.start({
			runId,
			script,
			// JHL-17: structured args (schema-validated at /workflow:<name>)
			// reach the interpreter's `args` global through the run.
			args: run.args,
			// JHL-13 contract: the runtime calls this exactly once, with the
			// run's final summary after ITS OWN final agent settles. The
			// notifier queues it and delivers it when the same run settles
			// (runId-scoped — never on arbitrary agent_settled).
			onFinalResult: (summary: string) => {
				deps.notifier?.queue(runId, script.meta.name, summary);
			},
		});
		deps.registry.setStatus(runId, "running", toIso(deps.now?.()));
		return { runId: started.runId, status: "running" };
	} catch {
		deps.registry.setStatus(runId, "failed");
		return new PwrError(ErrorCode.AGENT_RUNNER_UNAVAILABLE, { runId }).toResult();
	}
}

export type ControlSuccess = { runId: string; run: WorkflowRunView };

export async function controlWorkflow(
	deps: FlowDeps,
	input: { runId: string; action: "pause" | "resume" | "stop" | "restart_agent"; agentId?: string },
): Promise<ControlSuccess | PwrErrorResult> {
	const { runId, action } = input ?? {};
	if (!runId || !action) return new PwrError(ErrorCode.RUN_NOT_FOUND).toResult();

	const run = deps.registry.getRun(runId);
	if (!run) return new PwrError(ErrorCode.RUN_NOT_FOUND).toResult();
	if (run.status !== "running" && run.status !== "paused" && run.status !== "queued") {
		return new PwrError(ErrorCode.RUN_NOT_CONTROLLABLE, { runId }).toResult();
	}
	if (!deps.runtime) {
		return new PwrError(ErrorCode.RUN_NOT_CONTROLLABLE, { runId }).toResult();
	}

	try {
		const result = await deps.runtime.control({ runId, action, agentId: input.agentId });
		// PRD §6.2: success returns { run } so the UI can refresh state.
		return { runId, run: result.run };
	} catch {
		return new PwrError(ErrorCode.RUN_NOT_CONTROLLABLE, { runId }).toResult();
	}
}

export interface SaveAdapter {
	save(input: { runId: string; scope: "user" | "project"; name: string; overwrite?: boolean }): Promise<{
		commandName: string;
		pathScope: "user" | "project";
	} | PwrErrorResult>;
}

export async function saveWorkflow(
	deps: FlowDeps & { saveAdapter?: SaveAdapter },
	input: { runId: string; scope: "user" | "project"; name: string; overwrite?: boolean },
): Promise<{ commandName: string; pathScope: "user" | "project" } | PwrErrorResult> {
	const { runId, scope, name } = input ?? {};
	if (!runId || !name || (scope !== "user" && scope !== "project")) {
		return new PwrError(ErrorCode.RUN_NOT_FOUND).toResult();
	}
	if (!deps.saveAdapter) {
		return new PwrError(ErrorCode.RUN_NOT_CONTROLLABLE, { runId }).toResult();
	}
	return deps.saveAdapter.save({ runId, scope, name, overwrite: input?.overwrite });
}

export function approvalRecords(approvals: ApprovalStore): ApprovalRecord[] {
	return approvals.toJSON();
}

export { AGENT_LIMIT, CONCURRENCY_MAX };
