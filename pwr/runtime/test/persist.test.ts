/**
 * PWR runtime — persistence unit tests (PRD 6.1)
 *
 * The `pi-workflow-run-v1` entry must only carry metadata/status/summary/
 * cache index — never source, prompts, raw output or credentials.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { MemoryPersister, sanitizeUsage, serializeRunEntry, truncateError, truncateSummary } from "../persist.ts";
import type { RunEntryPayload } from "../persist.ts";
import type { AgentTask, WorkflowRun } from "../types.ts";

const run: WorkflowRun = {
	runId: "run-1",
	scriptId: "script-1",
	digest: "abc123",
	meta: { name: "audit", description: "audit routes", version: 1 },
	status: "completed",
	createdAt: "2026-08-05T00:00:00.000Z",
	startedAt: "2026-08-05T00:00:01.000Z",
	endedAt: "2026-08-05T00:00:02.000Z",
	summary: '{"ok":true}',
	errorMessage: "run boom",
	concurrency: 4,
	maxAgents: 1000,
	agentExecutions: 3,
};

const tasks: AgentTask[] = [
	{
		taskId: "t1",
		stageId: "stage-1",
		label: "discover",
		inputDigest: "key1",
		status: "completed",
		attempt: 1,
		summary: "found 3 files",
		usage: { inputTokens: 100, weird: "must-not-persist", nested: { a: 1 } } as unknown as Record<string, number>,
		startedAt: "2026-08-05T00:00:01.000Z",
		endedAt: "2026-08-05T00:00:01.500Z",
	},
	{
		taskId: "t2",
		stageId: "stage-2",
		label: "verify",
		inputDigest: "key2",
		status: "failed",
		attempt: 2,
		errorCode: "SCRIPT_RUNTIME_ERROR",
		errorMessage: "boom detail",
		startedAt: "2026-08-05T00:00:01.600Z",
	},
];

test("entry version and structure", () => {
	const entry = serializeRunEntry(run, tasks);
	assert.equal(entry.entryVersion, "pi-workflow-run-v1");
	assert.equal(entry.runId, "run-1");
	assert.equal(entry.status, "completed");
	assert.equal(entry.digest, "abc123");
	assert.deepEqual(entry.budget, { agentCalls: 3, maxAgents: 1000, concurrency: 4 });
	assert.equal(entry.cacheIndex.length, 2);
	assert.equal(entry.errorMessage, "run boom");
	const failed = entry.cacheIndex.find((c) => c.taskId === "t2")!;
	assert.equal(failed.errorCode, "SCRIPT_RUNTIME_ERROR");
	assert.equal(failed.errorMessage, "boom detail");
});

test("entry never leaks source, prompts, raw output or credentials", () => {
	const entry = serializeRunEntry(run, tasks);
	const serialized = JSON.stringify(entry);
	assert.ok(!("source" in entry), "no script source field");
	assert.ok(!serialized.includes("full subagent prompt"), "no prompts");
	assert.ok(!serialized.includes("weird"), "non-numeric usage dropped");
	assert.ok(!serialized.includes("nested"), "nested usage dropped");
	assert.ok(!serialized.includes("API_KEY"), "no credentials");
	assert.ok(!serialized.includes("process.env"), "no env access");
	for (const item of entry.cacheIndex) {
		assert.ok(!("result" in item), "cache index items never carry results");
	}
});

test("MemoryPersister keeps every persisted snapshot (every transition)", () => {
	const persister = new MemoryPersister();
	persister.persist(serializeRunEntry({ ...run, status: "queued" }, []));
	persister.persist(serializeRunEntry({ ...run, status: "running" }, []));
	persister.persist(serializeRunEntry(run, tasks));
	assert.equal(persister.snapshots().length, 3);
	const statuses = persister.snapshots().map((e) => e.status);
	assert.deepEqual(statuses, ["queued", "running", "completed"]);
	assert.equal(persister.latest()?.cacheIndex.length, 2);
	persister.clear();
	assert.equal(persister.snapshots().length, 0);
});

test("truncateSummary is UTF-8 byte-safe", () => {
	const small = "short summary";
	assert.equal(truncateSummary(small), small);
	// 8 KB limit: multibyte chars must never split mid-character.
	const big = "汉".repeat(100_000);
	const truncated = truncateSummary(big);
	assert.ok(Buffer.byteLength(truncated, "utf8") <= 8192);
	assert.ok(truncated.endsWith("[Summary truncated.]"));
	assert.ok(!truncated.includes("\uFFFD"), "no replacement characters");
});

test("truncateError is UTF-8 byte-safe and caps at 8 KB", () => {
	assert.equal(truncateError("short boom"), "short boom");
	const big = "汉".repeat(100_000);
	const truncated = truncateError(big);
	assert.ok(Buffer.byteLength(truncated, "utf8") <= 8192);
	assert.ok(truncated.endsWith("[Error truncated.]"));
	assert.ok(!truncated.includes("\uFFFD"), "no replacement characters");
	const overlong = serializeRunEntry(run, [
		{ ...tasks[1]!, errorMessage: "x".repeat(100_000) },
	]);
	const cached = overlong.cacheIndex.find((c) => c.taskId === "t2")!;
	assert.ok(Buffer.byteLength(cached.errorMessage!, "utf8") <= 8192);
	assert.ok(cached.errorMessage!.endsWith("[Error truncated.]"));
});

test("sanitizeUsage keeps finite numbers only", () => {
	assert.deepEqual(sanitizeUsage({ inputTokens: 1, outputTokens: 2.5 }), { inputTokens: 1, outputTokens: 2.5 });
	assert.deepEqual(sanitizeUsage({ inputTokens: 1, bad: "x", flag: true, nested: { a: 1 }, nan: Number.NaN, inf: Infinity }), {
		inputTokens: 1,
	});
	assert.equal(sanitizeUsage(undefined), undefined);
	assert.equal(sanitizeUsage({ only: "string" }), undefined);
	assert.equal(sanitizeUsage("nope"), undefined);
});

test("entry NEVER persists run args (sensitive or not)", () => {
	const secret = "sk-live-0123456789abcdefSECRET";
	const args = { files: ["a.ts"], token: secret, password: "hunter2" };
	const entry = serializeRunEntry({ ...run, args }, []);
	assert.ok(!("args" in entry), "args field must be structurally absent (PRD §6.1)");
	const serialized = JSON.stringify(entry);
	assert.ok(!serialized.includes(secret), "credential values never enter persisted entries");
	assert.ok(!serialized.includes("token"), "no args field names either");
	assert.ok(!serialized.includes("hunter2"), "no password value either");
});

test("missing optional fields stay absent", () => {
	const minimal = serializeRunEntry({ ...run, summary: undefined, startedAt: undefined, endedAt: undefined }, []);
	const entry: RunEntryPayload = minimal;
	assert.equal(entry.summary, undefined);
	assert.equal(entry.startedAt, undefined);
	assert.equal(entry.endedAt, undefined);
	assert.ok(!("args" in entry));
});
