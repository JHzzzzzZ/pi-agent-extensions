/**
 * PWR runtime — end-to-end tests (JHL-13)
 *
 * Covers: state machine persistence, per-run concurrency cap (128 hard),
 * 1,000-agent budget, private cache reuse across pause/resume and re-runs,
 * resume without re-execution, stop/shutdown, final-summary delivery only
 * after settle, stage aggregation, restart_agent.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { WorkflowRuntime } from "../index.ts";
import type { AgentRunResult, AgentRunner, AgentRunSpec } from "../../engine/index.ts";
import { computeDigest } from "../../src/digest.ts";
import { RunnerError, RunnerErrorCodes } from "../../runner/errors.ts";
import { MemoryPersister } from "../persist.ts";
import type { WorkflowScript } from "../../src/types.ts";
import type { RuntimeRunView } from "../types.ts";

// ------------------------------------------------------------------
// helpers
// ------------------------------------------------------------------

function scriptOf(source: string): WorkflowScript {
	const digest = computeDigest(source);
	return { scriptId: digest, digest, source, meta: { name: "runtime-test", version: 1 }, astVersion: "1" };
}

/** Valid PWR script with the given body and a fixed final return. */
function makeScript(body: string, ret = "{ done: true }"): string {
	return `export const meta = { name: "runtime-test", version: 1 }
${body}
return ${ret};`;
}

class FakeRunner implements AgentRunner {
	readonly calls: string[] = [];
	readonly specs: AgentRunSpec[] = [];
	private active = 0;
	maxActive = 0;
	private readonly behavior: (spec: AgentRunSpec) => Promise<AgentRunResult> | AgentRunResult;

	constructor(
		behavior: (spec: AgentRunSpec) => Promise<AgentRunResult> | AgentRunResult = (spec) => ({
			result: { [spec.prompt]: "ok" },
			summary: "result ok",
		}),
	) {
		this.behavior = behavior;
	}

	async run(spec: AgentRunSpec): Promise<AgentRunResult> {
		this.active++;
		this.maxActive = Math.max(this.maxActive, this.active);
		this.calls.push(spec.prompt);
		this.specs.push(spec);
		try {
			return await this.behavior(spec);
		} finally {
			this.active--;
		}
	}
}

async function waitFor(check: () => boolean, timeoutMs = 8000): Promise<void> {
	const start = Date.now();
	while (!check()) {
		if (Date.now() - start > timeoutMs) throw new Error("waitFor timeout");
		await new Promise((r) => setTimeout(r, 5));
	}
}

async function waitForTerminal(runtime: WorkflowRuntime, runId: string): Promise<RuntimeRunView> {
	await waitFor(() => {
		const status = runtime.getRun(runId)?.status;
		return status === "completed" || status === "failed" || status === "cancelled";
	});
	return runtime.view(runId);
}

const SEQ_SCRIPT = makeScript(`const a = await agent("prompt-alpha", { label: "first" });
const b = await agent("prompt-beta", { label: "second" });
const c = await agent("prompt-gamma", { label: "third" });`);

// ------------------------------------------------------------------
// lifecycle
// ------------------------------------------------------------------

test("run lifecycle: queued → running → completed, summary delivered once after settle", async () => {
	const runner = new FakeRunner();
	const runtime = new WorkflowRuntime({ runner, maxActiveRuns: 1 });
	const summaries: string[] = [];
	const settled: string[] = [];
	runtime.onRunSettled((runId) => settled.push(runId));

	const started = await runtime.start({
		runId: "r1",
		script: scriptOf(SEQ_SCRIPT),
		onFinalResult: (summary) => summaries.push(summary),
	});
	assert.equal(started.status, "running");
	// start() enqueues synchronously; the FIFO dispatcher begins the run
	// in the same tick, so the observable post-start state is running.
	assert.equal(runtime.getRun("r1")?.status, "running");
	const view = await waitForTerminal(runtime, "r1");
	assert.equal(view.status, "completed");
	assert.equal(runner.calls.length, 3);
	assert.equal(summaries.length, 1, "final summary delivered exactly once");
	assert.ok(summaries[0]!.includes('"done"'), "summary carries the final return value");
	assert.deepEqual(settled, ["r1"], "per-run settle fired once");
	assert.equal(view.budget.agentCalls, 3);
	assert.equal(view.tasks.length, 3);
	assert.ok(view.tasks.every((t) => t.status === "completed" && t.attempt === 1));
	assert.equal(runtime.getRun("r1")?.startedAt !== undefined, true);
	assert.equal(runtime.getRun("r1")?.endedAt !== undefined, true);
});

