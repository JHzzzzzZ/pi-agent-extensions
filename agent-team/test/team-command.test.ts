/**
 * Colon-namespaced `/team` command surface tests (命令面冒号化，v1.12.0).
 *
 * The cockpit command surface is one bare root command plus one statically
 * registered command per sub-command:
 *   /team                        → list teams (with args: usage hint)
 *   /team:list                   → list teams
 *   /team:run <团队> <任务>       → dispatch
 *   /team:status|stop|view|clear|doctor
 *
 * Locks the routing contract against the real entry + fake spawn:
 * - session_start registers the bare root plus the seven colon commands and
 *   nothing else; no dynamic `team:<name>` registrations exist (retired in
 *   v1.9.0 and kept retired).
 * - The bare root executes its historical behaviour ONLY with no args; any
 *   argument produces a usage hint. Old space-separated sub-commands get a
 *   rename hint and MUST NOT execute (no dispatch / no widget side effect).
 * - Team names may again collide with sub-command words: `/team:run <name>`
 *   dispatches any name — the reserved-word concept is retired.
 */

import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { serializeTeam } from "../config.ts";
import agentTeamExtension, {
  RETIRED_TEAM_SUBCOMMANDS,
  TEAM_COMMAND_NAMES,
  resetDoubleLoadGuardForTests,
} from "../index.ts";
import { readRunStatuses } from "../runstore.ts";
import { fixtureTeam } from "./fixtures.ts";
import { isolateRunsDir, makeFakeSpawn, messageEndLine, sleep, waitForChild, type FakeSpawnHandle } from "./helpers.ts";

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 400 && !predicate(); i++) await sleep(5);
}

function fakePi() {
  const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => Promise<void>>>();
  const commands = new Map<string, { description: string; handler: (args: string, ctx: unknown) => Promise<void> }>();
  const sentMessages: unknown[] = [];
  return {
    commands,
    sentMessages,
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
      sentMessages.push({});
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
  /** Isolated run-artifact root (status.json + session mirrors). */
  runsDir: string;
  /** Invoke a registered command by its exact name. */
  cmd: (name: string, args: string, cmdCtx?: unknown) => Promise<void>;
  cleanup: () => void;
}

async function setup(opts: { extraTeams?: string[] } = {}): Promise<Setup> {
  resetDoubleLoadGuardForTests();
  const runsDir = isolateRunsDir();
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
    runsDir,
    cmd: (name, args, cmdCtx) => {
      const command = pi.commands.get(name);
      assert.ok(command, `command ${name} must be registered`);
      return command.handler(args, cmdCtx ?? ctx);
    },
    cleanup: () => fs.rmSync(projectDir, { recursive: true, force: true }),
  };
}

const EXPECTED_COMMANDS = [
  "team",
  TEAM_COMMAND_NAMES.list,
  TEAM_COMMAND_NAMES.run,
  TEAM_COMMAND_NAMES.resume,
  TEAM_COMMAND_NAMES.status,
  TEAM_COMMAND_NAMES.stop,
  TEAM_COMMAND_NAMES.view,
  TEAM_COMMAND_NAMES.clear,
  TEAM_COMMAND_NAMES.doctor,
];

/** Position of a flag's value in a spawn argv (index.ts tests get a runner prefix). */
function argValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

test("session_start registers the bare root plus every colon sub-command", async () => {
  const { pi, cleanup } = await setup({ extraTeams: ["proj-team", "another-team"] });
  try {
    assert.deepEqual([...pi.commands.keys()], EXPECTED_COMMANDS, "root + colon commands only");
    for (const name of EXPECTED_COMMANDS) {
      assert.ok((pi.commands.get(name)!.description ?? "").length > 0, `${name} has a description`);
    }
    assert.ok(!pi.commands.has("team:proj-team"), "dynamic team:<name> stays retired");
  } finally {
    cleanup();
  }
});

test("/team with no args lists teams", async () => {
  const { cmd, notifications, cleanup } = await setup();
  try {
    await cmd("team", "");
    const last = notifications.at(-1);
    assert.ok(last, "list notified");
    assert.match(last.text, /proj-team/);
    assert.match(last.text, /项目团队/);
  } finally {
    cleanup();
  }
});

