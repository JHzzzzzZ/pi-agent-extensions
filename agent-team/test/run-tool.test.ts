/**
 * team_run tool tests: background-by-default dispatch (immediate return,
 * report delivered as a followUp on completion), wait:true synchronous
 * mode, and RUN_IN_PROGRESS while a run is active. Drives the real entry
 * through a fake ExtensionAPI with a scripted leader child (fake spawn).
 */

import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { serializeTeam } from "../config.ts";
import agentTeamExtension, { resetDoubleLoadGuardForTests } from "../index.ts";
import type { TeamConfig } from "../types.ts";
import { fixtureTeam } from "./fixtures.ts";
import {
  makeFakeSpawn,
  messageEndLine,
  sleep,
  toolExecutionEndLine,
  toolExecutionStartLine,
  waitForChild,
  type FakeSpawnHandle,
  isolateRunsDir,
} from "./helpers.ts";

// -- fake ExtensionAPI / ctx (same shape as entry.test.ts, kept local) -----

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

type RunTool = (params: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>;
  details?: unknown;
  isError?: boolean;
}>;

async function setup(teamOverrides: Partial<TeamConfig> = {}): Promise<{
  pi: ReturnType<typeof fakePi>;
  spawn: FakeSpawnHandle;
  run: RunTool;
  ctx: ReturnType<typeof fakeCtx>;
  cleanup: () => void;
}> {
  isolateRunsDir();
  resetDoubleLoadGuardForTests();
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-team-runtool-"));
  fs.mkdirSync(path.join(projectDir, ".pi", "teams"), { recursive: true });
  const team = fixtureTeam({ name: "proj-team", description: "项目团队", filePath: "", notes: undefined, ...teamOverrides });
  fs.writeFileSync(path.join(projectDir, ".pi", "teams", "proj-team.md"), serializeTeam(team));
  const spawn = makeFakeSpawn();
  const pi = fakePi();
  agentTeamExtension(pi as never, { spawn: spawn.spawn });
  const ctx = fakeCtx(projectDir, true);
  await pi.fire("session_start", { reason: "startup" }, ctx);
  const tool = pi.tools.get("team_run") as unknown as {
    execute: (id: string, params: Record<string, unknown>, signal?: undefined, onUpdate?: undefined, ctx?: unknown) => ReturnType<RunTool>;
  };
  return {
    pi,
    spawn,
    ctx,
    run: (params) => tool.execute("call-1", params, undefined, undefined, ctx),
    cleanup: () => fs.rmSync(projectDir, { recursive: true, force: true }),
  };
}

function dispatchDetails(members: Array<Record<string, unknown>>): string {
  return toolExecutionEndLine("team_dispatch", {
    content: [{ type: "text", text: "report" }],
    details: { members, totalUsage: { input: 1, output: 1, cost: 0.02, turns: 2 } },
  });
}

