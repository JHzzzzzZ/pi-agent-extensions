/**
 * team_stop tool tests: main-agent stop by runId against the real entry
 * (fake ExtensionAPI + scripted leader child). Locks the settle-aware stop
 * semantics — terminal aborted record, no followUp report after a stop, and
 * an immediate re-dispatch after the stop settles (no RUN_IN_PROGRESS
 * residue). Also the typed error contract: RUN_ID_REQUIRED /
 * RUN_NOT_FOUND / RUN_ALREADY_FINISHED, never a throw.
 */

import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { serializeTeam } from "../config.ts";
import agentTeamExtension, { resetDoubleLoadGuardForTests } from "../index.ts";
import { fixtureTeam } from "./fixtures.ts";
import {
  makeFakeSpawn,
  messageEndLine,
  sleep,
  toolExecutionEndLine,
  toolExecutionStartLine,
  waitForChild,
  waitForChildByRunId,
  type FakeSpawnHandle,
  isolateRunsDir,
} from "./helpers.ts";

// -- fake ExtensionAPI / ctx (same shape as run-tool.test.ts, kept local) --

function fakePi() {
  const tools = new Map<string, Record<string, unknown>>();
  const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => Promise<void>>>();
  const appendedEntries: Array<{ type: string; data: unknown }> = [];
  const sentMessages: Array<{ message: unknown; options?: unknown }> = [];
  return {
    tools,
    appendedEntries,
    sentMessages,
    on(name: string, fn: (event: unknown, ctx: unknown) => Promise<void>) {
      const list = handlers.get(name) ?? [];
      list.push(fn);
      handlers.set(name, list);
    },
    registerTool(tool: Record<string, unknown> & { name: string }) {
      tools.set(tool.name, tool);
    },
    registerCommand(_name: string, _command: unknown) {},
    registerEntryRenderer(_type: string, _renderer: unknown) {},
    appendEntry(customType: string, data: unknown) {
      appendedEntries.push({ type: customType, data });
      return {};
    },
    sendMessage(message: unknown, options?: unknown) {
      sentMessages.push({ message, options });
      return {};
    },
    async fire(name: string, event: unknown, ctx: unknown) {
      for (const fn of handlers.get(name) ?? []) await fn(event, ctx);
    },
  };
}

function fakeCtx(cwd: string, trusted = true) {
  return {
    cwd,
    hasUI: false,
    isProjectTrusted: () => trusted,
    ui: {},
    sessionManager: { getEntries: () => [] },
  };
}

type Tool = (params: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>;
  details?: unknown;
  isError?: boolean;
}>;

async function setup(): Promise<{
  pi: ReturnType<typeof fakePi>;
  spawn: FakeSpawnHandle;
  run: Tool;
  stop: Tool;
  cleanup: () => void;
}> {
  isolateRunsDir();
  resetDoubleLoadGuardForTests();
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-team-stoptool-"));
  fs.mkdirSync(path.join(projectDir, ".pi", "teams"), { recursive: true });
  const team = fixtureTeam({ name: "proj-team", description: "项目团队", filePath: "", notes: undefined });
  fs.writeFileSync(path.join(projectDir, ".pi", "teams", "proj-team.md"), serializeTeam(team));
  const spawn = makeFakeSpawn();
  const pi = fakePi();
  agentTeamExtension(pi as never, { spawn: spawn.spawn });
  const ctx = fakeCtx(projectDir, true);
  await pi.fire("session_start", { reason: "startup" }, ctx);
  const tool = (name: string) =>
    pi.tools.get(name) as unknown as {
      execute: (id: string, params: Record<string, unknown>, signal?: undefined, onUpdate?: undefined, ctx?: unknown) => ReturnType<Tool>;
    };
  return {
    pi,
    spawn,
    run: (params) => tool("team_run").execute("call-run", params, undefined, undefined, ctx),
    stop: (params) => tool("team_stop").execute("call-stop", params, undefined, undefined, ctx),
    cleanup: () => fs.rmSync(projectDir, { recursive: true, force: true }),
  };
}

function dispatchDetails(members: Array<Record<string, unknown>>): string {
  return toolExecutionEndLine("team_dispatch", {
    content: [{ type: "text", text: "report" }],
    details: { members, totalUsage: { input: 1, output: 1, cost: 0.02, turns: 2 } },
  });
}

