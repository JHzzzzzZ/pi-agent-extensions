/**
 * JHL-17: save/load and parameter commands.
 *
 * Covers: user/project scope save, trust gating, meta auto-fill, NAME_CONFLICT
 * + overwrite, project-over-user resolution, args parse/schema gating, approval
 * memory re-granted on digest change, command invocation without runtime.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ApprovalStore } from "../src/approval.ts";
import { computeDigest } from "../src/digest.ts";
import { ErrorCode } from "../src/errors.ts";
import { RunRegistry, saveWorkflow, validateWorkflow } from "../src/flow.ts";
import { getValidationEngine } from "../src/engine.ts";
import {
	deleteSavedWorkflow,
	invokeSavedWorkflow,
	isPwrError,
	listSavedWorkflows,
	loadSavedWorkflow,
	saveWorkflowCommand,
	type ApprovalDecision,
	type SaveLibDeps,
} from "../src/save.ts";
import type { RuntimeAdapter, WorkflowMeta, WorkflowRun } from "../src/types.ts";

const VALID = `
export const meta = { name: 'audit', description: 'Audit routes', version: 3 };
const files = await agent('list', { label: 'discover', tools: 'readonly' });
return await agent('summarize', { label: 'verify' });
`;

const MINIMAL_META = `
export const meta = {};
const files = await agent('list', { label: 'discover', tools: 'readonly' });
return await agent('summarize', { label: 'verify' });
`;

const WITH_ARGS_SCHEMA = `
export const meta = {
  name: 'audit',
  argsSchema: {
    type: 'object',
    required: ['files'],
    properties: { files: { type: 'array', items: { type: 'string' } }, depth: { type: 'integer', minimum: 1 } },
    additionalProperties: false,
  },
};
const files = await agent('list', { label: 'discover', tools: 'readonly' });
return await agent('summarize', { label: 'verify' });
`;

interface FakeRuntime extends RuntimeAdapter {
	startCalls: Array<{ runId: string; args?: unknown; script?: unknown }>;
}

function makeRuntime(): FakeRuntime {
	const runtime: FakeRuntime = {
		startCalls: [],
		async start(spec) {
			runtime.startCalls.push({ runId: spec.runId, args: spec.args, script: spec.script });
			return { runId: spec.runId, status: "running" };
		},
		async control() {
			throw new Error("not implemented");
		},
	};
	return runtime;
}

interface Harness {
	deps: SaveLibDeps & { registry: RunRegistry; approvals: ApprovalStore; runtime: FakeRuntime | null };
	userDir: string;
	projectPath: string;
	createdRuns: Array<{ run: WorkflowRun; args: unknown }>;
	approveCalls: Array<{ info: { runId: string; scriptName: string; digest: string; planText: string; scriptSource: string }; decision: ApprovalDecision }>;
	approve: (info: { runId: string; scriptName: string; digest: string; planText: string; scriptSource: string }) => Promise<ApprovalDecision>;
}

async function makeHarness(overrides?: {
	trusted?: boolean;
	approve?: ApprovalDecision;
	engine?: SaveLibDeps["engine"] | null;
	runtime?: FakeRuntime | null;
}): Promise<Harness> {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pwr-save-"));
	const userDir = path.join(root, "home", ".pi", "agent", "workflows");
	const projectPath = path.join(root, "project");
	fs.mkdirSync(userDir, { recursive: true });
	fs.mkdirSync(projectPath, { recursive: true });

	const registry = new RunRegistry();
	const approvals = new ApprovalStore();
	const runtime = overrides?.runtime === undefined ? makeRuntime() : (overrides.runtime ?? null);
	const engine = overrides?.engine === undefined ? (await getValidationEngine()) : overrides.engine;

	const createdRuns: Harness["createdRuns"] = [];
	const originalCreate = registry.create.bind(registry);
	registry.create = (source, meta, plan, now, astVersion, args) => {
		const run = originalCreate(source, meta, plan, now, astVersion, args);
		createdRuns.push({ run, args });
		return run;
	};

	const harness: Harness = {
		deps: {
			engine,
			approvals,
			registry,
			getProjectPath: () => projectPath,
			getUserWorkflowsDir: () => userDir,
			isProjectTrusted: () => (overrides?.trusted === undefined ? true : overrides.trusted),
			runtime,
			now: () => "2026-08-05T10:00:00Z",
		},
		userDir,
		projectPath,
		createdRuns,
		approveCalls: [],
		approve: null as never,
	};
	harness.approve = async (info) => {
		harness.approveCalls.push({ info, decision: overrides?.approve ?? null });
		return overrides?.approve ?? null;
	};
	return harness;
}

/** Mirrors the production flow: validate the source with the engine and use its meta. */
async function createValidatedRun(h: Harness, source = VALID): Promise<string> {
	if (!h.deps.engine) throw new Error("engine required");
	const v = await h.deps.engine.validate(source);
	if (!v.ok) throw new Error(`source invalid: ${JSON.stringify(v.errors[0])}`);
	const meta: WorkflowMeta = {
		name: v.meta?.name ?? "untitled",
		description: v.meta?.description,
		version: v.meta?.version,
	};
	if (v.meta?.argsSchema !== undefined) meta.argsSchema = v.meta.argsSchema;
	const draft = h.deps.registry.create(
		source,
		meta,
		{ stages: [], budget: { agentCalls: 0, pipelineCalls: 0, parallelCalls: 0, estimatedAgents: 0, writeRisk: false, warnLargeRun: false } },
		"2026-08-05T10:00:00Z",
		v.astVersion,
	);
	return draft.runId;
}

