/**
 * team_dispatch executor tests: request validation, member resolution,
 * bounded concurrency, worktree planning, report building, abort.
 */

import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import {
  buildDispatchReport,
  buildProgressText,
  createDispatchExecutor,
  parseDispatchMemberResults,
  parseDispatchRequest,
} from "../dispatch.ts";
import { fixtureTeam } from "./fixtures.ts";
import { makeFakeSpawn, messageEndLine, sleep, waitForChild } from "./helpers.ts";

function assistantLine(text: string, turn = 1): string {
  return messageEndLine("assistant", {
    content: [{ type: "text", text }],
    usage: { input: 100, output: 50, cost: { total: 0.01 }, totalTokens: 150 },
    stopReason: "stop",
  });
}

function baseDeps() {
  const spawn = makeFakeSpawn();
  return {
    deps: {
      team: fixtureTeam(),
      cwd: "/repo",
      worktreeRoot: "/tmp/worktrees",
      runId: "run-1",
      spawn: spawn.spawn,
      piCommand: "pi",
      killGraceMs: 20,
    },
    spawn,
  };
}

test("parseDispatchRequest validates and normalizes tasks", () => {
  assert.equal(parseDispatchRequest(null).ok, false);
  assert.equal(parseDispatchRequest({ tasks: [] }).ok, false);
  assert.equal(parseDispatchRequest({ tasks: new Array(9).fill({ agent: "a", task: "t" }) }).ok, false);
  const bad = parseDispatchRequest({ tasks: [{ agent: "", task: "t" }] });
  assert.equal(bad.ok, false);
  const good = parseDispatchRequest({ tasks: [{ agent: " frontend ", task: " 实现登录页 " }] });
  assert.ok(good.ok);
  assert.deepEqual(good.value?.tasks, [{ agent: "frontend", task: "实现登录页" }]);
});