test("agent() per-call model override reaches the runner (JHL-14 regression: dispatch dropped model)", async () => {
	const runner = new FakeRunner();
	const runtime = new WorkflowRuntime({ runner });
	const MODEL = "opencode-go/deepseek-v4-flash";
	const source = makeScript(`const a = await agent("audit routes", { label: "scan", model: "${MODEL}" });`);
	await runtime.start({ runId: "r1", script: scriptOf(source) });
	const view = await waitForTerminal(runtime, "r1");
	assert.equal(view.status, "completed");
	assert.equal(runner.specs.length, 1);
	assert.equal(runner.specs[0]!.model, MODEL, "per-call model override must be forwarded to the runner");
	assert.equal(runner.specs[0]!.prompt, "audit routes");
});

test("agent failure fails the run with the engine error code", async () => {
	const runner = new FakeRunner((spec) => {
		if (spec.prompt === "prompt-beta") throw new Error("boom");
		return { result: { ok: true }, summary: "result ok" };
	});
	const runtime = new WorkflowRuntime({ runner });
	const summaries: string[] = [];
	await runtime.start({ runId: "r1", script: scriptOf(SEQ_SCRIPT), onFinalResult: (s) => summaries.push(s) });
	const view = await waitForTerminal(runtime, "r1");
	assert.equal(view.status, "failed");
	assert.equal(view.errorCode, "SCRIPT_RUNTIME_ERROR");
	assert.equal(summaries.length, 0, "no final summary on failure");
	const betaTask = view.tasks.find((t) => t.label === "second");
	assert.equal(betaTask?.status, "failed");
	assert.equal(betaTask?.errorCode, "SCRIPT_RUNTIME_ERROR");
});

test("runner unavailable → failed with AGENT_RUNNER_UNAVAILABLE (never falls back)", async () => {
	const runtime = new WorkflowRuntime({});
	await runtime.start({ runId: "r1", script: scriptOf(SEQ_SCRIPT) });
	const view = await waitForTerminal(runtime, "r1");
	assert.equal(view.status, "failed");
	assert.equal(view.errorCode, "AGENT_RUNNER_UNAVAILABLE");
	const tasks = view.tasks;
	assert.equal(tasks.length, 1);
	assert.equal(tasks[0]?.status, "failed");
	assert.equal(tasks[0]?.errorCode, "AGENT_RUNNER_UNAVAILABLE");
});

// ------------------------------------------------------------------
// concurrency / budget
// ------------------------------------------------------------------

const PIPELINE_SCRIPT = makeScript(`const items = [0, 1, 2, 3, 4, 5, 6, 7];
const results = await pipeline(items, (x) => agent("work-" + x, { label: "bulk" }), { concurrency: 8 });
return { count: results.length };`);

test("pipeline never exceeds the per-run concurrency cap", async () => {
	const runner = new FakeRunner();
	const runtime = new WorkflowRuntime({ runner, concurrency: 2 });
	await runtime.start({ runId: "r1", script: scriptOf(PIPELINE_SCRIPT) });
	const view = await waitForTerminal(runtime, "r1");
	assert.equal(view.status, "completed");
	assert.equal(runner.calls.length, 8);
	assert.ok(runner.maxActive <= 2, `maxActive=${runner.maxActive} must not exceed run cap 2`);
	const bulk = view.stages.find((s) => s.label === "bulk")!;
	assert.equal(bulk.agentIds.length, 8);
	assert.equal(bulk.status, "completed");
});

