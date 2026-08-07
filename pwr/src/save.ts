/**
 * PWR - save/load and parameter commands (JHL-17)
 *
 * PRD §5.5 / §9 subtask 6:
 *  - workflow_save persists a validated script as `~/.pi/agent/workflows/<name>.js`
 *    (user scope, all projects) or `<project>/.pi/workflows/<name>.js`
 *    (project scope, trusted projects only; project script shadows the
 *    same-name global script), auto-filling `meta.name/description/version`,
 *    re-validating the filled source, and registering `/workflow:<name>`.
 *  - `/workflow:<name> <args>` loads the script (project first), re-validates,
 *    converts args into a schema-validated structured `args` global and starts
 *    the run. Approval memory stays keyed on `canonical project path + digest`
 *    (JHL-16 ApprovalStore) so any script edit forces re-approval.
 *  - Duplicate saves require an explicit overwrite confirmation
 *    (NAME_CONFLICT -> save again with overwrite: true).
 *
 * This module is pure logic; the pi command registration and approval-card
 * UI live in index.ts (injected via the `register`/`approve` callbacks).
 */

import { ApprovalStore, canonicalProjectPath } from "./approval.ts";
import { parseCommandArgs, validateArgsAgainstSchema, type ArgsResult } from "./args.ts";
import { computeDigest } from "./digest.ts";
import { ErrorCode, PwrError } from "./errors.ts";
import { RunRegistry, startWorkflow } from "./flow.ts";
import { extractPlan } from "./plan.ts";
import { parseScript } from "../engine/parser.ts";
import type { PwrErrorResult, RuntimeAdapter, ScriptEngine, WorkflowMeta, WorkflowPlan } from "./types.ts";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** Default user-scope save directory (PRD §5.5: `~/.pi/agent/workflows/`). */
export function defaultUserWorkflowsDir(): string {
	return path.join(os.homedir(), ".pi", "agent", "workflows");
}

/** Project-scope save directory for a project path. */
export function projectWorkflowsDir(projectPath: string): string {
	return path.join(projectPath, ".pi", "workflows");
}

/** Command-name pattern: lowercase letters, digits and dashes. */
const NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

/** Dependencies the save/load logic needs (a subset of ToolDeps). */
export interface SaveLibDeps {
	engine: ScriptEngine | null;
	approvals: ApprovalStore;
	registry: RunRegistry;
	getProjectPath(): string;
	/** Injectable for tests; defaults to `~/.pi/agent/workflows`. */
	getUserWorkflowsDir?(): string;
	/** Injectable for tests; defaults to "trusted". */
	isProjectTrusted?(): boolean;
	runtime?: RuntimeAdapter | null;
	now?(): string | Date;
}

export function normalizeCommandName(raw: string): string {
	return (raw ?? "").trim().toLowerCase();
}

export function isValidCommandName(name: string): boolean {
	return NAME_PATTERN.test(name);
}

function toIso(value: string | Date | undefined): string {
	return value instanceof Date ? value.toISOString() : (value ?? new Date()).toString();
}

export function isPwrError<T>(result: T | PwrErrorResult): result is PwrErrorResult {
	return typeof result === "object" && result !== null && "code" in result && "message" in result;
}

/**
 * Auto-fills meta (PRD §5.5): keeps present values, fills missing
 * name/description/version so every saved script carries a complete header.
 * The engine adapter's placeholder name "untitled" (mapped for scripts whose
 * meta declares no name) counts as missing so the command name wins.
 * `argsSchema` is preserved when the script declares one.
 */
export function fillMeta(meta: WorkflowMeta | undefined, commandName: string): WorkflowMeta {
	const declared = meta?.name?.trim();
	const name = declared && declared !== "untitled" ? declared : commandName;
	const description =
		meta?.description && meta.description.trim() ? meta.description.trim() : `PWR workflow "${commandName}" saved from a validated run.`;
	const out: WorkflowMeta = { name, description, version: meta?.version ?? 1 };
	if (meta?.argsSchema !== undefined) out.argsSchema = meta.argsSchema;
	return out;
}

interface MetaStatement {
	start: number;
	end: number;
}

