/**
 * PiAgentRunner adapter unit tests (JHL-14)
 *
 * All tests run against a MOCK spawn factory — no real child processes,
 * no network, no model calls. They cover: unknown-agent fail-fast before
 * launch, tools mapping (readonly/write), schema injection + JSON parsing,
 * result/summary truncation, usage normalization, abort, error mapping,
 * restart-safety, and the AGENT_RUNNER_UNAVAILABLE degradation path.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { PiAgentRunner, RunnerError, RunnerErrorCodes, effectiveTools } from "../index.ts";
import { discoverAgents } from "../discover.ts";
import { MAX_RESULT_BYTES, MAX_SUMMARY_BYTES, type AgentDefinition } from "../types.ts";
import { makeFakeSpawn, messageEndLine, toolResultEndLine, waitForChild, type FakeSpawnHandle } from "./helpers.ts";

function makeRunner(handle: FakeSpawnHandle): PiAgentRunner {
	const runner = new PiAgentRunner({ now: () => "2026-08-05T12:00:00.000Z" });
	runner.setSpawn(handle.spawn);
	return runner;
}

/** Builtin scout definition fixture — hermetic, no real agent discovery. */
function scoutAgent(model?: string): AgentDefinition {
	return {
		name: "scout",
		description: "Fast codebase recon",
		tools: ["read", "grep", "find", "ls", "bash"],
		model,
		systemPrompt: "You are a scout. Investigate and return structured findings.",
		source: "builtin",
		filePath: "<builtin>",
	};
}

test("UNKNOWN_AGENT: fails BEFORE launching any process", async () => {
	const handle = makeFakeSpawn();
	const runner = makeRunner(handle);
	await assert.rejects(
		() => runner.run({ runId: "r1", agentId: "nobody", prompt: "hi" }),
		(err) => {
			assert.ok(err instanceof RunnerError);
			assert.equal(err.code, RunnerErrorCodes.UNKNOWN_AGENT);
			assert.match(err.message, /Unknown agent id "nobody"/);
			return true;
		},
	);
	assert.equal(handle.records.length, 0, "no process may start for an unknown agent");
	assert.equal(handle.children.length, 0);
});

test("default agents: scout/planner/reviewer/worker are discovered (builtin fallback)", () => {
	const agents = discoverAgents(process.cwd(), "user");
	const names = agents.map((a) => a.name);
	for (const expected of ["scout", "planner", "reviewer", "worker"]) {
		assert.ok(names.includes(expected), `expected builtin default agent ${expected}`);
	}
});

test("successful run: result, summary, usage and events are normalized", async () => {
	const handle = makeFakeSpawn();
	const runner = makeRunner(handle);

	const runPromise = runner.run({ runId: "r1", agentId: "scout", prompt: "find auth code" });
	const child = await waitForChild(handle);
	child.emitLine(messageEndLine("assistant", { usage: { input: 10, output: 5, cacheRead: 2, cacheWrite: 1, cost: { total: 0.01 }, totalTokens: 15 }, model: "claude-haiku-4-5" }));
	child.emitLine(toolResultEndLine());
	child.emitClose(0);

	const result = await runPromise;
	assert.equal(typeof result.result, "string");
	assert.match(String(result.result), /final output/);
	assert.equal(result.summary, "final output");
	assert.equal(result.usage?.input, 10);
	assert.equal(result.usage?.output, 5);
	assert.equal(result.usage?.cacheRead, 2);
	assert.equal(result.usage?.cacheWrite, 1);
	assert.equal(result.usage?.cost, 0.01);
	assert.equal(result.usage?.contextTokens, 15);
	assert.equal(result.usage?.turns, 1);
	assert.equal(result.usage?.model, "claude-haiku-4-5");
	const events = result.events as Array<{ type: string; role?: string; exitCode?: number }>;
	assert.ok(events.some((e) => e.type === "message_end" && e.role === "assistant"));
	assert.ok(events.some((e) => e.type === "tool_result_end"));
	assert.ok(events.some((e) => e.type === "exit" && e.exitCode === 0));
});