test("requested concurrency clamps to the 128 hard cap", async () => {
	const runner = new FakeRunner();
	const runtime = new WorkflowRuntime({ runner, concurrency: 999 });
	assert.equal(runtime.getRun("r1"), undefined);
	const source = makeScript(`const items = [];
for (let i = 0; i < 300; i++) { items.push(i); }
const results = await pipeline(items, (x) => agent("w" + x), { concurrency: 1000 });
return { count: results.length };`);
	await runtime.start({ runId: "r1", script: scriptOf(source) });
	assert.equal(runtime.getRun("r1")?.concurrency, 128, "runtime clamps its own concurrency");
	const view = await waitForTerminal(runtime, "r1");
	assert.equal(view.status, "completed");
	assert.ok(runner.maxActive <= 128, `maxActive=${runner.maxActive} must not exceed 128`);
});

test("1,001st agent() call → AGENT_LIMIT_EXCEEDED, run fails", async () => {
	const runner = new FakeRunner();
	const runtime = new WorkflowRuntime({ runner });
	const calls = Array.from({ length: 1001 }, (_, i) => `await agent("n${i}");`).join("\n");
	const source = `export const meta = { name: "limit", version: 1 }\n${calls}\nreturn "done";`;
	await runtime.start({ runId: "r1", script: scriptOf(source) });
	const view = await waitForTerminal(runtime, "r1");
	assert.equal(view.status, "failed");
	assert.equal(view.errorCode, "AGENT_LIMIT_EXCEEDED");
	assert.equal(runner.calls.length, 1000, "exactly 1,000 dispatches happened before the cap");
	assert.equal(view.budget.agentCalls, 1000);
});

// ------------------------------------------------------------------
// private cache: reuse + resume without re-execution
// ------------------------------------------------------------------

test("same-session re-run with identical script replays cache (no re-execution)", async () => {
	const runner = new FakeRunner();
	const runtime = new WorkflowRuntime({ runner });
	await runtime.start({ runId: "r1", script: scriptOf(SEQ_SCRIPT) });
	await waitForTerminal(runtime, "r1");
	assert.equal(runner.calls.length, 3);

	await runtime.start({ runId: "r2", script: scriptOf(SEQ_SCRIPT) });
	const view2 = await waitForTerminal(runtime, "r2");
	assert.equal(view2.status, "completed");
	assert.equal(runner.calls.length, 3, "second run executed nothing — all cache hits");
	assert.equal(view2.budget.agentCalls, 0, "cache hits do not consume the agent budget");
	assert.equal(view2.tasks.length, 3, "cache-hit tasks are still visible per run");
	assert.ok(view2.tasks.every((t) => t.status === "completed" && t.attempt === 1));
});

test("different script digest → no cache reuse", async () => {
	const runner = new FakeRunner();
	const runtime = new WorkflowRuntime({ runner });
	const other = makeScript(`const a = await agent("prompt-alpha", { label: "first" });
const b = await agent("prompt-beta", { label: "second" });`);
	await runtime.start({ runId: "r1", script: scriptOf(SEQ_SCRIPT) });
	await waitForTerminal(runtime, "r1");
	await runtime.start({ runId: "r2", script: scriptOf(other) });
	await waitForTerminal(runtime, "r2");
	assert.equal(runner.calls.length, 5, "different digest re-executes everything");
});

