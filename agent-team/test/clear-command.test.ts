/**
 * /team:clear + widget lifecycle tests against the real entry (fake
 * ExtensionAPI / fake ctx with a TUI ui port + scripted leader child).
 *
 * Locks the data-driven widget lifecycle at the wiring layer:
 * - session_start mounts the controller once per session even with no run;
 *   the host widget is only registered while a run is live (a terminal
 *   record never pushes a frame).
 * - A background dispatch pushes a frame immediately; settle auto-unmounts
 *   (setWidget undefined).
 * - /team:clear refuses while a run is in progress; on a settled/idle
 *   session it only drops queued viewer chat messages and never touches the
 *   widget; lastRecord still powers /team:status.
 * - A team named "clear" cannot shadow /team:clear — the commands are
 *   separate static registrations.
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

interface FakeCtxState {
  ctx: unknown;
  widgetCalls: WidgetCall[];
  notifications: Array<{ text: string; level?: string }>;
  factoryCalls: () => number;
}

function fakeTuiCtx(cwd: string, entries: Array<{ type?: string; customType?: string; data?: unknown }> = [], trusted = true): FakeCtxState {
  const widgetCalls: WidgetCall[] = [];
  const notifications: Array<{ text: string; level?: string }> = [];
  let factoryCalls = 0;
  const ui = {
    theme: { fg: (_c: string, t: string) => t, bg: (_c: string, t: string) => t },
    notify: (text: string, level?: string) => notifications.push({ text, level }),
    getEditorText: () => "",
    setWidget: (id: string, content: unknown, _options?: unknown) => {
      // Factory form = host TUI capture (ensureRunWidget), string[]/undefined
      // = actual frames; the factory is invoked with a fake TUI like the host.
      if (typeof content === "function") {
        factoryCalls += 1;
        (content as (tui: unknown) => unknown)({
          focusedComponent: { render: () => [], invalidate: () => {}, handleInput: () => {}, getText: () => "", setText: () => {} },
        });
        return;
      }
      widgetCalls.push({ id, lines: content as string[] | undefined });
    },
    onTerminalInput: (_handler: (data: string) => { consume?: boolean } | undefined) => () => {},
  };
  const ctx = {
    cwd,
    hasUI: true,
    mode: "tui",
    isProjectTrusted: () => trusted,
    ui,
    sessionManager: { getEntries: () => entries },
  };
  return { ctx, widgetCalls, notifications, factoryCalls: () => factoryCalls };
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
  factoryCalls: () => number;
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
  const { ctx, widgetCalls, notifications, factoryCalls } = fakeTuiCtx(projectDir, opts.entries ?? []);
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
    clear: (clearCtx: unknown) => pi.commands.get("team:clear")!.handler("", clearCtx),
    ctx,
    widgetCalls,
    notifications,
    factoryCalls,
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

test("session_start 无 run：controller 已挂载（factory 一次）但不注册任何亮块", async () => {
  const { factoryCalls, widgetCalls, cleanup } = await setup();
  try {
    assert.equal(factoryCalls(), 1, "会话启动即挂 controller（数据驱动挂载，不再等派单）");
    // session_start 会先 clearWidget(undefined) 清理上一会话残留；除该清理帧外
    // 无活跃 run 不得推任何帧。
    assert.ok(widgetCalls.every((call) => call.lines === undefined && call.id === WIDGET_ID), "无活跃 run 不推任何亮块帧");
  } finally {
    cleanup();
  }
});

test("/team:clear refuses while a run is in progress (warning, widget untouched)", async () => {
  const { spawn, run, clear, ctx, widgetCalls, notifications, cleanup } = await setup();
  try {
    const started = await run({ team: "proj-team", task: "长任务" });
    assert.notEqual(started.isError, true);
    const child = await waitForChild(spawn, 0);
    // Widget registered by the dispatch (immediate frame, no tick wait).
    assert.ok(widgetCalls.some((call) => Array.isArray(call.lines)), "widget lines pushed on dispatch");
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

test("run 落定自动卸载亮块（setWidget undefined），/team:clear 不再触碰 widget 且 lastRecord 保留", async () => {
  const { pi, spawn, run, status, clear, ctx, widgetCalls, notifications, cleanup } = await setup();
  try {
    const started = await run({ team: "proj-team", task: "跑完" });
    const runId = (started.details as { runId?: string }).runId ?? "";
    const child = await waitForChild(spawn, 0);
    child.autoRespond(leaderLines(), 0, 5);
    await waitFor(() => pi.sentMessages.length > 0);

    // 数据驱动卸载：落定帧为 undefined（无需 /team:clear）。
    assert.equal(widgetCalls.at(-1)?.lines, undefined, "settle auto-unmounted the widget");
    const callsAfterSettle = widgetCalls.length;

    await clear(ctx);

    assert.equal(widgetCalls.length, callsAfterSettle, "clear 不再做任何 widget 操作");
    const last = notifications.at(-1);
    assert.ok(last, "clear notified");
    assert.equal(last.level, "info");
    assert.match(last.text, /自动隐藏/);

    // lastRecord survives: /team:status still shows the finished run.
    const statusText = (await status({})).content[0].text;
    assert.match(statusText, /completed/);
    assert.match(statusText, new RegExp(escapeRegExp(runId)));
  } finally {
    cleanup();
  }
});

test("/team:clear 空闲会话：只提示「无可清除内容」，无 widget 副作用", async () => {
  const { clear, ctx, widgetCalls, notifications, cleanup } = await setup();
  try {
    const callsBefore = widgetCalls.length;
    await clear(ctx);
    const last = notifications.at(-1);
    assert.ok(last, "clear notified");
    assert.equal(last.level, "info");
    assert.equal(last.text, "亮块随 run 结束自动隐藏，没有可清除的内容。");
    assert.equal(widgetCalls.length, callsBefore, "clear 不再做任何 widget 操作");
  } finally {
    cleanup();
  }
});

test("re-dispatch after /team:clear pushes a fresh frame（controller 从未卸载）", async () => {
  const { pi, spawn, run, clear, ctx, widgetCalls, cleanup } = await setup();
  try {
    const first = await run({ team: "proj-team", task: "one" });
    assert.notEqual(first.isError, true);
    const child = await waitForChild(spawn, 0);
    child.autoRespond(leaderLines(), 0, 5);
    await waitFor(() => pi.sentMessages.length > 0);

    await clear(ctx);
    const clearedAt = widgetCalls.length;
    assert.equal(widgetCalls.at(-1)?.lines, undefined, "settled frame already unmounted");

    const second = await run({ team: "proj-team", task: "two" });
    assert.notEqual(second.isError, true);
    await waitForChild(spawn, 1);
    await waitFor(() => widgetCalls.slice(clearedAt).some((call) => Array.isArray(call.lines)));
    assert.ok(widgetCalls.slice(clearedAt).some((call) => Array.isArray(call.lines)), "widget frame pushed again after clear");
  } finally {
    cleanup();
  }
});

test("session_start hydration: terminal record mounts the controller but pushes no frame; /team:status intact", async () => {
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
  const { status, widgetCalls, factoryCalls, cleanup } = await setup({ entries });
  try {
    assert.equal(factoryCalls(), 1, "controller mounted");
    assert.ok(widgetCalls.every((call) => !Array.isArray(call.lines)), "no frame pushed for a terminal record");
    const statusText = (await status({})).content[0].text;
    assert.match(statusText, /completed/);
    assert.match(statusText, /run-42/);
  } finally {
    cleanup();
  }
});

test("session_start hydration: a running run re-pushes its frame after reload", async () => {
  const { pi, spawn, run, ctx, widgetCalls, cleanup } = await setup();
  try {
    const started = await run({ team: "proj-team", task: "长任务" });
    assert.notEqual(started.isError, true);
    const child = await waitForChild(spawn, 0);
    assert.ok(widgetCalls.some((call) => Array.isArray(call.lines)), "widget frame pushed on dispatch");

    // Simulate /reload mid-run: session_start fires again while the run is live.
    const callsBefore = widgetCalls.length;
    await pi.fire("session_start", { reason: "reload" }, ctx);
    assert.ok(widgetCalls.length > callsBefore, "widget re-pushed after reload");
    assert.ok(widgetCalls.slice(callsBefore).some((call) => Array.isArray(call.lines)), "running run pushes a frame after hydration");
    assert.equal(child.killed.length, 0, "reload does not kill the run");
  } finally {
    cleanup();
  }
});

test("a team named clear cannot shadow /team:clear (separate static commands)", async () => {
  const { pi, clear, ctx, notifications, cleanup } = await setup({ extraTeamFile: "clear" });
  try {
    assert.ok(pi.commands.has("team:clear"), "/team:clear is its own command");
    assert.ok(pi.commands.has("team:run"), "/team:run is its own command");
    await clear(ctx);
    const last = notifications.at(-1);
    assert.equal(last?.level, "info");
    assert.match(last?.text ?? "", /自动隐藏/, "the clear command — not a dispatch to the team — handled it");
  } finally {
    cleanup();
  }
});
