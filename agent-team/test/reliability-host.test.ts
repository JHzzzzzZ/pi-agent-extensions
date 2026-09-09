/**
 * Host-level reliability wiring (real entry, fake ExtensionAPI):
 * - session_start reconciles stale `running` status files into failed
 *   records with an orphan-leader warning (no process is killed);
 * - team_run model preflight fails typed (MODEL_NOT_FOUND) before any
 *   spawn and warns on models without configured auth;
 * - leader mode consumes the frontmatter budget block;
 * - /team:doctor renders the self-check report.
 */

import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { serializeTeam } from "../config.ts";
import { RUN_STATUS_VERSION } from "../runstore.ts";
import agentTeamExtension, { resetDoubleLoadGuardForTests } from "../index.ts";
import { fixtureTeam } from "./fixtures.ts";
import { makeFakeSpawn, waitForChild, type FakeSpawnHandle, isolateRunsDir } from "./helpers.ts";

isolateRunsDir();

// -- fake ExtensionAPI / ctx (same shape as entry.test.ts) ------------------

function fakePi() {
  const tools = new Map<string, Record<string, unknown>>();
  const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> | void; description: string }>();
  const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => Promise<void>>>();
  return {
    tools,
    commands,
    on(name: string, fn: (event: unknown, ctx: unknown) => Promise<void>) {
      const list = handlers.get(name) ?? [];
      list.push(fn);
      handlers.set(name, list);
    },
    registerTool(tool: Record<string, unknown> & { name: string }) {
      tools.set(tool.name, tool);
    },
    registerCommand(name: string, command: { handler: (args: string, ctx: unknown) => Promise<void> | void; description: string }) {
      commands.set(name, command);
    },
    registerEntryRenderer(_type: string, _renderer: unknown) {},
    appendEntry(_customType: string, _data: unknown) {
      return {};
    },
    sendMessage(_message: unknown, _options?: unknown) {
      return {};
    },
    async fire(name: string, event: unknown, ctx: unknown) {
      for (const fn of handlers.get(name) ?? []) await fn(event, ctx);
    },
  };
}

interface CtxOptions {
  trusted?: boolean;
  registry?: unknown;
  runIds?: Array<{ runId: string; team?: string; task?: string; startedAt?: string; status?: string }>;
}

function fakeCtx(cwd: string, options: CtxOptions = {}) {
  const notifications: Array<{ text: string; level: string }> = [];
  const entries = (options.runIds ?? []).map((r) => ({
    type: "custom",
    customType: "agent-team-run-v1",
    data: { totalCost: 0, totalTokens: 0, members: [], ...r },
  }));
  const ctx = {
    cwd,
    hasUI: false,
    mode: "tui",
    isProjectTrusted: () => options.trusted ?? true,
    modelRegistry: options.registry,
    ui: { notify: (text: string, level: string) => notifications.push({ text, level }) },
    sessionManager: { getEntries: () => entries },
  };
  return { ctx, notifications };
}

function setupProjectTeam(name: string, team: ReturnType<typeof fixtureTeam>): string {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-team-reliability-"));
  fs.mkdirSync(path.join(projectDir, ".pi", "teams"), { recursive: true });
  fs.writeFileSync(path.join(projectDir, ".pi", "teams", `${name}.md`), serializeTeam(team));
  return projectDir;
}

function fakeRegistry(models: Array<{ provider: string; id: string; auth?: boolean }>, error?: string) {
  return {
    refresh: async () => {},
    getError: () => error,
    find: (provider: string, id: string) => models.find((m) => m.provider === provider && m.id === id),
    hasConfiguredAuth: (model: { auth?: boolean }) => model.auth === true,
  };
}

// ---------------------------------------------------------------------------
// session_start reconcile of stale running runs
// ---------------------------------------------------------------------------

