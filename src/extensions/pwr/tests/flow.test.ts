import { test } from "node:test";
import assert from "node:assert/strict";
import { ApprovalStore } from "../src/approval.ts";
import { ErrorCode } from "../src/errors.ts";
import { RunRegistry, controlWorkflow, startWorkflow, validateWorkflow, type FlowDeps } from "../src/flow.ts";
import { structuralGate } from "../src/engine.ts";
import type { ScriptEngine, RuntimeAdapter } from "../src/types.ts";

const VALID = `
export const meta = { name: 'audit', version: 1 };
const files = await agent('list', { label: 'discover', tools: 'readonly' });
const out = await pipeline(files.files, f => agent('audit ' + f, { label: 'audit' }), { concurrency: 4 });
return await agent('summarize', { label: 'verify' });
`;

function makeDeps(overrides?: Partial<FlowDeps>): { deps: FlowDeps; runtime: RuntimeAdapter; registry: RunRegistry } {
	const registry = new RunRegistry();
	const runtime: RuntimeAdapter = {
		async start(spec) {
			return { runId: spec.runId, status: "running" };
		},
		async control() {
			throw new Error("not implemented");
		},
	};
	const deps: FlowDeps = {
		engine: structuralGate,
		approvals: new ApprovalStore(),
		registry,
		getProjectPath: () => "C:/proj",
		runtime,
		now: () => "2026-08-05T10:00:00Z",
		...overrides,
	};
	return { deps, runtime, registry };
}

test("validate: valid script creates a draft run and plan", async () => {
	const { deps } = makeDeps();
	const result = await validateWorkflow(deps, { source: VALID });
	assert.ok(!("code" in result));
	assert.equal(result.runId.length, 36);
	assert.equal(result.script.digest.length, 64);
	assert.equal(result.script.astVersion.length > 0, true);
	// labels come from the AST: the pipeline stage has no own label, so it
	// gets an ordinal; the nested agent's label belongs to its own call.
	assert.deepEqual(result.plan.stages.map((s) => s.label), ["discover", "pipeline #1", "verify"]);
});

test("validate: invalid generation returns SCRIPT_GENERATION_INVALID", async () => {
	const { deps } = makeDeps();
	const result = await validateWorkflow(deps, { source: "" });
	assert.ok("code" in result);
	assert.equal(result.code, ErrorCode.SCRIPT_GENERATION_INVALID);

	const noMeta = await validateWorkflow(deps, { source: "const x = 1;" });
	assert.ok("code" in noMeta);
	assert.equal(noMeta.code, ErrorCode.SCRIPT_GENERATION_INVALID);
});

test("validate: engine rejection of forbidden syntax propagates", async () => {
	const engine: ScriptEngine = {
		validate() {
			return {
				ok: false,
				astVersion: "test",
				errors: [{ code: ErrorCode.SCRIPT_FORBIDDEN_SYNTAX, message: "forbidden", line: 3 }],
			};
		},
	};
	const { deps } = makeDeps({ engine });
	const result = await validateWorkflow(deps, { source: VALID });
	assert.ok("code" in result);
	assert.equal(result.code, ErrorCode.SCRIPT_FORBIDDEN_SYNTAX);
});

test("start: requires approval", async () => {
	const { deps } = makeDeps();
	const v = await validateWorkflow(deps, { source: VALID });
	if ("code" in v) throw new Error("validate failed");
	const result = await startWorkflow(deps, { runId: v.runId, approval: "once" });
	assert.ok("code" in result);
	assert.equal(result.code, ErrorCode.APPROVAL_REQUIRED);
});

test("start: once approval (user granted at card) starts the run", async () => {
	const { deps, registry } = makeDeps();
	const v = await validateWorkflow(deps, { source: VALID });
	if ("code" in v) throw new Error("validate failed");
	registry.markOnceApproved(v.runId);

	const result = await startWorkflow(deps, { runId: v.runId, approval: "once" });
	assert.ok(!("code" in result));
	assert.equal(result.status, "running");
	assert.equal(registry.getRun(v.runId)?.status, "running");
});

test("start: remembered approval starts without a card and survives re-start", async () => {
	const { deps, registry } = makeDeps();
	const v = await validateWorkflow(deps, { source: VALID });
	if ("code" in v) throw new Error("validate failed");
	deps.approvals.remember(deps.getProjectPath(), v.script.digest, "2026-08-05T10:00:00Z");

	const first = await startWorkflow(deps, { runId: v.runId, approval: "remember" });
	assert.ok(!("code" in first));
	assert.equal(first.status, "running");

	// same project + same digest -> auto-approved on a second run
	const v2 = await validateWorkflow(deps, { source: VALID });
	if ("code" in v2) throw new Error("validate failed");
	const second = await startWorkflow(deps, { runId: v2.runId, approval: "remember" });
	assert.ok(!("code" in second));
	assert.equal(registry.getRun(v2.runId)?.status, "running");
});

test("digest change: start fails with APPROVAL_STALE and requires re-approval", async () => {
	const { deps, registry } = makeDeps();
	const v = await validateWorkflow(deps, { source: VALID });
	if ("code" in v) throw new Error("validate failed");
	deps.approvals.remember(deps.getProjectPath(), v.script.digest, "2026-08-05T10:00:00Z");

	// script content changes -> new digest
	const changed = VALID + "\n// extra line";
	const v2 = await validateWorkflow(deps, { source: changed });
	if ("code" in v2) throw new Error("validate failed");
	assert.notEqual(v2.script.digest, v.script.digest);

	const result = await startWorkflow(deps, { runId: v2.runId, approval: "remember" });
	assert.ok("code" in result);
	assert.equal(result.code, ErrorCode.APPROVAL_STALE);

	// after re-approval for the new digest, start succeeds
	deps.approvals.remember(deps.getProjectPath(), v2.script.digest, "2026-08-05T11:00:00Z");
	const retry = await startWorkflow(deps, { runId: v2.runId, approval: "remember" });
	assert.ok(!("code" in retry));
	assert.equal(registry.getRun(v2.runId)?.status, "running");
});

