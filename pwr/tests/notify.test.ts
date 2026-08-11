import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { RunNotifier, truncateJsonSummary, type SendMessageFn } from "../src/notify.ts";
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

function makeNotifier(options?: { resultDir?: string }) {
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
		options,
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

// ------------------------------------------------------------------
// over-8KB final results: full JSON to disk + preview/path in message
// ------------------------------------------------------------------

const BIG_RESULT = () =>
	JSON.stringify({ repos: Array.from({ length: 400 }, (_, i) => ({ name: "repo-" + i, analysis: "x".repeat(100) })) });

function previewOf(content: string): string {
	// Message layout: "<header>\n\n<preview>[<path line>]" — preview is JSON.
	const marker = content.indexOf("\n\n完整结果:");
	const body = marker === -1 ? content : content.slice(0, marker);
	return body.slice(body.indexOf("{"));
}

test("over-8KB JSON results are written to the results file and the message carries the path (message ≤ 16KB)", () => {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pwr-result-"));
	try {
		const { notifier, sent, settle } = makeNotifier({ resultDir: tmpDir });
		const big = BIG_RESULT();
		assert.ok(Buffer.byteLength(big, "utf8") > 8 * 1024, "fixture must exceed the inline limit");
		notifier.queue("r1", "audit", big);
		settle("r1");
		assert.equal(sent.length, 1);
		const content = sent[0]!.content;
		assert.ok(content.includes("完整结果:"), "message carries the 完整结果 path line");
		assert.ok(content.includes(path.join(tmpDir, "r1.json")), "path points at the run's results file");
		assert.ok(Buffer.byteLength(content, "utf8") <= 16 * 1024, "message stays within the 16KB budget");
		const parsed = JSON.parse(previewOf(content)) as { __pwr_truncated__?: boolean };
		assert.equal(parsed.__pwr_truncated__, true, "preview is JSON-safe with the truncation marker");
		assert.equal(
			fs.readFileSync(path.join(tmpDir, "r1.json"), "utf8"),
			big,
			"the results file carries the FULL untruncated JSON",
		);
	} finally {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	}
});

test("over-8KB summary without a results dir still delivers a parseable JSON preview", () => {
	const { notifier, sent, settle } = makeNotifier();
	notifier.queue("r1", "audit", BIG_RESULT());
	settle("r1");
	assert.equal(sent.length, 1);
	const content = sent[0]!.content;
	assert.ok(!content.includes("完整结果:"), "no path line without a results dir");
	const parsed = JSON.parse(previewOf(content)) as { __pwr_truncated__?: boolean };
	assert.equal(parsed.__pwr_truncated__, true, "preview stays JSON-safe without a results dir");
});

test("results-file write failure degrades to preview-only delivery", () => {
	const blocker = path.join(os.tmpdir(), `pwr-result-blocker-${process.pid}.json`);
	fs.writeFileSync(blocker, "");
	try {
		// resultDir points AT an existing file → mkdirSync throws → degrade.
		const { notifier, sent, settle } = makeNotifier({ resultDir: blocker });
		notifier.queue("r1", "audit", BIG_RESULT());
		settle("r1");
		assert.equal(sent.length, 1, "message still delivered on write failure");
		const content = sent[0]!.content;
		assert.ok(!content.includes("完整结果:"), "no path line when the file could not be written");
		const parsed = JSON.parse(previewOf(content)) as { __pwr_truncated__?: boolean };
		assert.equal(parsed.__pwr_truncated__, true, "preview still parseable on write failure");
	} finally {
		fs.rmSync(blocker, { force: true });
	}
});

// ------------------------------------------------------------------
// truncateJsonSummary
// ------------------------------------------------------------------

test("truncateJsonSummary: object root stays valid JSON with the __pwr_truncated__ marker", () => {
	const out = truncateJsonSummary(BIG_RESULT(), 8192);
	assert.ok(out.startsWith("{"), "object root preserved");
	assert.ok(Buffer.byteLength(out, "utf8") <= 8192);
	const parsed = JSON.parse(out) as { __pwr_truncated__?: boolean };
	assert.equal(parsed.__pwr_truncated__, true);
	// Under-budget roots pass through untouched (no marker) and stay parseable.
	assert.equal(truncateJsonSummary("{}", 8192), "{}");
	assert.equal(JSON.parse(truncateJsonSummary("{}", 8192)).__pwr_truncated__, undefined);
});

test("truncateJsonSummary: array root appends a marker object element; scalar roots fall back to the text marker", () => {
	const arr = JSON.stringify(Array.from({ length: 4000 }, (_, i) => ({ name: "r" + i, body: "x".repeat(80) })));
	const out = truncateJsonSummary(arr, 8192);
	const parsed = JSON.parse(out) as Array<{ __pwr_truncated__?: boolean }>;
	assert.deepEqual(parsed[parsed.length - 1], { __pwr_truncated__: true }, "marker is the last array element");
	assert.ok(Buffer.byteLength(out, "utf8") <= 8192);
	assert.equal(truncateJsonSummary("[]", 8192), "[]", "empty array passes through");
	// Scalar root: no JSON reconstruction (would fabricate data) — text marker.
	const scalar = truncateJsonSummary("x".repeat(20 * 1024), 8192);
	assert.ok(scalar.endsWith("[Summary truncated.]"));
	assert.ok(Buffer.byteLength(scalar, "utf8") <= 8192);
});

test("truncateJsonSummary: under-cap passthrough and UTF-8 byte safety", () => {
	assert.equal(truncateJsonSummary("短", 8192), "短");
	assert.equal(truncateJsonSummary('{"ok":true}', 8192), '{"ok":true}', "small JSON passes through unmangled");
	const big = "汉".repeat(100_000);
	const truncated = truncateJsonSummary(big, 8192);
	assert.ok(Buffer.byteLength(truncated, "utf8") <= 8192);
	assert.ok(!truncated.includes("\uFFFD"), "no replacement characters — multi-byte chars never split");
});
