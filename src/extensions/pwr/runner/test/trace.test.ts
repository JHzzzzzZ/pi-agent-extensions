/**
 * Live per-step trace tests (v2.4): tool_execution_* event parsing, the
 * onEvent observer seam, message_update throttling and text/args
 * sanitization (single-line, tail-truncated, never raw payloads).
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { PiAgentRunner } from "../index.ts";
import { MESSAGE_UPDATE_THROTTLE_MS, runPiChild, summarizeArgs, textTail } from "../pi.ts";
import {
	makeFakeSpawn,
	messageEndLine,
	messageUpdateLine,
	toolExecutionEndLine,
	toolExecutionStartLine,
	toolExecutionUpdateLine,
	waitForChild,
} from "./helpers.ts";

test("tool_execution_start/update/end are parsed with sanitized summaries", async () => {
	const seen: Array<{ type: string; toolName?: string; argsSummary?: string; text?: string; isError?: boolean }> = [];
	const handle = makeFakeSpawn();
	const p = runPiChild({
		command: "pi",
		args: [],
		cwd: process.cwd(),
		spawn: handle.spawn,
		now: () => "2026-08-05T12:00:00.000Z",
		onEvent: (ev) => seen.push(ev),
	});
	const child = await waitForChild(handle);
	child.emitLine(toolExecutionStartLine("read", { path: "src/a.ts" }));
	child.emitLine(toolExecutionUpdateLine("bash", "npm test output line"));
	child.emitLine(toolExecutionEndLine("bash", "all tests passed"));
	child.emitLine(toolExecutionEndLine("bash", "boom", true));
	child.emitClose(0);
	await p;

	assert.deepEqual(
		seen.filter((e) => e.type !== "exit").map((e) => e.type),
		["tool_execution_start", "tool_execution_update", "tool_execution_end", "tool_execution_end"],
	);
	assert.equal(seen[0].toolName, "read");
	assert.equal(seen[0].argsSummary, '{"path":"src/a.ts"}');
	assert.equal(seen[1].text, "npm test output line");
	assert.equal(seen[2].text, "all tests passed");
	assert.equal(seen[2].isError, undefined);
	assert.equal(seen[3].isError, true);
});

test("tool events are also accumulated into the audit events array", async () => {
	const handle = makeFakeSpawn();
	const p = runPiChild({
		command: "pi",
		args: [],
		cwd: process.cwd(),
		spawn: handle.spawn,
		now: () => "2026-08-05T12:00:00.000Z",
	});
	const child = await waitForChild(handle);
	child.emitLine(toolExecutionStartLine("grep"));
	child.emitLine(toolExecutionEndLine("grep", "match"));
	child.emitClose(0);
	const outcome = await p;
	const types = outcome.events.map((e) => e.type);
	assert.deepEqual(types, ["tool_execution_start", "tool_execution_end", "exit"]);
});

test("message_update is throttled to one event per interval and never accumulated", async () => {
	let ms = 0;
	const handle = makeFakeSpawn();
	const seen: string[] = [];
	const p = runPiChild({
		command: "pi",
		args: [],
		cwd: process.cwd(),
		spawn: handle.spawn,
		now: () => "2026-08-05T12:00:00.000Z",
		nowMs: () => ms,
		onEvent: (ev) => {
			if (ev.type === "message_update") seen.push(ev.text);
		},
	});
	const child = await waitForChild(handle);
	child.emitLine(messageUpdateLine("first"));
	ms = 100;
	child.emitLine(messageUpdateLine("second")); // within the throttle window -> dropped
	ms = MESSAGE_UPDATE_THROTTLE_MS + 100;
	child.emitLine(messageUpdateLine("third")); // after the window -> emitted
	child.emitClose(0);
	const outcome = await p;
	assert.deepEqual(seen, ["first", "third"]);
	assert.equal(outcome.events.some((e) => e.type === "message_update"), false);
});

test("message_end carries the sanitized assistant text tail", async () => {
	const handle = makeFakeSpawn();
	const seen: Array<{ type: string; text?: string }> = [];
	const p = runPiChild({
		command: "pi",
		args: [],
		cwd: process.cwd(),
		spawn: handle.spawn,
		now: () => "2026-08-05T12:00:00.000Z",
		onEvent: (ev) => seen.push(ev),
	});
	const child = await waitForChild(handle);
	child.emitLine(messageEndLine("assistant", { content: [{ type: "text", text: "done with the task" }] }));
	child.emitClose(0);
	await p;
	const end = seen.find((e) => e.type === "message_end");
	assert.equal(end?.text, "done with the task");
});

test("an observer that throws never breaks the run", async () => {
	const handle = makeFakeSpawn();
	const p = runPiChild({
		command: "pi",
		args: [],
		cwd: process.cwd(),
		spawn: handle.spawn,
		now: () => "2026-08-05T12:00:00.000Z",
		onEvent: () => {
			throw new Error("observer boom");
		},
	});
	const child = await waitForChild(handle);
	child.emitLine(toolExecutionStartLine("read"));
	child.emitLine(messageEndLine("assistant"));
	child.emitClose(0);
	const outcome = await p;
	assert.equal(outcome.exitCode, 0);
	assert.equal(outcome.finalText, "final output");
});

test("textTail flattens whitespace and keeps the bounded tail", () => {
	assert.equal(textTail("  a\n\tb  c "), "a b c");
	const long = "x".repeat(500);
	const tail = textTail(`start ${long}`);
	assert.ok(tail.startsWith("…"));
	assert.ok(tail.length <= 201); // ellipsis + 200 chars
});

test("summarizeArgs bounds args payloads and skips empties", () => {
	assert.equal(summarizeArgs(undefined), "");
	assert.equal(summarizeArgs({}), "");
	assert.equal(summarizeArgs("hello"), "hello");
	assert.equal(summarizeArgs({ a: 1 }), '{"a":1}');
	const big = { blob: "y".repeat(400) };
	assert.ok(summarizeArgs(big).length <= 121);
	assert.ok(summarizeArgs(big).startsWith("…"));
});

test("PiAgentRunner threads spec.onEvent through to the child stream", async () => {
	const handle = makeFakeSpawn();
	const runner = new PiAgentRunner({
		agents: [{ name: "worker", description: "", systemPrompt: "", source: "builtin" as const, filePath: "worker.md" }],
		spawn: handle.spawn,
		now: () => "2026-08-05T12:00:00.000Z",
	});
	const seen: string[] = [];
	const done = runner.run({ prompt: "do it", onEvent: (ev) => seen.push(ev.type) });
	const child = await waitForChild(handle);
	child.emitLine(toolExecutionStartLine("read", { path: "src/a.ts" }));
	child.emitLine(messageEndLine("assistant"));
	child.emitClose(0);
	await done;
	assert.ok(seen.includes("tool_execution_start"), "live events flow from spec.onEvent");
	assert.ok(seen.includes("message_end"));
});
