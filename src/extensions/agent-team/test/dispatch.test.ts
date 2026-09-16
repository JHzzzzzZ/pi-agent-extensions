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
  stripRunScopedEnv,
  withLoopbackBypass,
} from "../dispatch.ts";
import { defaultSpawn, runChildPi } from "../runner.ts";
import type { TranscriptEntryKind } from "../transcript.ts";
import {
  DERIVED_AGENT_TOOL_DENYLIST,
  LEADER_ENV_FILE,
  LEADER_ENV_MEMBER_MODELS,
  LEADER_ENV_NAME,
  LEADER_ENV_RUNID,
  truncateUtf8,
  type DispatchOutcome,
  type ExternalBackend,
  type ExternalCliResolveResult,
  type PiSpawn,
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

/** 末轮收尾（stopReason/errorMessage 可注）。 */
function turnErrorLine(text: string, errorMessage: string, stopReason: string): string {
  return messageEndLine("assistant", {
    content: [{ type: "text", text }],
    usage: { input: 100, output: 50, cost: { total: 0.01 }, totalTokens: 150, turns: 1 },
    stopReason,
    errorMessage,
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

test("concurrency is capped at 8 members", async () => {
  const members = Array.from({ length: 10 }, (_, i) => ({
    name: `m${i}`,
    prompt: `p${i}`,
  }));
  const { deps, spawn } = baseDeps();
  const executor = createDispatchExecutor({ ...deps, team: fixtureTeam({ members }) });
  const tasks = members.map((m) => ({ agent: m.name, task: "t" }));
  const promise = executor({ tasks }, undefined, undefined);

  // Only 8 children may exist before any of them finishes.
  await waitForChild(spawn, 7);
  await sleep(30);
  assert.equal(spawn.records.length, 8, `expected 8 concurrent, got ${spawn.records.length}`);
  for (let i = 0; i < 8; i++) spawn.children[i].autoRespond([assistantLine("ok")], 0, 5);
  await waitForChild(spawn, 8);
  await waitForChild(spawn, 9);
  for (let i = 8; i < 10; i++) spawn.children[i].autoRespond([assistantLine("ok")], 0, 5);
  const outcome = await unwrap(promise);
  assert.equal(outcome.results.length, 10);
  assert.ok(outcome.results.every((r) => r.ok));
});

test("member child failure yields a failed member result, not a thrown error", async () => {
  const { deps, spawn } = baseDeps();
  const executor = createDispatchExecutor(deps);
  const promise = executor({ tasks: [{ agent: "frontend", task: "x" }] }, undefined, undefined);
  const child = await waitForChild(spawn, 0);
  // 末轮以错误收尾（stopReason error + errorMessage）才是真失败；
  // 末轮干净、仅退出码非 0 走「收尾异常」档（见下方 exit-code 用例）。
  child.autoRespond([turnErrorLine("炸了", "model exploded", "error")], 1, 5);
  const outcome = await unwrap(promise);
  assert.equal(outcome.results[0].ok, false);
  assert.equal(outcome.results[0].status, "failed");
  assert.equal(outcome.results[0].error?.code, "CHILD_FAILED");
  assert.match(outcome.results[0].error?.message ?? "", /model exploded/);
  assert.match(outcome.results[0].error?.message ?? "", /exit 1/, "真 failed 的消息必带 exit code");
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
  const keys = [
    LEADER_ENV_FILE,
    LEADER_ENV_NAME,
    LEADER_ENV_RUNID,
    "AGENT_TEAM_STRIP_SENTINEL",
    // 外部成员 env 透传用例会临时设置代理放行变量。
    "NO_PROXY",
  ] as const;
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

/** 回环豁免缺省值（`withLoopbackBypass` 的注入项，顺序即实现口径）。 */
const LOOPBACK_BYPASS = "127.0.0.1,localhost,::1";

/**
 * 临时移除大小写两份代理放行变量——模拟用户现场「宿主 httpProxy 已设、
 * NO_PROXY 缺失」（#67）。Windows 的 process.env 大小写不敏感，按枚举到的
 * 实际键恢复，避免把还原写成第二份键。
 */
function clearProxyBypassEnv(): () => void {
  const saved = Object.keys(process.env)
    .filter((key) => key.toUpperCase() === "NO_PROXY")
    .map((key) => [key, process.env[key] ?? ""] as const);
  for (const key of Object.keys(process.env)) {
    if (key.toUpperCase() === "NO_PROXY") delete process.env[key];
  }
  return () => {
    for (const [key, value] of saved) process.env[key] = value;
  };
}

/** 断言回环豁免齐备（进程 env 大小写键的存活表现随平台而异，只看集合）。 */
function assertLoopbackBypass(value: string | undefined, label: string): void {
  const entries = (value ?? "").split(",");
  for (const host of LOOPBACK_BYPASS.split(",")) {
    assert.ok(entries.includes(host), `${label} 缺回环项 ${host}：${value ?? "(undefined)"}`);
  }
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

test("withLoopbackBypass 缺省给两个大小写键注入回环豁免，且不改动入参", () => {
  const source: NodeJS.ProcessEnv = { PATH: "/usr/bin", HTTPS_PROXY: "http://127.0.0.1:10899" };
  const bypassed = withLoopbackBypass(source);

  assert.equal(bypassed.NO_PROXY, LOOPBACK_BYPASS);
  assert.equal(bypassed.no_proxy, LOOPBACK_BYPASS);
  assert.equal(bypassed.HTTPS_PROXY, "http://127.0.0.1:10899", "代理变量本身不动");
  assert.equal(bypassed.PATH, "/usr/bin");
  assert.equal(source.NO_PROXY, undefined, "浅拷贝：调用方对象不被修改");
});

test("withLoopbackBypass 保留用户显式值前缀，只追加缺失的回环项", () => {
  const bypassed = withLoopbackBypass({ NO_PROXY: "corp.example.com,127.0.0.1" });

  assert.equal(bypassed.NO_PROXY, "corp.example.com,127.0.0.1,localhost,::1", "原值前缀不动 + 只补缺失项");
  assert.equal(bypassed.no_proxy, LOOPBACK_BYPASS, "未显式设置的键按缺省补齐");
});

test("withLoopbackBypass 已含回环项时不重复追加（大小写不敏感）且重复调用不增字节", () => {
  const existing = "corp.example.com,127.0.0.1,LOCALHOST,::1";
  const once = withLoopbackBypass({ NO_PROXY: existing, no_proxy: existing });

  assert.equal(once.NO_PROXY, existing, "用户值逐字节保留");
  assert.equal(once.no_proxy, existing);
  const twice = withLoopbackBypass(once);
  assert.equal(twice.NO_PROXY, existing, "幂等：再跑一次不增字节");
  assert.equal(twice.no_proxy, existing);
});

test("withLoopbackBypass 只设小写键时大写补齐，且不覆盖小写内容", () => {
  const bypassed = withLoopbackBypass({ no_proxy: "corp.example.com" });

  assert.equal(bypassed.no_proxy, "corp.example.com,127.0.0.1,localhost,::1", "小写键是追加不是覆盖");
  assert.equal(bypassed.NO_PROXY, LOOPBACK_BYPASS, "大写键补齐缺省回环项");
});

test("stripLeaderEnv 给成员 env 补回环豁免（父进程没有 NO_PROXY 的 httpProxy 环境）", () => {
  const stripped = stripLeaderEnv({ PATH: "/usr/bin", HTTPS_PROXY: "http://127.0.0.1:10899" });

  assert.equal(stripped.NO_PROXY, LOOPBACK_BYPASS);
  assert.equal(stripped.no_proxy, LOOPBACK_BYPASS);
  assert.equal(stripped.HTTPS_PROXY, "http://127.0.0.1:10899", "继承语义不变");
  assert.equal(stripped.PATH, "/usr/bin");
});

test("stripRunScopedEnv 给 leader env 补回环豁免并保留用户显式值", () => {
  const stripped = stripRunScopedEnv({
    NO_PROXY: "corp.example.com",
    [LEADER_ENV_FILE]: "/x/team.md",
    [LEADER_ENV_MEMBER_MODELS]: "{}",
  });

  assert.equal(stripped.NO_PROXY, "corp.example.com,127.0.0.1,localhost,::1");
  assert.equal(stripped.no_proxy, LOOPBACK_BYPASS);
  assert.equal(stripped[LEADER_ENV_FILE], undefined, "原有剥键语义不变");
  assert.equal(stripped[LEADER_ENV_MEMBER_MODELS], undefined);
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

test("真实子进程拿到回环代理豁免（无 NO_PROXY 的 httpProxy 现场，#67）", async () => {
  const restoreEnv = snapshotMemberEnv();
  const restoreProxyEnv = clearProxyBypassEnv();
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

    // OS 级证据：真实 spawn 出去的进程里回环豁免键必须存在且值完整（
    // Windows 进程环境大小写不敏感，两个键可能只存活一个，值一致）。
    const bypass = childEnv.NO_PROXY ?? childEnv.no_proxy;
    assert.equal(bypass, LOOPBACK_BYPASS);
  } finally {
    restoreProxyEnv();
    restoreEnv();
  }
});

test("pi 成员子进程 env 带回环豁免（父进程无 NO_PROXY）", async () => {
  const restoreEnv = snapshotMemberEnv();
  const restoreProxyEnv = clearProxyBypassEnv();
  seedLeaderEnv();
  try {
    const { deps, spawn } = baseDeps();
    const executor = createDispatchExecutor(deps);
    const promise = executor({ tasks: [{ agent: "frontend", task: "写登录页" }] }, undefined, undefined);
    const child = await waitForChild(spawn, 0);
    const record = spawn.records.find((r) => r.args[r.args.length - 1] === "Task: 写登录页");
    assert.ok(record);

    // 成员子进程（pi 后端与外部 CLI 后端同一出口）也要放行回环——
    // 本地中继/本地模型服务经宿主 httpProxy 会被 CONNECT-only 桥劫持。
    assert.equal(record.env?.NO_PROXY, LOOPBACK_BYPASS);
    assert.equal(record.env?.no_proxy, LOOPBACK_BYPASS);
    assert.equal(record.env?.PATH, process.env.PATH, "其余 env 仍原样继承");

    child.autoRespond([assistantLine("done")], 0, 5);
    await unwrap(promise);
  } finally {
    restoreProxyEnv();
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

test("外部成员 model 带 :level：spawn 参数注入级别、--model 不带后缀（#66）", async () => {
  const { deps, spawn } = baseDeps();
  const executor = createDispatchExecutor({
    ...deps,
    team: fixtureTeam({ members: [{ ...CODEX_MEMBER, model: "gpt-5.1-codex:high" }] }),
    resolveExternalCli: fixedResolver(EXTERNAL_CODEX_BIN),
  });
  const promise = executor({ tasks: [{ agent: "coder", task: "写脚本" }] }, undefined, undefined);
  const child = await waitForChild(spawn, 0);

  const record = spawn.records[0];
  assert.equal(record.args[record.args.indexOf("--model") + 1], "gpt-5.1-codex", "--model 不带 :level 后缀");
  assert.ok(record.args.includes("model_reasoning_effort=high"), "级别经 -c model_reasoning_effort 注入");
  assert.equal(record.args[record.args.length - 1], "你是外部码农。\n\n---\n\nTask: 写脚本");

  child.autoRespond(fixtureLines("external-codex-success.jsonl"), 0, 5);
  const outcome = await unwrap(promise);
  assert.equal(outcome.results[0].status, "done");
});

test("外部成员 model 带不支持档位：零 spawn、failed EXTERNAL_THINKING_UNSUPPORTED（预检之外的第二道闸）", async () => {
  const { deps, spawn } = baseDeps();
  const executor = createDispatchExecutor({
    ...deps,
    team: fixtureTeam({ members: [{ ...CLAUDE_MEMBER, model: "claude-haiku-4-5:off" }] }),
    resolveExternalCli: fixedResolver(EXTERNAL_CLAUDE_BIN),
  });
  const outcome = await Promise.race([
    executor({ tasks: [{ agent: "coder", task: "读文件" }] }, undefined, undefined).then((r) => (r.ok ? r.value : undefined)),
    sleep(200).then(() => undefined),
  ]);
  assert.ok(outcome, "不支持的档位必须不 spawn 直接落定");
  assert.equal(spawn.records.length, 0, "no child spawns for an unsupported thinking level");
  assert.equal(outcome.results[0].status, "failed");
  assert.equal(outcome.results[0].error?.code, "EXTERNAL_THINKING_UNSUPPORTED");
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

test("外部成员 env 透传：保留父进程 NO_PROXY 并补上缺失的回环项", async () => {
  const restoreEnv = snapshotMemberEnv();
  const restoreProxyEnv = clearProxyBypassEnv();
  seedLeaderEnv();
  process.env.NO_PROXY = "127.0.0.1,localhost";
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

    // F1 修复链路的下半段：leader 子进程继承到的 NO_PROXY 必须能穿过
    // stripLeaderEnv 到达外部成员；#67 再补上缺失的回环项（用户显式
    // 值前缀原样保留，只追加没有的 ::1）。
    assert.equal(record.env?.NO_PROXY, "127.0.0.1,localhost,::1", "显式值前缀原样 + 追加缺失回环项");
    assertLoopbackBypass(record.env?.no_proxy, "no_proxy");
    assert.equal(record.env?.[LEADER_ENV_FILE], undefined);
    assert.equal(record.env?.[LEADER_ENV_NAME], undefined);
    assert.equal(record.env?.[LEADER_ENV_RUNID], undefined);

    child.autoRespond(fixtureLines("external-codex-success.jsonl"), 0, 5);
    const outcome = await unwrap(promise);
    assert.equal(outcome.results[0].status, "done");
  } finally {
    restoreProxyEnv();
    restoreEnv();
  }
});

test("claude 外部成员子进程 env 带回环豁免（本地中继 405 现场，#67）", async () => {
  const restoreEnv = snapshotMemberEnv();
  const restoreProxyEnv = clearProxyBypassEnv();
  seedLeaderEnv();
  try {
    const { deps, spawn } = baseDeps();
    const executor = createDispatchExecutor({
      ...deps,
      team: fixtureTeam({ members: [{ ...CLAUDE_MEMBER }] }),
      resolveExternalCli: fixedResolver(EXTERNAL_CLAUDE_BIN),
    });
    const promise = executor({ tasks: [{ agent: "coder", task: "读文件" }] }, undefined, undefined);
    const child = await waitForChild(spawn, 0);
    const record = spawn.records[0];

    // 用户现场：宿主 httpProxy 只注入 HTTP(S)_PROXY，父进程没有 NO_PROXY——
    // ANTHROPIC_BASE_URL=http://127.0.0.1:15721 的本地中继被 10899 桥劫持
    // （每次派单 405 CONNECT only）。出口必须自己合成豁免。
    assert.equal(record.env?.NO_PROXY, LOOPBACK_BYPASS);
    assert.equal(record.env?.no_proxy, LOOPBACK_BYPASS);
    assert.equal(record.env?.HTTPS_PROXY, process.env.HTTPS_PROXY, "代理变量继承语义不变");

    child.autoRespond(fixtureLines("external-claude-success.jsonl"), 0, 5);
    const outcome = await unwrap(promise);
    assert.equal(outcome.results[0].status, "done");
  } finally {
    restoreProxyEnv();
    restoreEnv();
  }
});

// ---------------------------------------------------------------------------
// ADR-0006 成员终态：末轮说了算（真机 run-1789104779153 的判定口径修复）
// ---------------------------------------------------------------------------

test("成员交付完成但早轮失败：末轮干净 + exit 0 ⇒ done（真机冤案最小复现）", async () => {
  const { deps, spawn } = baseDeps();
  const executor = createDispatchExecutor(deps);
  const promise = executor({ tasks: [{ agent: "frontend", task: "写报告" }] }, undefined, undefined);
  const child = await waitForChild(spawn, 0);
  // 第 1 轮报错、第 2 轮重试成功并给出完整报告（宿主 auto-retry 的常见形态）
  child.autoRespond(
    [turnErrorLine("第一轮失败", "transient 502", "error"), assistantLine("完整报告与 commit 已完成")],
    0,
    5,
  );
  const outcome = await unwrap(promise);
  const result = outcome.results[0];

  assert.equal(result.status, "done", "早轮错误不得把已交付的成员判成 failed");
  assert.equal(result.ok, true);
  assert.equal(result.error, undefined);
  assert.equal(result.warning, undefined, "收尾正常不给 warning");
  assert.equal(result.result, "完整报告与 commit 已完成");
  assert.deepEqual(result.diagnostics?.priorErrors, ["transient 502"], "早轮错误只留诊断");
  assert.equal(result.diagnostics?.priorErrorCount, 1);
  assert.equal(result.diagnostics?.exitCode, 0);
  assert.equal(result.diagnostics?.lastStopReason, "stop");
  assert.match(outcome.text, /## frontend — done/);
  assert.doesNotMatch(outcome.text, /失败处理指令/);
});

test("末轮干净 + exitCode ≠ 0 ⇒ done + warning（收尾异常），产出与 leader 可见面都在", async () => {
  const { deps, spawn } = baseDeps();
  const executor = createDispatchExecutor(deps);
  const promise = executor({ tasks: [{ agent: "frontend", task: "写报告" }] }, undefined, undefined);
  const child = await waitForChild(spawn, 0);
  child.autoRespond([assistantLine("报告正文")], 3, 5);
  const outcome = await unwrap(promise);
  const result = outcome.results[0];

  assert.equal(result.status, "done", "末轮干净不因退出码非 0 被判失败");
  assert.equal(result.ok, true);
  assert.equal(result.warning, "收尾异常：exit 3");
  assert.equal(result.error, undefined, "收尾异常不是 failed：不给 error");
  assert.equal(result.result, "报告正文");
  assert.equal(result.diagnostics?.exitCode, 3);
  assert.match(outcome.text, /## frontend — done（收尾异常：exit 3/);
  assert.doesNotMatch(outcome.text, /失败处理指令/, "收尾异常不进环境级失败指令");
});

test("轮中被打断（未配对工具 + 信号杀）⇒ failed，错误文本标注部分产出（可能可用）", async () => {
  const { deps, spawn } = baseDeps();
  const executor = createDispatchExecutor(deps);
  const promise = executor({ tasks: [{ agent: "frontend", task: "写报告" }] }, undefined, undefined);
  const child = await waitForChild(spawn, 0);
  child.emitLine(assistantLine("写到一半的报告"));
  child.emitLine(toolExecutionStartLine("bash", { command: "sleep 100" }));
  child.emitClose(null, "SIGTERM");
  const outcome = await unwrap(promise);
  const result = outcome.results[0];

  assert.equal(result.status, "failed");
  assert.equal(result.ok, false);
  assert.equal(result.error?.code, "CHILD_FAILED");
  assert.match(result.error?.message ?? "", /轮中被打断，部分产出（可能可用）/);
  assert.match(result.error?.message ?? "", /exit 0，信号 SIGTERM/);
  assert.equal(result.diagnostics?.signal, "SIGTERM");
  assert.equal(result.result, "写到一半的报告", "部分产出仍在结果里");
  assert.match(outcome.text, /（已有完整产出 \d+ 字节，可直接取用）/, "leader 可见产出可直接取用");
  assert.match(outcome.text, /失败处理指令/);
});

test("成员转录 system 行带诊断：exit/末轮 stopReason/前轮错误计数与条目", async () => {
  const entries: Array<{ actor: string; kind: TranscriptEntryKind; text: string }> = [];
  const { deps, spawn } = baseDeps();
  const executor = createDispatchExecutor({
    ...deps,
    transcript: { append: (actor, kind, text) => entries.push({ actor, kind, text }) },
  });
  const promise = executor({ tasks: [{ agent: "frontend", task: "写报告" }] }, undefined, undefined);
  const child = await waitForChild(spawn, 0);
  child.autoRespond([turnErrorLine("第一轮失败", "bad gateway", "error"), assistantLine("最终报告")], 2, 5);
  await unwrap(promise);

  const system = entries.filter((entry) => entry.actor === "frontend" && entry.kind === "system");
  assert.equal(system.length, 1, "每个成员一条 system 收尾行");
  assert.match(system[0].text, /^done（收尾异常：exit 2） · /);
  assert.match(system[0].text, /exit 2 · 末轮 stop · 前轮错误 1 条：bad gateway/);
});

test("buildDispatchReport：失败成员的部分产出附字节数、「可直接取用」提示与正文", () => {
  const base = {
    name: "writer",
    ok: false,
    status: "failed" as const,
    summary: "写到一半的报告",
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 },
    durationMs: 1000,
    error: { code: "CHILD_FAILED" as const, message: "轮中被打断，部分产出（可能可用）：…（exit 1）" },
  };
  const withOutput = buildDispatchReport([{ ...base, result: "写到一半的报告" }]);
  assert.match(withOutput, /## writer — failed（CHILD_FAILED）/);
  assert.match(withOutput, /错误: 轮中被打断/);
  assert.match(withOutput, /（已有完整产出 \d+ 字节，可直接取用）/);
  assert.match(withOutput, /写到一半的报告/, "部分产出正文进 leader 可见面");

  const empty = buildDispatchReport([{ ...base, result: "", summary: "" }]);
  assert.doesNotMatch(empty, /可直接取用/, "无产出不给该提示");

  // done 成员不受影响（正文照旧、无提示）
  const doneReport = buildDispatchReport([
    { ...base, ok: true, status: "done", result: "完整报告", error: undefined },
  ]);
  assert.match(doneReport, /## writer — done/);
  assert.doesNotMatch(doneReport, /可直接取用/);
});

test("真实子进程：脚本化 --mode json 事件流（早轮 errorMessage + 末轮干净 stop）⇒ done 且 priorErrors 留痕", async () => {
  const stream = [
    turnErrorLine("第一轮失败", "transient 502", "error"),
    assistantLine("重试后的最终报告"),
  ];
  const script = `process.stdout.write(${JSON.stringify(`${stream.join("\n")}\n`)});`;
  const { deps } = baseDeps();
  // 真实 OS 管道 + 真实退出码：只把 pi 的 argv 换成回放事件流的 node 子进程
  // （cwd 取真实目录：非存在目录会让 spawn 同步 ENOENT，测试就测不到事件流）
  const realSpawn: PiSpawn = (_command, _args, opts) => defaultSpawn()(process.execPath, ["-e", script], opts);
  const executor = createDispatchExecutor({ ...deps, cwd: process.cwd(), spawn: realSpawn });
  const outcome = await unwrap(executor({ tasks: [{ agent: "frontend", task: "写报告" }] }, undefined, undefined));
  const result = outcome.results[0];

  assert.equal(result.status, "done");
  assert.equal(result.ok, true);
  assert.equal(result.result, "重试后的最终报告");
  assert.equal(result.error, undefined);
  assert.deepEqual(result.diagnostics?.priorErrors, ["transient 502"]);
  assert.equal(result.diagnostics?.priorErrorCount, 1);
  assert.equal(result.diagnostics?.exitCode, 0);
  assert.match(outcome.text, /## frontend — done/);
});

test("外部成员：末轮干净但 CLI 收尾非 0 ⇒ done + warning（与 pi 成员共用判定函数）", async () => {
  const { deps, spawn } = baseDeps();
  const executor = createDispatchExecutor({
    ...deps,
    team: fixtureTeam({ members: [{ ...CODEX_MEMBER }] }),
    resolveExternalCli: fixedResolver(EXTERNAL_CODEX_BIN),
  });
  const promise = executor({ tasks: [{ agent: "coder", task: "写脚本" }] }, undefined, undefined);
  const child = await waitForChild(spawn, 0);
  // 事件流以成功收尾（末轮干净），但 CLI 进程退出码非 0：收尾异常而非失败
  child.autoRespond(fixtureLines("external-codex-success.jsonl"), 1, 5);
  const outcome = await unwrap(promise);
  const result = outcome.results[0];

  assert.equal(result.status, "done");
  assert.equal(result.ok, true);
  assert.equal(result.warning, "收尾异常：exit 1");
  assert.equal(result.error, undefined);
  assert.equal(result.diagnostics?.exitCode, 1);
  assert.match(outcome.text, /## coder — done（收尾异常：exit 1/);
  assert.doesNotMatch(outcome.text, /失败处理指令/);
});