test("child args: json mode, no-session, model, tools allowlist and task suffix", async () => {
	const handle = makeFakeSpawn();
	// Hermetic runner: explicit agents, so the pinned builtin scout model is
	// asserted regardless of what real agent discovery finds on this machine.
	const runner = new PiAgentRunner({ agents: [scoutAgent("claude-haiku-4-5")] });
	runner.setSpawn(handle.spawn);
	const runPromise = runner.run({ runId: "r1", agentId: "scout", prompt: "task prompt", tools: "readonly" });
	const child = await waitForChild(handle);
	child.emitLine(messageEndLine("assistant"));
	child.emitClose(0);
	await runPromise;

	const rec = handle.records[0];
	assert.ok(rec);
	assert.ok(rec.args.includes("--mode") && rec.args.includes("json"));
	assert.ok(rec.args.includes("-p"));
	assert.ok(rec.args.includes("--no-session"));
	assert.ok(rec.args.includes("--model"));
	assert.ok(rec.args.includes("claude-haiku-4-5"));
	assert.ok(rec.args.includes("--tools"));
	const toolsIdx = rec.args.indexOf("--tools");
	const tools = rec.args[toolsIdx + 1].split(",");
	assert.ok(tools.includes("read"), "readonly must include read");
	assert.ok(!tools.includes("bash"), "readonly must strip bash");
	assert.ok(!tools.includes("write"), "readonly must strip write");
	assert.ok(rec.args.some((a) => a.startsWith("Task: task prompt")), "task passed as positional arg");
});

test("model precedence: per-call spec.model > PWR defaultModel; definition pin > per-call", async () => {
	// Unpinned agent: the PWR default model applies.
	const handle1 = makeFakeSpawn();
	const runner1 = new PiAgentRunner({ agents: [scoutAgent(undefined)], defaultModel: () => "dflt-model" });
	runner1.setSpawn(handle1.spawn);
	const p1 = runner1.run({ runId: "r1", agentId: "scout", prompt: "p" });
	const c1 = await waitForChild(handle1);
	c1.emitLine(messageEndLine("assistant"));
	c1.emitClose(0);
	await p1;
	const rec1 = handle1.records[0]!;
	assert.ok(rec1.args.includes("--model"), "defaultModel must add --model");
	assert.ok(rec1.args.includes("dflt-model"));

	// Per-call option beats the PWR default.
	const handle2 = makeFakeSpawn();
	const runner2 = new PiAgentRunner({ agents: [scoutAgent(undefined)], defaultModel: () => "dflt-model" });
	runner2.setSpawn(handle2.spawn);
	const p2 = runner2.run({ runId: "r2", agentId: "scout", prompt: "p", model: "per-call" });
	const c2 = await waitForChild(handle2);
	c2.emitLine(messageEndLine("assistant"));
	c2.emitClose(0);
	await p2;
	const rec2 = handle2.records[0]!;
	assert.ok(rec2.args.includes("per-call"));
	assert.ok(!rec2.args.includes("dflt-model"), "per-call model must win over defaultModel");

	// Definition pin beats the per-call option.
	const handle3 = makeFakeSpawn();
	const runner3 = new PiAgentRunner({ agents: [scoutAgent("pinned-model")], defaultModel: () => "dflt-model" });
	runner3.setSpawn(handle3.spawn);
	const p3 = runner3.run({ runId: "r3", agentId: "scout", prompt: "p", model: "per-call" });
	const c3 = await waitForChild(handle3);
	c3.emitLine(messageEndLine("assistant"));
	c3.emitClose(0);
	await p3;
	const rec3 = handle3.records[0]!;
	assert.ok(rec3.args.includes("pinned-model"));
	assert.ok(!rec3.args.includes("per-call"), "definition pin must win over per-call model");
	assert.ok(!rec3.args.includes("dflt-model"), "definition pin must win over defaultModel");
});

test("effectiveTools: readonly strips write tools; write keeps them", () => {
	const scout = discoverAgents(process.cwd(), "user").find((a) => a.name === "scout")!;
	const readOnly = effectiveTools(scout, "readonly");
	assert.ok(!readOnly.includes("bash"));
	assert.ok(readOnly.includes("read"));
	const write = effectiveTools(scout, "write");
	assert.ok(write.includes("bash"));
	assert.ok(write.includes("read"));
	// worker declares no tools → falls back to the mode allowlist
	const worker = discoverAgents(process.cwd(), "user").find((a) => a.name === "worker")!;
	assert.deepEqual(effectiveTools(worker, "readonly"), ["read", "grep", "find", "ls", "glob"]);
});

