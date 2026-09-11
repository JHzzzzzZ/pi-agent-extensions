/**
 * team_dispatch executor tests: request validation, member resolution,
 * bounded concurrency, worktree planning, progress snapshots (latest
 * activity), failure visibility, dispatch budget, report building, abort.
 */

import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  buildDispatchReport,
  buildProgressText,
  createDispatchExecutor,
  parseDispatchMemberResults,
  parseDispatchRequest,
  stripLeaderEnv,
} from "../dispatch.ts";
import { defaultSpawn, runChildPi } from "../runner.ts";
import {
  DERIVED_AGENT_TOOL_DENYLIST,
  LEADER_ENV_FILE,
  LEADER_ENV_NAME,
  LEADER_ENV_RUNID,
  truncateUtf8,
  type DispatchOutcome,
  type ExternalBackend,
  type ExternalCliResolveResult,
} from "../types.ts";
import { fixtureTeam } from "./fixtures.ts";
import { makeFakeSpawn, messageEndLine, sleep, toolExecutionEndLine, toolExecutionStartLine, toolExecutionUpdateLine, waitForChild } from "./helpers.ts";

function assistantLine(text: string): string {
  return messageEndLine("assistant", {
    content: [{ type: "text", text }],
    usage: { input: 100, output: 50, cost: { total: 0.01 }, totalTokens: 150, turns: 1 },
    stopReason: "stop",
  });
}

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

