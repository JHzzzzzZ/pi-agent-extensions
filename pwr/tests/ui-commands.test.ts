/**
 * JHL-15 - /workflows command parsing + control dispatch tests: every
 * keyboard action is reachable as a command; run id prefix resolution;
 * error contracts ({ code, message } passthrough).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseControlArgs, parseWorkflowsArgs, resolveRunId, runApproveAction, runControlAction, workflowsHelpText } from "../src/ui/commands.ts";
import { MemoryRunStore } from "../src/ui/run-store.ts";
import { RunRegistry, type FlowDeps } from "../src/flow.ts";
import { ApprovalStore } from "../src/approval.ts";
import type { RuntimeAdapter, WorkflowRunView } from "../src/types.ts";

function makeStore(): { store: MemoryRunStore; registry: RunRegistry; runId: string } {
	const store = new MemoryRunStore({ nowMs: () => Date.parse("2026-08-05T12:00:00Z") });
	const registry = new RunRegistry();
	const plan = {
		stages: [{ stageId: "s1", label: "discover", kind: "agent" as const, agentCount: 1, writeRisk: false }],
		budget: { agentCalls: 1, pipelineCalls: 0, parallelCalls: 0, estimatedAgents: 1, writeRisk: false, warnLargeRun: false },
	};
	const run = registry.create("src", { name: "audit" }, plan, "2026-08-05T12:00:00Z");
	const runId = run.runId;
	// a controllable run must be running/paused/queued in the registry
	registry.setStatus(runId, "running", "2026-08-05T12:00:05Z");
	store.hydrateRun(registry.getRun(runId)!, registry.getScript(runId)!, registry.getPlan(runId)!);
	store.feedEvent({ type: "run_status", runId, status: "running", at: "2026-08-05T12:00:05Z" });
	return { store, registry, runId };
}

function fakeDeps(registry: RunRegistry, controlView?: WorkflowRunView): FlowDeps {
	const runtime: RuntimeAdapter = {
		start: async () => ({ runId: "x", status: "running" }),
		control: async () => ({
			run:
				controlView ??
				({
					runId: "x",
					scriptId: "s",
					scriptName: "audit",
					status: "paused",
					digest: "d",
					createdAt: "2026-08-05T12:00:00Z",
					stages: [],
					budget: { agentCalls: 0, pipelineCalls: 0, parallelCalls: 0, estimatedAgents: 0, writeRisk: false, warnLargeRun: false },
				} as WorkflowRunView),
		}),
	};
	return {
		engine: null,
		approvals: {} as ApprovalStore,
		registry,
		getProjectPath: () => "C:\\proj",
		runtime,
	};
}

test("parseWorkflowsArgs: no args -> list, runId -> detail, --filter -> filtered list", () => {
	assert.deepEqual(parseWorkflowsArgs(""), { kind: "list" });
	assert.deepEqual(parseWorkflowsArgs("   "), { kind: "list" });
	assert.deepEqual(parseWorkflowsArgs("a1b2c3d4"), { kind: "detail", runId: "a1b2c3d4" });
	assert.deepEqual(parseWorkflowsArgs("--filter running"), { kind: "list", status: "running" });
	assert.deepEqual(parseWorkflowsArgs("--filter bogus"), { kind: "list" });
	assert.deepEqual(parseWorkflowsArgs("help"), { kind: "help" });
	assert.deepEqual(parseWorkflowsArgs("--unknown"), { kind: "help" });
});

test("parseControlArgs: restart requires taskId, stop's agentId is optional", () => {
	assert.deepEqual(parseControlArgs("pause", ""), { ok: false, usage: "Usage: /workflows:pause <runId>" });
	assert.deepEqual(parseControlArgs("pause", "abc"), { ok: true, runId: "abc", agentId: undefined });
	assert.deepEqual(parseControlArgs("stop", "abc t1"), { ok: true, runId: "abc", agentId: "t1" });
	assert.deepEqual(parseControlArgs("stop", "abc"), { ok: true, runId: "abc", agentId: undefined });
	assert.deepEqual(parseControlArgs("restart_agent", "abc"), { ok: false, usage: "Usage: /workflows:restart <runId> <taskId>" });
	assert.deepEqual(parseControlArgs("restart_agent", "abc t1"), { ok: true, runId: "abc", agentId: "t1" });
});

test("resolveRunId: exact id, 8-char prefix, ambiguous prefix", () => {
	const { store, runId } = makeStore();
	assert.equal(resolveRunId(store, runId), runId);
	assert.equal(resolveRunId(store, runId.slice(0, 8)), runId);
	assert.equal(resolveRunId(store, "zzzzzzzz"), undefined);
});

test("runControlAction: unknown run -> RUN_NOT_FOUND text", async () => {
	const { store, registry } = makeStore();
	const out = await runControlAction(fakeDeps(registry), store, "pause", "nope");
	assert.equal(out.ok, false);
	assert.ok(out.text.includes("RUN_NOT_FOUND"));
});

test("runControlAction: restart without taskId fails fast", async () => {
	const { store, registry, runId } = makeStore();
	const out = await runControlAction(fakeDeps(registry), store, "restart_agent", runId);
	assert.equal(out.ok, false);
	assert.ok(out.text.includes("taskId"));
});

test("runControlAction: pause merges the returned { run } view into the store", async () => {
	const { store, registry, runId } = makeStore();
	const view: WorkflowRunView = {
		runId,
		scriptId: "s",
		scriptName: "audit",
		status: "paused",
		digest: "d",
		createdAt: "2026-08-05T12:00:00Z",
		stages: [{ stageId: "s1", label: "discover", kind: "agent", agentCount: 1, writeRisk: false }],
		budget: { agentCalls: 1, pipelineCalls: 0, parallelCalls: 0, estimatedAgents: 1, writeRisk: false, warnLargeRun: false },
	};
	const out = await runControlAction(fakeDeps(registry, view), store, "pause", runId.slice(0, 8));
	assert.equal(out.ok, true);
	assert.ok(out.text.includes("pause ok"));
	assert.equal(store.getDetail(runId)!.status, "paused");
});

test("runControlAction: runtime error surfaces the { code, message } contract", async () => {
	const { store, registry, runId } = makeStore();
	const runtime: RuntimeAdapter = {
		start: async () => ({ runId, status: "running" }),
		control: async () => {
			throw new Error("boom");
		},
	};
	const deps: FlowDeps = {
		engine: null,
		approvals: {} as ApprovalStore,
		registry,
		getProjectPath: () => "C:\\proj",
		runtime,
	};
	const out = await runControlAction(deps, store, "stop", runId);
	assert.equal(out.ok, false);
	assert.ok(out.text.includes("RUN_NOT_CONTROLLABLE"));
});

test("help text lists both commands and shortcuts (keyboard AND commands reachable)", () => {
	const help = workflowsHelpText();
	assert.ok(help.includes("/workflows:pause"));
	assert.ok(help.includes("/workflows:stop"));
	assert.ok(help.includes("/workflows:restart"));
	assert.ok(help.includes("/workflows:save"));
	assert.ok(help.includes("/workflows:approve"));
	assert.ok(help.includes("/workflow-delete"));
	assert.ok(help.includes("ctrl+alt+p"));
	assert.ok(help.includes("ctrl+alt+x"));
	assert.ok(help.includes("ctrl+alt+r"));
});

// ---------- /workflows:approve (runApproveAction) ----------

/** Store + registry with the run left in awaiting_approval (approve target). */
function makeApproveStore(): { store: MemoryRunStore; registry: RunRegistry; runId: string } {
	const store = new MemoryRunStore({ nowMs: () => Date.parse("2026-08-05T12:00:00Z") });
	const registry = new RunRegistry();
	const plan = {
		stages: [{ stageId: "s1", label: "discover", kind: "agent" as const, agentCount: 1, writeRisk: false }],
		budget: { agentCalls: 1, pipelineCalls: 0, parallelCalls: 0, estimatedAgents: 1, writeRisk: false, warnLargeRun: false },
	};
	const run = registry.create("src", { name: "audit" }, plan, "2026-08-05T12:00:00Z");
	const runId = run.runId;
	store.hydrateRun(registry.getRun(runId)!, registry.getScript(runId)!, registry.getPlan(runId)!);
	store.feedEvent({ type: "run_status", runId, status: "awaiting_approval", at: "2026-08-05T12:00:00Z" });
	return { store, registry, runId };
}