test("schema: injected into the prompt and parsed from the final text", async () => {
	const handle = makeFakeSpawn();
	const runner = makeRunner(handle);
	const schema = { type: "object", required: ["files"], properties: { files: { type: "array" } } };
	const runPromise = runner.run({ runId: "r1", agentId: "scout", prompt: "list files", schema });
	const child = await waitForChild(handle);
	const rec = handle.records[0];
	const taskArg = rec.args.find((a) => a.startsWith("Task: "))!;
	assert.ok(taskArg.includes("JSON Schema"), "schema instruction must be injected");
	assert.ok(taskArg.includes('"type":"object"'), "schema must be embedded as JSON");

	child.emitLine(messageEndLine("assistant", { content: [{ type: "text", text: '```json\n{"files": ["a.ts", "b.ts"]}\n```' }] }));
	child.emitClose(0);
	const result = await runPromise;
	assert.deepEqual(result.result, { files: ["a.ts", "b.ts"] });
});

test("schema with non-JSON output: falls back to raw text", async () => {
	const handle = makeFakeSpawn();
	const runner = makeRunner(handle);
	const runPromise = runner.run({ runId: "r1", agentId: "scout", prompt: "go", schema: { type: "object" } });
	const child = await waitForChild(handle);
	child.emitLine(messageEndLine("assistant", { content: [{ type: "text", text: "I could not parse." }] }));
	child.emitClose(0);
	const result = await runPromise;
	assert.equal(result.result, "I could not parse.");
});

test("schema: 模板散文包裹的 JSON 仍被解析", async () => {
	const handle = makeFakeSpawn();
	const runner = makeRunner(handle);
	const runPromise = runner.run({ runId: "r1", agentId: "scout", prompt: "go", schema: { type: "object" } });
	const child = await waitForChild(handle);
	child.emitLine(
		messageEndLine("assistant", {
			content: [{ type: "text", text: '## Completed\nI found the files: {"files": ["a.ts"]}\n## Notes\nall done' }],
		}),
	);
	child.emitClose(0);
	const result = await runPromise;
	assert.deepEqual(result.result, { files: ["a.ts"] });

	const handleArr = makeFakeSpawn();
	const runnerArr = makeRunner(handleArr);
	const arrPromise = runnerArr.run({ runId: "r2", agentId: "scout", prompt: "go", schema: { type: "array" } });
	const childArr = await waitForChild(handleArr);
	childArr.emitLine(messageEndLine("assistant", { content: [{ type: "text", text: "Some prose\n[1,2,3]\ntrailing" }] }));
	childArr.emitClose(0);
	const arrResult = await arrPromise;
	assert.deepEqual(arrResult.result, [1, 2, 3]);
});

test("schema: 散文里无 JSON 时仍回退原文", async () => {
	const handle = makeFakeSpawn();
	const runner = makeRunner(handle);
	const runPromise = runner.run({ runId: "r1", agentId: "scout", prompt: "go", schema: { type: "object" } });
	const child = await waitForChild(handle);
	child.emitLine(messageEndLine("assistant", { content: [{ type: "text", text: "No structured result here, sorry." }] }));
	child.emitClose(0);
	const result = await runPromise;
	assert.equal(result.result, "No structured result here, sorry.");
});

test("result truncation: 50KB cap on text results, 8KB cap on summary", async () => {
	const handle = makeFakeSpawn();
	const runner = makeRunner(handle);
	const huge = "x".repeat(MAX_RESULT_BYTES + 10_000);
	const runPromise = runner.run({ runId: "r1", agentId: "scout", prompt: "go" });
	const child = await waitForChild(handle);
	child.emitLine(messageEndLine("assistant", { content: [{ type: "text", text: huge }] }));
	child.emitClose(0);
	const result = await runPromise;
	assert.ok(Buffer.byteLength(String(result.result), "utf8") <= MAX_RESULT_BYTES);
	assert.ok(Buffer.byteLength(result.summary, "utf8") <= MAX_SUMMARY_BYTES);
});

