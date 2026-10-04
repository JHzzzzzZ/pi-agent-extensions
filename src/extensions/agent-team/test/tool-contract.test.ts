/**
 * agent-team — pi 1.0 工具面契约（agent-team-todo #73 / general-todo #20、#21）
 *
 * 三组契约：exposure 分级（编排型与阻塞型 model-only，查询型 direct）、
 * annotations（只读 / 破坏性 / 开放世界）、namespace 归属；以及查询型四个工具的
 * outputSchema + structuredContent 稳定契约（不镜像内部 details）。
 *
 * 边界：注册面走真实 entry（fake ExtensionAPI，同 stop-tool.test.ts），有 run 的
 * 分支用 fake leader 子进程脚本化真实事件流；codemode 脚本侧的解析走宿主真实
 * executor，见 tool-contract-codemode.test.ts。
 */

import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { serializeTeam } from "../config.ts";
import agentTeamExtension, { resetDoubleLoadGuardForTests } from "../index.ts";
import { registerManageTools } from "../manage.ts";
import { LEADER_ACTOR } from "../transcript.ts";
import { LEADER_ENV_FILE } from "../types.ts";
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
import type { ToolResult } from "./tool-types.ts";

// -- fake ExtensionAPI / ctx (same shape as stop-tool.test.ts, kept local) --

interface RegisteredTool {
  name: string;
  exposure?: string;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean };
  namespace?: { name: string; description?: string };
  outputSchema?: unknown;
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal: undefined,
    onUpdate: undefined,
    ctx: unknown,
  ) => Promise<ToolResult & { structuredContent?: unknown }>;
}