test("pause aborts in-flight agent; resume replays cache and runs only unfinished items", async () => {
	const release = { beta: null as (() => void) | null };
	const runner = new FakeRunner((spec) => {
		if (spec.prompt === "prompt-beta") {
			return new Promise<AgentRunResult>((resolve, reject) => {
				const onAbort = () => {
					spec.signal?.removeEventListener("abort", onAbort);
					reject(new Error("cancelled"));
				};
				spec.signal?.addEventListener("abort", onAbort, { once: true });
				release.beta = () => {
					spec.signal?.removeEventListener("abort", onAbort);
					resolve({ result: { beta: "done" }, summary: "beta ok" });
				};
			});
		}
		return { result: { [spec.prompt]: "ok" }, summary: "result ok" };
	});
	const runtime = new WorkflowRuntime({ runner });
	const summaries: string[] = [];
	await runtime.start({
		runId: "r1",
		script: scriptOf(SEQ_SCRIPT),
		onFinalResult: (s) => summaries.push(s),
	});

	// alpha completes, beta is in flight
	await waitFor(() => runner.calls.includes("prompt-beta"));
	const paused = await runtime.control({ runId: "r1", action: "pause" });
	assert.equal(paused.run.status, "paused");
	assert.equal(runtime.getRun("r1")?.status, "paused");
	// cooperative cancellation of the in-flight task
	await waitFor(() => runtime.view("r1").tasks.find((t) => t.label === "second")?.status === "cancelled");
	assert.deepEqual(runner.calls, ["prompt-alpha", "prompt-beta"]);

	// resume: alpha replays from cache, beta re-dispatches (attempt 2)
	await runtime.control({ runId: "r1", action: "resume" });
	await waitFor(() => runtime.getRun("r1")?.status === "running");
	await waitFor(() => runner.calls.length >= 3);
	assert.deepEqual(runner.calls, ["prompt-alpha", "prompt-beta", "prompt-beta"], "completed item NOT re-executed");
	release.beta?.();
	const view = await waitForTerminal(runtime, "r1");
	assert.equal(view.status, "completed");
	assert.equal(runner.calls.length, 4, "alpha cached, beta retried, gamma ran for the first time");
	const alphaTask = view.tasks.find((t) => t.label === "first");
	const betaTask = view.tasks.find((t) => t.label === "second");
	assert.equal(alphaTask?.attempt, 1, "cached task keeps its attempt count");
	assert.equal(betaTask?.attempt, 2, "unfinished task gets a fresh attempt");
	assert.equal(summaries.length, 1, "exactly one final summary across pause/resume");
});

test("pause then IMMEDIATE resume: a late-finishing (abort-ignoring) runner cannot corrupt the resumed run", async () => {
	// Reviewer repro: the runner IGNORES the abort signal and resolves late;
	// the user resumes before the old executor winds down. The resumed run
	// must still complete — never `failed` via an illegal queued → completed.
	const releases: Array<() => void> = [];
	const runner = new FakeRunner(
		(spec) =>
			new Promise<AgentRunResult>((resolve) => {
				releases.push(() => resolve({ result: { [spec.prompt]: "late" }, summary: "late ok" }));
			}),
	);
	const runtime = new WorkflowRuntime({ runner });
	const summaries: string[] = [];
	await runtime.start({ runId: "r1", script: scriptOf(SEQ_SCRIPT), onFinalResult: (s) => summaries.push(s) });

	// alpha is in flight; pause then resume IMMEDIATELY (no waiting).
	await waitFor(() => runner.calls.length === 1);
	await runtime.control({ runId: "r1", action: "pause" });
	await runtime.control({ runId: "r1", action: "resume" });

	// The old executor's runner call finishes LATE, after the resume.
	releases.shift()?.();
	// Drain the resumed run's agent calls as they appear.
	const deadline = Date.now() + 8000;
	while (runtime.getRun("r1")?.status !== "completed" && runtime.getRun("r1")?.status !== "failed" && Date.now() < deadline) {
		for (const release of releases.splice(0)) release();
		await new Promise((r) => setTimeout(r, 5));
	}
	const view = runtime.view("r1");
	assert.equal(view.status, "completed", "late-finishing runner must not fail the resumed run");
	assert.equal(summaries.length, 1, "exactly one final summary across pause/resume");
	assert.ok(runner.calls.length >= 3, "the resumed run re-executed the script");
	const alpha = view.tasks.find((t) => t.label === "first")!;
	assert.equal(alpha.status, "completed");
	assert.ok(alpha.attempt >= 1);
});