/** Locates the `export const meta = {...}` statement span in validated source. */
export function findMetaStatement(source: string): MetaStatement | null {
	const ast = parseScript(source) as unknown as {
		body?: Array<{ type: string; declaration?: unknown }>;
	};
	for (const stmt of ast.body ?? []) {
		if (stmt.type !== "ExportNamedDeclaration") continue;
		const decl = stmt.declaration as
			| { type?: string; kind?: string; declarations?: Array<{ id?: { type?: string; name?: string }; init?: unknown }> }
			| null
			| undefined;
		if (!decl || decl.type !== "VariableDeclaration" || decl.kind !== "const") continue;
		const declarators = decl.declarations ?? [];
		if (declarators.length !== 1) continue;
		const id = declarators[0]?.id;
		if (id?.type === "Identifier" && id.name === "meta") {
			const stmtNode = stmt as unknown as { start?: number; end?: number };
			if (typeof stmtNode.start === "number" && typeof stmtNode.end === "number") {
				return { start: stmtNode.start, end: stmtNode.end };
			}
		}
	}
	return null;
}

/**
 * Rewrites the script's meta block to `export const meta = {...}` with the
 * filled values. When the script has no meta export at all, one is prepended
 * (still within the engine's "only meta export" rule).
 */
export function withFilledMeta(source: string, meta: WorkflowMeta): string {
	const block = `export const meta = ${JSON.stringify(meta)};`;
	const span = findMetaStatement(source);
	if (!span) return `${block}\n\n${source}`;
	return source.slice(0, span.start) + block + source.slice(span.end);
}

export interface SavedWorkflowFile {
	source: string;
	scope: "user" | "project";
	filePath: string;
	digest: string;
}

export interface SaveSuccess {
	commandName: string;
	pathScope: "user" | "project";
	filePath: string;
	digest: string;
}

/**
 * Saves a validated run's script as a reusable `/workflow:<name>` command.
 * - auto-fills meta and RE-validates the filled source (never saves a script
 *   the engine rejects; engine missing -> ENGINE_UNAVAILABLE);
 * - project scope requires a trusted project (PROJECT_NOT_TRUSTED, no write);
 * - an existing target file requires `overwrite: true` (NAME_CONFLICT).
 */
export async function saveWorkflowCommand(
	deps: SaveLibDeps,
	input: { runId: string; scope: "user" | "project"; name: string; overwrite?: boolean },
): Promise<SaveSuccess | PwrErrorResult> {
	const { runId, scope, name, overwrite } = input ?? {};
	if (!runId || !name || (scope !== "user" && scope !== "project")) {
		return new PwrError(ErrorCode.RUN_NOT_FOUND).toResult();
	}

	const run = deps.registry.getRun(runId);
	const script = deps.registry.getScript(runId);
	if (!run || !script) return new PwrError(ErrorCode.RUN_NOT_FOUND, { runId }).toResult();

	const commandName = normalizeCommandName(name);
	if (!isValidCommandName(commandName)) {
		return new PwrError(ErrorCode.SCRIPT_GENERATION_INVALID, { runId }, "(command name may only contain lowercase letters, digits and dashes)").toResult();
	}

	if (scope === "project" && deps.isProjectTrusted && !deps.isProjectTrusted()) {
		return new PwrError(ErrorCode.PROJECT_NOT_TRUSTED, { runId }).toResult();
	}

	const filled = fillMeta(script.meta, commandName);
	const source = withFilledMeta(script.source, filled);

	if (!deps.engine) {
		return new PwrError(ErrorCode.ENGINE_UNAVAILABLE, { runId }).toResult();
	}
	let validation;
	try {
		validation = await deps.engine.validate(source);
	} catch {
		return new PwrError(ErrorCode.ENGINE_UNAVAILABLE, { runId }).toResult();
	}
	if (!validation.ok) {
		return new PwrError(ErrorCode.SCRIPT_GENERATION_INVALID, { runId }, "(filled meta makes the script invalid)").toResult();
	}

	const workflowsDir =
		scope === "user"
			? deps.getUserWorkflowsDir?.() ?? defaultUserWorkflowsDir()
			: projectWorkflowsDir(deps.getProjectPath());
	const filePath = path.join(workflowsDir, `${commandName}.js`);
	if (fs.existsSync(filePath) && !overwrite) {
		return new PwrError(ErrorCode.NAME_CONFLICT, { runId }, `(a workflow named "${commandName}" already exists; pass overwrite: true to replace it)`).toResult();
	}
	try {
		fs.mkdirSync(workflowsDir, { recursive: true });
		fs.writeFileSync(filePath, source, "utf8");
	} catch {
		return new PwrError(ErrorCode.SAVE_IO_ERROR, { runId }).toResult();
	}
	return { commandName, pathScope: scope, filePath, digest: computeDigest(source) };
}

/**
 * Loads a saved workflow: the project-scope file (trusted projects only)
 * shadows the same-name user-scope file. Untrusted projects fall back to the
 * user scope instead of failing (the write path is the trust-gated one).
 */