test("start: unknown run -> RUN_NOT_FOUND", async () => {
	const { deps } = makeDeps();
	const result = await startWorkflow(deps, { runId: "nope", approval: "once" });
	assert.ok("code" in result);
	assert.equal(result.code, ErrorCode.RUN_NOT_FOUND);
});

test("start: no runtime -> AGENT_RUNNER_UNAVAILABLE (no implicit fallback)", async () => {
	const { deps, registry } = makeDeps();
	deps.runtime = null;
	const v = await validateWorkflow(deps, { source: VALID });
	if ("code" in v) throw new Error("validate failed");
	registry.markOnceApproved(v.runId);

	const result = await startWorkflow(deps, { runId: v.runId, approval: "once" });
	assert.ok("code" in result);
	assert.equal(result.code, ErrorCode.AGENT_RUNNER_UNAVAILABLE);
	assert.equal(registry.getRun(v.runId)?.status, "failed");
});

test("validate: missing engine -> ENGINE_UNAVAILABLE (never the structural gate)", async () => {
	const { deps } = makeDeps({ engine: null });
	const result = await validateWorkflow(deps, { source: VALID });
	assert.ok("code" in result);
	assert.equal(result.code, ErrorCode.ENGINE_UNAVAILABLE);
});

test("validate: over-budget script (1001 agent calls) is rejected with BUDGET_EXCEEDED", async () => {
	const many = Array.from({ length: 1001 }, (_, i) => `await agent('task ${i}', { label: 'l${i}' });`).join("\n");
	const source = `export const meta = { name: 'big' };\n${many}`;
	const { deps } = makeDeps();
	const result = await validateWorkflow(deps, { source });
	assert.ok("code" in result);
	assert.equal(result.code, ErrorCode.BUDGET_EXCEEDED);
});

test("start: onFinalResult is passed to the runtime and queued on the notifier", async () => {
	const registry = new RunRegistry();
	let captured: ((summary: string) => void) | undefined;
	const runtime: RuntimeAdapter = {
		async start(spec) {
			captured = spec.onFinalResult;
			return { runId: spec.runId, status: "running" };
		},
		async control() {
			throw new Error("not implemented");
		},
	};
	const queued: Array<{ runId: string; name: string; summary: string }> = [];
	const fakeNotifier = {
		queue: (runId: string, name: string, summary: string) => queued.push({ runId, name, summary }),
	} as never;
	const deps: FlowDeps = {
		engine: structuralGate,
		approvals: new ApprovalStore(),
		registry,
		getProjectPath: () => "C:/proj",
		runtime,
		notifier: fakeNotifier,
		now: () => "2026-08-05T10:00:00Z",
	};
	const v = await validateWorkflow(deps, { source: VALID });
	if ("code" in v) throw new Error("validate failed");
	registry.markOnceApproved(v.runId);
	await startWorkflow(deps, { runId: v.runId, approval: "once" });

	assert.ok(captured, "runtime.start must receive onFinalResult");
	assert.equal(queued.length, 0, "nothing queued before the runtime delivers the summary");
	captured!("final result text");
	assert.equal(queued.length, 1);
	assert.equal(queued[0]!.runId, v.runId);
	assert.equal(queued[0]!.name, "audit");
	assert.equal(queued[0]!.summary, "final result text");
});

test("control: success returns { runId, run } per PRD §6.2", async () => {
	const registry = new RunRegistry();
	const views = new Map<string, { status: string }>();
	const runtime: RuntimeAdapter = {
		async start(spec) {
			return { runId: spec.runId, status: "running" };
		},
		async control(input) {
			const status = input.action === "pause" ? "paused" : input.action === "resume" ? "running" : "completed";
			views.set(input.runId, { status });
			return { run: { runId: input.runId, status } as never };
		},
	};
	const deps: FlowDeps = {
		engine: structuralGate,
		approvals: new ApprovalStore(),
		registry,
		getProjectPath: () => "C:/proj",
		runtime,
	};
	const v = await validateWorkflow(deps, { source: VALID });
	if ("code" in v) throw new Error("validate failed");
	registry.markOnceApproved(v.runId);
	await startWorkflow(deps, { runId: v.runId, approval: "once" });

	const pause = await controlWorkflow(deps, { runId: v.runId, action: "pause" });
	assert.ok(!("code" in pause));
	assert.equal(pause.runId, v.runId);
	assert.equal(pause.run.status, "paused");

	const resume = await controlWorkflow(deps, { runId: v.runId, action: "resume" });
	assert.ok(!("code" in resume));
	assert.equal(resume.run.status, "running");

	const stop = await controlWorkflow(deps, { runId: v.runId, action: "stop" });
	assert.ok(!("code" in stop));
	assert.equal(stop.run.status, "completed");

	const restart = await controlWorkflow(deps, { runId: v.runId, action: "restart_agent", agentId: "a1" });
	assert.ok(!("code" in restart));
	assert.equal(restart.run.status, "completed");
});
