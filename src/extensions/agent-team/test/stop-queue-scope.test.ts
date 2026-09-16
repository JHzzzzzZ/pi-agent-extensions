/**
 * agent-team — 停止路径的排队消息丢弃范围（#61）
 *
 * 场景（两个 run 并行）：run A、run B 各自在 viewer 里排一条成员对话消息，
 * 然后停 A。契约：只丢弃 A 的排队条目（转录结局记「未派出（run 已停止）」），
 * B 的排队条目条数与内容原样保留（B 落定后照常链式派出、载荷仍是 B 的消息）；
 * 丢弃文案标明被停 run 与条数。
 *
 * 同一场景用命令路径（`/team:stop <runId>`）与工具路径（`team_stop`）各跑
 * 一遍，共用同一断言集（`assertStopDropsOnlyTarget`）——两条路径的丢弃结果
 * 必须一致。修复前命令路径走 `chat.clear()`（清全队列、统一记 CLEAR、文案
 * 把 B 的条数也算进去），本文件是它的红测。
 *
 * 边界：真实 cockpit + 真实 TranscriptViewer（排队消息只从 viewer 提交入队）
 * + fake leader 子进程，隔离 PI_AGENT_TEAM_RUNS_DIR；不触真进程/网络。转录
 * 断言直读 run 产物目录（排队条目落盘语义的既有观测面）。
 */

import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { serializeTeam } from "../config.ts";
import agentTeamExtension, { resetDoubleLoadGuardForTests } from "../index.ts";
import { LEADER_ACTOR, readTranscript } from "../transcript.ts";
import { LEADER_ENV_RUNID } from "../types.ts";
import { fixtureTeam } from "./fixtures.ts";
import { isolateRunsDir, makeFakeSpawn, sleep, waitForChildByRunId, type FakeChild, type FakeSpawnHandle } from "./helpers.ts";

type Handler = (event: unknown, ctx: unknown) => Promise<unknown>;
type ToolResult = { content: Array<{ type: string; text: string }>; details?: unknown; isError?: boolean };
type Tool = (params: Record<string, unknown>) => Promise<ToolResult>;
type ViewerComponentLike = { handleInput: (data: string) => void; render: (width: number) => string[]; dispose: () => void };
type Notification = { text: string; level?: string };

function fakePi() {
  const tools = new Map<string, unknown>();
  const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<unknown> }>();
  const handlers = new Map<string, Handler[]>();
  return {
    tools,
    commands,
    registerTool: (tool: { name: string }): void => {
      tools.set(tool.name, tool);
    },
    registerCommand: (name: string, command: { handler: (args: string, ctx: unknown) => Promise<unknown> }): void => {
      commands.set(name, command);
    },
    registerEntryRenderer: (): void => {},
    on: (event: string, handler: Handler): void => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    appendEntry: (): object => ({}),
    sendMessage: (): object => ({}),
    async fire(event: string, ctx: unknown): Promise<void> {
      for (const handler of handlers.get(event) ?? []) await handler({}, ctx);
    },
  };
}

/** 宿主 ctx：记录 notice + 真实 TranscriptViewer 的 custom 工厂捕获。 */
function hostCtx(cwd: string) {
  const notifications: Notification[] = [];
  let viewer: ViewerComponentLike | undefined;
  const theme = { fg: (_color: string, text: string): string => text, bold: (text: string): string => text };
  const ui = {
    theme,
    notify: (text: string, level?: string): void => {
      notifications.push({ text, level });
    },
    setWidget: (): void => {},
    onTerminalInput: (): (() => void) => () => {},
    custom: (factory: unknown): Promise<never> => {
      const build = factory as (tui: unknown, t: unknown, keybindings: unknown, done: (r: unknown) => void) => unknown;
      viewer = build({}, theme, undefined, () => {}) as ViewerComponentLike;
      return new Promise<never>(() => {});
    },
  };
  return {
    ctx: {
      cwd,
      hasUI: true,
      mode: "tui",
      isProjectTrusted: (): boolean => true,
      ui,
      sessionManager: { getEntries: (): unknown[] => [] },
    },
    notifications,
    component: (): ViewerComponentLike => {
      assert.ok(viewer, "viewer 组件应已实例化");
      return viewer;
    },
  };
}