// ---------- save ----------

test("save user scope: writes ~/.pi/agent/workflows/<name>.js, meta auto-filled", async () => {
	const h = await makeHarness();
	const runId = await createValidatedRun(h, MINIMAL_META);
	const result = await saveWorkflowCommand(h.deps, { runId, scope: "user", name: "AuditRoutes" });
	assert.ok(!isPwrError(result), "save should succeed");
	if (isPwrError(result)) return;

	assert.equal(result.commandName, "auditroutes", "name is lowercased");
	assert.equal(result.pathScope, "user");
	const filePath = path.join(h.userDir, "auditroutes.js");
	assert.equal(result.filePath, filePath);
	assert.ok(fs.existsSync(filePath), "file must exist");

	const content = fs.readFileSync(filePath, "utf8");
	assert.ok(content.includes('"name":"auditroutes"'), "missing meta.name filled from command name");
	assert.ok(content.includes('"version":1'), "missing version filled with 1");
	assert.ok(content.includes('"description"'), "missing description auto-generated");
	assert.ok(!content.includes("meta = {}"), "empty meta replaced, not duplicated");
	assert.equal(result.digest, computeDigest(content));
});

test("save preserves existing meta fields and argsSchema", async () => {
	const h = await makeHarness();
	const runId = await createValidatedRun(h, WITH_ARGS_SCHEMA);
	const result = await saveWorkflowCommand(h.deps, { runId, scope: "user", name: "audit" });
	assert.ok(!isPwrError(result));
	if (isPwrError(result)) return;

	const content = fs.readFileSync(result.filePath, "utf8");
	assert.ok(content.includes('"name":"audit"'), "existing name preserved");
	assert.ok(content.includes('"version":1'), "missing version filled with 1");
	assert.ok(content.includes("argsSchema"), "argsSchema survives the save round-trip");
	assert.ok(content.includes('"required"'), "schema body preserved");
});

test("save project scope: trusted project writes .pi/workflows/<name>.js", async () => {
	const h = await makeHarness({ trusted: true });
	const runId = await createValidatedRun(h);
	const result = await saveWorkflowCommand(h.deps, { runId, scope: "project", name: "audit" });
	assert.ok(!isPwrError(result));
	if (isPwrError(result)) return;
	assert.equal(result.pathScope, "project");
	assert.equal(result.filePath, path.join(h.projectPath, ".pi", "workflows", "audit.js"));
	assert.ok(fs.existsSync(result.filePath));
});

test("save project scope: untrusted project -> PROJECT_NOT_TRUSTED and no write", async () => {
	const h = await makeHarness({ trusted: false });
	const runId = await createValidatedRun(h);
	const result = await saveWorkflowCommand(h.deps, { runId, scope: "project", name: "audit" });
	assert.ok(isPwrError(result));
	if (!isPwrError(result)) return;
	assert.equal(result.code, ErrorCode.PROJECT_NOT_TRUSTED);
	assert.ok(!fs.existsSync(path.join(h.projectPath, ".pi", "workflows", "audit.js")), "nothing written");
});

