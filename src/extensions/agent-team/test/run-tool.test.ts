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
import { fileURLToPath } from "node:url";
import { serializeTeam } from "../config.ts";
import agentTeamExtension, { resetDoubleLoadGuardForTests } from "../index.ts";
import type { ExternalBackend, ExternalCliResolveResult, TeamConfig } from "../types.ts";
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

async function setup(
  teamOverrides: Partial<TeamConfig> = {},
  extensionOpts: { resolveExternalCli?: (backend: ExternalBackend) => ExternalCliResolveResult } = {},
): Promise<{
  pi: ReturnType<typeof fakePi>;
  spawn: FakeSpawnHandle;
  run: RunTool;
  ctx: ReturnType<typeof fakeCtx>;
  runsDir: string;
  cleanup: () => void;
}> {
  const runsDir = isolateRunsDir();
  resetDoubleLoadGuardForTests();
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-team-runtool-"));
  fs.mkdirSync(path.join(projectDir, ".pi", "teams"), { recursive: true });
  const team = fixtureTeam({ name: "proj-team", description: "项目团队", filePath: "", notes: undefined, ...teamOverrides });
  fs.writeFileSync(path.join(projectDir, ".pi", "teams", "proj-team.md"), serializeTeam(team));
  const spawn = makeFakeSpawn();
  const pi = fakePi();
  agentTeamExtension(pi as never, { spawn: spawn.spawn, ...extensionOpts });
  const ctx = fakeCtx(projectDir, true);
  await pi.fire("session_start", { reason: "startup" }, ctx);
  const tool = pi.tools.get("team_run") as unknown as {
    execute: (id: string, params: Record<string, unknown>, signal?: undefined, onUpdate?: undefined, ctx?: unknown) => ReturnType<RunTool>;
  };
  return {
    pi,
    spawn,
    ctx,
    runsDir,
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

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

/** 外部 CLI fixture JSONL 行（跳过注释/空行）——fake child 逐行回放用。 */
function fixtureLines(name: string): string[] {
  return fs
    .readFileSync(path.join(FIXTURES, name), "utf-8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
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

// 需求 B：team_transcript 的 details.actors 与 viewer 同口径带思考级别
// （leader 实际 provider 级别优先、成员回退声明后缀）。
test("team_transcript details expose each actor's thinking level (leader actual + member declared suffix)", async () => {
  const { pi, spawn, run, ctx, cleanup } = await setup();
  try {
    const team = fixtureTeam({
      name: "proj-team",
      description: "项目团队",
      filePath: "",
      notes: undefined,
      leader: { model: "anthropic/claude-opus-4-5:high", prompt: "你是技术负责人。" },
      members: [
        { name: "frontend", model: "chatanywhere/gpt-5.6:medium", prompt: "你是前端工程师。" },
        { name: "backend", model: "anthropic/claude-sonnet-4-5:xhigh", prompt: "你是后端工程师。" },
      ],
    });
    fs.writeFileSync(path.join(ctx.cwd, ".pi", "teams", "proj-team.md"), serializeTeam(team));

    const promise = run({ team: "proj-team", task: "修复登录 bug", wait: true });
    const child = await waitForChild(spawn, 0);
    child.autoRespond(
      [
        toolExecutionStartLine("team_dispatch", { tasks: [{ agent: "frontend", task: "a" }] }),
        dispatchDetails([
          { name: "frontend", ok: true, status: "done", summary: "前端做完", usage: { input: 10, output: 5, cost: 0.01, turns: 1 } },
        ]),
        messageEndLine("assistant", {
          content: [{ type: "text", text: "FINAL REPORT" }],
          usage: { input: 50, output: 20, cost: { total: 0.05 }, totalTokens: 300 },
          model: "claude-opus-4-5",
          providerThinkingLevel: "low",
        }),
      ],
      0,
      5,
    );
    await promise;

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
    const actors = (result.details as { actors: Array<{ actor: string; thinkingLevel?: string }> }).actors;
    assert.equal(
      actors.find((a) => a.actor === "_leader")?.thinkingLevel,
      "low",
      "leader thinking level comes from the child's providerThinkingLevel",
    );
    assert.equal(
      actors.find((a) => a.actor === "frontend")?.thinkingLevel,
      "medium",
      "member thinking level falls back to the declared model suffix (no provider report)",
    );
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

test("team_run keeps dispatching up to the concurrency cap; the next one returns RUN_IN_PROGRESS", async () => {
  const { pi, spawn, run, cleanup } = await setup();
  try {
    const first = await run({ team: "proj-team", task: "one" });
    assert.match(first.content[0].text, /已在后台启动/);
    await waitForChild(spawn, 0);
    const second = await run({ team: "proj-team", task: "two" });
    assert.match(second.content[0].text, /已在后台启动/, "第二个 run 不再被拒（真正并发）");
    await waitForChild(spawn, 1);
    const third = await run({ team: "proj-team", task: "three" });
    assert.match(third.content[0].text, /已在后台启动/);
    await waitForChild(spawn, 2);
    const activeIds = [0, 1, 2].map((i) => spawn.records[i].env?.PI_AGENT_TEAM_RUN_ID ?? "");

    const fourth = await run({ team: "proj-team", task: "four" });
    assert.match(fourth.content[0].text, /并发 team run 已达上限（3）/);
    for (const id of activeIds) assert.ok(fourth.content[0].text.includes(id), `message lists ${id}`);
    assert.equal((fourth.details as { code?: string }).code, "RUN_IN_PROGRESS");
    assert.equal(spawn.records.length, 3, "no fourth leader spawned");
    assert.equal(fourth.isError, false, "RUN_IN_PROGRESS 不是工具错误（主 agent 可继续）");

    for (const child of spawn.children) child.autoRespond(leaderLines(), 0, 5);
    await waitFor(() => pi.sentMessages.length >= 3);
  } finally {
    cleanup();
  }
});

test("team_status{runId} pins one of two parallel runs; unknown runId answers not-found", async () => {
  const { pi, spawn, run, ctx, cleanup } = await setup();
  try {
    await run({ team: "proj-team", task: "one" });
    await waitForChild(spawn, 0);
    await run({ team: "proj-team", task: "two" });
    await waitForChild(spawn, 1);
    const runId = spawn.records[0].env?.PI_AGENT_TEAM_RUN_ID ?? "";
    const otherId = spawn.records[1].env?.PI_AGENT_TEAM_RUN_ID ?? "";
    const tool = pi.tools.get("team_status") as unknown as {
      execute: (id: string, params: Record<string, unknown>, signal?: undefined, onUpdate?: undefined, ctx?: unknown) => Promise<{ content: Array<{ text: string }> }>;
    };

    const targeted = await tool.execute("c", { runId }, undefined, undefined, ctx);
    assert.match(targeted.content[0].text, new RegExp(`runId: ${runId}`));
    assert.match(targeted.content[0].text, /当前 run：/);
    assert.doesNotMatch(targeted.content[0].text, /── run /);
    assert.doesNotMatch(targeted.content[0].text, new RegExp(`── run ${otherId}`));

    const aggregate = await tool.execute("c", {}, undefined, undefined, ctx);
    assert.match(aggregate.content[0].text, /当前共 2 个 run 并行（上限 3）：/);

    const unknown = await tool.execute("c", { runId: "run-nope" }, undefined, undefined, ctx);
    assert.match(unknown.content[0].text, /没有找到 runId run-nope/);

    for (const child of spawn.children) child.autoRespond(leaderLines(), 0, 5);
    await waitFor(() => pi.sentMessages.length >= 2);
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// team_resume: resume a failed/aborted run (parent session + worktree reuse,
// model overrides) with typed errors for every ineligible case.
// ---------------------------------------------------------------------------

interface AnyTool {
  execute: (
    id: string,
    params: Record<string, unknown>,
    signal?: undefined,
    onUpdate?: undefined,
    ctx?: unknown,
  ) => Promise<{ content: Array<{ text: string }>; details?: unknown; isError?: boolean }>;
}

function resumeTool(pi: ReturnType<typeof fakePi>): AnyTool {
  const tool = pi.tools.get("team_resume") as unknown as AnyTool | undefined;
  assert.ok(tool, "team_resume must be registered in cockpit mode");
  return tool;
}

function writeParentSessionMirror(runsDir: string, runId: string): string {
  const sessionDir = path.join(runsDir, runId, "session");
  fs.mkdirSync(sessionDir, { recursive: true });
  const file = path.join(sessionDir, "20260911_000000_aaa.jsonl");
  fs.writeFileSync(
    file,
    `${JSON.stringify({ type: "session", version: 3, id: "aaa", timestamp: "2026-09-11T05:00:00Z", cwd: "/tmp" })}\n`,
  );
  return file;
}

/** Runs a wait:true team_run that fails on the leader child (quota-style). */
async function seedFailedRun(
  run: RunTool,
  spawn: FakeSpawnHandle,
): Promise<{ runId: string; text: string }> {
  const index = spawn.children.length;
  const promise = run({ team: "proj-team", task: "原始任务", wait: true });
  const child = await waitForChild(spawn, index);
  child.autoRespond(
    [messageEndLine("assistant", { content: [{ type: "text", text: "partial" }], errorMessage: "quota exhausted", stopReason: "error" })],
    1,
    5,
  );
  const result = await promise;
  assert.equal(result.isError, true, "seed run must be a failed run");
  const runId = spawn.records[spawn.records.length - 1]?.env?.PI_AGENT_TEAM_RUN_ID ?? "";
  return { runId, text: result.content[0].text };
}

test("team_resume resumes a failed parent: same session, override models, lineage in the record", async () => {
  const { pi, spawn, run, ctx, runsDir, cleanup } = await setup();
  try {
    const parent = await seedFailedRun(run, spawn);
    const mirror = writeParentSessionMirror(runsDir, parent.runId);

    const started = await resumeTool(pi).execute(
      "call-resume",
      { runId: parent.runId, instructions: "换用有额度的模型继续", leaderModel: "opencode-go/deepseek-v4:max" },
      undefined,
      undefined,
      ctx,
    );
    assert.notEqual(started.isError, true);
    assert.match(started.content[0].text, /已续跑/);
    assert.match(started.content[0].text, new RegExp(parent.runId));
    assert.equal((started.details as { background?: boolean }).background, true);
    assert.equal((started.details as { parentRunId?: string }).parentRunId, parent.runId);

    const child = await waitForChild(spawn, 1);
    const resumeArgs = spawn.records[1].args;
    assert.equal(resumeArgs[resumeArgs.indexOf("--session")], "--session");
    assert.equal(resumeArgs[resumeArgs.indexOf("--session") + 1], path.resolve(mirror));
    assert.ok(!resumeArgs.includes("--no-session"), "resume never disables session persistence");
    assert.ok(!resumeArgs.includes("--session-dir"), "resume opens the parent file directly");
    assert.equal(resumeArgs[resumeArgs.indexOf("--model") + 1], "opencode-go/deepseek-v4:max");
    assert.equal(spawn.records[1].env?.PI_AGENT_TEAM_WORKTREE_RUN_ID, parent.runId);
    assert.deepEqual(JSON.parse(child.writes[0] ?? "{}"), {
      type: "prompt",
      id: "task",
      message: "Task: 继续上次未完成的任务。补充指示：\n换用有额度的模型继续\n完成后按团队约定的最终报告格式输出报告。",
    });

    child.autoRespond(leaderLines(), 0, 5);
    await waitFor(() => pi.sentMessages.length > 0);
    const records = pi.appendedEntries.filter((entry) => entry.type === "agent-team-run-v1");
    assert.equal(records.length, 2, "parent + resume records persisted");
    const resumed = records[records.length - 1].data as { runId: string; parentRunId?: string; leaderSessionFile?: string };
    assert.notEqual(resumed.runId, parent.runId);
    assert.equal(resumed.parentRunId, parent.runId);
    assert.equal(resumed.leaderSessionFile, path.resolve(mirror));
  } finally {
    cleanup();
  }
});

test("team_resume defaults to background and reports the resumed runId", async () => {
  const { pi, spawn, run, ctx, runsDir, cleanup } = await setup();
  try {
    const parent = await seedFailedRun(run, spawn);
    writeParentSessionMirror(runsDir, parent.runId);
    const started = await resumeTool(pi).execute("call-resume", { runId: parent.runId }, undefined, undefined, ctx);
    assert.match(started.content[0].text, /已续跑/);
    assert.match(started.content[0].text, new RegExp(parent.runId));
    const details = started.details as { runId?: string; parentRunId?: string };
    assert.ok(details.runId && details.runId !== parent.runId);
    assert.equal(details.parentRunId, parent.runId);
    const child = await waitForChild(spawn, 1);
    child.autoRespond(leaderLines(), 0, 5);
    await waitFor(() => pi.sentMessages.length > 0);
  } finally {
    cleanup();
  }
});

test("team_resume typed errors: missing/unknown/idle states never spawn", async () => {
  const { pi, spawn, run, ctx, runsDir, cleanup } = await setup();
  try {
    const tool = resumeTool(pi);
    const missing = await tool.execute("c", {}, undefined, undefined, ctx);
    assert.equal(missing.isError, true);
    assert.equal((missing.details as { code?: string }).code, "RUN_ID_REQUIRED");

    const unknown = await tool.execute("c", { runId: "run-nope" }, undefined, undefined, ctx);
    assert.equal((unknown.details as { code?: string }).code, "RUN_NOT_FOUND");

    // completed runs are not resumable.
    const completedPromise = run({ team: "proj-team", task: "done", wait: true });
    const completedChild = await waitForChild(spawn, 0);
    completedChild.autoRespond(leaderLines(), 0, 5);
    await completedPromise;
    const completedRunId = spawn.records[0].env?.PI_AGENT_TEAM_RUN_ID ?? "";
    const completed = await tool.execute("c", { runId: completedRunId }, undefined, undefined, ctx);
    assert.equal((completed.details as { code?: string }).code, "RUN_ALREADY_FINISHED");
    assert.match(completed.content[0].text, /team_run/);

    // failed parent without a session mirror.
    const parent = await seedFailedRun(run, spawn);
    const unavailable = await tool.execute("c", { runId: parent.runId }, undefined, undefined, ctx);
    assert.equal((unavailable.details as { code?: string }).code, "RESUME_UNAVAILABLE");
    assert.equal(spawn.records.length, 2, "no leader spawned for ineligible resumes");

    // A deleted team definition is a typed failure too.
    writeParentSessionMirror(runsDir, parent.runId);
    fs.rmSync(path.join(ctx.cwd, ".pi", "teams", "proj-team.md"));
    const gone = await tool.execute("c", { runId: parent.runId }, undefined, undefined, ctx);
    assert.equal((gone.details as { code?: string }).code, "TEAM_NOT_FOUND");
  } finally {
    cleanup();
  }
});

test("team_resume rejects running parents (RUN_NOT_TERMINAL) and caps parallel runs (RUN_IN_PROGRESS)", async () => {
  const { pi, spawn, run, ctx, runsDir, cleanup } = await setup();
  try {
    const parent = await seedFailedRun(run, spawn);
    writeParentSessionMirror(runsDir, parent.runId);

    // Fill the concurrency cap with live runs: resuming a failed run is blocked
    // with RUN_IN_PROGRESS until one of them settles.
    for (let i = 1; i <= 3; i++) {
      const active = await run({ team: "proj-team", task: `active-${i}` });
      assert.match(active.content[0].text, /已在后台启动/);
      await waitForChild(spawn, i);
    }
    const blocked = await resumeTool(pi).execute("c", { runId: parent.runId }, undefined, undefined, ctx);
    assert.equal((blocked.details as { code?: string }).code, "RUN_IN_PROGRESS");

    // Resuming the running run itself is RUN_NOT_TERMINAL.
    const activeRunId = spawn.records[1].env?.PI_AGENT_TEAM_RUN_ID ?? "";
    const notTerminal = await resumeTool(pi).execute("c", { runId: activeRunId }, undefined, undefined, ctx);
    assert.equal((notTerminal.details as { code?: string }).code, "RUN_NOT_TERMINAL");

    for (const child of [spawn.children[1], spawn.children[2], spawn.children[3]]) child.autoRespond(leaderLines(), 0, 5);
    await waitFor(() => pi.sentMessages.length >= 3);
    assert.equal(spawn.records.length, 4, "no resume leader spawned");
  } finally {
    cleanup();
  }
});

test("team_resume preflights the effective (override) models: bad override → MODEL_NOT_FOUND", async () => {
  const { pi, spawn, run, ctx, runsDir, cleanup } = await setup();
  try {
    const parent = await seedFailedRun(run, spawn);
    writeParentSessionMirror(runsDir, parent.runId);
    const registryCtx = {
      ...ctx,
      modelRegistry: {
        find: (_provider: string, _modelId: string) => undefined as unknown,
        hasConfiguredAuth: () => true,
      },
    };
    const result = await resumeTool(pi).execute(
      "c",
      { runId: parent.runId, leaderModel: "nope/nope" },
      undefined,
      undefined,
      registryCtx,
    );
    assert.equal(result.isError, true);
    assert.equal((result.details as { code?: string }).code, "MODEL_NOT_FOUND");
    assert.equal(spawn.records.length, 1, "preflight failure never spawns the resume leader");
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// v1.22.0 外部 CLI 后端：run 预检门（index.ts 接线，10-design §5/§6）
// ---------------------------------------------------------------------------

test("team_run 预检拒绝外部 leader（EXTERNAL_LEADER_UNSUPPORTED），零 spawn", async () => {
  const { spawn, run, cleanup } = await setup({
    leader: { model: "anthropic/claude-opus-4-5", prompt: "你是技术负责人。", backend: "codex" },
  });
  try {
    const result = await run({ team: "proj-team", task: "修复登录 bug" });
    assert.equal(result.isError, true);
    assert.equal((result.details as { code?: string }).code, "EXTERNAL_LEADER_UNSUPPORTED");
    assert.match(result.content[0].text, /v1 限制/);
    assert.equal(spawn.records.length, 0, "no leader spawned on external-leader preflight failure");
  } finally {
    cleanup();
  }
});

test("team_run 预检：外部成员 CLI 不可解析 → CLI_NOT_FOUND 且零 spawn", async () => {
  const seen: ExternalBackend[] = [];
  const { spawn, run, cleanup } = await setup(
    { members: [{ name: "coder", backend: "codex", model: "gpt-5.1-codex", prompt: "你是外部码农。" }] },
    {
      resolveExternalCli: (backend): ExternalCliResolveResult => {
        seen.push(backend);
        return { ok: false, code: "CLI_NOT_FOUND", message: "未找到可直接 spawn 的 codex CLI" };
      },
    },
  );
  try {
    const result = await run({ team: "proj-team", task: "写脚本" });
    assert.equal(result.isError, true);
    assert.equal((result.details as { code?: string }).code, "CLI_NOT_FOUND");
    assert.deepEqual(seen, ["codex"], "resolver called for the external member");
    assert.equal(spawn.records.length, 0, "no leader spawned when the run preflight fails");
  } finally {
    cleanup();
  }
});

test("team_run 预检（登记偏差）：无注册表 + pi 成员裸 id model → MODEL_NOT_FOUND", async () => {
  // 1.21.0 在无注册表时整门跳过（裸 id 放行）；v1.22.0 的 permissive fallback
  // 让外部成员 CLI 探测在无注册表时仍生效，代价是裸 id model 硬失败——此用例
  // 锁定该已知边缘偏差（理由见 index.ts runModelPreflight 注释）。
  const { spawn, run, cleanup } = await setup({
    members: [{ name: "frontend", description: "前端", model: "bareid", prompt: "你是前端工程师。" }],
  });
  try {
    const result = await run({ team: "proj-team", task: "修复登录 bug" });
    assert.equal(result.isError, true);
    assert.equal((result.details as { code?: string }).code, "MODEL_NOT_FOUND");
    assert.match(result.content[0].text, /bareid/);
    assert.equal(spawn.records.length, 0, "no leader spawned on model preflight failure");
  } finally {
    cleanup();
  }
});

test("leader 模式 team_dispatch：外部成员 usage 折回 details.totalUsage", async () => {
  isolateRunsDir();
  resetDoubleLoadGuardForTests();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-team-leader-extcli-"));
  const teamFile = path.join(dir, "ext-team.md");
  fs.writeFileSync(
    teamFile,
    serializeTeam(
      fixtureTeam({
        name: "ext-team",
        description: "外部 CLI 团队",
        filePath: "",
        notes: undefined,
        members: [{ name: "coder", backend: "codex", model: "gpt-5.1-codex", prompt: "你是外部码农。" }],
      }),
    ),
  );
  const spawn = makeFakeSpawn();
  const pi = fakePi();
  const previousFile = process.env.PI_AGENT_TEAM_FILE;
  const previousRunId = process.env.PI_AGENT_TEAM_RUN_ID;
  process.env.PI_AGENT_TEAM_FILE = teamFile;
  process.env.PI_AGENT_TEAM_RUN_ID = "run-leader-extcli";
  try {
    agentTeamExtension(pi as never, {
      spawn: spawn.spawn,
      resolveExternalCli: () => ({ ok: true, value: { command: "C:\\tools\\codex.exe" } }),
    });
    const tool = pi.tools.get("team_dispatch") as unknown as {
      execute: (
        id: string,
        params: Record<string, unknown>,
        signal?: undefined,
        onUpdate?: undefined,
        ctx?: unknown,
      ) => Promise<{ content: Array<{ type: string; text: string }>; details?: unknown; isError?: boolean }>;
    };
    const promise = tool.execute("call-1", { tasks: [{ agent: "coder", task: "写脚本" }] }, undefined, undefined, undefined);
    const child = await waitForChild(spawn, 0);
    child.autoRespond(fixtureLines("external-codex-success.jsonl"), 0, 5);
    const result = await promise;

    assert.notEqual(result.isError, true);
    const details = result.details as {
      members: Array<{ name: string; status: string; usage: { input: number; turns: number } }>;
      totalUsage: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number; turns: number };
    };
    assert.equal(details.members[0].name, "coder");
    assert.equal(details.members[0].status, "done");
    assert.equal(details.members[0].usage.input, 17704);
    assert.equal(details.members[0].usage.turns, 1);
    assert.deepEqual(details.totalUsage, { input: 17704, output: 5, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 });
  } finally {
    if (previousFile === undefined) delete process.env.PI_AGENT_TEAM_FILE;
    else process.env.PI_AGENT_TEAM_FILE = previousFile;
    if (previousRunId === undefined) delete process.env.PI_AGENT_TEAM_RUN_ID;
    else process.env.PI_AGENT_TEAM_RUN_ID = previousRunId;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