test("schema structured array over 50KB: rejected with RESULT_TOO_LARGE (no truncation bypass)", async () => {
	const handle = makeFakeSpawn();
	const runner = makeRunner(handle);
	// >50KB once serialized
	const bigArray = Array.from({ length: 6000 }, (_, i) => `item-${i}-${"x".repeat(12)}`);
	assert.ok(Buffer.byteLength(JSON.stringify(bigArray), "utf8") > MAX_RESULT_BYTES, "fixture must exceed the budget");
	const runPromise = runner.run({ runId: "r1", agentId: "scout", prompt: "go", schema: { type: "array" } });
	const child = await waitForChild(handle);
	child.emitLine(messageEndLine("assistant", { content: [{ type: "text", text: JSON.stringify(bigArray) }] }));
	child.emitClose(0);
	await assert.rejects(() => runPromise, (err) => {
		assert.ok(err instanceof RunnerError);
		assert.equal(err.code, RunnerErrorCodes.RESULT_TOO_LARGE);
		return true;
	});
});

test("schema structured object over 50KB: rejected with RESULT_TOO_LARGE (no truncation bypass)", async () => {
	const handle = makeFakeSpawn();
	const runner = makeRunner(handle);
	const bigObject: Record<string, string> = {};
	for (let i = 0; i < 3000; i++) bigObject[`key${i}`] = "v".repeat(20);
	assert.ok(Buffer.byteLength(JSON.stringify(bigObject), "utf8") > MAX_RESULT_BYTES, "fixture must exceed the budget");
	const runPromise = runner.run({ runId: "r1", agentId: "scout", prompt: "go", schema: { type: "object" } });
	const child = await waitForChild(handle);
	child.emitLine(messageEndLine("assistant", { content: [{ type: "text", text: JSON.stringify(bigObject) }] }));
	child.emitClose(0);
	await assert.rejects(() => runPromise, (err) => {
		assert.ok(err instanceof RunnerError);
		assert.equal(err.code, RunnerErrorCodes.RESULT_TOO_LARGE);
		return true;
	});
});

test("schema structured result within the budget is preserved", async () => {
	const handle = makeFakeSpawn();
	const runner = makeRunner(handle);
	const ok = { files: Array.from({ length: 200 }, (_, i) => `src/file-${i}.ts`) };
	const runPromise = runner.run({ runId: "r1", agentId: "scout", prompt: "go", schema: { type: "object" } });
	const child = await waitForChild(handle);
	child.emitLine(messageEndLine("assistant", { content: [{ type: "text", text: JSON.stringify(ok) }] }));
	child.emitClose(0);
	const result = await runPromise;
	assert.deepEqual(result.result, ok);
});

test("abort before launch: throws AGENT_ABORTED and never spawns", async () => {
	const handle = makeFakeSpawn();
	const runner = makeRunner(handle);
	const controller = new AbortController();
	controller.abort();
	await assert.rejects(
		() => runner.run({ runId: "r1", agentId: "scout", prompt: "go", signal: controller.signal }),
		(err) => {
			assert.ok(err instanceof RunnerError);
			assert.equal(err.code, RunnerErrorCodes.AGENT_ABORTED);
			return true;
		},
	);
	assert.equal(handle.records.length, 0, "no process may start for an already-aborted run");
});

test("abort while running: child killed and AGENT_ABORTED surfaced", async () => {
	const handle = makeFakeSpawn();
	const runner = makeRunner(handle);
	const controller = new AbortController();
	const runPromise = runner.run({ runId: "r1", agentId: "scout", prompt: "go", signal: controller.signal });
	const child = await waitForChild(handle);
	controller.abort();
	await new Promise((r) => setTimeout(r, 10));
	assert.ok(child.killed.includes("SIGTERM"), "child must be killed with SIGTERM");
	child.emitClose(0);
	await assert.rejects(() => runPromise, (err) => {
		assert.ok(err instanceof RunnerError);
		assert.equal(err.code, RunnerErrorCodes.AGENT_ABORTED);
		return true;
	});
});

