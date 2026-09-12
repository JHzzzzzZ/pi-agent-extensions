/**
 * Failed-run delivery tests: the main session (team_run caller) must learn
 * about a failed terminal state through the same followUp channel as a
 * completed run — status + error + member results + partial report — and
 * launch-level async failures (worktree pre-flight, leader spawn error)
 * must leave a minimal failed record behind. aborted keeps the team_stop
 * contract (silent); wait:true keeps the inline result; synchronous
 * rejections (RUN_IN_PROGRESS) add no delivery.
 *
 * Host wiring level: real entry + fake ExtensionAPI + scripted leader
 * child (fake spawn), same harness as run-tool.test.ts.
 */

import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { serializeTeam } from "../config.ts";
import agentTeamExtension, { resetDoubleLoadGuardForTests } from "../index.ts";
import type { TeamConfig, TeamRunRecord } from "../types.ts";
import { fixtureTeam } from "./fixtures.ts";
import {
  isolateRunsDir,
  makeFakeSpawn,
  messageEndLine,
  sleep,
  toolExecutionEndLine,
  toolExecutionStartLine,
  waitForChild,
  type FakeSpawnHandle,
} from "./helpers.ts";

// -- fake ExtensionAPI / ctx (run-tool.test.ts shape + notify capture) -----

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

function fakeCtx(cwd: string) {
  const notifications: Array<{ text: string; level?: string }> = [];
  const ctx = {
    cwd,
    hasUI: false,
    isProjectTrusted: () => true,
    ui: {
      notify: (text: string, level?: string) => {
        notifications.push({ text, level });
      },
    },
    sessionManager: { getEntries: () => [] },
  };
  return { ctx, notifications };
}

type Tool = (params: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>;
  details?: unknown;
  isError?: boolean;
}>;

async function setup(teamOverrides: Partial<TeamConfig> = {}): Promise<{
  pi: ReturnType<typeof fakePi>;
  spawn: FakeSpawnHandle;
  run: Tool;
  stop: Tool;
  notifications: Array<{ text: string; level?: string }>;
  cleanup: () => void;
}> {
  isolateRunsDir();
  resetDoubleLoadGuardForTests();
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-team-faildeliver-"));
  fs.mkdirSync(path.join(projectDir, ".pi", "teams"), { recursive: true });
  const team = fixtureTeam({ name: "proj-team", description: "项目团队", filePath: "", notes: undefined, ...teamOverrides });
  fs.writeFileSync(path.join(projectDir, ".pi", "teams", "proj-team.md"), serializeTeam(team));
  const spawn = makeFakeSpawn();
  const pi = fakePi();
  agentTeamExtension(pi as never, { spawn: spawn.spawn });
  const { ctx, notifications } = fakeCtx(projectDir);
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
    notifications,
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
    messageEndLine("assistant", {
      content: [{ type: "text", text: "FINAL REPORT" }],
      usage: { input: 50, output: 20, cost: { total: 0.05 }, totalTokens: 300 },
      model: "claude-opus-4-5",
    }),
  ];
}

function runEntries(pi: ReturnType<typeof fakePi>): TeamRunRecord[] {
  return pi.appendedEntries
    .filter((entry) => entry.type === "agent-team-run-v1")
    .map((entry) => entry.data as TeamRunRecord);
}

function noticeText(pi: ReturnType<typeof fakePi>): string {
  const delivery = pi.sentMessages[0];
  assert.ok(delivery, "a followUp delivery exists");
  const message = delivery.message as { customType: string; content: Array<{ type: string; text: string }> };
  assert.equal(message.customType, "agent-team-result");
  return message.content[0].text;
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 400 && !predicate(); i++) await sleep(5);
}

test("background failed run delivers a followUp notice: status + error + runId", async () => {
  const { pi, spawn, run, notifications, cleanup } = await setup();
  try {
    const started = await run({ team: "proj-team", task: "修复登录 bug" });
    assert.notEqual(started.isError, true, "background dispatch returns immediately");
    const runId = (started.details as { runId?: string }).runId ?? "";
    const child = await waitForChild(spawn, 0);
    child.autoRespond([messageEndLine("assistant", { content: [{ type: "text", text: "做到一半" }] })], 1, 5);
    await waitFor(() => pi.sentMessages.length > 0);

    assert.equal(pi.sentMessages.length, 1, "exactly one followUp delivery for the failure");
    assert.deepEqual(pi.sentMessages[0].options, { deliverAs: "followUp", triggerTurn: true });
    const text = noticeText(pi);
    assert.match(text, /失败/);
    assert.ok(text.includes(runId), "notice carries the runId");
    assert.match(text, /pi exited with code 1/);

    const entry = runEntries(pi)[0];
    assert.equal(entry.status, "failed", "failed record persisted");
    assert.ok(
      notifications.some((n) => n.level === "error" && n.text.includes("failed")),
      "transient notify kept on the user side",
    );
  } finally {
    cleanup();
  }
});