export function loadSavedWorkflow(deps: SaveLibDeps, name: string): SavedWorkflowFile | PwrErrorResult {
	const commandName = normalizeCommandName(name);
	if (!isValidCommandName(commandName)) {
		return new PwrError(ErrorCode.WORKFLOW_NOT_FOUND).toResult();
	}

	const trustUnknown = !deps.isProjectTrusted || deps.isProjectTrusted();
	if (trustUnknown) {
		const projectPath = projectWorkflowsDir(deps.getProjectPath());
		const projectFile = path.join(projectPath, `${commandName}.js`);
		try {
			if (fs.existsSync(projectFile)) {
				const source = fs.readFileSync(projectFile, "utf8");
				return { source, scope: "project", filePath: projectFile, digest: computeDigest(source) };
			}
		} catch {
			// Unreadable project file: fall through to the user scope.
		}
	}

	const userDir = deps.getUserWorkflowsDir?.() ?? defaultUserWorkflowsDir();
	const userFile = path.join(userDir, `${commandName}.js`);
	try {
		if (fs.existsSync(userFile)) {
			const source = fs.readFileSync(userFile, "utf8");
			return { source, scope: "user", filePath: userFile, digest: computeDigest(source) };
		}
	} catch {
		return new PwrError(ErrorCode.WORKFLOW_NOT_FOUND).toResult();
	}
	return new PwrError(ErrorCode.WORKFLOW_NOT_FOUND).toResult();
}

/** Names of saved workflows (user scope always, project scope when trusted). */
export function listSavedWorkflows(deps: SaveLibDeps): string[] {
	const names = new Set<string>();
	const userDir = deps.getUserWorkflowsDir?.() ?? defaultUserWorkflowsDir();
	try {
		if (fs.existsSync(userDir)) {
			for (const entry of fs.readdirSync(userDir)) {
				if (entry.endsWith(".js")) {
					const stem = entry.slice(0, -3);
					if (isValidCommandName(stem)) names.add(stem);
				}
			}
		}
	} catch {
		// Scan is best-effort; an inaccessible directory just yields nothing.
	}
	const trustUnknown = !deps.isProjectTrusted || deps.isProjectTrusted();
	if (trustUnknown) {
		const projectDir = projectWorkflowsDir(deps.getProjectPath());
		try {
			if (fs.existsSync(projectDir)) {
				for (const entry of fs.readdirSync(projectDir)) {
					if (entry.endsWith(".js")) {
						const stem = entry.slice(0, -3);
						if (isValidCommandName(stem)) names.add(stem);
					}
				}
			}
		} catch {
			// Same best-effort rule as the user scope.
		}
	}
	return [...names].sort();
}

export interface DeleteSuccess {
	deleted: true;
	scope: "user" | "project";
	filePath: string;
}

/**
 * Deletes a saved workflow, mirroring loadSavedWorkflow resolution: the
 * project-scope file (trusted projects only) shadows the same-name
 * user-scope file; untrusted projects fall back to the user scope.
 * Missing file (or invalid name) → WORKFLOW_NOT_FOUND; any fs failure → DELETE_IO_ERROR.
 */
export function deleteSavedWorkflow(deps: SaveLibDeps, name: string): DeleteSuccess | PwrErrorResult {
	const commandName = normalizeCommandName(name);
	if (!isValidCommandName(commandName)) {
		return new PwrError(ErrorCode.WORKFLOW_NOT_FOUND).toResult();
	}

	const trustUnknown = !deps.isProjectTrusted || deps.isProjectTrusted();
	try {
		if (trustUnknown) {
			const projectPath = projectWorkflowsDir(deps.getProjectPath());
			const projectFile = path.join(projectPath, `${commandName}.js`);
			if (fs.existsSync(projectFile)) {
				fs.unlinkSync(projectFile);
				return { deleted: true, scope: "project", filePath: projectFile };
			}
		}

		const userDir = deps.getUserWorkflowsDir?.() ?? defaultUserWorkflowsDir();
		const userFile = path.join(userDir, `${commandName}.js`);
		if (fs.existsSync(userFile)) {
			fs.unlinkSync(userFile);
			return { deleted: true, scope: "user", filePath: userFile };
		}
	} catch {
		return new PwrError(ErrorCode.DELETE_IO_ERROR).toResult();
	}
	return new PwrError(ErrorCode.WORKFLOW_NOT_FOUND).toResult();
}

/** Approval-card decision callback injected by the caller (index.ts wires the UI). */
export type ApprovalDecision = "once" | "remember" | "reject" | null;

export interface SavedInvokeSuccess {
	ok: true;
	runId: string;
	started: boolean;
	message: string;
}

