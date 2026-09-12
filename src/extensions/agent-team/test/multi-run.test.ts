/**
 * Multi-run core tests (真正并发跑多个 team run, writer-1 core line).
 *
 * Locks the registry contract: several runs coexist in one session, each
 * with its own child process, stdin channel, progress and terminal record.
 * The parallel/steer/settle cases drive REAL child processes
 * (`defaultSpawn()` + `process.execPath -e`, the runner.test.ts pattern):
 * two leaders must be alive at the same time, stdin routing must not cross
 * runs, and each run must settle independently — a fake spawn cannot catch
 * registry-level cross-talk (v1.15.0 deadlock lesson: fakes never hit EOF).
 *
 * Pure-function cases (runId suffix, records bound, status projection,
 * snapshot formatting) run against fake children — the archive path is
 * already covered by real-file tests elsewhere.
 */

import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import agentTeamExtension, { resetDoubleLoadGuardForTests } from "../index.ts";
import { formatStatusSnapshot, TeamRunCoordinator, type UiPort } from "../cockpit.ts";
import { serializeTeam } from "../config.ts";
import { defaultSpawn } from "../runner.ts";
import { MAX_CONCURRENT_TEAM_RUNS, MAX_RETAINED_RUN_RECORDS, type PiSpawn, type RunProgress } from "../types.ts";
import { stripAnsi } from "../viewer.ts";
import { fixtureTeam } from "./fixtures.ts";
import { isolateRunsDir, makeFakeSpawn, messageEndLine, sleep, waitForChild, waitForChildByRunId, type FakeSpawnHandle } from "./helpers.ts";

function fakeUi(): UiPort {
  return { notify: () => {}, dim: (text) => text };
}

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agent-team-multi-run-"));
}

async function waitFor(predicate: () => boolean, what: string, attempts = 200): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    if (predicate()) return;
    await sleep(10);
  }
  assert.ok(false, `等待超时：${what}`);
}

/**
 * Steers as soon as the run's RPC stdin channel is live (the leader spawn
 * does async temp-prompt work before onChild installs the channel, so an
 * immediate steer would fall back to queue semantics).
 */
async function steerWhenReady(coordinator: TeamRunCoordinator, runId: string, message: string): Promise<void> {
  for (let i = 0; i < 300; i++) {
    if (coordinator.steerLeader(runId, message)) return;
    await sleep(10);
  }
  assert.ok(false, `steer channel never became ready for ${runId}`);
}

/**
 * RPC-mode leader script for real child processes. Reads JSON lines from
 * stdin exactly like pi's `--mode rpc`:
 * - `prompt`  → assistant message_end (keeps the run live)
 * - `steer` containing "dispatch" → team_dispatch tool_execution_end whose
 *   details carry member progress (per-run event routing proof)
 * - `steer` containing "settle"   → agent_settled (cockpit closes stdin;
 *   stdin end exits the process)
 * - any other steer → assistant message_end echoing the message back
 */
const CHILD_SCRIPT = [
  "const readline = require('node:readline');",
  "const rl = readline.createInterface({ input: process.stdin });",
  "const runId = process.env.PI_AGENT_TEAM_RUN_ID || '?';",
  "function emit(o){ console.log(JSON.stringify(o)); }",
  "function assistant(text){ emit({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text }], usage: { input: 1, output: 1, cost: { total: 0 } }, model: 'm' } }); }",
  "rl.on('line', (line) => {",
  "  let msg; try { msg = JSON.parse(line); } catch { return; }",
  "  if (msg.type === 'prompt') { setTimeout(() => assistant('working ' + runId), 30); return; }",
  "  if (msg.type !== 'steer') return;",
  "  const text = String(msg.message || '');",
  "  if (text.includes('settle')) { emit({ type: 'agent_settled' }); return; }",
  "  if (text.includes('dispatch')) {",
  "    emit({ type: 'tool_execution_end', toolName: 'team_dispatch', result: { content: [{ type: 'text', text: 'ok' }], details: { members: [{ name: 'frontend', ok: true, status: 'done', summary: 's', usage: { input: 1, output: 1, cost: 0, turns: 1 } }], totalUsage: { input: 1, output: 1, cost: 0, turns: 1 } } } });",
  "    return;",
  "  }",
  "  assistant('STEER:' + text);",
  "});",
].join("\n");