test("/team:list lists teams", async () => {
  const { cmd, notifications, cleanup } = await setup();
  try {
    await cmd(TEAM_COMMAND_NAMES.list, "");
    const last = notifications.at(-1);
    assert.ok(last, "list notified");
    assert.match(last.text, /proj-team/);
  } finally {
    cleanup();
  }
});

test("the retired bare dispatch form /team <团队> <任务> is a usage hint (no spawn)", async () => {
  const { spawn, cmd, notifications, cleanup } = await setup();
  try {
    await cmd("team", "proj-team 写一个 hello");
    assert.equal(spawn.records.length, 0, "no dispatch from the bare root");
    const last = notifications.at(-1);
    assert.equal(last?.level, "warning");
    assert.match(last?.text ?? "", /\/team:run <团队>/);
  } finally {
    cleanup();
  }
});

test("/team:run <团队> <任务> dispatches", async () => {
  const { spawn, cmd, notifications, cleanup } = await setup();
  try {
    await cmd(TEAM_COMMAND_NAMES.run, "proj-team 写一个 hello");
    await waitForChild(spawn, 0);
    assert.equal(spawn.records.length, 1, "one leader spawned");
    assert.match(notifications.at(-1)?.text ?? "", /已在后台启动/);
  } finally {
    cleanup();
  }
});

test("/team:run <团队> without a task replies with a usage hint (no dispatch)", async () => {
  const { spawn, cmd, notifications, cleanup } = await setup();
  try {
    await cmd(TEAM_COMMAND_NAMES.run, "proj-team");
    assert.equal(spawn.records.length, 0, "no dispatch");
    const last = notifications.at(-1);
    assert.equal(last?.level, "warning");
    assert.match(last?.text ?? "", /用法：\/team:run <团队名> <任务描述>/);
  } finally {
    cleanup();
  }
});

test("old space-separated sub-commands reply with a rename hint and never execute", async () => {
  const { spawn, cmd, notifications, cleanup } = await setup();
  try {
    for (const [head, target] of Object.entries(RETIRED_TEAM_SUBCOMMANDS)) {
      const before = notifications.length;
      await cmd("team", head);
      const last = notifications.at(-1);
      assert.equal(notifications.length, before + 1, `/team ${head} notifies exactly once`);
      assert.equal(last?.level, "warning", `/team ${head} hints as warning`);
      assert.ok(last?.text.includes(`「/team ${head}」已改名为「/${target.command}」`), `/team ${head} rename hint names /${target.command}`);
    }
    assert.equal(spawn.records.length, 0, "no retired form ever dispatches");
  } finally {
    cleanup();
  }
});

test("the rename hint for /team stop does not send a stop signal", async () => {
  const { cmd, notifications, cleanup } = await setup();
  try {
    await cmd("team", "stop");
    assert.match(notifications.at(-1)?.text ?? "", /已改名为「\/team:stop」/);
    assert.ok(!notifications.some((n) => /已发送中止信号/.test(n.text)), "hint must not stop anything");
  } finally {
    cleanup();
  }
});

test("/team:status renders the status snapshot", async () => {
  const { cmd, notifications, cleanup } = await setup();
  try {
    await cmd(TEAM_COMMAND_NAMES.status, "");
    const last = notifications.at(-1);
    assert.ok(last, "status notified");
    assert.match(last.text, /当前没有 team run 记录/);
  } finally {
    cleanup();
  }
});

test("/team:stop on an idle session reports nothing to stop", async () => {
  const { cmd, notifications, cleanup } = await setup();
  try {
    await cmd(TEAM_COMMAND_NAMES.stop, "");
    const last = notifications.at(-1);
    assert.equal(last?.level, "info");
    assert.match(last?.text ?? "", /没有正在进行/);
  } finally {
    cleanup();
  }
});

test("/team:view routes to the viewer branch (no run → its own hint)", async () => {
  const { cmd, notifications, cleanup } = await setup();
  try {
    await cmd(TEAM_COMMAND_NAMES.view, "");
    const last = notifications.at(-1);
    assert.ok(last, "view notified");
    assert.match(last.text, /派单后即可查看/);
  } finally {
    cleanup();
  }
});