test("dispatch runs members in parallel and returns a per-member report", async () => {
  const { deps, spawn } = baseDeps();
  const executor = createDispatchExecutor(deps);
  const updates: Array<{ text: string; details?: unknown }> = [];
  const promise = executor(
    { tasks: [{ agent: "frontend", task: "写登录页" }, { agent: "backend", task: "写 API" }] },
    undefined,
    (update) => updates.push({ text: update.content[0]?.text ?? "", details: update.details }),
  );
  const [frontendChild, backendChild] = [await waitForChild(spawn, 0), await waitForChild(spawn, 1)];
  // Spawn order between members races — key each response to its task arg.
  for (const [index, rec] of spawn.records.entries()) {
    const text = rec.args[rec.args.length - 1].includes("写登录页") ? "前端完成" : "后端完成";
    spawn.children[index].autoRespond([assistantLine(text)], 0, 10);
  }
  void frontendChild;
  void backendChild;
  const outcome = await promise;

  assert.equal(outcome.results.length, 2);
  assert.ok(outcome.results.every((r) => r.ok && r.status === "done"));
  const frontendResult = outcome.results.find((r) => r.name === "frontend");
  const backendResult = outcome.results.find((r) => r.name === "backend");
  assert.equal(frontendResult?.result, "前端完成");
  assert.ok(frontendResult.usage.cost > 0);
  assert.equal(backendResult?.result, "后端完成");
  assert.match(outcome.text, /## frontend — done/);
  assert.match(outcome.text, /前端完成/);
  assert.match(outcome.text, /## backend — done/);
  assert.match(outcome.text, /后端完成/);
  assert.ok(updates.length > 0, "progress snapshots emitted");
  const parsed = parseDispatchMemberResults(updates[updates.length - 1].details);
  assert.equal(parsed?.length, 2);
});

test("member children receive model/tools/prompt flags and the task text", async () => {
  const { deps, spawn } = baseDeps();
  const executor = createDispatchExecutor(deps);
  const promise = executor({ tasks: [{ agent: "frontend", task: "写登录页" }] }, undefined, undefined);
  const child = await waitForChild(spawn, 0);

  // Spawn order between members races — locate the frontend child by task.
  const record = spawn.records.find((r) => r.args[r.args.length - 1] === "Task: 写登录页");
  assert.ok(record);
  assert.equal(record.cwd, "/repo");
  const args = record.args;
  assert.ok(args.includes("--model"));
  assert.equal(args[args.indexOf("--model") + 1], "chatanywhere/gpt-5.6");
  assert.ok(args.includes("--tools"));
  assert.equal(args[args.indexOf("--tools") + 1], "read,edit,bash");
  const promptIndex = args.indexOf("--append-system-prompt");
  const promptPath = args[promptIndex + 1];
  assert.ok(!promptPath.startsWith("team-tmp://"), "prompt materialized before spawn");
  assert.match(fs.readFileSync(promptPath, "utf-8"), /你是前端工程师/);
  assert.equal(args[args.length - 1], "Task: 写登录页");
  assert.deepEqual(args.slice(0, 4), ["--mode", "json", "-p", "--no-session"]);

  child.autoRespond([assistantLine("done")], 0, 5);
  await promise;
  assert.equal(fs.existsSync(promptPath), false, "temp prompt cleaned up");
  child.autoRespond([assistantLine("ok")], 0, 5);
  await promise;
  assert.equal(fs.existsSync(promptPath), false, "temp prompt cleaned up");
});

test("unknown members fail per-task with the roster, other tasks still run", async () => {
  const { deps, spawn } = baseDeps();
  const executor = createDispatchExecutor(deps);
  const promise = executor(
    { tasks: [{ agent: "ghost", task: "x" }, { agent: "frontend", task: "y" }] },
    undefined,
    undefined,
  );
  const child = await waitForChild(spawn, 0);
  child.autoRespond([assistantLine("ok")]);
  const outcome = await promise;

  assert.equal(outcome.results.length, 2);
  assert.equal(outcome.results[0].ok, false);
  assert.equal(outcome.results[0].status, "failed");
  assert.equal(outcome.results[0].error?.code, "MEMBER_NOT_FOUND");
  assert.match(outcome.results[0].error?.message ?? "", /frontend/);
  assert.equal(outcome.results[1].ok, true);
});

test("worktree members run in their isolated worktree path and branch", async () => {
  const gitCalls: Array<{ args: string[]; cwd?: string }> = [];
  const fakeGit = async (args: string[], cwd?: string) => {
    gitCalls.push({ args, cwd });
    // rev-parse --is-inside-work-tree must report a repo
    return { code: 0, stdout: args[0] === "rev-parse" ? "true\n" : "", stderr: "" };
  };
  const { deps, spawn } = baseDeps();
  const worktreeTeam = fixtureTeam({
    members: [{ name: "backend", model: "anthropic/claude-sonnet-4-5", worktree: true, prompt: "你是后端工程师。" }],
  });
  const executor = createDispatchExecutor({ ...deps, team: worktreeTeam, gitRunner: fakeGit });
  const promise = executor({ tasks: [{ agent: "backend", task: "改数据库" }] }, undefined, undefined);
  const child = await waitForChild(spawn, 0);
  child.autoRespond([assistantLine("完成")]);
  const outcome = await promise;

  const expectedPath = path.join("/tmp/worktrees", "run-1", "backend");
  const add = gitCalls.find((c) => c.args[0] === "worktree");
  assert.ok(add, "git worktree add invoked");
  assert.deepEqual(add.args, ["worktree", "add", expectedPath, "-b", "team/run-1/backend"]);
  assert.equal(add.cwd, "/repo");
  assert.equal(spawn.records[0].cwd, expectedPath);
  const result = outcome.results[0];
  assert.deepEqual(result.worktree, { path: expectedPath, branch: "team/run-1/backend" });
  assert.ok(outcome.text.includes(`worktree: \`${expectedPath}\``));
});

test("worktree creation failure fails that member without spawning a child", async () => {
  const fakeGit = async (args: string[]) =>
    args[0] === "rev-parse" ? { code: 1, stdout: "false\n", stderr: "" } : { code: 0, stdout: "", stderr: "" };
  const { deps, spawn } = baseDeps();
  const worktreeTeam = fixtureTeam({
    members: [{ name: "backend", model: "anthropic/claude-sonnet-4-5", worktree: true, prompt: "你是后端工程师。" }],
  });
  const executor = createDispatchExecutor({ ...deps, team: worktreeTeam, gitRunner: fakeGit });
  const outcome = await executor({ tasks: [{ agent: "backend", task: "x" }] }, undefined, undefined);
  assert.equal(spawn.records.length, 0);
  assert.equal(outcome.results[0].ok, false);
  assert.equal(outcome.results[0].error?.code, "WORKTREE_UNAVAILABLE");
});

test("concurrency is capped at 4 members", async () => {
  const members = Array.from({ length: 6 }, (_, i) => ({
    name: `m${i}`,
    prompt: `p${i}`,
  }));
  const { deps, spawn } = baseDeps();
  const executor = createDispatchExecutor({ ...deps, team: fixtureTeam({ members }) });
  const tasks = members.map((m) => ({ agent: m.name, task: "t" }));
  const promise = executor({ tasks }, undefined, undefined);

  // Only 4 children may exist before any of them finishes.
  await waitForChild(spawn, 3);
  await sleep(30);
  assert.equal(spawn.records.length, 4, `expected 4 concurrent, got ${spawn.records.length}`);
  for (let i = 0; i < 4; i++) spawn.children[i].autoRespond([assistantLine("ok")], 0, 5);
  await waitForChild(spawn, 4);
  await waitForChild(spawn, 5);
  for (let i = 4; i < 6; i++) spawn.children[i].autoRespond([assistantLine("ok")], 0, 5);
  const outcome = await promise;
  assert.equal(outcome.results.length, 6);
  assert.ok(outcome.results.every((r) => r.ok));
});

test("member child failure yields a failed member result, not a thrown error", async () => {
  const { deps, spawn } = baseDeps();
  const executor = createDispatchExecutor(deps);
  const promise = executor({ tasks: [{ agent: "frontend", task: "x" }] }, undefined, undefined);
  const child = await waitForChild(spawn, 0);
  child.autoRespond([assistantLine("boom")], 3, 5);
  const outcome = await promise;
  assert.equal(outcome.results[0].ok, false);
  assert.equal(outcome.results[0].status, "failed");
  assert.equal(outcome.results[0].error?.code, "CHILD_FAILED");
  assert.match(outcome.text, /failed（CHILD_FAILED）/);
});

test("abort kills running member children", async () => {
  const { deps, spawn } = baseDeps();
  const executor = createDispatchExecutor(deps);
  const controller = new AbortController();
  const promise = executor(
    { tasks: [{ agent: "frontend", task: "x" }, { agent: "backend", task: "y" }] },
    controller.signal,
    undefined,
  );
  const [c0, c1] = [await waitForChild(spawn, 0), await waitForChild(spawn, 1)];
  controller.abort();
  await sleep(50);
  assert.ok(c0.killed.includes("SIGTERM"));
  assert.ok(c1.killed.includes("SIGTERM"));
  c0.emitClose(null);
  c1.emitClose(null);
  const outcome = await promise;
  assert.ok(outcome.results.every((r) => r.status === "aborted"));
});

test("buildProgressText renders status icons", () => {
  const text = buildProgressText([
    { name: "a", status: "running", note: "turn 2" },
    { name: "b", status: "done" },
  ]);
  assert.match(text, /▶ a running — turn 2/);
  assert.match(text, /✓ b done/);
});

test("buildDispatchReport includes cost and member sections", () => {
  const report = buildDispatchReport([
    {
      name: "frontend",
      ok: true,
      status: "done",
      result: "页面完成",
      summary: "页面完成",
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0.02, turns: 1 },
      durationMs: 4500,
    },
  ]);
  assert.match(report, /## frontend — done（4\.5s，\$0\.0200）/);
  assert.match(report, /页面完成/);
});