test("save invalid name -> SCRIPT_GENERATION_INVALID, nothing written", async () => {
	const h = await makeHarness();
	const runId = await createValidatedRun(h);
	for (const bad of ["My Script", "-abc", "a_b", "a b", "audit/../evil"]) {
		const result = await saveWorkflowCommand(h.deps, { runId, scope: "user", name: bad });
		assert.ok(isPwrError(result));
		if (isPwrError(result)) assert.equal(result.code, ErrorCode.SCRIPT_GENERATION_INVALID);
	}
	assert.equal(fs.readdirSync(h.userDir).length, 0, "no files written");
});

test("save duplicate name -> NAME_CONFLICT; overwrite:true replaces the file", async () => {
	const h = await makeHarness();
	const first = await saveWorkflowCommand(h.deps, { runId: await createValidatedRun(h, VALID), scope: "user", name: "audit" });
	assert.ok(!isPwrError(first));
	const original = fs.readFileSync((first as { filePath: string }).filePath, "utf8");

	const conflict = await saveWorkflowCommand(h.deps, { runId: await createValidatedRun(h, VALID + "\n// v2"), scope: "user", name: "audit" });
	assert.ok(isPwrError(conflict));
	if (!isPwrError(conflict)) return;
	assert.equal(conflict.code, ErrorCode.NAME_CONFLICT);
	assert.equal(fs.readFileSync((first as { filePath: string }).filePath, "utf8"), original, "file untouched on conflict");

	const overwritten = await saveWorkflowCommand(h.deps, { runId: await createValidatedRun(h, VALID + "\n// v2"), scope: "user", name: "audit", overwrite: true });
	assert.ok(!isPwrError(overwritten));
	if (isPwrError(overwritten)) return;
	const replaced = fs.readFileSync((overwritten as { filePath: string }).filePath, "utf8");
	assert.ok(replaced.includes("// v2"), "file replaced after overwrite confirmation");
});

test("save unknown run -> RUN_NOT_FOUND; missing engine -> ENGINE_UNAVAILABLE", async () => {
	const h = await makeHarness();
	const result = await saveWorkflowCommand(h.deps, { runId: "nope", scope: "user", name: "audit" });
	assert.ok(isPwrError(result));
	if (!isPwrError(result)) return;
	assert.equal(result.code, ErrorCode.RUN_NOT_FOUND);

	const runId = await createValidatedRun(h);
	const noEngine = await saveWorkflowCommand({ ...h.deps, engine: null }, { runId, scope: "user", name: "audit" });
	assert.ok(isPwrError(noEngine));
	if (isPwrError(noEngine)) assert.equal(noEngine.code, ErrorCode.ENGINE_UNAVAILABLE);
});

test("workflow_save tool contract: overwrite flag passes through the adapter", async () => {
	const calls: Array<{ name: string; overwrite: boolean | undefined }> = [];
	const adapter = {
		async save(input: { name: string; overwrite?: boolean }) {
			calls.push({ name: input.name, overwrite: input.overwrite });
			return { commandName: input.name, pathScope: "user" as const };
		},
	};
	const h = await makeHarness();
	const flowDeps = { ...h.deps, saveAdapter: adapter };
	const result = await saveWorkflow(flowDeps, { runId: "r1", scope: "user", name: "audit", overwrite: true });
	void result;
	assert.deepEqual(calls, [{ name: "audit", overwrite: true }]);

	const result2 = await saveWorkflow(flowDeps, { runId: "r1", scope: "user", name: "audit" });
	void result2;
	assert.equal(calls[1]!.overwrite, undefined, "omitted overwrite stays undefined");
});

// ---------- load / resolution ----------

test("load: project-scope script shadows same-name user-scope script", async () => {
	const h = await makeHarness();
	const runId = await createValidatedRun(h, VALID);
	await saveWorkflowCommand(h.deps, { runId, scope: "user", name: "audit" });
	await saveWorkflowCommand(h.deps, { runId, scope: "project", name: "audit" });

	const loaded = loadSavedWorkflow(h.deps, "audit");
	assert.ok(!isPwrError(loaded));
	if (isPwrError(loaded)) return;
	assert.equal(loaded.scope, "project");
	assert.equal(loaded.filePath, path.join(h.projectPath, ".pi", "workflows", "audit.js"));
});