test("/team:clear routes to the clear branch (no widget → info hint)", async () => {
  const { cmd, notifications, cleanup } = await setup();
  try {
    await cmd(TEAM_COMMAND_NAMES.clear, "");
    const last = notifications.at(-1);
    assert.equal(last?.level, "info");
    assert.match(last?.text ?? "", /亮块/);
  } finally {
    cleanup();
  }
});

test("/team:doctor renders the self-check report", async () => {
  const { cmd, notifications, cleanup } = await setup();
  try {
    await cmd(TEAM_COMMAND_NAMES.doctor, "");
    const last = notifications.at(-1);
    assert.ok(last, "doctor notified");
    assert.match(last.text, /agent-team 自检报告/);
  } finally {
    cleanup();
  }
});

test("sub-command words are valid team names again (reserved list retired)", async () => {
  const { pi, spawn, cmd, notifications, cleanup } = await setup({ extraTeams: ["clear", "run", "status"] });
  try {
    // The bare root never dispatches, so a team named "clear" cannot shadow
    // /team:clear — but /team:run reaches every name.
    await cmd("team", "clear");
    assert.equal(spawn.records.length, 0, "bare /team clear is a rename hint, not a dispatch");
    assert.match(notifications.at(-1)?.text ?? "", /已改名为「\/team:clear」/);

    for (const name of ["clear", "run", "status"]) {
      const before: number = spawn.records.length;
      const forwarded = pi.sentMessages.length;
      await cmd(TEAM_COMMAND_NAMES.run, `${name} 做点事`);
      const child = await waitForChild(spawn, before);
      child.autoRespond([messageEndLine("assistant")], 0, 5);
      await waitFor(() => pi.sentMessages.length > forwarded);
      assert.equal(spawn.records.length, before + 1, `team named ${name} dispatches via /team:run`);
    }
    assert.match(notifications.at(-2)?.text ?? notifications.at(-1)?.text ?? "", /已在后台启动/);
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// /team:resume — resume a failed/aborted run (parent session + worktree)
// ---------------------------------------------------------------------------

test("/team:resume without a runId replies with a usage hint (no dispatch)", async () => {
  const { spawn, cmd, notifications, cleanup } = await setup();
  try {
    await cmd(TEAM_COMMAND_NAMES.resume, "");
    assert.equal(spawn.records.length, 0, "no dispatch");
    const last = notifications.at(-1);
    assert.equal(last?.level, "warning");
    assert.match(last?.text ?? "", /用法：\/team:resume <runId>/);
  } finally {
    cleanup();
  }
});

test("/team:resume <runId> continues a failed run on its parent session", async () => {
  const { pi, spawn, cmd, notifications, runsDir, cleanup } = await setup();
  try {
    await cmd(TEAM_COMMAND_NAMES.run, "proj-team 原始任务");
    const child = await waitForChild(spawn, 0);
    const runId = spawn.records[0].env?.PI_AGENT_TEAM_RUN_ID ?? "";
    child.autoRespond(
      [messageEndLine("assistant", { content: [{ type: "text", text: "partial" }], errorMessage: "quota exhausted", stopReason: "error" })],
      1,
      5,
    );
    await waitFor(() => readRunStatuses(runsDir).entries.find((e) => e.runId === runId)?.status === "failed");

    const sessionDir = path.join(runsDir, runId, "session");
    fs.mkdirSync(sessionDir, { recursive: true });
    const mirror = path.join(sessionDir, "20260911_000000_aaa.jsonl");
    fs.writeFileSync(mirror, `${JSON.stringify({ type: "session", version: 3, id: "aaa", timestamp: "t", cwd: "/tmp" })}\n`);

    await cmd(TEAM_COMMAND_NAMES.resume, `${runId} 换用有额度的模型继续`);
    const resumeChild = await waitForChild(spawn, 1);
    assert.equal(spawn.records.length, 2, "resume leader spawned");
    assert.equal(argValue(spawn.records[1].args, "--session"), path.resolve(mirror));
    assert.ok(!spawn.records[1].args.includes("--session-dir"), "resume never opens a session-dir");
    assert.match(notifications.at(-1)?.text ?? "", /已续跑/);

    resumeChild.autoRespond([messageEndLine("assistant", { content: [{ type: "text", text: "FINAL" }] })], 0, 5);
    await waitFor(() => pi.sentMessages.length > 0);
  } finally {
    cleanup();
  }
});
