/**
 * Unified `/team` command router tests (命令风格统一：子命令式).
 *
 * The whole cockpit command surface is ONE `/team` command:
 *   /team                        → list teams
 *   /team run <团队> <任务>       → dispatch
 *   /team <团队> <任务>           → dispatch (first token not reserved)
 *   /team status|stop|view|clear|doctor → sub-commands
 *
 * Locks the routing contract against the real entry + fake spawn:
 * - session_start registers exactly one command ("team"); the old dynamic
 *   `team:<name>` registrations are gone.
 * - Reserved-word first tokens route to sub-commands; any other first token
 *   is a team name (bare dispatch).
 * - A team named like a reserved word is dispatched explicitly via
 *   /team run <name> <任务>, and the bare /team listing points that out.
 */

import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { serializeTeam } from "../config.ts";
import agentTeamExtension, { resetDoubleLoadGuardForTests } from "../index.ts";
import { fixtureTeam } from "./fixtures.ts";
import { isolateRunsDir, makeFakeSpawn, waitForChild, type FakeSpawnHandle } from "./helpers.ts";

function fakePi() {
  const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => Promise<void>>>();
  const commands = new Map<string, { description: string; handler: (args: string, ctx: unknown) => Promise<void> }>();
  return {
    commands,
    on(name: string, fn: (event: unknown, ctx: unknown) => Promise<void>) {
      const list = handlers.get(name) ?? [];
      list.push(fn);
      handlers.set(name, list);
    },
    registerCommand(name: string, command: { description: string; handler: (args: string, ctx: unknown) => Promise<void> }) {
      commands.set(name, command);
    },
    registerTool() {},
    registerEntryRenderer() {},
    appendEntry() {
      return {};
    },
    sendMessage() {
      return {};
    },
    async fire(name: string, event: unknown, ctx: unknown) {
      for (const fn of handlers.get(name) ?? []) await fn(event, ctx);
    },
  };
}

function fakeTuiCtx(cwd: string) {
  const notifications: Array<{ text: string; level?: string }> = [];
  const ctx = {
    cwd,
    hasUI: true,
    mode: "tui",
    isProjectTrusted: () => true,
    ui: {
      theme: { fg: (_c: string, t: string) => t, bg: (_c: string, t: string) => t },
      notify: (text: string, level?: string) => notifications.push({ text, level }),
      setWidget: () => {},
    },
    sessionManager: { getEntries: () => [] },
  };
  return { ctx, notifications };
}

interface Setup {
  pi: ReturnType<typeof fakePi>;
  spawn: FakeSpawnHandle;
  ctx: unknown;
  notifications: Array<{ text: string; level?: string }>;
  team: (args: string, cmdCtx?: unknown) => Promise<void>;
  cleanup: () => void;
}

async function setup(opts: { extraTeams?: string[] } = {}): Promise<Setup> {
  resetDoubleLoadGuardForTests();
  isolateRunsDir();
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-team-cmd-"));
  fs.mkdirSync(path.join(projectDir, ".pi", "teams"), { recursive: true });
  fs.writeFileSync(
    path.join(projectDir, ".pi", "teams", "proj-team.md"),
    serializeTeam(fixtureTeam({ name: "proj-team", description: "项目团队", filePath: "", notes: undefined })),
  );
  for (const name of opts.extraTeams ?? []) {
    fs.writeFileSync(
      path.join(projectDir, ".pi", "teams", `${name}.md`),
      serializeTeam(fixtureTeam({ name, description: `${name} 团队`, filePath: "", notes: undefined })),
    );
  }
  const spawn = makeFakeSpawn();
  const pi = fakePi();
  agentTeamExtension(pi as never, { spawn: spawn.spawn });
  const { ctx, notifications } = fakeTuiCtx(projectDir);
  await pi.fire("session_start", { reason: "startup" }, ctx);
  return {
    pi,
    spawn,
    ctx,
    notifications,
    team: (args, cmdCtx) => pi.commands.get("team")!.handler(args, cmdCtx ?? ctx),
    cleanup: () => fs.rmSync(projectDir, { recursive: true, force: true }),
  };
}

test("session_start registers exactly one /team command (no dynamic team:<name>)", async () => {
  const { pi, cleanup } = await setup({ extraTeams: ["proj-team", "another-team"] });
  try {
    assert.deepEqual([...pi.commands.keys()], ["team"], "only /team is registered");
    assert.ok(!pi.commands.has("team:proj-team"), "dynamic team:<name> must be gone");
    assert.ok(!pi.commands.has("team:run"), "team:run must be gone");
    assert.ok(!pi.commands.has("team:status"), "team:status must be gone");
  } finally {
    cleanup();
  }
});