test("failure notice carries member results and the partial leader report", async () => {
  const { pi, spawn, run, cleanup } = await setup();
  try {
    await run({ team: "proj-team", task: "修复登录 bug" });
    const child = await waitForChild(spawn, 0);
    child.autoRespond(
      [
        toolExecutionStartLine("team_dispatch", { tasks: [{ agent: "frontend", task: "a" }, { agent: "backend", task: "b" }] }),
        dispatchDetails([
          { name: "frontend", ok: true, status: "done", summary: "前端做完", usage: { input: 10, output: 5, cost: 0.01, turns: 1 } },
          {
            name: "backend",
            ok: false,
            status: "failed",
            summary: "后端挂了",
            error: { code: "CHILD_FAILED", message: "boom" },
            usage: { input: 20, output: 8, cost: 0.02, turns: 2 },
          },
        ]),
        messageEndLine("assistant", { content: [{ type: "text", text: "FINAL PARTIAL REPORT" }] }),
      ],
      1,
      5,
    );
    await waitFor(() => pi.sentMessages.length > 0);

    const text = noticeText(pi);
    assert.match(text, /成员:/);
    assert.match(text, /frontend: done/);
    assert.match(text, /backend: failed/);
    assert.match(text, /后端挂了/);
    assert.match(text, /部分报告:/);
    assert.match(text, /FINAL PARTIAL REPORT/);
  } finally {
    cleanup();
  }
});

test("worktree pre-flight failure: minimal failed record + followUp, no leader spawned", async () => {
  const { pi, spawn, run, cleanup } = await setup({ worktree: true });
  try {
    const started = await run({ team: "proj-team", task: "修复登录 bug" });
    assert.notEqual(started.isError, true, "launch-level failure surfaces asynchronously");
    await waitFor(() => pi.sentMessages.length > 0);

    assert.equal(spawn.records.length, 0, "no leader spawned");
    assert.equal(pi.sentMessages.length, 1, "failure delivered once");
    const text = noticeText(pi);
    assert.match(text, /失败/);
    assert.match(text, /不是 git 仓库/);

    const entry = runEntries(pi)[0];
    assert.equal(entry.status, "failed");
    assert.deepEqual(entry.members, [], "minimal record has no member rows");
    assert.ok(entry.runId, "minimal record keeps the runId");
  } finally {
    cleanup();
  }
});

test("leader spawn error (CHILD_FAILED): minimal failed record + followUp", async () => {
  const { pi, spawn, run, cleanup } = await setup();
  try {
    spawn.spawnError = new Error("ENOENT");
    const started = await run({ team: "proj-team", task: "修复登录 bug" });
    assert.notEqual(started.isError, true, "launch-level failure surfaces asynchronously");
    await waitFor(() => pi.sentMessages.length > 0);

    assert.equal(pi.sentMessages.length, 1, "failure delivered once");
    const text = noticeText(pi);
    assert.match(text, /failed to start leader process/);
    assert.match(text, /ENOENT/);

    const entry = runEntries(pi)[0];
    assert.equal(entry.status, "failed");
    assert.deepEqual(entry.members, []);
  } finally {
    cleanup();
  }
});

test("aborted run stays silent: no followUp after a stop (team_stop contract lock)", async () => {
  const { pi, spawn, run, stop, cleanup } = await setup();
  try {
    const first = await run({ team: "proj-team", task: "修复登录 bug" });
    const runId = (first.details as { runId?: string }).runId;
    const child = await waitForChild(spawn, 0);
    const stopPromise = stop({ runId });
    child.emitClose(null);
    const stopped = await stopPromise;
    assert.equal((stopped.details as { status?: string }).status, "aborted");
    await sleep(20);
    assert.equal(pi.sentMessages.length, 0, "aborted never delivers");
  } finally {
    cleanup();
  }
});

test("wait:true failed run stays inline (isError) with no followUp", async () => {
  const { pi, spawn, run, cleanup } = await setup();
  try {
    const promise = run({ team: "proj-team", task: "修复登录 bug", wait: true });
    const child = await waitForChild(spawn, 0);
    child.autoRespond([messageEndLine("assistant", { content: [{ type: "text", text: "partial" }] })], 1, 5);
    const result = await promise;

    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /failed/);
    assert.equal(pi.sentMessages.length, 0, "inline mode never delivers a followUp");
    assert.equal(runEntries(pi)[0]?.status, "failed");
  } finally {
    cleanup();
  }
});

test("synchronous rejection (RUN_IN_PROGRESS at the concurrency cap) adds no delivery", async () => {
  const { pi, spawn, run, cleanup } = await setup();
  try {
    for (let i = 0; i < 3; i++) {
      const started = await run({ team: "proj-team", task: `task-${i}` });
      assert.match(started.content[0].text, /已在后台启动/);
      await waitForChild(spawn, i);
    }
    const rejected = await run({ team: "proj-team", task: "one-too-many" });
    assert.equal((rejected.details as { code?: string }).code, "RUN_IN_PROGRESS");
    assert.equal(pi.sentMessages.length, 0, "synchronous rejection delivers nothing");
    assert.equal(spawn.records.length, 3, "no extra leader spawned");

    for (const child of spawn.children) child.autoRespond(leaderLines(), 0, 5);
    await waitFor(() => pi.sentMessages.length >= 3);
    assert.equal(pi.sentMessages.length, 3, "only the completed reports arrive");
  } finally {
    cleanup();
  }
});