function leaderLines(): string[] {
  return [
    messageEndLine("assistant", {
      content: [{ type: "text", text: "让我先把任务拆解成两个子任务" }],
      usage: { input: 10, output: 5, cost: { total: 0.001 }, totalTokens: 15 },
    }),
    toolExecutionStartLine("team_dispatch", { tasks: [{ agent: "frontend", task: "a" }, { agent: "backend", task: "b" }] }),
    dispatchDetails([
      { name: "frontend", ok: true, status: "done", summary: "前端做完", latest: "前端完成", usage: { input: 10, output: 5, cost: 0.01, turns: 1 } },
      { name: "backend", ok: true, status: "done", summary: "后端做完", usage: { input: 20, output: 8, cost: 0.02, turns: 2 } },
    ]),
    messageEndLine("assistant", {
      content: [{ type: "text", text: "FINAL REPORT" }],
      usage: { input: 50, output: 20, cost: { total: 0.05 }, totalTokens: 300 },
      model: "claude-opus-4-5",
    }),
  ];
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 400 && !predicate(); i++) await sleep(5);
}

test("team_stop stops an active background run by runId: SIGTERM, aborted record, no followUp", async () => {
  const { pi, spawn, run, stop, cleanup } = await setup();
  try {
    const first = await run({ team: "proj-team", task: "修复登录 bug" });
    const runId = (first.details as { runId?: string }).runId;
    assert.ok(runId && /^run-\d+$/.test(runId), "runId surfaced by team_run");
    const child = await waitForChild(spawn, 0);

    const stopPromise = stop({ runId });
    assert.ok(child.killed.includes("SIGTERM"), "leader killed while waiting");
    child.emitClose(null);
    const result = await stopPromise;

    assert.notEqual(result.isError, true);
    const details = result.details as { stopped?: boolean; settled?: boolean; runId?: string; team?: string; status?: string; record?: { status?: string; members?: unknown[] } };
    assert.equal(details.stopped, true);
    assert.equal(details.settled, true);
    assert.equal(details.runId, runId);
    assert.equal(details.team, "proj-team");
    assert.equal(details.status, "aborted");
    assert.equal(details.record?.status, "aborted");
    assert.match(result.content[0].text, /已停止|中止/);
    assert.match(result.content[0].text, new RegExp(runId.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")));

    // Terminal record persisted; the aborted run never delivers a followUp report.
    const abortedEntry = pi.appendedEntries.find(
      (entry) => entry.type === "agent-team-run-v1" && (entry.data as { runId?: string }).runId === runId,
    );
    assert.ok(abortedEntry, "aborted run record appended");
    assert.equal((abortedEntry.data as { status?: string }).status, "aborted");
    assert.equal(pi.sentMessages.length, 0, "no followUp report after a stop");
  } finally {
    cleanup();
  }
});

test("team_stop errors with RUN_ALREADY_FINISHED for a finished runId (no signal, no spawn)", async () => {
  const { pi, spawn, run, stop, cleanup } = await setup();
  try {
    const first = await run({ team: "proj-team", task: "修复登录 bug" });
    const runId = (first.details as { runId?: string }).runId;
    const child = await waitForChild(spawn, 0);
    child.autoRespond(leaderLines(), 0, 5);
    await waitFor(() => pi.sentMessages.length > 0);

    const result = await stop({ runId });
    assert.equal(result.isError, true);
    assert.equal((result.details as { code?: string }).code, "RUN_ALREADY_FINISHED");
    assert.equal(child.killed.length, 0, "no kill for a finished run");
    assert.equal(spawn.records.length, 1, "no new leader spawned");
  } finally {
    cleanup();
  }
});

test("team_stop errors with RUN_NOT_FOUND for an unknown runId", async () => {
  const { spawn, stop, cleanup } = await setup();
  try {
    const result = await stop({ runId: "run-999" });
    assert.equal(result.isError, true);
    assert.equal((result.details as { code?: string }).code, "RUN_NOT_FOUND");
    assert.equal(spawn.records.length, 0, "nothing spawned");
  } finally {
    cleanup();
  }
});

test("team_stop without runId on an idle session reports nothing to stop (not an error)", async () => {
  const { spawn, stop, cleanup } = await setup();
  try {
    const result = await stop({});
    assert.notEqual(result.isError, true, "0 活跃不是错误");
    assert.match(result.content[0].text, /当前没有正在进行的 team run/);
    assert.deepEqual(result.details, { stopped: false, activeCount: 0 });
    assert.equal(spawn.records.length, 0, "nothing spawned");
  } finally {
    cleanup();
  }
});

test("team_stop without runId stops the single active run", async () => {
  const { pi, spawn, run, stop, cleanup } = await setup();
  try {
    const first = await run({ team: "proj-team", task: "one" });
    const runId = (first.details as { runId?: string }).runId;
    const child = await waitForChild(spawn, 0);

    const stopPromise = stop({});
    assert.ok(child.killed.includes("SIGTERM"), "single active run aborted");
    child.emitClose(null);
    const result = await stopPromise;
    assert.notEqual(result.isError, true);
    const details = result.details as { stopped?: boolean; settled?: boolean; runId?: string };
    assert.equal(details.stopped, true);
    assert.equal(details.settled, true);
    assert.equal(details.runId, runId);
    const abortedEntry = pi.appendedEntries.find(
      (entry) => entry.type === "agent-team-run-v1" && (entry.data as { runId?: string }).runId === runId,
    );
    assert.equal((abortedEntry?.data as { status?: string }).status, "aborted");
  } finally {
    cleanup();
  }
});

test("team_stop without runId errors with RUN_ID_REQUIRED while two runs run in parallel", async () => {
  const { pi, spawn, run, stop, cleanup } = await setup();
  try {
    const first = await run({ team: "proj-team", task: "one" });
    const second = await run({ team: "proj-team", task: "two" });
    const firstId = (first.details as { runId?: string }).runId ?? "";
    const secondId = (second.details as { runId?: string }).runId ?? "";
    // 两个 start 在 spawn 前的真实异步工作让 spawn 完成序可与调用序翻转；
    // 按索引取 child 会在翻转时把被停的 run 判到另一个 child 上（本用例
    // 负载下实测过一次该假红）。
    const childA = await waitForChildByRunId(spawn, firstId);
    const childB = await waitForChildByRunId(spawn, secondId);

    const result = await stop({});
    assert.equal(result.isError, true);
    assert.equal((result.details as { code?: string }).code, "RUN_ID_REQUIRED");
    assert.match(result.content[0].text, new RegExp(firstId));
    assert.match(result.content[0].text, new RegExp(secondId));
    assert.equal(childA.killed.length, 0, "ambiguous stop signals nobody");
    assert.equal(childB.killed.length, 0);

    // An explicit runId still stops only that run.
    const targeted = stop({ runId: secondId });
    // 不能 await targeted（stopAndSettle 会等 settle 死锁）；SIGTERM 是否
    // 与 stop() 调用同步可见不作契约，改有界轮询后显式断言。
    await waitFor(() => childB.killed.includes("SIGTERM"));
    assert.ok(childB.killed.includes("SIGTERM"), "targeted stop signals its leader");
    assert.equal(childA.killed.length, 0, "the other run is untouched");
    childB.emitClose(null);
    const targetedResult = await targeted;
    assert.equal((targetedResult.details as { runId?: string }).runId, secondId);

    childA.emitClose(0);
    await waitFor(() => pi.sentMessages.length > 0);
  } finally {
    cleanup();
  }
});

test("re-dispatch right after a settled stop spawns a new leader (no RUN_IN_PROGRESS residue)", async () => {
  const { pi, spawn, run, stop, cleanup } = await setup();
  try {
    const first = await run({ team: "proj-team", task: "one" });
    const runId = (first.details as { runId?: string }).runId;
    const child = await waitForChild(spawn, 0);
    const stopPromise = stop({ runId });
    child.emitClose(null);
    const stopped = await stopPromise;
    assert.equal((stopped.details as { settled?: boolean }).settled, true);

    const second = await run({ team: "proj-team", task: "two" });
    assert.notEqual(second.isError, true);
    const child2 = await waitForChild(spawn, 1);
    assert.equal(spawn.records.length, 2, "second leader spawned after the stop settled");
    child2.autoRespond(leaderLines(), 0, 5);
    await waitFor(() => pi.sentMessages.length > 0);
  } finally {
    cleanup();
  }
});