/** Spawn port that replaces the leader argv with a real `node -e` child. */
function realChildSpawn(): PiSpawn {
  const base = defaultSpawn();
  return (_command, _args, opts) => base(process.execPath, ["-e", CHILD_SCRIPT], opts);
}

function makeRealCoordinator(root: string, nowMs?: () => number): TeamRunCoordinator {
  return new TeamRunCoordinator({
    cwd: () => root,
    worktreeRoot: path.join(root, "worktrees"),
    transcriptRoot: path.join(root, "runs"),
    piCommand: "node",
    spawn: realChildSpawn(),
    killGraceMs: 50,
    ...(nowMs ? { nowMs } : {}),
  });
}

function leaderLines(): string[] {
  return [messageEndLine("assistant", { content: [{ type: "text", text: "FINAL" }] })];
}

test("two runs progress in parallel under real child processes", async () => {
  const root = tmpRoot();
  try {
    const coordinator = makeRealCoordinator(root);
    const first = coordinator.start({ team: fixtureTeam(), task: "任务 A", ui: fakeUi() });
    const second = coordinator.start({ team: fixtureTeam(), task: "任务 B", ui: fakeUi() });
    const runA = coordinator.activeRunIds()[0]!;
    const runB = coordinator.activeRunIds()[1]!;
    assert.ok(runA && runB && runA !== runB, "two distinct runs claimed");

    // Both leaders are alive: neither promise resolved / no close observed.
    let settledA = false;
    void first.then(() => {
      settledA = true;
    });
    await waitFor(() => coordinator.activeRunIds().length === 2, "both runs active");
    assert.equal(settledA, false, "run A still running while B runs");

    // Per-run member events: only A's dispatch folds into A's progress.
    await steerWhenReady(coordinator, runA, "please dispatch now");
    await waitFor(() => coordinator.getStatus(runA)?.progress?.members[0]?.status === "done", "A member done");
    const progressA = coordinator.getStatus(runA)?.progress as RunProgress;
    const progressB = coordinator.getStatus(runB)?.progress as RunProgress;
    assert.equal(progressA.members[0]?.status, "done");
    assert.equal(progressB.members[0]?.status, "queued", "B's members untouched by A's dispatch");

    // Per-run steering: only B's child echoes B's message.
    await steerWhenReady(coordinator, runB, "hello-B");
    await waitFor(() => coordinator.getStatus(runB)?.progress?.leaderActivity === "STEER:hello-B", "B saw its steer");
    assert.notEqual(coordinator.getStatus(runA)?.progress?.leaderActivity, "STEER:hello-B", "A's channel did not see B's steer");

    // A settles first (agent_settled → stdin closed → real child exits).
    await steerWhenReady(coordinator, runA, "settle");
    const resultA = await first;
    assert.ok(resultA.ok);
    assert.equal(resultA.value?.status, "completed");
    assert.deepEqual(coordinator.getStatus().records.map((r) => r.runId).slice(0, 1), [runA], "A is the newest record");
    assert.deepEqual(coordinator.activeRunIds(), [runB], "B keeps running after A settled");

    // B settles later: both terminal records coexist, independently.
    await steerWhenReady(coordinator, runB, "settle");
    const resultB = await second;
    assert.ok(resultB.ok);
    assert.equal(resultB.value?.status, "completed");
    assert.equal(coordinator.getStatus().records.length, 2);
    assert.deepEqual(new Set(coordinator.getStatus().records.map((r) => r.runId)), new Set([runA, runB]));
    assert.equal(coordinator.getStatus(runA)?.progress, null);
    assert.equal(coordinator.getStatus(runA)?.lastRecord?.status, "completed");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("two runs start; the fourth is rejected with RUN_IN_PROGRESS listing active runIds", async () => {
  const root = tmpRoot();
  try {
    const coordinator = makeRealCoordinator(root);
    const promises = [0, 1, 2].map((i) =>
      coordinator.start({ team: fixtureTeam(), task: `task ${i}`, ui: fakeUi() }),
    );
    await waitFor(() => coordinator.activeRunIds().length === MAX_CONCURRENT_TEAM_RUNS, "cap reached");
    const activeIds = coordinator.activeRunIds();
    assert.equal(activeIds.length, MAX_CONCURRENT_TEAM_RUNS);

    const rejected = await coordinator.start({ team: fixtureTeam(), task: "one too many", ui: fakeUi() });
    assert.ok(!rejected.ok);
    assert.equal(rejected.code, "RUN_IN_PROGRESS");
    for (const id of activeIds) assert.ok(rejected.message.includes(id), `message lists ${id}`);
    assert.equal(coordinator.activeRunIds().length, MAX_CONCURRENT_TEAM_RUNS, "no fourth run claimed");

    // Keep the test bounded: settle all three real children.
    for (const id of activeIds) await steerWhenReady(coordinator, id, "settle");
    await Promise.all(promises);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("runIds in the same millisecond get distinct -n suffixes", async () => {
  const root = tmpRoot();
  try {
    const spawn = makeFakeSpawn();
    const coordinator = new TeamRunCoordinator({
      cwd: () => root,
      worktreeRoot: path.join(root, "worktrees"),
      spawn: spawn.spawn,
      piCommand: "pi",
      transcriptRoot: path.join(root, "runs"),
      now: () => "2026-09-16T00:00:00Z",
      nowMs: () => 1000,
    });
    const first = coordinator.start({ team: fixtureTeam(), task: "a", ui: fakeUi() });
    const second = coordinator.start({ team: fixtureTeam(), task: "b", ui: fakeUi() });
    const ids = coordinator.activeRunIds();
    assert.deepEqual(ids, ["run-1000", "run-1000-2"]);
    assert.ok(fs.existsSync(path.join(root, "runs", "run-1000", "status.json")));
    assert.ok(fs.existsSync(path.join(root, "runs", "run-1000-2", "status.json")));

    // 并发 start() 在 spawn 前有真实异步工作（状态落盘、临时提示词落盘、
    // 可选 git 预检），spawn 完成序可与 start 调用序不一致（实测翻转）；
    // 按 children 索引配对会在翻转时把 A 的事件喂给 B 的 child → 后者先
    // 落定、`await first` 永挂。按 spawn env 里的 runId 配对（makeFakeSpawn
    // 已记录），任意 spawn 序都稳定。
    const childA = await waitForChildByRunId(spawn, "run-1000");
    const childB = await waitForChildByRunId(spawn, "run-1000-2");
    // 同毫秒 startedAt 下 records 的先后由落定序决定（pushRecord 稳定排序：
    // 后落定者在前）。两个 5ms 定时器的回调顺序在机器满载时会翻转（本用例
    // 曾在全量中偶发抖红），故串行落定 A→B，把「后完成者在前」锁死。
    childA.autoRespond(leaderLines(), 0, 5);
    const resultA = await first;
    assert.ok(resultA.ok);
    childB.autoRespond(leaderLines(), 0, 5);
    const resultB = await second;
    assert.ok(resultB.ok);
    assert.deepEqual(coordinator.getStatus().records.map((r) => r.runId), ["run-1000-2", "run-1000"]);
    assert.equal(coordinator.getStatus("run-1000")?.lastRecord?.runId, "run-1000");
    assert.equal(coordinator.getStatus("run-1000-2")?.lastRecord?.runId, "run-1000-2");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("records are bounded to five, newest first", async () => {
  const root = tmpRoot();
  try {
    const spawn = makeFakeSpawn();
    const coordinator = new TeamRunCoordinator({
      cwd: () => root,
      worktreeRoot: path.join(root, "worktrees"),
      spawn: spawn.spawn,
      piCommand: "pi",
    });
    const runIds: string[] = [];
    for (let i = 0; i < 7; i++) {
      const promise = coordinator.start({ team: fixtureTeam(), task: `task ${i}`, ui: fakeUi() });
      const runId = coordinator.activeRunIds().at(-1) ?? "";
      runIds.push(runId);
      const child = await waitForChild(spawn, i);
      child.autoRespond([messageEndLine("assistant", { content: [{ type: "text", text: `done ${i}` }] })], 0, 2);
      const result = await promise;
      assert.ok(result.ok);
    }
    const snapshot = coordinator.getStatus();
    assert.equal(snapshot.records.length, MAX_RETAINED_RUN_RECORDS);
    assert.deepEqual(snapshot.records.map((r) => r.runId), runIds.slice(2).reverse());
    assert.equal(snapshot.lastRecord?.runId, runIds[6], "lastRecord is the newest record");
    assert.equal(snapshot.records[0], snapshot.lastRecord);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("stopAndSettle(runId) settles only the targeted run", async () => {
  const root = tmpRoot();
  try {
    const coordinator = makeRealCoordinator(root);
    const first = coordinator.start({ team: fixtureTeam(), task: "A", ui: fakeUi() });
    const second = coordinator.start({ team: fixtureTeam(), task: "B", ui: fakeUi() });
    const runA = coordinator.activeRunIds()[0]!;
    const runB = coordinator.activeRunIds()[1]!;
    await waitFor(() => coordinator.activeRunIds().length === 2, "both active");

    const outcome = await coordinator.stopAndSettle(runB, 5000);
    assert.equal(outcome.wasRunning, true);
    assert.equal(outcome.settled, true, "B's real child exits on SIGTERM");
    assert.equal(outcome.record?.status, "aborted");
    assert.equal(outcome.record?.runId, runB);
    assert.deepEqual(coordinator.activeRunIds(), [runA], "A keeps running");

    // A is untouched: it still settles into its own completed record.
    await steerWhenReady(coordinator, runA, "settle");
    const resultA = await first;
    assert.ok(resultA.ok);
    assert.equal(resultA.value?.status, "completed");
    const resultB = await second;
    assert.ok(resultB.ok);
    assert.equal(resultB.value?.status, "aborted");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("getStatus(runId) projects a single run; an unknown runId returns null", async () => {
  const root = tmpRoot();
  try {
    const spawn = makeFakeSpawn();
    const coordinator = new TeamRunCoordinator({
      cwd: () => root,
      worktreeRoot: path.join(root, "worktrees"),
      spawn: spawn.spawn,
      piCommand: "pi",
    });
    const first = coordinator.start({ team: fixtureTeam(), task: "A", ui: fakeUi() });
    const second = coordinator.start({ team: fixtureTeam(), task: "B", ui: fakeUi() });
    const runA = coordinator.activeRunIds()[0]!;
    const runB = coordinator.activeRunIds()[1]!;

    const projection = coordinator.getStatus(runA);
    assert.ok(projection);
    assert.equal(projection.running, true);
    assert.equal(projection.progress?.runId, runA);
    assert.deepEqual(projection.actives.map((p) => p.runId), [runA]);

    assert.equal(coordinator.getStatus("run-unknown"), null);

    const aggregate = coordinator.getStatus();
    assert.equal(aggregate.actives.length, 2);
    assert.equal(aggregate.running, true);
    assert.equal(aggregate.progress?.runId, runB, "aggregate progress is the newest active run");

    const [childA, childB] = [await waitForChild(spawn, 0), await waitForChild(spawn, 1)];
    childB.autoRespond(leaderLines(), 0, 5);
    childA.autoRespond(leaderLines(), 0, 5);
    await Promise.all([first, second]);

    const afterTerminal = coordinator.getStatus(runA);
    assert.ok(afterTerminal);
    assert.equal(afterTerminal.running, false);
    assert.equal(afterTerminal.progress, null);
    assert.equal(afterTerminal.lastRecord?.runId, runA, "terminal projection pins the requested run");
    assert.deepEqual(afterTerminal.actives, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("formatStatusSnapshot renders multi-active sections and runId lookup", () => {
  const older: RunProgress = {
    runId: "run-old",
    team: "alpha",
    task: "第一个任务",
    startedAtMs: 0,
    members: [{ name: "frontend", status: "running", model: "m1", note: "turn 1" }],
  };
  const newer: RunProgress = {
    runId: "run-new",
    team: "beta",
    task: "第二个任务",
    startedAtMs: 65_000,
    leaderDeclaredModel: "opencode-go/deepseek",
    leaderModel: "deepseek-v3",
    members: [{ name: "backend", status: "queued" }],
  };
  const multi = formatStatusSnapshot(
    { running: true, progress: newer, lastRecord: null, actives: [older, newer], records: [] },
    130_000,
  );
  assert.match(multi, new RegExp(`^当前共 2 个 run 并行（上限 ${MAX_CONCURRENT_TEAM_RUNS}）：`));
  assert.match(multi, /── run run-old · team alpha ▶ running · 2m10s/);
  assert.match(multi, /── run run-new · team beta ▶ running · 1m5s/);
  assert.match(multi, /任务: 第一个任务/);
  assert.match(multi, /任务: 第二个任务/);
  assert.match(multi, /leader: opencode-go\/deepseek-v3/);
  assert.match(multi, /▶ frontend running — m1 — turn 1/);
  assert.doesNotMatch(multi, /当前 run：/);

  // runId-targeted lookup keeps the single-run format (zero regression).
  const targeted = formatStatusSnapshot(
    { running: true, progress: older, lastRecord: null, actives: [older], records: [] },
    10_000,
    undefined,
    "run-old",
  );
  assert.match(targeted, /当前 run：team alpha ▶ running · 10s/);
  assert.match(targeted, /runId: run-old/);
  assert.doesNotMatch(targeted, /── run /);

  // No active runs + several records: single record block plus the recent tail.
  const records = [0, 1, 2, 3, 4, 5].map((i) => ({
    runId: `run-${i}`,
    team: "t",
    task: "x",
    startedAt: `2026-09-16T00:00:0${i}Z`,
    status: (i === 0 ? "completed" : i === 1 ? "failed" : "aborted") as "completed" | "failed" | "aborted",
    members: [],
    totalCost: 0,
    totalTokens: 0,
  }));
  const tail = formatStatusSnapshot({ running: false, progress: null, lastRecord: records[0]!, actives: [], records }, 0);
  assert.match(tail, /最近一次 run：team t ✓ completed/);
  assert.match(tail, /近期 run：run-1 ✗failed · run-2 ⊘aborted · run-3 ⊘aborted · run-4 ⊘aborted（最多再列 4 条；\/team:status <runId> 查看详情）/);
  assert.doesNotMatch(tail, /run-5/);
});

// ---------------------------------------------------------------------------
// Viewer 切 run 接缝（index.ts 接线）
//
// writer-2 把「当前查看 run 的 runId」交到 stop(runId)/onMessage.target.runId/
// widget onConfirm(actor, runId)，但 index.ts 侧未消费：切到 run B 后 D 仍停
// 默认 run、插话仍打默认 run、widget enter 不钉选。本组用例用真实 extension
// + 真实 TranscriptViewer + fake leader 子进程锁住三条接缝；运行目录经
// PI_AGENT_TEAM_RUNS_DIR 隔离到临时目录。
// ---------------------------------------------------------------------------

type ExtHandler = (event: unknown, ctx: unknown) => Promise<unknown>;

function extFakePi() {
  const tools = new Map<string, unknown>();
  const commands = new Map<string, { handler: (args: unknown, ctx: unknown) => Promise<unknown> }>();
  const handlers = new Map<string, ExtHandler[]>();
  return {
    tools,
    commands,
    registerTool: (tool: { name: string }): void => {
      tools.set(tool.name, tool);
    },
    registerCommand: (name: string, command: { handler: (args: unknown, ctx: unknown) => Promise<unknown> }): void => {
      commands.set(name, command);
    },
    registerEntryRenderer: (): void => {},
    on: (event: string, handler: ExtHandler): void => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    async fire(event: string, ctx: unknown): Promise<void> {
      for (const handler of handlers.get(event) ?? []) await handler({}, ctx);
    },
  };
}

type ViewerComponentLike = {
  handleInput: (data: string) => void;
  render: (width: number) => string[];
  dispose: () => void;
};

interface ExtCapture {
  viewer: ViewerComponentLike | undefined;
  inputHandlers: Array<(data: string) => { consume?: boolean } | undefined>;
  pushed: Array<string[] | undefined>;
}

interface ExtHost {
  spawn: FakeSpawnHandle;
  pi: ReturnType<typeof extFakePi>;
  sessionCtx: Record<string, unknown>;
  capture: ExtCapture;
  startRun: (task: string) => Promise<string>;
  openViewer: () => Promise<ViewerComponentLike>;
  cleanup: () => Promise<void>;
}

/** 真实 cockpit + fake leader 子进程；widget 是否挂载由用例选择。 */
async function setupExtensionHost(opts: { widget: boolean }): Promise<ExtHost> {
  resetDoubleLoadGuardForTests();
  const runsDir = isolateRunsDir();
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-team-wiring-"));
  fs.mkdirSync(path.join(projectDir, ".pi", "teams"), { recursive: true });
  const team = fixtureTeam({ name: "wiring-team", description: "切 run 接线观测团队", filePath: "", notes: undefined });
  fs.writeFileSync(path.join(projectDir, ".pi", "teams", "wiring-team.md"), serializeTeam(team));
  const spawn = makeFakeSpawn();
  const pi = extFakePi();
  const capture: ExtCapture = { viewer: undefined, inputHandlers: [], pushed: [] };
  const previousWidget = process.env.PI_AGENT_TEAM_WIDGET;
  if (opts.widget) delete process.env.PI_AGENT_TEAM_WIDGET;
  else process.env.PI_AGENT_TEAM_WIDGET = "0";
  const sessionCtx = {
    cwd: projectDir,
    hasUI: true,
    mode: "tui",
    isProjectTrusted: (): boolean => true,
    ui: {
      getEditorText: (): string => "",
      setWidget: (_key: string, content: unknown): void => {
        if (typeof content === "function") {
          (content as (tui: unknown) => unknown)({});
          return;
        }
        capture.pushed.push(content as string[] | undefined);
      },
      onTerminalInput: (handler: (data: string) => { consume?: boolean } | undefined): (() => void) => {
        capture.inputHandlers.push(handler);
        return () => {};
      },
      custom: (...args: unknown[]): Promise<unknown> => {
        const factory = args[0] as (tui: unknown, theme: unknown, kb: unknown, done: (r: unknown) => void) => unknown;
        capture.viewer = factory({}, { fg: (_c: string, t: string) => t }, undefined, () => {}) as ViewerComponentLike;
        return new Promise<unknown>(() => {}); // overlay 常开；cleanup 直接收尾
      },
      notify: (): void => {},
      theme: { fg: (_c: string, t: string): string => t },
    },
    sessionManager: { getEntries: (): unknown[] => [] },
  };
  agentTeamExtension(pi as never, { spawn: spawn.spawn });
  await pi.fire("session_start", sessionCtx);

  const startRun = async (task: string): Promise<string> => {
    const run = pi.tools.get("team_run") as unknown as {
      execute: (
        id: string,
        params: Record<string, unknown>,
        signal?: undefined,
        onUpdate?: undefined,
        ctx?: unknown,
      ) => Promise<{ isError?: boolean; content?: Array<{ text?: string }>; details?: { runId?: string } }>;
    };
    const result = await run.execute("call-run", { team: "wiring-team", task }, undefined, undefined, sessionCtx);
    assert.notEqual(result.isError, true, `team_run 应成功：${JSON.stringify(result)}`);
    const runId = result.details?.runId;
    assert.ok(runId, `启动结果应含 runId：${JSON.stringify(result)}`);
    return runId;
  };
  const openViewer = async (): Promise<ViewerComponentLike> => {
    const view = pi.commands.get("team:view");
    assert.ok(view, "cockpit 应注册 /team:view 命令");
    void view.handler("", sessionCtx as never);
    await sleep(30);
    assert.ok(capture.viewer, "viewer 组件应已实例化");
    return capture.viewer;
  };
  const cleanup = async (): Promise<void> => {
    await pi.fire("session_shutdown", sessionCtx);
    capture.viewer?.dispose();
    fs.rmSync(projectDir, { recursive: true, force: true });
    fs.rmSync(runsDir, { recursive: true, force: true });
    delete process.env.PI_AGENT_TEAM_RUNS_DIR;
    if (previousWidget === undefined) delete process.env.PI_AGENT_TEAM_WIDGET;
    else process.env.PI_AGENT_TEAM_WIDGET = previousWidget;
    resetDoubleLoadGuardForTests();
  };
  return { spawn, pi, sessionCtx, capture, startRun, openViewer, cleanup };
}

/** 启动较早 run A（先）与较新 run B（后），返回 runId 与两棵 fake 子进程。 */
async function startTwoRuns(host: ExtHost): Promise<{ runA: string; runB: string }> {
  const runA = await host.startRun("任务 A");
  await waitForChild(host.spawn, 0);
  const runB = await host.startRun("任务 B");
  await waitForChild(host.spawn, 1);
  assert.notEqual(runA, runB, "两个 run 应有不同 runId");
  return { runA, runB };
}

test("接线：viewer 切到较早 run 后 D 停该 run（stop 消费当前查看 runId）", async () => {
  const host = await setupExtensionHost({ widget: false });
  try {
    const { runA, runB } = await startTwoRuns(host);
    const viewer = await host.openViewer();
    assert.ok(
      stripAnsi(viewer.render(120).join("\n")).includes(`Run: ${runB}`),
      "默认查看最新活跃 run B",
    );

    viewer.handleInput("[");
    assert.ok(
      stripAnsi(viewer.render(120).join("\n")).includes(`Run: ${runA}`),
      "`[` 切到较早的 run A",
    );

    viewer.handleInput("D");
    viewer.handleInput("\r");
    await waitFor(() => host.spawn.children[0]!.killed.includes("SIGTERM"), "run A 收到 SIGTERM");
    host.spawn.children[0]!.emitClose(0); // 让 A 落定，viewer 收到 success notice
    await waitFor(
      () => stripAnsi(viewer.render(120).join("\n")).includes(`run ${runA} 已停止`),
      "A 的停止 notice 上屏",
    );
    assert.deepEqual(host.spawn.children[1]!.killed, [], "run B 未收到任何信号");
  } finally {
    await host.cleanup();
  }
});

test("接线：viewer 切到较早 run 后 m 插话 steer 到该 run 的 leader（onMessage 消费 target.runId）", async () => {
  const host = await setupExtensionHost({ widget: false });
  try {
    const { runA } = await startTwoRuns(host);
    await waitFor(
      () => host.spawn.children[0]!.writes.length > 0 && host.spawn.children[1]!.writes.length > 0,
      "两个 leader 的 RPC stdin 就绪",
    );
    const viewer = await host.openViewer();
    viewer.handleInput("[");
    assert.ok(
      stripAnsi(viewer.render(120).join("\n")).includes(`Run: ${runA}`),
      "`[` 切到较早的 run A",
    );

    viewer.handleInput("m");
    viewer.handleInput("查一下");
    viewer.handleInput("\r");
    await waitFor(
      () => host.spawn.children[0]!.writes.some((line) => line.includes("查一下")),
      "run A 的 leader 收到插话",
    );
    assert.ok(
      host.spawn.children[0]!.writes.some((line) => line.includes('"type":"steer"') && line.includes("查一下")),
      "插话经 steer 通道写入 A 的 stdin",
    );
    assert.ok(
      !host.spawn.children[1]!.writes.some((line) => line.includes("查一下")),
      "run B 的 leader 不收到该消息",
    );
  } finally {
    await host.cleanup();
  }
});

test("接线：widget enter 从较早 run 的行打开该 run 的 viewer（onConfirm 钉选 runId）", async () => {
  const host = await setupExtensionHost({ widget: true });
  try {
    const { runA, runB } = await startTwoRuns(host);
    await waitFor(() => host.capture.inputHandlers.length === 1, "widget 输入钩子已挂");
    await waitFor(
      () => (host.capture.pushed.at(-1)?.[0] ?? "").includes("2 run 并行"),
      "widget 多 run 折叠行（2 run 并行）",
    );

    const handler = host.capture.inputHandlers[0]!;
    handler("\x1b[B"); // 激活并选中 main 根行
    handler("\x1b[B"); // 下移到较早 run A 的 leader 行
    handler("\r"); // enter → onConfirm(actor, runId=A) → openViewer 钉选 A
    await waitFor(() => host.capture.viewer !== undefined, "viewer 由 widget enter 打开");
    const frame = stripAnsi(host.capture.viewer!.render(120).join("\n"));
    assert.ok(frame.includes(`Run: ${runA}`), `widget enter 应打开 run A（钉选行 runId）：\n${frame}`);
    assert.ok(!frame.includes(`Run: ${runB}`), "不得落到默认 run B");
  } finally {
    await host.cleanup();
  }
});