/**
 * Invokes a saved workflow: load -> re-validate -> args parse/schema check ->
 * create run -> approval (remembered, card, or reject) -> start.
 * Invalid args never create a run; a changed file digest invalidates the
 * remembered approval (APPROVAL_STALE / re-approval) per PRD §5.5.
 */
export async function invokeSavedWorkflow(
	deps: SaveLibDeps,
	input: { name: string; rawArgs?: string },
	approve: (info: { runId: string; scriptName: string; digest: string; planText: string; scriptSource: string }) => Promise<ApprovalDecision>,
): Promise<SavedInvokeSuccess | PwrErrorResult> {
	const name = normalizeCommandName(input?.name ?? "");
	if (!isValidCommandName(name)) {
		return new PwrError(ErrorCode.WORKFLOW_NOT_FOUND).toResult();
	}

	const loaded = loadSavedWorkflow(deps, name);
	if (isPwrError(loaded)) return loaded;

	if (!deps.engine) return new PwrError(ErrorCode.ENGINE_UNAVAILABLE).toResult();
	let validation;
	try {
		validation = await deps.engine.validate(loaded.source);
	} catch {
		return new PwrError(ErrorCode.ENGINE_UNAVAILABLE).toResult();
	}
	if (!validation.ok) {
		// A saved file that no longer validates must not run.
		return new PwrError(ErrorCode.SCRIPT_GENERATION_INVALID, undefined, "(saved workflow no longer passes validation)").toResult();
	}

	const meta: WorkflowMeta = {
		name: validation.meta?.name ?? name,
		description: validation.meta?.description,
		version: validation.meta?.version,
	};
	if (validation.meta?.argsSchema !== undefined) meta.argsSchema = validation.meta.argsSchema;

	const parsed: ArgsResult = parseCommandArgs(input.rawArgs);
	if (!parsed.ok) return { code: parsed.code, message: parsed.message };

	const args = parsed.value;
	if (args !== undefined && meta.argsSchema !== undefined) {
		const validatedArgs = validateArgsAgainstSchema(args, meta.argsSchema);
		if (!validatedArgs.ok) return { code: validatedArgs.code, message: validatedArgs.message };
	}

	let plan: WorkflowPlan;
	try {
		plan = extractPlan(loaded.source);
	} catch {
		// Validated source cannot fail to parse; defensive empty plan.
		plan = {
			stages: [],
			budget: { agentCalls: 0, pipelineCalls: 0, parallelCalls: 0, estimatedAgents: 0, writeRisk: false, warnLargeRun: false },
		};
	}

	const now = toIso(deps.now?.());
	const run = deps.registry.create(loaded.source, meta, plan, now, validation.astVersion, args);
	const script = deps.registry.getScript(run.runId);
	const digest = script?.digest ?? computeDigest(loaded.source);
	const projectPath = deps.getProjectPath();

	const remembered = deps.approvals.get(projectPath, digest);
	let approval: "once" | "remember";
	if (remembered && remembered.digest === digest) {
		approval = "remember";
	} else {
		const decision = await approve({
			runId: run.runId,
			scriptName: meta.name,
			digest,
			planText: formatSavedPlan(plan),
			scriptSource: loaded.source,
		});
		if (decision === "reject") {
			deps.registry.setStatus(run.runId, "cancelled");
			return new PwrError(ErrorCode.APPROVAL_REQUIRED, { runId: run.runId }, "(start rejected by user)").toResult();
		}
		if (decision === null) {
			return new PwrError(ErrorCode.APPROVAL_REQUIRED, { runId: run.runId }).toResult();
		}
		if (decision === "remember") {
			deps.approvals.remember(canonicalProjectPath(projectPath), digest, now);
		} else {
			deps.registry.markOnceApproved(run.runId);
		}
		approval = decision;
	}

	const started = await startWorkflow(deps, { runId: run.runId, approval });
	if (isPwrError(started)) return started;

	return {
		ok: true,
		runId: run.runId,
		started: true,
		message: `Workflow "${name}" started (run ${run.runId.slice(0, 8)}, ${loaded.scope} scope).`,
	};
}

function formatSavedPlan(plan: WorkflowPlan): string {
	const lines = [`Stages (${plan.stages.length}):`];
	for (const stage of plan.stages) {
		lines.push(`  - ${stage.label} (${stage.agentCount} agent(s))${stage.writeRisk ? " [write]" : ""}`);
	}
	lines.push(`Budget: ~${plan.budget.estimatedAgents} agents`);
	if (plan.budget.writeRisk) lines.push("⚠️ Write tools will be available to some agents.");
	if (plan.budget.warnLargeRun) lines.push("⚠️ Large run warning (over 25 agents).");
	return lines.join("\n");
}