test("load: untrusted project falls back to the user scope", async () => {
	const h = await makeHarness({ trusted: false });
	const runId = await createValidatedRun(h, VALID);
	await saveWorkflowCommand(h.deps, { runId, scope: "user", name: "audit" });
	const projectDir = path.join(h.projectPath, ".pi", "workflows");
	fs.mkdirSync(projectDir, { recursive: true });
	fs.writeFileSync(path.join(projectDir, "audit.js"), VALID, "utf8");

	const loaded = loadSavedWorkflow(h.deps, "audit");
	assert.ok(!isPwrError(loaded));
	if (isPwrError(loaded)) return;
	assert.equal(loaded.scope, "user", "untrusted project file is ignored");
});

test("load: missing workflow -> WORKFLOW_NOT_FOUND (also for invalid names)", async () => {
	const h = await makeHarness();
	assert.equal((loadSavedWorkflow(h.deps, "missing") as { code: string }).code, ErrorCode.WORKFLOW_NOT_FOUND);
	assert.equal((loadSavedWorkflow(h.deps, "Bad Name") as { code: string }).code, ErrorCode.WORKFLOW_NOT_FOUND);
});

// ---------- delete ----------

/** Delete-only deps: engine/registry are unused by deleteSavedWorkflow. */
function makeDeleteDeps(root: string, trusted: boolean): SaveLibDeps {
	return {
		engine: null,
		approvals: new ApprovalStore(),
		registry: new RunRegistry(),
		getProjectPath: () => path.join(root, "project"),
		getUserWorkflowsDir: () => path.join(root, "home", ".pi", "agent", "workflows"),
		isProjectTrusted: () => trusted,
	};
}

test("delete: user-scope workflow is removed", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pwr-del-"));
	const deps = makeDeleteDeps(root, false);
	const userDir = deps.getUserWorkflowsDir!();
	fs.mkdirSync(userDir, { recursive: true });
	fs.writeFileSync(path.join(userDir, "audit.js"), VALID, "utf8");

	const result = deleteSavedWorkflow(deps, "audit");
	assert.deepEqual(result, { deleted: true, scope: "user", filePath: path.join(userDir, "audit.js") });
	assert.ok(!fs.existsSync(path.join(userDir, "audit.js")), "file must be gone");
});

test("delete: project file shadows user file (project deleted, user file survives)", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pwr-del-"));
	const deps = makeDeleteDeps(root, true);
	const userDir = deps.getUserWorkflowsDir!();
	const projectDir = path.join(deps.getProjectPath(), ".pi", "workflows");
	fs.mkdirSync(userDir, { recursive: true });
	fs.mkdirSync(projectDir, { recursive: true });
	fs.writeFileSync(path.join(userDir, "audit.js"), VALID, "utf8");
	fs.writeFileSync(path.join(projectDir, "audit.js"), VALID, "utf8");

	const result = deleteSavedWorkflow(deps, "audit");
	assert.deepEqual(result, { deleted: true, scope: "project", filePath: path.join(projectDir, "audit.js") });
	assert.ok(!fs.existsSync(path.join(projectDir, "audit.js")), "project file must be gone");
	assert.ok(fs.existsSync(path.join(userDir, "audit.js")), "user file must survive");
	assert.equal((loadSavedWorkflow(deps, "audit") as { scope: string }).scope, "user", "user copy still loadable");
});

test("delete: untrusted project falls back to the user scope", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pwr-del-"));
	const deps = makeDeleteDeps(root, false);
	const userDir = deps.getUserWorkflowsDir!();
	const projectDir = path.join(deps.getProjectPath(), ".pi", "workflows");
	fs.mkdirSync(userDir, { recursive: true });
	fs.mkdirSync(projectDir, { recursive: true });
	fs.writeFileSync(path.join(userDir, "audit.js"), VALID, "utf8");
	fs.writeFileSync(path.join(projectDir, "audit.js"), VALID, "utf8");

	const result = deleteSavedWorkflow(deps, "audit");
	assert.deepEqual(result, { deleted: true, scope: "user", filePath: path.join(userDir, "audit.js") });
	assert.ok(fs.existsSync(path.join(projectDir, "audit.js")), "project file must be untouched when untrusted");
});

