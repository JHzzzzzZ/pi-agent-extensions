/**
 * Child pi runner tests: line-JSON parsing, usage accumulation, temp
 * prompt materialization, env injection, abort semantics.
 */

import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { getPiInvocation, runChildPi } from "../runner.ts";
import { makeFakeSpawn, messageEndLine, sleep, waitForChild } from "./helpers.ts";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agent-team-run-"));
}

test("runChildPi parses JSON events and accumulates usage/finalText", async () => {
  const spawn = makeFakeSpawn();
  const events: string[] = [];
  const promise = runChildPi({
    command: "pi",
    args: ["--mode", "json", "-p", "--no-session", "Task: demo"],
    spawn: spawn.spawn,
    onEvent: (event) => events.push(event.type),
  });
  const child = await waitForChild(spawn);
  child.emitLine(messageEndLine("user", { content: [{ type: "text", text: "hi" }] }));
  child.emitLine(
    messageEndLine("assistant", {
      content: [{ type: "text", text: "PART1" }],
      usage: { input: 10, output: 5, cost: { total: 0.01 } },
      model: "m1",
    }),
  );
  child.emitLine(
    messageEndLine("assistant", {
      content: [{ type: "text", text: "PART2" }],
      usage: { input: 20, output: 8, cost: { total: 0.02 } },
      model: "m2",
      stopReason: "stop",
    }),
  );
  child.emitClose(0);
  const outcome = await promise;

  assert.equal(outcome.exitCode, 0);
  assert.equal(outcome.finalText, "PART2");
  assert.equal(outcome.usage.turns, 2);
  assert.equal(outcome.usage.input, 30);
  assert.equal(outcome.usage.output, 13);
  assert.ok(Math.abs(outcome.usage.cost - 0.03) < 1e-9);
  assert.equal(outcome.model, "m2");
  assert.equal(outcome.stopReason, "stop");
  assert.deepEqual(events, ["message_end", "message_end", "message_end", "exit"]);
});

test("runChildPi buffers partial stdout chunks", async () => {
  const spawn = makeFakeSpawn();
  const promise = runChildPi({ command: "pi", args: [], spawn: spawn.spawn });
  const child = await waitForChild(spawn);
  const line = messageEndLine("assistant", { content: [{ type: "text", text: "SPLIT" }] });
  const [a, b] = [line.slice(0, 17), line.slice(17)];
  child.emitChunk(a);
  child.emitChunk(b);
  child.emitChunk("\n");
  child.emitClose(0);
  const outcome = await promise;
  assert.equal(outcome.finalText, "SPLIT");
});

test("runChildPi surfaces tool_execution events and stderr", async () => {
  const spawn = makeFakeSpawn();
  const promise = runChildPi({ command: "pi", args: [], spawn: spawn.spawn });
  const child = await waitForChild(spawn);
  child.emitLine(JSON.stringify({ type: "tool_execution_start", toolName: "team_dispatch", args: { tasks: [] } }));
  child.emitLine(JSON.stringify({ type: "tool_execution_update", toolName: "team_dispatch", partial: { content: [{ type: "text", text: "progress" }] } }));
  child.emitLine("not json at all");
  child.emitStderr("boom");
  child.emitClose(0);
  const outcome = await promise;
  const types = outcome.events.map((e) => e.type);
  assert.ok(types.includes("tool_execution_start"));
  assert.ok(types.includes("tool_execution_update"));
  const update = outcome.events.find((e) => e.type === "tool_execution_update");
  assert.equal(update?.type === "tool_execution_update" ? update.text : undefined, "progress");
  assert.equal(outcome.stderr, "boom");
});

test("runChildPi materializes team-tmp:// prompts into temp files and cleans up", async () => {
  const spawn = makeFakeSpawn();
  const promise = runChildPi({
    command: "pi",
    args: ["--append-system-prompt", "team-tmp://SECRET PROMPT 内容", "Task: x"],
    spawn: spawn.spawn,
  });
  const child = await waitForChild(spawn);
  const passed = spawn.records[0].args;
  const promptIndex = passed.indexOf("--append-system-prompt");
  const tmpPath = passed[promptIndex + 1];
  assert.ok(!tmpPath.startsWith("team-tmp://"));
  assert.equal(fs.readFileSync(tmpPath, "utf-8"), "SECRET PROMPT 内容");
  child.emitClose(0);
  await promise;
  assert.equal(fs.existsSync(tmpPath), false, "temp prompt removed after exit");
});

test("runChildPi merges extra env into the child environment", async () => {
  const spawn = makeFakeSpawn();
  const promise = runChildPi({
    command: "pi",
    args: [],
    env: { PI_AGENT_TEAM_FILE: "/teams/x.md", PI_AGENT_TEAM_NAME: "x" },
    spawn: spawn.spawn,
  });
  const child = await waitForChild(spawn);
  child.emitClose(0);
  await promise;
  assert.equal(spawn.records[0].env?.PI_AGENT_TEAM_FILE, "/teams/x.md");
  assert.equal(spawn.records[0].env?.PI_AGENT_TEAM_NAME, "x");
});

test("abort kills the child SIGTERM then SIGKILL after the grace period", async () => {
  const spawn = makeFakeSpawn();
  const controller = new AbortController();
  const promise = runChildPi({
    command: "pi",
    args: [],
    spawn: spawn.spawn,
    signal: controller.signal,
    killGraceMs: 20,
  });
  const child = await waitForChild(spawn);
  controller.abort();
  await sleep(60);
  assert.deepEqual(child.killed, ["SIGTERM", "SIGKILL"]);
  child.emitClose(null);
  const outcome = await promise;
  const codes = outcome.events.map((e) => (e.type === "error" ? e.code : e.type));
  assert.ok(codes.includes("AGENT_ABORTED"));
  assert.ok(codes.includes("exit"));
});

test("a pre-aborted signal kills the child immediately; spawn errors are reported", async () => {
  const controller = new AbortController();
  controller.abort();
  const spawn = makeFakeSpawn();
  const promise = runChildPi({
    command: "pi",
    args: [],
    spawn: spawn.spawn,
    signal: controller.signal,
    killGraceMs: 10,
  });
  const child = await waitForChild(spawn);
  await sleep(30);
  assert.ok(child.killed.includes("SIGTERM"), "pre-aborted signal kills the child");
  child.emitClose(null);
  const outcome = await promise;
  assert.ok(outcome.events.some((e) => e.type === "error" && e.code === "AGENT_ABORTED"));

  const failing = makeFakeSpawn();
  failing.spawnError = new Error("E2BIG");
  // Sync spawn errors are re-thrown to the caller (dispatch/cockpit wrap
  // them into typed CHILD_FAILED results).
  await assert.rejects(
    () => runChildPi({ command: "pi", args: [], spawn: failing.spawn }),
    /E2BIG/,
  );
});

test("getPiInvocation falls back to `pi` under a generic node runtime", () => {
  const invocation = getPiInvocation(["--mode", "json"]);
  assert.ok(invocation.command.length > 0);
  assert.ok(invocation.args.includes("--mode"));
});