test("/team with no args lists teams", async () => {
  const { team, notifications, cleanup } = await setup();
  try {
    await team("");
    const last = notifications.at(-1);
    assert.ok(last, "list notified");
    assert.match(last.text, /proj-team/);
    assert.match(last.text, /项目团队/);
  } finally {
    cleanup();
  }
});

test("/team <团队> <任务> dispatches without a dynamic command registration", async () => {
  const { spawn, team, notifications, cleanup } = await setup();
  try {
    await team("proj-team 写一个 hello");
    await waitForChild(spawn, 0);
    assert.equal(spawn.records.length, 1, "one leader spawned");
    const last = notifications.at(-1);
    assert.ok(last, "dispatch notified");
    assert.match(last.text, /已在后台启动/);
  } finally {
    cleanup();
  }
});

test("/team run <团队> <任务> dispatches (explicit form)", async () => {
  const { spawn, team, notifications, cleanup } = await setup();
  try {
    await team("run proj-team 写一个 hello");
    await waitForChild(spawn, 0);
    assert.equal(spawn.records.length, 1, "one leader spawned");
    assert.match(notifications.at(-1)?.text ?? "", /已在后台启动/);
  } finally {
    cleanup();
  }
});

test("/team <团队> without a task replies with a usage hint (no dispatch)", async () => {
  const { spawn, team, notifications, cleanup } = await setup();
  try {
    await team("proj-team");
    assert.equal(spawn.records.length, 0, "no dispatch");
    const last = notifications.at(-1);
    assert.equal(last?.level, "warning");
    assert.match(last?.text ?? "", /用法：\/team proj-team <任务描述>/);
  } finally {
    cleanup();
  }
});

test("/team run <团队> without a task replies with a usage hint (no dispatch)", async () => {
  const { spawn, team, notifications, cleanup } = await setup();
  try {
    await team("run proj-team");
    assert.equal(spawn.records.length, 0, "no dispatch");
    const last = notifications.at(-1);
    assert.equal(last?.level, "warning");
    assert.match(last?.text ?? "", /用法：\/team run <团队名> <任务描述>/);
  } finally {
    cleanup();
  }
});

test("/team status renders the status snapshot", async () => {
  const { team, notifications, cleanup } = await setup();
  try {
    await team("status");
    const last = notifications.at(-1);
    assert.ok(last, "status notified");
    assert.match(last.text, /当前没有 team run 记录/);
  } finally {
    cleanup();
  }
});

test("/team stop on an idle session reports nothing to stop", async () => {
  const { team, notifications, cleanup } = await setup();
  try {
    await team("stop");
    const last = notifications.at(-1);
    assert.equal(last?.level, "info");
    assert.match(last?.text ?? "", /没有正在进行/);
  } finally {
    cleanup();
  }
});

test("/team view routes to the viewer branch (no run → its own hint)", async () => {
  const { team, notifications, cleanup } = await setup();
  try {
    await team("view");
    const last = notifications.at(-1);
    assert.ok(last, "view notified");
    assert.match(last.text, /派单后即可查看/);
  } finally {
    cleanup();
  }
});

test("/team clear routes to the clear branch (no widget → info hint)", async () => {
  const { team, notifications, cleanup } = await setup();
  try {
    await team("clear");
    const last = notifications.at(-1);
    assert.equal(last?.level, "info");
    assert.match(last?.text ?? "", /亮块/);
  } finally {
    cleanup();
  }
});

test("/team doctor renders the self-check report", async () => {
  const { team, notifications, cleanup } = await setup();
  try {
    await team("doctor");
    const last = notifications.at(-1);
    assert.ok(last, "doctor notified");
    assert.match(last.text, /agent-team 自检报告/);
  } finally {
    cleanup();
  }
});

test("a team named like a reserved word: bare form is the sub-command, explicit run dispatches", async () => {
  const { spawn, team, notifications, cleanup } = await setup({ extraTeams: ["clear"] });
  try {
    // /team clear is the built-in sub-command, never a dispatch to the team.
    await team("clear");
    assert.equal(spawn.records.length, 0, "team named clear must not shadow the sub-command");
    assert.match(notifications.at(-1)?.text ?? "", /亮块/);

    // The list output points at the explicit form.
    await team("");
    assert.match(notifications.at(-1)?.text ?? "", /\/team run clear <任务>/);

    // Explicit /team run clear <task> reaches the team.
    await team("run clear 做点事");
    await waitForChild(spawn, 0);
    assert.equal(spawn.records.length, 1, "explicit run dispatches to the reserved-name team");
    assert.match(notifications.at(-1)?.text ?? "", /已在后台启动/);
  } finally {
    cleanup();
  }
});