test("delete: missing workflow and invalid names -> WORKFLOW_NOT_FOUND", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pwr-del-"));
	const deps = makeDeleteDeps(root, true);
	const missing = deleteSavedWorkflow(deps, "missing");
	assert.equal((missing as { code: string }).code, ErrorCode.WORKFLOW_NOT_FOUND);
	const invalid = deleteSavedWorkflow(deps, "Bad Name");
	assert.equal((invalid as { code: string }).code, ErrorCode.WORKFLOW_NOT_FOUND);
});

test("listSavedWorkflows: user + trusted project files; invalid names ignored", async () => {
	const h = await makeHarness({ trusted: true });
	const runId = await createValidatedRun(h, VALID);
	await saveWorkflowCommand(h.deps, { runId, scope: "user", name: "audit" });
	await saveWorkflowCommand(h.deps, { runId, scope: "user", name: "audit" });
	await saveWorkflowCommand(h.deps, { runId, scope: "project", name: "fix-routes" });
	fs.writeFileSync(path.join(h.userDir, "not a name.js"), VALID, "utf8");

	assert.deepEqual(listSavedWorkflows(h.deps), ["audit", "fix-routes"]);
});

// ---------- invoke ----------

test("invoke: remembered approval starts with parsed args", async () => {
	const h = await makeHarness();
	const runId = await createValidatedRun(h, WITH_ARGS_SCHEMA);
	const saved = await saveWorkflowCommand(h.deps, { runId, scope: "user", name: "audit" });
	if (isPwrError(saved)) throw new Error("save failed");
	h.deps.approvals.remember(h.projectPath, saved.digest, "2026-08-05T10:00:00Z");

	const result = await invokeSavedWorkflow(h.deps, { name: "audit", rawArgs: '{"files":["src/a.ts"],"depth":2}' }, h.approve);
	assert.ok(!isPwrError(result));
	if (isPwrError(result)) return;
	assert.equal(result.ok, true);
	assert.equal(h.approveCalls.length, 0, "remembered approval skips the card");
	const invokeRun = h.createdRuns.at(-1)!;
	assert.deepEqual(invokeRun.args, { files: ["src/a.ts"], depth: 2 });
	assert.equal(h.deps.runtime!.startCalls.length, 1);
	assert.deepEqual(h.deps.runtime!.startCalls[0]!.args, { files: ["src/a.ts"], depth: 2 }, "args reach the runtime");
	assert.equal(h.deps.registry.getRun(result.runId)?.status, "running");
});

test("invoke: no approval -> card 'once' starts; card 'remember' records approval", async () => {
	const h = await makeHarness({ approve: "once" });
	const saved = await saveWorkflowCommand(h.deps, { runId: await createValidatedRun(h, VALID), scope: "user", name: "audit" });
	if (isPwrError(saved)) throw new Error("save failed");

	const once = await invokeSavedWorkflow(h.deps, { name: "audit", rawArgs: "" }, h.approve);
	assert.ok(!isPwrError(once));
	if (isPwrError(once)) return;
	assert.equal(once.ok, true);
	assert.equal(h.approveCalls.length, 1);
	assert.equal(h.approveCalls[0]!.info.digest, saved.digest, "card shows the current digest");
	assert.ok(h.approveCalls[0]!.info.planText.includes("Stages"), "card shows the stage plan");
	assert.equal(
		h.approveCalls[0]!.info.scriptSource,
		fs.readFileSync(path.join(h.userDir, "audit.js"), "utf8"),
		"card carries the saved script source",
	);
	assert.ok(h.deps.registry.isOnceApproved(once.runId));

	const h2 = await makeHarness({ approve: "remember" });
	const saved2 = await saveWorkflowCommand(h2.deps, { runId: await createValidatedRun(h2, VALID), scope: "user", name: "audit" });
	if (isPwrError(saved2)) throw new Error("save failed");
	const remembered = await invokeSavedWorkflow(h2.deps, { name: "audit", rawArgs: "" }, h2.approve);
	assert.ok(!isPwrError(remembered));
	if (isPwrError(remembered)) return;
	assert.ok(h2.deps.approvals.get(h2.projectPath, saved2.digest), "remembered approval persisted");
});