test("non-zero exit: AGENT_EXECUTION_ERROR with stderr diagnostics", async () => {
	const handle = makeFakeSpawn();
	const runner = makeRunner(handle);
	const runPromise = runner.run({ runId: "r1", agentId: "scout", prompt: "go" });
	const child = await waitForChild(handle);
	child.emitStderr("model overloaded");
	child.emitClose(1);
	await assert.rejects(() => runPromise, (err) => {
		assert.ok(err instanceof RunnerError);
		assert.equal(err.code, RunnerErrorCodes.AGENT_EXECUTION_ERROR);
		assert.match(err.message, /model overloaded/);
		return true;
	});
});

test("stopReason error: AGENT_EXECUTION_ERROR with the error message", async () => {
	const handle = makeFakeSpawn();
	const runner = makeRunner(handle);
	const runPromise = runner.run({ runId: "r1", agentId: "scout", prompt: "go" });
	const child = await waitForChild(handle);
	child.emitLine(messageEndLine("assistant", { stopReason: "error", errorMessage: "rate limited" }));
	child.emitClose(0);
	await assert.rejects(() => runPromise, (err) => {
		assert.ok(err instanceof RunnerError);
		assert.equal(err.code, RunnerErrorCodes.AGENT_EXECUTION_ERROR);
		assert.match(err.message, /rate limited/);
		return true;
	});
});

test("spawn failure: AGENT_RUNNER_UNAVAILABLE (no implicit fallback)", async () => {
	const handle = makeFakeSpawn();
	handle.spawnError = new Error("ENOENT: pi not found");
	const runner = makeRunner(handle);
	await assert.rejects(
		() => runner.run({ runId: "r1", agentId: "scout", prompt: "go" }),
		(err) => {
			assert.ok(err instanceof RunnerError);
			assert.equal(err.code, RunnerErrorCodes.AGENT_RUNNER_UNAVAILABLE);
			assert.match(err.message, /Failed to start pi subprocess/);
			return true;
		},
	);
});

test("restart-safety: two runs for the same agent id are independent", async () => {
	const handle = makeFakeSpawn();
	const runner = makeRunner(handle);

	const p1 = runner.run({ runId: "r1", agentId: "scout", prompt: "first" });
	const child1 = await waitForChild(handle, 0);
	child1.emitLine(messageEndLine("assistant", { content: [{ type: "text", text: "first result" }] }));
	child1.emitClose(0);
	const r1 = await p1;

	const p2 = runner.run({ runId: "r1", agentId: "scout", prompt: "retry after restart" });
	const child2 = await waitForChild(handle, 1);
	child2.emitLine(messageEndLine("assistant", { content: [{ type: "text", text: "second result" }] }));
	child2.emitClose(0);
	const r2 = await p2;

	assert.equal(r1.result, "first result");
	assert.equal(r2.result, "second result");
	assert.equal(handle.records.length, 2, "each run() starts its own child process");
	// The adapter is stateless: attempt counting belongs to the runtime.
	assert.equal(r1.usage?.turns, 1);
	assert.equal(r2.usage?.turns, 1);
});

test("stderr fallback: no assistant output → result from stderr with warning text", async () => {
	const handle = makeFakeSpawn();
	const runner = makeRunner(handle);
	const runPromise = runner.run({ runId: "r1", agentId: "scout", prompt: "go" });
	const child = await waitForChild(handle);
	child.emitStderr("diagnostic noise");
	child.emitClose(0);
	const result = await runPromise;
	assert.equal(result.result, "diagnostic noise");
});

test("events carry no raw tool output", async () => {
	const handle = makeFakeSpawn();
	const runner = makeRunner(handle);
	const runPromise = runner.run({ runId: "r1", agentId: "scout", prompt: "go" });
	const child = await waitForChild(handle);
	child.emitLine(messageEndLine("assistant"));
	child.emitLine(toolResultEndLine());
	child.emitClose(0);
	const result = await runPromise;
	const events = result.events as Array<Record<string, unknown>>;
	for (const ev of events) {
		assert.equal(JSON.stringify(ev).includes("secret-payload"), false);
	}
});