test("entry never persists sensitive run args end-to-end", async () => {
	const secret = "sk-live-runtime-0123456789SECRET";
	const persister = new MemoryPersister();
	const runner = new FakeRunner();
	const runtime = new WorkflowRuntime({ runner, persister });
	await runtime.start({
		runId: "r1",
		script: scriptOf(SEQ_SCRIPT),
		args: { files: ["a.ts"], token: secret },
	});
	await waitForTerminal(runtime, "r1");

	for (const entry of persister.snapshots()) {
		assert.ok(!("args" in entry), "persisted entries must be args-free");
	}
	const serialized = JSON.stringify(persister.snapshots());
	assert.ok(!serialized.includes(secret), "credential values never enter persisted entries");
	assert.ok(!serialized.includes("files"), "no args field names either");
	// args stay in run memory only (viewable, not persisted)
	assert.deepEqual(runtime.view("r1").args, { files: ["a.ts"], token: secret });
});

test("stop cancels the run; no final summary is delivered", async () => {
	const runner = new FakeRunner((spec) => {
		if (spec.prompt === "prompt-beta") {
			return new Promise<AgentRunResult>((_resolve, reject) => {
				const onAbort = () => {
					spec.signal?.removeEventListener("abort", onAbort);
					reject(new Error("cancelled"));
				};
				spec.signal?.addEventListener("abort", onAbort, { once: true });
			});
		}
		return { result: { ok: true }, summary: "result ok" };
	});
	const runtime = new WorkflowRuntime({ runner });
	const summaries: string[] = [];
	await runtime.start({ runId: "r1", script: scriptOf(SEQ_SCRIPT), onFinalResult: (s) => summaries.push(s) });
	await waitFor(() => runner.calls.includes("prompt-beta"));
	const result = await runtime.control({ runId: "r1", action: "stop" });
	assert.equal(result.run.status, "cancelled");
	const view = await waitForTerminal(runtime, "r1");
	assert.equal(view.status, "cancelled");
	assert.equal(summaries.length, 0, "stop never delivers a final summary");
	// after stop, no new dispatches
	assert.equal(runner.calls.length, 2);
});

test("restart_agent invalidates the cache entry (queued/running lifecycle only); only that agent re-executes", async () => {
	let releaseGamma: (() => void) | undefined;
	const runner = new FakeRunner((spec) => {
		if (spec.prompt === "prompt-gamma") {
			return new Promise<AgentRunResult>((resolve, reject) => {
				const onAbort = () => {
					spec.signal?.removeEventListener("abort", onAbort);
					reject(new Error("aborted"));
				};
				spec.signal?.addEventListener("abort", onAbort, { once: true });
				releaseGamma = () => {
					spec.signal?.removeEventListener("abort", onAbort);
					resolve({ result: { ok: true }, summary: "gamma ok" });
				};
			});
		}
		return { result: { [spec.prompt]: "ok" }, summary: "result ok" };
	});
	const runtime = new WorkflowRuntime({ runner });
	await runtime.start({ runId: "r1", script: scriptOf(SEQ_SCRIPT) });

	// While the run is RUNNING (gamma in flight), restart the already
	// completed alpha task: cache entry invalidated, task queued, attempt++.
	await waitFor(() => runner.calls.includes("prompt-gamma"));
	const alphaTask = runtime.view("r1").tasks.find((t) => t.label === "first")!;
	await runtime.control({ runId: "r1", action: "restart_agent", agentId: alphaTask.taskId });
	assert.equal(runtime.view("r1").tasks.find((t) => t.taskId === alphaTask.taskId)?.status, "queued");
	assert.equal(runtime.view("r1").tasks.find((t) => t.taskId === alphaTask.taskId)?.attempt, 2);
	releaseGamma?.();
	const done1 = await waitForTerminal(runtime, "r1");
	assert.equal(done1.status, "completed");

	await runtime.restart("r1");
	const done2 = await waitForTerminal(runtime, "r1");
	assert.equal(done2.status, "completed");
	assert.deepEqual(runner.calls, ["prompt-alpha", "prompt-beta", "prompt-gamma", "prompt-alpha"], "only alpha re-executed");
	const alpha2 = done2.tasks.find((t) => t.label === "first")!;
	assert.equal(alpha2.attempt, 2);
	assert.equal(alpha2.status, "completed");
	assert.equal(done2.budget.agentCalls, 1, "restart budget counts only the re-executed agent");
});