function fakePi() {
  const tools = new Map<string, RegisteredTool>();
  const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => Promise<void>>>();
  const sentMessages: Array<{ message: unknown; options?: unknown }> = [];
  return {
    tools,
    sentMessages,
    on(name: string, fn: (event: unknown, ctx: unknown) => Promise<void>) {
      const list = handlers.get(name) ?? [];
      list.push(fn);
      handlers.set(name, list);
    },
    registerTool(tool: RegisteredTool) {
      tools.set(tool.name, tool);
    },
    registerCommand(_name: string, _command: unknown) {},
    registerEntryRenderer(_type: string, _renderer: unknown) {},
    appendEntry(_customType: string, _data: unknown) {
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

interface CockpitHarness {
  pi: ReturnType<typeof fakePi>;
  spawn: FakeSpawnHandle;
  ctx: ReturnType<typeof fakeCtx>;
  call: (name: string, params?: Record<string, unknown>) => Promise<ToolResult & { structuredContent?: unknown }>;
  cleanup: () => void;
}

async function registerCockpit(): Promise<CockpitHarness> {
  isolateRunsDir();
  resetDoubleLoadGuardForTests();
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-team-contract-"));
  fs.mkdirSync(path.join(projectDir, ".pi", "teams"), { recursive: true });
  const team = fixtureTeam({ name: "proj-team", description: "项目团队", filePath: "", notes: undefined });
  fs.writeFileSync(path.join(projectDir, ".pi", "teams", "proj-team.md"), serializeTeam(team));
  const spawn = makeFakeSpawn();
  const pi = fakePi();
  agentTeamExtension(pi as never, { spawn: spawn.spawn });
  const ctx = fakeCtx(projectDir, true);
  await pi.fire("session_start", { reason: "startup" }, ctx);
  return {
    pi,
    spawn,
    ctx,
    call: (name, params = {}) => pi.tools.get(name)!.execute("call-1", params, undefined, undefined, ctx),
    cleanup: () => fs.rmSync(projectDir, { recursive: true, force: true }),
  };
}

/** Leader-mode registration (a child leader process sees only its own two tools). */
async function registerLeaderMode(): Promise<{ pi: ReturnType<typeof fakePi>; cleanup: () => void }> {
  isolateRunsDir();
  resetDoubleLoadGuardForTests();
  const teamDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-team-leader-contract-"));
  const teamFile = path.join(teamDir, "dev-team.md");
  fs.writeFileSync(teamFile, serializeTeam(fixtureTeam({ filePath: "" })));
  const previous = process.env[LEADER_ENV_FILE];
  process.env[LEADER_ENV_FILE] = teamFile;
  const pi = fakePi();
  try {
    agentTeamExtension(pi as never, {});
  } finally {
    if (previous === undefined) delete process.env[LEADER_ENV_FILE];
    else process.env[LEADER_ENV_FILE] = previous;
  }
  return { pi, cleanup: () => fs.rmSync(teamDir, { recursive: true, force: true }) };
}

const COCKPIT_TOOLS = [
  "team_run",
  "team_status",
  "team_transcript",
  "team_stop",
  "team_resume",
  "team_create",
  "team_list",
  "team_models",
];
const LEADER_TOOLS = ["team_dispatch", "team_ask"];
/** 编排型（起子进程 / 杀进程 / 写盘）与阻塞型（team_ask 等人）：脚本不可达。 */
const MODEL_ONLY_TOOLS = ["team_ask", "team_run", "team_resume", "team_stop", "team_create", "team_dispatch"];
/** 查询型：脚本可调，正是 outputSchema 的用途。 */
const QUERY_TOOLS = ["team_status", "team_list", "team_transcript", "team_models"];

const NAMESPACE = { name: "agent-team", description: "多 agent 团队派单与查询" };

test("exposure 分级：编排型/阻塞型 model-only，查询型 direct", async () => {
  const cockpit = await registerCockpit();
  const leader = await registerLeaderMode();
  try {
    assert.deepEqual([...cockpit.pi.tools.keys()].sort(), [...COCKPIT_TOOLS].sort(), "cockpit 模式注册面");
    assert.deepEqual([...leader.pi.tools.keys()].sort(), [...LEADER_TOOLS].sort(), "leader 模式注册面");

    for (const name of [...COCKPIT_TOOLS, ...LEADER_TOOLS]) {
      const tool = cockpit.pi.tools.get(name) ?? leader.pi.tools.get(name);
      assert.ok(tool, `${name} 已注册`);
      const expected = MODEL_ONLY_TOOLS.includes(name) ? "model-only" : "direct";
      // direct 是宿主默认值：查询型不写冗余字段，断言读默认口径。
      assert.equal(tool.exposure ?? "direct", expected, `${name} exposure`);
    }
  } finally {
    cockpit.cleanup();
    leader.cleanup();
  }
});

test("annotations：查询型只读、写盘/停止破坏性、派单破坏性+开放世界、team_ask 无标注", async () => {
  const cockpit = await registerCockpit();
  const leader = await registerLeaderMode();
  try {
    const tool = (name: string): RegisteredTool => (cockpit.pi.tools.get(name) ?? leader.pi.tools.get(name))!;

    for (const name of QUERY_TOOLS) {
      assert.deepEqual(tool(name).annotations, { readOnlyHint: true }, `${name} 只读`);
    }
    for (const name of ["team_stop", "team_create"]) {
      assert.deepEqual(tool(name).annotations, { destructiveHint: true }, `${name} 破坏性`);
    }
    for (const name of ["team_run", "team_resume", "team_dispatch"]) {
      assert.deepEqual(
        tool(name).annotations,
        { destructiveHint: true, openWorldHint: true },
        `${name} 破坏性 + 开放世界`,
      );
    }
    // 阻塞语义在 ToolAnnotations 里没有对应字段（缺口登记在 general-todo#21），
    // 只能靠 exposure 兜——因此这里不标任何副作用提示。
    assert.equal(tool("team_ask").annotations, undefined, "team_ask 无标注");
  } finally {
    cockpit.cleanup();
    leader.cleanup();
  }
});

test("namespace：9 个工具同属 agent-team 分组", async () => {
  const cockpit = await registerCockpit();
  const leader = await registerLeaderMode();
  try {
    for (const name of [...COCKPIT_TOOLS, ...LEADER_TOOLS]) {
      const tool = cockpit.pi.tools.get(name) ?? leader.pi.tools.get(name);
      assert.deepEqual(tool?.namespace, NAMESPACE, `${name} namespace`);
    }
  } finally {
    cockpit.cleanup();
    leader.cleanup();
  }
});

test("outputSchema：只查询型四个声明（编排型保持无结构契约）", async () => {
  const cockpit = await registerCockpit();
  const leader = await registerLeaderMode();
  try {
    for (const name of QUERY_TOOLS) {
      assert.notEqual(cockpit.pi.tools.get(name)!.outputSchema, undefined, `${name} 有 outputSchema`);
    }
    for (const name of [...COCKPIT_TOOLS, ...LEADER_TOOLS].filter((n) => !QUERY_TOOLS.includes(n))) {
      const tool = cockpit.pi.tools.get(name) ?? leader.pi.tools.get(name);
      assert.equal(tool?.outputSchema, undefined, `${name} 不声明 outputSchema`);
    }
  } finally {
    cockpit.cleanup();
    leader.cleanup();
  }
});

/** Scripted leader turn: one dispatch of both members, then the final report. */
function leaderLines(): string[] {
  return [
    messageEndLine("assistant", {
      content: [{ type: "text", text: "开始拆解" }],
      usage: { input: 10, output: 5, cost: { total: 0.001 }, totalTokens: 15 },
    }),
    toolExecutionStartLine("team_dispatch", { tasks: [{ agent: "frontend", task: "a" }] }),
    toolExecutionEndLine("team_dispatch", {
      content: [{ type: "text", text: "report" }],
      details: {
        members: [
          { name: "frontend", ok: true, status: "done", summary: "前端做完", usage: { input: 1, output: 1, cost: 0.01, turns: 1 } },
          { name: "backend", ok: true, status: "done", summary: "后端做完", usage: { input: 2, output: 2, cost: 0.02, turns: 1 } },
        ],
        totalUsage: { input: 3, output: 3, cost: 0.03, turns: 2 },
      },
    }),
    messageEndLine("assistant", {
      content: [{ type: "text", text: "FINAL REPORT" }],
      usage: { input: 50, output: 20, cost: { total: 0.05 }, totalTokens: 300 },
    }),
  ];
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 400 && !predicate(); i++) await sleep(5);
}

test("team_status：空态/活跃/终态/未知 runId 的结构化契约", async () => {
  const { pi, spawn, call, cleanup } = await registerCockpit();
  try {
    assert.deepEqual((await call("team_status")).structuredContent, { active: [], recent: [] }, "空态汇总");

    const started = await call("team_run", { team: "proj-team", task: "修复登录 bug" });
    const runId = (started.details as { runId: string }).runId;
    const child = await waitForChild(spawn, 0);

    const aggregate = (await call("team_status")).structuredContent as {
      active: Array<Record<string, unknown>>;
      recent: unknown[];
    };
    assert.equal(aggregate.recent.length, 0);
    assert.equal(aggregate.active.length, 1);
    const active = aggregate.active[0] as {
      runId: string;
      team: string;
      status: string;
      startedAt: string;
      elapsedMs: number;
      members: Array<{ name: string; status: string }>;
      budget: { maxDispatchCalls: number; maxMemberRuns: number };
    };
    assert.equal(active.runId, runId);
    assert.equal(active.team, "proj-team");
    assert.equal(active.status, "running");
    assert.ok(Number.isFinite(Date.parse(active.startedAt)), `startedAt 是 ISO 时间: ${active.startedAt}`);
    assert.ok(active.elapsedMs >= 0);
    assert.deepEqual(active.members.map((m) => m.name), ["frontend", "backend"]);
    assert.equal(active.budget.maxDispatchCalls, 12);
    assert.equal(active.budget.maxMemberRuns, 40);

    const single = (await call("team_status", { runId })).structuredContent as Record<string, unknown>;
    assert.equal(single.runId, runId, "带 runId 给单 run 契约");
    assert.equal(single.status, "running");
    assert.equal("active" in single, false);
    assert.equal("recent" in single, false);

    child.autoRespond(leaderLines(), 0, 5);
    await waitFor(() => pi.sentMessages.length > 0);

    const after = (await call("team_status")).structuredContent as {
      active: unknown[];
      recent: Array<{ runId: string; status: string; elapsedMs?: number; members: Array<{ name: string; status: string }> }>;
    };
    assert.deepEqual(after.active, [], "终态后不再活跃");
    assert.equal(after.recent.length, 1);
    assert.equal(after.recent[0].runId, runId);
    assert.equal(after.recent[0].status, "completed");
    assert.ok((after.recent[0].elapsedMs ?? -1) >= 0);
    assert.deepEqual(after.recent[0].members, [
      { name: "frontend", status: "done" },
      { name: "backend", status: "done" },
    ]);

    // 未知 runId：没有 run 可描述 → 与空态同一形状（原因在文本里）。
    assert.deepEqual((await call("team_status", { runId: "run-nope" })).structuredContent, { active: [], recent: [] });
  } finally {
    cleanup();
  }
});

test("team_list：teams 结构化列表（name/source/members/leader）", async () => {
  const globalDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-team-list-global-"));
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-team-list-project-"));
  fs.mkdirSync(path.join(projectDir, ".pi", "teams"), { recursive: true });
  const pi = fakePi();
  registerManageTools(pi as never, { globalDir, cwd: projectDir });
  try {
    fs.writeFileSync(
      path.join(globalDir, "global-team.md"),
      serializeTeam(fixtureTeam({ name: "global-team", source: "global", filePath: "" })),
    );
    fs.writeFileSync(
      path.join(projectDir, ".pi", "teams", "proj-team.md"),
      serializeTeam(
        fixtureTeam({
          name: "proj-team",
          source: "project",
          filePath: "",
          leader: { prompt: "只有 prompt（用 pi 默认模型）" },
          members: [{ name: "frontend", prompt: "你是前端工程师。" }],
        }),
      ),
    );

    const result = await pi.tools
      .get("team_list")!
      .execute("call-1", {}, undefined, undefined, fakeCtx(projectDir, true));
    const structured = result.structuredContent as {
      teams: Array<{ name: string; source: string; members: string[]; leader?: string }>;
    };
    assert.deepEqual(structured.teams.map((t) => t.name), ["global-team", "proj-team"]);
    const globalTeam = structured.teams.find((t) => t.name === "global-team")!;
    assert.equal(globalTeam.source, "global");
    assert.deepEqual(globalTeam.members, ["frontend", "backend"]);
    assert.equal(globalTeam.leader, "anthropic/claude-opus-4-5");
    const projectTeam = structured.teams.find((t) => t.name === "proj-team")!;
    assert.equal(projectTeam.source, "project");
    assert.deepEqual(projectTeam.members, ["frontend"]);
    assert.equal(projectTeam.leader, undefined, "leader 缺省（pi 默认模型）时省略该字段");
  } finally {
    fs.rmSync(globalDir, { recursive: true, force: true });
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});

test("team_transcript：{actor, lines} 与文本同源（无 run 时 lines 为空）", async () => {
  const { pi, spawn, call, cleanup } = await registerCockpit();
  try {
    const empty = await call("team_transcript", {});
    assert.deepEqual(empty.structuredContent, { actor: LEADER_ACTOR, lines: [] });

    const pending = call("team_run", { team: "proj-team", task: "修复登录 bug", wait: true });
    const child = await waitForChild(spawn, 0);
    child.autoRespond(leaderLines(), 0, 5);
    const started = await pending;
    assert.equal(started.isError, undefined, "wait:true 内联返回报告");

    const leader = await call("team_transcript", {});
    const structured = leader.structuredContent as { actor: string; lines: string[] };
    assert.equal(structured.actor, LEADER_ACTOR);
    assert.equal(structured.lines.join("\n"), leader.content[0].text, "lines 与文本同一截断口径");
    assert.match(structured.lines[0] ?? "", /^## /);
    assert.match(structured.lines.join("\n"), /FINAL REPORT/);

    const member = await call("team_transcript", { member: "frontend" });
    assert.equal((member.structuredContent as { actor: string }).actor, "frontend");
  } finally {
    cleanup();
  }
});

test("team_models：models 结构化目录（provider/id/name）", async () => {
  const pi = fakePi();
  registerManageTools(pi as never, { globalDir: fs.mkdtempSync(path.join(os.tmpdir(), "agent-team-models-")) });
  const ctx = {
    ...fakeCtx("/repo"),
    modelRegistry: {
      getAvailable: () => [
        { provider: "anthropic", id: "claude-opus-4-5", name: "Claude Opus 4.5", reasoning: true, contextWindow: 200000 },
        { provider: "chatanywhere", id: "gpt-5.6", name: "GPT-5.6", reasoning: false, contextWindow: 128000 },
      ],
      getProviderDisplayName: (provider: string) => provider,
    },
  };
  const result = await pi.tools
    .get("team_models")!
    .execute("call-1", {}, undefined, undefined, ctx as never);
  assert.deepEqual(result.structuredContent, {
    models: [
      { provider: "anthropic", id: "claude-opus-4-5", name: "Claude Opus 4.5" },
      { provider: "chatanywhere", id: "gpt-5.6", name: "GPT-5.6" },
    ],
  });
  assert.match(result.content[0].text, /claude-opus-4-5/, "文本目录不变");
});