interface HostFixture {
  pi: ReturnType<typeof fakePi>;
  spawn: FakeSpawnHandle;
  ctx: unknown;
  notifications: Notification[];
  runsDir: string;
  projectDir: string;
  component: () => ViewerComponentLike;
  cleanup: () => Promise<void>;
}

async function setupHost(): Promise<HostFixture> {
  resetDoubleLoadGuardForTests();
  const runsDir = isolateRunsDir();
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-team-stopq-"));
  fs.mkdirSync(path.join(projectDir, ".pi", "teams"), { recursive: true });
  fs.writeFileSync(
    path.join(projectDir, ".pi", "teams", "proj-team.md"),
    serializeTeam(fixtureTeam({ name: "proj-team", description: "项目团队", filePath: "", notes: undefined })),
  );
  const spawn = makeFakeSpawn();
  const pi = fakePi();
  agentTeamExtension(pi as never, { spawn: spawn.spawn });
  const { ctx, notifications, component } = hostCtx(projectDir);
  await pi.fire("session_start", ctx);
  return {
    pi,
    spawn,
    ctx,
    notifications,
    runsDir,
    projectDir,
    component,
    cleanup: async () => {
      await pi.fire("session_shutdown", ctx);
      fs.rmSync(projectDir, { recursive: true, force: true });
      fs.rmSync(runsDir, { recursive: true, force: true });
      delete process.env.PI_AGENT_TEAM_RUNS_DIR;
    },
  };
}

async function waitFor(predicate: () => boolean, what: string, attempts = 400): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    if (predicate()) return;
    await sleep(5);
  }
  assert.fail(`等待超时：${what}`);
}

/** 有界等待但不判失败：异步观测（链式派出/结局行）的判定交给共用断言集。 */
async function waitUntil(predicate: () => boolean, attempts = 400): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    if (predicate()) return true;
    await sleep(5);
  }
  return false;
}

async function startBackgroundRun(host: HostFixture, task: string): Promise<string> {
  const run = host.pi.tools.get("team_run") as unknown as {
    execute: (id: string, params: Record<string, unknown>, signal?: undefined, onUpdate?: undefined, ctx?: unknown) => Promise<ToolResult>;
  };
  const started = await run.execute("call-run", { team: "proj-team", task }, undefined, undefined, host.ctx);
  assert.notEqual(started.isError, true, `派单失败：${started.content[0]?.text ?? ""}`);
  const runId = (started.details as { runId?: string }).runId ?? "";
  assert.ok(runId, "team_run 应返回 runId");
  return runId;
}

async function openViewer(host: HostFixture): Promise<ViewerComponentLike> {
  const previousWidget = process.env.PI_AGENT_TEAM_WIDGET;
  process.env.PI_AGENT_TEAM_WIDGET = "0";
  try {
    const view = host.pi.commands.get("team:view");
    assert.ok(view, "/team:view 已注册");
    void view.handler("", host.ctx as never);
    await sleep(30);
    return host.component();
  } finally {
    if (previousWidget === undefined) delete process.env.PI_AGENT_TEAM_WIDGET;
    else process.env.PI_AGENT_TEAM_WIDGET = previousWidget;
  }
}

/** viewer 当前展示的 runId（detail 头「Run:」行）。 */
function shownRunId(viewer: ViewerComponentLike): string {
  const frame = viewer.render(140).join("\n");
  const match = frame.match(/Run:\s*([^\s│|]+)/);
  return match?.[1] ?? "";
}

/** 用 `]` 环形切到目标 run（恰 2 个 run 时最多一次）。 */
function switchToRun(viewer: ViewerComponentLike, target: string): void {
  for (let i = 0; i < 4; i++) {
    if (shownRunId(viewer) === target) return;
    viewer.handleInput("]");
  }
  assert.fail(`viewer 未切到 ${target}（当前 ${shownRunId(viewer)}）`);
}

