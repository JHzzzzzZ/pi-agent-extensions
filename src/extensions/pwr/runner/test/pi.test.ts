/**
 * Child pi process mode tests (JHL-14): JSON line streaming, usage
 * aggregation, temp prompt materialization, abort kill semantics.
 */

import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { KILL_GRACE_MS, runPiChild } from "../pi.ts";
import { makeFakeSpawn, messageEndLine, toolResultEndLine, waitForChild, type FakeSpawnHandle } from "./helpers.ts";

test("streams message_end / tool_result_end events and aggregates usage", async () => {
	const handle = makeFakeSpawn();
	const p = runPiChild({
		command: "pi",
		args: ["--mode", "json", "-p", "--no-session"],
		cwd: process.cwd(),
		spawn: handle.spawn,
		now: () => "2026-08-05T12:00:00.000Z",
	});
	const child = await waitForChild(handle);
	child.emitLine(messageEndLine("user", { content: [] }));
	child.emitLine(
		messageEndLine("assistant", {
			usage: { input: 10, output: 5, cacheRead: 2, cacheWrite: 1, cost: { total: 0.01 }, totalTokens: 15 },
			model: "claude-haiku-4-5",
		}),
	);
	child.emitLine(toolResultEndLine());
	child.emitClose(0);

	const outcome = await p;
	assert.equal(outcome.exitCode, 0);
	assert.equal(outcome.usage.input, 10);
	assert.equal(outcome.usage.output, 5);
	assert.equal(outcome.usage.cacheRead, 2);
	assert.equal(outcome.usage.cacheWrite, 1);
	assert.equal(outcome.usage.cost, 0.01);
	assert.equal(outcome.usage.contextTokens, 15);
	assert.equal(outcome.usage.turns, 1);
	assert.equal(outcome.model, "claude-haiku-4-5");
	assert.equal(outcome.finalText, "final output");
	assert.equal(outcome.events.length, 4); // user message_end + assistant message_end + tool_result_end + exit
});

test("handles partial stdout chunks (line buffering)", async () => {
	const handle = makeFakeSpawn();
	const p = runPiChild({
		command: "pi",
		args: [],
		cwd: process.cwd(),
		spawn: handle.spawn,
		now: () => "2026-08-05T12:00:00.000Z",
	});
	const child = await waitForChild(handle);
	const line = messageEndLine("assistant");
	const half = Math.floor(line.length / 2);
	child.emitChunk(line.slice(0, half));
	child.emitChunk(line.slice(half));
	child.emitChunk("\n");
	child.emitClose(0);
	const outcome = await p;
	assert.equal(outcome.finalText, "final output");
});

test("abort: child killed with SIGTERM, error event emitted", async () => {
	const handle = makeFakeSpawn();
	const controller = new AbortController();
	const p = runPiChild({
		command: "pi",
		args: [],
		cwd: process.cwd(),
		spawn: handle.spawn,
		signal: controller.signal,
		now: () => "2026-08-05T12:00:00.000Z",
	});
	const child = await waitForChild(handle);
	controller.abort();
	await new Promise((r) => setTimeout(r, 10));
	assert.ok(child.killed.includes("SIGTERM"));
	child.emitClose(0);
	const outcome = await p;
	assert.ok(outcome.events.some((e) => e.type === "error" && e.code === "AGENT_ABORTED"));
});

test("abort then immediate close: pending SIGKILL timer is cancelled and listener removed", async () => {
	const handle = makeFakeSpawn();
	const controller = new AbortController();
	const p = runPiChild({
		command: "pi",
		args: [],
		cwd: process.cwd(),
		spawn: handle.spawn,
		signal: controller.signal,
		now: () => "2026-08-05T12:00:00.000Z",
	});
	const child = await waitForChild(handle);

	// Mock the 5s grace timer so the test does not wait in real time.
	mock.timers.enable({ apis: ["setTimeout"] });
	controller.abort();
	await Promise.resolve(); // let the abort listener run (SIGTERM + timer)
	assert.ok(child.killed.includes("SIGTERM"));

	// The child closes immediately after SIGTERM — the grace period is over.
	child.emitClose(0);
	await p;

	// PRD §7 hygiene: after close, the pending SIGKILL timer must be cleared
	// and the abort listener removed — advancing past the grace period must
	// NOT signal the finished child, and a second abort must not kill again.
	mock.timers.tick(KILL_GRACE_MS + 1000);
	assert.deepEqual(child.killed, ["SIGTERM"], "SIGKILL must never fire after the child has closed");
	controller.abort();
	await Promise.resolve();
	assert.deepEqual(child.killed, ["SIGTERM"], "abort listener must be removed after close");
	mock.timers.reset();
});

test("spawn error is captured and surfaced", async () => {
	const handle = makeFakeSpawn();
	const p = runPiChild({
		command: "pi",
		args: [],
		cwd: process.cwd(),
		spawn: handle.spawn,
		now: () => "2026-08-05T12:00:00.000Z",
	});
	const child = await waitForChild(handle);
	child.emitError(new Error("ENOENT: pi"));
	child.emitClose(0);
	const outcome = await p;
	assert.ok(outcome.events.some((e) => e.type === "error" && e.code === "AGENT_RUNNER_UNAVAILABLE"));
});

test("stderr is collected", async () => {
	const handle = makeFakeSpawn();
	const p = runPiChild({
		command: "pi",
		args: [],
		cwd: process.cwd(),
		spawn: handle.spawn,
		now: () => "2026-08-05T12:00:00.000Z",
	});
	const child = await waitForChild(handle);
	child.emitStderr("boom");
	child.emitClose(1);
	const outcome = await p;
	assert.equal(outcome.exitCode, 1);
	assert.match(outcome.stderr, /boom/);
});

test("--append-system-prompt pwr-tmp:// is materialized to a temp file", async () => {
	const handle = makeFakeSpawn();
	const p = runPiChild({
		command: "pi",
		args: ["--append-system-prompt", "pwr-tmp://hello system prompt"],
		cwd: process.cwd(),
		spawn: handle.spawn,
		now: () => "2026-08-05T12:00:00.000Z",
	});
	const child = await waitForChild(handle);
	const args = handle.records[0].args;
	const idx = args.indexOf("--append-system-prompt");
	assert.ok(idx >= 0);
	const fileArg = args[idx + 1];
	assert.ok(!fileArg.startsWith("pwr-tmp://"), "temp file replaced the marker");
	assert.ok(fileArg.includes("pwr-agent-"), "temp file in os tmpdir");
	assert.ok(fileArg.includes("prompt.md"), "prompt file name used");
	child.emitLine(messageEndLine("assistant"));
	child.emitClose(0);
	await p;
});