test("invoke: card dismissed -> APPROVAL_REQUIRED, run not started; reject -> cancelled", async () => {
	const h = await makeHarness({ approve: null });
	await saveWorkflowCommand(h.deps, { runId: await createValidatedRun(h, VALID), scope: "user", name: "audit" });

	const dismissed = await invokeSavedWorkflow(h.deps, { name: "audit", rawArgs: "" }, h.approve);
	assert.ok(isPwrError(dismissed));
	if (isPwrError(dismissed)) assert.equal(dismissed.code, ErrorCode.APPROVAL_REQUIRED);
	assert.equal(h.deps.runtime!.startCalls.length, 0, "never started");
	assert.equal(h.deps.registry.getRun(h.createdRuns.at(-1)!.run.runId)?.status, "awaiting_approval");

	const h2 = await makeHarness({ approve: "reject" });
	await saveWorkflowCommand(h2.deps, { runId: await createValidatedRun(h2, VALID), scope: "user", name: "audit" });
	const rejected = await invokeSavedWorkflow(h2.deps, { name: "audit", rawArgs: "" }, h2.approve);
	assert.ok(isPwrError(rejected));
	assert.equal(h2.deps.runtime!.startCalls.length, 0);
	assert.equal(h2.deps.registry.getRun(h2.createdRuns.at(-1)!.run.runId)?.status, "cancelled");
});

test("invoke: invalid args and schema violations never create a run", async () => {
	const h = await makeHarness();
	await saveWorkflowCommand(h.deps, { runId: await createValidatedRun(h, WITH_ARGS_SCHEMA), scope: "user", name: "audit" });
	const baselineRuns = h.createdRuns.length;

	const badJson = await invokeSavedWorkflow(h.deps, { name: "audit", rawArgs: "not json" }, h.approve);
	assert.ok(isPwrError(badJson));
	if (isPwrError(badJson)) assert.equal(badJson.code, ErrorCode.ARGS_INVALID);
	assert.equal(h.createdRuns.length, baselineRuns, "no run for unparseable args");
	assert.equal(h.deps.runtime!.startCalls.length, 0);

	const violation = await invokeSavedWorkflow(h.deps, { name: "audit", rawArgs: '{"files":"not-an-array"}' }, h.approve);
	assert.ok(isPwrError(violation));
	if (isPwrError(violation)) assert.equal(violation.code, ErrorCode.ARGS_SCHEMA_VIOLATION);
	assert.equal(h.createdRuns.length, baselineRuns, "no run for schema-violating args");
});

test("invoke: valid schema args start; no args stays undefined", async () => {
	const h = await makeHarness({ approve: "once" });
	await saveWorkflowCommand(h.deps, { runId: await createValidatedRun(h, WITH_ARGS_SCHEMA), scope: "user", name: "audit" });
	const ok = await invokeSavedWorkflow(h.deps, { name: "audit", rawArgs: '{"files":["x.ts"]}' }, h.approve);
	assert.ok(!isPwrError(ok));
	if (isPwrError(ok)) return;
	assert.deepEqual(h.createdRuns.at(-1)!.args, { files: ["x.ts"] });

	const h2 = await makeHarness({ approve: "once" });
	await saveWorkflowCommand(h2.deps, { runId: await createValidatedRun(h2, VALID), scope: "user", name: "audit" });
	const noArgs = await invokeSavedWorkflow(h2.deps, { name: "audit", rawArgs: "" }, h2.approve);
	assert.ok(!isPwrError(noArgs));
	assert.equal(h2.createdRuns.at(-1)!.args, undefined, "no args -> undefined");
});