test("restart_agent on a terminal run is rejected with RUN_NOT_CONTROLLABLE (PRD §5.3)", async () => {
	const runner = new FakeRunner();
	const runtime = new WorkflowRuntime({ runner });
	await runtime.start({ runId: "r1", script: scriptOf(SEQ_SCRIPT) });
	await waitForTerminal(runtime, "r1");
	const alphaTask = runtime.view("r1").tasks.find((t) => t.label === "first")!;

	await assert.rejects(
		() => runtime.control({ runId: "r1", action: "restart_agent", agentId: alphaTask.taskId }),
		(err: Error) => {
			assert.match(err.message, /not controllable/i);
			return true;
		},
	);
	// The task/cache must be untouched: a re-run replays everything from cache.
	const callsAfterRejection = runner.calls.length;
	await runtime.restart("r1");
	const view = await waitForTerminal(runtime, "r1");
	assert.equal(view.status, "completed");
	assert.equal(runner.calls.length, callsAfterRejection, "terminal restart_agent must not delete cache entries");
});

test("restart_agent with unknown id throws AGENT_NOT_RESTARTABLE", async () => {
	let release: (() => void) | undefined;
	const runner = new FakeRunner((spec) => {
		if (spec.prompt === "prompt-alpha") {
			return new Promise<AgentRunResult>((resolve) => {
				release = () => resolve({ result: { ok: true }, summary: "alpha ok" });
			});
		}
		return { result: { ok: true }, summary: "result ok" };
	});
	const runtime = new WorkflowRuntime({ runner });
	await runtime.start({ runId: "r1", script: scriptOf(SEQ_SCRIPT) });
	// keep the run RUNNING (queued/running lifecycle) so the state gate passes
	await waitFor(() => runner.calls.includes("prompt-alpha"));
	await assert.rejects(
		() => runtime.control({ runId: "r1", action: "restart_agent", agentId: "nope" }),
		(err: Error) => {
			assert.match(err.message, /not restartable/i);
			return true;
		},
	);
	release?.();
	await waitForTerminal(runtime, "r1");
});

// ------------------------------------------------------------------
// persistence
// ------------------------------------------------------------------

test("every status change is persisted; entry stays metadata-only", async () => {
	const runner = new FakeRunner();
	const persister = new MemoryPersister();
	const runtime = new WorkflowRuntime({ runner, persister });
	await runtime.start({ runId: "r1", script: scriptOf(SEQ_SCRIPT) });
	await waitForTerminal(runtime, "r1");

	const snapshots = persister.snapshots();
	const statuses = snapshots.map((e) => e.status);
	assert.equal(statuses[0], "queued", "start persisted first");
	assert.equal(statuses[statuses.length - 1], "completed", "terminal state persisted last");
	assert.ok(statuses.includes("running"), "running state persisted");
	assert.ok(new Set(statuses).size >= 3, "all transitions recorded");
	const latest = persister.latest()!;
	assert.equal(latest.entryVersion, "pi-workflow-run-v1");
	assert.equal(latest.digest, computeDigest(SEQ_SCRIPT));
	assert.equal(latest.cacheIndex.length, 3);
	for (const item of latest.cacheIndex) {
		assert.ok(!("result" in item));
		assert.ok(!("prompt" in item));
	}
	const serialized = JSON.stringify(snapshots);
	assert.ok(!serialized.includes("prompt-alpha"), "prompts never enter persisted entries");
	assert.ok(!serialized.includes(SEQ_SCRIPT), "script source never enters persisted entries");
	assert.ok(!serialized.includes("process.env"), "no environment leakage");
});