async function readTranscriptActors(
  pi: ReturnType<typeof fakePi>,
  ctx: ReturnType<typeof fakeCtx>,
): Promise<Array<{ actor: string; model?: string }>> {
  const tool = pi.tools.get("team_transcript") as unknown as {
    execute: (
      id: string,
      params: Record<string, unknown>,
      signal?: undefined,
      onUpdate?: undefined,
      ctx?: unknown,
    ) => Promise<{ content: Array<{ text: string }>; details?: unknown }>;
  };
  const result = await tool.execute("call-1", {}, undefined, undefined, ctx);
  return (result.details as { actors: Array<{ actor: string; model?: string }> }).actors;
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

test("team_run defaults to background: returns while the child runs, report arrives as followUp", async () => {
  const { pi, spawn, run, cleanup } = await setup();
  try {
    const result = await run({ team: "proj-team", task: "修复登录 bug" });
    assert.match(result.content[0].text, /已在后台启动/);
    assert.match(result.content[0].text, /2 成员并行/);
    assert.notEqual(result.isError, true);
    assert.equal((result.details as { background?: boolean }).background, true);

    const child = await waitForChild(spawn, 0);
    assert.equal(spawn.records.length, 1, "exactly one leader spawned");

    assert.equal(pi.sentMessages.length, 0, "nothing delivered before completion");
    child.autoRespond(leaderLines(), 0, 5);
    await waitFor(() => pi.sentMessages.length > 0);

    assert.equal(pi.sentMessages.length, 1, "report delivered once");
    const delivery = pi.sentMessages[0];
    assert.equal((delivery.message as { customType: string }).customType, "agent-team-result");
    assert.deepEqual(delivery.options, { deliverAs: "followUp", triggerTurn: true });
    assert.ok(
      pi.appendedEntries.some((entry) => entry.type === "agent-team-run-v1"),
      "run record persisted",
    );
  } finally {
    cleanup();
  }
});

test("team_run wait:true keeps the synchronous contract: inline report, no followUp", async () => {
  const { pi, spawn, run, cleanup } = await setup();
  try {
    const promise = run({ team: "proj-team", task: "修复登录 bug", wait: true });
    const child = await waitForChild(spawn, 0);
    child.autoRespond(leaderLines(), 0, 5);
    const result = await promise;

    assert.match(result.content[0].text, /FINAL REPORT/);
    assert.equal(pi.sentMessages.length, 0, "sync mode returns inline, no followUp delivery");
    assert.ok(
      pi.appendedEntries.some((entry) => entry.type === "agent-team-run-v1"),
      "run record persisted",
    );
  } finally {
    cleanup();
  }
});

// Viewer / team_transcript 的模型口径统一为 `provider/id`（v1.15.4）：声明含 provider
// 前缀时用「声明 provider + 子进程实际上报 id」组合（leader 与成员同规则），实际值自带
// 前缀/无声明/无实际各有明确规则（见 model-caliber.ts）。
test("team_transcript details unify each actor's model to the provider/id caliber", async () => {
  const { pi, spawn, run, ctx, cleanup } = await setup({
    // 四种口径输入：声明+实际不同 id 段、无实际、无声明、实际自带前缀。
    members: [
      { name: "frontend", model: "chatanywhere/gpt-5.6", prompt: "p" },
      { name: "backend", model: "anthropic/claude-sonnet-4-5", prompt: "p" },
      { name: "db", prompt: "p" },
      { name: "ops", model: "chatanywhere/gpt-5.6", prompt: "p" },
    ],
  });
  try {
    const usageOf = (model?: string): Record<string, unknown> => ({
      input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0.01, turns: 1,
      ...(model ? { model } : {}),
    });
    const promise = run({ team: "proj-team", task: "修复登录 bug", wait: true });
    const child = await waitForChild(spawn, 0);
    child.autoRespond([
      messageEndLine("assistant", {
        content: [{ type: "text", text: "开始拆解" }],
        usage: { input: 10, output: 5, cost: { total: 0.001 }, totalTokens: 15 },
        model: "claude-opus-4-5",
      }),
      toolExecutionStartLine("team_dispatch", {
        tasks: ["frontend", "backend", "db", "ops"].map((agent) => ({ agent, task: "t" })),
      }),
      dispatchDetails([
        { name: "frontend", ok: true, status: "done", summary: "f", usage: usageOf("gpt-5.7") },
        { name: "backend", ok: true, status: "done", summary: "b", usage: usageOf() },
        { name: "db", ok: true, status: "done", summary: "d", usage: usageOf("deepseek-flash") },
        { name: "ops", ok: true, status: "done", summary: "o", usage: usageOf("anthropic/claude-sonnet-4-5") },
      ]),
      messageEndLine("assistant", {
        content: [{ type: "text", text: "FINAL REPORT" }],
        usage: { input: 50, output: 20, cost: { total: 0.05 }, totalTokens: 300 },
        model: "claude-opus-4-5",
      }),
    ], 0, 5);
    await promise;

    const actors = await readTranscriptActors(pi, ctx);
    assert.equal(
      actors.find((a) => a.actor === "_leader")?.model,
      "anthropic/claude-opus-4-5",
      "leader: declared provider prefix + actually reported id segment",
    );
    assert.equal(
      actors.find((a) => a.actor === "frontend")?.model,
      "chatanywhere/gpt-5.7",
      "member: declared provider prefix + actual id segment (runtime model differs from the declaration)",
    );
    assert.equal(
      actors.find((a) => a.actor === "backend")?.model,
      "anthropic/claude-sonnet-4-5",
      "member: no actual report → declared value as-is",
    );
    assert.equal(
      actors.find((a) => a.actor === "db")?.model,
      "deepseek-flash",
      "member: no declaration → bare actual id kept (no invented prefix)",
    );
    assert.equal(
      actors.find((a) => a.actor === "ops")?.model,
      "anthropic/claude-sonnet-4-5",
      "member: actual already carries a provider prefix → used as-is",
    );
  } finally {
    cleanup();
  }
});

// live 态同样走归一：leader 的声明前缀在 coordinator 启动时进 progress，
// 子进程实际上报的裸 id 到达后组合；成员 live 只有声明值（原样）。
test("team_transcript live view composes the leader's declared provider with the reported id", async () => {
  const { pi, spawn, run, ctx, cleanup } = await setup();
  try {
    const started = await run({ team: "proj-team", task: "修复登录 bug" });
    assert.match(started.content[0].text, /已在后台启动/);
    const child = await waitForChild(spawn, 0);
    child.emitLine(
      messageEndLine("assistant", {
        content: [{ type: "text", text: "开始拆解" }],
        usage: { input: 10, output: 5, cost: { total: 0.001 }, totalTokens: 15 },
        model: "claude-opus-4-5",
      }),
    );

    let actors: Array<{ actor: string; model?: string }> = [];
    for (let i = 0; i < 100 && !actors.find((a) => a.actor === "_leader")?.model; i++) {
      actors = await readTranscriptActors(pi, ctx);
      if (!actors.find((a) => a.actor === "_leader")?.model) await sleep(5);
    }
    assert.equal(
      actors.find((a) => a.actor === "_leader")?.model,
      "anthropic/claude-opus-4-5",
      "live leader: declared provider prefix + the bare id reported mid-run",
    );
    assert.equal(
      actors.find((a) => a.actor === "frontend")?.model,
      "chatanywhere/gpt-5.6",
      "live member: declared caliber shown as-is until it reports",
    );

    child.autoRespond(leaderLines().slice(1), 0, 5);
    await waitFor(() => pi.sentMessages.length > 0);
  } finally {
    cleanup();
  }
});

test("team_run background result exposes the runId (team_stop's handle)", async () => {
  const { pi, spawn, run, cleanup } = await setup();
  try {
    const result = await run({ team: "proj-team", task: "修复登录 bug" });
    const runId = (result.details as { runId?: string }).runId;
    assert.ok(runId, "details.runId present");
    assert.match(runId, /^run-\d+$/);
    assert.match(result.content[0].text, /runId/);
    const child = await waitForChild(spawn, 0);
    assert.equal(runId, spawn.records[0].env?.PI_AGENT_TEAM_RUN_ID, "runId matches the leader's env");
    child.autoRespond(leaderLines(), 0, 5);
    await waitFor(() => pi.sentMessages.length > 0);
  } finally {
    cleanup();
  }
});

test("team_run while a run is active returns RUN_IN_PROGRESS without spawning again", async () => {
  const { pi, spawn, run, cleanup } = await setup();
  try {
    const first = await run({ team: "proj-team", task: "one" });
    assert.match(first.content[0].text, /已在后台启动/);
    const child = await waitForChild(spawn, 0);

    const second = await run({ team: "proj-team", task: "two" });
    assert.match(second.content[0].text, /另一个 team run 正在进行中/);
    assert.equal((second.details as { code?: string }).code, "RUN_IN_PROGRESS");
    assert.equal(spawn.records.length, 1, "no second leader spawned");

    child.autoRespond(leaderLines(), 0, 5);
    await waitFor(() => pi.sentMessages.length > 0);
  } finally {
    cleanup();
  }
});