test("e2e: script meta.argsSchema survives validate -> save -> invoke (production path)", async () => {
	const h = await makeHarness({ approve: "once" });

	// Production path: workflow_validate (engine adapter -> validateWorkflow),
	// NOT the hand-rolled helper. The engine-validated meta.argsSchema must be
	// carried into the registry script meta.
	const v = await validateWorkflow(h.deps, { source: WITH_ARGS_SCHEMA });
	assert.ok(!("code" in v), "validate must succeed");
	if ("code" in v) return;
	assert.deepEqual(
		h.deps.registry.getScript(v.runId)?.meta.argsSchema,
		{
			type: "object",
			required: ["files"],
			properties: { files: { type: "array", items: { type: "string" } }, depth: { type: "integer", minimum: 1 } },
			additionalProperties: false,
		},
		"registry script meta must carry the engine-validated argsSchema",
	);

	// Save via the production adapter path: the schema must survive into the
	// persisted file (fillMeta/withFilledMeta round-trip).
	const saved = await saveWorkflowCommand(h.deps, { runId: v.runId, scope: "user", name: "audit" });
	assert.ok(!isPwrError(saved), "save must succeed");
	if (isPwrError(saved)) return;
	const content = fs.readFileSync((saved as { filePath: string }).filePath, "utf8");
	assert.ok(content.includes("argsSchema"), "argsSchema must be written into the saved file");
	assert.ok(content.includes('"required"'), "schema body preserved in the saved file");

	// Invoke with violating args: ARGS_SCHEMA_VIOLATION and NO run created.
	const baselineRuns = h.createdRuns.length;
	const violation = await invokeSavedWorkflow(h.deps, { name: "audit", rawArgs: '{"files":"not-an-array"}' }, h.approve);
	assert.ok(isPwrError(violation));
	if (isPwrError(violation)) assert.equal(violation.code, ErrorCode.ARGS_SCHEMA_VIOLATION);
	assert.equal(h.createdRuns.length, baselineRuns, "no run for schema-violating args");
	assert.equal(h.deps.runtime!.startCalls.length, 0, "never started");

	// Valid args still start through the same chain.
	const ok = await invokeSavedWorkflow(h.deps, { name: "audit", rawArgs: '{"files":["x.ts"],"depth":2}' }, h.approve);
	assert.ok(!isPwrError(ok));
	if (isPwrError(ok)) return;
	assert.deepEqual(h.createdRuns.at(-1)!.args, { files: ["x.ts"], depth: 2 });
});

test("invoke: script edited after remember -> re-approval required, new digest recorded", async () => {
	const h = await makeHarness({ approve: "remember" });
	const saved = await saveWorkflowCommand(h.deps, { runId: await createValidatedRun(h, VALID), scope: "user", name: "audit" });
	if (isPwrError(saved)) throw new Error("save failed");
	h.deps.approvals.remember(h.projectPath, saved.digest, "2026-08-05T10:00:00Z");

	const first = await invokeSavedWorkflow(h.deps, { name: "audit", rawArgs: "" }, h.approve);
	assert.ok(!isPwrError(first), "remembered approval covers the unmodified script");
	assert.equal(h.approveCalls.length, 0);

	// user edits the saved file -> digest changes -> card must re-appear
	fs.appendFileSync(saved.filePath, "\n// user edit\n");
	const edited = await invokeSavedWorkflow(h.deps, { name: "audit", rawArgs: "" }, h.approve);
	assert.ok(!isPwrError(edited));
	assert.equal(h.approveCalls.length, 1, "card re-shown after digest change");
	const newDigest = computeDigest(fs.readFileSync(saved.filePath, "utf8"));
	assert.notEqual(newDigest, saved.digest);
	assert.ok(h.deps.approvals.get(h.projectPath, newDigest), "re-approval recorded for the new digest");
	assert.ok(h.deps.registry.getRun(h.createdRuns[1]!.run.runId)?.status, "running");
});

test("invoke: unknown saved workflow -> WORKFLOW_NOT_FOUND", async () => {
	const h = await makeHarness();
	const result = await invokeSavedWorkflow(h.deps, { name: "ghost", rawArgs: "" }, h.approve);
	assert.ok(isPwrError(result));
	if (isPwrError(result)) assert.equal(result.code, ErrorCode.WORKFLOW_NOT_FOUND);
});

test("invoke: no runtime -> AGENT_RUNNER_UNAVAILABLE, run marked failed (no fallback)", async () => {
	const h = await makeHarness({ approve: "once", runtime: null });
	await saveWorkflowCommand(h.deps, { runId: await createValidatedRun(h, VALID), scope: "user", name: "audit" });
	const result = await invokeSavedWorkflow(h.deps, { name: "audit", rawArgs: "" }, h.approve);
	assert.ok(isPwrError(result));
	if (isPwrError(result)) assert.equal(result.code, ErrorCode.AGENT_RUNNER_UNAVAILABLE);
	assert.equal(h.deps.registry.getRun(h.createdRuns.at(-1)!.run.runId)?.status, "failed");
});



