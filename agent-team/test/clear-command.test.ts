/**
 * /team clear + hydration-gating tests against the real entry (fake
 * ExtensionAPI / fake ctx with a TUI ui port + scripted leader child).
 *
 * Locks:
 * - /team clear refuses while a run is in progress (warning, no widget side
 *   effects), no-ops with an info hint when no widget is mounted, and
 *   otherwise unmounts the below-editor block (controller stop + setWidget
 *   undefined) without touching lastRecord.
 * - A re-dispatch after a clear remounts the widget (ensureRunWidget path).
 * - session_start hydration only mounts the widget when a run is actually
 *   RUNNING; a terminal record hydrates status/view paths but no widget.
 * - A team named "clear" must not shadow the /team clear sub-command.
 */

import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { serializeTeam } from "../config.ts";
import { WIDGET_ID } from "../types.ts";
import agentTeamExtension, { resetDoubleLoadGuardForTests } from "../index.ts";
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

// -- fake ExtensionAPI / ctx (TUI ui port with recorders) -------------------

interface WidgetCall {
  id: string;
  lines: string[] | undefined;
}

function fakePi() {
  const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => Promise<void>>>();
  const tools = new Map<string, Record<string, unknown>>();
  const commands = new Map<string, { description: string; handler: (args: string, ctx: unknown) => Promise<void> }>();
  const appendedEntries: Array<{ type: string; data: unknown }> = [];
  const sentMessages: Array<{ message: unknown; options?: unknown }> = [];
  return {
    tools,
    commands,
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
    registerCommand(name: string, command: { description: string; handler: (args: string, ctx: unknown) => Promise<void> }) {
      commands.set(name, command);
    },
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

function fakeTuiCtx(cwd: string, entries: Array<{ type?: string; customType?: string; data?: unknown }> = [], trusted = true) {
  const widgetCalls: WidgetCall[] = [];
  const notifications: Array<{ text: string; level?: string }> = [];
  const ui = {
    theme: { fg: (_c: string, t: string) => t, bg: (_c: string, t: string) => t },
    notify: (text: string, level?: string) => notifications.push({ text, level }),
    setWidget: (id: string, lines: string[] | undefined, _options?: unknown) => {
      widgetCalls.push({ id, lines });
    },
  };
  const ctx = {
    cwd,
    hasUI: true,
    mode: "tui",
    isProjectTrusted: () => trusted,
    ui,
    sessionManager: { getEntries: () => entries },
  };
  return { ctx, widgetCalls, notifications };
}

type Tool = (params: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>;
  details?: unknown;
  isError?: boolean;
}>;

interface Setup {
  pi: ReturnType<typeof fakePi>;
  spawn: FakeSpawnHandle;
  run: Tool;
  status: Tool;
  clear: (ctx: unknown) => Promise<void>;
  ctx: unknown;
  widgetCalls: WidgetCall[];
  notifications: Array<{ text: string; level?: string }>;
  cleanup: () => void;
}

async function setup(opts: { entries?: Array<{ type?: string; customType?: string; data?: unknown }>; extraTeamFile?: string } = {}): Promise<Setup> {
  resetDoubleLoadGuardForTests();
  isolateRunsDir();
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-team-clear-"));
  fs.mkdirSync(path.join(projectDir, ".pi", "teams"), { recursive: true });
  const team = fixtureTeam({ name: "proj-team", description: "项目团队", filePath: "", notes: undefined });
  fs.writeFileSync(path.join(projectDir, ".pi", "teams", "proj-team.md"), serializeTeam(team));
  if (opts.extraTeamFile) {
    fs.writeFileSync(
      path.join(projectDir, ".pi", "teams", `${opts.extraTeamFile}.md`),
      serializeTeam(fixtureTeam({ name: opts.extraTeamFile, description: `${opts.extraTeamFile} 团队`, filePath: "", notes: undefined })),
    );
  }
  const spawn = makeFakeSpawn();
  const pi = fakePi();
  agentTeamExtension(pi as never, { spawn: spawn.spawn });
  const { ctx, widgetCalls, notifications } = fakeTuiCtx(projectDir, opts.entries ?? []);
  await pi.fire("session_start", { reason: "startup" }, ctx);
  const tool = (name: string) =>
    pi.tools.get(name) as unknown as {
      execute: (id: string, params: Record<string, unknown>, signal?: undefined, onUpdate?: undefined, ctx?: unknown) => ReturnType<Tool>;
    };
  return {
    pi,
    spawn,
    run: (params) => tool("team_run").execute("call-run", params, undefined, undefined, ctx),
    status: (params) => tool("team_status").execute("call-status", params, undefined, undefined, ctx),
    clear: (clearCtx: unknown) => pi.commands.get("team")!.handler("clear", clearCtx),
    ctx,
    widgetCalls,
    notifications,
    cleanup: () => fs.rmSync(projectDir, { recursive: true, force: true }),
  };
}

function leaderLines(): string[] {
  return [
    messageEndLine("assistant", {
      content: [{ type: "text", text: "拆解为两个子任务" }],
      usage: { input: 10, output: 5, cost: { total: 0.001 }, totalTokens: 15 },
    }),
    toolExecutionStartLine("team_dispatch", { tasks: [{ agent: "frontend", task: "a" }, { agent: "backend", task: "b" }] }),
    toolExecutionEndLine("team_dispatch", {
      content: [{ type: "text", text: "report" }],
      details: {
        members: [{ name: "frontend", ok: true, status: "done", usage: { input: 1, output: 1, cost: 0.01, turns: 1 } }],
        totalUsage: { input: 1, output: 1, cost: 0.02, turns: 1 },
      },
    }),
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

function escapeRegExp(text: string): string {
  return text.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&");
}

test("/team clear refuses while a run is in progress (warning, widget untouched)", async () => {
  const { spawn, run, clear, ctx, widgetCalls, notifications, cleanup } = await setup();
  try {
    const started = await run({ team: "proj-team", task: "长任务" });
    assert.notEqual(started.isError, true);
    const child = await waitForChild(spawn, 0);
    // Widget mounted by the dispatch (initial refresh pushed lines).
    assert.ok(widgetCalls.some((call) => Array.isArray(call.lines)), "widget lines pushed on mount");
    const callsBefore = widgetCalls.length;

    await clear(ctx);

    const last = notifications.at(-1);
    assert.ok(last, "clear notified");
    assert.equal(last.level, "warning");
    assert.match(last.text, /进行中/);
    assert.match(last.text, /stop|结束/);
    assert.equal(widgetCalls.length, callsBefore, "no setWidget side effects while running");
    assert.equal(child.killed.length, 0, "clear never kills the run");
  } finally {
    cleanup();
  }
});

test("/team clear on a terminal run unmounts the widget (setWidget undefined, lastRecord kept)", async () => {
  const { pi, spawn, run, status, clear, ctx, widgetCalls, notifications, cleanup } = await setup();
  try {
    const started = await run({ team: "proj-team", task: "跑完" });
    const runId = (started.details as { runId?: string }).runId ?? "";
    const child = await waitForChild(spawn, 0);
    child.autoRespond(leaderLines(), 0, 5);
    await waitFor(() => pi.sentMessages.length > 0);
    assert.ok(widgetCalls.some((call) => Array.isArray(call.lines)), "terminal widget was mounted");

    await clear(ctx);

    const lastWidget = widgetCalls.at(-1);
    assert.ok(lastWidget, "a final setWidget call happened");
    assert.equal(lastWidget.id, WIDGET_ID);
    assert.equal(lastWidget.lines, undefined, "widget pushed as undefined on clear");
    const last = notifications.at(-1);
    assert.ok(last, "clear notified");
    assert.equal(last.level, "info");
    assert.match(last.text, /清除/);

    // lastRecord survives: /team status still shows the finished run.
    const statusText = (await status({})).content[0].text;
    assert.match(statusText, /completed/);
    assert.match(statusText, new RegExp(escapeRegExp(runId)));
  } finally {
    cleanup();
  }
});

test("/team clear with no mounted widget is a no-op info hint", async () => {
  const { clear, ctx, widgetCalls, notifications, cleanup } = await setup();
  try {
    await clear(ctx);
    const last = notifications.at(-1);
    assert.ok(last, "clear notified");
    assert.equal(last.level, "info");
    assert.match(last.text, /亮块/);
    // Only the session_start's initial clearWidget(…, undefined) may appear;
    // no mount call (array lines) and no extra setWidget beyond that.
    assert.ok(widgetCalls.every((call) => call.lines === undefined), "no mount setWidget side effects");
  } finally {
    cleanup();
  }
});

test("re-dispatch after /team clear remounts the widget", async () => {
  const { pi, spawn, run, clear, ctx, widgetCalls, cleanup } = await setup();
  try {
    const first = await run({ team: "proj-team", task: "one" });
    assert.notEqual(first.isError, true);
    const child = await waitForChild(spawn, 0);
    child.autoRespond(leaderLines(), 0, 5);
    await waitFor(() => pi.sentMessages.length > 0);

    await clear(ctx);
    const clearedAt = widgetCalls.length - 1;
    assert.equal(widgetCalls.at(-1)?.lines, undefined, "widget cleared");

    const second = await run({ team: "proj-team", task: "two" });
    assert.notEqual(second.isError, true);
    const child2 = await waitForChild(spawn, 1);
    child2.autoRespond(leaderLines(), 0, 5);
    await waitFor(() => widgetCalls.slice(clearedAt + 1).some((call) => Array.isArray(call.lines)));
    assert.ok(widgetCalls.slice(clearedAt + 1).some((call) => Array.isArray(call.lines)), "widget lines pushed again after clear");
  } finally {
    cleanup();
  }
});

test("session_start hydration: terminal record mounts no widget but keeps /team status", async () => {
  const entries = [
    {
      type: "custom",
      customType: "agent-team-run-v1",
      data: {
        runId: "run-42",
        team: "proj-team",
        task: "历史任务",
        startedAt: "2026-09-05T12:00:00Z",
        status: "completed",
        report: "历史报告",
        members: [{ name: "frontend", model: "chatanywhere/gpt-5.6", status: "done", summary: "做完" }],
        totalCost: 0.05,
        totalTokens: 15,
        durationMs: 32000,
      },
    },
  ];
  const { status, widgetCalls, cleanup } = await setup({ entries });
  try {
    assert.ok(widgetCalls.every((call) => !Array.isArray(call.lines)), "no widget mounted for a terminal record");
    const statusText = (await status({})).content[0].text;
    assert.match(statusText, /completed/);
    assert.match(statusText, /run-42/);
  } finally {
    cleanup();
  }
});

test("session_start hydration: a running run still mounts the widget (reload mid-run)", async () => {
  const { pi, spawn, run, ctx, widgetCalls, cleanup } = await setup();
  try {
    const started = await run({ team: "proj-team", task: "长任务" });
    assert.notEqual(started.isError, true);
    const child = await waitForChild(spawn, 0);
    assert.ok(widgetCalls.some((call) => Array.isArray(call.lines)), "widget mounted on dispatch");

    // Simulate /reload mid-run: session_start fires again while the run is live.
    const callsBefore = widgetCalls.length;
    await pi.fire("session_start", { reason: "reload" }, ctx);
    assert.ok(widgetCalls.length > callsBefore, "widget re-pushed after reload");
    assert.ok(widgetCalls.slice(callsBefore).some((call) => Array.isArray(call.lines)), "running run mounts widget after hydration");
    assert.equal(child.killed.length, 0, "reload does not kill the run");
  } finally {
    cleanup();
  }
});

test("a team named clear cannot shadow the /team clear sub-command (single router)", async () => {
  const { pi, clear, ctx, notifications, cleanup } = await setup({ extraTeamFile: "clear" });
  try {
    assert.deepEqual([...pi.commands.keys()], ["team"], "only the unified /team router is registered");
    await clear(ctx);
    const last = notifications.at(-1);
    assert.equal(last?.level, "info");
    assert.match(last?.text ?? "", /亮块/, "the clear sub-command — not a dispatch to the team — handled it");
  } finally {
    cleanup();
  }
});