test("large final summaries are truncated to the 8KB limit", async () => {
	const runner = new FakeRunner();
	const runtime = new WorkflowRuntime({ runner });
	const source = makeScript(`const arr = [];
for (let i = 0; i < 30000; i++) { arr.push("x"); }
return arr.join("");`, "arr.join(\"\")");
	await runtime.start({ runId: "r1", script: scriptOf(source) });
	const view = await waitForTerminal(runtime, "r1");
	assert.equal(view.status, "completed");
	assert.ok(view.summary !== undefined);
	assert.ok(Buffer.byteLength(view.summary!, "utf8") <= 8192, "summary size bounded");
	assert.ok(view.summary!.endsWith("[Summary truncated.]"));
});

// ------------------------------------------------------------------
// control / shutdown
// ------------------------------------------------------------------

test("control errors: unknown run and illegal transitions", async () => {
	const runner = new FakeRunner();
	const runtime = new WorkflowRuntime({ runner });
	await assert.rejects(() => runtime.control({ runId: "ghost", action: "pause" }), (err: Error) => {
		assert.match(err.message, /run not found/i);
		return true;
	});
	await runtime.start({ runId: "r1", script: scriptOf(SEQ_SCRIPT) });
	await waitForTerminal(runtime, "r1");
	await assert.rejects(() => runtime.control({ runId: "r1", action: "pause" }), (err: Error) => {
		assert.match(err.message, /state transition/i);
		return true;
	});
	await assert.rejects(() => runtime.control({ runId: "r1", action: "bogus" as never }), (err: Error) => {
		assert.match(err.message, /not controllable/i);
		return true;
	});
});

test("pause while queued withdraws the run; resume restarts it", async () => {
	const gate = { release: () => {} };
	const runner = new FakeRunner((spec) => {
		if (spec.prompt === "blocker") {
			return new Promise<AgentRunResult>((resolve) => {
				gate.release = () => resolve({ result: { ok: true }, summary: "result ok" });
			});
		}
		return { result: { ok: true }, summary: "result ok" };
	});
	const runtime = new WorkflowRuntime({ runner, maxActiveRuns: 1 });
	await runtime.start({ runId: "block", script: scriptOf(makeScript(`await agent("blocker");`)) });
	await waitFor(() => runtime.getRun("block")?.status === "running");

	await runtime.start({ runId: "wait", script: scriptOf(SEQ_SCRIPT) });
	await waitFor(() => runtime.getRun("wait")?.status === "queued");
	await runtime.control({ runId: "wait", action: "pause" });
	assert.equal(runtime.getRun("wait")?.status, "paused");
	// release the blocking run; the paused run must NOT start
	gate.release();
	await waitForTerminal(runtime, "block");
	await new Promise((r) => setTimeout(r, 20));
	assert.equal(runtime.getRun("wait")?.status, "paused", "paused run stays paused");

	await runtime.control({ runId: "wait", action: "resume" });
	const view = await waitForTerminal(runtime, "wait");
	assert.equal(view.status, "completed");
	assert.equal(view.tasks.length, 3);
});

test("shutdown cancels active runs, aborts in-flight agents and blocks new starts", async () => {
	let release: (() => void) | undefined;
	const runner = new FakeRunner((spec) => {
		return new Promise<AgentRunResult>((resolve, reject) => {
			const onAbort = () => {
				spec.signal?.removeEventListener("abort", onAbort);
				reject(new Error("shutdown"));
			};
			spec.signal?.addEventListener("abort", onAbort, { once: true });
			release = () => resolve({ result: { ok: true }, summary: "result ok" });
		});
	});
	const runtime = new WorkflowRuntime({ runner });
	const settled: string[] = [];
	runtime.onRunSettled((runId) => settled.push(runId));
	await runtime.start({ runId: "r1", script: scriptOf(SEQ_SCRIPT) });
	await waitFor(() => runner.calls.length === 1);
	assert.equal(runtime.getRun("r1")?.status, "running");

	runtime.shutdown();
	const view = await waitForTerminal(runtime, "r1");
	assert.equal(view.status, "cancelled", "active run cancelled on shutdown");
	await waitFor(() => runtime.view("r1").tasks[0]?.status === "cancelled");
	assert.equal(runtime.list().length, 1);

	await assert.rejects(
		() => runtime.start({ runId: "r2", script: scriptOf(SEQ_SCRIPT) }),
		(err: Error) => {
			assert.match(err.message, /shut down/i);
			return true;
		},
	);
	assert.deepEqual(settled, ["r1"]);
});