/** Approve-capable deps: real ApprovalStore + a tracking runtime. */
function approveDeps(registry: RunRegistry): { deps: FlowDeps; startCalls: { n: number } } {
	const startCalls = { n: 0 };
	const runtime: RuntimeAdapter = {
		start: async () => {
			startCalls.n++;
			return { runId: "x", status: "running" };
		},
		control: async () => {
			throw new Error("not implemented");
		},
	};
	const deps: FlowDeps = {
		engine: null,
		approvals: new ApprovalStore(),
		registry,
		getProjectPath: () => "C:\\proj",
		runtime,
	};
	return { deps, startCalls };
}

function approveCtx(select: () => Promise<string | undefined>): {
	hasUI: true;
	ui: { select: typeof select; notify: (text: string, type: string) => void };
	notifyCalls: Array<{ text: string; type: string }>;
} {
	const notifyCalls: Array<{ text: string; type: string }> = [];
	return {
		hasUI: true,
		notifyCalls,
		ui: {
			select,
			notify: (text, type) => {
				notifyCalls.push({ text, type });
			},
		},
	};
}

test("runApproveAction: once-decision starts the awaiting run", async () => {
	const { store, registry, runId } = makeApproveStore();
	const { deps, startCalls } = approveDeps(registry);
	let selectCalls = 0;
	const out = await runApproveAction(deps, store, runId, approveCtx(async () => {
		selectCalls++;
		return "Run once";
	}) as never);
	assert.equal(out.ok, true);
	assert.ok(out.text.includes("workflow started"));
	assert.equal(selectCalls, 1, "card must be shown once");
	assert.equal(startCalls.n, 1, "runtime must start the run");
	assert.equal(registry.getRun(runId)?.status, "running");
});

