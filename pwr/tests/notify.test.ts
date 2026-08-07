import { test } from "node:test";
import assert from "node:assert/strict";
import { RunNotifier, type SendMessageFn } from "../src/notify.ts";
import { controlWorkflow, saveWorkflow, startWorkflow, validateWorkflow, RunRegistry, type FlowDeps } from "../src/flow.ts";
import { ApprovalStore } from "../src/approval.ts";
import { ErrorCode } from "../src/errors.ts";
import { structuralGate } from "../src/engine.ts";
import type { RuntimeAdapter } from "../src/types.ts";

const VALID = `
export const meta = { name: 'audit', version: 1 };
const files = await agent('list', { label: 'discover', tools: 'readonly' });
return await agent('summarize', { label: 'verify' });
`;

function makeNotifier() {
	const sent: Array<{
		content: string;
		details?: Record<string, unknown>;
		options: { triggerTurn: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" };
	}> = [];
	const settleHandlers: Array<(runId: string) => void> = [];
	const notifier = new RunNotifier(
		((message, options) => {
			sent.push({ content: message.content, details: message.details, options });
		}) as SendMessageFn,
		{ onRunSettled: (handler) => settleHandlers.push(handler) },
	);
	return {
		notifier,
		sent,
		settle: (runId: string) => settleHandlers.forEach((h) => h(runId)),
	};
}

test("final summary is NOT delivered before the run settles", () => {
	const { notifier, sent } = makeNotifier();
	notifier.queue("r1", "audit", "final result");
	assert.equal(sent.length, 0);
	assert.equal(notifier.hasPending(), true);
});

test("final summary is delivered only when ITS OWN run settles", () => {
	const { notifier, sent, settle } = makeNotifier();
	notifier.queue("r1", "audit", "final result r1");
	notifier.queue("r2", "audit2", "final result r2");

	// run r2 settles first: only r2's summary is delivered, r1 stays pending
	settle("r2");
	assert.equal(sent.length, 1);
	assert.ok(sent[0]!.content.includes("final result r2"));
	assert.equal(sent[0]!.details?.runId, "r2");
	assert.equal(notifier.hasPending(), true, "r1 must still be pending");

	settle("r1");
	assert.equal(sent.length, 2);
	assert.ok(sent[1]!.content.includes("final result r1"));
	assert.equal(notifier.hasPending(), false);
});

test("a settle for an unrelated run never flushes other pending results", () => {
	const { notifier, sent, settle } = makeNotifier();
	notifier.queue("r1", "audit", "final result r1");
	settle("unknown-run");
	settle("another-run");
	assert.equal(sent.length, 0);
	assert.equal(notifier.hasPending(), true);
	assert.equal(notifier.hasSettled("r1"), false, "r1 is not marked settled by foreign events");
});

test("summary arriving AFTER its run settled is still delivered", () => {
	const { notifier, sent, settle } = makeNotifier();
	settle("r1"); // settle first (e.g. runtime delivers summary late)
	notifier.queue("r1", "audit", "late summary");
	assert.equal(sent.length, 1);
	assert.ok(sent[0]!.content.includes("late summary"));
	assert.equal(notifier.hasPending(), false);
});

test("delivered result wakes the main agent", () => {
	const { notifier, sent, settle } = makeNotifier();
	notifier.queue("r1", "audit", "final result");
	settle("r1");
	assert.equal(sent.length, 1);
	assert.deepEqual(sent[0]!.options, { triggerTurn: true, deliverAs: "followUp" });
});

test("queueFailure delivers a failure message that wakes the main agent", () => {
	const { notifier, sent, settle } = makeNotifier();
	notifier.queueFailure("r1", "audit", "AGENT_EXECUTION_ERROR", "boom");
	settle("r1");
	assert.equal(sent.length, 1);
	assert.ok(sent[0]!.content.includes("failed"));
	assert.ok(sent[0]!.content.includes("AGENT_EXECUTION_ERROR: boom"));
	assert.ok(sent[0]!.content.includes("r1"));
	assert.deepEqual(sent[0]!.options, { triggerTurn: true, deliverAs: "followUp" });
});

test("queueFailure without error fields falls back", () => {
	const { notifier, sent, settle } = makeNotifier();
	notifier.queueFailure("r1", "audit");
	settle("r1");
	assert.equal(sent.length, 1);
	assert.ok(sent[0]!.content.includes("unknown error"));
});

test("control: run not found -> RUN_NOT_FOUND", async () => {
	const registry = new RunRegistry();
	const deps: FlowDeps = {
		engine: structuralGate,
		approvals: new ApprovalStore(),
		registry,
		getProjectPath: () => "C:/proj",
		runtime: null,
	};
	const result = await controlWorkflow(deps, { runId: "nope", action: "pause" });
	assert.ok("code" in result);
	assert.equal(result.code, ErrorCode.RUN_NOT_FOUND);
});

test("control: running run delegates to runtime adapter", async () => {
	const registry = new RunRegistry();
	const calls: string[] = [];
	const runtime: RuntimeAdapter = {
		async start(spec) {
			return { runId: spec.runId, status: "running" };
		},
		async control(input) {
			calls.push(input.action);
			return { run: { runId: input.runId, status: "running" } as never };
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

	const result = await controlWorkflow(deps, { runId: v.runId, action: "pause" });
	assert.ok(!("code" in result));
	assert.deepEqual(calls, ["pause"]);
	assert.equal(result.run.status, "running", "PRD §6.2: success carries { run }");
});

test("save: no save adapter -> RUN_NOT_CONTROLLABLE", async () => {
	const registry = new RunRegistry();
	const deps: FlowDeps = {
		engine: structuralGate,
		approvals: new ApprovalStore(),
		registry,
		getProjectPath: () => "C:/proj",
		runtime: null,
	};
	const result = await saveWorkflow(deps, { runId: "r", scope: "user", name: "x" });
	assert.ok("code" in result);
	assert.equal(result.code, ErrorCode.RUN_NOT_CONTROLLABLE);
});

test("save: adapter NAME_CONFLICT propagates", async () => {
	const registry = new RunRegistry();
	const deps: FlowDeps & { saveAdapter?: unknown } = {
		engine: structuralGate,
		approvals: new ApprovalStore(),
		registry,
		getProjectPath: () => "C:/proj",
		runtime: null,
		saveAdapter: {
			async save() {
				return { code: ErrorCode.NAME_CONFLICT, message: "exists" };
			},
		},
	};
	const v = await validateWorkflow(deps as FlowDeps, { source: VALID });
	if ("code" in v) throw new Error("validate failed");
	const result = await saveWorkflow(deps as never, { runId: v.runId, scope: "user", name: "dup" });
	assert.ok("code" in result);
	assert.equal(result.code, ErrorCode.NAME_CONFLICT);
});