/** viewer 里给「选中的成员」提交一条消息（成员无 steer 通道 → 纯排队路径）。 */
function submitMemberMessage(viewer: ViewerComponentLike, message: string): void {
  viewer.handleInput("j");
  viewer.handleInput("m");
  for (const char of message) viewer.handleInput(char);
  viewer.handleInput("\r");
}

function transcriptTexts(runsDir: string, runId: string): { users: string[]; systems: string[] } {
  const entries = readTranscript(runsDir, runId, LEADER_ACTOR);
  return {
    users: entries.filter((entry) => entry.kind === "user").map((entry) => entry.text),
    systems: entries.filter((entry) => entry.kind === "system").map((entry) => entry.text),
  };
}

type StopDriver = "command" | "tool";

interface ObservedTranscript {
  users: string[];
  systems: string[];
}

interface Observation {
  /** 用户可见文案（notice + 工具结果文本）。 */
  noticeTexts: string[];
  stoppedRun: string;
  otherRun: string;
  stoppedMessage: string;
  otherMessage: string;
  /** 场景收尾时的转录快照（清理临时目录前采样）。 */
  stoppedTranscript: ObservedTranscript;
  otherTranscript: ObservedTranscript;
  /** B 落定后链式派出的新 run 载荷（proves B 的排队内容原样保留）。 */
  chainedPrompt: string;
  spawnCount: number;
}

/**
 * 场景：两 run 并行 + 各自排队一条 + 停 A + B 落定链发。
 * driver 只决定「怎么停 A」；断言集共用（命令路径 / 工具路径各跑一遍）。
 */
async function runStopScenario(driver: StopDriver): Promise<Observation> {
  const host = await setupHost();
  const stoppedMessage = "只丢A的消息";
  const otherMessage = "B的消息要留住";
  try {
    const runA = await startBackgroundRun(host, "任务 A");
    const runB = await startBackgroundRun(host, "任务 B");
    const childA = await waitForChildByRunId(host.spawn, runA);
    const childB = await waitForChildByRunId(host.spawn, runB);

    // 两个 run 各自在 viewer 里排队一条成员对话；提交即落各自 run 转录。
    const viewer = await openViewer(host);
    switchToRun(viewer, runB);
    submitMemberMessage(viewer, otherMessage);
    assert.deepEqual(transcriptTexts(host.runsDir, runB).users, [otherMessage], "B 的排队消息落 B 的转录");
    switchToRun(viewer, runA);
    submitMemberMessage(viewer, stoppedMessage);
    assert.deepEqual(transcriptTexts(host.runsDir, runA).users, [stoppedMessage], "A 的排队消息落 A 的转录");
    assert.deepEqual(transcriptTexts(host.runsDir, runB).users, [otherMessage], "切 run 后 B 的转录不受扰");
    assert.equal(host.spawn.records.length, 2, "排队不派新 run");

    // 停 A（本条差异所在）：命令路径 vs 工具路径。
    let toolText = "";
    if (driver === "command") {
      const stop = host.pi.commands.get("team:stop");
      assert.ok(stop, "/team:stop 已注册");
      await stop.handler(runA, host.ctx as never);
      await waitFor(() => childA.killed.includes("SIGTERM"), "命令路径给 A 发 SIGTERM");
      childA.emitClose(null);
    } else {
      const stop = host.pi.tools.get("team_stop") as unknown as {
        execute: (id: string, params: Record<string, unknown>, signal?: undefined, onUpdate?: undefined, ctx?: unknown) => Promise<ToolResult>;
      };
      const pending = stop.execute("call-stop", { runId: runA }, undefined, undefined, host.ctx);
      await waitFor(() => childA.killed.includes("SIGTERM"), "工具路径给 A 发 SIGTERM");
      childA.emitClose(null);
      const result = await pending;
      assert.notEqual(result.isError, true, `停止失败：${result.content[0]?.text ?? ""}`);
      toolText = result.content[0]?.text ?? "";
    }
    const dropNoticeSeen = await waitUntil(() => host.notifications.some((n) => n.text.includes("已丢弃")));
    assert.ok(dropNoticeSeen, `停止后应有一条丢弃 notice（${driver}）`);

    // B 落定（completed）→ 应链式派出 B 的排队消息（修复前被一并清掉，故此处
    // 只做有界等待，判定交给与工具路径共用的断言集）。
    childB.emitClose(0);
    const chained = await waitUntil(() => host.spawn.records.length >= 3);
    if (chained) {
      await waitUntil(() => transcriptTexts(host.runsDir, runB).systems.some((text) => text.startsWith("已派出（新 run ")));
    }
    const chainedIndex = host.spawn.records.findIndex((record) => {
      const id = record.env?.[LEADER_ENV_RUNID];
      return id !== undefined && id !== runA && id !== runB;
    });
    const chainedChild: FakeChild | undefined = chainedIndex >= 0 ? host.spawn.children[chainedIndex] : undefined;
    const chainedPrompt = chainedChild
      ? String((JSON.parse(chainedChild.writes[0] ?? "{}") as { message?: string }).message ?? "")
      : "";

    viewer.dispose();
    return {
      noticeTexts: [...host.notifications.map((n) => n.text), ...(toolText ? [toolText] : [])],
      stoppedRun: runA,
      otherRun: runB,
      stoppedMessage,
      otherMessage,
      stoppedTranscript: transcriptTexts(host.runsDir, runA),
      otherTranscript: transcriptTexts(host.runsDir, runB),
      chainedPrompt,
      spawnCount: host.spawn.records.length,
    };
  } finally {
    await host.cleanup();
  }
}