/** 外部 CLI fixture JSONL 行（跳过注释/空行）——fake child 逐行回放用。 */
function fixtureLines(name: string): string[] {
  return fs
    .readFileSync(path.join(FIXTURES, name), "utf-8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
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

/** Unwraps an executor result promise (asserting ok). */
async function unwrap(
  promise: Promise<{ ok: true; value: DispatchOutcome } | { ok: false; code: string; message: string }>,
): Promise<DispatchOutcome> {
  const result = await promise;
  assert.ok(result.ok, result.ok ? "" : `executor failed: ${result.code} ${result.message}`);
  return result.value;
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

test("dispatch runs members in parallel, captures latest activity, returns a per-member report", async () => {
  const { deps, spawn } = baseDeps();
  const executor = createDispatchExecutor(deps);
  const updates: Array<{ text: string; details?: unknown }> = [];
  const promise = executor(
    { tasks: [{ agent: "frontend", task: "写登录页" }, { agent: "backend", task: "写 API" }] },
    undefined,
    (update) => updates.push({ text: update.content[0]?.text ?? "", details: update.details }),
  );
  await waitForChild(spawn, 0);
  await waitForChild(spawn, 1);
  // Spawn order between members races — key each response to its task arg.
  for (const [index, rec] of spawn.records.entries()) {
    const text = rec.args[rec.args.length - 1].includes("写登录页") ? "前端完成" : "后端完成";
    spawn.children[index].autoRespond([assistantLine(text)], 0, 10);
  }
  const outcome = await unwrap(promise);

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
  // Latest activity: the progress snapshot reflects the assistant text tail.
  const frontendProgress = parsed?.find((m) => m.name === "frontend");
  assert.equal(frontendProgress?.latest, "前端完成");
  assert.match(updates[updates.length - 1].text, /前端完成|后端完成/);
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
  // 成员 prompt 全在 argv：stdin 必须保持 ignore，否则 pi 的 `-p` 模式
  // 会等一个永不关闭的管道（v1.15.0 真机死锁）
  assert.equal(record.stdin, "ignore", "member stdin stays ignored");

  child.autoRespond([assistantLine("done")], 0, 5);
  await unwrap(promise);
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
  const outcome = await unwrap(promise);

  assert.equal(outcome.results.length, 2);
  assert.equal(outcome.results[0].ok, false);
  assert.equal(outcome.results[0].status, "failed");
  assert.equal(outcome.results[0].error?.code, "MEMBER_NOT_FOUND");
  assert.match(outcome.results[0].error?.message ?? "", /frontend/);
  assert.equal(outcome.results[1].ok, true);
  assert.match(outcome.text, /失败处理指令/);
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
  const outcome = await unwrap(promise);

  const expectedPath = path.join("/tmp/worktrees", "run-1", "backend");
  const add = gitCalls.find((c) => c.args[0] === "worktree" && c.args[1] === "add");
  assert.ok(add, "git worktree add invoked");
  assert.deepEqual(add.args, ["worktree", "add", expectedPath, "-b", "team/run-1/backend"]);
  assert.equal(add.cwd, "/repo");
  assert.equal(spawn.records[0].cwd, expectedPath);
  const result = outcome.results[0];
  assert.deepEqual(result.worktree, { path: expectedPath, branch: "team/run-1/backend" });
  assert.ok(outcome.text.includes(`worktree: \`${expectedPath}\``));
});

test("worktreeRunId aliases member worktree paths/branches to the resumed parent run", async () => {
  const gitCalls: Array<{ args: string[]; cwd?: string }> = [];
  const fakeGit = async (args: string[], cwd?: string) => {
    gitCalls.push({ args, cwd });
    return { code: 0, stdout: args[0] === "rev-parse" ? "true\n" : "", stderr: "" };
  };
  const { deps, spawn } = baseDeps();
  const worktreeTeam = fixtureTeam({
    members: [{ name: "backend", model: "anthropic/claude-sonnet-4-5", worktree: true, prompt: "你是后端工程师。" }],
  });
  const executor = createDispatchExecutor({ ...deps, team: worktreeTeam, gitRunner: fakeGit, worktreeRunId: "run-parent" });
  const promise = executor({ tasks: [{ agent: "backend", task: "接着改" }] }, undefined, undefined);
  const child = await waitForChild(spawn, 0);
  child.autoRespond([assistantLine("完成")]);
  const outcome = await unwrap(promise);

  const expectedPath = path.join("/tmp/worktrees", "run-parent", "backend");
  const add = gitCalls.find((c) => c.args[0] === "worktree" && c.args[1] === "add");
  assert.ok(add, "git worktree add invoked");
  assert.deepEqual(add.args, ["worktree", "add", expectedPath, "-b", "team/run-parent/backend"]);
  assert.equal(spawn.records[0].cwd, expectedPath, "member reuses the parent run's worktree path");
  assert.deepEqual(outcome.results[0].worktree, { path: expectedPath, branch: "team/run-parent/backend" });
});

test("worktree creation failure fails that member with a visible reason", async () => {
  const fakeGit = async (args: string[]) =>
    args[0] === "rev-parse" ? { code: 1, stdout: "false\n", stderr: "" } : { code: 0, stdout: "", stderr: "" };
  const { deps, spawn } = baseDeps();
  const worktreeTeam = fixtureTeam({
    members: [{ name: "backend", model: "anthropic/claude-sonnet-4-5", worktree: true, prompt: "你是后端工程师。" }],
  });
  const executor = createDispatchExecutor({ ...deps, team: worktreeTeam, gitRunner: fakeGit });
  const updates: Array<{ text: string }> = [];
  const outcome = await unwrap(
    executor({ tasks: [{ agent: "backend", task: "x" }] }, undefined, (u) => updates.push({ text: u.content[0]?.text ?? "" })),
  );
  assert.equal(spawn.records.length, 0);
  assert.equal(outcome.results[0].ok, false);
  assert.equal(outcome.results[0].error?.code, "WORKTREE_UNAVAILABLE");
  assert.match(outcome.text, /失败处理指令/);
  // The failure REASON (not just the code) reaches the progress stream.
  assert.ok(updates.some((u) => u.text.includes("WORKTREE_UNAVAILABLE: ")));
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
  const outcome = await unwrap(promise);
  assert.equal(outcome.results.length, 6);
  assert.ok(outcome.results.every((r) => r.ok));
});

test("member child failure yields a failed member result, not a thrown error", async () => {
  const { deps, spawn } = baseDeps();
  const executor = createDispatchExecutor(deps);
  const promise = executor({ tasks: [{ agent: "frontend", task: "x" }] }, undefined, undefined);
  const child = await waitForChild(spawn, 0);
  child.autoRespond([assistantLine("boom")], 3, 5);
  const outcome = await unwrap(promise);
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
  const outcome = await unwrap(promise);
  assert.ok(outcome.results.every((r) => r.status === "aborted"));
});

test("dispatch budget cuts off an endlessly retrying leader", async () => {
  const { deps, spawn } = baseDeps();
  const executor = createDispatchExecutor(deps);
  // One executor instance (per leader process) across 12 calls: each spawns
  // one member child that responds immediately.
  for (let i = 0; i < 12; i++) {
    const promise = executor({ tasks: [{ agent: "frontend", task: `t${i}` }] }, undefined, undefined);
    const child = await waitForChild(spawn, i);
    child.autoRespond([assistantLine("ok")], 0, 2);
    await unwrap(promise);
  }
  // 13th call: budget exhausted, nothing spawns, message demands wrap-up.
  const exceeded = await executor({ tasks: [{ agent: "frontend", task: "again" }] }, undefined, undefined);
  assert.ok(!exceeded.ok);
  assert.equal(exceeded.code, "BUDGET_EXCEEDED");
  assert.match(exceeded.message, /最终报告/);
  assert.equal(spawn.records.length, 12);
});

test("injected budget lowers the dispatch-call cap", async () => {
  const { deps, spawn } = baseDeps();
  const executor = createDispatchExecutor({ ...deps, budget: { maxDispatchCalls: 2, maxMemberRuns: 100, maxCostUsd: null, maxTotalTokens: null, source: "frontmatter" as const } });
  for (let i = 0; i < 2; i++) {
    const promise = executor({ tasks: [{ agent: "frontend", task: `t${i}` }] }, undefined, undefined);
    const child = await waitForChild(spawn, i);
    child.autoRespond([assistantLine("ok")], 0, 2);
    await unwrap(promise);
  }
  const exceeded = await executor({ tasks: [{ agent: "frontend", task: "again" }] }, undefined, undefined);
  assert.ok(!exceeded.ok);
  assert.equal(exceeded.code, "BUDGET_EXCEEDED");
  assert.match(exceeded.message, /2 次 dispatch/);
  assert.equal(spawn.records.length, 2);
});

test("injected budget lowers the member-run cap", async () => {
  const { deps, spawn } = baseDeps();
  const executor = createDispatchExecutor({ ...deps, budget: { maxDispatchCalls: 100, maxMemberRuns: 3, maxCostUsd: null, maxTotalTokens: null, source: "frontmatter" as const } });
  const first = executor(
    { tasks: [{ agent: "frontend", task: "a" }, { agent: "backend", task: "b" }, { agent: "ghost", task: "c" }] },
    undefined,
    undefined,
  );
  const child0 = await waitForChild(spawn, 0);
  const child1 = await waitForChild(spawn, 1);
  child0.autoRespond([assistantLine("ok")], 0, 2);
  child1.autoRespond([assistantLine("ok")], 0, 2);
  await unwrap(first);
  // 3 member runs consumed (the unknown member still counts toward the cap).
  const exceeded = await executor({ tasks: [{ agent: "frontend", task: "again" }] }, undefined, undefined);
  assert.ok(!exceeded.ok);
  assert.equal(exceeded.code, "BUDGET_EXCEEDED");
  assert.match(exceeded.message, /3 次成员运行/);
  assert.equal(spawn.records.length, 2, "nothing spawned past the cap (2 real members in the first dispatch)");
});

// ---------------------------------------------------------------------------
// buildProgressText / buildDispatchReport (pure)
// ---------------------------------------------------------------------------

test("buildProgressText renders status icons, notes and latest activity", () => {
  const text = buildProgressText([
    { name: "a", status: "running", note: "turn 2", latest: "正在编辑 login.tsx" },
    { name: "b", status: "done" },
  ]);
  assert.match(text, /▶ a running — turn 2 — 正在编辑 login\.tsx/);
  assert.match(text, /✓ b done/);
});

/**
 * Snapshot/restore the env keys these tests mutate. The leader keys are set
 * in the test process to prove the member path strips them (and the real
 * boundary test proves the OS-level child never sees them).
 */
function snapshotMemberEnv(): () => void {
  const keys = [LEADER_ENV_FILE, LEADER_ENV_NAME, LEADER_ENV_RUNID, "AGENT_TEAM_STRIP_SENTINEL"] as const;
  const saved = new Map<string, string | undefined>(keys.map((key) => [key, process.env[key]]));
  return () => {
    for (const key of keys) {
      const value = saved.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

function seedLeaderEnv(): void {
  process.env[LEADER_ENV_FILE] = "/tmp/teams/dev-team.md";
  process.env[LEADER_ENV_NAME] = "dev-team";
  process.env[LEADER_ENV_RUNID] = "run-1789115942094";
  process.env.AGENT_TEAM_STRIP_SENTINEL = "1";
}

test("stripLeaderEnv drops the three leader keys and keeps the rest of the environment", () => {
  const source: NodeJS.ProcessEnv = {
    PATH: "/usr/bin",
    AGENT_TEAM_STRIP_SENTINEL: "1",
    [LEADER_ENV_FILE]: "/tmp/teams/dev-team.md",
    [LEADER_ENV_NAME]: "dev-team",
    [LEADER_ENV_RUNID]: "run-1789115942094",
  };
  const stripped = stripLeaderEnv(source);

  assert.equal(stripped[LEADER_ENV_FILE], undefined);
  assert.equal(stripped[LEADER_ENV_NAME], undefined);
  assert.equal(stripped[LEADER_ENV_RUNID], undefined);
  assert.equal(stripped.AGENT_TEAM_STRIP_SENTINEL, "1");
  assert.equal(stripped.PATH, "/usr/bin");
  // Shallow copy: the caller's object is never mutated.
  assert.equal(source[LEADER_ENV_FILE], "/tmp/teams/dev-team.md");
});

test("derived-agent denylist bans nested agent tools but leaves team_dispatch to the leader", () => {
  assert.ok(DERIVED_AGENT_TOOL_DENYLIST.includes("subagent"));
  assert.ok(DERIVED_AGENT_TOOL_DENYLIST.includes("team_run"));
  assert.ok(!(DERIVED_AGENT_TOOL_DENYLIST as readonly string[]).includes("team_dispatch"));
});

test("member children get a leader-env-stripped env and the derived-tool denylist in argv", async () => {
  const restoreEnv = snapshotMemberEnv();
  seedLeaderEnv();
  try {
    const { deps, spawn } = baseDeps();
    const executor = createDispatchExecutor(deps);
    const promise = executor({ tasks: [{ agent: "frontend", task: "写登录页" }] }, undefined, undefined);
    const child = await waitForChild(spawn, 0);
    const record = spawn.records.find((r) => r.args[r.args.length - 1] === "Task: 写登录页");
    assert.ok(record);

    // The member child must not inherit leader mode (it would load
    // agent-team as a leader and bind to the parent run).
    assert.equal(record.env?.[LEADER_ENV_FILE], undefined);
    assert.equal(record.env?.[LEADER_ENV_NAME], undefined);
    assert.equal(record.env?.[LEADER_ENV_RUNID], undefined);
    assert.equal(record.env?.AGENT_TEAM_STRIP_SENTINEL, "1", "non-leader env is preserved");
    assert.equal(record.env?.PATH, process.env.PATH, "PATH is preserved");

    // Derived agents may not re-enter team/subagent tooling; the flag pair
    // must travel together and precede the task text.
    const denyIndex = record.args.indexOf("--exclude-tools");
    assert.ok(denyIndex >= 0, "member argv carries --exclude-tools");
    assert.equal(record.args[denyIndex + 1], DERIVED_AGENT_TOOL_DENYLIST.join(","));
    assert.ok(denyIndex < record.args.indexOf("--append-system-prompt"));
    assert.ok(denyIndex < record.args.length - 1);

    child.autoRespond([assistantLine("done")], 0, 5);
    await unwrap(promise);
  } finally {
    restoreEnv();
  }
});

test("real child process spawns at the OS level without the leader keys", async () => {
  const restoreEnv = snapshotMemberEnv();
  seedLeaderEnv();
  try {
    const outcome = await runChildPi({
      command: process.execPath,
      args: ["-e", "process.stderr.write(JSON.stringify(process.env))"],
      env: stripLeaderEnv(),
      spawn: defaultSpawn(),
    });
    assert.equal(outcome.exitCode, 0);
    const jsonLine = outcome.stderr
      .split(/\r?\n/)
      .reverse()
      .find((line) => line.startsWith("{"));
    assert.ok(jsonLine, `child env JSON missing in stderr: ${outcome.stderr}`);
    const childEnv = JSON.parse(jsonLine) as Record<string, string>;

    assert.equal(childEnv[LEADER_ENV_FILE], undefined);
    assert.equal(childEnv[LEADER_ENV_NAME], undefined);
    assert.equal(childEnv[LEADER_ENV_RUNID], undefined);
    assert.equal(childEnv.AGENT_TEAM_STRIP_SENTINEL, "1");
    assert.equal(childEnv.PATH, process.env.PATH);
  } finally {
    restoreEnv();
  }
});

test("buildDispatchReport includes cost, member sections and failure guidance", () => {
  const ok = buildDispatchReport([
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
  assert.match(ok, /## frontend — done（4\.5s，\$0\.0200）/);
  assert.match(ok, /页面完成/);
  assert.doesNotMatch(ok, /失败处理指令/);

  const withFailure = buildDispatchReport([
    {
      name: "backend",
      ok: false,
      status: "failed",
      result: "",
      summary: "",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
      durationMs: 0,
      error: { code: "WORKTREE_UNAVAILABLE", message: "/repo 不是 git 仓库" },
    },
  ]);
  assert.match(withFailure, /错误: \/repo 不是 git 仓库/);
  assert.match(withFailure, /失败处理指令/);
  assert.match(withFailure, /不要再次派发/);
});

// ---------------------------------------------------------------------------
// v1.17.0 成员活动阶段（viewer 活动行的成员侧数据源）
// ---------------------------------------------------------------------------

test("成员子进程事件写入活动阶段：tool start→tool+名字、update 刷新、end/message_end→waiting", async () => {
  const { deps, spawn } = baseDeps();
  const executor = createDispatchExecutor(deps);
  const updates: unknown[] = [];
  const promise = executor({ tasks: [{ agent: "frontend", task: "写登录页" }] }, undefined, (update) => updates.push(update.details));
  const child = await waitForChild(spawn, 0);

  const member = () => parseDispatchMemberResults(updates.at(-1))?.find((m) => m.name === "frontend");

  child.emitLine(toolExecutionStartLine("read", { path: "login.tsx" }));
  assert.equal(member()?.status, "running");
  assert.equal(member()?.phase, "tool");
  assert.equal(member()?.toolName, "read");
  assert.equal(typeof member()?.lastActivityAtMs, "number");

  child.emitLine(toolExecutionUpdateLine("read", { content: [{ type: "text", text: "chunk" }] }));
  assert.equal(member()?.phase, "tool", "update 保持工具阶段");
  assert.equal(member()?.toolName, "read");
  assert.equal(typeof member()?.lastActivityAtMs, "number");

  child.emitLine(toolExecutionEndLine("read", { content: [{ type: "text", text: "ok" }] }));
  assert.equal(member()?.phase, "waiting", "工具结束回 waiting");
  assert.equal(member()?.toolName, undefined, "工具名随之清除");

  child.emitLine(
    messageEndLine("assistant", {
      content: [{ type: "text", text: "完成" }],
      usage: { input: 1, output: 1, cost: { total: 0 }, totalTokens: 2, turns: 1 },
    }),
  );
  assert.equal(member()?.phase, "waiting");
  assert.equal(member()?.latest, "完成");

  child.emitClose(0);
  const outcome = await unwrap(promise);
  assert.equal(outcome.results[0].status, "done");
});

// ---------------------------------------------------------------------------
// v1.22.0 外部 CLI 后端成员（dispatch 集成，10-design §5）
// ---------------------------------------------------------------------------

const EXTERNAL_CODEX_BIN = "C:\\tools\\codex.exe";
const EXTERNAL_CLAUDE_BIN = "C:\\tools\\claude.exe";
const CODEX_MEMBER = { name: "coder", backend: "codex" as const, model: "gpt-5.1-codex", prompt: "你是外部码农。" };
const CLAUDE_MEMBER = { name: "coder", backend: "claude" as const, model: "claude-haiku-4-5", prompt: "你是外部码农。" };

/** 固定 resolver（进程边界替身）：直接给出可 spawn 的命令。 */
function fixedResolver(command: string): (backend: ExternalBackend) => ExternalCliResolveResult {
  return () => ({ ok: true, value: { command } });
}

test("外部成员派发：resolver 命令/args 形状、stdin ignore、leader 环境剥离", async () => {
  const restoreEnv = snapshotMemberEnv();
  seedLeaderEnv();
  try {
    const { deps, spawn } = baseDeps();
    const executor = createDispatchExecutor({
      ...deps,
      team: fixtureTeam({ members: [{ ...CODEX_MEMBER }] }),
      resolveExternalCli: fixedResolver(EXTERNAL_CODEX_BIN),
    });
    const promise = executor({ tasks: [{ agent: "coder", task: "写脚本" }] }, undefined, undefined);
    const child = await waitForChild(spawn, 0);

    const record = spawn.records[0];
    assert.equal(record.command, EXTERNAL_CODEX_BIN);
    assert.deepEqual(record.args, [
      "exec",
      "--json",
      "--skip-git-repo-check",
      "--ephemeral",
      "-s",
      "workspace-write",
      "--model",
      "gpt-5.1-codex",
      "你是外部码农。\n\n---\n\nTask: 写脚本",
    ]);
    assert.equal(record.cwd, "/repo");
    // P5：argv prompt + stdin ignore 不挂起；外部 CLI 的任务文本只进 argv。
    assert.equal(record.stdin, "ignore", "external member stdin stays ignored");
    assert.equal(record.env?.[LEADER_ENV_FILE], undefined);
    assert.equal(record.env?.[LEADER_ENV_NAME], undefined);
    assert.equal(record.env?.[LEADER_ENV_RUNID], undefined);
    assert.equal(record.env?.AGENT_TEAM_STRIP_SENTINEL, "1", "non-leader env is preserved");

    child.autoRespond(fixtureLines("external-codex-success.jsonl"), 0, 5);
    const outcome = await unwrap(promise);
    assert.equal(outcome.results[0].status, "done");
  } finally {
    restoreEnv();
  }
});

test("codex 外部成员回放成功 fixture：done + usage 折回 + progress latest", async () => {
  const { deps, spawn } = baseDeps();
  const executor = createDispatchExecutor({
    ...deps,
    team: fixtureTeam({ members: [{ ...CODEX_MEMBER }] }),
    resolveExternalCli: fixedResolver(EXTERNAL_CODEX_BIN),
  });
  const updates: Array<{ text: string; details?: unknown }> = [];
  const promise = executor({ tasks: [{ agent: "coder", task: "写脚本" }] }, undefined, (u) =>
    updates.push({ text: u.content[0]?.text ?? "", details: u.details }),
  );
  const child = await waitForChild(spawn, 0);
  for (const line of fixtureLines("external-codex-success.jsonl")) child.emitLine(line);
  assert.equal(parseDispatchMemberResults(updates.at(-1)?.details)?.[0].latest, "ok", "message_end 更新 latest");
  child.emitClose(0);

  const outcome = await unwrap(promise);
  const result = outcome.results[0];
  assert.equal(result.ok, true);
  assert.equal(result.status, "done");
  assert.equal(result.result, "ok");
  assert.deepEqual(result.usage, { input: 17704, output: 5, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 });
  assert.match(outcome.text, /## coder — done/);
});

test("claude 外部成员：tool_use/tool_result 驱动 progress 阶段，result 定稿 usage", async () => {
  const { deps, spawn } = baseDeps();
  const executor = createDispatchExecutor({
    ...deps,
    team: fixtureTeam({ members: [{ ...CLAUDE_MEMBER }] }),
    resolveExternalCli: fixedResolver(EXTERNAL_CLAUDE_BIN),
  });
  const updates: Array<{ details?: unknown }> = [];
  const promise = executor({ tasks: [{ agent: "coder", task: "读文件" }] }, undefined, (u) =>
    updates.push({ details: u.details }),
  );
  const child = await waitForChild(spawn, 0);
  const member = () => parseDispatchMemberResults(updates.at(-1)?.details)?.[0];

  assert.deepEqual(spawn.records[0].args, [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--no-session-persistence",
    "--permission-mode",
    "acceptEdits",
    "--append-system-prompt",
    "你是外部码农。",
    "--model",
    "claude-haiku-4-5",
    "Task: 读文件",
  ]);

  const lines = fixtureLines("external-claude-success.jsonl");
  child.emitLine(lines[1]); // assistant 文本
  assert.equal(member()?.latest, "我先读取 a.txt 再回答。");
  child.emitLine(lines[2]); // tool_use
  assert.equal(member()?.phase, "tool");
  assert.equal(member()?.toolName, "Read");
  child.emitLine(lines[3]); // tool_result
  assert.equal(member()?.phase, "waiting");
  child.emitLine(lines[4]); // 最终 assistant 文本
  assert.equal(member()?.latest, "a.txt 的内容是 hello。");
  child.emitLine(lines[5]); // result
  child.emitClose(0);

  const outcome = await unwrap(promise);
  const result = outcome.results[0];
  assert.equal(result.status, "done");
  assert.equal(result.result, "a.txt 的内容是 hello。");
  assert.equal(result.usage.cost, 0.0123);
  assert.equal(result.usage.turns, 3);
  assert.equal(result.usage.input, 123);
});

test("claude 外部成员失败：failed 且错误消息取自 result", async () => {
  const { deps, spawn } = baseDeps();
  const executor = createDispatchExecutor({
    ...deps,
    team: fixtureTeam({ members: [{ ...CLAUDE_MEMBER }] }),
    resolveExternalCli: fixedResolver(EXTERNAL_CLAUDE_BIN),
  });
  const promise = executor({ tasks: [{ agent: "coder", task: "读文件" }] }, undefined, undefined);
  const child = await waitForChild(spawn, 0);
  child.autoRespond(fixtureLines("external-claude-error.jsonl"), 1, 5);

  const outcome = await unwrap(promise);
  const result = outcome.results[0];
  assert.equal(result.ok, false);
  assert.equal(result.status, "failed");
  assert.equal(result.error?.code, "CHILD_FAILED");
  assert.match(result.error?.message ?? "", /405 CONNECT only/);
  assert.match(outcome.text, /失败处理指令/);
});

test("外部 CLI 解析失败：零 spawn、failed CLI_NOT_FOUND", async () => {
  const { deps, spawn } = baseDeps();
  const executor = createDispatchExecutor({
    ...deps,
    team: fixtureTeam({ members: [{ ...CODEX_MEMBER }] }),
    resolveExternalCli: () => ({ ok: false, code: "CLI_NOT_FOUND", message: "未找到可直接 spawn 的 codex CLI" }),
  });
  // 守卫：resolver 失败必须无子进程可等（防回归/红灯阶段挂起）。
  const outcome = await Promise.race([
    executor({ tasks: [{ agent: "coder", task: "写脚本" }] }, undefined, undefined).then((r) => (r.ok ? r.value : undefined)),
    sleep(200).then(() => undefined),
  ]);
  assert.ok(outcome, "resolver failure must settle without waiting for a child");
  assert.equal(spawn.records.length, 0, "no child spawns when the CLI cannot be resolved");
  assert.equal(outcome.results[0].ok, false);
  assert.equal(outcome.results[0].status, "failed");
  assert.equal(outcome.results[0].error?.code, "CLI_NOT_FOUND");
  assert.match(outcome.text, /失败处理指令/);
});

test("外部成员 abort：SIGTERM→SIGKILL、成员行 aborted", async () => {
  const { deps, spawn } = baseDeps();
  const executor = createDispatchExecutor({
    ...deps,
    team: fixtureTeam({ members: [{ ...CODEX_MEMBER }] }),
    resolveExternalCli: fixedResolver(EXTERNAL_CODEX_BIN),
  });
  const controller = new AbortController();
  const promise = executor({ tasks: [{ agent: "coder", task: "写脚本" }] }, controller.signal, undefined);
  const child = await waitForChild(spawn, 0);
  controller.abort();
  await sleep(50);
  assert.deepEqual(child.killed, ["SIGTERM", "SIGKILL"]);
  child.emitClose(null);
  const outcome = await unwrap(promise);
  assert.equal(outcome.results[0].status, "aborted");
  assert.equal(outcome.results[0].error?.code, "AGENT_ABORTED");
});

test("混合派单：1 pi + 1 codex 成员同池、各自命令面，同一次 dispatch 完成", async () => {
  const { deps, spawn } = baseDeps();
  const executor = createDispatchExecutor({
    ...deps,
    team: fixtureTeam({
      members: [
        { name: "frontend", model: "chatanywhere/gpt-5.6", prompt: "你是前端工程师。" },
        { ...CODEX_MEMBER },
      ],
    }),
    resolveExternalCli: fixedResolver(EXTERNAL_CODEX_BIN),
  });
  const promise = executor(
    { tasks: [{ agent: "frontend", task: "写登录页" }, { agent: "coder", task: "写脚本" }] },
    undefined,
    undefined,
  );
  await waitForChild(spawn, 1);
  for (const [index, rec] of spawn.records.entries()) {
    if (rec.command === EXTERNAL_CODEX_BIN) {
      spawn.children[index].autoRespond(fixtureLines("external-codex-success.jsonl"), 0, 5);
    } else {
      spawn.children[index].autoRespond([assistantLine("前端完成")], 0, 5);
    }
  }
  const outcome = await unwrap(promise);
  assert.equal(outcome.results.length, 2);
  assert.ok(outcome.results.every((r) => r.ok && r.status === "done"));
  const coder = outcome.results.find((r) => r.name === "coder");
  assert.equal(coder?.result, "ok");
  assert.equal(coder?.usage.input, 17704);
  assert.equal(coder?.usage.cost, 0);
  const frontend = outcome.results.find((r) => r.name === "frontend");
  assert.equal(frontend?.result, "前端完成");
  assert.ok(frontend !== undefined && frontend.usage.cost > 0);
  assert.equal(spawn.records.length, 2);
});

test("外部成员 worktree:true 在隔离 worktree 中启动", async () => {
  const gitCalls: Array<{ args: string[]; cwd?: string }> = [];
  const fakeGit = async (args: string[], cwd?: string) => {
    gitCalls.push({ args, cwd });
    return { code: 0, stdout: args[0] === "rev-parse" ? "true\n" : "", stderr: "" };
  };
  const { deps, spawn } = baseDeps();
  const executor = createDispatchExecutor({
    ...deps,
    team: fixtureTeam({ members: [{ ...CODEX_MEMBER, worktree: true }] }),
    gitRunner: fakeGit,
    resolveExternalCli: fixedResolver(EXTERNAL_CODEX_BIN),
  });
  const promise = executor({ tasks: [{ agent: "coder", task: "写脚本" }] }, undefined, undefined);
  const child = await waitForChild(spawn, 0);
  child.autoRespond(fixtureLines("external-codex-success.jsonl"), 0, 5);
  const outcome = await unwrap(promise);

  const expectedPath = path.join("/tmp/worktrees", "run-1", "coder");
  const add = gitCalls.find((c) => c.args[0] === "worktree" && c.args[1] === "add");
  assert.ok(add, "git worktree add invoked");
  assert.equal(spawn.records[0].cwd, expectedPath, "external member spawns in the isolated worktree");
  assert.deepEqual(outcome.results[0].worktree, { path: expectedPath, branch: "team/run-1/coder" });
});
