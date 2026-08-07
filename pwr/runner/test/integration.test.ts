/**
 * Integration tests (JHL-14): PiAgentRunner wired into WorkflowRuntime.
 *
 * Uses the mock spawn factory — no real child processes. Verifies the
 * adapter's errors surface through the runtime as task error codes and
 * that restart_agent re-dispatches through the adapter with attempt+1.
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { PiAgentRunner } from "../index.ts";
import { WorkflowRuntime, type AgentTask } from "../../runtime/index.ts";
import { MemoryPersister } from "../../runtime/persist.ts";
import type { WorkflowScript } from "../../src/types.ts";
import { makeFakeSpawn, messageEndLine, waitForChild, type FakeSpawnHandle } from "./helpers.ts";

const SOURCE = [
	"export const meta = { name: 'demo', version: 1 }",
	"const a = await agent('first', { label: 's1' })",
	"return a",
].join("\n");

/** Two sequential agents: lets a restart_agent target a COMPLETED task while another is in flight. */
const TWO_AGENT_SOURCE = [
	"export const meta = { name: 'demo2', version: 1 }",
	"const a = await agent('first', { label: 's1' })",
	"const b = await agent('second', { label: 's2' })",
	"return b",
].join("\n");

function makeScript(): WorkflowScript {
	// Stable digest across calls so cache replay keys match (PRD: cache key
	// = script digest + normalized input).
	return {
		scriptId: "script-demo",
		digest: "digest-demo",
		source: SOURCE,
		meta: { name: "demo", version: 1 },
		astVersion: "1",
	};
}

function makeRunner(handle: FakeSpawnHandle): PiAgentRunner {
	const runner = new PiAgentRunner({ now: () => "2026-08-05T12:00:00.000Z" });
	runner.setSpawn(handle.spawn);
	return runner;
}

async function waitSettled(rt: WorkflowRuntime, runId: string): Promise<void> {
	for (let i = 0; i < 100; i++) {
		const view = rt.view(runId);
		if (view.status === "completed" || view.status === "failed" || view.status === "cancelled") return;
		await new Promise((r) => setTimeout(r, 10));
	}
	throw new Error("run did not settle");
}

test("runtime + adapter: successful agent execution completes the run", async () => {
	const handle = makeFakeSpawn();
	const runner = makeRunner(handle);
	const rt = new WorkflowRuntime({ runner, persister: new MemoryPersister(), now: () => "2026-08-05T12:00:00.000Z" });

	let finalSummary = "";
	const runId = randomUUID();
	await rt.start({ runId, script: makeScript(), onFinalResult: (s) => (finalSummary = s) });
	// Let the interpreter run: it awaits the agent which blocks on the child.
	const child = await waitForChild(handle);
	child.emitLine(messageEndLine("assistant", { content: [{ type: "text", text: '{"ok":true}' }] }));
	child.emitClose(0);

	await waitSettled(rt, runId);
	const view = rt.view(runId);
	assert.equal(view.status, "completed");
	assert.ok(view.summary && view.summary.length > 0);
	assert.equal(view.errorCode, undefined);
	const task = view.tasks[0] as AgentTask | undefined;
	assert.ok(task);
	assert.equal(task.status, "completed");
	assert.equal(task.attempt, 1);
	assert.ok(finalSummary.length > 0, "onFinalResult must deliver the final summary");
});

test("runtime + adapter: restart_agent invalidates cache, re-executes via the adapter on rerun", async () => {
	const handle = makeFakeSpawn();
	const runner = makeRunner(handle);
	const rt = new WorkflowRuntime({ runner, persister: new MemoryPersister(), now: () => "2026-08-05T12:00:00.000Z" });

	const runId = randomUUID();
	await rt.start({ runId, script: makeScript() });

	// First completion.
	const child1 = await waitForChild(handle, 0);
	child1.emitLine(messageEndLine("assistant", { content: [{ type: "text", text: "first" }] }));
	child1.emitClose(0);
	await waitSettled(rt, runId);
	assert.equal(rt.view(runId).status, "completed");

	// Fresh run of the same script (same input digest) replays from cache
	// unless we restart the agent — verify cache replay does NOT spawn.
	const runId2 = randomUUID();
	await rt.start({ runId: runId2, script: makeScript() });
	await waitSettled(rt, runId2);
	assert.equal(rt.view(runId2).status, "completed");
	assert.equal(handle.records.length, 1, "cache replay must not spawn a new child");

	// restart_agent on the completed run is rejected (PRD 5.3: terminal
	// runs are view/save/run_again only).
	await assert.rejects(
		() => rt.control({ runId: runId2, action: "restart_agent", agentId: rt.view(runId2).tasks[0].taskId }),
		(err) => {
			assert.equal((err as { code?: string }).code, "RUN_NOT_CONTROLLABLE");
			return true;
		},
	);

	// Restart an ALREADY COMPLETED task while the run is still in flight
	// (second agent running): cache invalidated, task queued, attempt++
	// (audit preserved). The first agent re-executes via the adapter when
	// the run is re-run.
	const runId3 = randomUUID();
	const script3: WorkflowScript = {
		scriptId: "script-demo-3",
		digest: "digest-demo-3",
		source: TWO_AGENT_SOURCE,
		meta: { name: "demo2", version: 1 },
		astVersion: "1",
	};
	await rt.start({ runId: runId3, script: script3 });
	const childFirst = await waitForChild(handle, 1);
	childFirst.emitLine(messageEndLine("assistant", { content: [{ type: "text", text: "first" }] }));
	childFirst.emitClose(0);
	const childSecond = await waitForChild(handle, 2);
	const firstTask = rt.view(runId3).tasks.find((t) => t.label === "s1")!;
	assert.equal(firstTask.status, "completed");
	assert.equal(firstTask.attempt, 1);
	await rt.control({ runId: runId3, action: "restart_agent", agentId: firstTask.taskId });
	const queuedFirst = rt.view(runId3).tasks.find((t) => t.label === "s1")!;
	assert.equal(queuedFirst.status, "queued");
	assert.equal(queuedFirst.attempt, 2, "restart increments the attempt audit counter");

	// The in-flight second agent settles; the run completes.
	childSecond.emitLine(messageEndLine("assistant", { content: [{ type: "text", text: "second" }] }));
	childSecond.emitClose(0);
	await waitSettled(rt, runId3);
	assert.equal(rt.view(runId3).status, "completed");

	// Re-run the script: the invalidated first-task cache forces a REAL
	// dispatch through the adapter (new child process), attempt stays at 2;
	// the second task replays from cache (no spawn).
	await rt.restart(runId3);
	const childRetry = await waitForChild(handle, 3);
	assert.ok(childRetry, "re-run after restart_agent must spawn a new child pi process for the restarted task");
	childRetry.emitLine(messageEndLine("assistant", { content: [{ type: "text", text: "first again" }] }));
	childRetry.emitClose(0);
	await waitSettled(rt, runId3);
	const taskAfter = rt.view(runId3).tasks.find((t) => t.label === "s1") as AgentTask | undefined;
	assert.ok(taskAfter);
	assert.equal(taskAfter.attempt, 2, "attempt audit counter is preserved");
	assert.equal(taskAfter.status, "completed");
	assert.equal(rt.view(runId3).status, "completed");
	assert.equal(handle.records.length, 4, "3 real dispatches + 1 restarted re-execution, no cache replay for the restarted task");
});