/** 命令路径与工具路径共用的断言集：停 A 只丢 A 的排队。 */
function assertStopDropsOnlyTarget(o: Observation): void {
  // ① 丢弃文案：标明被停 run 与条数，且只算该 run 的条目。
  const dropped = o.noticeTexts.filter((text) => text.includes("已丢弃"));
  assert.ok(
    dropped.some((text) => text.includes(o.stoppedRun) && text.includes("1 条")),
    `丢弃文案应标明 run ${o.stoppedRun} 与条数 1：${JSON.stringify(dropped)}`,
  );
  assert.ok(
    !dropped.some((text) => text.includes("2 条")),
    `其他并行 run 的排队不得计入丢弃条数：${JSON.stringify(dropped)}`,
  );

  // ② 被停 run 的排队条目：转录结局记 STOP，绝不记 CLEAR。
  const stopped = o.stoppedTranscript;
  assert.ok(
    stopped.systems.includes("未派出（run 已停止）"),
    `被停 run 的排队条目应记「未派出（run 已停止）」：${JSON.stringify(stopped.systems)}`,
  );
  assert.ok(
    !stopped.systems.some((text) => text.includes("队列已清空")),
    `被停 run 不得记「队列已清空」（那是 /team:clear 的语义）：${JSON.stringify(stopped.systems)}`,
  );

  // ③ 其他并行 run 的排队条目：条数、内容、结局原样保留。
  const other = o.otherTranscript;
  assert.deepEqual(other.users, [o.otherMessage], "B 的排队用户原文不变");
  assert.ok(
    !other.systems.some((text) => text.includes("未派出")),
    `B 的排队条目不得被丢弃：${JSON.stringify(other.systems)}`,
  );
  assert.ok(
    o.chainedPrompt.includes(o.otherMessage),
    `B 落定后链式派出的载荷应仍是 B 的排队消息：${o.chainedPrompt}`,
  );
  assert.ok(
    !o.chainedPrompt.includes(o.stoppedMessage),
    `被停 run 的排队消息绝不派出：${o.chainedPrompt}`,
  );
  assert.equal(o.spawnCount, 3, "链式派出恰一个新 run（B 的排队条数不变）");
}

test("命令路径 /team:stop <runId>：停 A 只丢 A 的排队消息（B 原样保留）", async () => {
  const observation = await runStopScenario("command");
  assertStopDropsOnlyTarget(observation);
});

test("工具路径 team_stop：停 A 只丢 A 的排队消息（与命令路径同断言集）", async () => {
  const observation = await runStopScenario("tool");
  assertStopDropsOnlyTarget(observation);
});