test("runApproveAction: already once-approved run skips the card and starts", async () => {
	const { store, registry, runId } = makeApproveStore();
	const { deps, startCalls } = approveDeps(registry);
	registry.markOnceApproved(runId);
	let selectCalls = 0;
	const out = await runApproveAction(deps, store, runId, approveCtx(async () => {
		selectCalls++;
		return "Run once";
	}) as never);
	assert.equal(out.ok, true);
	assert.equal(selectCalls, 0, "once approval must skip the card");
	assert.equal(startCalls.n, 1);
});

test("runApproveAction: reject cancels the run and does not start", async () => {
	const { store, registry, runId } = makeApproveStore();
	const { deps, startCalls } = approveDeps(registry);
	const out = await runApproveAction(deps, store, runId, approveCtx(async () => "Reject") as never);
	assert.equal(out.ok, false);
	assert.ok(out.text.includes("rejected"));
	assert.equal(startCalls.n, 0, "rejected run must not start");
	assert.equal(registry.getRun(runId)?.status, "cancelled");
});

test("runApproveAction: dismissed card leaves the run pending", async () => {
	const { store, registry, runId } = makeApproveStore();
	const { deps, startCalls } = approveDeps(registry);
	const out = await runApproveAction(deps, store, runId, approveCtx(async () => undefined) as never);
	assert.equal(out.ok, false);
	assert.ok(out.text.includes("Approval pending"));
	assert.equal(startCalls.n, 0);
	assert.equal(registry.getRun(runId)?.status, "awaiting_approval");
});

test("runApproveAction: non-awaiting run is refused", async () => {
	const { store, registry, runId } = makeStore(); // status = running
	const { deps, startCalls } = approveDeps(registry);
	const out = await runApproveAction(deps, store, runId, approveCtx(async () => "Run once") as never);
	assert.equal(out.ok, false);
	assert.ok(out.text.includes("only awaiting_approval"));
	assert.equal(startCalls.n, 0);
});

test("runApproveAction: unknown ref -> RUN_NOT_FOUND", async () => {
	const { store, registry } = makeApproveStore();
	const { deps, startCalls } = approveDeps(registry);
	const out = await runApproveAction(deps, store, "nope", approveCtx(async () => "Run once") as never);
	assert.equal(out.ok, false);
	assert.ok(out.text.includes("RUN_NOT_FOUND"));
	assert.equal(startCalls.n, 0);
});