test("stage aggregation: labels and anonymous call sequence", async () => {
	const runner = new FakeRunner();
	const runtime = new WorkflowRuntime({ runner });
	const source = makeScript(`const x = await agent("prompt-x", { label: "plan" });
const y = await agent("prompt-y");
const z = await agent("prompt-z");`);
	await runtime.start({ runId: "r1", script: scriptOf(source) });
	const view = await waitForTerminal(runtime, "r1");
	const labels = view.stages.map((s) => s.label).sort();
	assert.deepEqual(labels, ["agent-1", "agent-2", "plan"], "anonymous calls use call sequence numbers");
	const planStage = view.stages.find((s) => s.label === "plan")!;
	assert.equal(planStage.agentIds.length, 1);
	assert.equal(planStage.status, "completed");
});

test("onRunSettled is run-scoped (one run's settle never fires another's summary)", async () => {
	const runner = new FakeRunner();
	const runtime = new WorkflowRuntime({ runner });
	const settled: string[] = [];
	const summaries: string[] = [];
	runtime.onRunSettled((runId) => settled.push(runId));
	await runtime.start({ runId: "r1", script: scriptOf(SEQ_SCRIPT), onFinalResult: (s) => summaries.push(s) });
	await waitForTerminal(runtime, "r1");
	await runtime.start({ runId: "r2", script: scriptOf(SEQ_SCRIPT), onFinalResult: (s) => summaries.push(s) });
	await waitForTerminal(runtime, "r2");
	assert.deepEqual(settled.sort(), ["r1", "r2"]);
	assert.equal(summaries.length, 2);
});

test("failed agent records errorCode+errorMessage and broadcasts task_result", async () => {
	const runner = new FakeRunner(() => {
		throw new RunnerError(RunnerErrorCodes.AGENT_EXECUTION_ERROR, "boom detail");
	});
	const persister = new MemoryPersister();
	const runtime = new WorkflowRuntime({ runner, persister });
	const events: Array<{ type: string; error?: string }> = [];
	runtime.onEvent((ev) => events.push(ev));
	await runtime.start({ runId: "r1", script: scriptOf(makeScript(`await agent('x')`)) });
	const view = await waitForTerminal(runtime, "r1");
	assert.equal(view.status, "failed");
	assert.ok(view.errorMessage?.includes("boom detail"), "run errorMessage carries the detail");
	const task = view.tasks[0]!;
	assert.equal(task.status, "failed");
	assert.equal(task.errorCode, "AGENT_EXECUTION_ERROR");
	assert.ok(task.errorMessage?.includes("boom detail"), "task errorMessage carries the detail");
	const resultEvents = events.filter((e) => e.type === "task_result");
	assert.equal(resultEvents.length, 1);
	assert.ok(resultEvents[0]?.error?.includes("boom detail"), "task_result event carries the error");
	const latest = persister.latest()!;
	assert.equal(latest.status, "failed");
	assert.ok(latest.errorMessage?.includes("boom detail"), "persisted run errorMessage carries the detail");
	const cached = latest.cacheIndex[0]!;
	assert.equal(cached.errorCode, "AGENT_EXECUTION_ERROR");
	assert.ok(cached.errorMessage?.includes("boom detail"), "persisted task errorMessage carries the detail");
});