test("session_start reconciles stale running status files into failed records (report only)", async () => {
  resetDoubleLoadGuardForTests();
  const projectDir = setupProjectTeam("recon-team", fixtureTeam({ name: "recon-team", filePath: "" }));
  const runsRoot = process.env.PI_AGENT_TEAM_RUNS_DIR ?? path.join(getAgentDir(), "teams", "runs");
  const staleDir = path.join(runsRoot, `run-reconcile-test-${Date.now()}`);
  fs.mkdirSync(staleDir, { recursive: true });
  fs.writeFileSync(
    path.join(staleDir, "status.json"),
    JSON.stringify({
      version: RUN_STATUS_VERSION,
      runId: path.basename(staleDir),
      team: "recon-team",
      task: "上次会话崩溃时的任务",
      startedAt: "2026-09-09T00:00:00Z",
      status: "running",
      leaderPid: 12345,
      updatedAt: "2026-09-09T00:00:00Z",
    }),
    "utf-8",
  );

  const spawn = makeFakeSpawn();
  const pi = fakePi();
  agentTeamExtension(pi as never, { spawn: spawn.spawn });
  const { ctx, notifications } = fakeCtx(projectDir);
  try {
    await pi.fire("session_start", { reason: "startup" }, ctx);

    // Warning surfaced with the orphan-leader diagnostic (no kill).
    const warning = notifications.find((n) => n.level === "warning" && n.text.includes(path.basename(staleDir)));
    assert.ok(warning, `warning notify present: ${JSON.stringify(notifications)}`);
    assert.match(warning.text, /已标记为 failed/);
    assert.match(warning.text, /pid=12345/);
    assert.match(warning.text, /未自动终止/);

    // status.json on disk flipped to failed (next start won't re-report).
    const raw = JSON.parse(fs.readFileSync(path.join(staleDir, "status.json"), "utf-8")) as { status: string; error?: string };
    assert.equal(raw.status, "failed");
    assert.match(raw.error ?? "", /pid=12345/);

    // The synthesized record is visible through team_status.
    const statusTool = pi.tools.get("team_status") as { execute: () => Promise<{ content: Array<{ text: string }> }> };
    const status = await statusTool.execute();
    assert.match(status.content[0].text, new RegExp(path.basename(staleDir)));
    assert.match(status.content[0].text, /failed/);
    assert.equal(spawn.records.length, 0, "reconcile never spawns anything");
  } finally {
    fs.rmSync(staleDir, { recursive: true, force: true });
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});

test("session_start without stale runs stays silent", async () => {
  resetDoubleLoadGuardForTests();
  const projectDir = setupProjectTeam("quiet-team", fixtureTeam({ name: "quiet-team", filePath: "" }));
  const spawn = makeFakeSpawn();
  const pi = fakePi();
  agentTeamExtension(pi as never, { spawn: spawn.spawn });
  const { ctx, notifications } = fakeCtx(projectDir);
  try {
    await pi.fire("session_start", { reason: "startup" }, ctx);
    assert.equal(notifications.filter((n) => n.level === "warning").length, 0);
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// team_run model preflight
// ---------------------------------------------------------------------------

type RunTool = (params: Record<string, unknown>, ctx: unknown) => Promise<{
  content: Array<{ type: string; text: string }>;
  details?: unknown;
  isError?: boolean;
}>;

function getRunTool(pi: ReturnType<typeof fakePi>): RunTool {
  const tool = pi.tools.get("team_run") as unknown as {
    execute: (id: string, params: Record<string, unknown>, signal?: undefined, onUpdate?: undefined, ctx?: unknown) => ReturnType<RunTool>;
  };
  return (params, ctx) => tool.execute("call-1", params, undefined, undefined, ctx);
}

test("team_run with an unresolvable model fails typed before spawning", async () => {
  resetDoubleLoadGuardForTests();
  const projectDir = setupProjectTeam(
    "badmodel-team",
    fixtureTeam({ name: "badmodel-team", members: [{ name: "ghosted", model: "ghost/no-such-model", prompt: "p" }], filePath: "" }),
  );
  const spawn = makeFakeSpawn();
  const pi = fakePi();
  agentTeamExtension(pi as never, { spawn: spawn.spawn });
  const { ctx } = fakeCtx(projectDir, { registry: fakeRegistry([]) });
  try {
    await pi.fire("session_start", { reason: "startup" }, ctx);
    const result = await getRunTool(pi)({ team: "badmodel-team", task: "t" }, ctx);
    assert.equal(result.isError, true);
    assert.equal((result.details as { code?: string }).code, "MODEL_NOT_FOUND");
    assert.match(result.content[0].text, /ghost\/no-such-model/);
    assert.match(result.content[0].text, /team_models/);
    assert.equal(spawn.records.length, 0, "nothing spawned");
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});

test("team_run passes preflight when models resolve (auth warning only, no block)", async () => {
  resetDoubleLoadGuardForTests();
  const projectDir = setupProjectTeam("authwarn-team", fixtureTeam({ name: "authwarn-team", filePath: "" }));
  const spawn = makeFakeSpawn();
  const pi = fakePi();
  agentTeamExtension(pi as never, { spawn: spawn.spawn });
  const { ctx, notifications } = fakeCtx(projectDir, {
    registry: fakeRegistry([
      { provider: "anthropic", id: "claude-opus-4-5" },
      { provider: "chatanywhere", id: "gpt-5.6", auth: true },
      { provider: "anthropic", id: "claude-sonnet-4-5", auth: true },
    ]),
  });
  try {
    await pi.fire("session_start", { reason: "startup" }, ctx);
    const result = await getRunTool(pi)({ team: "authwarn-team", task: "t" }, ctx);
    assert.match(result.content[0].text, /已在后台启动/);
    assert.equal((result.details as { code?: string }).code, undefined);
    assert.ok(notifications.some((n) => n.level === "warning" && n.text.includes("claude-opus-4-5")), "auth warning surfaced");
    const child = await waitForChild(spawn, 0);
    assert.equal(spawn.records.length, 1, "leader spawned");
    child.emitClose(0);
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});

test("team_run without a host registry skips preflight (background dispatch still works)", async () => {
  resetDoubleLoadGuardForTests();
  const projectDir = setupProjectTeam("noregistry-team", fixtureTeam({ name: "noregistry-team", filePath: "" }));
  const spawn = makeFakeSpawn();
  const pi = fakePi();
  agentTeamExtension(pi as never, { spawn: spawn.spawn });
  const { ctx } = fakeCtx(projectDir);
  try {
    await pi.fire("session_start", { reason: "startup" }, ctx);
    const result = await getRunTool(pi)({ team: "noregistry-team", task: "t" }, ctx);
    assert.match(result.content[0].text, /已在后台启动/);
    const child = await waitForChild(spawn, 0);
    child.emitClose(0);
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Leader mode budget from the frontmatter block
// ---------------------------------------------------------------------------

function withLeaderEnv(file: string | undefined, fn: () => void | Promise<void>): Promise<void> | void {
  const previous = process.env.PI_AGENT_TEAM_FILE;
  if (file === undefined) delete process.env.PI_AGENT_TEAM_FILE;
  else process.env.PI_AGENT_TEAM_FILE = file;
  const done = fn();
  if (done instanceof Promise) {
    return done.finally(() => {
      if (previous === undefined) delete process.env.PI_AGENT_TEAM_FILE;
      else process.env.PI_AGENT_TEAM_FILE = previous;
    });
  }
  if (previous === undefined) delete process.env.PI_AGENT_TEAM_FILE;
  else process.env.PI_AGENT_TEAM_FILE = previous;
}

type DispatchTool = (params: { tasks: Array<{ agent: string; task: string }> }) => Promise<{
  content: Array<{ type: string; text: string }>;
  details?: { code?: string; members?: unknown[] };
  isError?: boolean;
}>;

test("leader mode consumes the frontmatter budget block (dispatch cap enforced)", async () => {
  resetDoubleLoadGuardForTests();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-team-leader-budget-"));
  const teamFile = path.join(dir, "budgeted.md");
  const team = fixtureTeam({
    name: "budgeted",
    budget: { maxDispatchCalls: 1 },
    members: [{ name: "real-member", model: "chatanywhere/gpt-5.6", prompt: "p" }],
    filePath: teamFile,
  });
  fs.writeFileSync(teamFile, serializeTeam(team));
  const pi = fakePi();
  await withLeaderEnv(teamFile, async () => {
    agentTeamExtension(pi as never);
    const dispatch = pi.tools.get("team_dispatch") as unknown as {
      execute: (id: string, params: { tasks: Array<{ agent: string; task: string }> }) => ReturnType<DispatchTool>;
    };
    // First call: unknown member → failed result, budget counter at 1/1.
    const first = await dispatch.execute("d1", { tasks: [{ agent: "ghost", task: "x" }] });
    const members = first.details?.members as Array<{ status?: string; error?: { code?: string } }>;
    assert.equal(members?.[0]?.error?.code, "MEMBER_NOT_FOUND");
    assert.equal(first.isError, undefined, "per-member failure is not a tool error");
    // Second call: dispatch budget exhausted → typed BUDGET_EXCEEDED.
    const second = await dispatch.execute("d2", { tasks: [{ agent: "ghost", task: "y" }] });
    assert.equal(second.isError, true);
    assert.equal(second.details?.code, "BUDGET_EXCEEDED");
    assert.match(second.content[0].text, /上限 1/);
  });
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// /team:doctor
// ---------------------------------------------------------------------------

test("/team:doctor renders the self-check report (registry refreshed, error surfaced)", async () => {
  resetDoubleLoadGuardForTests();
  const projectDir = setupProjectTeam("doctor-team", fixtureTeam({ name: "doctor-team", filePath: "" }));
  const spawn: FakeSpawnHandle = makeFakeSpawn();
  const pi = fakePi();
  agentTeamExtension(pi as never, { spawn: spawn.spawn });
  let refreshed = false;
  const registry = { ...fakeRegistry([], "models.json 解析失败"), refresh: async () => { refreshed = true; } };
  const { ctx, notifications } = fakeCtx(projectDir, { registry });
  try {
    await pi.fire("session_start", { reason: "startup" }, ctx);
    assert.ok(pi.commands.has("team:doctor"), "doctor command registered");
    const handler = pi.commands.get("team:doctor")!.handler;
    await handler("", ctx);
    assert.equal(refreshed, true, "registry refreshed before reading");
    const info = notifications.find((n) => n.level === "info");
    assert.ok(info, "report notified");
    assert.match(info.text, /agent-team 自检报告/);
    assert.match(info.text, /错误: models\.json 解析失败/);
    assert.match(info.text, /doctor-team/);
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});

test("a team named doctor cannot shadow the built-in /team:doctor command", async () => {
  resetDoubleLoadGuardForTests();
  const projectDir = setupProjectTeam("doctor", fixtureTeam({ name: "doctor", description: "自定义团队", filePath: "" }));
  const pi = fakePi();
  agentTeamExtension(pi as never);
  const { ctx } = fakeCtx(projectDir, { trusted: true });
  try {
    await pi.fire("session_start", { reason: "startup" }, ctx);
    const description = pi.commands.get("team:doctor")!.description;
    assert.match(description, /自检/, "built-in doctor description wins over the dynamic team dispatch");
    assert.doesNotMatch(description, /派单给/);
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});
